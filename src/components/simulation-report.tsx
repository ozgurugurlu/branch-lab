"use client";

import { useId } from "react";
import {
  ArrowUpRight,
  Check,
  FileText,
  LoaderCircle,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import type { Simulation } from "@/lib/types";
import type { RequestError } from "./client-api";
import { InlineRequestError } from "./request-error";

interface ContentProps {
  simulation: Simulation;
  onEvent: (id: string) => void;
  onSource: (id: string) => void;
  variant?: "chat" | "drawer";
  onUpdate?: () => void;
  updateDisabled?: boolean;
}

/** The same saved findings and provenance are readable in the thread and drawer. */
export function ReportContent({
  simulation,
  onEvent,
  onSource,
  variant = "chat",
  onUpdate,
  updateDisabled = false,
}: ContentProps) {
  const headingId = useId();
  const report = simulation.report;
  if (!report) return null;
  const events = new Map(
    simulation.rounds.flatMap((round) =>
      round.events.map((event) => [event.id, event] as const),
    ),
  );
  return (
    <article
      className={`research-report report-content report-content-${variant}`}
      aria-labelledby={headingId}
    >
      <div className="report-content-heading">
        <span>
          <Sparkles size={15} />
          Simulation report
        </span>
        <span>
          <Check size={12} />
          {simulation.model.provider === "demo"
            ? "Saved demo report"
            : "Saved report"}
        </span>
      </div>
      <h3 id={headingId}>{report.headline}</h3>
      {report.answer ? (
        <section
          className="report-scenario-answer"
          aria-label="Scenario answer"
        >
          <h4>Scenario answer</h4>
          <p className="report-question">{simulation.question}</p>
          <p className="report-answer">{report.answer}</p>
          {report.summary.trim() !== report.answer.trim() && (
            <details className="report-run-summary">
              <summary>What the run showed</summary>
              <p className="report-summary">{report.summary}</p>
            </details>
          )}
        </section>
      ) : (
        <>
          <p className="report-summary">{report.summary}</p>
          <div className="report-upgrade">
            <p>
              This saved report does not include a direct scenario answer.
              Update it to answer your original question.
            </p>
            {onUpdate && (
              <button
                className="button secondary small"
                disabled={updateDisabled}
                onClick={onUpdate}
              >
                <RotateCcw size={13} />
                Update report
              </button>
            )}
          </div>
        </>
      )}
      <div className="report-findings">
        {report.findings.map((finding, index) => (
          <section key={index}>
            <span className="finding-number" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
            <div>
              <h4>{finding.title}</h4>
              <p>{finding.detail}</p>
              {finding.eventIds.length > 0 && (
                <div
                  className="evidence-links"
                  aria-label={`Recorded evidence for ${finding.title}`}
                >
                  {finding.eventIds.map((id) => {
                    const event = events.get(id);
                    const actor =
                      event &&
                      simulation.world.actors.find(
                        (item) => item.id === event.actorId,
                      );
                    return (
                      <button
                        key={id}
                        onClick={() => onEvent(id)}
                        aria-label={`View event ${id}${event ? `, round ${event.round}${actor ? `, ${actor.name}` : ""}` : ""}`}
                        title={id}
                      >
                        <ArrowUpRight size={12} />
                        {event
                          ? `Round ${event.round}${actor ? ` · ${actor.name}` : ""}`
                          : id}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        ))}
      </div>
      <section className="report-uncertainties">
        <h4>What remains uncertain</h4>
        {report.uncertainties.length ? (
          <ul>
            {report.uncertainties.map((uncertainty, index) => (
              <li key={index}>{uncertainty}</li>
            ))}
          </ul>
        ) : (
          <p>
            No additional uncertainties were listed. The simulation’s
            assumptions still limit these findings.
          </p>
        )}
      </section>
      <section className="report-source-list">
        <h4>Source references</h4>
        {report.sourceIds.length ? (
          <ul>
            {report.sourceIds.map((id) => {
              const source = simulation.sources.find((item) => item.id === id);
              return (
                <li key={id}>
                  <button
                    onClick={() => onSource(id)}
                    aria-label={`Open source ${source?.name ?? id}`}
                  >
                    <FileText size={14} />
                    <span>
                      {source?.name ?? id}
                      <small>
                        {id}
                        {source?.access === "analyst-only"
                          ? " · Analyst-only source"
                          : ""}
                      </small>
                    </span>
                    <ArrowUpRight size={12} />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p>
            No document sources were cited. Findings describe the scenario and
            its recorded interactions.
          </p>
        )}
        <p className="report-provenance-note">
          Event and source links identify the inputs cited by this report; they
          do not independently verify its conclusions.
        </p>
      </section>
      {Boolean(report.contextNotes?.length) && (
        <section className="report-evidence-coverage">
          <h4>Evidence coverage</h4>
          <ul>
            {report.contextNotes?.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </section>
      )}
      <p className="report-disclaimer">
        This report describes a conditional simulation based on this run’s
        inputs and assumptions. Simulated support is not a real-world
        probability, and scenario differences do not establish causal effects.
      </p>
    </article>
  );
}

interface InlineProps extends Omit<ContentProps, "variant"> {
  busy: string | null;
  error: RequestError | null;
  online: boolean;
  onGenerate: () => void;
}

export function InlineSimulationReport({
  simulation,
  busy,
  error,
  online,
  onGenerate,
  onEvent,
  onSource,
}: InlineProps) {
  if (
    !simulation.report &&
    simulation.status !== "completed" &&
    busy !== "report" &&
    !error
  )
    return null;
  return (
    <section
      className="inline-simulation-report conversation-report"
      aria-label="Simulation report"
    >
      {simulation.report && (
        <ReportContent
          simulation={simulation}
          onEvent={onEvent}
          onSource={onSource}
          onUpdate={onGenerate}
          updateDisabled={Boolean(busy) || !online}
        />
      )}
      {busy === "report" ? (
        <div className="inline-report-progress" role="status">
          <LoaderCircle size={17} className="spin" />
          <div>
            <h3>Writing the simulation report…</h3>
            <p>
              {simulation.report
                ? "Your saved report stays available while its update is prepared."
                : simulation.status === "completed"
                  ? "The completed simulation is saved. Its answer, findings and references will appear here."
                  : "Your saved rounds are unchanged. An answer, findings and references from this run so far will appear here."}
            </p>
          </div>
        </div>
      ) : error ? (
        <div className="inline-report-recovery">
          <h3>
            {simulation.report
              ? "The report update needs another try. Your saved report is unchanged."
              : simulation.status === "completed"
                ? "The simulation is complete. Its report needs another try."
                : "The report needs another try. Your saved rounds are unchanged."}
          </h3>
          <InlineRequestError error={error} />
          <button
            className="button secondary small"
            disabled={Boolean(busy) || !online}
            onClick={onGenerate}
          >
            <RotateCcw size={14} />
            Retry report
          </button>
        </div>
      ) : !simulation.report ? (
        <div className="inline-report-missing">
          <div>
            <h3>Simulation report</h3>
            <p>
              Get an answer to your question, with the run’s evidence and
              remaining uncertainty.
            </p>
          </div>
          <button
            className="button secondary small"
            disabled={Boolean(busy) || !online || !simulation.rounds.length}
            onClick={onGenerate}
          >
            <FileText size={14} />
            Generate report
          </button>
        </div>
      ) : null}
    </section>
  );
}
