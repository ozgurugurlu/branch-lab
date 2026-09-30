import { randomUUID } from "node:crypto";
import type { Simulation, SimulationSummary } from "@/lib/types";
import { database } from "./db";
import { AppError } from "./errors";

const LEASE_MS = 210_000;
export interface Lease {
  token: string;
  version: number;
  simulation: Simulation;
}

export async function listSimulations(
  owner: string,
): Promise<SimulationSummary[]> {
  const db = await database();
  const result = await db.execute({
    sql: "SELECT data FROM simulations WHERE owner = ? ORDER BY updated_at DESC LIMIT 100",
    args: [owner],
  });
  return result.rows.map((row) => {
    const s = JSON.parse(String(row.data)) as Simulation;
    return {
      id: s.id,
      title: s.title,
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
    sql: "SELECT data FROM simulations WHERE id = ? AND owner = ?",
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

export async function insertSimulation(simulation: Simulation, owner: string) {
  const db = await database();
  // Atomic quota: simultaneous creates cannot bypass the workspace limit.
  const result = await db.execute({
    sql: `INSERT INTO simulations (id, owner, title, created_at, updated_at, version, data)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM simulations WHERE owner = ?) < 100`,
    args: [
      simulation.id,
      owner,
      simulation.title,
      simulation.createdAt,
      simulation.updatedAt,
      simulation.version,
      JSON.stringify(simulation),
      owner,
    ],
  });
  if (!result.rowsAffected)
    throw new AppError(
      "WORKSPACE_FULL",
      "Your workspace has 100 simulations. Export and delete a run before creating another.",
      409,
    );
  return simulation;
}

export async function acquireLease(id: string, owner: string): Promise<Lease> {
  const simulation = await readSimulation(id, owner);
  const token = randomUUID();
  const db = await database();
  const result = await db.execute({
    sql: `UPDATE simulations SET lease_token = ?, lease_expires = ?
      WHERE id = ? AND owner = ? AND version = ? AND (lease_token IS NULL OR lease_expires < ?)`,
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
) {
  const updated = {
    ...simulation,
    version: lease.version + 1,
    updatedAt: new Date().toISOString(),
  };
  const db = await database();
  const result = await db.execute({
    sql: `UPDATE simulations SET data = ?, title = ?, updated_at = ?, version = ?, lease_token = NULL, lease_expires = 0
      WHERE id = ? AND owner = ? AND version = ? AND lease_token = ? AND lease_expires > ?`,
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
    ],
  });
  if (result.rowsAffected !== 1)
    throw new AppError(
      "STALE_OPERATION",
      "The run changed or its operation expired. Reload the latest saved state before retrying.",
      409,
      true,
    );
  return updated;
}

export async function releaseLease(id: string, owner: string, token: string) {
  const db = await database();
  await db.execute({
    sql: "UPDATE simulations SET lease_token = NULL, lease_expires = 0 WHERE id = ? AND owner = ? AND lease_token = ?",
    args: [id, owner, token],
  });
}

export async function deleteSimulation(id: string, owner: string) {
  await readSimulation(id, owner);
  const db = await database();
  const result = await db.execute({
    sql: "DELETE FROM simulations WHERE id = ? AND owner = ? AND (lease_token IS NULL OR lease_expires < ?)",
    args: [id, owner, Date.now()],
  });
  if (!result.rowsAffected)
    throw new AppError(
      "RUN_BUSY",
      "Wait for the current operation to finish before deleting this run.",
      409,
      true,
    );
}
