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
import { z } from "zod";
import { closeDatabase, database } from "../src/server/db";
import { AppError, publicError } from "../src/server/errors";
import { api, body, withDeadline } from "../src/server/http";
import { ModelConfigurationError } from "../src/server/models";
import {
  assertOrigin,
  checkPassword,
  consumeLimit,
  getSession,
  liveEnabled,
  reserveModelCalls,
  setAuthenticated,
} from "../src/server/security";

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "branchlab-http-"));
});
beforeEach(async () => {
  vi.stubEnv("TURSO_DATABASE_URL", `file:${join(directory, "test.db")}`);
  for (const key of [
    "VERCEL",
    "CF_PAGES",
    "WORKERS_CI",
    "APP_PASSWORD",
    "APP_ORIGIN",
    "DAILY_MODEL_CALL_LIMIT",
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await closeDatabase();
  await rm(directory, { recursive: true, force: true });
});

const request = (headers: HeadersInit = {}) =>
  new Request("http://localhost:3000/api/test", { headers });
const cookie = (id: string) => ({ cookie: `branchlab_session=${id}` });

describe("session identity and authentication", () => {
  it("creates an opaque HttpOnly session and reuses only a valid persisted token", async () => {
    const first = await getSession(request());
    expect(first.id).toMatch(/^[a-f0-9]{64}$/);
    expect(first.authenticated).toBe(true);
    expect(first.cookie).toContain("HttpOnly; SameSite=Strict");
    const second = await getSession(request(cookie(first.id)));
    expect(second.id).toBe(first.id);
    expect(second.cookie).toBeUndefined();
    const forged = await getSession(request(cookie("f".repeat(64))));
    expect(forged.id).not.toBe("f".repeat(64));
    const malformed = await getSession(request(cookie("../another-session")));
    expect(malformed.id).not.toBe(first.id);
  });

  it("requires the password, supports logout and invalidates authentication after rotation", async () => {
    vi.stubEnv("APP_PASSWORD", "first-workspace-password");
    const session = await getSession(request());
    expect(session.authenticated).toBe(false);
    expect(checkPassword("wrong-password")).toBe(false);
    expect(checkPassword("first-workspace-password")).toBe(true);
    await setAuthenticated(session.id, true);
    expect((await getSession(request(cookie(session.id)))).authenticated).toBe(
      true,
    );
    vi.stubEnv("APP_PASSWORD", "rotated-workspace-password");
    expect((await getSession(request(cookie(session.id)))).authenticated).toBe(
      false,
    );
    await setAuthenticated(session.id, true);
    await setAuthenticated(session.id, false);
    expect((await getSession(request(cookie(session.id)))).authenticated).toBe(
      false,
    );
  });

  it("expires session identity instead of reviving its authentication", async () => {
    vi.stubEnv("APP_PASSWORD", "unit-test-password");
    const previous = await getSession(request());
    await setAuthenticated(previous.id, true);
    await (
      await database()
    ).execute({
      sql: "UPDATE sessions SET expires_at = ? WHERE id = ?",
      args: [Date.now() - 1, previous.id],
    });
    const next = await getSession(request(cookie(previous.id)));
    expect(next.id).not.toBe(previous.id);
    expect(next.authenticated).toBe(false);
  });

  it("sets Secure cookies for HTTPS and hosted requests", async () => {
    const https = await getSession(
      new Request("https://branchlab.example/api/config"),
    );
    expect(https.cookie).toContain("; Secure");
    vi.stubEnv("VERCEL", "1");
    expect((await getSession(request())).cookie).toContain("; Secure");
  });
});

describe("shared SQL request budgets", () => {
  it("admits exactly the budget under concurrent calls and counts rejected attempts", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        consumeLimit("test:concurrent", 7, 60_000),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(7);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(13);
    expect(
      rejected.every(
        (result) =>
          result.status === "rejected" && result.reason.code === "RATE_LIMIT",
      ),
    ).toBe(true);
    const saved = await (
      await database()
    ).execute({
      sql: "SELECT count FROM rate_limits WHERE key = ?",
      args: ["test:concurrent"],
    });
    expect(Number(saved.rows[0].count)).toBe(20);
  });

  it("accounts for call reservations and resets an expired window", async () => {
    await consumeLimit("test:amount", 5, 60_000, 3);
    await expect(
      consumeLimit("test:amount", 5, 60_000, 3),
    ).rejects.toMatchObject({ code: "RATE_LIMIT" });
    await (
      await database()
    ).execute({
      sql: "UPDATE rate_limits SET resets_at = ? WHERE key = ?",
      args: [Date.now() - 1, "test:amount"],
    });
    await expect(
      consumeLimit("test:amount", 5, 60_000, 5),
    ).resolves.toBeUndefined();
  });

  it("requires a hosted password before reserving live model calls", async () => {
    vi.stubEnv("VERCEL", "1");
    expect(liveEnabled()).toBe(false);
    await expect(reserveModelCalls("owner", 1)).rejects.toMatchObject({
      code: "LIVE_DISABLED",
      status: 403,
    });
    vi.stubEnv("APP_PASSWORD", "unit-test-password");
    vi.stubEnv("DAILY_MODEL_CALL_LIMIT", "2");
    expect(liveEnabled()).toBe(true);
    await reserveModelCalls("owner", 2);
    await expect(reserveModelCalls("different-owner", 1)).rejects.toMatchObject(
      { code: "RATE_LIMIT" },
    );
  });
});

describe("request origin and body boundaries", () => {
  it("uses the browser destination host when Next normalizes its internal bind URL", () => {
    expect(() =>
      assertOrigin(
        new Request("http://0.0.0.0:3100/api/test", {
          headers: { host: "127.0.0.1:3100", origin: "http://127.0.0.1:3100" },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertOrigin(
        new Request("http://0.0.0.0:3100/api/test", {
          headers: {
            host: "127.0.0.1:3100",
            origin: "https://untrusted.example",
            "x-forwarded-host": "untrusted.example",
          },
        }),
      ),
    ).toThrow(AppError);
  });
  it("permits same-origin and configured proxy origins, but rejects cross-site requests", () => {
    expect(() =>
      assertOrigin(request({ origin: "http://localhost:3000" })),
    ).not.toThrow();
    expect(() => assertOrigin(request())).not.toThrow();
    vi.stubEnv("APP_ORIGIN", "https://branchlab.example");
    expect(() =>
      assertOrigin(request({ origin: "https://branchlab.example" })),
    ).not.toThrow();
    expect(() =>
      assertOrigin(request({ origin: "https://untrusted.example" })),
    ).toThrow(AppError);
    expect(() =>
      assertOrigin(
        request({
          origin: "http://localhost:3000",
          "sec-fetch-site": "cross-site",
        }),
      ),
    ).toThrow("Cross-site");
  });

  it("parses valid JSON through its schema and rejects missing/invalid JSON", async () => {
    const schema = z.object({ count: z.number().int().min(1) }).strict();
    const jsonRequest = (value: string) =>
      new Request("http://localhost/api/test", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: value,
      });
    await expect(body(jsonRequest('{"count":2}'), schema)).resolves.toEqual({
      count: 2,
    });
    await expect(
      body(jsonRequest('{"count":0}'), schema),
    ).rejects.toBeInstanceOf(z.ZodError);
    await expect(
      body(jsonRequest("{broken json}"), schema),
    ).rejects.toMatchObject({ code: "INVALID_JSON" });
    await expect(
      body(
        new Request("http://localhost/api/test", {
          method: "POST",
          headers: { "content-type": "application/json" },
        }),
        schema,
      ),
    ).rejects.toMatchObject({ code: "INVALID_JSON" });
    await expect(
      body(
        new Request("http://localhost/api/test", {
          method: "POST",
          body: "{}",
        }),
        schema,
      ),
    ).rejects.toMatchObject({ code: "CONTENT_TYPE", status: 415 });
    await expect(
      body(
        new Request("http://localhost/api/test", {
          method: "POST",
          headers: { "content-type": "text/plain; note=application/json" },
          body: "{}",
        }),
        schema,
      ),
    ).rejects.toMatchObject({ code: "CONTENT_TYPE", status: 415 });
  });

  it("checks declared and actual byte limits even when Content-Length lies", async () => {
    const oversizedHeader = new Request("http://localhost/api/test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "256001",
      },
      body: "{}",
    });
    await expect(body(oversizedHeader, z.unknown())).rejects.toMatchObject({
      code: "BODY_TOO_LARGE",
      status: 413,
    });
    const oversizedBody = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "2" },
      body: JSON.stringify({ text: "é".repeat(128_000) }),
    });
    await expect(body(oversizedBody, z.unknown())).rejects.toMatchObject({
      code: "BODY_TOO_LARGE",
      status: 413,
    });
  });
});

