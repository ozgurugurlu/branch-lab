import { createHash, randomUUID } from "node:crypto";
import type { CreateSimulationInput, Simulation, Source } from "@/lib/types";
import {
  buildWorld,
  executeRound,
  answerQuestion,
  generateReport,
} from "@/mastra/simulation";
import { ENGINE_VERSION, PROMPT_VERSION } from "@/mastra/domain";
import { isSupportedModel } from "@/lib/providers";
import { getProviderStatuses } from "./models";
import { AppError } from "./errors";
import {
  acquireLease,
  commitLease,
  insertSimulation,
  readSimulation,
  releaseLease,
  type Lease,
} from "./store";
import { consumeLimit, reserveModelCalls } from "./security";
import { withOperation, type Operation } from "./operations";
import { operationRuntime } from "./trace";

async function ensureModel(
  input: { model: Simulation["model"]; privacy?: { allowCloud: boolean } },
  owner: string,
  calls: number,
  requireConsent = false,
) {
  if (
    input.privacy?.allowCloud === false &&
    ["openai", "google"].includes(input.model.provider)
  )
    throw new AppError(
      "CLOUD_PROCESSING_DENIED",
      "This run does not allow cloud model processing. Create a new run with explicit cloud consent or use a local provider.",
      403,
    );
  if (!isSupportedModel(input.model))
    throw new AppError(
      "INVALID_MODEL",
      "Choose a supported model or a valid installed local model identifier.",
    );
  const provider = getProviderStatuses().find(
    (p) => p.id === input.model.provider,
  );
  if (!provider?.configured)
    throw new AppError(
      "PROVIDER_NOT_CONFIGURED",
      provider?.reason ||
        "Configure this model provider in the server environment.",
      400,
    );
  if (
    ["openai", "google"].includes(input.model.provider) &&
    !provider.models.some((m) => m.id === input.model.model)
  )
    throw new AppError(
      "INVALID_MODEL",
      "Choose one of the configured cloud model presets.",
    );
  if (
    requireConsent &&
    ["openai", "google"].includes(input.model.provider) &&
    input.privacy?.allowCloud !== true
  )
    throw new AppError(
      "CLOUD_CONSENT_REQUIRED",
      "Explicitly allow cloud model processing before creating this run.",
      403,
    );
  if (input.model.provider !== "demo") await reserveModelCalls(owner, calls);
}

async function createSimulationInternal(
  input: CreateSimulationInput,
  owner: string,
  signal: AbortSignal,
  operation: Operation,
) {
  await consumeLimit(`create:${owner}`, 30, 60 * 60 * 1000);
  await ensureModel(input, owner, 3, true);
  const sources: Source[] = input.sources.map((s, i) => ({
    ...s,
    id: `source-${i + 1}`,
    hash: createHash("sha256").update(s.content).digest("hex"),
  }));
  const runtime = await operationRuntime(
    operation,
    input.privacy?.allowWebSearch === true,
    signal,
  );
  const world = await buildWorld(input, sources, runtime.signal, runtime.hooks);
  signal.throwIfAborted();
  const now = new Date().toISOString();
  const simulation: Simulation = {
    id: randomUUID(),
    title: input.title?.trim() || "Untitled simulation",
    titleSource: input.title?.trim() ? "user" : "default",
    question: input.question,
    context: input.context,
    model: input.model,
    privacy: input.privacy ?? { allowCloud: false },
    seed: input.seed,
    maxRounds: input.maxRounds,
    initialWorld: structuredClone(world),
    world,
    sources,
    rounds: [],
    interventions: [],
    messages: [],
    report: null,
    status: "ready",
    createdAt: now,
    updatedAt: now,
    parentId: null,
    forkRound: null,
    version: 0,
    usage: { modelCalls: runtime.modelCalls() },
    manifest: { engineVersion: ENGINE_VERSION, promptVersion: PROMPT_VERSION },
  };
  return insertSimulation(simulation, owner, operation);
}

