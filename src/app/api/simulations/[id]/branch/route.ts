import { branchSchema } from "@/lib/schemas";
import { api, body } from "@/server/http";
import { branchSimulation } from "@/server/simulations";

export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return api(
    request,
    async ({ owner }) => {
      const input = await body(request, branchSchema);
      return branchSimulation(
        (await context.params).id,
        owner,
        input.intervention,
        input.title,
      );
    },
    { mutation: true },
  );
}
