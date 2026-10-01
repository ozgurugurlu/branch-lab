import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../src/server/database-client";
import {
  databaseError,
  withDatabaseErrors,
} from "../src/server/database-errors";
import { AppError, publicError } from "../src/server/errors";

const privateText = "private-database-password-and-row-content";
const driverError = (code?: string) =>
  Object.assign(new Error(privateText), {
    code,
    detail: privateText,
    query: privateText,
    connectionString: privateText,
  });

describe("safe database errors", () => {
  it.each([
    ["28P01", "DATABASE_AUTHENTICATION", false],
    ["42501", "DATABASE_PERMISSION", false],
    ["42703", "DATABASE_SCHEMA", false],
    ["42P01", "DATABASE_SCHEMA", false],
    ["3D000", "DATABASE_CONFIGURATION", false],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "DATABASE_TLS", false],
    ["SELF_SIGNED_CERT_IN_CHAIN", "DATABASE_TLS", false],
    ["ECONNREFUSED", "DATABASE_UNAVAILABLE", true],
    ["40001", "DATABASE_UNAVAILABLE", true],
    ["40P01", "DATABASE_UNAVAILABLE", true],
    ["53300", "DATABASE_UNAVAILABLE", true],
    ["unrecognized-private-code", "DATABASE_OPERATION_FAILED", true],
  ])(
    "classifies %s without publishing driver details",
    (code, expected, retryable) => {
      const failure = databaseError(driverError(code as string));
      expect(failure).toMatchObject({ code: expected, retryable });
      expect(failure.message).not.toContain(privateText);
      expect(JSON.stringify(failure)).not.toContain(privateText);
      expect(JSON.stringify(failure)).not.toContain(
        "unrecognized-private-code",
      );
      expect(publicError(failure)).toBe(failure);
    },
  );

  it("preserves domain failures raised by a transaction callback", () => {
    const denied = new AppError(
      "SESSION_REVOKED",
      "This session was erased.",
      401,
    );
    expect(databaseError(denied)).toBe(denied);
  });

  it("does not mistake an arbitrary provider error for a database error", () => {
    expect(publicError(driverError("28P01")).code).toBe("OPERATION_FAILED");
  });

  it("normalizes execute, batch and transaction failures at their outer boundary", async () => {
    const raw: DatabaseClient = {
      dialect: "postgres",
      execute: vi.fn().mockRejectedValue(driverError("42703")),
      batch: vi.fn().mockRejectedValue(driverError("42501")),
      transaction: vi.fn().mockRejectedValue(driverError("40001")),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const db = withDatabaseErrors(raw);
    await expect(db.execute("SELECT 1")).rejects.toMatchObject({
      code: "DATABASE_SCHEMA",
    });
    await expect(db.batch(["SELECT 1"])).rejects.toMatchObject({
      code: "DATABASE_PERMISSION",
    });
    await expect(db.transaction(async () => 1)).rejects.toMatchObject({
      code: "DATABASE_UNAVAILABLE",
    });
    await db.close();
    expect(raw.close).toHaveBeenCalledOnce();
  });

  it("lets the adapter finish a serialization retry before mapping any error", async () => {
    const rawState = driverError("40001");
    let callbacks = 0;
    const raw: DatabaseClient = {
      dialect: "postgres",
      execute: vi.fn(),
      batch: vi.fn(),
      async transaction(callback) {
        try {
          return await callback({
            execute: async () => {
              throw rawState;
            },
          });
        } catch (error) {
          expect(error).toBe(rawState);
          return callback({
            execute: async () => ({ rows: [{ count: 1 }], rowsAffected: 0 }),
          });
        }
      },
      close: async () => {},
    };
    const result = await withDatabaseErrors(raw).transaction(
      async (transaction) => {
        callbacks++;
        return transaction.execute("SELECT 1");
      },
    );
    expect(callbacks).toBe(2);
    expect(result.rows).toEqual([{ count: 1 }]);
  });
});
