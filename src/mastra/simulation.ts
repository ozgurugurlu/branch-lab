import { Agent } from "@mastra/core/agent";
import { noopLogger } from "@mastra/core/logger";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import type {
  Action,
  CreateSimulationInput,
  EngineRuntimeHooks,
  Report,
  Round,
  Simulation,
  Source,
  World,
} from "@/lib/types";
import { calculateMetrics } from "@/lib/simulation-math";
import { capabilityProfileFor } from "@/lib/capabilities";
import { resolveModel } from "@/server/models";
import {
  actionSchema,
  actorSchema,
  actorVisibleSources,
  analystContextNotes,
  analystEvents,
  interviewSchema,
  MEMORY_LIMIT,
  observeActor,
  reportSchema,
  validateAction,
  validateInterview,
  validateReport,
  validateWorld,
  worldSchema,
  sourceContextNotes,
  type ActorObservation,
  ENGINE_VERSION,
  PROMPT_VERSION,
} from "./domain";
import { buildDemoWorld, demoAnswer, demoDecision, demoReport } from "./demo";
import { checkedModelOutput, classifyEngineError, EngineError } from "./errors";
import {
  actorInstructions,
  ANALYST_CHAT_INSTRUCTIONS,
  ARCHITECT_INSTRUCTIONS,
  DATA_BOUNDARY,
  interviewInstructions,
  REPORT_INSTRUCTIONS,
} from "./prompts";
import {
  actorTools,
  analystTools,
  architectTools,
  emit,
  evidenceSnippets as evidenceForModel,
  MAX_AGENT_STEPS,
  runDemoRead,
  runtimeFor,
  type ScopedTools,
  type ToolRuntime,
} from "./tools";

export const MAX_MODEL_INPUT_CHARS = 160_000;
const MAX_CHAT_CONTEXT_CHARS = 12_000;
const MODEL_TIMEOUT_MS = 40_000;

const roundSchema = z.object({
  number: z.number().int().positive(),
  summary: z.string(),
  events: z.array(
    actionSchema.extend({ id: z.string(), round: z.number().int().positive() }),
  ),
  metrics: z.object({
    support: z.number().min(0).max(100),
    polarization: z.number().min(0).max(100),
    activity: z.number().int().min(0),
  }),
  actors: z.array(actorSchema),
  createdAt: z.string(),
  modelCalls: z.number().int().min(0),
  execution: z.object({ engineVersion: z.string(), promptVersion: z.string() }),
});

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw classifyEngineError(signal.reason, signal);
}

function callSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(MODEL_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function actorPayload(observation: ActorObservation) {
  return {
    ...observation,
    sources: evidenceForModel(observation.sources),
    contextLimits: sourceContextNotes(observation.sources),
  };
}

async function generateStructured<T extends z.ZodType>(
  simulationModel: Simulation["model"],
  agentId: string,
  instructions: string,
  payload: unknown,
  schema: T,
  signal?: AbortSignal,
  scoped?: ScopedTools,
  runtime?: ToolRuntime,
): Promise<z.infer<T>> {
  throwIfAborted(signal);
  const message = JSON.stringify({ scenarioData: payload });
  if (message.length > MAX_MODEL_INPUT_CHARS)
    throw new EngineError("MODEL_CONTEXT_LIMIT");
  const agent = new Agent({
    id: agentId,
    name: agentId,
    instructions: `${instructions}\n\n${DATA_BOUNDARY}`,
    model: resolveModel(simulationModel),
    tools: scoped?.tools ?? {},
  });
  // SDK diagnostics can contain prompts and provider bodies; the application owns safe traces/errors.
  agent.__setLogger(noopLogger);
  // Mastra 1.72 getLLM propagates registered primitives, not just the agent's logger field.
  agent.__registerPrimitives({ logger: noopLogger });
  const deadline = callSignal(signal);
  if (runtime) runtime.signal = deadline;
  const started = Date.now();
  try {
    if (runtime)
      await emit(runtime, {
        kind: "phase-start",
        summary:
          "Starting bounded model execution with scoped read-only tools.",
      });
    const response = await agent.generate(message, {
      maxSteps: MAX_AGENT_STEPS,
      toolChoice: scoped ? { type: "tool", toolName: scoped.primary } : "none",
      toolCallConcurrency: { limit: 1, strategy: "called" },
      prepareStep: ({ stepNumber }) => {
        if (runtime) runtime.modelCalls = stepNumber + 1;
        return {
          toolChoice:
            stepNumber === 0 && scoped
              ? { type: "tool" as const, toolName: scoped.primary }
              : stepNumber >= MAX_AGENT_STEPS - 1
                ? ("none" as const)
                : ("auto" as const),
        };
      },
      maxProcessorRetries: 0,
      tracingOptions: { hideInput: true, hideOutput: true },
      abortSignal: deadline,
      structuredOutput: {
        schema,
        errorStrategy: "strict",
        jsonPromptInjection: true,
        logger: noopLogger,
      },
      modelSettings: {
        maxOutputTokens:
          agentId === "world-architect"
            ? 6500
            : agentId === "simulation-report"
              ? 6000
              : agentId === "simulation-analyst"
                ? 3000
                : 1800,
        maxRetries: 0,
        timeout: { totalMs: MODEL_TIMEOUT_MS, stepMs: MODEL_TIMEOUT_MS },
      },
    });
    throwIfAborted(deadline);
    if (runtime?.toolError) throw runtime.toolError;
    if (scoped && !runtime?.toolCalls)
      throw new EngineError("MODEL_CAPABILITY_UNSUPPORTED");
    if (response.finishReason !== "stop" || response.tripwire)
      throw new EngineError("MODEL_OUTPUT_INVALID");
    const result = checkedModelOutput(() => schema.parse(response.object));
    if (runtime) {
      runtime.modelCalls = response.steps.length;
      await emit(runtime, {
        kind: "phase-end",
        status: "success",
        durationMs: Date.now() - started,
        modelCalls: runtime.modelCalls,
        summary:
          "The model completed its scoped tool work and returned a typed proposal for validation.",
      });
    }
    return result;
  } catch (error) {
    if (runtime)
      await emit(runtime, {
        kind: "error",
        status: "failed",
        durationMs: Date.now() - started,
        modelCalls: runtime.modelCalls,
        summary:
          "The bounded agent operation failed; no proposed changes were committed.",
      });
    throw classifyEngineError(error, deadline);
  }
}

export async function buildWorld(
  input: CreateSimulationInput,
  sources: Source[],
  signal?: AbortSignal,
  hooks?: EngineRuntimeHooks,
): Promise<World> {
  throwIfAborted(signal);
  if (
    !Number.isInteger(input.actorCount) ||
    input.actorCount < 2 ||
    input.actorCount > 16
  )
    throw new Error("Actor count is outside the engine budget.");
  if (
    sources.length > 20 ||
    new Set(sources.map((source) => source.id)).size !== sources.length
  )
    throw new Error("Invalid source collection.");
  const visibleSources = actorVisibleSources(sources);
  const runtime = runtimeFor(
    "architect",
    input.model.provider === "demo",
    signal,
    hooks,
  );
  const scoped = architectTools(input.actorCount, visibleSources, runtime);
  const assignProfiles = (world: World): World => ({
    ...world,
    actors: world.actors.map((actor) => ({
      ...actor,
      capabilityProfile: capabilityProfileFor(actor),
    })),
  });
  if (input.model.provider === "demo") {
    await runDemoRead(runtime, scoped);
    return assignProfiles(
      validateWorld(
        buildDemoWorld(input, visibleSources),
        sources,
        input.actorCount,
      ),
    );
  }
  const world = await generateStructured(
    input.model,
    "world-architect",
    ARCHITECT_INSTRUCTIONS,
    {
      question: input.question,
      context: input.context,
      actorCount: input.actorCount,
      seed: input.seed,
      sources: evidenceForModel(visibleSources),
    },
    worldSchema,
    signal,
    scoped,
    runtime,
  );
  return checkedModelOutput(() =>
    assignProfiles(validateWorld(world, sources, input.actorCount)),
  );
}

/** A bounded worker pool propagates failures and waits for in-flight work to settle. */
export async function mapActors<T, R>(
  values: readonly T[],
  map: (value: T, index: number, workerSignal: AbortSignal) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  let failure: unknown;
  let failed = false;
  const group = new AbortController();
  const workerSignal = signal
    ? AbortSignal.any([signal, group.signal])
    : group.signal;
  const worker = async () => {
    while (!failed) {
      try {
        throwIfAborted(workerSignal);
        const index = cursor++;
        if (index >= values.length) return;
        results[index] = await map(values[index], index, workerSignal);
      } catch (error) {
        if (!failed) {
          failure = error;
          failed = true;
          group.abort(error);
        }
        return;
      }
    }
  };
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(3, values.length) }, worker),
  );
  const rejected = workers.find((result) => result.status === "rejected");
  if (failed) throw failure;
  if (rejected?.status === "rejected") throw rejected.reason;
  throwIfAborted(signal);
  return results;
}

