import { z } from "zod";
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
      await body(request, z.object({}).strict());
      const { id } = await context.params;
      return withDeadline(request, (signal) =>
        reportSimulation(id, owner, signal),
      );
    },
    { mutation: true },
  );
}