async function mutate(
  id: string,
  owner: string,
  update: (simulation: Simulation, lease: Lease) => Promise<Simulation>,
  operation: Operation,
) {
  const lease = await acquireLease(id, owner);
  try {
    return await commitLease(
      lease,
      await update(lease.simulation, lease),
      owner,
      operation,
    );
  } finally {
    // A cleanup outage must not turn an already committed success into a misleading failure.
    await releaseLease(id, owner, lease.token).catch(() => {
      console.error(
        JSON.stringify({
          event: "lease_cleanup_failed",
          code: "DATABASE_UNAVAILABLE",
        }),
      );
    });
  }
}

async function stepSimulationInternal(
  id: string,
  owner: string,
  expectedRound: number,
  signal: AbortSignal,
  operation: Operation,
) {
  const current = await readSimulation(id, owner);
  if (expectedRound < current.rounds.length) return current;
  if (expectedRound > current.rounds.length)
    throw new AppError(
      "ROUND_MISMATCH",
      "Reload the saved run before advancing its next round.",
      409,
      true,
    );
  if (current.rounds.length >= current.maxRounds) return current;
  return mutate(
    id,
    owner,
    async (simulation) => {
      if (expectedRound !== simulation.rounds.length)
        throw new AppError(
          "ROUND_MISMATCH",
          "The run advanced in another request. Reload the saved state.",
          409,
          true,
        );
      await ensureModel(simulation, owner, simulation.world.actors.length * 3);
      const runtime = await operationRuntime(
        operation,
        simulation.privacy?.allowWebSearch === true,
        signal,
      );
      const round = await executeRound(
        simulation,
        runtime.signal,
        runtime.hooks,
      );
      signal.throwIfAborted();
      if (round.number !== simulation.rounds.length + 1)
        throw new AppError(
          "INVALID_ROUND",
          "The engine returned an invalid round number.",
          500,
        );
      return {
        ...simulation,
        rounds: [...simulation.rounds, round],
        world: { ...simulation.world, actors: round.actors },
        report: null,
        status: round.number >= simulation.maxRounds ? "completed" : "ready",
        usage: { modelCalls: simulation.usage.modelCalls + round.modelCalls },
      };
    },
    operation,
  );
}

async function branchSimulationInternal(
  id: string,
  owner: string,
  intervention: string,
  title: string | undefined,
  operation: Operation,
) {
  await consumeLimit(`create:${owner}`, 30, 60 * 60 * 1000);
  // A read is a consistent completed checkpoint even while a new round is in flight.
  const parent = await readSimulation(id, owner);
  if (parent.rounds.length >= 24)
    throw new AppError(
      "ROUND_LIMIT",
      "This branch reached the 24-round limit. Start a new scenario to continue.",
    );
  const now = new Date().toISOString();
  const child: Simulation = {
    ...structuredClone(parent),
    id: randomUUID(),
    title: title?.trim() || `${parent.title.slice(0, 83)} · branch`,
    titleSource: title?.trim() ? "user" : "default",
    createdAt: now,
    updatedAt: now,
    parentId: parent.id,
    forkRound: parent.rounds.length,
    version: 0,
    status: "ready",
    maxRounds: Math.min(24, parent.rounds.length + 3),
    report: null,
    messages: [],
    interventions: [
      ...parent.interventions,
      {
        id: randomUUID(),
        afterRound: parent.rounds.length,
        content: intervention,
      },
    ],
  };
  return insertSimulation(child, owner, operation);
}

