import { z } from "zod";
import type {
  Action,
  Actor,
  Report,
  SimEvent,
  Simulation,
  Source,
  World,
} from "@/lib/types";

export const ENGINE_VERSION = "0.3.0";
export const PROMPT_VERSION = "2026-09-30.3";
export const MEMORY_LIMIT = 8;
export const SOURCE_CONTEXT_BUDGET = 24_000;
export const SOURCE_DOCUMENT_LIMIT = 6000;
export const ANALYST_ROUND_WINDOW = 4;
export const ANALYST_EVENT_LIMIT = 48;
const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
const prose = z.string().trim().min(1).max(1600);
const sourceIds = z.array(id).max(20);
const stance = z.number().finite().min(-1).max(1);

export const actorSchema = z
  .object({
    id: id.max(48),
    name: z.string().trim().min(1).max(80),
    role: z.string().trim().min(1).max(100),
    description: prose,
    goal: prose,
    stance,
    influence: z.number().finite().min(0).max(1),
    sourceIds,
    memory: z.array(z.string().min(1).max(800)).max(MEMORY_LIMIT),
    capabilityProfile: z
      .enum(["community", "research", "operations", "policy"])
      .optional(),
  })
  .strict();
export const relationshipSchema = z
  .object({
    from: id,
    to: id,
    label: z.string().trim().min(1).max(100),
    weight: z.number().finite().min(0).max(1),
  })
  .strict();
export const worldSchema = z
  .object({
    summary: prose,
    assumptions: z.array(prose).min(1).max(10),
    actors: z.array(actorSchema).min(2).max(16),
    relationships: z.array(relationshipSchema).min(1).max(60),
  })
  .strict();
export const actionSchema = z
  .object({
    actorId: id,
    kind: z.enum(["advocate", "oppose", "question", "adapt", "observe"]),
    content: prose,
    stance,
    targetId: id.nullable(),
    sourceIds,
  })
  .strict();
export const reportSchema = z
  .object({
    headline: z.string().trim().min(1).max(180),
    summary: z.string().trim().min(1).max(3000),
    findings: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(160),
            detail: prose,
            eventIds: z.array(id).max(16),
          })
          .strict(),
      )
      .min(1)
      .max(6),
    uncertainties: z.array(prose).min(1).max(8),
    sourceIds,
  })
  .strict();
export const interviewSchema = z
  .object({
    answer: z.string().trim().min(1).max(5000),
    eventIds: z.array(id).max(12),
    sourceIds,
  })
  .strict();

function assertUnique(values: string[], label: string) {
  if (new Set(values).size !== values.length)
    throw new Error(`Duplicate ${label}.`);
}

function assertReferences(
  values: string[],
  allowed: Set<string>,
  label: string,
) {
  assertUnique(values, label);
  if (values.some((value) => !allowed.has(value)))
    throw new Error(`Unknown or inaccessible ${label}.`);
}

/** Source visibility is enforced before prompt assembly, never delegated to a model. */
export function actorVisibleSources(sources: Source[]): Source[] {
  return sources.filter((source) => source.access !== "analyst-only");
}

/** Check citation-shaped prose too; ordinary brackets such as [draft] are not citations. */
function assertInlineReferences(
  texts: string[],
  allowed: Set<string>,
  declared: Set<string>,
) {
  for (const text of texts) {
    for (const match of text.matchAll(/\[([a-zA-Z0-9_-]+)\]/g)) {
      const reference = match[1];
      if (
        !reference.startsWith("source-") &&
        !/-r\d+-/.test(reference) &&
        !allowed.has(reference)
      )
        continue;
      if (!allowed.has(reference) || !declared.has(reference))
        throw new Error(
          "Unknown, inaccessible, or undeclared inline citation.",
        );
    }
  }
}

