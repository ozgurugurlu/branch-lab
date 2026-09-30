export type EngineErrorCode =
  | "MODEL_TIMEOUT"
  | "MODEL_CANCELLED"
  | "MODEL_RATE_LIMIT"
  | "MODEL_AUTHENTICATION"
  | "MODEL_UNAVAILABLE"
  | "MODEL_OUTPUT_INVALID"
  | "MODEL_CONTEXT_LIMIT"
  | "MODEL_CAPABILITY_UNSUPPORTED"
  | "MODEL_FAILED";

const descriptions: Record<
  EngineErrorCode,
  { message: string; status: number; retryable: boolean }
> = {
  MODEL_TIMEOUT: {
    message:
      "The model exceeded its response deadline. The last completed checkpoint is unchanged; retry or choose a faster model.",
    status: 504,
    retryable: true,
  },
  MODEL_CANCELLED: {
    message:
      "The model operation was cancelled. The last completed checkpoint is unchanged.",
    status: 499,
    retryable: true,
  },
  MODEL_RATE_LIMIT: {
    message:
      "The model provider reached a request or quota limit. Wait before retrying or choose another configured model.",
    status: 429,
    retryable: true,
  },
  MODEL_AUTHENTICATION: {
    message:
      "The model provider rejected authentication or access. Check its server-side credential and model permissions.",
    status: 502,
    retryable: false,
  },
  MODEL_UNAVAILABLE: {
    message:
      "The model provider is unavailable. The last completed checkpoint is unchanged; try again later.",
    status: 503,
    retryable: true,
  },
  MODEL_OUTPUT_INVALID: {
    message:
      "The model returned incomplete, invalid, or inaccessible simulation evidence. No proposed changes were saved; retry or choose another model.",
    status: 502,
    retryable: true,
  },
  MODEL_CONTEXT_LIMIT: {
    message:
      "This operation exceeds the model context budget. Start a smaller scenario with shorter context, interventions, or documents.",
    status: 413,
    retryable: false,
  },
  MODEL_CAPABILITY_UNSUPPORTED: {
    message:
      "This model did not execute the required scoped tool call. Choose a model with tool-calling support; no simulation changes were saved.",
    status: 502,
    retryable: false,
  },
  MODEL_FAILED: {
    message:
      "The model operation failed. Check the configured model and provider, then retry; the last completed checkpoint is unchanged.",
    status: 502,
    retryable: true,
  },
};

/** Only fixed public-safe fields survive this boundary; no provider message, body, URL, or cause. */
export class EngineError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(readonly code: EngineErrorCode) {
    super(descriptions[code].message);
    this.name = "EngineError";
    this.status = descriptions[code].status;
    this.retryable = descriptions[code].retryable;
  }
}

export function classifyEngineError(
  error: unknown,
  signal?: AbortSignal,
): EngineError {
  if (error instanceof EngineError) return error;
  if (signal?.aborted) {
    if (signal.reason instanceof EngineError) return signal.reason;
    return new EngineError(
      signal.reason?.name === "TimeoutError"
        ? "MODEL_TIMEOUT"
        : "MODEL_CANCELLED",
    );
  }
  let current = error;
  const visited = new Set<unknown>();
  for (
    let depth = 0;
    depth < 5 &&
    current &&
    typeof current === "object" &&
    !visited.has(current);
    depth++
  ) {
    visited.add(current);
    if (current instanceof EngineError) return current;
    const record = current as {
      name?: unknown;
      statusCode?: unknown;
      status?: unknown;
      cause?: unknown;
    };
    const name = typeof record.name === "string" ? record.name : "";
    const status =
      typeof record.statusCode === "number" ? record.statusCode : record.status;
    if (name === "TimeoutError" || name === "MastraTimeoutError")
      return new EngineError("MODEL_TIMEOUT");
    if (name === "AbortError") return new EngineError("MODEL_CANCELLED");
    if (status === 401 || status === 403)
      return new EngineError("MODEL_AUTHENTICATION");
    if (status === 429) return new EngineError("MODEL_RATE_LIMIT");
    if (status === 408 || status === 504)
      return new EngineError("MODEL_TIMEOUT");
    if (typeof status === "number" && status >= 500)
      return new EngineError("MODEL_UNAVAILABLE");
    if (
      /ZodError|JSONParseError|TypeValidationError|NoObjectGeneratedError|StructuredOutputValidationError/.test(
        name,
      )
    )
      return new EngineError("MODEL_OUTPUT_INVALID");
    current = record.cause;
  }
  return new EngineError("MODEL_FAILED");
}

export function checkedModelOutput<T>(validate: () => T): T {
  try {
    return validate();
  } catch {
    throw new EngineError("MODEL_OUTPUT_INVALID");
  }
}
