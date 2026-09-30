import { createSimulationSchema } from "@/lib/schemas";
import { api, body, withDeadline } from "@/server/http";
import { listSimulations } from "@/server/store";
import { createSimulation } from "@/server/simulations";

export const runtime = "nodejs";
export const maxDuration = 240;
export async function GET(request: Request) {
  return api(request, ({ owner }) => listSimulations(owner));
}
export async function POST(request: Request) {
  return api(
    request,
    async ({ owner }) => {
      const input = await body(request, createSimulationSchema);
      return withDeadline(request, (signal) =>
        createSimulation(input, owner, signal),
      );
    },
    { mutation: true },
  );
}
