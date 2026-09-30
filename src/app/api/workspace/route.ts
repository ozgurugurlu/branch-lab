import { deleteWorkspaceSchema } from "@/lib/schemas";
import { api, body } from "@/server/http";
import { eraseWorkspace } from "@/server/privacy";
import { clearSessionCookie } from "@/server/security";

export const runtime = "nodejs";
export async function DELETE(request: Request) {
  return api(
    request,
    async ({ owner }) => {
      await body(request, deleteWorkspaceSchema);
      await eraseWorkspace(owner);
      return Response.json(
        { data: { deleted: true } },
        {
          headers: { "Set-Cookie": clearSessionCookie(request) },
        },
      );
    },
    { mutation: true },
  );
}
