import type { DatabaseClient } from "./database-client";
import { AppError } from "./errors";

/** Called only at a database boundary. Driver details can contain secrets or SQL data. */
export function databaseError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;

  if (code === "28P01" || code === "28000")
    return new AppError(
      "DATABASE_AUTHENTICATION",
      "Database authentication failed. Check the database username and password in the server configuration, then restart the application.",
      503,
    );
  if (code === "42501")
    return new AppError(
      "DATABASE_PERMISSION",
      "The database role cannot access or initialize the application schema. Check its schema and table permissions, then restart the application.",
      503,
    );
  if (["42703", "42P01", "42804", "3F000"].includes(String(code)))
    return new AppError(
      "DATABASE_SCHEMA",
      "The selected database schema is incompatible with Branchlab. Use its dedicated DATABASE_SCHEMA=branchlab namespace and restart the application. Do not delete another application's tables.",
      503,
    );
  if (code === "3D000")
    return new AppError(
      "DATABASE_CONFIGURATION",
      "The configured database does not exist. Check the database name in DATABASE_URL, then restart the application.",
      503,
    );
  if (
    [
      "CERT_HAS_EXPIRED",
      "CERT_NOT_YET_VALID",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ].includes(String(code))
  )
    return new AppError(
      "DATABASE_TLS",
      "The database TLS certificate could not be verified. Check the database hostname and certificate authority configuration.",
      503,
    );
  if (
    [
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN",
      "EPIPE",
      "08000",
      "08001",
      "08003",
      "08004",
      "08006",
      "08007",
      "08P01",
      "53300",
      "53400",
      "57P01",
      "57P02",
      "57P03",
      "57014",
      "40001",
      "40P01",
      "55P03",
    ].includes(String(code))
  )
    return new AppError(
      "DATABASE_UNAVAILABLE",
      "The database is temporarily unavailable or busy. Check connectivity and retry.",
      503,
      true,
    );
  return new AppError(
    "DATABASE_OPERATION_FAILED",
    "The database operation could not finish. Check the server database configuration, then retry.",
    500,
    true,
  );
}

/** Normalize outside the adapter so its SQLSTATE-based transaction retries remain intact. */
export function withDatabaseErrors(client: DatabaseClient): DatabaseClient {
  const run = async <T>(execute: () => Promise<T>): Promise<T> => {
    try {
      return await execute();
    } catch (error) {
      throw databaseError(error);
    }
  };
  return {
    dialect: client.dialect,
    execute: (statement) => run(() => client.execute(statement)),
    batch: (statements, mode) => run(() => client.batch(statements, mode)),
    transaction: (execute) => run(() => client.transaction(execute)),
    close: () => run(() => client.close()),
  };
}
