import type { SimulationSummary } from "./types";

/** Display the question when no custom title was supplied, without filling the form. */
export function chatTitle(
  run: Pick<SimulationSummary, "title" | "titleSource" | "question">,
): string {
  const title = run.title.trim();
  const isLegacyPlaceholder =
    run.titleSource === undefined &&
    /^Untitled (?:simulation|chat)(?: · branch)*$/i.test(title);
  return run.titleSource === "default" || !title || isLegacyPlaceholder
    ? run.question.trim() || title || "Untitled simulation"
    : title;
}
