import type { ExecutionFeed, OperationRecord, Simulation } from "@/lib/types";
import { api, RequestError } from "./client-api";

const STORAGE_KEY = "branchlab-auto-run-v1";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export interface AutoRunIntent {
  version: 1;
  id: string;
  simulationId: string | null;
  startedAt: number;
  updatedAt: number;
  pending: {
    kind: "create" | "step" | "report";
    requestId: string | null;
    expectedRound: number;
  } | null;
}

/** Only opaque execution metadata is stored; never scenario or source contents. */
export function saveAutoRunIntent(intent: AutoRunIntent | null) {
  try {
    if (intent) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(intent));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // The current in-memory run still works when tab storage is unavailable.
  }
}

function validAutoRunIntent(candidate: unknown): AutoRunIntent | null {
  try {
    const value = candidate as AutoRunIntent;
    if (
      value.version !== 1 ||
      !UUID.test(value.id) ||
      (value.simulationId !== null && !UUID.test(value.simulationId)) ||
      !Number.isFinite(value.startedAt) ||
      !Number.isFinite(value.updatedAt) ||
      value.startedAt > Date.now() ||
      Date.now() - value.updatedAt > MAX_AGE_MS ||
      value.updatedAt > Date.now() ||
      (value.pending !== null &&
        (!value.pending ||
          !["create", "step", "report"].includes(value.pending.kind) ||
          (value.pending.requestId !== null &&
            !UUID.test(value.pending.requestId)) ||
          !Number.isInteger(value.pending.expectedRound) ||
          value.pending.expectedRound < 0 ||
          value.pending.expectedRound > 24)) ||
      (!value.simulationId && value.pending?.kind !== "create")
    )
      throw new Error("Invalid tab execution metadata.");
    // Reconstruct the allowlist instead of carrying extra browser-stored fields.
    return {
      version: 1,
      id: value.id,
      simulationId: value.simulationId,
      startedAt: value.startedAt,
      updatedAt: value.updatedAt,
      pending: value.pending
        ? {
            kind: value.pending.kind,
            requestId: value.pending.requestId,
            expectedRound: value.pending.expectedRound,
          }
        : null,
    };
  } catch {
    return null;
  }
}

export function readAutoRunIntent(
  fallback: AutoRunIntent | null = null,
): AutoRunIntent | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage denial may use the live component's metadata, with the same
    // shape/freshness checks. An absent or rejected stored intent never does.
    return validAutoRunIntent(fallback);
  }
  if (!raw) return null;
  let intent: AutoRunIntent | null = null;
  try {
    intent = validAutoRunIntent(JSON.parse(raw));
  } catch {
    // Malformed metadata is discarded without reviving an in-memory copy.
  }
  if (!intent) saveAutoRunIntent(null);
  return intent;
}

export function newAutoRunIntent(simulationId: string | null): AutoRunIntent {
  const now = Date.now();
  return {
    version: 1,
    id: crypto.randomUUID(),
    simulationId,
    startedAt: now,
    updatedAt: now,
    pending: null,
  };
}

function waitForJournal(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const done = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, 1000);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function operationFailure(operation: OperationRecord) {
  const code = operation.errorCode || "OPERATION_INTERRUPTED";
  return new RequestError(
    code,
    `Automatic simulation stopped: the previous ${operation.kind} operation ${operation.status === "failed" ? "failed" : "was interrupted"} (${code}). ${operation.kind === "create" ? "Check saved chats before trying again." : "Saved rounds remain available. Review the activity before retrying."}`,
    code === "SESSION_LOCKED" || code === "SESSION_REVOKED" ? 401 : 409,
    true,
  );
}

