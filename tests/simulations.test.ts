import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { CreateSimulationInput } from "@/lib/types";
import { closeDatabase, database } from "@/server/db";
import {
  createSimulation,
  stepSimulation,
  branchSimulation,
  chatSimulation,
  reportSimulation,
} from "@/server/simulations";
import { listSimulations, readSimulation } from "@/server/store";

const owner = "integration-owner";
const input: CreateSimulationInput = {
  title: "Community pilot",
  question: "Will residents support a car-free city-center pilot?",
  context:
    "The pilot lasts six months and preserves access for essential services.",
  model: { provider: "demo", model: "branchlab-demo" },
  seed: 813,
  actorCount: 6,
  maxRounds: 4,
  sources: [
    {
      name: "Local consultation",
      content:
        "Residents ask for transparent evaluation and accessible alternatives.",
    },
  ],
};
const signal = () => AbortSignal.timeout(10_000);
let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "branchlab-simulation-test-"));
  vi.stubEnv("TURSO_DATABASE_URL", `file:${join(directory, "simulation.db")}`);
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("CF_PAGES", "");
  vi.stubEnv("WORKERS_CI", "");
  vi.stubEnv("APP_PASSWORD", "");
});

afterEach(async () => {
  await closeDatabase();
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("simulation orchestration with real local SQL", () => {
  it("upgrades legacy reports explicitly, fences refresh retries and preserves the old report on failure", async () => {
    const created = await createSimulation(input, owner, signal());
    await stepSimulation(created.id, owner, 0, signal());
    const reported = await reportSimulation(created.id, owner, signal());
    expect(reported.report?.answer).toBeTruthy();
    const legacy = structuredClone(reported);
    delete legacy.report!.answer;
    const db = await database();
    await db.execute({
      sql: "UPDATE simulations SET data = $1 WHERE id = $2 AND owner = $3",
      args: [JSON.stringify(legacy), legacy.id, owner],
    });
    expect(await reportSimulation(legacy.id, owner, signal())).toEqual(legacy);
    await expect(
      reportSimulation(legacy.id, owner, AbortSignal.abort(), undefined, true),
    ).rejects.toThrow();
    expect(await readSimulation(legacy.id, owner)).toEqual(legacy);
    const requestId = randomUUID();
    const updated = await reportSimulation(
      legacy.id,
      owner,
      signal(),
      requestId,
      true,
    );
    expect(updated.report?.answer).toBeTruthy();
    expect(updated.rounds).toEqual(legacy.rounds);
    expect(updated.messages).toEqual(legacy.messages);
    expect(updated.version).toBe(legacy.version + 1);
    expect(
      await reportSimulation(legacy.id, owner, signal(), requestId, true),
    ).toEqual(updated);
    expect(await readSimulation(legacy.id, owner)).toEqual(updated);
    await expect(
      reportSimulation(legacy.id, owner, signal(), requestId),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("persists creation, idempotent round retries, isolated branches, interviews, and reports", async () => {
    const created = await createSimulation(input, owner, signal());
    expect(created.rounds).toHaveLength(0);
    expect(created.world.actors).toHaveLength(6);
    expect(created.sources[0].hash).toBe(
      createHash("sha256").update(input.sources[0].content).digest("hex"),
    );
    expect(await readSimulation(created.id, owner)).toEqual(created);

    const parent = await stepSimulation(created.id, owner, 0, signal());
    expect(parent.rounds).toHaveLength(1);
    expect(parent.version).toBe(1);
    const duplicate = await stepSimulation(created.id, owner, 0, signal());
    expect(duplicate).toEqual(parent);
    expect(duplicate.usage.modelCalls).toBe(0);

    const child = await branchSimulation(
      parent.id,
      owner,
      "Provide a subsidy and a transparent community consultation.",
      "Consultation branch",
    );
    expect(child.id).not.toBe(parent.id);
    expect(child.parentId).toBe(parent.id);
    expect(child.forkRound).toBe(1);
    expect(child.rounds).toEqual(parent.rounds);
    expect(child.maxRounds).toBe(4);
    expect(child.interventions).toHaveLength(1);
    const advanced = await stepSimulation(child.id, owner, 1, signal());
    expect(advanced.rounds).toHaveLength(2);
    expect(advanced.rounds[1].events[0].content).toContain("subsidy");
    expect(await readSimulation(parent.id, owner)).toEqual(parent);

    const actorId = advanced.world.actors[0].id;
    const interviewed = await chatSimulation(
      child.id,
      owner,
      "What would change your stance?",
      actorId,
      signal(),
    );
    expect(interviewed.messages).toHaveLength(2);
    expect(
      interviewed.messages.every(
        (message) => message.actorId === actorId && message.round === 2,
      ),
    ).toBe(true);
    expect(interviewed.messages[1].content).toContain("Deterministic demo");
    expect(interviewed.world).toEqual(advanced.world);

    const reported = await reportSimulation(child.id, owner, signal());
    expect(reported.report?.findings.length).toBeGreaterThan(0);
    const repeatedReport = await reportSimulation(child.id, owner, signal());
    expect(repeatedReport).toEqual(reported);
    expect(await readSimulation(child.id, owner)).toEqual(reported);
    expect(await readSimulation(parent.id, owner)).toEqual(parent);
    const listed = await listSimulations(owner);
    expect(listed).toHaveLength(2);
    expect(
      listed.find((simulation) => simulation.id === child.id)?.roundCount,
    ).toBe(2);
  });

  it("preserves the checkpoint after failed mutations and releases the operation lease", async () => {
    const created = await createSimulation(input, owner, signal());
    await expect(
      chatSimulation(created.id, owner, "Hello", "nonexistent-actor", signal()),
    ).rejects.toMatchObject({ code: "INVALID_ACTOR" });
    expect(await readSimulation(created.id, owner)).toEqual(created);
    const stepped = await stepSimulation(created.id, owner, 0, signal());
    expect(stepped.rounds).toHaveLength(1);
    expect(stepped.version).toBe(1);
    await expect(
      stepSimulation(created.id, owner, 5, signal()),
    ).rejects.toMatchObject({ code: "ROUND_MISMATCH" });
    expect(await readSimulation(created.id, owner)).toEqual(stepped);
  });

  it("scopes the full lifecycle to the owner and allows only one simultaneous round commit", async () => {
    const created = await createSimulation(input, owner, signal());
    await expect(
      readSimulation(created.id, "other-owner"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      branchSimulation(created.id, "other-owner", "Unseen intervention"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await listSimulations("other-owner")).toEqual([]);
    const attempts = await Promise.allSettled([
      stepSimulation(created.id, owner, 0, signal()),
      stepSimulation(created.id, owner, 0, signal()),
    ]);
    expect(attempts.some((attempt) => attempt.status === "fulfilled")).toBe(
      true,
    );
    const saved = await readSimulation(created.id, owner);
    expect(saved.rounds).toHaveLength(1);
    expect(saved.version).toBe(1);
    expect(saved.usage.modelCalls).toBe(0);
  });
});