describe("API responses and error privacy", () => {
  it("returns consistent envelopes, no-store and the new session cookie", async () => {
    const response = await api(request(), async ({ owner }) => ({
      owner,
      ok: true,
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toContain("branchlab_session=");
    const payload = await response.json();
    expect(payload.data.ok).toBe(true);
    expect(payload.data.owner).toMatch(/^[a-f0-9]{64}$/);
  });

  it("blocks a locked workspace before invoking its handler", async () => {
    vi.stubEnv("APP_PASSWORD", "unit-test-password");
    const handler = vi.fn(async () => "private simulation");
    const response = await api(request(), handler);
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      error: {
        code: "AUTH_REQUIRED",
        message: "Unlock this workspace in Settings to continue.",
        retryable: false,
      },
    });
    const publicResponse = await api(request(), handler, { public: true });
    expect(publicResponse.status).toBe(200);
  });

  it("rejects a cross-site mutation before executing its handler", async () => {
    const handler = vi.fn(async () => ({ changed: true }));
    const response = await api(
      request({ origin: "https://untrusted.example" }),
      handler,
      { mutation: true },
    );
    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("redacts provider internals from public errors and logs", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const sensitive = "unit-test-secret-in-provider-error";
    const response = await api(request(), async () => {
      throw Object.assign(new Error(`Upstream failed with ${sensitive}`), {
        requestBody: { apiKey: sensitive, sources: "private evidence" },
      });
    });
    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload.error.code).toBe("OPERATION_FAILED");
    expect(JSON.stringify(payload)).not.toContain(sensitive);
    expect(JSON.stringify(log.mock.calls)).not.toContain(sensitive);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: "api_failure",
        code: "OPERATION_FAILED",
        path: "/api/test",
      }),
    );
  });

  it("preserves safe configuration errors, maps aborts, and marks retryable limits", async () => {
    const configuration = new ModelConfigurationError(
      "Set OPENAI_API_KEY on the server.",
    );
    expect(publicError(configuration)).toBe(configuration);
    const response = await api(request(), async () => {
      throw configuration;
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("MODEL_CONFIGURATION");
    expect(
      publicError(
        new DOMException(
          "sensitive provider cancellation detail",
          "AbortError",
        ),
      ),
    ).toMatchObject({ code: "TIMEOUT", status: 504, retryable: true });
    const limited = await api(request(), async () => {
      throw new AppError("RATE_LIMIT", "Budget reached.", 429, true);
    });
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await limited.json()).error.retryable).toBe(true);
  });

  it("returns bounded schema errors as a 400 response", async () => {
    const response = await api(request(), async () =>
      z.object({ count: z.number().int().min(1) }).parse({ count: -1 }),
    );
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("INVALID_INPUT");
    expect(payload.error.message).toContain("count:");
    expect(payload.error.message.length).toBeLessThanOrEqual(600);
  });
});

describe("operation cancellation", () => {
  it("forwards an already aborted request to the operation", async () => {
    const controller = new AbortController();
    controller.abort();
    const req = new Request("http://localhost/api/test", {
      signal: controller.signal,
    });
    await expect(
      withDeadline(req, async (signal) => {
        signal.throwIfAborted();
        return "unreachable";
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts and rejects stalled operations at the deadline", async () => {
    vi.useFakeTimers();
    let operationSignal: AbortSignal | undefined;
    const operation = withDeadline(request(), (signal) => {
      operationSignal = signal;
      return new Promise<never>(() => {});
    });
    const assertion = expect(operation).rejects.toMatchObject({
      code: "TIMEOUT",
      status: 504,
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(180_000);
    await assertion;
    expect(operationSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
