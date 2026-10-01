import {
  wrapLibsql,
  type DatabaseClient,
  type DatabaseExecutor,
  type Statement,
} from "./database-client";
import { createPostgresClient, postgresSchema } from "./postgres";
import { databaseError, withDatabaseErrors } from "./database-errors";
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

const expectedColumns = {
  simulations:
    "id:text owner:text title:text created_at:text updated_at:text version:int8 data:text lease_token:text lease_expires:int8",
  sessions: "id:text authenticated:int8 expires_at:int8 auth_fingerprint:text",
  rate_limits: "key:text count:int8 resets_at:int8",
  revoked_sessions: "id:text revoked_at:int8",
  operations:
    "id:text owner:text simulation_id:text kind:text status:text started_at:text finished_at:text expires_at:int8 error_code:text attempt:int8 token:text engine_version:text prompt_version:text request_hash:text request_key:text result_id:text",
  trace_events:
    "id:text operation_id:text owner:text sequence:int8 created_at:text data:text",
  schema_migrations: "version:int8 applied_at:text",
} as const;
const expectedUniqueKeys: Record<keyof typeof expectedColumns, string[]> = {
  simulations: ["id"],
  sessions: ["id"],
  rate_limits: ["key"],
  revoked_sessions: ["id"],
  operations: ["id", "owner,request_key"],
  trace_events: ["id", "operation_id,sequence"],
  schema_migrations: ["version"],
};
const expectedDefaults: Record<string, Record<string, string>> = {
  simulations: { lease_expires: "0" },
  sessions: { authenticated: "0" },
  operations: { attempt: "1" },
};

/** Metadata only, before application table creation, reads, writes or retention. */
async function validatePostgresSchema(tx: DatabaseExecutor, schema: string) {
  let complete = true;
  const tables = Object.keys(expectedColumns)
    .map((name) => `'${name}'`)
    .join(",");
  const columns = await tx.execute({
    sql: `SELECT c.relname AS table_name, c.relkind, a.attname AS column_name, t.typname AS data_type,
      a.attnotnull AS required, (d.oid IS NOT NULL OR a.attidentity <> '' OR a.attgenerated <> '') AS has_default,
      pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_expression
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      LEFT JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE n.nspname = $1 AND c.relname IN (${tables})`,
    args: [schema],
  });
  const indexes = await tx.execute({
    sql: `SELECT c.relname AS table_name, string_agg(a.attname, ',' ORDER BY k.ordinality) AS key_columns
      FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
      WHERE n.nspname = $1 AND c.relname IN (${tables}) AND i.indisunique AND i.indisvalid AND i.indimmediate
        AND i.indpred IS NULL AND i.indexprs IS NULL AND k.ordinality <= i.indnkeyatts
      GROUP BY c.relname, i.indexrelid`,
    args: [schema],
  });
  for (const [table, definition] of Object.entries(expectedColumns)) {
    const existing = columns.rows.filter((row) => row.table_name === table);
    if (!existing.length) {
      complete = false;
      continue;
    }
    const fail = (detail: string): never => {
      throw new AppError(
        "DATABASE_SCHEMA",
        `The selected PostgreSQL schema has an incompatible ${table} table (${detail}). Select an unused DATABASE_SCHEMA or the schema containing compatible Branchlab tables. No existing tables were changed.`,
        503,
      );
    };
    if (existing.some((row) => row.relkind !== "r" && row.relkind !== "p"))
      fail("a regular table is required");
    const expected = new Map(
      definition.split(" ").map((item) => item.split(":") as [string, string]),
    );
    for (const [name, type] of expected) {
      const column = existing.find((row) => row.column_name === name);
      if (!column || column.data_type !== type)
        fail(
          `expected ${name} with type ${type === "int8" ? "bigint" : "text"}`,
        );
    }
    for (const [name, value] of Object.entries(expectedDefaults[table] ?? {})) {
      const column = existing.find((row) => row.column_name === name);
      const expression = String(column?.default_expression ?? "").replace(
        /\s/g,
        "",
      );
      if (
        ![
          value,
          `(${value})`,
          `${value}::bigint`,
          `'${value}'::bigint`,
        ].includes(expression)
      )
        fail(`expected ${name} default ${value}`);
    }
    if (
      existing.some(
        (row) =>
          !expected.has(String(row.column_name)) &&
          row.required === true &&
          row.has_default !== true,
      )
    )
      fail("unexpected required columns");
    for (const key of expectedUniqueKeys[
      table as keyof typeof expectedColumns
    ]) {
      if (
        !indexes.rows.some(
          (row) => row.table_name === table && row.key_columns === key,
        )
      )
        fail(`missing unique key ${key}`);
    }
  }
  return complete;
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
    const statements: Statement[] = [
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
    ];
    if (client.dialect === "postgres") {
      const schema = postgresSchema();
      await client.transaction(async (tx) => {
        await tx.execute("SELECT pg_advisory_xact_lock(2026093001)");
        const namespace = await tx.execute({
          sql: "SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1",
          args: [schema],
        });
        if (!namespace.rows.length)
          await tx.execute(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
        const complete = await validatePostgresSchema(tx, schema);
        if (complete) {
          const current = await tx.execute(
            "SELECT 1 FROM schema_migrations WHERE version = 3",
          );
          if (current.rows.length) return;
        }
        for (const statement of statements) await tx.execute(statement);
      });
    } else {
      await client.batch(statements, "write");
    }
    return withDatabaseErrors(client);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw databaseError(error);
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
