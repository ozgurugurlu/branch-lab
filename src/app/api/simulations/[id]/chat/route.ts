import { chatSchema } from "@/lib/schemas";
import { api, body, withDeadline } from "@/server/http";
import { chatSimulation } from "@/server/simulations";

export const runtime = "nodejs";
export const maxDuration = 240;
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return api(
    request,
    async ({ owner }) => {
      const input = await body(request, chatSchema);
      const { id } = await context.params;
      return withDeadline(request, (signal) =>
        chatSimulation(
          id,
          owner,
          input.message,
          input.actorId,
          signal,
          input.requestId,
        ),
      );
    },
    { mutation: true },
  );
}
