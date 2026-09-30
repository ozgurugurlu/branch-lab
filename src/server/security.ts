import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { database } from "./db";
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
  cookie?: string;
}

export async function getSession(request: Request): Promise<Session> {
  const db = await database();
  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    const result = await db.execute({
      sql: "SELECT authenticated, expires_at, auth_fingerprint FROM sessions WHERE id = ? AND expires_at > ?",
      args: [token, Date.now()],
    });
    if (result.rows.length) {
      const row = result.rows[0];
      return {
        id: token,
        authenticated:
          !requiresPassword() ||
          (Boolean(row.authenticated) &&
            row.auth_fingerprint === digest(process.env.APP_PASSWORD!)),
      };
    }
  }
  const id = randomBytes(32).toString("hex");
  await db.execute({
    sql: "INSERT INTO sessions (id, authenticated, expires_at) VALUES (?, 0, ?)",
    args: [id, Date.now() + SESSION_SECONDS * 1000],
  });
  // Cookie security follows the deployment origin, so production Docker can also run on HTTP localhost.
  const secure =
    new URL(request.url).protocol === "https:" ||
    process.env.APP_ORIGIN?.startsWith("https://") ||
    isHosted();
  const cookie = `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure ? "; Secure" : ""}`;
  return { id, authenticated: !requiresPassword(), cookie };
}

export async function setAuthenticated(id: string, authenticated: boolean) {
  const db = await database();
  await db.execute({
    sql: "UPDATE sessions SET authenticated = ?, auth_fingerprint = ? WHERE id = ?",
    args: [
      authenticated ? 1 : 0,
      authenticated && process.env.APP_PASSWORD
        ? digest(process.env.APP_PASSWORD)
        : null,
      id,
    ],
  });
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
  const db = await database();
  const now = Date.now();
  const result = await db.execute({
    sql: `INSERT INTO rate_limits (key, count, resets_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        count = CASE WHEN resets_at <= ? THEN excluded.count ELSE count + excluded.count END,
        resets_at = CASE WHEN resets_at <= ? THEN excluded.resets_at ELSE resets_at END
      RETURNING count, resets_at`,
    args: [key, amount, now + windowMs, now, now],
  });
  if (Number(result.rows[0].count) > limit)
    throw new AppError(
      "RATE_LIMIT",
      "This workspace or server reached its request budget. Try again after the current limit window resets.",
      429,
      true,
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
  if (
    origin &&
    origin !== destinationOrigin &&
    origin !== process.env.APP_ORIGIN
  )
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
