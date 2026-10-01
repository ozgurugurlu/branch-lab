import { describe, expect, it, vi } from "vitest";
import type {
  Action,
  CreateSimulationInput,
  EngineTraceEvent,
  Simulation,
  Source,
} from "@/lib/types";
import { calculateMetrics } from "@/lib/simulation-math";
import {
  buildWorld,
  executeRound,
  generateReport,
  answerQuestion,
  mapActors,
  reduceRound,
} from "@/mastra/simulation";
import {
  analystEvents,
  observeActor,
  validateAction,
  validateInterview,
  validateReport,
  validateWorld,
} from "@/mastra/domain";
import { actorTools, runtimeFor } from "@/mastra/tools";
import { CAPABILITY_PROFILES } from "@/lib/capabilities";

vi.mock("@/server/models", () => ({
  resolveModel: vi.fn(() => {
    throw new Error("Live model resolution was attempted in a demo test.");
  }),
}));

const input = {
  title: "Neighborhood mobility",
  question: "Will residents support a car-free city center?",
  context:
    "A six-month pilot retains accessible transport and delivery windows.",
  model: { provider: "demo", model: "deterministic-v1" },
  seed: 42,
  actorCount: 6,
  maxRounds: 12,
  sources: [],
} satisfies CreateSimulationInput;
const sources: Source[] = [
  {
    id: "source-1",
    name: "Pilot notes",
    content: "Local residents requested an accessible pilot.",
    hash: "a".repeat(64),
  },
  {
    id: "source-2",
    name: "Trading survey",
    content: "Some traders have concerns about delivery access.",
    hash: "b".repeat(64),
  },
];

async function fixture(): Promise<Simulation> {
  const world = await buildWorld(input, sources);
  return {
    id: "simulation-test",
    title: input.title,
    question: input.question,
    context: input.context,
    seed: input.seed,
    model: input.model,
    maxRounds: input.maxRounds,
    initialWorld: structuredClone(world),
    world,
    sources: structuredClone(sources),
    rounds: [],
    interventions: [],
    messages: [],
    report: null,
    status: "ready",
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
    parentId: null,
    forkRound: null,
    version: 0,
    usage: { modelCalls: 0 },
    manifest: { engineVersion: "0.1.0", promptVersion: "2026-09-30.1" },
  };
}

function commit(
  simulation: Simulation,
  round: Awaited<ReturnType<typeof executeRound>>,
) {
  simulation.rounds.push(round);
  simulation.world.actors = round.actors;
}

function proposal(
  _simulation: Simulation,
  actorId: string,
  stance = 0,
): Action {
  return {
    actorId,
    kind: "question",
    stance,
    content: "What evidence supports this assumption?",
    targetId: null,
    sourceIds: [],
  };
}

