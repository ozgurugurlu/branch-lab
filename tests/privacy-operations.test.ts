import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CreateSimulationInput } from "@/lib/types";
import { closeDatabase, database, pruneExpiredWorkspaces } from "@/server/db";
import {
  createSimulation,
  branchSimulation,
  chatSimulation,
  stepSimulation,
} from "@/server/simulations";
import {
  acquireLease,
  commitLease,
  insertSimulation,
  listSimulations,
  readSimulation,
} from "@/server/store";
import { listOperations, withOperation } from "@/server/operations";
import { eraseWorkspace } from "@/server/privacy";
import { GET as configGET } from "@/app/api/config/route";
import { GET as privacyGET } from "@/app/api/privacy/route";
import { DELETE as workspaceDELETE } from "@/app/api/workspace/route";
import { setAuthenticated } from "@/server/security";

let directory: string;
const input: CreateSimulationInput = {
  title: "A shared experiment",
  question: "How will participants respond to a four-day trial?",
  context: "",
  model: { provider: "demo", model: "branchlab-demo" },
  seed: 42,
  maxRounds: 3,
  actorCount: 4,
  privacy: { allowCloud: false },
  sources: [
    {
      name: "Private analyst notes",
      content: "Hidden evaluation criterion: blue orchid.",
      access: "analyst-only",
    },
  ],
};
const signal = () => AbortSignal.timeout(10_000);
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "branchlab-privacy-"));
  vi.stubEnv("TURSO_DATABASE_URL", `file:${join(directory, "test.db")}`);
  for (const key of [
    "APP_PASSWORD",
    "APP_ORIGIN",
    "VERCEL",
    "CF_PAGES",
    "WORKERS_CI",
    "OPENAI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
  ])
    vi.stubEnv(key, undefined);
});
afterEach(async () => {
  await closeDatabase();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function browser() {
  const response = await configGET(new Request("http://localhost/api/config"));
  return response.headers.get("set-cookie")!.split(";")[0];
}
function owner(cookie: string) {
  return cookie.split("=")[1];
}

it("replays creation, branching and chat without duplicating saved actions", async () => {
  const requestId = randomUUID();
  const created = await createSimulation(
    { ...input, requestId },
    "alice",
    signal(),
  );
  const replay = await createSimulation(
    { ...input, requestId },
    "alice",
    signal(),
  );
  expect(replay).toEqual(created);
  expect(await listSimulations("alice")).toHaveLength(1);
  await expect(
    createSimulation(
      { ...input, title: "Changed input", requestId },
      "alice",
      signal(),
    ),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  const chatId = randomUUID();
  const answered = await chatSimulation(
    created.id,
    "alice",
    "What remains uncertain?",
    undefined,
    signal(),
    chatId,
  );
  const repeated = await chatSimulation(
    created.id,
    "alice",
    "What remains uncertain?",
    undefined,
    signal(),
    chatId,
  );
  expect(repeated.messages).toHaveLength(2);
  expect(repeated.version).toBe(answered.version);
  const branchId = randomUUID();
  const fork = await branchSimulation(
    created.id,
    "alice",
    "Introduce a public consultation before the trial.",
    undefined,
    branchId,
  );
  const forkReplay = await branchSimulation(
    created.id,
    "alice",
    "Introduce a public consultation before the trial.",
    undefined,
    branchId,
  );
  expect(forkReplay.id).toBe(fork.id);
  expect(await listSimulations("alice")).toHaveLength(2);
  const operations = await listOperations(created.id, "alice");
  expect(operations).toHaveLength(3);
  expect(operations.every((op) => op.status === "completed")).toBe(true);
  expect(JSON.stringify(operations)).not.toContain("blue orchid");
  expect(JSON.stringify(operations)).not.toContain("What remains");
  await expect(listOperations(created.id, "bob")).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

it("prevents duplicate concurrent work and records safe failures", async () => {
  const run = await createSimulation(input, "alice", signal());
  const key = randomUUID();
  let unblock!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const first = withOperation("alice", "report", run.id, {}, key, async () => {
    started();
    await gate;
    return run;
  });
  await entered;
  const duplicateWork = vi.fn(async () => run);
  await expect(
    withOperation("alice", "report", run.id, {}, key, duplicateWork),
  ).rejects.toMatchObject({ code: "RUN_BUSY" });
  expect(duplicateWork).not.toHaveBeenCalled();
  unblock();
  await first;
  await expect(
    withOperation("alice", "chat", run.id, {}, undefined, async () => {
      throw new Error("secret provider response and credential");
    }),
  ).rejects.toThrow("secret provider");
  const failed = (await listOperations(run.id, "alice")).find(
    (op) => op.status === "failed",
  );
  expect(failed?.errorCode).toBe("OPERATION_FAILED");
  expect(JSON.stringify(failed)).not.toContain("credential");
});

it("blocks cloud access before any provider call when a run withholds permission", async () => {
  vi.stubEnv("OPENAI_API_KEY", "unit-test-not-a-key");
  await expect(
    createSimulation(
      { ...input, model: { provider: "openai", model: "gpt-6-luna" } },
      "alice",
      signal(),
    ),
  ).rejects.toMatchObject({ code: "CLOUD_PROCESSING_DENIED", status: 403 });
  expect(await listSimulations("alice")).toHaveLength(0);
  await expect(
    createSimulation(
      {
        ...input,
        privacy: undefined,
        model: { provider: "openai", model: "gpt-6-luna" },
      },
      "alice",
      signal(),
    ),
  ).rejects.toMatchObject({ code: "CLOUD_CONSENT_REQUIRED" });
});

it("revokes in-flight writes atomically with workspace erasure", async () => {
  const alice = await createSimulation(input, "alice", signal());
  const bob = await createSimulation(input, "bob", signal());
  const lease = await acquireLease(alice.id, "alice");
  await eraseWorkspace("alice");
  await expect(commitLease(lease, alice, "alice")).rejects.toMatchObject({
    code: "STALE_OPERATION",
  });
  await expect(
    insertSimulation({ ...alice, id: randomUUID() }, "alice"),
  ).rejects.toMatchObject({ code: "SESSION_REVOKED" });
  await expect(
    createSimulation(input, "alice", signal()),
  ).rejects.toMatchObject({ code: "SESSION_REVOKED" });
  expect(await listSimulations("alice")).toHaveLength(0);
  expect((await readSimulation(bob.id, "bob")).id).toBe(bob.id);
  const db = await database();
  expect(
    (
      await db.execute({
        sql: "SELECT id FROM operations WHERE owner = ?",
        args: ["alice"],
      })
    ).rows,
  ).toHaveLength(0);
});

it("requires explicit erasure confirmation and expires the session cookie", async () => {
  const cookie = await browser();
  await createSimulation(input, owner(cookie), signal());
  const privacy = await privacyGET(
    new Request("http://localhost/api/privacy", { headers: { cookie } }),
  );
  expect((await privacy.json()).data).toMatchObject({
    simulationCount: 1,
    storage: "local",
    retentionDays: 30,
  });
  const request = (confirmation: string) =>
    new Request("http://localhost/api/workspace", {
      method: "DELETE",
      headers: {
        cookie,
        origin: "http://localhost",
        "content-type": "application/json",
      },
      body: JSON.stringify({ confirmation }),
    });
  expect((await workspaceDELETE(request("oops"))).status).toBe(400);
  expect(await listSimulations(owner(cookie))).toHaveLength(1);
  const erased = await workspaceDELETE(request("DELETE MY WORKSPACE"));
  expect(erased.status).toBe(200);
  expect(erased.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(await listSimulations(owner(cookie))).toHaveLength(0);
  const stale = await privacyGET(
    new Request("http://localhost/api/privacy", { headers: { cookie } }),
  );
  expect((await stale.json()).data.simulationCount).toBe(0);
});

it("removes expired workspaces on retention cleanup while preserving active owners", async () => {
  const cookie = await browser();
  await createSimulation(input, owner(cookie), signal());
  await createSimulation(input, "active-owner", signal());
  let db = await database();
  await db.execute({
    sql: "UPDATE sessions SET expires_at = ? WHERE id = ?",
    args: [Date.now() - 1, owner(cookie)],
  });
  await closeDatabase();
  db = await database();
  await pruneExpiredWorkspaces(db);
  expect(await listSimulations(owner(cookie))).toHaveLength(0);
  expect(await listSimulations("active-owner")).toHaveLength(1);
  await expect(
    insertSimulation(
      {
        ...(await readSimulation(
          (await listSimulations("active-owner"))[0].id,
          "active-owner",
        )),
        id: randomUUID(),
      },
      owner(cookie),
    ),
  ).rejects.toMatchObject({ code: "SESSION_REVOKED" });
});

it("locking a session fences out an old lease even after the session is unlocked", async () => {
  const cookie = await browser();
  const run = await createSimulation(input, owner(cookie), signal());
  const lease = await acquireLease(run.id, owner(cookie));
  await setAuthenticated(owner(cookie), false);
  await setAuthenticated(owner(cookie), true);
  await expect(commitLease(lease, run, owner(cookie))).rejects.toMatchObject({
    code: "STALE_OPERATION",
  });
  expect(
    (await stepSimulation(run.id, owner(cookie), 0, signal())).rounds,
  ).toHaveLength(1);
});

it("exposes only owner-scoped execution summaries and aborts later stages after erasure", async () => {
  const { executionFeed, operationRuntime } = await import("@/server/trace");
  const requestId = randomUUID();
  const run = await createSimulation(
    { ...input, requestId },
    "alice",
    signal(),
  );
  const feed = await executionFeed("alice", { requestId });
  expect(feed.events.some((event) => event.kind === "tool-result")).toBe(true);
  expect(feed.events.some((event) => event.kind === "phase-end")).toBe(true);
  expect(JSON.stringify(feed)).not.toContain("blue orchid");
  expect(JSON.stringify(feed)).not.toContain("Private analyst notes");
  expect(await executionFeed("bob", { requestId })).toEqual({
    operations: [],
    events: [],
  });
  await expect(
    executionFeed("bob", { simulationId: run.id }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    withOperation("alice", "chat", run.id, {}, undefined, async (operation) => {
      const runtime = await operationRuntime(operation, false, signal());
      await eraseWorkspace("alice");
      await expect(
        runtime.hooks.onEvent!({
          phase: "analyst",
          kind: "phase-start",
          summary: "Starting analysis.",
        }),
      ).rejects.toMatchObject({ code: "OPERATION_REVOKED" });
      expect(runtime.signal.aborted).toBe(true);
      runtime.signal.throwIfAborted();
      return run;
    }),
  ).rejects.toMatchObject({ code: "OPERATION_REVOKED" });
  expect(await executionFeed("alice", { requestId })).toEqual({
    operations: [],
    events: [],
  });
});
