import { database, storageMode } from "@/server/db";
import { version } from "../../../../package.json";

export const runtime = "nodejs";
export async function GET() {
  try {
    await (await database()).execute("SELECT 1");
    return Response.json(
      { data: { status: "ok", storage: storageMode(), version } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      {
        error: {
          code: "DATABASE_UNAVAILABLE",
          message:
            "Database is unavailable. Check the server database configuration.",
          retryable: true,
        },
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