async function chatSimulationInternal(
  id: string,
  owner: string,
  message: string,
  actorId: string | undefined,
  signal: AbortSignal,
  operation: Operation,
) {
  return mutate(
    id,
    owner,
    async (simulation) => {
      if (simulation.messages.length >= 80)
        throw new AppError(
          "CHAT_LIMIT",
          "This run reached 40 questions. Export the conversation or continue in a new branch.",
        );
      if (actorId && !simulation.world.actors.some((a) => a.id === actorId))
        throw new AppError(
          "INVALID_ACTOR",
          "Select an actor in this simulation.",
        );
      await ensureModel(simulation, owner, 3);
      const runtime = await operationRuntime(
        operation,
        simulation.privacy?.allowWebSearch === true,
        signal,
      );
      const response = await answerQuestion(
        simulation,
        message,
        actorId,
        runtime.signal,
        runtime.hooks,
      );
      signal.throwIfAborted();
      const now = new Date().toISOString();
      return {
        ...simulation,
        messages: [
          ...simulation.messages,
          {
            id: randomUUID(),
            role: "user" as const,
            content: message,
            actorId: actorId || null,
            createdAt: now,
            round: simulation.rounds.length,
          },
          {
            id: randomUUID(),
            role: "assistant" as const,
            content: response,
            actorId: actorId || null,
            createdAt: now,
            round: simulation.rounds.length,
          },
        ],
        usage: {
          modelCalls: simulation.usage.modelCalls + runtime.modelCalls(),
        },
      };
    },
    operation,
  );
}

async function reportSimulationInternal(
  id: string,
  owner: string,
  signal: AbortSignal,
  operation: Operation,
  refresh: boolean,
  expectedRound?: number,
) {
  const assertRound = (simulation: Simulation) => {
    if (
      expectedRound !== undefined &&
      simulation.rounds.length !== expectedRound
    )
      throw new AppError(
        "ROUND_MISMATCH",
        "The simulation has advanced. Refresh saved state before generating its report.",
        409,
      );
  };
  const current = await readSimulation(id, owner);
  assertRound(current);
  if (current.report && !refresh) return current;
  if (!current.rounds.length)
    throw new AppError(
      "NO_ROUNDS",
      "Complete at least one round before generating a report.",
    );
  return mutate(
    id,
    owner,
    async (simulation) => {
      assertRound(simulation);
      await ensureModel(simulation, owner, 3);
      const runtime = await operationRuntime(
        operation,
        simulation.privacy?.allowWebSearch === true,
        signal,
      );
      const report = await generateReport(
        simulation,
        runtime.signal,
        runtime.hooks,
      );
      signal.throwIfAborted();
      return {
        ...simulation,
        report,
        usage: {
          modelCalls: simulation.usage.modelCalls + runtime.modelCalls(),
        },
      };
    },
    operation,
  );
}

export function createSimulation(
  input: CreateSimulationInput,
  owner: string,
  signal: AbortSignal,
) {
  const { requestId, ...payload } = input;
  return withOperation(owner, "create", null, payload, requestId, (op) =>
    createSimulationInternal(payload, owner, signal, op),
  );
}
export function stepSimulation(
  id: string,
  owner: string,
  expectedRound: number,
  signal: AbortSignal,
  requestId?: string,
) {
  return withOperation(owner, "step", id, { expectedRound }, requestId, (op) =>
    stepSimulationInternal(id, owner, expectedRound, signal, op),
  );
}
export function branchSimulation(
  id: string,
  owner: string,
  intervention: string,
  title?: string,
  requestId?: string,
) {
  return withOperation(
    owner,
    "branch",
    id,
    { intervention, title },
    requestId,
    (op) => branchSimulationInternal(id, owner, intervention, title, op),
  );
}
export function chatSimulation(
  id: string,
  owner: string,
  message: string,
  actorId: string | undefined,
  signal: AbortSignal,
  requestId?: string,
) {
  return withOperation(
    owner,
    "chat",
    id,
    { message, actorId },
    requestId,
    (op) => chatSimulationInternal(id, owner, message, actorId, signal, op),
  );
}
export function reportSimulation(
  id: string,
  owner: string,
  signal: AbortSignal,
  requestId?: string,
  refresh = false,
  expectedRound?: number,
) {
  return withOperation(
    owner,
    "report",
    id,
    {
      ...(refresh ? { refresh: true } : {}),
      ...(expectedRound !== undefined ? { expectedRound } : {}),
    },
    requestId,
    (op) =>
      reportSimulationInternal(id, owner, signal, op, refresh, expectedRound),
  );
}