/** Reconciliation makes read requests only. Failed or ambiguous work is never replayed. */
export async function reconcileAutoRun(
  initial: AutoRunIntent,
  options: {
    signal: AbortSignal;
    onIntent: (intent: AutoRunIntent) => void;
    onProgress: (
      simulation: Simulation | null,
      kind: "create" | "step" | "report",
    ) => void;
  },
): Promise<Simulation> {
  let intent = initial;
  const deadline = Date.now() + 225_000;
  let missingSince: number | null = null;
  const observedRunning = new Set<string>();
  while (true) {
    options.signal.throwIfAborted();
    if (!navigator.onLine)
      throw new RequestError(
        "NETWORK_UNAVAILABLE",
        "Auto-run paused because this browser is offline.",
        0,
        true,
      );
    let own: OperationRecord | undefined;
    if (intent.pending?.requestId) {
      const feed = await api<ExecutionFeed>(
        `/api/operations/${intent.pending.requestId}/trace`,
        { signal: options.signal },
      );
      own = feed.operations[0];
      if (!own) {
        missingSince ??= Date.now();
        if (Date.now() - missingSince >= 5000)
          throw new RequestError(
            "OPERATION_UNCONFIRMED",
            "The previous request could not be confirmed. Auto-run stopped to avoid repeating model work. Refresh saved state before retrying.",
            409,
            true,
          );
        options.onProgress(null, intent.pending.kind);
        await waitForJournal(options.signal);
        continue;
      }
      if (own.kind !== intent.pending.kind)
        throw new RequestError(
          "OPERATION_MISMATCH",
          "The saved execution request does not match this run. Auto-run stopped before starting more work.",
          409,
        );
      if (
        intent.simulationId &&
        own.simulationId &&
        own.simulationId !== intent.simulationId
      )
        throw new RequestError(
          "OPERATION_MISMATCH",
          "The saved execution request belongs to a different simulation. Auto-run stopped before starting more work.",
          409,
        );
      if (
        (own.status === "failed" && own.errorCode !== "RUN_BUSY") ||
        own.status === "interrupted"
      )
        throw operationFailure(own);
      if (!intent.simulationId && own.simulationId) {
        intent = {
          ...intent,
          simulationId: own.simulationId,
          updatedAt: Date.now(),
        };
        options.onIntent(intent);
      }
      if (own.status === "running") {
        options.onProgress(null, intent.pending?.kind ?? "step");
        if (Date.now() > deadline)
          throw operationFailure({ ...own, status: "interrupted" });
        await waitForJournal(options.signal);
        continue;
      }
    }
    if (!intent.simulationId)
      throw new RequestError(
        "OPERATION_UNCONFIRMED",
        "The started simulation has no confirmed saved result. Auto-run stopped; create it again only after checking saved chats.",
        409,
        true,
      );
    const operations = await api<OperationRecord[]>(
      `/api/simulations/${intent.simulationId}/operations`,
      { signal: options.signal },
    );
    const current = await api<Simulation>(
      `/api/simulations/${intent.simulationId}`,
      { signal: options.signal },
    );
    const failed = operations.find(
      (operation) =>
        operation.id !== own?.id &&
        (operation.kind === "step" || operation.kind === "report") &&
        (operation.status === "interrupted" ||
          (operation.status === "failed" &&
            operation.errorCode !== "RUN_BUSY")) &&
        (observedRunning.has(operation.id) ||
          Date.parse(operation.startedAt) >= intent.startedAt),
    );
    if (failed) throw operationFailure(failed);
    if (own?.status === "completed" && intent.pending) {
      if (
        (intent.pending.kind === "step" &&
          current.rounds.length <= intent.pending.expectedRound) ||
        (intent.pending.kind === "report" && !current.report)
      )
        throw new RequestError(
          "CHECKPOINT_UNCONFIRMED",
          "The completed request and saved checkpoint do not agree. Auto-run stopped before starting more work. Refresh saved state.",
          409,
          true,
        );
      intent = { ...intent, pending: null, updatedAt: Date.now() };
      options.onIntent(intent);
    }
    const active = operations.find(
      (operation) => operation.status === "running",
    );
    for (const operation of operations) {
      if (operation.status === "running") observedRunning.add(operation.id);
    }
    options.onProgress(current, active?.kind === "report" ? "report" : "step");
    if (!active) return current;
    if (Date.now() > deadline)
      throw operationFailure({ ...active, status: "interrupted" });
    await waitForJournal(options.signal);
  }
}