describe("simulation engine invariants", () => {
  it("executes honest demo read traces with zero model calls and different capability toolsets", async () => {
    const simulation = await fixture();
    const events: EngineTraceEvent[] = [];
    const hooks = {
      onEvent: (event: EngineTraceEvent) => {
        events.push(event);
      },
    };
    const round = await executeRound(simulation, undefined, hooks);
    expect(round.modelCalls).toBe(0);
    expect(events.filter((event) => event.kind === "tool-result")).toHaveLength(
      simulation.world.actors.length,
    );
    expect(events.every((event) => event.summary.startsWith("Demo:"))).toBe(
      true,
    );
    expect(
      events
        .filter((event) => event.kind === "phase-end")
        .every((event) => event.modelCalls === 0),
    ).toBe(true);
    expect(
      new Set(
        Object.values(CAPABILITY_PROFILES).map((profile) =>
          [...profile.tools].sort().join(","),
        ),
      ).size,
    ).toBe(4);
    for (const actor of simulation.world.actors)
      expect(actor.capabilityProfile).toBeDefined();
  });

  it("keeps scoped actor tool data bounded even with a hostile stored source assignment", async () => {
    const simulation = await fixture();
    simulation.sources.push({
      ...sources[0],
      id: "source-secret",
      content: "ANALYST_PRIVATE_TOOL_SENTINEL",
      access: "analyst-only",
    });
    const actor = simulation.world.actors[0];
    actor.sourceIds.push("source-secret");
    actor.capabilityProfile = "research";
    const observation = observeActor(simulation, actor.id);
    const searchWeb = vi.fn();
    const runtime = runtimeFor(
      "actor",
      true,
      undefined,
      { searchWeb },
      actor.id,
    );
    const scoped = actorTools(observation, runtime, true);
    expect(scoped.tools.search_web).toBeUndefined();
    expect(scoped.tools.read_all_evidence).toBeUndefined();
    const read = await scoped.runPrimary();
    expect(JSON.stringify(read)).not.toContain("ANALYST_PRIVATE_TOOL_SENTINEL");
    expect(JSON.stringify(read)).not.toContain("source-secret");
    expect(searchWeb).not.toHaveBeenCalled();
    await scoped.runPrimary();
    await expect(scoped.runPrimary()).rejects.toMatchObject({
      code: "MODEL_OUTPUT_INVALID",
    });
  });

  it("replays seeded worlds and rounds deterministically, independent of wall-clock timestamps", async () => {
    const left = await fixture();
    const right = await fixture();
    expect(left.world).toEqual(right.world);
    for (let index = 0; index < 3; index++) {
      const first = await executeRound(left);
      const second = await executeRound(right);
      expect({ ...first, createdAt: null }).toEqual({
        ...second,
        createdAt: null,
      });
      expect(first.modelCalls).toBe(0);
      commit(left, first);
      commit(right, second);
    }
  });

  it("keeps round input isolated and every proposal observes only the preceding snapshot", async () => {
    const simulation = await fixture();
    const before = structuredClone(simulation);
    const round = await executeRound(simulation);
    expect(simulation).toEqual(before);
    expect(round.number).toBe(1);
    expect(round.events).toHaveLength(simulation.world.actors.length);
    expect(round.events.map((event) => event.actorId)).toEqual(
      simulation.world.actors.map((actor) => actor.id),
    );
    expect(
      round.events.every(
        (event) => !event.content.includes("connected voices inform"),
      ),
    ).toBe(true);
    commit(simulation, round);
    const nextObservations = simulation.world.actors.map((actor) =>
      observeActor(simulation, actor.id),
    );
    expect(
      nextObservations.every((observation) =>
        observation.publicEvents.every((event) => event.round === 1),
      ),
    ).toBe(true);
  });

  it("caps parallel actor model work at three and retains input ordering", async () => {
    let active = 0;
    let peak = 0;
    const values = [30, 1, 10, 5, 2, 15, 3];
    const results = await mapActors(values, async (value, index) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, value));
      active--;
      return index;
    });
    expect(peak).toBe(3);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("rejects duplicate, missing and non-finite actions before reduction", async () => {
    const simulation = await fixture();
    const valid = simulation.world.actors.map((actor) =>
      proposal(simulation, actor.id),
    );
    expect(() => reduceRound(simulation, valid.slice(1))).toThrow(/one action/);
    expect(() =>
      reduceRound(
        simulation,
        valid.map((action, index) => (index === 1 ? valid[0] : action)),
      ),
    ).toThrow(/duplicate/);
    expect(() =>
      reduceRound(
        simulation,
        valid.map((action, index) =>
          index === 0 ? { ...action, stance: NaN } : action,
        ),
      ),
    ).toThrow();
    expect(() =>
      reduceRound(
        simulation,
        valid.map((action, index) =>
          index === 0 ? { ...action, stance: 1.01 } : action,
        ),
      ),
    ).toThrow();
  });

  it("uses deterministic descriptive metrics, with observe excluded from activity", async () => {
    const simulation = await fixture();
    const actors = [
      { ...simulation.world.actors[0], stance: -1 },
      { ...simulation.world.actors[1], stance: 1 },
    ];
    const actions = [
      { ...proposal(simulation, actors[0].id), kind: "observe" as const },
      proposal(simulation, actors[1].id),
    ];
    expect(calculateMetrics(actors, actions)).toEqual({
      support: 50,
      polarization: 100,
      activity: 1,
    });
    expect(
      calculateMetrics(
        actors.map((actor) => ({ ...actor, stance: 1 })),
        actions,
      ),
    ).toEqual({ support: 100, polarization: 0, activity: 1 });
  });

  it("responds distinctly to interventions and respects scenario-specific archetypes", async () => {
    const baseline = await fixture();
    const positive = structuredClone(baseline);
    const negative = structuredClone(baseline);
    positive.interventions = [
      {
        id: "intervention-1",
        afterRound: 0,
        content:
          "Offer a subsidy, transparent consultation and a reversible pilot.",
      },
    ];
    negative.interventions = [
      {
        id: "intervention-1",
        afterRound: 0,
        content: "Raise fees and impose a mandatory ban without consultation.",
      },
    ];
    const [baseRound, positiveRound, negativeRound] = await Promise.all([
      executeRound(baseline),
      executeRound(positive),
      executeRound(negative),
    ]);
    expect(positiveRound.metrics.support).toBeGreaterThan(
      baseRound.metrics.support,
    );
    expect(positiveRound.metrics.support).toBeGreaterThan(
      negativeRound.metrics.support,
    );
    expect(positiveRound.events[0].content).toContain("subsidy");
    const product = await buildWorld(
      {
        ...input,
        question: "Will customers accept the new subscription pricing?",
        context: "An optional premium plan.",
      },
      sources,
    );
    expect(product.actors.map((actor) => actor.role)).not.toEqual(
      baseline.world.actors.map((actor) => actor.role),
    );
  });

  it("retains bounded own-memory and generates reports exclusively from recorded events", async () => {
    const simulation = await fixture();
    for (let index = 0; index < 10; index++)
      commit(simulation, await executeRound(simulation));
    expect(
      simulation.world.actors.every((actor) => actor.memory.length === 8),
    ).toBe(true);
    const report = await generateReport(simulation);
    const eventIds = new Set(
      simulation.rounds.flatMap((round) =>
        round.events.map((event) => event.id),
      ),
    );
    expect(
      report.findings.every((finding) =>
        finding.eventIds.every((eventId) => eventIds.has(eventId)),
      ),
    ).toBe(true);
    expect(report.headline).toContain(
      simulation.rounds.at(-1)!.metrics.support.toFixed(1),
    );
    const invalid = structuredClone(report);
    invalid.findings[0].eventIds = ["invented-event"];
    expect(() => validateReport(invalid, simulation)).toThrow(/event IDs/);
    invalid.findings[0].eventIds = [];
    expect(() => validateReport(invalid, simulation)).toThrow(
      /supporting event/,
    );
  });

  it("rejects aborted operations and exhausted round budgets", async () => {
    const simulation = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(executeRound(simulation, controller.signal)).rejects.toThrow();
    simulation.maxRounds = 0;
    await expect(executeRound(simulation)).rejects.toThrow(/round budget/);
  });

  it("propagates a live provider failure instead of silently generating demo data", async () => {
    await expect(
      buildWorld(
        { ...input, model: { provider: "openai", model: "gpt-5.4-mini" } },
        sources,
      ),
    ).rejects.toThrow(/Live model resolution was attempted/);
  });
});

