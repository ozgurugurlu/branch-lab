import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError, publicError } from "./errors";
import {
  assertOrigin,
  consumeLimit,
  getSession,
  type Session,
} from "./security";

interface Context {
  owner: string;
  session: Session;
}

/** Never record user-supplied IDs, query strings, or arbitrary path segments. */
function logRoute(request: Request): string {
  const path = new URL(request.url).pathname;
  if (
    /^\/api\/(config|session|health|privacy|workspace|simulations)$/.test(path)
  )
    return path;
  const match = path.match(
    /^\/api\/simulations\/[^/]+(?:\/(step|branch|chat|report|export))?$/,
  );
  return match
    ? `/api/simulations/:id${match[1] ? `/${match[1]}` : ""}`
    : "/api/unknown";
}

function responseHeaders(
  response: Response,
  requestId: string,
  session?: Session,
) {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("X-Request-ID", requestId);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  response.headers.set(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  const vary = new Set(
    (response.headers.get("Vary") ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  );
  vary.add("Cookie");
  response.headers.set("Vary", [...vary].join(", "));
  // A purge handler must be able to expire the cookie even for a new session.
  if (session?.cookie && !response.headers.has("Set-Cookie"))
    response.headers.set("Set-Cookie", session.cookie);
  return response;
}

function validationMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const path =
        issue.path
          .filter(
            (part) =>
              typeof part === "number" ||
              /^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(String(part)),
          )
          .join(".") || "Input";
      // Zod messages may quote unknown property names or rejected values.
      const message =
        issue.code === "unrecognized_keys"
          ? "Unexpected fields are not permitted."
          : issue.code === "too_small"
            ? "The value is below the permitted minimum."
            : issue.code === "too_big"
              ? "The value exceeds the permitted maximum."
              : "Check the value and format for this field.";
      return `${path}: ${message}`;
    })
    .join("; ")
    .slice(0, 600);
}
export async function api(
  request: Request,
  handler: (context: Context) => Promise<unknown>,
  options: { public?: boolean; mutation?: boolean } = {},
) {
  let session: Session | undefined;
  // Do not trust caller-supplied correlation IDs: they may contain private text.
  const requestId = randomUUID();
  try {
    if (options.mutation) assertOrigin(request);
    session = await getSession(request);
    if (!options.public && !session.authenticated)
      throw new AppError(
        "AUTH_REQUIRED",
        "Unlock this workspace in Settings to continue.",
        401,
      );
    if (options.mutation)
      await consumeLimit(`requests:${session.id}`, 120, 60_000);
    const result = await handler({ owner: session.id, session });
    const response =
      result instanceof Response ? result : Response.json({ data: result });
    return responseHeaders(response, requestId, session);
  } catch (error) {
    const safe =
      error instanceof z.ZodError
        ? new AppError("INVALID_INPUT", validationMessage(error), 400)
        : publicError(error);
    // Never log provider error objects, request bodies, source contents or credentials.
    if (safe.status >= 500)
      console.error(
        JSON.stringify({
          event: "api_failure",
          code: safe.code,
          path: logRoute(request),
          requestId,
        }),
      );
    const retryAfterSeconds =
      safe.retryAfterSeconds ?? (safe.status === 429 ? 60 : undefined);
    const response = Response.json(
      {
        error: {
          code: safe.code,
          message: safe.message,
          retryable: safe.retryable,
          requestId,
          ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
        },
      },
      { status: safe.status, headers: { "Cache-Control": "no-store" } },
    );
    if (retryAfterSeconds)
      response.headers.set("Retry-After", String(retryAfterSeconds));
    return responseHeaders(response, requestId, session);
  }
}

export async function body<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  )
    throw new AppError("CONTENT_TYPE", "Send an application/json body.", 415);
  const encoding = request.headers
    .get("content-encoding")
    ?.trim()
    .toLowerCase();
  if (encoding && encoding !== "identity")
    throw new AppError(
      "CONTENT_ENCODING",
      "Send uncompressed UTF-8 JSON.",
      415,
    );
  const max = 256_000;
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) ||
      !Number.isSafeInteger(Number(declaredLength)))
  )
    throw new AppError(
      "INVALID_CONTENT_LENGTH",
      "The request has an invalid Content-Length header.",
    );
  if (Number(declaredLength || 0) > max)
    throw new AppError(
      "BODY_TOO_LARGE",
      "The request exceeds 256 KB. Use shorter source excerpts.",
      413,
    );
  if (!request.body)
    throw new AppError("INVALID_JSON", "A JSON body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let rejectReading: (reason: AppError) => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    rejectReading = reject;
  });
  const stopReading = (reason: AppError) => {
    rejectReading(reason);
    void reader.cancel().catch(() => {});
  };
  const onAbort = () =>
    stopReading(
      new AppError(
        "REQUEST_CANCELLED",
        "The request was cancelled before its body was received.",
        499,
        true,
      ),
    );
  request.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () =>
      stopReading(
        new AppError(
          "BODY_TIMEOUT",
          "The request body was not received within 30 seconds. Retry with a smaller payload.",
          408,
          true,
        ),
      ),
    30_000,
  );
  if (request.signal.aborted) onAbort();
  try {
    while (true) {
      const result = await Promise.race([interrupted, reader.read()]);
      if (result.done) break;
      length += result.value.byteLength;
      if (length > max) {
        void reader.cancel().catch(() => {});
        throw new AppError(
          "BODY_TOO_LARGE",
          "The request exceeds 256 KB. Use shorter source excerpts.",
          413,
        );
      }
      chunks.push(result.value);
    }
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  let json: unknown;
  try {
    json = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    throw new AppError("INVALID_JSON", "The request contains invalid JSON.");
  }
  return schema.parse(json);
}

export async function withDeadline<T>(
  request: Request,
  execute: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let rejectOperation: (reason: Error) => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    rejectOperation = reject;
  });
  const onAbort = () => {
    const error = new DOMException("The request was cancelled.", "AbortError");
    rejectOperation(error);
    controller.abort(error);
  };
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    timer = setTimeout(() => {
      rejectOperation(
        new AppError(
          "TIMEOUT",
          "The operation exceeded three minutes. Your last saved round is intact; retry or choose a faster model.",
          504,
          true,
        ),
      );
      controller.abort(
        new DOMException("The operation deadline expired.", "TimeoutError"),
      );
    }, 180_000);
    return await Promise.race([
      interrupted,
      controller.signal.aborted
        ? Promise.reject(controller.signal.reason)
        : Promise.resolve().then(() => execute(controller.signal)),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
  }
}
