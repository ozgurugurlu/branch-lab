import { api } from "@/server/http";
import { listOperations } from "@/server/operations";

export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return api(request, async ({ owner }) =>
    listOperations((await context.params).id, owner),
  );
}