describe("actor information boundaries and reference validation", () => {
  it("excludes analyst-only sources from deterministic world construction and hostile stored assignments", async () => {
    const privateSource: Source = {
      id: "source-private",
      name: "PRIVATE_DOCUMENT_NAME",
      content: "PRIVATE_DOCUMENT_CONTENT",
      hash: "c".repeat(64),
      access: "analyst-only",
    };
    const publicWorld = await buildWorld(input, sources);
    const privateWorld = await buildWorld(input, [...sources, privateSource]);
    expect(privateWorld).toEqual(publicWorld);
    const simulation = await fixture();
    simulation.sources.push(privateSource);
    simulation.world.actors[0].sourceIds = [privateSource.id];
    expect(() => validateWorld(simulation.world, simulation.sources)).toThrow(
      /source IDs/,
    );
    const observation = observeActor(simulation, "actor-1");
    expect(observation.sources).toEqual([]);
    expect(observation.actor.sourceIds).toEqual([]);
    expect(JSON.stringify(observation)).not.toContain("PRIVATE_DOCUMENT");
    expect(JSON.stringify(observation)).not.toContain("source-private");
  });

  it("checks reference-shaped inline citations without forbidding ordinary bracketed prose", async () => {
    const simulation = await fixture();
    simulation.world.actors[0].sourceIds = ["source-1"];
    const observation = observeActor(simulation, "actor-1");
    const action = proposal(simulation, "actor-1");
    expect(
      validateAction(
        { ...action, content: "A [draft] proposal needs evidence." },
        observation,
      ).content,
    ).toContain("[draft]");
    expect(() =>
      validateAction({ ...action, content: "See [source-2]." }, observation),
    ).toThrow(/inline citation/);
    expect(() =>
      validateAction(
        { ...action, content: "See [source-1].", sourceIds: [] },
        observation,
      ),
    ).toThrow(/undeclared/);
    expect(
      validateAction(
        { ...action, content: "See [source-1].", sourceIds: ["source-1"] },
        observation,
      ).sourceIds,
    ).toEqual(["source-1"]);
    expect(() =>
      validateInterview(
        {
          answer: "A claim [simulation-test-r99-actor-1]",
          eventIds: [],
          sourceIds: [],
        },
        [],
        [],
      ),
    ).toThrow(/inline citation/);
    expect(() =>
      validateInterview(
        { answer: "A claim [source-1]", eventIds: [], sourceIds: [] },
        [],
        ["source-1"],
      ),
    ).toThrow(/undeclared/);
  });

  it("excludes disconnected actors, other private memory, unassigned sources, and private chats", async () => {
    const simulation = await fixture();
    simulation.world.relationships = [
      { from: "actor-1", to: "actor-2", label: "contact", weight: 0.6 },
    ];
    simulation.world.actors[0].sourceIds = ["source-1"];
    simulation.world.actors[1].memory = ["PRIVATE_NEIGHBOR_MEMORY"];
    simulation.world.actors[1].goal = "PRIVATE_NEIGHBOR_GOAL";
    simulation.world.actors[2].memory = ["PRIVATE_DISCONNECTED_MEMORY"];
    simulation.sources[1].content = "PRIVATE_SOURCE_CONTENT";
    simulation.messages = [
      {
        id: "message-1",
        role: "user",
        content: "PRIVATE_INTERVIEW",
        actorId: "actor-2",
        round: 0,
        createdAt: "2026-09-30T00:00:00.000Z",
      },
    ];
    const actions = simulation.world.actors.map((actor) =>
      proposal(simulation, actor.id),
    );
    actions[1].sourceIds = simulation.world.actors[1].sourceIds;
    const round = reduceRound(simulation, actions);
    commit(simulation, round);
    const observation = observeActor(simulation, "actor-1");
    const serialized = JSON.stringify(observation);
    expect(serialized).not.toContain("PRIVATE_");
    expect(observation.neighbors.map((actor) => actor.id)).toEqual(["actor-2"]);
    expect(observation.publicEvents.map((event) => event.actorId)).toEqual([
      "actor-1",
      "actor-2",
    ]);
    expect(
      observation.publicEvents.flatMap((event) => event.sourceIds),
    ).not.toContain("source-2");
    observation.actor.memory.push("MUTATION");
    expect(simulation.world.actors[0].memory).not.toContain("MUTATION");
  });

  it("rejects forged actor IDs, inaccessible source citations and disconnected targets", async () => {
    const simulation = await fixture();
    simulation.world.actors[0].sourceIds = ["source-1"];
    simulation.world.relationships = [
      { from: "actor-1", to: "actor-2", label: "contact", weight: 0.6 },
    ];
    const observation = observeActor(simulation, "actor-1");
    const action = proposal(simulation, "actor-1");
    expect(() =>
      validateAction({ ...action, actorId: "actor-2" }, observation),
    ).toThrow(/identity/);
    expect(() =>
      validateAction({ ...action, sourceIds: ["source-2"] }, observation),
    ).toThrow(/inaccessible/);
    expect(() =>
      validateAction({ ...action, targetId: "actor-3" }, observation),
    ).toThrow(/neighbor/);
    expect(() =>
      validateInterview(
        { answer: "Claim", eventIds: ["hidden-event"], sourceIds: [] },
        ["visible-event"],
        ["source-1"],
      ),
    ).toThrow(/inaccessible/);
    expect(() =>
      validateInterview(
        { answer: "Claim", eventIds: [], sourceIds: ["source-2"] },
        [],
        ["source-1"],
      ),
    ).toThrow(/inaccessible/);
  });

  it("rejects architect identity, source and relationship corruption", async () => {
    const simulation = await fixture();
    const invalid = structuredClone(simulation.world);
    invalid.actors[1].id = invalid.actors[0].id;
    expect(() => validateWorld(invalid, sources)).toThrow(/Duplicate actor/);
    const missingSource = structuredClone(simulation.world);
    missingSource.actors[0].sourceIds = ["fake-source"];
    expect(() => validateWorld(missingSource, sources)).toThrow(/inaccessible/);
    const invalidRelationship = structuredClone(simulation.world);
    invalidRelationship.relationships[0].to = "nonexistent-actor";
    expect(() => validateWorld(invalidRelationship, sources)).toThrow(
      /Unknown relationship/,
    );
    invalidRelationship.relationships[0].to =
      invalidRelationship.relationships[0].from;
    expect(() => validateWorld(invalidRelationship, sources)).toThrow(/Self/);
    const duplicate = structuredClone(simulation.world);
    duplicate.relationships.push({
      ...duplicate.relationships[0],
      from: duplicate.relationships[0].to,
      to: duplicate.relationships[0].from,
    });
    expect(() => validateWorld(duplicate, sources)).toThrow(
      /Duplicate relationship/,
    );
    const disconnected = structuredClone(simulation.world);
    disconnected.relationships = [disconnected.relationships[0]];
    expect(() => validateWorld(disconnected, sources)).toThrow(/connected/);
  });

  it("labels demo interviews and does not mutate world state", async () => {
    const simulation = await fixture();
    commit(simulation, await executeRound(simulation));
    const before = structuredClone(simulation);
    const reply = await answerQuestion(
      simulation,
      "What would convince you to change?",
      "actor-1",
    );
    expect(reply).toContain("Deterministic demo");
    expect(reply).toContain(simulation.world.actors[0].goal);
    expect(simulation).toEqual(before);
    await expect(
      answerQuestion(simulation, "Hello", "invented-actor"),
    ).rejects.toThrow(/Unknown actor/);
  });

  it("allows remembered own actions beyond two rounds while rejecting older neighbor events and forgotten own events", async () => {
    const simulation = await fixture();
    for (let index = 0; index < 6; index++)
      commit(simulation, await executeRound(simulation));
    let observation = observeActor(simulation, "actor-1");
    const ownFirstEvent = simulation.rounds[0].events.find(
      (event) => event.actorId === "actor-1",
    )!.id;
    const neighborFirstEvent = simulation.rounds[0].events.find(
      (event) => event.actorId === "actor-2",
    )!.id;
    expect(
      observation.publicEvents.some((event) => event.id === ownFirstEvent),
    ).toBe(false);
    expect(observation.rememberedEventIds).toContain(ownFirstEvent);
    expect(observation.rememberedEventIds).not.toContain(neighborFirstEvent);
    let visibleIds = [
      ...observation.publicEvents.map((event) => event.id),
      ...observation.rememberedEventIds,
    ];
    expect(
      validateInterview(
        { answer: "My first action", eventIds: [ownFirstEvent], sourceIds: [] },
        visibleIds,
        [],
      ),
    ).toBeTruthy();
    expect(() =>
      validateInterview(
        {
          answer: "Neighbor's first action",
          eventIds: [neighborFirstEvent],
          sourceIds: [],
        },
        visibleIds,
        [],
      ),
    ).toThrow(/inaccessible/);
    for (let index = 0; index < 3; index++)
      commit(simulation, await executeRound(simulation));
    observation = observeActor(simulation, "actor-1");
    visibleIds = [
      ...observation.publicEvents.map((event) => event.id),
      ...observation.rememberedEventIds,
    ];
    expect(observation.rememberedEventIds).not.toContain(ownFirstEvent);
    expect(() =>
      validateInterview(
        {
          answer: "Forgotten first action",
          eventIds: [ownFirstEvent],
          sourceIds: [],
        },
        visibleIds,
        [],
      ),
    ).toThrow(/inaccessible/);
  });

  it("restricts analyst citations to supplied events and surfaces source and history truncation", async () => {
    const simulation = await fixture();
    simulation.sources[0].content = "Full original text. ".repeat(1000);
    for (let index = 0; index < 6; index++)
      commit(simulation, await executeRound(simulation));
    const report = await generateReport(simulation);
    expect(report.uncertainties.join(" ")).toContain("source document(s)");
    expect(report.uncertainties.join(" ")).toContain("recent public events");
    expect(analystEvents(simulation)).toHaveLength(24);
    const firstEvent = simulation.rounds[0].events[0].id;
    expect(
      analystEvents(simulation).some((event) => event.id === firstEvent),
    ).toBe(false);
    report.findings[0].eventIds = [firstEvent];
    expect(() => validateReport(report, simulation)).toThrow(/inaccessible/);
    expect(simulation.sources[0].content.length).toBeGreaterThan(6000);
  });

  it("keeps a maximum UI population report within the structured citation schema", async () => {
    const simulation = await fixture();
    simulation.world = await buildWorld(
      { ...input, actorCount: 12 },
      simulation.sources,
    );
    simulation.initialWorld = structuredClone(simulation.world);
    for (let index = 0; index < 5; index++)
      commit(simulation, await executeRound(simulation));
    const report = await generateReport(simulation);
    expect(simulation.rounds[0].events).toHaveLength(12);
    expect(analystEvents(simulation)).toHaveLength(48);
    expect(
      report.findings.every((finding) => finding.eventIds.length <= 16),
    ).toBe(true);
    expect(validateReport(report, simulation)).toEqual(report);
  });
});
