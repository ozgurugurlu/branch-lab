import { createHash, randomUUID } from "node:crypto";
import type { Statement } from "./db";
import type { OperationRecord, Simulation } from "@/lib/types";
import { ENGINE_VERSION, PROMPT_VERSION } from "@/mastra/domain";
import { database } from "./db";
import { AppError, publicError } from "./errors";
import { readSimulation } from "./store";

export interface Operation {
  id: string;
  owner: string;
  token: string;
  completed?: boolean;
}

/** Only metadata is recorded: never prompts, source text, answers or provider errors. */
export async function withOperation(
  owner: string,
  kind: OperationRecord["kind"],
  simulationId: string | null,
  input: unknown,
  requestId: string | undefined,
  execute: (operation: Operation) => Promise<Simulation>,
): Promise<Simulation> {
  const db = await database();
  const requestKey = requestId || randomUUID();
  const hash = createHash("sha256")
    .update(JSON.stringify({ kind, simulationId, input }))
    .digest("hex");
  const operation: Operation = { id: randomUUID(), owner, token: randomUUID() };
  const now = Date.now();
  const inserted = await db.transaction((tx) =>
    tx.execute({
      sql: `INSERT INTO operations (id, owner, simulation_id, kind, status, started_at, expires_at, token, engine_version, prompt_version, request_hash, request_key)
      SELECT $1, $2, $3, $4, 'running', $5, $6, $7, $8, $9, $10, $11
      WHERE NOT EXISTS (SELECT 1 FROM revoked_sessions WHERE id = $12)
      AND (SELECT COUNT(*) FROM operations WHERE owner = $13) < 5000
      ON CONFLICT(owner, request_key) DO NOTHING`,
      args: [
        operation.id,
        owner,
        simulationId,
        kind,
        new Date(now).toISOString(),
        now + 210_000,
        operation.token,
        ENGINE_VERSION,
        PROMPT_VERSION,
        hash,
        requestKey,
        owner,
        owner,
      ],
    }),
  );
  if (!inserted.rowsAffected) {
    const existing = await db.execute({
      sql: "SELECT * FROM operations WHERE owner = $1 AND request_key = $2",
      args: [owner, requestKey],
    });
    const row = existing.rows[0];
    if (!row) {
      const revoked = await db.execute({
        sql: "SELECT id FROM revoked_sessions WHERE id = $1",
        args: [owner],
      });
      if (revoked.rows.length)
        throw new AppError(
          "SESSION_REVOKED",
          "This workspace was erased. Reload to start a new workspace.",
          401,
        );
      throw new AppError(
        "OPERATION_HISTORY_FULL",
        "This workspace reached its 5,000-operation history limit. Export and delete older runs, or erase the workspace, before starting another action.",
        409,
      );
    }
    if (row.request_hash !== hash)
      throw new AppError(
        "IDEMPOTENCY_CONFLICT",
        "This request identifier was already used for different input. Submit a new action.",
        409,
      );
    if (row.status === "completed" && row.result_id)
      return readSimulation(String(row.result_id), owner);
    operation.id = String(row.id);
    const claimed = await db.transaction((tx) =>
      tx.execute({
        sql: `UPDATE operations SET status = 'running', token = $1, started_at = $2, finished_at = NULL,
        expires_at = $3, error_code = NULL, attempt = attempt + 1, engine_version = $4, prompt_version = $5
        WHERE id = $6 AND owner = $7 AND (status IN ('failed', 'interrupted') OR (status = 'running' AND expires_at < $8))
        AND NOT EXISTS (SELECT 1 FROM revoked_sessions WHERE id = $9)`,
        args: [
          operation.token,
          new Date(now).toISOString(),
          now + 210_000,
          ENGINE_VERSION,
          PROMPT_VERSION,
          operation.id,
          owner,
          now,
          owner,
        ],
      }),
    );
    if (!claimed.rowsAffected)
      throw new AppError(
        "RUN_BUSY",
        "This action is still running. Reload its saved state before retrying; interrupted actions unlock within 210 seconds.",
        409,
        true,
      );
  }
  try {
    const result = await execute(operation);
    // Writes normally complete this row in the same SQL transaction as the checkpoint.
    // The fallback covers successful no-op retries (e.g. an already advanced round).
    if (!operation.completed)
      await db.execute(completionStatement(operation, result.id));
    return result;
  } catch (error) {
    await db
      .execute({
        sql: "UPDATE operations SET status = 'failed', error_code = $1, finished_at = $2 WHERE id = $3 AND owner = $4 AND token = $5 AND status = 'running'",
        args: [
          publicError(error).code,
          new Date().toISOString(),
          operation.id,
          owner,
          operation.token,
        ],
      })
      .catch(() => undefined);
    throw error;
  }
}

export function completionStatement(
  operation: Operation,
  resultId: string,
): Statement {
  return {
    sql: `UPDATE operations SET status = 'completed', result_id = $1, simulation_id = COALESCE(simulation_id, $2), finished_at = $3, error_code = NULL
      WHERE id = $4 AND owner = $5 AND token = $6 AND status = 'running' AND expires_at > $7`,
    args: [
      resultId,
      resultId,
      new Date().toISOString(),
      operation.id,
      operation.owner,
      operation.token,
      Date.now(),
    ],
  };
}

export async function listOperations(
  id: string,
  owner: string,
): Promise<OperationRecord[]> {
  await readSimulation(id, owner);
  const db = await database();
  const result = await db.execute({
    sql: "SELECT * FROM operations WHERE owner = $1 AND simulation_id = $2 ORDER BY started_at DESC LIMIT 100",
    args: [owner, id],
  });
  return result.rows.map(operationRecord);
}

export function operationRecord(row: Record<string, unknown>): OperationRecord {
  return {
    id: String(row.id),
    simulationId:
      row.simulation_id != null
        ? String(row.simulation_id)
        : row.result_id != null
          ? String(row.result_id)
          : null,
    kind: row.kind as OperationRecord["kind"],
    status:
      row.status === "running" && Number(row.expires_at) < Date.now()
        ? "interrupted"
        : (row.status as OperationRecord["status"]),
    startedAt: String(row.started_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    errorCode: row.error_code ? String(row.error_code) : null,
    attempt: Number(row.attempt),
    engineVersion: String(row.engine_version),
    promptVersion: String(row.prompt_version),
  };
}
