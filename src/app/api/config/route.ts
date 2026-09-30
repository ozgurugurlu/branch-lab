import { api } from "@/server/http";
import { getProviderStatuses } from "@/server/models";
import { liveEnabled, requiresPassword } from "@/server/security";
import { storageMode, databaseBackend } from "@/server/db";
import { webSearchConfigured } from "@/server/web-search";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return api(
    request,
    async ({ session }) => ({
      providers: getProviderStatuses(),
      authenticated: session.authenticated,
      passwordRequired: requiresPassword(),
      liveEnabled: liveEnabled(),
      storage: storageMode(),
      databaseBackend: databaseBackend(),
      webSearchConfigured: webSearchConfigured(),
    }),
    { public: true },
  );
}
