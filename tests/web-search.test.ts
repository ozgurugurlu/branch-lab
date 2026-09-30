import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeDatabase } from "@/server/db";
import { searchWeb } from "@/server/web-search";
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "branchlab-search-"));
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("TURSO_DATABASE_URL", `file:${join(directory, "test.db")}`);
  vi.stubEnv("BRAVE_SEARCH_API_KEY", "synthetic-search-key");
  for (const key of ["VERCEL", "CF_PAGES", "WORKERS_CI"]) vi.stubEnv(key, "");
});
afterEach(async () => {
  await closeDatabase();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

it("pins the search endpoint, bounds results and never fetches result URLs", async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      web: {
        results: [
          {
            title: "A public source",
            url: "https://example.org/study",
            description: "<b>Unverified</b> external claim",
          },
          {
            title: "Unsafe link",
            url: "javascript:alert(1)",
            description: "ignored",
          },
          {
            title: "Credential link",
            url: "https://name:password@example.org",
            description: "ignored",
          },
        ],
      },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const results = await searchWeb("community trial evidence", "alice");
  expect(results).toEqual([
    {
      title: "A public source",
      url: "https://example.org/study",
      snippet: "Unverified external claim",
    },
  ]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
  expect(url.origin).toBe("https://api.search.brave.com");
  expect(url.searchParams.get("q")).toBe("community trial evidence");
  expect(options.redirect).toBe("error");
  expect(options.headers).toMatchObject({
    "X-Subscription-Token": "synthetic-search-key",
  });
});
it("rejects unavailable configuration and oversized queries before network access", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(searchWeb("x".repeat(401), "alice")).rejects.toMatchObject({
    code: "INVALID_SEARCH",
  });
  vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
  await expect(searchWeb("a query", "alice")).rejects.toMatchObject({
    code: "SEARCH_NOT_CONFIGURED",
  });
  expect(fetcher).not.toHaveBeenCalled();
});
it("does not expose search-service response bodies or credentials on failure", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("private upstream error", { status: 401 })),
  );
  const error = await searchWeb("a query", "alice").catch(
    (failure: unknown) => failure,
  );
  expect(error).toMatchObject({ code: "SEARCH_UNAVAILABLE", status: 502 });
  expect(String(error)).not.toContain("private upstream");
  expect(String(error)).not.toContain("synthetic-search-key");
});
it("caps response size before parsing provider content", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("x".repeat(256001))),
  );
  await expect(searchWeb("a query", "alice")).rejects.toMatchObject({
    code: "SEARCH_UNAVAILABLE",
  });
});
