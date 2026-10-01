import { database, storageMode } from "@/server/db";
import { databaseError } from "@/server/database-errors";
import { version } from "../../../../package.json";

export const runtime = "nodejs";
export async function GET() {
  try {
    await (await database()).execute("SELECT 1");
    return Response.json(
      { data: { status: "ok", storage: storageMode(), version } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const failure = databaseError(error);
    return Response.json(
      {
        error: {
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
        },
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
