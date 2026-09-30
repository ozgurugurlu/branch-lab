import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  Actor,
  CreateSimulationInput,
  Simulation,
  Source,
  World,
} from "@/lib/types";
import {
  answerQuestion,
  buildWorld,
  executeRound,
  generateReport,
} from "@/mastra/simulation";

/** This is a protocol fixture, not a model mock: the real provider, HTTP client, Agent and workflow execute. */
interface ChatRequest {
  model: string;
  stream?: boolean;
  messages: {
    role: string;
    content: string | { type: string; text?: string }[];
  }[];
  response_format?: unknown;
}
type Captured = {
  request: ChatRequest;
  payload: Record<string, unknown>;
  text: string;
};
const input: CreateSimulationInput = {
  title: "Protocol fixture",
  question: "Will stakeholders support a reversible neighborhood pilot?",
  context: "Synthetic protocol test, without external inference.",
  model: { provider: "ollama", model: "schema-fixture" },
  seed: 11,
  maxRounds: 3,
  actorCount: 4,
  sources: [],
};
const sources: Source[] = [
  {
    id: "source-1",
    name: "Public brief",
    content: "VISIBLE_BRIEF: The pilot will be evaluated.",
    hash: "a".repeat(64),
  },
  {
    id: "source-2",
    name: "Assigned appendix",
    content: "RESTRICTED_APPENDIX: Alternative delivery access.",
    hash: "b".repeat(64),
  },
];
const world: World = {
  summary: "Four fictional stakeholders discuss a reversible pilot.",
  assumptions: [
    "Profiles and initial stances are synthetic protocol fixtures.",
  ],
  actors: Array.from({ length: 4 }, (_, index) => ({
    id: `actor-${index + 1}`,
    name: `Stakeholder ${index + 1}`,
    role: `Fictional role ${index + 1}`,
    description: "A fictional stakeholder.",
    goal: `PRIVATE_GOAL_${index + 1}`,
    stance: index % 2 ? -0.4 : 0.4,
    influence: 0.5,
    sourceIds: [index % 2 ? "source-2" : "source-1"],
    memory: [`PRIVATE_MEMORY_${index + 1}`],
  })),
  relationships: [
    { from: "actor-1", to: "actor-2", label: "contact", weight: 0.5 },
    { from: "actor-2", to: "actor-3", label: "contact", weight: 0.5 },
    { from: "actor-3", to: "actor-4", label: "contact", weight: 0.5 },
  ],
};

let server: Server;
let captured: Captured[];
let failureMode: "none" | "invalid-json" | "http-error";
let active = 0;
let peak = 0;

function messageText(request: ChatRequest) {
  return request.messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => part.text ?? "").join("\n"),
    )
    .join("\n");
}

/** Inline JSON-schema instructions may surround the payload; locate its own balanced JSON object. */
function scenarioPayload(request: ChatRequest): Record<string, unknown> {
  const text = messageText(request);
  const marker = text.indexOf('{"scenarioData":');
  if (marker < 0)
    throw new Error("The actual model request omitted scenarioData.");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = marker; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0)
      return JSON.parse(text.slice(marker, index + 1)).scenarioData;
  }
  throw new Error(
    "The actual model request contained incomplete scenario JSON.",
  );
}

function structuredReply(payload: Record<string, unknown>) {
  if (payload.actorCount) return structuredClone(world);
  if (payload.actor) {
    const actor = payload.actor as Actor;
    return {
      actorId: actor.id,
      kind: "question",
      content: `Protocol response from ${actor.name}: please evaluate the pilot.`,
      stance: actor.stance + 0.05,
      targetId: null,
      sourceIds: actor.sourceIds,
    };
  }
  if (payload.observation) {
    const observation = payload.observation as Record<string, unknown>;
    const events = (observation.publicEvents ?? observation.recentEvents) as {
      id: string;
    }[];
    return {
      answer:
        "The recorded action asks for evaluation; this is synthetic evidence.",
      eventIds: events.length ? [events[0].id] : [],
      sourceIds: [],
    };
  }
  const events = payload.recentEvents as { id: string }[];
  return {
    headline: "Recorded requests for evaluation",
    summary: "The fictional actors requested evaluation in the observed round.",
    findings: [
      {
        title: "Observed request",
        detail: "A recorded actor action requested evaluation of the pilot.",
        eventIds: [events[0].id],
      },
    ],
    uncertainties: [
      "This protocol fixture cannot establish real-world behavior.",
    ],
    sourceIds: [],
  };
}

