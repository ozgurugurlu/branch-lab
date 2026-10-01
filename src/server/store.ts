import { createHash, randomUUID } from "node:crypto";
import type { SqlValue } from "./db";
import type { Simulation, SimulationSummary } from "@/lib/types";
import { database } from "./db";
import { AppError } from "./errors";
import { completionStatement, type Operation } from "./operations";

const LEASE_MS = 210_000;
export interface Lease {
  token: string;
  version: number;
  simulation: Simulation;
}

function writeGuard(owner: string, operation?: Operation, offset = 0) {
  const args: SqlValue[] = [];
  const bind = (value: SqlValue) => {
    args.push(value);
    return `$${offset + args.length}`;
  };
  let sql = `NOT EXISTS (SELECT 1 FROM revoked_sessions WHERE id = ${bind(owner)})
    AND NOT EXISTS (SELECT 1 FROM sessions WHERE id = ${bind(owner)} AND expires_at <= ${bind(Date.now())})`;
  if (process.env.APP_PASSWORD) {
    sql += ` AND EXISTS (SELECT 1 FROM sessions WHERE id = ${bind(owner)} AND authenticated = 1 AND auth_fingerprint = ${bind(createHash("sha256").update(process.env.APP_PASSWORD).digest("hex"))} AND expires_at > ${bind(Date.now())})`;
  }
  if (operation) {
    sql += ` AND EXISTS (SELECT 1 FROM operations WHERE id = ${bind(operation.id)} AND owner = ${bind(owner)} AND token = ${bind(operation.token)} AND status = 'running' AND expires_at > ${bind(Date.now())})`;
  }
  return { sql, args };
}

export async function listSimulations(
  owner: string,
): Promise<SimulationSummary[]> {
  const db = await database();
  const result = await db.execute({
    sql: "SELECT data FROM simulations WHERE owner = $1 ORDER BY updated_at DESC LIMIT 100",
    args: [owner],
  });
  return result.rows.map((row) => {
    const s = JSON.parse(String(row.data)) as Simulation;
    return {
      id: s.id,
      title: s.title,
      titleSource: s.titleSource,
      question: s.question,
      status: s.status,
      roundCount: s.rounds.length,
      maxRounds: s.maxRounds,
      provider: s.model.provider,
      updatedAt: s.updatedAt,
      parentId: s.parentId,
      metrics: s.rounds.at(-1)?.metrics || null,
    };
  });
}

export async function readSimulation(
  id: string,
  owner: string,
): Promise<Simulation> {
  const db = await database();
  const result = await db.execute({
    sql: "SELECT data FROM simulations WHERE id = $1 AND owner = $2",
    args: [id, owner],
  });
  if (!result.rows.length)
    throw new AppError(
      "NOT_FOUND",
      "This simulation was not found in your workspace.",
      404,
    );
  return JSON.parse(String(result.rows[0].data)) as Simulation;
}

export async function insertSimulation(
  simulation: Simulation,
  owner: string,
  operation?: Operation,
) {
  const db = await database();
  const guard = writeGuard(owner, operation, 8);
  // Atomic quota: simultaneous creates cannot bypass the workspace limit.
  const statement = {
    sql: `INSERT INTO simulations (id, owner, title, created_at, updated_at, version, data)
      SELECT $1, $2, $3, $4, $5, $6, $7 WHERE (SELECT COUNT(*) FROM simulations WHERE owner = $8) < 100 AND ${guard.sql}`,
    args: [
      simulation.id,
      owner,
      simulation.title,
      simulation.createdAt,
      simulation.updatedAt,
      simulation.version,
      JSON.stringify(simulation),
      owner,
      ...guard.args,
    ],
  };
  const result = await db.transaction(async (tx) => {
    const written = await tx.execute(statement);
    if (written.rowsAffected && operation)
      await tx.execute(completionStatement(operation, simulation.id));
    return written;
  });
  if (!result.rowsAffected) {
    const authorizationGuard = writeGuard(owner, operation);
    const authorization = await db.execute({
      sql: `SELECT 1 WHERE ${authorizationGuard.sql}`,
      args: authorizationGuard.args,
    });
    if (!authorization.rows.length)
      throw new AppError(
        "SESSION_REVOKED",
        "This session expired, was locked or erased. Reload and unlock before continuing.",
        401,
      );
    throw new AppError(
      "WORKSPACE_FULL",
      "Your workspace has 100 simulations. Export and delete a run before creating another.",
      409,
    );
  }
  if (operation) operation.completed = true;
  return simulation;
}

