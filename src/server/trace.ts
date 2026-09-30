import { randomUUID } from "node:crypto";
import type {
  EngineRuntimeHooks,
  EngineTraceEvent,
  ExecutionFeed,
  ExecutionTrace,
} from "@/lib/types";
import { database } from "./db";
import { AppError } from "./errors";
import { listOperations, operationRecord, type Operation } from "./operations";
import { readSimulation } from "./store";
import { searchWeb, webSearchConfigured } from "./web-search";

export async function operationRuntime(
  operation: Operation,
  allowWebSearch = false,
  parentSignal?: AbortSignal,
) {
  const db = await database();
  const existing = await db.execute({
    sql: "SELECT COALESCE(MAX(sequence), 0) AS last FROM trace_events WHERE operation_id = $1 AND owner = $2",
    args: [operation.id, operation.owner],
  });
  let sequence = Number(existing.rows[0].last);
  let modelCalls = 0;
  let searches = 0;
  let emitted = 0;
  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  const onEvent = async (event: EngineTraceEvent) => {
    if (++emitted > 300)
      throw new AppError(
        "TRACE_LIMIT",
        "The operation exceeded its bounded execution-event budget.",
        500,
      );
    if (event.kind === "phase-end" && event.modelCalls)
      modelCalls += event.modelCalls;
    const trace: ExecutionTrace = {
      ...event,
      summary: event.summary.slice(0, 400),
      id: randomUUID(),
      operationId: operation.id,
      sequence: ++sequence,
      createdAt: new Date().toISOString(),
    };
    const written = await db.transaction((tx) =>
      tx.execute({
        sql: `INSERT INTO trace_events (id, operation_id, owner, sequence, created_at, data)
        SELECT $1, $2, $3, $4, $5, $6 WHERE EXISTS
        (SELECT 1 FROM operations WHERE id = $7 AND owner = $8 AND token = $9 AND status = 'running' AND expires_at > $10)`,
        args: [
          trace.id,
          operation.id,
          operation.owner,
          trace.sequence,
          trace.createdAt,
          JSON.stringify(trace),
          operation.id,
          operation.owner,
          operation.token,
          Date.now(),
        ],
      }),
    );
    if (!written.rowsAffected) {
      const error = new AppError(
        "OPERATION_REVOKED",
        "This operation was locked, erased or expired. Reload the saved workspace before continuing.",
        409,
      );
      controller.abort(error);
      throw error;
    }
  };
  const hooks: EngineRuntimeHooks = { onEvent };
  if (allowWebSearch && webSearchConfigured())
    hooks.searchWeb = async (query, signal) => {
      if (++searches > 3)
        throw new AppError(
          "SEARCH_BUDGET",
          "This operation reached its three-search limit.",
          429,
        );
      const results = await searchWeb(query, operation.owner, signal);
      await onEvent({
        phase: "research",
        kind: "tool-result",
        tool: "search_web",
        summary: `Retrieved ${results.length} web search results. Search snippets are unverified external claims.`,
        status: "success",
        webSources: results.map(({ title, url }) => ({ title, url })),
      });
      return results;
    };
  return { hooks, signal, modelCalls: () => modelCalls };
}

export async function executionFeed(
  owner: string,
  selector: { simulationId: string } | { requestId: string },
): Promise<ExecutionFeed> {
  const db = await database();
  let operationIds: string[];
  let operations: ExecutionFeed["operations"];
  if ("simulationId" in selector) {
    await readSimulation(selector.simulationId, owner);
    operations = await listOperations(selector.simulationId, owner);
    operationIds = operations.map((op) => op.id);
  } else {
    const result = await db.execute({
      sql: "SELECT * FROM operations WHERE owner = $1 AND request_key = $2",
      args: [owner, selector.requestId],
    });
    operations = result.rows.map(operationRecord);
    operationIds = operations.map((op) => op.id);
  }
  if (!operationIds.length) return { operations, events: [] };
  const result = await db.execute({
    sql: `SELECT data FROM trace_events WHERE owner = $1 AND operation_id IN (${operationIds.map((_, i) => `$${i + 2}`).join(",")}) ORDER BY created_at DESC, sequence DESC LIMIT 600`,
    args: [owner, ...operationIds],
  });
  return {
    operations,
    events: result.rows
      .map((row) => JSON.parse(String(row.data)) as ExecutionTrace)
      .reverse(),
  };
}
