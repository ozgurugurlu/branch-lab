import type { Client } from "@libsql/client";
import { AppError } from "./errors";

let clientPromise: Promise<Client> | undefined;

export function storageMode(): "local" | "remote" {
  return process.env.TURSO_DATABASE_URL &&
    !process.env.TURSO_DATABASE_URL.startsWith("file:")
    ? "remote"
    : "local";
}

async function connect() {
  const url = process.env.TURSO_DATABASE_URL || "file:.data/branchlab.db";
  let client: Client;
  if (url.startsWith("file:")) {
    if (process.env.VERCEL || process.env.CF_PAGES) {
      throw new AppError(
        "DATABASE_CONFIGURATION",
        "Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN to a remote database before deploying.",
        503,
      );
    }
    const { mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(url.slice(5)), { recursive: true });
    const { createClient } = await import("@libsql/client");
    client = createClient({ url });
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA busy_timeout = 5000");
  } else {
    const { createClient } = await import("@libsql/client/web");
    client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  }
  await client.batch(
    [
      `CREATE TABLE IF NOT EXISTS simulations (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL,
      data TEXT NOT NULL, lease_token TEXT, lease_expires INTEGER NOT NULL DEFAULT 0
    )`,
      "CREATE INDEX IF NOT EXISTS simulations_owner_updated ON simulations(owner, updated_at DESC)",
      `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, authenticated INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL, auth_fingerprint TEXT
    )`,
      `CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, resets_at INTEGER NOT NULL
    )`,
    ],
    "write",
  );
  return client;
}

export async function database(): Promise<Client> {
  if (!clientPromise)
    clientPromise = connect().catch((error) => {
      clientPromise = undefined;
      throw error;
    });
  return clientPromise;
}

/** Test-only lifecycle helper; no request can choose the database location. */
export async function closeDatabase() {
  if (clientPromise) (await clientPromise).close();
  clientPromise = undefined;
}