export async function acquireLease(id: string, owner: string): Promise<Lease> {
  const simulation = await readSimulation(id, owner);
  const token = randomUUID();
  const db = await database();
  const result = await db.execute({
    sql: `UPDATE simulations SET lease_token = $1, lease_expires = $2
      WHERE id = $3 AND owner = $4 AND version = $5 AND (lease_token IS NULL OR lease_expires < $6)`,
    args: [
      token,
      Date.now() + LEASE_MS,
      id,
      owner,
      simulation.version,
      Date.now(),
    ],
  });
  if (result.rowsAffected !== 1)
    throw new AppError(
      "RUN_BUSY",
      "Another operation is running. Wait for it to finish, then retry. Interrupted operations unlock within 210 seconds.",
      409,
      true,
    );
  return { token, version: simulation.version, simulation };
}

export async function commitLease(
  lease: Lease,
  simulation: Simulation,
  owner: string,
  operation?: Operation,
) {
  const updated = {
    ...simulation,
    version: lease.version + 1,
    updatedAt: new Date().toISOString(),
  };
  const db = await database();
  const guard = writeGuard(owner, operation, 9);
  const statement = {
    sql: `UPDATE simulations SET data = $1, title = $2, updated_at = $3, version = $4, lease_token = NULL, lease_expires = 0
      WHERE id = $5 AND owner = $6 AND version = $7 AND lease_token = $8 AND lease_expires > $9 AND ${guard.sql}`,
    args: [
      JSON.stringify(updated),
      updated.title,
      updated.updatedAt,
      updated.version,
      updated.id,
      owner,
      lease.version,
      lease.token,
      Date.now(),
      ...guard.args,
    ],
  };
  const result = await db.transaction(async (tx) => {
    const written = await tx.execute(statement);
    if (written.rowsAffected && operation)
      await tx.execute(completionStatement(operation, updated.id));
    return written;
  });
  if (result.rowsAffected !== 1)
    throw new AppError(
      "STALE_OPERATION",
      "The run changed or its operation expired. Reload the latest saved state before retrying.",
      409,
      true,
    );
  if (operation) operation.completed = true;
  return updated;
}

export async function releaseLease(id: string, owner: string, token: string) {
  const db = await database();
  await db.execute({
    sql: "UPDATE simulations SET lease_token = NULL, lease_expires = 0 WHERE id = $1 AND owner = $2 AND lease_token = $3",
    args: [id, owner, token],
  });
}

export async function deleteSimulation(id: string, owner: string) {
  await readSimulation(id, owner);
  const db = await database();
  const result = await db.transaction(async (tx) => {
    const deleted = await tx.execute({
      sql: "DELETE FROM simulations WHERE id = $1 AND owner = $2 AND (lease_token IS NULL OR lease_expires < $3)",
      args: [id, owner, Date.now()],
    });
    if (deleted.rowsAffected) {
      await tx.execute({
        sql: "DELETE FROM trace_events WHERE owner = $1 AND operation_id IN (SELECT id FROM operations WHERE owner = $2 AND (simulation_id = $3 OR result_id = $4))",
        args: [owner, owner, id, id],
      });
      await tx.execute({
        sql: "DELETE FROM operations WHERE owner = $1 AND (simulation_id = $2 OR result_id = $3)",
        args: [owner, id, id],
      });
    }
    return deleted;
  });
  if (!result.rowsAffected)
    throw new AppError(
      "RUN_BUSY",
      "Wait for the current operation to finish before deleting this run.",
      409,
      true,
    );
}