export function validateWorld(
  raw: unknown,
  sources: Source[],
  expectedActors?: number,
): World {
  const world = worldSchema.parse(raw);
  if (expectedActors !== undefined && world.actors.length !== expectedActors) {
    throw new Error("The architect returned an unexpected number of actors.");
  }
  assertUnique(
    world.actors.map((actor) => actor.id),
    "actor IDs",
  );
  const actors = new Set(world.actors.map((actor) => actor.id));
  const sourceSet = new Set(
    actorVisibleSources(sources).map((source) => source.id),
  );
  world.actors.forEach((actor) =>
    assertReferences(actor.sourceIds, sourceSet, "source IDs"),
  );
  const links = new Set<string>();
  for (const relationship of world.relationships) {
    if (!actors.has(relationship.from) || !actors.has(relationship.to))
      throw new Error("Unknown relationship actor.");
    if (relationship.from === relationship.to)
      throw new Error("Self relationships are not permitted.");
    const key = [relationship.from, relationship.to].sort().join(":");
    if (links.has(key)) throw new Error("Duplicate relationship.");
    links.add(key);
  }
  const reached = new Set([world.actors[0].id]);
  for (let pass = 0; pass < world.actors.length; pass++) {
    for (const relationship of world.relationships) {
      if (reached.has(relationship.from)) reached.add(relationship.to);
      if (reached.has(relationship.to)) reached.add(relationship.from);
    }
  }
  if (reached.size !== world.actors.length)
    throw new Error("The actor contact graph must be connected.");
  return world;
}

export interface ActorObservation {
  question: string;
  context: string;
  round: number;
  actor: Actor;
  neighbors: {
    id: string;
    name: string;
    role: string;
    weight: number;
    relationship: string;
  }[];
  publicEvents: SimEvent[];
  rememberedEventIds: string[];
  sources: Source[];
  interventions: { content: string; afterRound: number }[];
}

/** Observation is an explicit information boundary. No other actor's private memory or goals. */
export function observeActor(
  simulation: Simulation,
  actorId: string,
): ActorObservation {
  const actor = simulation.world.actors.find(
    (candidate) => candidate.id === actorId,
  );
  if (!actor) throw new Error("Unknown actor.");
  const neighborLinks = simulation.world.relationships.filter(
    (link) => link.from === actorId || link.to === actorId,
  );
  const neighbors = neighborLinks.map((link) => {
    const neighborId = link.from === actorId ? link.to : link.from;
    const neighbor = simulation.world.actors.find(
      (candidate) => candidate.id === neighborId,
    );
    if (!neighbor) throw new Error("Invalid relationship.");
    return {
      id: neighbor.id,
      name: neighbor.name,
      role: neighbor.role,
      weight: link.weight,
      relationship: link.label,
    };
  });
  const visibleActors = new Set([
    actorId,
    ...neighbors.map((neighbor) => neighbor.id),
  ]);
  const assignableSources = new Set(
    actorVisibleSources(simulation.sources).map((source) => source.id),
  );
  const visibleSources = new Set(
    actor.sourceIds.filter((sourceId) => assignableSources.has(sourceId)),
  );
  const publicEvents = simulation.rounds
    .slice(-2)
    .flatMap((round) => round.events)
    .filter((event) => visibleActors.has(event.actorId))
    .map((event) => ({
      ...event,
      // A public statement doesn't grant permission to read the speaker's source documents.
      sourceIds: event.sourceIds.filter((sourceId) =>
        visibleSources.has(sourceId),
      ),
      targetId:
        event.targetId && visibleActors.has(event.targetId)
          ? event.targetId
          : null,
    }));
  const rememberedEventIds = simulation.rounds
    .flatMap((round) => round.events)
    .filter(
      (event) =>
        event.actorId === actorId &&
        actor.memory.some((memory) => memory.includes(`[${event.id}]`)),
    )
    .map((event) => event.id);
  return structuredClone({
    question: simulation.question,
    context: simulation.context,
    round: simulation.rounds.length + 1,
    actor: { ...actor, sourceIds: [...visibleSources] },
    neighbors,
    publicEvents,
    rememberedEventIds,
    sources: simulation.sources.filter((source) =>
      visibleSources.has(source.id),
    ),
    interventions: simulation.interventions
      .filter(
        (intervention) => intervention.afterRound <= simulation.rounds.length,
      )
      .map(({ content, afterRound }) => ({ content, afterRound })),
  });
}

