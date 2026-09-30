import { api } from "@/server/http";
import { executionFeed } from "@/server/trace";

export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return api(request, async ({ owner }) =>
    executionFeed(owner, { simulationId: (await context.params).id }),
  );
}
