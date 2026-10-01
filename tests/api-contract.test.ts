import { createHash } from "node:crypto";
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
import { GET as configGET } from "../src/app/api/config/route";
import { GET as healthGET } from "../src/app/api/health/route";
import {
  DELETE as sessionDELETE,
  POST as sessionPOST,
} from "../src/app/api/session/route";
import {
  GET as runsGET,
  POST as runsPOST,
} from "../src/app/api/simulations/route";
import {
  DELETE as runDELETE,
  GET as runGET,
} from "../src/app/api/simulations/[id]/route";
import { POST as stepPOST } from "../src/app/api/simulations/[id]/step/route";
import { POST as chatPOST } from "../src/app/api/simulations/[id]/chat/route";
import { POST as reportPOST } from "../src/app/api/simulations/[id]/report/route";
import { POST as branchPOST } from "../src/app/api/simulations/[id]/branch/route";
import { GET as exportGET } from "../src/app/api/simulations/[id]/export/route";
import type { CreateSimulationInput, Simulation } from "../src/lib/types";
import { closeDatabase, database } from "../src/server/db";

let directory: string;
const origin = "http://localhost:3000";
const sourceContent =
  "Local shop owners requested a six-week trial and clear loading-zone access.";

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "branchlab-routes-"));
});
beforeEach(async () => {
  vi.stubEnv("TURSO_DATABASE_URL", `file:${join(directory, "test.db")}`);
  for (const key of [
    "VERCEL",
    "CF_PAGES",
    "WORKERS_CI",
    "APP_PASSWORD",
    "APP_ORIGIN",
    "OPENAI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "ENABLE_LOCAL_MODELS",
  ])
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

function input(): CreateSimulationInput {
  return {
    title: "A six-week street pilot",
    question:
      "How would local stakeholders respond to a car-free street pilot?",
    context:
      "Maintain delivery access and compare alternative implementations.",
    model: { provider: "demo", model: "branchlab-demo" },
    actorCount: 4,
    maxRounds: 2,
    seed: 42,
    sources: [{ name: "Community notes.md", content: sourceContent }],
  };
}

function req(
  path: string,
  cookie?: string,
  payload?: unknown,
  method = payload === undefined ? "GET" : "POST",
) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (method !== "GET") headers.set("origin", origin);
  if (payload !== undefined) headers.set("content-type", "application/json");
  return new Request(`${origin}${path}`, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

const context = (id: string) => ({ params: Promise.resolve({ id }) });

async function browser() {
  const response = await configGET(req("/api/config"));
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  expect(cookie).toMatch(/^branchlab_session=[a-f0-9]{64}$/);
  return cookie!;
}

async function create(cookie: string): Promise<Simulation> {
  const response = await runsPOST(req("/api/simulations", cookie, input()));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return (await response.json()).data;
}

describe("actual Next.js route contracts", () => {
  it.each([undefined, "", "   ", "X", "Untitled simulation"])(
    "accepts an optional simulation and branch title (%j)",
    async (title) => {
      const cookie = await browser();
      const response = await runsPOST(
        req("/api/simulations", cookie, { ...input(), title }),
      );
      expect(response.status).toBe(200);
      const run: Simulation = (await response.json()).data;
      expect(run.title).toBe(title?.trim() || "Untitled simulation");
      expect(run.titleSource).toBe(title?.trim() ? "user" : "default");
      expect(run.title).not.toBe(run.question);
      const listed = await runsGET(req("/api/simulations", cookie));
      expect((await listed.json()).data).toContainEqual(
        expect.objectContaining({
          id: run.id,
          title: run.title,
          titleSource: run.titleSource,
          question: run.question,
        }),
      );
      const branch = await branchPOST(
        req(`/api/simulations/${run.id}/branch`, cookie, {
          intervention: "Offer a community grant to support the pilot.",
          title,
        }),
        context(run.id),
      );
      expect(branch.status).toBe(200);
      expect((await branch.json()).data).toMatchObject({
        title: title?.trim() || `${run.title} · branch`,
        titleSource: title?.trim() ? "user" : "default",
      });
    },
  );

  it("still requires a scenario question and limits optional titles", async () => {
    const cookie = await browser();
    for (const payload of [
      { ...input(), title: undefined, question: "" },
      { ...input(), title: "x".repeat(101) },
    ]) {
      const response = await runsPOST(req("/api/simulations", cookie, payload));
      expect(response.status).toBe(400);
    }
  });

  it("provides configuration and health without exposing server secrets", async () => {
    vi.stubEnv("OPENAI_API_KEY", "unit-test-cloud-key-must-stay-private");
    const response = await configGET(req("/api/config"));
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toContain(
      "HttpOnly; SameSite=Strict",
    );
    const payload = await response.json();
    expect(payload.data).toMatchObject({
      authenticated: true,
      passwordRequired: false,
      liveEnabled: true,
      storage: "local",
    });
    expect(
      payload.data.providers.find(
        (provider: { id: string }) => provider.id === "openai",
      ).configured,
    ).toBe(true);
    expect(JSON.stringify(payload)).not.toContain(
      "unit-test-cloud-key-must-stay-private",
    );
    const health = await healthGET();
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(await health.json()).toEqual({
      data: { status: "ok", storage: "local", version: "0.3.0" },
    });
  });

  it("completes the demo REST lifecycle with typed responses and downloadable exports", async () => {
    const cookie = await browser();
    let run = await create(cookie);
    expect(run.sources[0]).toMatchObject({
      id: "source-1",
      content: sourceContent,
      hash: createHash("sha256").update(sourceContent).digest("hex"),
    });
    expect(run.world.actors).toHaveLength(4);
    const id = run.id;
    const routeContext = context(id);
    const listed = await runsGET(req("/api/simulations", cookie));
    expect((await listed.json()).data).toHaveLength(1);
    const loaded = await runGET(
      req(`/api/simulations/${id}`, cookie),
      routeContext,
    );
    expect((await loaded.json()).data).toEqual(run);

    const advanced = await stepPOST(
      req(`/api/simulations/${id}/step`, cookie, { expectedRound: 0 }),
      routeContext,
    );
    expect(advanced.status).toBe(200);
    run = (await advanced.json()).data;
    expect(run.rounds).toHaveLength(1);
    const duplicate = await stepPOST(
      req(`/api/simulations/${id}/step`, cookie, { expectedRound: 0 }),
      routeContext,
    );
    expect((await duplicate.json()).data).toEqual(run);

    const conversation = await chatPOST(
      req(`/api/simulations/${id}/chat`, cookie, {
        message: "What are your main concerns?",
        actorId: run.world.actors[0].id,
      }),
      routeContext,
    );
    expect(conversation.status).toBe(200);
    run = (await conversation.json()).data;
    expect(run.messages).toHaveLength(2);
    expect(run.messages[1]).toMatchObject({
      role: "assistant",
      actorId: run.world.actors[0].id,
      round: 1,
    });
    expect(run.messages[1].content).toContain("Deterministic demo");

    const report = await reportPOST(
      req(`/api/simulations/${id}/report`, cookie, {}),
      routeContext,
    );
    expect(report.status).toBe(200);
    run = (await report.json()).data;
    expect(run.report?.findings.length).toBeGreaterThan(0);
    expect(run.report?.answer).toBeTruthy();
    const refreshed = await reportPOST(
      req(`/api/simulations/${id}/report`, cookie, {
        refresh: true,
        expectedRound: 1,
      }),
      routeContext,
    );
    expect(refreshed.status).toBe(200);
    const updated: Simulation = (await refreshed.json()).data;
    expect(updated.version).toBe(run.version + 1);
    expect(updated.rounds).toEqual(run.rounds);
    run = updated;
    const staleReport = await reportPOST(
      req(`/api/simulations/${id}/report`, cookie, {
        refresh: true,
        expectedRound: 0,
      }),
      routeContext,
    );
    expect(staleReport.status).toBe(409);
    expect((await staleReport.json()).error.code).toBe("ROUND_MISMATCH");

    const jsonExport = await exportGET(
      req(`/api/simulations/${id}/export?format=json`, cookie),
      routeContext,
    );
    expect(jsonExport.status).toBe(200);
    expect(jsonExport.headers.get("content-disposition")).toBe(
      `attachment; filename="branchlab-${id}.json"`,
    );
    expect(jsonExport.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(jsonExport.headers.get("cache-control")).toBe("no-store");
    const exported = await jsonExport.json();
    expect(exported).toMatchObject(run);
    expect(exported.execution.operations.length).toBeGreaterThan(0);
    expect(exported).not.toHaveProperty("owner");
    expect(exported).not.toHaveProperty("session");
    expect(JSON.stringify(exported)).not.toContain(cookie.split("=")[1]);

    const markdownExport = await exportGET(
      req(`/api/simulations/${id}/export?format=markdown`, cookie),
      routeContext,
    );
    expect(markdownExport.headers.get("content-disposition")).toBe(
      `attachment; filename="branchlab-${id}.md"`,
    );
    expect(markdownExport.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    const markdown = await markdownExport.text();
    expect(markdown).toContain("# A six-week street pilot");
    expect(markdown).toContain(sourceContent);
    expect(markdown).toContain(run.rounds[0].events[0].id);
    expect(markdown).toContain("## Conversations");
    expect(markdown).toContain("### Scenario answer");
    expect(markdown).toContain(run.report!.answer);

    const deleted = await runDELETE(
      req(`/api/simulations/${id}`, cookie, undefined, "DELETE"),
      routeContext,
    );
    expect(await deleted.json()).toEqual({ data: { deleted: true } });
    const missing = await runGET(
      req(`/api/simulations/${id}`, cookie),
      routeContext,
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("NOT_FOUND");
  });

  it("enforces owner isolation at every run route, including downloads", async () => {
    const ownerCookie = await browser();
    const outsiderCookie = await browser();
    const run = await create(ownerCookie);
    const id = run.id;
    const routeContext = context(id);
    const listed = await runsGET(req("/api/simulations", outsiderCookie));
    expect((await listed.json()).data).toEqual([]);
    const responses = await Promise.all([
      runGET(req(`/api/simulations/${id}`, outsiderCookie), routeContext),
      exportGET(
        req(`/api/simulations/${id}/export`, outsiderCookie),
        routeContext,
      ),
      stepPOST(
        req(`/api/simulations/${id}/step`, outsiderCookie, {
          expectedRound: 0,
        }),
        routeContext,
      ),
      chatPOST(
        req(`/api/simulations/${id}/chat`, outsiderCookie, {
          message: "Show the source material.",
        }),
        routeContext,
      ),
      reportPOST(
        req(`/api/simulations/${id}/report`, outsiderCookie, {}),
        routeContext,
      ),
      branchPOST(
        req(`/api/simulations/${id}/branch`, outsiderCookie, {
          intervention: "Subsidize the entire pilot for residents.",
        }),
        routeContext,
      ),
      runDELETE(
        req(`/api/simulations/${id}`, outsiderCookie, undefined, "DELETE"),
        routeContext,
      ),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const payload = await response.json();
      expect(payload.error.code).toBe("NOT_FOUND");
      expect(JSON.stringify(payload)).not.toContain(sourceContent);
    }
    const unchanged = await runGET(
      req(`/api/simulations/${id}`, ownerCookie),
      routeContext,
    );
    expect((await unchanged.json()).data).toEqual(run);
  });

  it("protects the instance until a session logs in and locks it again on logout", async () => {
    vi.stubEnv("APP_PASSWORD", "unit-test-instance-password");
    const cookie = await browser();
    const denied = await runsPOST(req("/api/simulations", cookie, input()));
    expect(denied.status).toBe(401);
    expect((await denied.json()).error.code).toBe("AUTH_REQUIRED");
    const wrong = await sessionPOST(
      req("/api/session", cookie, { password: "incorrect-unit-test-password" }),
    );
    expect(wrong.status).toBe(401);
    expect(JSON.stringify(await wrong.json())).not.toContain(
      "incorrect-unit-test-password",
    );
    const accepted = await sessionPOST(
      req("/api/session", cookie, { password: "unit-test-instance-password" }),
    );
    expect(await accepted.json()).toEqual({ data: { authenticated: true } });
    await create(cookie);
    const logout = await sessionDELETE(
      req("/api/session", cookie, undefined, "DELETE"),
    );
    expect(await logout.json()).toEqual({ data: { authenticated: false } });
    const relocked = await runsGET(req("/api/simulations", cookie));
    expect(relocked.status).toBe(401);
  });

  it("rejects invalid schema fields and never accepts browser credentials or URLs", async () => {
    const cookie = await browser();
    const suppliedSecret = "browser-supplied-secret-must-not-echo";
    const withKey = await runsPOST(
      req("/api/simulations", cookie, { ...input(), apiKey: suppliedSecret }),
    );
    expect(withKey.status).toBe(400);
    const withKeyPayload = await withKey.json();
    expect(withKeyPayload.error.code).toBe("INVALID_INPUT");
    expect(JSON.stringify(withKeyPayload)).not.toContain(suppliedSecret);
    const withURL = await runsPOST(
      req("/api/simulations", cookie, {
        ...input(),
        model: {
          provider: "ollama",
          model: "qwen3:8b",
          baseURL: "http://169.254.169.254/v1",
        },
      }),
    );
    expect(withURL.status).toBe(400);
    expect((await withURL.json()).error.code).toBe("INVALID_INPUT");
    const invalidPopulation = await runsPOST(
      req("/api/simulations", cookie, { ...input(), actorCount: 999 }),
    );
    expect(invalidPopulation.status).toBe(400);
    const listed = await runsGET(req("/api/simulations", cookie));
    expect((await listed.json()).data).toEqual([]);
  });

  it("reports provider configuration errors without attempting inference", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Network must not be called in this test"));
    const cookie = await browser();
    const missingKey = await runsPOST(
      req("/api/simulations", cookie, {
        ...input(),
        model: { provider: "openai", model: "gpt-6-luna" },
      }),
    );
    expect(missingKey.status).toBe(400);
    expect((await missingKey.json()).error.code).toBe(
      "PROVIDER_NOT_CONFIGURED",
    );
    vi.stubEnv("OPENAI_API_KEY", "unit-test-fake-key");
    const invalidCloud = await runsPOST(
      req("/api/simulations", cookie, {
        ...input(),
        model: { provider: "openai", model: "unsupported-model" },
      }),
    );
    expect(invalidCloud.status).toBe(400);
    expect((await invalidCloud.json()).error.code).toBe("INVALID_MODEL");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("enforces actual route JSON media types, parsing and byte bounds", async () => {
    const cookie = await browser();
    const rawRequest = (value: string, contentType: string) =>
      new Request(`${origin}/api/simulations`, {
        method: "POST",
        headers: { cookie, origin, "content-type": contentType },
        body: value,
      });
    const wrongType = await runsPOST(
      rawRequest(JSON.stringify(input()), "text/plain; note=application/json"),
    );
    expect(wrongType.status).toBe(415);
    expect((await wrongType.json()).error.code).toBe("CONTENT_TYPE");
    const malformed = await runsPOST(
      rawRequest('{"question":', "application/json"),
    );
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.code).toBe("INVALID_JSON");
    const oversized = await runsPOST(
      rawRequest(
        JSON.stringify({ ...input(), context: "x".repeat(256_001) }),
        "application/json",
      ),
    );
    expect(oversized.status).toBe(413);
    expect((await oversized.json()).error.code).toBe("BODY_TOO_LARGE");
  });

  it("returns safe errors for unsupported export formats and malformed step contracts", async () => {
    const cookie = await browser();
    const run = await create(cookie);
    const routeContext = context(run.id);
    const invalidExport = await exportGET(
      req(`/api/simulations/${run.id}/export?format=html`, cookie),
      routeContext,
    );
    expect(invalidExport.status).toBe(400);
    expect((await invalidExport.json()).error.code).toBe("INVALID_FORMAT");
    const invalidStep = await stepPOST(
      req(`/api/simulations/${run.id}/step`, cookie, { expectedRound: "zero" }),
      routeContext,
    );
    expect(invalidStep.status).toBe(400);
    expect((await invalidStep.json()).error.code).toBe("INVALID_INPUT");
    const invalidReport = await reportPOST(
      req(`/api/simulations/${run.id}/report`, cookie, { invented: true }),
      routeContext,
    );
    expect(invalidReport.status).toBe(400);
    const noRounds = await reportPOST(
      req(`/api/simulations/${run.id}/report`, cookie, {}),
      routeContext,
    );
    expect(noRounds.status).toBe(400);
    expect((await noRounds.json()).error.code).toBe("NO_ROUNDS");
  });
});
