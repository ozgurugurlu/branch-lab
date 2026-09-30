import { z } from "zod";
import type { WebSearchResult } from "@/lib/types";
import { AppError } from "./errors";
import { consumeLimit } from "./security";

export const webSearchConfigured = () =>
  Boolean(process.env.BRAVE_SEARCH_API_KEY);
const resultSchema = z.object({
  web: z
    .object({
      results: z.array(
        z.object({
          title: z.string(),
          url: z.string(),
          description: z.string().optional(),
        }),
      ),
    })
    .optional(),
});

/** One allowlisted search service. Result URLs are data; the server never follows or fetches them. */
export async function searchWeb(
  query: string,
  owner: string,
  signal?: AbortSignal,
): Promise<WebSearchResult[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key)
    throw new AppError(
      "SEARCH_NOT_CONFIGURED",
      "Web search is not configured on this server.",
      503,
    );
  if (
    !query.trim() ||
    query.length > 400 ||
    query.trim().split(/\s+/).length > 60
  )
    throw new AppError("INVALID_SEARCH", "Use a short, specific search query.");
  await consumeLimit("web-search:global", 200, 86_400_000);
  await consumeLimit(`web-search:${owner}`, 30, 3_600_000);
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query.trim());
  url.searchParams.set("count", "5");
  url.searchParams.set("safesearch", "moderate");
  const timeout = AbortSignal.timeout(15_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": key },
    signal: requestSignal,
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError(
      "SEARCH_UNAVAILABLE",
      "The search service could not complete this request. Check server configuration or retry later.",
      502,
      true,
    );
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw new AppError(
      "SEARCH_UNAVAILABLE",
      "The search service returned an empty response.",
      502,
      true,
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      requestSignal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 256_000) {
        await reader.cancel();
        throw new AppError(
          "SEARCH_UNAVAILABLE",
          "The search response exceeded its size limit.",
          502,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const parsed = resultSchema.safeParse(
    JSON.parse(Buffer.concat(chunks).toString("utf8")),
  );
  if (!parsed.success)
    throw new AppError(
      "SEARCH_UNAVAILABLE",
      "The search service returned an unsupported response.",
      502,
      true,
    );
  return (parsed.data.web?.results || [])
    .flatMap((result) => {
      try {
        const target = new URL(result.url);
        if (
          !["https:", "http:"].includes(target.protocol) ||
          target.username ||
          target.password
        )
          return [];
        return [
          {
            title: result.title.slice(0, 180),
            url: target.href.slice(0, 2000),
            snippet: (result.description || "")
              .replace(/<[^>]*>/g, "")
              .slice(0, 1200),
          },
        ];
      } catch {
        return [];
      }
    })
    .slice(0, 5);
}
