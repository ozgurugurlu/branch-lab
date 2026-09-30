import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Simulation, World } from "../src/lib/types";
import { closeDatabase, database } from "../src/server/db";
import {
  acquireLease,
  commitLease,
  deleteSimulation,
  insertSimulation,
  listSimulations,
  readSimulation,
  releaseLease,
} from "../src/server/store";

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "branchlab-store-"));
});
beforeEach(async () => {
  vi.stubEnv("TURSO_DATABASE_URL", `file:${join(directory, "test.db")}`);
  for (const key of ["VERCEL", "CF_PAGES", "WORKERS_CI", "APP_PASSWORD"])
    vi.stubEnv(key, undefined);
  const db = await database();
  await db.batch(
    [
      "DELETE FROM simulations",
      "DELETE FROM sessions",
      "DELETE FROM rate_limits",
    ],
    "write",
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await closeDatabase();
  await rm(directory, { recursive: true, force: true });
});

function fixture(id = "run-a"): Simulation {
  const world: World = {
    summary: "A fictional community considers a small local pilot.",
    assumptions: [
      "These two actors are fictional and do not represent a population.",
    ],
    actors: [
      {
        id: "actor-1",
        name: "Maya",
        role: "Resident",
        description: "A cautious resident",
        goal: "Keep access affordable",
        stance: -0.4,
        influence: 0.5,
        sourceIds: [],
        memory: ["Initial fictional concern"],
      },
      {
        id: "actor-2",
        name: "Eli",
        role: "Organizer",
        description: "A pilot organizer",
        goal: "Test the proposal",
        stance: 0.6,
        influence: 0.5,
        sourceIds: [],
        memory: ["Initial fictional support"],
      },
    ],
    relationships: [
      { from: "actor-1", to: "actor-2", label: "Neighbors", weight: 0.5 },
    ],
  };
  return {
    id,
    title: "Community pilot",
    question: "How would a local community respond to a free pilot?",
    context: "",
    model: { provider: "demo", model: "branchlab-demo" },
    seed: 42,
    maxRounds: 3,
    initialWorld: structuredClone(world),
    world,
    sources: [],
    rounds: [],
    interventions: [],
    messages: [],
    report: null,
    status: "ready",
    createdAt: "2026-09-30T10:00:00.000Z",
    updatedAt: "2026-09-30T10:00:00.000Z",
    parentId: null,
    forkRound: null,
    version: 0,
    usage: { modelCalls: 0 },
    manifest: { engineVersion: "test", promptVersion: "test" },
  };
}

describe("persistent workspace ownership", () => {
  it("scopes lists, reads, leases and deletion to the owning session", async () => {
    await insertSimulation(fixture("alice-run"), "alice");
    await insertSimulation(fixture("bob-run"), "bob");
    expect((await listSimulations("alice")).map((run) => run.id)).toEqual([
      "alice-run",
    ]);
    expect(await listSimulations("unknown-owner")).toEqual([]);
    await expect(readSimulation("alice-run", "bob")).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    await expect(acquireLease("alice-run", "bob")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(deleteSimulation("alice-run", "bob")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await readSimulation("alice-run", "alice")).id).toBe("alice-run");
  });

  it("returns detached snapshots that cannot change persisted state", async () => {
    const input = fixture();
    await insertSimulation(input, "owner");
    input.world.actors[0].memory.push("Mutation outside the database");
    const copy = await readSimulation(input.id, "owner");
    copy.world.actors[0].stance = 1;
    const saved = await readSimulation(input.id, "owner");
    expect(saved.world.actors[0].memory).toEqual(["Initial fictional concern"]);
    expect(saved.world.actors[0].stance).toBe(-0.4);
  });

  it("enforces the workspace quota atomically across simultaneous creates", async () => {
    await Promise.all(
      Array.from({ length: 99 }, (_, index) =>
        insertSimulation(fixture(`run-${index}`), "owner"),
      ),
    );
    const results = await Promise.allSettled([
      insertSimulation(fixture("last-slot-a"), "owner"),
      insertSimulation(fixture("last-slot-b"), "owner"),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.code).toBe(
      "WORKSPACE_FULL",
    );
    expect(await listSimulations("owner")).toHaveLength(100);
    await expect(
      insertSimulation(fixture("other-owner"), "someone-else"),
    ).resolves.toMatchObject({ id: "other-owner" });
  });
});

describe("SQL operation leases", () => {
  beforeEach(async () => {
    await insertSimulation(fixture(), "owner");
  });

  it("lets exactly one concurrent operation acquire a lease", async () => {
    const results = await Promise.allSettled([
      acquireLease("run-a", "owner"),
      acquireLease("run-a", "owner"),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({
      code: "RUN_BUSY",
      retryable: true,
    });
    expect((await readSimulation("run-a", "owner")).version).toBe(0);
  });

  it("commits once and rejects reuse of the old fencing token", async () => {
    const lease = await acquireLease("run-a", "owner");
    const changed = { ...lease.simulation, title: "Committed checkpoint" };
    const committed = await commitLease(lease, changed, "owner");
    expect(committed.version).toBe(1);
    expect((await readSimulation("run-a", "owner")).title).toBe(
      "Committed checkpoint",
    );
    await expect(
      commitLease(lease, { ...changed, title: "Stale write" }, "owner"),
    ).rejects.toMatchObject({ code: "STALE_OPERATION" });
    expect((await readSimulation("run-a", "owner")).title).toBe(
      "Committed checkpoint",
    );
  });

  it("cannot commit a valid lease under a different owner", async () => {
    const lease = await acquireLease("run-a", "owner");
    await expect(
      commitLease(lease, lease.simulation, "outsider"),
    ).rejects.toMatchObject({ code: "STALE_OPERATION" });
    await expect(
      commitLease(lease, lease.simulation, "owner"),
    ).resolves.toMatchObject({ version: 1 });
  });

  it("does not let an old release unlock a newer operation", async () => {
    const previous = await acquireLease("run-a", "owner");
    await releaseLease("run-a", "owner", previous.token);
    const current = await acquireLease("run-a", "owner");
    await releaseLease("run-a", "owner", previous.token);
    await expect(acquireLease("run-a", "owner")).rejects.toMatchObject({
      code: "RUN_BUSY",
    });
    await expect(
      commitLease(current, current.simulation, "owner"),
    ).resolves.toMatchObject({ version: 1 });
  });

  it("expires interrupted work and fences it out after another lease starts", async () => {
    const stale = await acquireLease("run-a", "owner");
    const advanced = Date.now() + 210_001;
    vi.spyOn(Date, "now").mockReturnValue(advanced);
    const replacement = await acquireLease("run-a", "owner");
    expect(replacement.token).not.toBe(stale.token);
    await expect(
      commitLease(
        stale,
        { ...stale.simulation, title: "Expired write" },
        "owner",
      ),
    ).rejects.toMatchObject({ code: "STALE_OPERATION" });
    await releaseLease("run-a", "owner", stale.token);
    await expect(
      commitLease(
        replacement,
        { ...replacement.simulation, title: "Recovered checkpoint" },
        "owner",
      ),
    ).resolves.toMatchObject({ version: 1 });
    expect((await readSimulation("run-a", "owner")).title).toBe(
      "Recovered checkpoint",
    );
  });

  it("rejects an expired commit even when no replacement operation exists", async () => {
    const lease = await acquireLease("run-a", "owner");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 210_001);
    await expect(
      commitLease(
        lease,
        { ...lease.simulation, title: "Expired write" },
        "owner",
      ),
    ).rejects.toMatchObject({ code: "STALE_OPERATION" });
    expect((await readSimulation("run-a", "owner")).version).toBe(0);
  });

  it("blocks deletion during work, then permits it after lease release", async () => {
    const lease = await acquireLease("run-a", "owner");
    await expect(deleteSimulation("run-a", "owner")).rejects.toMatchObject({
      code: "RUN_BUSY",
    });
    await releaseLease("run-a", "owner", lease.token);
    await deleteSimulation("run-a", "owner");
    await expect(readSimulation("run-a", "owner")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("saved demo round operations", () => {
  it("returns an already committed round for duplicate requests without advancing twice", async () => {
    const { stepSimulation } = await import("../src/server/simulations");
    await insertSimulation(fixture(), "owner");
    const signal = new AbortController().signal;
    const first = await stepSimulation("run-a", "owner", 0, signal);
    const duplicate = await stepSimulation("run-a", "owner", 0, signal);
    expect(first.rounds).toHaveLength(1);
    expect(duplicate).toEqual(first);
    expect((await readSimulation("run-a", "owner")).rounds).toHaveLength(1);
    await expect(
      stepSimulation("run-a", "owner", 3, signal),
    ).rejects.toMatchObject({ code: "ROUND_MISMATCH" });
  });

  it("preserves the last checkpoint and releases the lease on cancellation", async () => {
    const { stepSimulation } = await import("../src/server/simulations");
    await insertSimulation(fixture(), "owner");
    const checkpoint = await stepSimulation(
      "run-a",
      "owner",
      0,
      new AbortController().signal,
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      stepSimulation("run-a", "owner", 1, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await readSimulation("run-a", "owner")).toEqual(checkpoint);
    await expect(acquireLease("run-a", "owner")).resolves.toMatchObject({
      version: checkpoint.version,
    });
  });

  it("forks a completed snapshot without changing the parent", async () => {
    const { branchSimulation, stepSimulation } =
      await import("../src/server/simulations");
    await insertSimulation(fixture(), "owner");
    const signal = new AbortController().signal;
    const parent = await stepSimulation("run-a", "owner", 0, signal);
    const child = await branchSimulation(
      "run-a",
      "owner",
      "Offer a transparent, free pilot with community consultation.",
    );
    expect(child.parentId).toBe(parent.id);
    expect(child.forkRound).toBe(1);
    expect(child.rounds).toEqual(parent.rounds);
    expect(child.interventions).toHaveLength(1);
    await stepSimulation(child.id, "owner", 1, signal);
    expect(await readSimulation(parent.id, "owner")).toEqual(parent);
    await expect(readSimulation(child.id, "outsider")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
