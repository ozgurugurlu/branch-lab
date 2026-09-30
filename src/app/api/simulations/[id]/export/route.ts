import { api } from "@/server/http";
import { readSimulation } from "@/server/store";
import { exportMarkdown } from "@/server/export";
import { AppError } from "@/server/errors";
import { executionFeed } from "@/server/trace";

export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return api(request, async ({ owner }) => {
    const s = await readSimulation((await context.params).id, owner);
    const format = new URL(request.url).searchParams.get("format") || "json";
    if (!["json", "markdown"].includes(format))
      throw new AppError(
        "INVALID_FORMAT",
        "Export format must be json or markdown.",
      );
    const filename = `branchlab-${s.id}.${format === "json" ? "json" : "md"}`;
    const execution = await executionFeed(owner, { simulationId: s.id });
    return new Response(
      format === "json"
        ? JSON.stringify({ ...s, execution }, null, 2)
        : exportMarkdown(s, execution),
      {
        headers: {
          "Content-Type":
            format === "json"
              ? "application/json; charset=utf-8"
              : "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      },
    );
  });
}
