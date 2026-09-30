"use client";

import { useState } from "react";
import { Clock3, LoaderCircle, RotateCcw } from "lucide-react";
import type { OperationRecord } from "@/lib/types";
import { api } from "./client-api";
import { InlineRequestError } from "./request-error";

export function ExecutionHistory({ simulationId }: { simulationId: string }) {
  const [records, setRecords] = useState<OperationRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setRecords(
        await api<OperationRecord[]>(
          `/api/simulations/${simulationId}/operations`,
        ),
      );
    } catch (reason) {
      setError(reason);
    } finally {
      setLoading(false);
    }
  }
  return (
    <details
      className="execution-history"
      onToggle={(event) => {
        if (event.currentTarget.open) void refresh();
      }}
    >
      <summary>
        <Clock3 size={14} /> Execution activity
      </summary>
      <div className="execution-toolbar">
        <p>
          Saved request outcomes for this simulation. Retrying an unfinished
          operation can still incur provider charges.
        </p>
        <button
          className="text-button"
          disabled={loading}
          onClick={() => void refresh()}
          aria-label="Refresh execution history"
        >
          {loading ? (
            <LoaderCircle size={13} className="spin" />
          ) : (
            <RotateCcw size={13} />
          )}
        </button>
      </div>
      <InlineRequestError error={error} />
      {records.length ? (
        <ol>
          {records.map((record) => (
            <li key={record.id}>
              <span className={`operation-status ${record.status}`}>
                {record.status}
              </span>
              <div>
                <strong>
                  {record.kind} · attempt {record.attempt}
                </strong>
                <time dateTime={record.startedAt}>
                  {new Date(record.startedAt).toLocaleString()}
                </time>
                {record.errorCode && <code>{record.errorCode}</code>}
                <small>
                  Engine {record.engineVersion} · prompt {record.promptVersion}
                </small>
              </div>
            </li>
          ))}
        </ol>
      ) : !loading && !error ? (
        <p>No operation records are available for this simulation.</p>
      ) : null}
    </details>
  );
}
