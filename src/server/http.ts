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
export async function api(
  request: Request,
  handler: (context: Context) => Promise<unknown>,
  options: { public?: boolean; mutation?: boolean } = {},
) {
  let session: Session | undefined;
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
    response.headers.set("Cache-Control", "no-store");
    if (session.cookie) response.headers.set("Set-Cookie", session.cookie);
    return response;
  } catch (error) {
    const safe =
      error instanceof z.ZodError
        ? new AppError(
            "INVALID_INPUT",
            error.issues
              .map(
                (issue) =>
                  `${issue.path.join(".") || "Input"}: ${issue.message}`,
              )
              .join("; ")
              .slice(0, 600),
            400,
          )
        : publicError(error);
    // Never log provider error objects, request bodies, source contents or credentials.
    if (safe.status >= 500)
      console.error(
        JSON.stringify({
          event: "api_failure",
          code: safe.code,
          path: new URL(request.url).pathname,
        }),
      );
    const response = Response.json(
      {
        error: {
          code: safe.code,
          message: safe.message,
          retryable: safe.retryable,
        },
      },
      { status: safe.status, headers: { "Cache-Control": "no-store" } },
    );
    if (safe.status === 429) response.headers.set("Retry-After", "60");
    if (session?.cookie) response.headers.set("Set-Cookie", session.cookie);
    return response;
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
  const max = 256_000;
  if (Number(request.headers.get("content-length") || 0) > max)
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
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > max) {
        await reader.cancel();
        throw new AppError(
          "BODY_TOO_LARGE",
          "The request exceeds 256 KB. Use shorter source excerpts.",
          413,
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
  const onAbort = () => controller.abort(request.signal.reason);
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      execute(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new AppError(
              "TIMEOUT",
              "The operation exceeded three minutes. Your last saved round is intact; retry or choose a faster model.",
              504,
              true,
            ),
          );
        }, 180_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
  }
}
