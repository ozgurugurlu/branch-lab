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
import { POST as login } from "../src/app/api/session/route";
import { EngineError } from "../src/mastra/errors";
import { closeDatabase, database } from "../src/server/db";
import { databaseError } from "../src/server/database-errors";
import { AppError, publicError } from "../src/server/errors";
import { api, body, withDeadline } from "../src/server/http";
import { ModelConfigurationError } from "../src/server/models";
import {
  assertOrigin,
  checkPassword,
  clearSessionCookie,
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
    "DATABASE_URL",
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
      "DELETE FROM operations",
      "DELETE FROM revoked_sessions",
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
        requestId: expect.any(String),
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
        path: "/api/unknown",
        requestId: payload.error.requestId,
      }),
    );
  });

  it("returns an actionable database error without logging driver details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const sensitive = "private-database-credential-and-row";
    const response = await api(request(), async () => {
      throw databaseError(
        Object.assign(new Error(sensitive), {
          code: "42703",
          detail: sensitive,
          query: sensitive,
        }),
      );
    });
    expect(response.status).toBe(503);
    const payload = await response.json();
    expect(payload.error).toMatchObject({
      code: "DATABASE_SCHEMA",
      retryable: false,
    });
    expect(payload.error.message).toContain("DATABASE_SCHEMA=branchlab");
    expect(payload.error.message).not.toContain("last saved");
    expect(JSON.stringify(payload)).not.toContain(sensitive);
    expect(JSON.stringify(log.mock.calls)).not.toContain(sensitive);
    expect(response.headers.get("X-Request-ID")).toBe(payload.error.requestId);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: "api_failure",
        code: "DATABASE_SCHEMA",
        path: "/api/unknown",
        requestId: payload.error.requestId,
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

describe("security hardening regressions", () => {
  it("pins an explicit application origin instead of also trusting a supplied Host", () => {
    vi.stubEnv("APP_ORIGIN", "https://branchlab.example/");
    expect(() =>
      assertOrigin(request({ origin: "https://branchlab.example" })),
    ).not.toThrow();
    expect(() =>
      assertOrigin(
        request({
          host: "untrusted.example",
          origin: "http://untrusted.example",
        }),
      ),
    ).toThrow(AppError);
    expect(() => assertOrigin(request({ origin: "null" }))).toThrow(AppError);
    vi.stubEnv("APP_ORIGIN", "https://username:private@branchlab.example/path");
    expect(() => assertOrigin(request())).toThrow("Set APP_ORIGIN");
  });

  it("returns session expiry and permits the workspace purge handler to clear a new cookie", async () => {
    const session = await getSession(request());
    expect(session.expiresAt).toBeGreaterThan(Date.now());
    expect((await getSession(request(cookie(session.id)))).expiresAt).toBe(
      session.expiresAt,
    );
    const response = await api(request(), async () =>
      Response.json(
        { data: { deleted: true } },
        { headers: { "Set-Cookie": clearSessionCookie(request()) } },
      ),
    );
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("set-cookie")).not.toContain(session.id);
    expect(
      clearSessionCookie(
        new Request("https://branchlab.example/api/workspace"),
      ),
    ).toContain("; Secure");
  });

  it("returns a server-generated correlation ID and protects success, error, and attachment responses", async () => {
    const success = await api(
      request({ "x-request-id": "private-caller-value" }),
      async () =>
        Response.json(
          { data: true },
          {
            headers: {
              "content-disposition": "attachment; filename=test.json",
            },
          },
        ),
    );
    const error = await api(request(), async () => {
      throw new AppError("INVALID_INPUT", "Check the input.");
    });
    for (const response of [success, error]) {
      expect(response.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/);
      expect(response.headers.get("x-request-id")).not.toContain("private");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("vary")).toContain("Cookie");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toContain(
        "default-src 'none'",
      );
      expect(response.headers.get("cross-origin-resource-policy")).toBe(
        "same-origin",
      );
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
    expect((await error.json()).error.requestId).toBe(
      error.headers.get("x-request-id"),
    );
    expect(success.headers.get("content-disposition")).toContain("attachment");
  });

  it("does not echo private property names or log user-controlled paths", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const invalid = await api(request(), async () =>
      z
        .object({ count: z.number() })
        .strict()
        .parse({ count: 1, "private-document-secret": true }),
    );
    expect(JSON.stringify(await invalid.json())).not.toContain(
      "private-document-secret",
    );
    const response = await api(
      new Request(
        "http://localhost/api/simulations/private-document-secret/chat?secret=private-query",
      ),
      async () => {
        throw new Error("private-provider-secret");
      },
    );
    const logged = JSON.parse(String(log.mock.calls[0][0]));
    expect(logged.path).toBe("/api/simulations/:id/chat");
    expect(logged.requestId).toBe(response.headers.get("x-request-id"));
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-");
  });

  it("preserves typed engine errors without trusting similarly named arbitrary errors", async () => {
    const response = await api(request(), async () => {
      throw new EngineError("MODEL_RATE_LIMIT");
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      error: { code: "MODEL_RATE_LIMIT", retryAfterSeconds: 60 },
    });
    const forged = Object.assign(new Error("private-upstream-details"), {
      name: "EngineError",
      code: "MODEL_FAILED",
      status: 502,
    });
    expect(publicError(forged).code).toBe("OPERATION_FAILED");
    expect(publicError(forged).message).not.toContain("private-upstream");
  });

  it("reports the persisted budget reset time and rejects invalid reservations", async () => {
    await consumeLimit("test:long-window", 1, 15 * 60_000);
    const response = await api(request(), async () =>
      consumeLimit("test:long-window", 1, 15 * 60_000),
    );
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(895);
    const payload = await response.json();
    expect(payload.error.retryAfterSeconds).toBe(
      Number(response.headers.get("retry-after")),
    );
    for (const amount of [0, -1, NaN, Infinity, 0.5]) {
      await expect(
        consumeLimit("invalid", 5, 60_000, amount),
      ).rejects.toMatchObject({ code: "LIMIT_CONFIGURATION" });
    }
  });

  it("limits password guessing globally even when the attacker resets the session cookie", async () => {
    vi.stubEnv("APP_PASSWORD", "private-correct-password");
    const req = () =>
      new Request("http://localhost:3000/api/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({ password: "private-wrong-password" }),
      });
    await consumeLimit("login:global", 100, 15 * 60_000, 99);
    const failed = await login(req());
    expect(failed.status).toBe(401);
    expect(JSON.stringify(await failed.json())).not.toContain("private-");
    const limited = await login(req());
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(895);
    expect(failed.headers.get("set-cookie")).not.toBe(
      limited.headers.get("set-cookie"),
    );
    const sessions = await (
      await database()
    ).execute("SELECT authenticated FROM sessions");
    expect(sessions.rows.every((row) => Number(row.authenticated) === 0)).toBe(
      true,
    );
  });

  it("rejects compressed bodies, invalid Content-Length, and malformed UTF-8", async () => {
    const invalidHeaders: Record<string, string>[] = [
      { "content-encoding": "gzip" },
      { "content-length": "-1" },
      { "content-length": "NaN" },
    ];
    for (const headers of invalidHeaders) {
      const req = new Request("http://localhost/api/test", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: "{}",
      });
      await expect(body(req, z.unknown())).rejects.toBeInstanceOf(AppError);
    }
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array([123, 34, 97, 34, 58, 34, 255, 34, 125]),
    });
    await expect(body(req, z.unknown())).rejects.toMatchObject({
      code: "INVALID_JSON",
    });
  });

  it("cancels a stalled body within 30 seconds and releases its stream reader", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    const assertion = expect(body(req, z.unknown())).rejects.toMatchObject({
      code: "BODY_TIMEOUT",
      status: 408,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops body reads and uncooperative operation waits immediately when the client cancels", async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>();
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: stream,
      duplex: "half",
    } as RequestInit);
    const reading = expect(body(req, z.unknown())).rejects.toMatchObject({
      code: "REQUEST_CANCELLED",
      status: 499,
    });
    const running = expect(
      withDeadline(req, () => new Promise<never>(() => {})),
    ).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(new Error("private-abort-detail"));
    await Promise.all([reading, running]);
    expect(stream.locked).toBe(false);
  });
});

