import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { CreateSimulationInput } from "../src/lib/types";
import { closeDatabase, database, databaseBackend } from "../src/server/db";
import { postgresConfig } from "../src/server/postgres";
import {
  consumeLimit,
  getSession,
  setAuthenticated,
} from "../src/server/security";
import {
  createSimulation,
  stepSimulation,
  chatSimulation,
  reportSimulation,
} from "../src/server/simulations";
import {
  acquireLease,
  commitLease,
  insertSimulation,
  listSimulations,
  readSimulation,
  releaseLease,
} from "../src/server/store";
import { eraseWorkspace } from "../src/server/privacy";
import { operationRuntime } from "../src/server/trace";

const testURL = process.env.TEST_DATABASE_URL;
const signal = () => AbortSignal.timeout(10_000);

async function pauseInserts(table: "operations" | "trace_events") {
  const db = await database();
  await db.execute(
    "CREATE OR REPLACE FUNCTION branchlab_test_pause_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END; $$",
  );
  await db.execute(
    `CREATE TRIGGER branchlab_test_pause_write BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION branchlab_test_pause_write()`,
  );
  return async () => {
    await db.execute(
      `DROP TRIGGER IF EXISTS branchlab_test_pause_write ON ${table}`,
    );
    await db.execute("DROP FUNCTION IF EXISTS branchlab_test_pause_write()");
  };
}
async function waitForPausedInsert(table: "operations" | "trace_events") {
  const db = await database();
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = await db.execute({
      sql: "SELECT COUNT(*) AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'PgSleep' AND query LIKE $1",
      args: [`INSERT INTO ${table}%`],
    });
    if (Number(result.rows[0].count)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    "The test INSERT did not reach its controlled concurrency barrier.",
  );
}
const input: CreateSimulationInput = {
  title: "PostgreSQL community pilot",
  question: "How would residents respond to a six-week street pilot?",
  context: "Preserve deliveries and compare stakeholder responses.",
  model: { provider: "demo", model: "branchlab-demo" },
  seed: 42,
  actorCount: 4,
  maxRounds: 2,
  sources: [],
};

afterEach(() => vi.unstubAllEnvs());

describe("PostgreSQL connection configuration", () => {
  it("requires verified TLS for Neon and leaves loopback PostgreSQL usable without TLS", () => {
    const neon = postgresConfig(
      "postgresql://user:test-only@ep-example-pooler.neon.tech/branchlab?sslmode=require&channel_binding=require",
    );
    expect(neon.ssl).toMatchObject({ rejectUnauthorized: true });
    expect(neon.enableChannelBinding).toBe(true);
    expect(neon.max).toBe(5);
    expect(neon.host).toBe("ep-example-pooler.neon.tech");
    expect(
      postgresConfig(
        "postgresql://user:test-only@127.0.0.1:5432/branchlab_test",
      ).ssl,
    ).toBe(false);
  });
  it.each([
    "https://private-credential@example.com/database",
    "postgresql://user:private-credential@example.com/database?sslmode=disable",
    "postgresql://user:private-credential@example.com/database?host=unexpected.example",
    "postgresql://user:private-credential@example.com/",
    "not-a-url-private-credential",
  ])(
    "rejects unsafe or invalid connection settings without echoing the URL",
    (value) => {
      try {
        postgresConfig(value);
        throw new Error("Expected configuration rejection");
      } catch (error) {
        expect(error).toMatchObject({
          code: "DATABASE_CONFIGURATION",
          status: 503,
        });
        expect(String(error)).not.toContain("private-credential");
      }
    },
  );
});

