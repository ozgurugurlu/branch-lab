import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

process.env.NODE_ENV ??= "production";
// Existing shell variables take precedence; local files are checked from most to least specific.
for (const file of [
  ".env.production.local",
  ".env.local",
  ".env.production",
  ".env",
]) {
  try {
    process.loadEnvFile(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
// The generated server changes cwd. Keep local data outside the replaceable build directory.
const databaseURL = process.env.TURSO_DATABASE_URL || "file:.data/branchlab.db";
if (databaseURL.startsWith("file:"))
  process.env.TURSO_DATABASE_URL = `file:${resolve(databaseURL.slice(5))}`;
process.env.HOSTNAME ||= "0.0.0.0";
await import(pathToFileURL(resolve(".next/standalone/server.js")).href);