async function decide(
  observation: ActorObservation,
  simulation: Simulation,
  signal?: AbortSignal,
  hooks?: EngineRuntimeHooks,
) {
  const runtime = runtimeFor(
    "actor",
    simulation.model.provider === "demo",
    signal,
    hooks,
    observation.actor.id,
  );
  const scoped = actorTools(
    observation,
    runtime,
    simulation.privacy?.allowWebSearch === true,
  );
  if (simulation.model.provider === "demo") {
    await runDemoRead(runtime, scoped);
    return {
      action: validateAction(
        demoDecision(observation, simulation.seed),
        observation,
      ),
      modelCalls: 0,
    };
  }
  const raw = await generateStructured(
    simulation.model,
    `decision-${observation.actor.id}`,
    actorInstructions(capabilityProfileFor(observation.actor)),
    actorPayload(observation),
    actionSchema,
    signal,
    scoped,
    runtime,
  );
  return {
    action: checkedModelOutput(() => validateAction(raw, observation)),
    modelCalls: runtime.modelCalls,
  };
}

/** The reducer is the sole owner of state transitions; models do not invent aggregate metrics. */
export function reduceRound(
  simulation: Simulation,
  rawActions: Action[],
  createdAt = new Date().toISOString(),
): z.infer<typeof roundSchema> {
  const number = simulation.rounds.length + 1;
  if (rawActions.length !== simulation.world.actors.length)
    throw new Error("A round must contain one action per actor.");
  const byActor = new Map<string, Action>();
  for (const raw of rawActions) {
    if (byActor.has(raw.actorId))
      throw new Error("A round contains duplicate actor actions.");
    const action = validateAction(raw, observeActor(simulation, raw.actorId));
    byActor.set(action.actorId, action);
  }
  // Stable world order ensures network timing cannot affect replay or event order.
  const events = simulation.world.actors.map((actor) => {
    const action = byActor.get(actor.id);
    if (!action) throw new Error("A round is missing an actor action.");
    return {
      ...action,
      id: `${simulation.id}-r${number}-${actor.id}`,
      round: number,
    };
  });
  const actors = simulation.world.actors.map((actor) => {
    const event = events.find((candidate) => candidate.actorId === actor.id)!;
    const memory =
      `Round ${number} [${event.id}]: ${event.kind}; stance ${event.stance.toFixed(2)}. ${event.content}`.slice(
        0,
        800,
      );
    return {
      ...structuredClone(actor),
      stance: event.stance,
      memory: [...actor.memory, memory].slice(-MEMORY_LIMIT),
    };
  });
  const metrics = calculateMetrics(actors, events);
  const changed = events.filter(
    (event) =>
      Math.abs(
        event.stance -
          simulation.world.actors.find((actor) => actor.id === event.actorId)!
            .stance,
      ) >= 0.05,
  ).length;
  return roundSchema.parse({
    number,
    actors,
    events,
    metrics,
    createdAt,
    summary: `Round ${number}: ${metrics.activity} active voices, ${changed} stance shifts of at least 0.05. Synthetic support ${metrics.support.toFixed(1)}/100; polarization ${metrics.polarization.toFixed(1)}/100.`,
    modelCalls: simulation.model.provider === "demo" ? 0 : actors.length,
    execution: { engineVersion: ENGINE_VERSION, promptVersion: PROMPT_VERSION },
  });
}

