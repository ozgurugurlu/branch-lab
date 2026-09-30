import { wrapLibsql, type DatabaseClient } from "./database-client";
import { createPostgresClient } from "./postgres";
import { AppError } from "./errors";

export type {
  DatabaseClient,
  DatabaseExecutor,
  QueryResult,
  SqlValue,
  Statement,
} from "./database-client";
let clientPromise: Promise<DatabaseClient> | undefined;
let nextCleanup = 0;
let cleanupPromise: Promise<void> | undefined;

export function databaseBackend(): "libsql" | "postgres" {
  return process.env.DATABASE_URL?.trim() ? "postgres" : "libsql";
}
export function storageMode(): "local" | "remote" {
  return databaseBackend() === "postgres" ||
    (process.env.TURSO_DATABASE_URL &&
      !process.env.TURSO_DATABASE_URL.startsWith("file:"))
    ? "remote"
    : "local";
}

async function connect(): Promise<DatabaseClient> {
  let client: DatabaseClient;
  if (databaseBackend() === "postgres") {
    client = createPostgresClient(process.env.DATABASE_URL!.trim());
  } else {
    const url = process.env.TURSO_DATABASE_URL || "file:.data/branchlab.db";
    if (url.startsWith("file:")) {
      if (process.env.VERCEL || process.env.CF_PAGES || process.env.WORKERS_CI)
        throw new AppError(
          "DATABASE_CONFIGURATION",
          "Set DATABASE_URL to PostgreSQL/Neon, or TURSO_DATABASE_URL and TURSO_AUTH_TOKEN to a remote database before deploying.",
          503,
        );
      const { mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(url.slice(5)), { recursive: true });
      const { createClient } = await import("@libsql/client");
      client = wrapLibsql(createClient({ url }));
      await client.execute("PRAGMA journal_mode = WAL");
      await client.execute("PRAGMA busy_timeout = 5000");
    } else {
      const { createClient } = await import("@libsql/client/web");
      client = wrapLibsql(
        createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN }),
      );
    }
  }
  try {
    await client.batch(
      [
        ...(client.dialect === "postgres"
          ? ["SELECT pg_advisory_xact_lock(2026093001)"]
          : []),
        `CREATE TABLE IF NOT EXISTS simulations (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version BIGINT NOT NULL,
        data TEXT NOT NULL, lease_token TEXT, lease_expires BIGINT NOT NULL DEFAULT 0
      )`,
        "CREATE INDEX IF NOT EXISTS simulations_owner_updated ON simulations(owner, updated_at DESC)",
        `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, authenticated BIGINT NOT NULL DEFAULT 0,
        expires_at BIGINT NOT NULL, auth_fingerprint TEXT
      )`,
        `CREATE TABLE IF NOT EXISTS rate_limits (
        key TEXT PRIMARY KEY, count BIGINT NOT NULL DEFAULT 0, resets_at BIGINT NOT NULL
      )`,
        `CREATE TABLE IF NOT EXISTS revoked_sessions (id TEXT PRIMARY KEY, revoked_at BIGINT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, simulation_id TEXT,
        kind TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL,
        finished_at TEXT, expires_at BIGINT NOT NULL, error_code TEXT,
        attempt BIGINT NOT NULL DEFAULT 1, token TEXT NOT NULL,
        engine_version TEXT NOT NULL, prompt_version TEXT NOT NULL,
        request_hash TEXT NOT NULL, request_key TEXT NOT NULL,
        result_id TEXT, UNIQUE(owner, request_key)
      )`,
        "CREATE INDEX IF NOT EXISTS operations_owner_run ON operations(owner, simulation_id, started_at DESC)",
        `CREATE TABLE IF NOT EXISTS trace_events (
        id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, owner TEXT NOT NULL,
        sequence BIGINT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL,
        UNIQUE(operation_id, sequence)
      )`,
        "CREATE INDEX IF NOT EXISTS trace_events_owner_operation ON trace_events(owner, operation_id, sequence)",
        "CREATE TABLE IF NOT EXISTS schema_migrations (version BIGINT PRIMARY KEY, applied_at TEXT NOT NULL)",
        {
          sql: "INSERT INTO schema_migrations (version, applied_at) VALUES (3, $1) ON CONFLICT(version) DO NOTHING",
          args: [new Date().toISOString()],
        },
      ],
      "write",
    );
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

export async function database(): Promise<DatabaseClient> {
  if (!clientPromise)
    clientPromise = connect().catch((error) => {
      clientPromise = undefined;
      throw error;
    });
  return clientPromise;
}

/** Test-only lifecycle helper; no request can choose the database location. */
export async function closeDatabase() {
  if (clientPromise) await (await clientPromise).close();
  clientPromise = undefined;
  nextCleanup = 0;
  cleanupPromise = undefined;
}

/** Lazy retention: expired workspaces are removed on traffic, at most every five minutes per process. */
export async function pruneExpiredWorkspaces(client: DatabaseClient) {
  if (cleanupPromise) return cleanupPromise;
  if (Date.now() < nextCleanup) return;
  const now = Date.now();
  cleanupPromise = client
    .batch(
      [
        {
          sql: "INSERT INTO revoked_sessions (id, revoked_at) SELECT id, $1 FROM sessions WHERE expires_at <= $2 ON CONFLICT(id) DO NOTHING",
          args: [now, now],
        },
        {
          sql: "DELETE FROM simulations WHERE owner IN (SELECT id FROM sessions WHERE expires_at <= $1)",
          args: [now],
        },
        {
          sql: "DELETE FROM trace_events WHERE owner IN (SELECT id FROM sessions WHERE expires_at <= $1)",
          args: [now],
        },
        {
          sql: "DELETE FROM operations WHERE owner IN (SELECT id FROM sessions WHERE expires_at <= $1)",
          args: [now],
        },
        { sql: "DELETE FROM rate_limits WHERE resets_at <= $1", args: [now] },
        { sql: "DELETE FROM sessions WHERE expires_at <= $1", args: [now] },
        {
          sql: "DELETE FROM revoked_sessions WHERE revoked_at < $1",
          args: [now - 86_400_000],
        },
      ],
      "write",
    )
    .then(() => {
      nextCleanup = now + 300_000;
    })
    .finally(() => {
      cleanupPromise = undefined;
    });
  return cleanupPromise;
}
