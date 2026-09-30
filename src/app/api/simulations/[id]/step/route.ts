import { stepSchema } from "@/lib/schemas";
import { api, body, withDeadline } from "@/server/http";
import { stepSimulation } from "@/server/simulations";

export const runtime = "nodejs";
export const maxDuration = 240;
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return api(
    request,
    async ({ owner }) => {
      const { expectedRound } = await body(request, stepSchema);
      const { id } = await context.params;
      return withDeadline(request, (signal) =>
        stepSimulation(id, owner, expectedRound, signal),
      );
    },
    { mutation: true },
  );
}
