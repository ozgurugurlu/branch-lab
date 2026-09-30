import { isIP } from "node:net";
import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResult as PgResult,
} from "pg";
import type {
  DatabaseClient,
  DatabaseExecutor,
  QueryResult,
  Statement,
} from "./database-client";
import { AppError } from "./errors";

/** Parse explicitly: do not inherit PGHOST/PGPASSWORD or URL options that redirect credentials. */
export function postgresConfig(value: string): PoolConfig {
  try {
    const url = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      !url.pathname.slice(1) ||
      url.hash
    )
      throw new Error();
    const allowed = new Set(["sslmode", "channel_binding"]);
    if ([...url.searchParams.keys()].some((key) => !allowed.has(key)))
      throw new Error();
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const loopback =
      host === "localhost" ||
      host === "::1" ||
      host === "host.docker.internal" ||
      (isIP(host) === 4 && host.startsWith("127."));
    const sslMode = url.searchParams.get("sslmode");
    if (sslMode && !["disable", "require", "verify-full"].includes(sslMode))
      throw new Error();
    if (!loopback && sslMode === "disable") throw new Error();
    const binding = url.searchParams.get("channel_binding");
    if (binding && !["disable", "prefer", "require"].includes(binding))
      throw new Error();
    const ssl = !loopback || (sslMode !== null && sslMode !== "disable");
    return {
      host,
      port: url.port ? Number(url.port) : 5432,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)),
      ssl: ssl
        ? {
            rejectUnauthorized: true,
            ...(process.env.DATABASE_SSL_CA
              ? { ca: process.env.DATABASE_SSL_CA }
              : {}),
          }
        : false,
      enableChannelBinding: binding !== "disable",
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 15_000,
      idle_in_transaction_session_timeout: 15_000,
      application_name: "branchlab",
      allowExitOnIdle: true,
    };
  } catch {
    throw new AppError(
      "DATABASE_CONFIGURATION",
      "Set DATABASE_URL to a PostgreSQL connection URL with a username and database. Remote connections require verified TLS; supported options are sslmode=require|verify-full and channel_binding.",
      503,
    );
  }
}

function normalized(result: PgResult): QueryResult {
  return {
    rows: result.rows as Record<string, unknown>[],
    rowsAffected: ["INSERT", "UPDATE", "DELETE", "MERGE"].includes(
      result.command,
    )
      ? (result.rowCount ?? 0)
      : 0,
  };
}
function statementParts(statement: Statement) {
  return typeof statement === "string"
    ? { sql: statement, args: [] }
    : { sql: statement.sql, args: statement.args ?? [] };
}
async function executeOn(
  client: Pool | PoolClient,
  statement: Statement,
): Promise<QueryResult> {
  const { sql, args } = statementParts(statement);
  return normalized(await client.query(sql, args));
}

export function createPostgresClient(connectionURL: string): DatabaseClient {
  const pool = new Pool(postgresConfig(connectionURL));
  pool.on("error", () =>
    console.error(
      JSON.stringify({
        event: "database_pool_error",
        code: "DATABASE_UNAVAILABLE",
      }),
    ),
  );
  const database: DatabaseClient = {
    dialect: "postgres",
    execute: (statement) => executeOn(pool, statement),
    async batch(statements) {
      return database.transaction(async (transaction) => {
        const results: QueryResult[] = [];
        for (const statement of statements)
          results.push(await transaction.execute(statement));
        return results;
      });
    },
    async transaction<T>(
      execute: (transaction: DatabaseExecutor) => Promise<T>,
    ): Promise<T> {
      // Serializable isolation protects quota/read-then-write predicates across connections.
      // Only these short SQL callbacks are repeated; no model inference runs here.
      for (let attempt = 0; ; attempt++) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
          const result = await execute({
            execute: (statement) => executeOn(client, statement),
          });
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          const code = (error as { code?: unknown })?.code;
          if (attempt >= 7 || (code !== "40001" && code !== "40P01"))
            throw error;
        } finally {
          client.release();
        }
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(5 * 2 ** attempt, 100) + Math.random() * 10,
          ),
        );
      }
    },
    close: () => pool.end(),
  };
  return database;
}
