import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const loader = require.resolve("tsx");
const script = fileURLToPath(
  new URL("../scripts/db-prepare.mjs", import.meta.url),
);
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "branchlab-prepare-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function prepare(env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve) => {
      execFile(
        process.execPath,
        ["--import", loader, script],
        {
          cwd: directory,
          timeout: 10_000,
          // Never inherit real DB URLs, keys, NODE_OPTIONS or project env files.
          env: {
            PATH: process.env.PATH,
            NODE_ENV: "development",
            NEXT_TELEMETRY_DISABLED: "1",
            NO_COLOR: "1",
            ...env,
          },
        },
        (error, stdout, stderr) => {
          resolve({
            code: error ? Number(error.code) || 1 : 0,
            stdout,
            stderr,
          });
        },
      );
    },
  );
}

describe("database preparation CLI", () => {
  it("prepares the default SQLite schema repeatedly without erasing data or pruning expired sessions", async () => {
    expect(await prepare()).toMatchObject({ code: 0, stderr: "" });
    const db = createClient({
      url: `file:${join(directory, ".data/branchlab.db")}`,
    });
    try {
      await db.execute(
        "INSERT INTO sessions (id, expires_at) VALUES ('expired-fixture', 1)",
      );
      await db.execute({
        sql: "INSERT INTO simulations (id, owner, title, created_at, updated_at, version, data) VALUES ($1, $2, $3, $4, $4, 0, '{}')",
        args: [
          "saved-fixture",
          "expired-fixture",
          "Saved scenario",
          "2020-01-01",
        ],
      });
      const second = await prepare();
      expect(second).toMatchObject({ code: 0, stderr: "" });
      expect(second.stdout).toContain("Connection closed");
      expect((await db.execute("SELECT id FROM sessions")).rows).toHaveLength(
        1,
      );
      expect(
        (await db.execute("SELECT id FROM simulations")).rows,
      ).toHaveLength(1);
      expect(
        (await db.execute("SELECT version FROM schema_migrations")).rows,
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("matches Next development precedence and environment expansion without loading repository env files", async () => {
    const files = [
      ".env.development.local",
      ".env.local",
      ".env.development",
      ".env",
    ];
    for (const [index, file] of files.entries()) {
      await writeFile(
        join(directory, file),
        `DATABASE_URL=\nBRANCHLAB_FIXTURE_FILE=level-${index}.db\nTURSO_DATABASE_URL=file:\${BRANCHLAB_FIXTURE_FILE}\nOPENAI_API_KEY=private-fixture-key\n`,
      );
    }
    for (const [index, file] of files.entries()) {
      const result = await prepare();
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(result.stdout).not.toContain("private-fixture-key");
      expect(
        (await readFile(join(directory, `level-${index}.db`)))
          .subarray(0, 6)
          .toString(),
      ).toBe("SQLite");
      await rm(join(directory, file));
    }
  });

  it("preserves shell settings ahead of every env file", async () => {
    await writeFile(
      join(directory, ".env.development.local"),
      "DATABASE_URL=invalid-private-value\nTURSO_DATABASE_URL=file:ignored.db\n",
    );
    const result = await prepare({
      DATABASE_URL: "",
      TURSO_DATABASE_URL: "file:shell.db",
    });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(
      (await readFile(join(directory, "shell.db"))).subarray(0, 6).toString(),
    ).toBe("SQLite");
    await expect(readFile(join(directory, "ignored.db"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("honors an explicit production environment and skips local files in test mode", async () => {
    await writeFile(
      join(directory, ".env.local"),
      "DATABASE_URL=invalid-local-private-value\n",
    );
    await writeFile(
      join(directory, ".env.production.local"),
      "DATABASE_URL=\nTURSO_DATABASE_URL=file:production.db\n",
    );
    await writeFile(
      join(directory, ".env.test"),
      "DATABASE_URL=\nTURSO_DATABASE_URL=file:test.db\n",
    );
    expect(await prepare({ NODE_ENV: "production" })).toMatchObject({
      code: 0,
      stderr: "",
    });
    expect(await prepare({ NODE_ENV: "test" })).toMatchObject({
      code: 0,
      stderr: "",
    });
    expect(
      (await readFile(join(directory, "production.db"))).length,
    ).toBeGreaterThan(0);
    expect((await readFile(join(directory, "test.db"))).length).toBeGreaterThan(
      0,
    );
  });

  it("returns a safe nonzero failure for invalid PostgreSQL configuration before connecting", async () => {
    const secret = "private-db-credential-sentinel";
    const result = await prepare({
      DATABASE_URL: `postgresql://fixture:${secret}@127.0.0.1:1/fixture_test?options=${secret}`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("[DATABASE_CONFIGURATION]");
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(result.stdout + result.stderr).not.toContain("postgresql://");
    expect(result.stdout).not.toContain("Database ready");
  });

  it("does not expose SQLite paths or raw driver failures", async () => {
    const secret = "private-path-sentinel";
    await writeFile(
      join(directory, `${secret}.db`),
      "This is not a SQLite database",
    );
    const result = await prepare({ TURSO_DATABASE_URL: `file:${secret}.db` });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("[DATABASE_OPERATION_FAILED]");
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(result.stdout + result.stderr).not.toContain(directory);
  });

  it("stops safely when an environment file cannot be read", async () => {
    await symlink(".env.local", join(directory, ".env.local"));
    const result = await prepare();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("[ENVIRONMENT_CONFIGURATION]");
    expect(result.stderr).not.toContain(directory);
    expect(result.stderr).not.toContain("ELOOP");
    await expect(
      readFile(join(directory, ".data/branchlab.db")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs preparation before dev without connecting during install, build or production start", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(manifest.scripts["db:prepare"]).toBe(
      "node --import tsx scripts/db-prepare.mjs",
    );
    expect(manifest.scripts.predev).toBe("npm run db:prepare");
    expect(manifest.scripts.preinstall).toBeUndefined();
    expect(manifest.scripts.postinstall).toBeUndefined();
    expect(manifest.scripts.prebuild).toBeUndefined();
    expect(manifest.scripts.prestart).toBeUndefined();
  });
});
