import { api } from "@/server/http";
import { deleteSimulation, readSimulation } from "@/server/store";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return api(request, async ({ owner }) =>
    readSimulation((await context.params).id, owner),
  );
}
export async function DELETE(request: Request, context: Context) {
  return api(
    request,
    async ({ owner }) => {
      await deleteSimulation((await context.params).id, owner);
      return { deleted: true };
    },
    { mutation: true },
  );
}