export async function executeRound(
  simulation: Simulation,
  signal?: AbortSignal,
  hooks?: EngineRuntimeHooks,
): Promise<Round> {
  throwIfAborted(signal);
  if (
    simulation.rounds.length >= simulation.maxRounds ||
    simulation.rounds.length >= 24
  )
    throw new Error("This simulation has reached its round budget.");
  validateWorld(simulation.world, simulation.sources);
  const frozen = structuredClone(simulation);
  const observations = frozen.world.actors.map((actor) =>
    observeActor(frozen, actor.id),
  );
  const gateSchema = z.object({ round: z.number().int().positive() });
  const actionsSchema = z.object({
    actions: z.array(actionSchema),
    modelCalls: z.number().int().min(0),
  });
  let executionError: unknown;
  const decideStep = createStep({
    id: "actor-decisions",
    inputSchema: gateSchema,
    outputSchema: actionsSchema,
    retries: 0,
    execute: async () => {
      try {
        const decisions = await mapActors(
          observations,
          (observation, _index, workerSignal) =>
            decide(observation, frozen, workerSignal, hooks),
          signal,
        );
        return {
          actions: decisions.map((decision) => decision.action),
          modelCalls: decisions.reduce(
            (sum, decision) => sum + decision.modelCalls,
            0,
          ),
        };
      } catch (error) {
        executionError = error;
        throw error;
      }
    },
  });
  const reduceStep = createStep({
    id: "deterministic-reducer",
    inputSchema: actionsSchema,
    outputSchema: roundSchema,
    retries: 0,
    execute: async ({ inputData }) => {
      throwIfAborted(signal);
      try {
        return checkedModelOutput(() => ({
          ...reduceRound(frozen, inputData.actions),
          modelCalls: inputData.modelCalls,
        }));
      } catch (error) {
        executionError = error;
        throw error;
      }
    },
  });
  // This workflow is intentionally ephemeral. The application atomically persists completed rounds.
  const workflow = createWorkflow({
    id: "simulation-round",
    inputSchema: gateSchema,
    outputSchema: roundSchema,
    retryConfig: { attempts: 0, delay: 0 },
  })
    .then(decideStep)
    .then(reduceStep)
    .commit();
  workflow.__setLogger(noopLogger);
  const run = await workflow.createRun();
  const result = await run.start({
    inputData: { round: frozen.rounds.length + 1 },
    tracingOptions: { hideInput: true, hideOutput: true },
  });
  throwIfAborted(signal);
  if (result.status !== "success")
    throw classifyEngineError(
      executionError ?? (result.status === "failed" ? result.error : undefined),
      signal,
    );
  return roundSchema.parse(result.result);
}

function analystPayload(simulation: Simulation) {
  return {
    question: simulation.question,
    context: simulation.context,
    assumptions: simulation.world.assumptions,
    actors: simulation.world.actors.map(({ id, name, role, stance }) => ({
      id,
      name,
      role,
      stance,
    })),
    trajectories: simulation.rounds.map((round) => ({
      round: round.number,
      ...round.metrics,
    })),
    // Explicit selection prevents prompt growth; references still identify actual recorded events.
    recentEvents: analystEvents(simulation),
    contextLimits: analystContextNotes(simulation),
    interventions: simulation.interventions,
    sources: evidenceForModel(simulation.sources),
  };
}

export async function generateReport(
  simulation: Simulation,
  signal?: AbortSignal,
  hooks?: EngineRuntimeHooks,
): Promise<Report> {
  throwIfAborted(signal);
  const runtime = runtimeFor(
    "analyst",
    simulation.model.provider === "demo",
    signal,
    hooks,
  );
  const scoped = analystTools(simulation, runtime);
  if (simulation.model.provider === "demo") {
    await runDemoRead(runtime, scoped);
    const report = demoReport(simulation);
    // Demo reports do not call a model, but expose the same evidence window as live reports.
    return withContextNotes(validateReport(report, simulation), simulation);
  }
  const raw = await generateStructured(
    simulation.model,
    "simulation-report",
    REPORT_INSTRUCTIONS,
    analystPayload(simulation),
    reportSchema,
    signal,
    scoped,
    runtime,
  );
  return checkedModelOutput(() =>
    withContextNotes(validateReport(raw, simulation), simulation),
  );
}

