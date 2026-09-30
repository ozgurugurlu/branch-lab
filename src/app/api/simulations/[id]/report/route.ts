import { reportInputSchema } from "@/lib/schemas";
import { api, body, withDeadline } from "@/server/http";
import { reportSimulation } from "@/server/simulations";

export const runtime = "nodejs";
export const maxDuration = 240;
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return api(
    request,
    async ({ owner }) => {
      const { requestId } = await body(request, reportInputSchema);
      const { id } = await context.params;
      return withDeadline(request, (signal) =>
        reportSimulation(id, owner, signal, requestId),
      );
    },
    { mutation: true },
  );
}
