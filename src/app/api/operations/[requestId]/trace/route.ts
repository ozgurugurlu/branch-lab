import { z } from "zod";
import { api } from "@/server/http";
import { executionFeed } from "@/server/trace";

export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ requestId: string }> },
) {
  return api(request, async ({ owner }) =>
    executionFeed(owner, {
      requestId: z
        .string()
        .uuid()
        .parse((await context.params).requestId),
    }),
  );
}