function withContextNotes(report: Report, simulation: Simulation): Report {
  const notes = analystContextNotes(simulation);
  return {
    ...report,
    // Coverage notices are interface metadata; do not inject English into generated narrative.
    contextNotes: notes,
  };
}

/** Conversation is untrusted context, never an alternate route around the evidence window. */
function boundedHistory(
  simulation: Simulation,
  actorId: string | undefined,
  visibleReferences: Set<string>,
) {
  const matching = simulation.messages.filter(
    (entry) => entry.actorId === (actorId ?? null),
  );
  let remaining = MAX_CHAT_CONTEXT_CHARS;
  let omitted = Math.max(0, matching.length - 8);
  const entries = [];
  for (const entry of matching.slice(-8).reverse()) {
    const references = [
      ...entry.content.matchAll(
        /\[((?:source-[a-zA-Z0-9_-]+)|(?:[a-zA-Z0-9_-]+-r\d+-[a-zA-Z0-9_-]+))\]/g,
      ),
    ].map((match) => match[1]);
    if (
      (entry.role === "assistant" &&
        references.some((reference) => !visibleReferences.has(reference))) ||
      remaining === 0
    ) {
      omitted++;
      continue;
    }
    const content = entry.content.slice(0, Math.min(2000, remaining));
    remaining -= content.length;
    entries.push({
      role: entry.role,
      content,
      round: entry.round,
      truncated: content.length < entry.content.length,
    });
  }
  return {
    entries: entries.reverse(),
    omitted,
    status: "untrusted conversation, not simulation evidence",
  };
}

export async function answerQuestion(
  simulation: Simulation,
  message: string,
  actorId?: string,
  signal?: AbortSignal,
  hooks?: EngineRuntimeHooks,
): Promise<string> {
  throwIfAborted(signal);
  if (!message.trim() || message.length > 4000)
    throw new Error("Question must contain between 1 and 4,000 characters.");
  const observation = actorId ? observeActor(simulation, actorId) : undefined;
  const runtime = runtimeFor(
    observation ? "interview" : "analyst",
    simulation.model.provider === "demo",
    signal,
    hooks,
    actorId,
  );
  const scoped = observation
    ? actorTools(
        observation,
        runtime,
        simulation.privacy?.allowWebSearch === true,
      )
    : analystTools(simulation, runtime);
  if (simulation.model.provider === "demo") {
    await runDemoRead(runtime, scoped);
    return demoAnswer(simulation, message, observation);
  }
  const payload = observation
    ? actorPayload(observation)
    : analystPayload(simulation);
  const visibleEvents = observation
    ? [
        ...observation.publicEvents.map((event) => event.id),
        ...observation.rememberedEventIds,
      ]
    : analystEvents(simulation).map((event) => event.id);
  const visibleSources = observation
    ? observation.sources.map((source) => source.id)
    : simulation.sources.map((source) => source.id);
  const history = boundedHistory(
    simulation,
    actorId,
    new Set([...visibleEvents, ...visibleSources]),
  );
  const raw = await generateStructured(
    simulation.model,
    actorId ? `interview-${actorId}` : "simulation-analyst",
    observation
      ? interviewInstructions(capabilityProfileFor(observation.actor))
      : ANALYST_CHAT_INSTRUCTIONS,
    { observation: payload, history, question: message },
    interviewSchema,
    signal,
    scoped,
    runtime,
  );
  const reply = checkedModelOutput(() =>
    validateInterview(raw, visibleEvents, visibleSources),
  );
  const references = [...reply.eventIds, ...reply.sourceIds];
  return references.length
    ? `${reply.answer}\n\n${references.map((reference) => `[${reference}]`).join(" ")}`
    : reply.answer;
}
