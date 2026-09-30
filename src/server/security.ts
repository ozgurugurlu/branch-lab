import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { database, pruneExpiredWorkspaces } from "./db";
import { AppError } from "./errors";

const COOKIE = "branchlab_session";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
export const isHosted = () =>
  Boolean(process.env.VERCEL || process.env.CF_PAGES || process.env.WORKERS_CI);
export const requiresPassword = () => Boolean(process.env.APP_PASSWORD);
export const liveEnabled = () => !isHosted() || requiresPassword();
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export interface Session {
  id: string;
  authenticated: boolean;
  expiresAt?: number;
  cookie?: string;
}

function configuredOrigin(): string | undefined {
  const value = process.env.APP_ORIGIN?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new AppError(
      "APP_CONFIGURATION",
      "Set APP_ORIGIN to the application's HTTP or HTTPS origin, without a path or credentials.",
      503,
    );
  }
}

function cookieAttributes(request: Request): string {
  const secure =
    new URL(request.url).protocol === "https:" ||
    configuredOrigin()?.startsWith("https://") ||
    isHosted();
  return `Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(request: Request): string {
  return `${COOKIE}=; ${cookieAttributes(request)}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export async function getSession(request: Request): Promise<Session> {
  const db = await database();
  await pruneExpiredWorkspaces(db);
  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    const result = await db.execute({
      sql: "SELECT authenticated, expires_at, auth_fingerprint FROM sessions WHERE id = $1 AND expires_at > $2",
      args: [token, Date.now()],
    });
    if (result.rows.length) {
      const row = result.rows[0];
      return {
        id: token,
        expiresAt: Number(row.expires_at),
        authenticated:
          !requiresPassword() ||
          (Number(row.authenticated) === 1 &&
            row.auth_fingerprint === digest(process.env.APP_PASSWORD!)),
      };
    }
  }
  const id = randomBytes(32).toString("hex");
  const attributes = cookieAttributes(request);
  const expiresAt = Date.now() + SESSION_SECONDS * 1000;
  await db.execute({
    sql: "INSERT INTO sessions (id, authenticated, expires_at) VALUES ($1, 0, $2)",
    args: [id, expiresAt],
  });
  // Cookie security follows the deployment origin, so production Docker can also run on HTTP localhost.
  const cookie = `${COOKIE}=${id}; ${attributes}; Max-Age=${SESSION_SECONDS}`;
  return { id, authenticated: !requiresPassword(), expiresAt, cookie };
}

export async function setAuthenticated(id: string, authenticated: boolean) {
  const db = await database();
  const authentication = {
    sql: "UPDATE sessions SET authenticated = $1, auth_fingerprint = $2 WHERE id = $3 AND expires_at > $4",
    args: [
      authenticated ? 1 : 0,
      authenticated && process.env.APP_PASSWORD
        ? digest(process.env.APP_PASSWORD)
        : null,
      id,
      Date.now(),
    ],
  };
  if (authenticated) {
    await db.execute(authentication);
  } else {
    // Fencing and operation state are revoked atomically with authentication.
    // Unlocking again cannot revive model work started before this lock.
    await db.batch(
      [
        authentication,
        {
          sql: "UPDATE simulations SET lease_token = NULL, lease_expires = 0 WHERE owner = $1",
          args: [id],
        },
        {
          sql: "UPDATE operations SET status = 'interrupted', error_code = 'SESSION_LOCKED', finished_at = $1 WHERE owner = $2 AND status = 'running'",
          args: [new Date().toISOString(), id],
        },
      ],
      "write",
    );
  }
}

export function checkPassword(password: string) {
  return (
    Boolean(process.env.APP_PASSWORD) &&
    timingSafeEqual(
      Buffer.from(digest(password)),
      Buffer.from(digest(process.env.APP_PASSWORD!)),
    )
  );
}

/** Atomic fixed-window limiter shared across serverless instances. Failed attempts consume budget. */
export async function consumeLimit(
  key: string,
  limit: number,
  windowMs: number,
  amount = 1,
) {
  if (
    ![limit, windowMs, amount].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    throw new AppError(
      "LIMIT_CONFIGURATION",
      "The server request budget is not configured correctly.",
      500,
    );
  const db = await database();
  const now = Date.now();
  const result = await db.execute({
    sql: `INSERT INTO rate_limits (key, count, resets_at) VALUES ($1, $2, $3)
      ON CONFLICT(key) DO UPDATE SET
        count = CASE WHEN rate_limits.resets_at <= $4 THEN excluded.count ELSE rate_limits.count + excluded.count END,
        resets_at = CASE WHEN rate_limits.resets_at <= $5 THEN excluded.resets_at ELSE rate_limits.resets_at END
      RETURNING count, resets_at`,
    args: [key, amount, now + windowMs, now, now],
  });
  if (Number(result.rows[0].count) > limit)
    throw new AppError(
      "RATE_LIMIT",
      "This workspace or server reached its request budget. Try again after the current limit window resets.",
      429,
      true,
      Math.max(1, Math.ceil((Number(result.rows[0].resets_at) - now) / 1000)),
    );
}

export function assertOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site")
    throw new AppError(
      "ORIGIN_DENIED",
      "Cross-site requests are not permitted.",
      403,
    );
  const requestURL = new URL(request.url);
  // Next's standalone server can construct request.url from its bind hostname
  // (e.g. localhost/0.0.0.0). Host remains the browser's actual destination.
  // Never use an arbitrary X-Forwarded-Host as an additional allowed origin.
  const host = request.headers.get("host");
  const destinationOrigin = host
    ? `${requestURL.protocol}//${host}`
    : requestURL.origin;
  const allowedOrigin = configuredOrigin() ?? destinationOrigin;
  if (origin && origin !== allowedOrigin)
    throw new AppError(
      "ORIGIN_DENIED",
      "The request origin does not match this application.",
      403,
    );
}

export async function reserveModelCalls(owner: string, count: number) {
  if (!liveEnabled())
    throw new AppError(
      "LIVE_DISABLED",
      "Set APP_PASSWORD on the hosted server to enable paid or private model connections.",
      403,
    );
  const configured = Number(process.env.DAILY_MODEL_CALL_LIMIT || 1000);
  const limit =
    Number.isInteger(configured) && configured > 0 ? configured : 1000;
  await consumeLimit("model-calls:global", limit, 24 * 60 * 60 * 1000, count);
  await consumeLimit(
    `model-calls:${owner}`,
    Math.min(limit, 300),
    60 * 60 * 1000,
    count,
  );
}
