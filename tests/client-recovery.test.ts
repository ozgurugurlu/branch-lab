import { describe, expect, it } from "vitest";
import { recoveryHint, RequestError } from "../src/components/client-api";

describe("context-aware workspace recovery", () => {
  it.each([
    ["DATABASE_SCHEMA", "schema and migrations"],
    ["DATABASE_PERMISSION", "schema and table permissions"],
    ["DATABASE_CONFIGURATION", "database configuration"],
    ["DATABASE_AUTHENTICATION", "database credentials"],
    ["DATABASE_TLS", "TLS settings and certificate"],
    ["DATABASE_UNAVAILABLE", "database connection"],
  ])(
    "treats %s as database setup, even during a simulation",
    (code, detail) => {
      const error = new RequestError(code, "Database setup failed", 500, true);
      for (const context of ["workspace", "draft", "simulation"] as const) {
        const hint = recoveryHint(error, context);
        expect(hint).toContain(detail);
        expect(hint).toContain("reload the workspace");
        expect(hint).not.toMatch(/saved checkpoint|model charges|Unlock/);
      }
    },
  );

  it.each([
    "OPERATION_FAILED",
    "NETWORK_UNAVAILABLE",
    "INVALID_RESPONSE",
    "TIMEOUT",
  ])(
    "does not claim saved progress or a paid action when startup fails with %s",
    (code) => {
      const hint = recoveryHint(
        new RequestError(code, "Startup failed", 503, true),
        "workspace",
      );
      expect(hint).toContain("server setup");
      expect(hint).toContain("reload the workspace");
      expect(hint).not.toMatch(
        /checkpoint|draft|model charges|may have finished/,
      );
    },
  );

  it("distinguishes database authentication from browser workspace authentication", () => {
    const database = new RequestError(
      "DATABASE_AUTHENTICATION",
      "Database rejected credentials",
      401,
    );
    expect(recoveryHint(database, "workspace")).toContain(
      "database credentials",
    );
    const workspace = new RequestError("UNAUTHORIZED", "Unlock required", 401);
    expect(recoveryHint(workspace, "workspace")).toBe(
      "Unlock the workspace to continue.",
    );
    expect(recoveryHint(workspace, "draft")).toContain("Your draft stays");
  });

  it("retains draft and checkpoint recovery for submitted work", () => {
    const error = new RequestError(
      "OPERATION_FAILED",
      "Could not finish",
      500,
      true,
    );
    expect(recoveryHint(error, "draft")).toContain("Your draft stays");
    expect(recoveryHint(error, "draft")).not.toContain("checkpoint");
    expect(recoveryHint(error)).toContain(
      "Your last saved checkpoint remains available",
    );
    expect(
      recoveryHint(
        new RequestError("NETWORK_UNAVAILABLE", "Connection lost"),
        "simulation",
      ),
    ).toContain("model charges");
  });

  it("preserves explicit throttling guidance before a workspace reload", () => {
    const error = new RequestError("RATE_LIMIT", "Slow down", 429, true, 45);
    expect(recoveryHint(error, "workspace")).toBe(
      "Wait at least 45 seconds before trying again.",
    );
  });
});
