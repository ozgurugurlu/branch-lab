"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  Check,
  ChevronDown,
  FileSearch,
  Globe2,
  LoaderCircle,
  Network,
  Sparkles,
  TriangleAlert,
  Users,
} from "lucide-react";
import type { ExecutionFeed } from "@/lib/types";
import {
  api,
  RequestError,
  getRequestIdentity,
  subscribeRequestIdentity,
} from "./client-api";
import { InlineRequestError } from "./request-error";

export function ProcessTrace({
  simulationId,
  busy,
}: {
  simulationId?: string;
  busy: string | null;
}) {
  const requestId = useSyncExternalStore(
    subscribeRequestIdentity,
    getRequestIdentity,
    () => null,
  );
  const endpoint =
    busy && requestId
      ? `/api/operations/${requestId}/trace`
      : simulationId
        ? `/api/simulations/${simulationId}/trace`
        : requestId
          ? `/api/operations/${requestId}/trace`
          : null;
  const [snapshot, setSnapshot] = useState<{
    endpoint: string;
    feed: ExecutionFeed;
  } | null>(null);
  const [failure, setFailure] = useState<{
    endpoint: string;
    error: unknown;
  } | null>(null);
  const trace = snapshot?.endpoint === endpoint ? snapshot.feed : null;
  const error = failure?.endpoint === endpoint ? failure.error : null;
  const [open, setOpen] = useState<boolean | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!endpoint) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const result = await api<ExecutionFeed>(endpoint!, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setSnapshot({ endpoint: endpoint!, feed: result });
        setFailure(null);
      } catch (reason) {
        if (
          !controller.signal.aborted &&
          !(busy && reason instanceof RequestError && reason.status === 404)
        )
          setFailure({ endpoint: endpoint!, error: reason });
      }
      if (busy && !controller.signal.aborted)
        timer = setTimeout(() => void poll(), 1000);
    }
    void poll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [endpoint, busy, attempt]);
  if (!busy && !trace?.events.length && !trace?.operations.length && !error)
    return null;
  const events = trace?.events ?? [];
  const expanded = open ?? Boolean(busy);
  const failed = trace?.operations.some(
    (operation) =>
      operation.status === "failed" || operation.status === "interrupted",
  );
  return (
    <section className="process-block" aria-label="Execution activity">
      <button
        className="process-trigger"
        aria-expanded={expanded}
        onClick={() => setOpen(!expanded)}
      >
        {busy ? (
          <LoaderCircle size={15} className="spin" />
        ) : failed ? (
          <TriangleAlert size={15} />
        ) : (
          <Sparkles size={15} />
        )}
        <span className={busy ? "working-shimmer" : ""}>
          {busy
            ? "Working on the simulation"
            : `Execution activity · ${events.length || trace?.operations.length || 0} recorded steps`}
        </span>
        <ChevronDown size={14} className={expanded ? "rotate-180" : ""} />
      </button>
      {expanded && (
        <div className="process-content">
          {events.length
            ? events.map((event) => {
                const Icon =
                  event.phase === "research"
                    ? Globe2
                    : event.phase === "actor"
                      ? Users
                      : event.tool
                        ? FileSearch
                        : Network;
                return (
                  <div
                    className={`process-event ${event.kind === "error" ? "failed" : ""}`}
                    key={event.id}
                  >
                    <span className="process-event-icon">
                      {event.kind === "phase-end" ||
                      event.kind === "tool-result" ? (
                        <Check size={12} />
                      ) : (
                        <Icon size={13} />
                      )}
                    </span>
                    <div>
                      <span>{event.summary}</span>
                      <small>
                        {event.phase}
                        {event.tool
                          ? ` · ${event.tool.replaceAll("_", " ")}`
                          : ""}
                        {event.actorId ? ` · ${event.actorId}` : ""}
                        {typeof event.durationMs === "number"
                          ? ` · ${(event.durationMs / 1000).toFixed(1)}s`
                          : ""}
                      </small>
                      {event.webSources?.length ? (
                        <div className="trace-web-sources">
                          {event.webSources
                            .filter((source) =>
                              /^https?:\/\//i.test(source.url),
                            )
                            .map((source, index) => (
                              <a
                                key={`${source.url}-${index}`}
                                href={source.url}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                <Globe2 size={11} />
                                {source.title || source.url}
                              </a>
                            ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })
            : trace?.operations.map((operation) => (
                <div className="process-event" key={operation.id}>
                  <span className="process-event-icon">
                    {operation.status === "running" ? (
                      <LoaderCircle size={13} className="spin" />
                    ) : (
                      <Check size={13} />
                    )}
                  </span>
                  <div>
                    <span>
                      {operation.kind} · {operation.status}
                    </span>
                    <small>
                      Attempt {operation.attempt}
                      {operation.errorCode ? ` · ${operation.errorCode}` : ""}
                    </small>
                  </div>
                </div>
              ))}
          {busy && !events.length && !trace?.operations.length && (
            <p className="trace-waiting">
              Waiting for recorded execution steps…
            </p>
          )}
          {Boolean(error) && (
            <>
              <InlineRequestError error={error} />
              <button
                className="text-button"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Refresh execution activity
              </button>
            </>
          )}
          <p className="trace-disclosure">
            Recorded execution summaries, limited to the latest 100 operations
            and 600 events. Private model reasoning is not shown.
          </p>
        </div>
      )}
    </section>
  );
}