function sendCompletion(
  response: ServerResponse,
  request: ChatRequest,
  content: string,
) {
  const envelope = {
    id: `fixture-${captured.length}`,
    created: 1_800_000_000,
    model: request.model,
  };
  if (request.stream) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    response.write(
      `data: ${JSON.stringify({ ...envelope, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ ...envelope, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  } else {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        ...envelope,
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 100,
          total_tokens: 200,
        },
      }),
    );
  }
}

beforeEach(async () => {
  captured = [];
  failureMode = "none";
  active = 0;
  peak = 0;
  server = createServer(async (request, response) => {
    active++;
    peak = Math.max(peak, active);
    try {
      if (request.url !== "/v1/chat/completions")
        throw new Error(`Unexpected endpoint: ${request.url}`);
      let body = "";
      for await (const chunk of request) body += chunk;
      const data = JSON.parse(body) as ChatRequest;
      const payload = scenarioPayload(data);
      captured.push({ request: data, payload, text: messageText(data) });
      if (payload.actor && failureMode === "http-error") {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "Protocol fixture rejected the request",
              type: "invalid_request_error",
            },
          }),
        );
      } else {
        // A tiny delay makes actual parallel actor requests observable without slowing the test suite.
        if (payload.actor)
          await new Promise((resolve) => setTimeout(resolve, 10));
        const content =
          payload.actor && failureMode === "invalid-json"
            ? "this is not a JSON object"
            : JSON.stringify(structuredReply(payload));
        sendCompletion(response, data, content);
      }
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: error instanceof Error ? error.message : "Fixture failed",
          },
        }),
      );
    } finally {
      active--;
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  vi.stubEnv("ENABLE_LOCAL_MODELS", "true");
  vi.stubEnv("OLLAMA_BASE_URL", `http://127.0.0.1:${port}/v1`);
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("CF_PAGES", "");
  vi.stubEnv("WORKERS_CI", "");
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  vi.unstubAllEnvs();
});

async function simulationFixture(): Promise<Simulation> {
  const generated = await buildWorld(input, sources, AbortSignal.timeout(4000));
  return {
    id: "live-protocol",
    title: input.title,
    question: input.question,
    context: input.context,
    seed: input.seed,
    model: input.model,
    maxRounds: input.maxRounds,
    sources: structuredClone(sources),
    initialWorld: structuredClone(generated),
    world: generated,
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
    usage: { modelCalls: 1 },
    manifest: { engineVersion: "0.1.0", promptVersion: "2026-09-30.1" },
  };
}

describe("real provider to Mastra workflow protocol", () => {
  it("executes architect, isolated actor decisions, report and interview through the HTTP adapter", async () => {
    const simulation = await simulationFixture();
    expect(simulation.world).toEqual(world);
    const round = await executeRound(simulation, AbortSignal.timeout(4000));
    expect(round.modelCalls).toBe(4);
    expect(
      round.events.every((event) =>
        event.content.startsWith("Protocol response"),
      ),
    ).toBe(true);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
    const actorRequests = captured.filter((entry) => entry.payload.actor);
    expect(actorRequests).toHaveLength(4);
    for (const entry of actorRequests) {
      const actor = entry.payload.actor as Actor;
      const number = Number(actor.id.split("-")[1]);
      expect(entry.text).toContain(`PRIVATE_MEMORY_${number}`);
      for (const other of [1, 2, 3, 4].filter(
        (candidate) => candidate !== number,
      )) {
        expect(entry.text).not.toContain(`PRIVATE_MEMORY_${other}`);
        expect(entry.text).not.toContain(`PRIVATE_GOAL_${other}`);
      }
      if (actor.sourceIds.includes("source-1"))
        expect(entry.text).not.toContain("RESTRICTED_APPENDIX");
      expect(entry.payload.publicEvents).toEqual([]);
    }
    simulation.rounds.push(round);
    simulation.world.actors = round.actors;
    const report = await generateReport(simulation, AbortSignal.timeout(4000));
    expect(report.findings[0].eventIds).toEqual([round.events[0].id]);
    const answer = await answerQuestion(
      simulation,
      "What happened?",
      "actor-1",
      AbortSignal.timeout(4000),
    );
    expect(answer).toContain(round.events[0].id);
    expect(answer).not.toContain("Deterministic demo");
    expect(
      captured.every((entry) => entry.request.model === "schema-fixture"),
    ).toBe(true);
  });

  it.each(["invalid-json", "http-error"] as const)(
    "fails a live round on %s without substituting demo output",
    async (mode) => {
      const simulation = await simulationFixture();
      failureMode = mode;
      const before = structuredClone(simulation);
      await expect(
        executeRound(simulation, AbortSignal.timeout(4000)),
      ).rejects.toThrow(/failed|valid|JSON|abort|timeout/i);
      expect(simulation).toEqual(before);
      expect(captured.some((entry) => entry.payload.actor)).toBe(true);
    },
  );
});
