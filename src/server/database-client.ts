import type { Client as LibsqlClient, InStatement } from "@libsql/client";

export type SqlValue =
  string | number | bigint | boolean | null | Uint8Array | Date;
export type Statement = string | { sql: string; args?: SqlValue[] };
export interface QueryResult {
  rows: Record<string, unknown>[];
  rowsAffected: number;
}
export interface DatabaseExecutor {
  execute(statement: Statement): Promise<QueryResult>;
}
export interface DatabaseClient extends DatabaseExecutor {
  dialect: "sqlite" | "postgres";
  batch(
    statements: Statement[],
    mode?: "write" | "read" | "deferred",
  ): Promise<QueryResult[]>;
  /** SQL only: PostgreSQL serialization failures can re-run this callback. */
  transaction<T>(
    execute: (transaction: DatabaseExecutor) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

export function wrapLibsql(client: LibsqlClient): DatabaseClient {
  // The local synchronous SQLite driver cannot progress another connection's
  // transaction while it blocks waiting for a write lock. Serialize short SQL
  // work per client, with transaction statements bypassing this outer queue.
  let pending: Promise<unknown> = Promise.resolve();
  const serialized = <T>(execute: () => Promise<T>): Promise<T> => {
    const result = pending.then(execute);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return {
    dialect: "sqlite",
    execute: (statement) =>
      serialized(() => client.execute(statement as InStatement)),
    batch: (statements, mode = "write") =>
      serialized(() => client.batch(statements as InStatement[], mode)),
    transaction: (execute) =>
      serialized(async () => {
        const transaction = await client.transaction("write");
        try {
          const result = await execute({
            execute: (statement) =>
              transaction.execute(statement as InStatement),
          });
          await transaction.commit();
          return result;
        } catch (error) {
          await transaction.rollback().catch(() => undefined);
          throw error;
        } finally {
          transaction.close();
        }
      }),
    close: () =>
      serialized(async () => {
        client.close();
      }),
  };
}
