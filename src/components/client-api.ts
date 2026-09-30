/** The browser only receives sanitized public errors, never provider payloads. */
export class RequestError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 0,
    public retryable = false,
    public retryAfter: number | null = null,
    public requestId?: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

export function requestError(error: unknown): RequestError {
  if (error instanceof RequestError) return error;
  if (error instanceof DOMException && error.name === "AbortError")
    return new RequestError("ABORTED", "The request was cancelled.");
  return new RequestError(
    "UNEXPECTED_ERROR",
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "The operation could not finish.",
    0,
    true,
  );
}

// Keep a failed action's identity in memory so an explicit retry of the same
// payload can recover a committed result instead of creating duplicate work.
// Never persist document contents or request metadata in browser storage.
const pendingMutations = new Map<string, string>();
let latestRequestId: string | null = null;
const requestListeners = new Set<() => void>();
export const subscribeRequestIdentity = (listener: () => void) => {
  requestListeners.add(listener);
  return () => {
    requestListeners.delete(listener);
  };
};
export const getRequestIdentity = () => latestRequestId;
export function resetMutationRequests() {
  pendingMutations.clear();
  latestRequestId = null;
  requestListeners.forEach((listener) => listener());
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  let mutationKey: string | null = null;
  if (
    options?.method === "POST" &&
    /^\/api\/simulations(?:\/[^/]+\/(?:step|chat|branch|report))?$/.test(
      path,
    ) &&
    typeof options.body === "string"
  ) {
    const payload = JSON.parse(options.body) as Record<string, unknown>;
    if (!payload.requestId) {
      const bytes = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${path}\n${options.body}`),
      );
      mutationKey = Array.from(new Uint8Array(bytes), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join("");
      const requestId =
        pendingMutations.get(mutationKey) ?? crypto.randomUUID();
      if (pendingMutations.size >= 100)
        pendingMutations.delete(pendingMutations.keys().next().value!);
      pendingMutations.set(mutationKey, requestId);
      latestRequestId = requestId;
      requestListeners.forEach((listener) => listener());
      options = { ...options, body: JSON.stringify({ ...payload, requestId }) };
    }
  }
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      headers: {
        ...(options?.body ? { "Content-Type": "application/json" } : {}),
        ...options?.headers,
      },
      cache: "no-store",
    });
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    throw new RequestError(
      "NETWORK_UNAVAILABLE",
      "Could not reach the workspace. Check your connection, then refresh saved state before repeating an operation.",
      0,
      true,
    );
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new RequestError(
      "INVALID_RESPONSE",
      "The server returned an unreadable response. Refresh saved state before repeating an operation.",
      response.status,
      true,
    );
  }
  if (!response.ok) {
    const body = result as {
      error?: {
        code?: unknown;
        message?: unknown;
        retryable?: unknown;
        requestId?: unknown;
      };
    } | null;
    const wait = Number(response.headers.get("Retry-After"));
    throw new RequestError(
      typeof body?.error?.code === "string"
        ? body.error.code
        : "REQUEST_FAILED",
      typeof body?.error?.message === "string"
        ? body.error.message
        : `The request could not finish (${response.status}).`,
      response.status,
      body?.error?.retryable === true,
      Number.isFinite(wait) && wait > 0 ? wait : null,
      typeof body?.error?.requestId === "string"
        ? body.error.requestId
        : (response.headers.get("X-Request-ID") ?? undefined),
    );
  }
  if (
    !result ||
    typeof result !== "object" ||
    !("data" in result) ||
    result.data == null
  )
    throw new RequestError(
      "INVALID_RESPONSE",
      "The server response is incomplete. Refresh the workspace to recover saved state.",
      response.status,
      true,
    );
  if (mutationKey) pendingMutations.delete(mutationKey);
  return result.data as T;
}

export const post = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
});

export function recoveryHint(error: RequestError) {
  if (error.status === 401)
    return "Unlock the workspace to continue. Your draft stays in this browser tab.";
  if (error.status === 429)
    return error.retryAfter
      ? `Wait at least ${error.retryAfter} seconds before trying again.`
      : "Wait before trying again. Provider or workspace limits may apply.";
  if (error.status === 409)
    return "Another operation may still be running. Refresh saved state before continuing.";
  if (
    ["NETWORK_UNAVAILABLE", "INVALID_RESPONSE", "TIMEOUT"].includes(error.code)
  )
    return "The server may have finished after the connection was lost. Refresh first to avoid repeating work or model charges.";
  return error.retryable
    ? "Your last saved checkpoint remains available. Refresh saved state before retrying."
    : "Review the message and your settings before submitting again.";
}