describe("workspace lock fencing", () => {
  it("revokes only the locked owner's leases and active operation tokens before unlock", async () => {
    vi.stubEnv("APP_PASSWORD", "unit-test-password");
    const owner = await getSession(request());
    const other = await getSession(request());
    await setAuthenticated(owner.id, true);
    const db = await database();
    for (const [id, identity] of [
      ["owner", owner.id],
      ["other", other.id],
    ]) {
      await db.batch(
        [
          {
            sql: "INSERT INTO simulations (id, owner, title, created_at, updated_at, version, data, lease_token, lease_expires) VALUES (?, ?, 'Fixture', 'now', 'now', 1, '{}', ?, ?)",
            args: [id, identity, `${id}-lease`, Date.now() + 200_000],
          },
          {
            sql: "INSERT INTO operations (id, owner, simulation_id, kind, status, started_at, expires_at, token, engine_version, prompt_version, request_hash, request_key) VALUES (?, ?, ?, 'round', 'running', 'now', ?, ?, 'test', 'test', 'hash', ?)",
            args: [
              `${id}-operation`,
              identity,
              id,
              Date.now() + 200_000,
              `${id}-operation-token`,
              `${id}-request`,
            ],
          },
        ],
        "write",
      );
    }
    await setAuthenticated(owner.id, false);
    expect((await getSession(request(cookie(owner.id)))).authenticated).toBe(
      false,
    );
    await setAuthenticated(owner.id, true);
    const runs = await db.execute(
      "SELECT id, lease_token, lease_expires FROM simulations ORDER BY id",
    );
    expect(runs.rows.find((row) => row.id === "owner")).toMatchObject({
      lease_token: null,
      lease_expires: 0,
    });
    expect(runs.rows.find((row) => row.id === "other")?.lease_token).toBe(
      "other-lease",
    );
    const operations = await db.execute(
      "SELECT id, status, error_code, finished_at FROM operations ORDER BY id",
    );
    expect(
      operations.rows.find((row) => row.id === "owner-operation"),
    ).toMatchObject({ status: "interrupted", error_code: "SESSION_LOCKED" });
    expect(
      operations.rows.find((row) => row.id === "owner-operation")?.finished_at,
    ).toBeTruthy();
    expect(
      operations.rows.find((row) => row.id === "other-operation"),
    ).toMatchObject({ status: "running", error_code: null });
  });
});