// Explicit opt-in only; the supplied database must be disposable and end in _test.
// No test reads DATABASE_URL from a developer's ordinary application environment.
describe.skipIf(!testURL)(
  "PostgreSQL integration against a real disposable database",
  () => {
    beforeEach(async () => {
      if (!new URL(testURL!).pathname.endsWith("_test"))
        throw new Error(
          "TEST_DATABASE_URL must name a disposable database ending in _test.",
        );
      vi.stubEnv("DATABASE_URL", testURL!);
      for (const key of [
        "VERCEL",
        "CF_PAGES",
        "WORKERS_CI",
        "APP_PASSWORD",
        "APP_ORIGIN",
      ])
        vi.stubEnv(key, undefined);
      const db = await database();
      await db.execute(
        "TRUNCATE trace_events, operations, simulations, sessions, rate_limits, revoked_sessions",
      );
    });
    afterAll(async () => {
      await closeDatabase();
    });

    it("migrates the schema, binds numbered parameters without rewriting SQL, and preserves large timestamps", async () => {
      const db = await database();
      expect(db.dialect).toBe("postgres");
      expect(databaseBackend()).toBe("postgres");
      const result = await db.execute({
        sql: "SELECT $1::text AS supplied, '? is literal' AS literal",
        args: ["Bound private fixture"],
      });
      expect(result.rows[0]).toEqual({
        supplied: "Bound private fixture",
        literal: "? is literal",
      });
      const migration = await db.execute(
        "SELECT version FROM schema_migrations WHERE version = 3",
      );
      expect(Number(migration.rows[0].version)).toBe(3);
      vi.stubEnv("APP_PASSWORD", "unit-test-password");
      const session = await getSession(
        new Request("http://localhost/api/config"),
      );
      expect(session.authenticated).toBe(false);
      expect(session.expiresAt).toBeGreaterThan(2 ** 31);
      const req = new Request("http://localhost/api/config", {
        headers: { cookie: `branchlab_session=${session.id}` },
      });
      expect((await getSession(req)).authenticated).toBe(false);
      await setAuthenticated(session.id, true);
      expect((await getSession(req)).authenticated).toBe(true);
    });

    it("rolls back every statement and interactive write when a transaction fails", async () => {
      const db = await database();
      const insert = {
        sql: "INSERT INTO sessions (id, authenticated, expires_at) VALUES ($1, 0, $2)",
        args: ["rollback-owner", Date.now() + 60_000],
      };
      await expect(db.batch([insert, insert], "write")).rejects.toBeDefined();
      expect((await db.execute("SELECT id FROM sessions")).rows).toHaveLength(
        0,
      );
      await expect(
        db.transaction(async (tx) => {
          await tx.execute(insert);
          throw new Error("Fixture rollback");
        }),
      ).rejects.toThrow("Fixture rollback");
      expect((await db.execute("SELECT id FROM sessions")).rows).toHaveLength(
        0,
      );
    });

    it("persists a complete demo operation with ownership, idempotency, report and chat", async () => {
      const created = await createSimulation(
        { ...input, requestId: randomUUID() },
        "pg-owner",
        signal(),
      );
      await expect(
        readSimulation(created.id, "different-owner"),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      const advanced = await stepSimulation(
        created.id,
        "pg-owner",
        0,
        AbortSignal.timeout(10_000),
      );
      expect(advanced.rounds).toHaveLength(1);
      expect(await stepSimulation(created.id, "pg-owner", 0, signal())).toEqual(
        advanced,
      );
      const chatted = await chatSimulation(
        created.id,
        "pg-owner",
        "What caused disagreement?",
        undefined,
        signal(),
      );
      expect(chatted.messages.length).toBeGreaterThan(0);
      const reported = await reportSimulation(created.id, "pg-owner", signal());
      expect(reported.report).toBeTruthy();
      const operations = await (
        await database()
      ).execute({
        sql: "SELECT status FROM operations WHERE owner = $1",
        args: ["pg-owner"],
      });
      expect(operations.rows.length).toBeGreaterThanOrEqual(4);
      expect(operations.rows.every((row) => row.status === "completed")).toBe(
        true,
      );
    });

    it("fences concurrent lease winners and rejects a stale commit after another lease starts", async () => {
      const run = await createSimulation(input, "pg-owner", signal());
      const attempts = await Promise.allSettled(
        Array.from({ length: 8 }, () => acquireLease(run.id, "pg-owner")),
      );
      const winners = attempts.filter(
        (attempt) => attempt.status === "fulfilled",
      );
      expect(winners).toHaveLength(1);
      const winner = winners[0];
      if (winner.status !== "fulfilled") throw new Error("Missing lease");
      await releaseLease(run.id, "pg-owner", winner.value.token);
      const current = await acquireLease(run.id, "pg-owner");
      await expect(
        commitLease(winner.value, run, "pg-owner"),
      ).rejects.toMatchObject({ code: "STALE_OPERATION" });
      expect((await commitLease(current, run, "pg-owner")).version).toBe(1);
    });

    it("enforces global budgets atomically across concurrent PostgreSQL connections", async () => {
      const attempts = await Promise.allSettled(
        Array.from({ length: 20 }, () =>
          consumeLimit("postgres-budget", 7, 60_000),
        ),
      );
      expect(
        attempts.filter((attempt) => attempt.status === "fulfilled"),
      ).toHaveLength(7);
      const result = await (
        await database()
      ).execute({
        sql: "SELECT count FROM rate_limits WHERE key = $1",
        args: ["postgres-budget"],
      });
      expect(Number(result.rows[0].count)).toBe(20);
    });

    it("prevents quota write skew when several connections create at once", async () => {
      const seed = await createSimulation(input, "pg-quota-owner", signal());
      for (let i = 0; i < 94; i++)
        await insertSimulation({ ...seed, id: randomUUID() }, "pg-quota-owner");
      const attempts = await Promise.allSettled(
        Array.from({ length: 15 }, () =>
          insertSimulation({ ...seed, id: randomUUID() }, "pg-quota-owner"),
        ),
      );
      expect(
        attempts.filter((attempt) => attempt.status === "fulfilled"),
      ).toHaveLength(5);
      expect(await listSimulations("pg-quota-owner")).toHaveLength(100);
      for (const attempt of attempts)
        if (attempt.status === "rejected")
          expect(attempt.reason).toMatchObject({ code: "WORKSPACE_FULL" });
    });

    it("erases only one owner's data and blocks late commits or recreated runs", async () => {
      const erased = await createSimulation(input, "pg-erased", signal());
      const preserved = await createSimulation(input, "pg-preserved", signal());
      const lease = await acquireLease(erased.id, "pg-erased");
      await eraseWorkspace("pg-erased");
      await expect(
        commitLease(lease, erased, "pg-erased"),
      ).rejects.toMatchObject({ code: "STALE_OPERATION" });
      await expect(
        insertSimulation({ ...erased, id: randomUUID() }, "pg-erased"),
      ).rejects.toMatchObject({ code: "SESSION_REVOKED" });
      expect(await readSimulation(preserved.id, "pg-preserved")).toEqual(
        preserved,
      );
      expect(
        (
          await (
            await database()
          ).execute({
            sql: "SELECT id FROM operations WHERE owner = $1",
            args: ["pg-erased"],
          })
        ).rows,
      ).toHaveLength(0);
    });

    it("does not resurrect operation metadata when purge commits during operation admission", async () => {
      const restore = await pauseInserts("operations");
      try {
        const pending = createSimulation(input, "pg-admission-race", signal());
        const assertion = expect(pending).rejects.toMatchObject({
          code: "SESSION_REVOKED",
        });
        await waitForPausedInsert("operations");
        await eraseWorkspace("pg-admission-race");
        await assertion;
        const result = await (
          await database()
        ).execute({
          sql: "SELECT id FROM operations WHERE owner = $1",
          args: ["pg-admission-race"],
        });
        expect(result.rows).toHaveLength(0);
      } finally {
        await restore();
      }
    });

    it("does not resurrect trace metadata when purge commits after the operation guard was read", async () => {
      const db = await database();
      const operation = {
        id: randomUUID(),
        token: randomUUID(),
        owner: "pg-trace-race",
      };
      await db.execute({
        sql: "INSERT INTO operations (id, owner, kind, status, started_at, expires_at, token, engine_version, prompt_version, request_hash, request_key) VALUES ($1, $2, 'create', 'running', $3, $4, $5, 'test', 'test', 'test', $6)",
        args: [
          operation.id,
          operation.owner,
          new Date().toISOString(),
          Date.now() + 200_000,
          operation.token,
          randomUUID(),
        ],
      });
      const runtime = await operationRuntime(operation);
      const restore = await pauseInserts("trace_events");
      try {
        const pending = Promise.resolve(
          runtime.hooks.onEvent!({
            phase: "architect",
            kind: "phase-start",
            summary: "Starting fixture actor construction.",
          }),
        );
        const assertion = expect(pending).rejects.toMatchObject({
          code: "OPERATION_REVOKED",
        });
        await waitForPausedInsert("trace_events");
        await eraseWorkspace(operation.owner);
        await assertion;
        expect(runtime.signal.aborted).toBe(true);
        expect(runtime.signal.reason).toMatchObject({
          code: "OPERATION_REVOKED",
        });
        const result = await db.execute({
          sql: "SELECT id FROM trace_events WHERE owner = $1",
          args: [operation.owner],
        });
        expect(result.rows).toHaveLength(0);
      } finally {
        await restore();
      }
    });
  },
);
