import type { ExecutionFeed, Simulation } from "@/lib/types";

export function exportMarkdown(
  s: Simulation,
  execution?: ExecutionFeed,
): string {
  const lines = [
    `# ${s.title}`,
    "",
    s.question,
    "",
    `Generated from a ${s.model.provider === "demo" ? "deterministic demonstration" : "synthetic agent simulation"}. These metrics are not calibrated real-world probabilities.`,
    "",
  ];
  // Build line-oriented artifacts without rendering submitted Markdown in the web application.
  lines.push(
    `Model: ${s.model.provider}/${s.model.model} · Seed: ${s.seed} · Rounds: ${s.rounds.length}/${s.maxRounds}`,
    `Engine: ${s.manifest.engineVersion} · Prompts: ${s.manifest.promptVersion} · Created: ${s.createdAt}`,
    `Cloud model processing: ${s.privacy?.allowCloud === false ? "not permitted" : "permitted"}. Source visibility controls agent inputs; the workspace owner and exports include all stored sources.`,
    "",
    "## Context",
    "",
    s.context || "No additional context supplied.",
    "",
    "## Assumptions",
    "",
    ...s.world.assumptions.map((a) => `- ${a}`),
  );
  if (s.parentId)
    lines.push("", `Branched from ${s.parentId} after round ${s.forkRound}.`);
  for (const i of s.interventions)
    lines.push(
      "",
      `## Intervention after round ${i.afterRound}`,
      "",
      i.content,
    );
  if (s.report) {
    lines.push("", "## Report", "", s.report.headline, "", s.report.summary);
    for (const f of s.report.findings)
      lines.push(
        "",
        `### ${f.title}`,
        "",
        f.detail,
        "",
        `Events: ${f.eventIds.join(", ") || "none"}`,
      );
    lines.push(
      "",
      "### Uncertainties",
      "",
      ...s.report.uncertainties.map((u) => `- ${u}`),
    );
  }
  for (const round of s.rounds) {
    lines.push(
      "",
      `## Round ${round.number}`,
      "",
      round.summary,
      "",
      `Simulated support ${round.metrics.support.toFixed(1)}%; disagreement ${round.metrics.polarization.toFixed(1)}; active actions ${round.metrics.activity}.`,
      "",
    );
    for (const event of round.events)
      lines.push(
        `- [${event.id}] ${s.world.actors.find((a) => a.id === event.actorId)?.name || event.actorId} (${event.kind}): ${event.content}${event.sourceIds.length ? ` [Sources: ${event.sourceIds.join(", ")}]` : ""}`,
      );
  }
  lines.push("", "## Source documents", "");
  for (const source of s.sources)
    lines.push(
      `### ${source.name} (${source.id})`,
      "",
      `SHA-256: ${source.hash}`,
      `Agent access: ${source.access === "analyst-only" ? "analyst only (excluded from architect and actors)" : "assigned actors and analyst"}`,
      "",
      source.content,
      "",
    );
  if (s.messages.length) {
    lines.push("", "## Conversations", "");
    for (const message of s.messages)
      lines.push(
        `**${message.role} · ${message.actorId || "analyst"} · round ${message.round}**`,
        "",
        message.content,
        "",
      );
  }
  if (execution) {
    lines.push(
      "",
      "## Execution activity",
      "",
      "Most recent 100 operations and 600 execution events. These are tool/status summaries, not private model reasoning.",
      "",
    );
    for (const operation of execution.operations)
      lines.push(
        `- ${operation.startedAt} · ${operation.kind} · ${operation.status} · attempt ${operation.attempt}${operation.errorCode ? ` · ${operation.errorCode}` : ""}`,
      );
    for (const event of execution.events) {
      lines.push(
        `- ${event.createdAt} · ${event.phase}${event.actorId ? ` / ${event.actorId}` : ""}${event.tool ? ` / ${event.tool}` : ""} · ${event.kind}: ${event.summary}`,
      );
      for (const source of event.webSources || [])
        lines.push(`  - Web result: ${source.title} — ${source.url}`);
    }
  }
  return lines.join("\n");
}