export function analystEvents(simulation: Simulation) {
  return simulation.rounds
    .slice(-ANALYST_ROUND_WINDOW)
    .flatMap((round) => round.events)
    .slice(-ANALYST_EVENT_LIMIT);
}

export function sourceContextNotes(sources: Source[]): string[] {
  const perSource = Math.min(
    SOURCE_DOCUMENT_LIMIT,
    Math.floor(SOURCE_CONTEXT_BUDGET / Math.max(1, sources.length)),
  );
  const truncated = sources.filter(
    (source) => source.content.length > perSource,
  );
  return truncated.length
    ? [
        `Model context uses excerpts: ${truncated.length} source document(s) exceed the ${perSource.toLocaleString("en-US")}-character per-document allowance. Original imported text remains stored; omitted passages were not considered by the model.`,
      ]
    : [];
}

export function analystContextNotes(simulation: Simulation): string[] {
  const totalEvents = simulation.rounds.reduce(
    (count, round) => count + round.events.length,
    0,
  );
  const visibleEvents = analystEvents(simulation).length;
  return [
    ...(visibleEvents < totalEvents
      ? [
          `Detailed evidence is limited to ${visibleEvents} recent public events from at most the latest ${ANALYST_ROUND_WINDOW} rounds. Metrics include all ${simulation.rounds.length} rounds; earlier event details were not supplied to the analyst.`,
        ]
      : []),
    ...sourceContextNotes(simulation.sources),
  ];
}

export function validateAction(
  raw: unknown,
  observation: ActorObservation,
): Action {
  const action = actionSchema.parse(raw);
  if (action.actorId !== observation.actor.id)
    throw new Error("Actor identity mismatch.");
  if (
    action.targetId !== null &&
    !observation.neighbors.some((neighbor) => neighbor.id === action.targetId)
  ) {
    throw new Error("Action target is not a visible neighbor.");
  }
  assertReferences(
    action.sourceIds,
    new Set(observation.sources.map((source) => source.id)),
    "source IDs",
  );
  const visibleEvents = [
    ...observation.publicEvents.map((event) => event.id),
    ...observation.rememberedEventIds,
  ];
  assertInlineReferences(
    [action.content],
    new Set([
      ...visibleEvents,
      ...observation.sources.map((source) => source.id),
    ]),
    new Set([...visibleEvents, ...action.sourceIds]),
  );
  return action;
}

export function validateReport(raw: unknown, simulation: Simulation): Report {
  const report = reportSchema.parse(raw);
  const events = new Set(analystEvents(simulation).map((event) => event.id));
  const sources = new Set(simulation.sources.map((source) => source.id));
  assertReferences(report.sourceIds, sources, "source IDs");
  for (const finding of report.findings) {
    assertReferences(finding.eventIds, events, "event IDs");
    if (events.size > 0 && finding.eventIds.length === 0)
      throw new Error("Report finding has no supporting event.");
    assertInlineReferences(
      [finding.title, finding.detail],
      new Set([...events, ...sources]),
      new Set([...finding.eventIds, ...report.sourceIds]),
    );
  }
  assertInlineReferences(
    [report.headline, report.summary, ...report.uncertainties],
    new Set([...events, ...sources]),
    new Set([
      ...report.findings.flatMap((finding) => finding.eventIds),
      ...report.sourceIds,
    ]),
  );
  return report;
}

export function validateInterview(
  raw: unknown,
  eventIds: string[],
  visibleSourceIds: string[],
) {
  const reply = interviewSchema.parse(raw);
  assertReferences(reply.eventIds, new Set(eventIds), "event IDs");
  assertReferences(reply.sourceIds, new Set(visibleSourceIds), "source IDs");
  assertInlineReferences(
    [reply.answer],
    new Set([...eventIds, ...visibleSourceIds]),
    new Set([...reply.eventIds, ...reply.sourceIds]),
  );
  return reply;
}
