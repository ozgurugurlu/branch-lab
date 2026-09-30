import { describe, expect, it } from "vitest";
import { classifyEngineError, EngineError } from "@/mastra/errors";

describe("safe agent error boundary", () => {
  it.each([
    [401, "MODEL_AUTHENTICATION", false],
    [403, "MODEL_AUTHENTICATION", false],
    [429, "MODEL_RATE_LIMIT", true],
    [503, "MODEL_UNAVAILABLE", true],
    [504, "MODEL_TIMEOUT", true],
  ])(
    "classifies nested provider status %i without retaining secret error context",
    (status, code, retryable) => {
      const upstream = Object.assign(new Error("SECRET_PROVIDER_MESSAGE"), {
        statusCode: status,
        responseBody: "SECRET_RESPONSE_BODY",
        requestBodyValues: { apiKey: "SECRET_API_KEY" },
      });
      const classified = classifyEngineError(
        new Error("SECRET_WRAPPER", { cause: upstream }),
      );
      expect(classified).toMatchObject({ code, retryable });
      expect(classified.cause).toBeUndefined();
      expect(`${classified.stack} ${JSON.stringify(classified)}`).not.toContain(
        "SECRET_",
      );
    },
  );

  it("bounds cyclic provider cause traversal and never trusts messages containing forged status codes", () => {
    const error = new Error("401 429 SECRET_FAKE_STATUS");
    error.cause = error;
    expect(classifyEngineError(error)).toMatchObject({ code: "MODEL_FAILED" });
  });

  it("keeps timeout, caller cancellation and sibling-failure cancellation distinct", () => {
    const deadline = new AbortController();
    deadline.abort(new DOMException("SECRET_TIMEOUT_REASON", "TimeoutError"));
    expect(
      classifyEngineError(new Error("upstream"), deadline.signal),
    ).toMatchObject({ code: "MODEL_TIMEOUT" });
    const caller = new AbortController();
    caller.abort();
    expect(
      classifyEngineError(new Error("upstream"), caller.signal),
    ).toMatchObject({ code: "MODEL_CANCELLED" });
    const sibling = new AbortController();
    const failure = new EngineError("MODEL_RATE_LIMIT");
    sibling.abort(failure);
    expect(classifyEngineError(new Error("abort"), sibling.signal)).toBe(
      failure,
    );
  });
});
