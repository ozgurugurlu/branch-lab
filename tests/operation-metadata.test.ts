import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateSimulationInput } from "@/lib/types";
import { closeDatabase, database } from "@/server/db";
import { createSimulation } from "@/server/simulations";
import { listOperations, withOperation } from "@/server/operations";
import { executionFeed } from "@/server/trace";

let directory: string;
const input: CreateSimulationInput = {
  question: "How would a shared library respond to a weekend pilot?",
  context: "",
  model: { provider: "demo", model: "branchlab-demo" },
  seed: 17,
  maxRounds: 2,
  actorCount: 4,
  sources: [],
  privacy: { allowCloud: false },
};
const signal = () => AbortSignal.timeout(10_000);

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "branchlab-operation-metadata-"));
  vi.stubEnv("TURSO_DATABASE_URL", `file:${join(directory, "test.db")}`);
});
afterEach(async () => {
  await closeDatabase();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("owner-scoped operation recovery metadata", () => {
  it("resolves a completed creation by its request UUID without exposing another workspace's result", async () => {
    const requestId = randomUUID();
    const alice = await createSimulation(
      { ...input, requestId },
      "alice",
      signal(),
    );
    expect((await executionFeed("alice", { requestId })).operations).toEqual([
      expect.objectContaining({
        kind: "create",
        status: "completed",
        simulationId: alice.id,
      }),
    ]);
    expect(await executionFeed("bob", { requestId })).toEqual({
      operations: [],
      events: [],
    });

    // The same client UUID is independently scoped by the authenticated owner.
    const bob = await createSimulation(
      { ...input, requestId },
      "bob",
      signal(),
    );
    expect(bob.id).not.toBe(alice.id);
    const bobFeed = await executionFeed("bob", { requestId });
    expect(bobFeed.operations).toEqual([
      expect.objectContaining({ simulationId: bob.id }),
    ]);
    expect(JSON.stringify(bobFeed)).not.toContain(alice.id);
    expect((await listOperations(alice.id, "alice"))[0].simulationId).toBe(
      alice.id,
    );
    await expect(listOperations(alice.id, "bob")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("falls back to the committed result ID in legacy operation rows without returning internal journal fields", async () => {
    const requestId = randomUUID();
    const created = await createSimulation(
      { ...input, requestId },
      "alice",
      signal(),
    );
    const db = await database();
    await db.execute({
      sql: "UPDATE operations SET simulation_id = NULL WHERE owner = $1 AND request_key = $2",
      args: ["alice", requestId],
    });
    const feed = await executionFeed("alice", { requestId });
    expect(feed.operations[0].simulationId).toBe(created.id);
    for (const internal of [
      "owner",
      "token",
      "request_hash",
      "request_key",
      "result_id",
    ])
      expect(feed.operations[0]).not.toHaveProperty(internal);
    expect(await executionFeed("bob", { requestId })).toEqual({
      operations: [],
      events: [],
    });
  });

  it("keeps an in-flight creation's run ID absent until the result commits", async () => {
    const existing = await createSimulation(input, "alice", signal());
    const requestId = randomUUID();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = withOperation(
      "alice",
      "create",
      null,
      {},
      requestId,
      async () => {
        started();
        await gate;
        return existing;
      },
    );
    try {
      await entered;
      expect((await executionFeed("alice", { requestId })).operations).toEqual([
        expect.objectContaining({ status: "running", simulationId: null }),
      ]);
    } finally {
      release();
      await pending;
    }
    expect((await executionFeed("alice", { requestId })).operations).toEqual([
      expect.objectContaining({
        status: "completed",
        simulationId: existing.id,
      }),
    ]);
  });
});
