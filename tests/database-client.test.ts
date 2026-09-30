import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { wrapLibsql, type DatabaseClient } from "../src/server/database-client";

let client: DatabaseClient | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function connection() {
  client = wrapLibsql(createClient({ url: ":memory:" }));
  await client.execute(
    "CREATE TABLE counters (id TEXT PRIMARY KEY, value INTEGER NOT NULL)",
  );
  return client;
}

describe("libSQL short transaction queue", () => {
  it("serializes concurrent read-modify-write transactions without blocking the synchronous SQLite driver", async () => {
    const db = await connection();
    await db.execute({
      sql: "INSERT INTO counters (id, value) VALUES ($1, $2)",
      args: ["shared", 0],
    });
    await Promise.all(
      Array.from({ length: 20 }, () =>
        db.transaction(async (tx) => {
          const current = await tx.execute({
            sql: "SELECT value FROM counters WHERE id = $1",
            args: ["shared"],
          });
          await Promise.resolve();
          await tx.execute({
            sql: "UPDATE counters SET value = $1 WHERE id = $2",
            args: [Number(current.rows[0].value) + 1, "shared"],
          });
        }),
      ),
    );
    expect((await db.execute("SELECT value FROM counters")).rows[0].value).toBe(
      20,
    );
  });

  it("rolls back failed callbacks and lets queued work continue after rejection", async () => {
    const db = await connection();
    const failed = db.transaction(async (tx) => {
      await tx.execute({
        sql: "INSERT INTO counters (id, value) VALUES ($1, $2)",
        args: ["rollback", 1],
      });
      throw new Error("Fixture failure");
    });
    const next = db.execute({
      sql: "INSERT INTO counters (id, value) VALUES ($1, $2)",
      args: ["survivor", 2],
    });
    await expect(failed).rejects.toThrow("Fixture failure");
    await next;
    expect((await db.execute("SELECT id, value FROM counters")).rows).toEqual([
      { id: "survivor", value: 2 },
    ]);
  });

  it("does not expose partially applied transaction state to queued reads", async () => {
    const db = await connection();
    const transaction = db.transaction(async (tx) => {
      await tx.execute({
        sql: "INSERT INTO counters (id, value) VALUES ($1, $2)",
        args: ["saved", 1],
      });
      await Promise.resolve();
      await tx.execute({
        sql: "UPDATE counters SET value = $1 WHERE id = $2",
        args: [2, "saved"],
      });
    });
    const read = db.execute("SELECT value FROM counters");
    await transaction;
    expect((await read).rows[0].value).toBe(2);
  });
});
