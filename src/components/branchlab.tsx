"use client";

import { ChatWorkspace, type PendingCreation } from "./chat-workspace";
import { ExecutionHistory } from "./execution-history";
import { useOverlayFocus } from "./use-overlay-focus";
import {
  api,
  post,
  RequestError,
  requestError,
  recoveryHint,
  isDatabaseSetupError,
  resetMutationRequests,
  getRequestIdentity,
  subscribeRequestIdentity,
} from "./client-api";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Clock3,
  FileText,
  FlaskConical,
  GitBranch,
  Layers3,
  LoaderCircle,
  MessageSquare,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  ShieldCheck,
  SkipForward,
  X,
} from "lucide-react";
import type {
  AppConfig,
  CreateSimulationInput,
  Simulation,
  SimulationSummary,
} from "@/lib/types";
import { TEMPLATES, type ScenarioTemplate } from "@/lib/templates";
import { ActorNetwork, initials, Trajectory } from "./network";
import {
  BranchDialog,
  DeleteDialog,
  Dialog,
  NewSimulationDialog,
  SettingsDialog,
} from "./dialogs";

type View = "network" | "timeline" | "sources" | "report";
type Modal =
  "new" | "settings" | "branch" | "delete" | "about" | "workspace" | null;

function Mark({ small = false }: { small?: boolean }) {
  return (
    <svg
      className={`brand-mark ${small ? "small" : ""}`}
      viewBox="0 0 36 36"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M10 29V8m0 12L28 7M10 20l18 9"
        stroke="currentColor"
        strokeWidth="2.3"
        strokeLinecap="round"
      />
      <circle cx="10" cy="6" r="3.5" fill="currentColor" />
      <circle cx="29" cy="6" r="3.5" fill="currentColor" />
      <circle cx="29" cy="30" r="3.5" fill="currentColor" />
    </svg>
  );
}

export function Branchlab() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [runs, setRuns] = useState<SimulationSummary[]>([]);
  const [simulation, setSimulation] = useState<Simulation | null>(null);
  const [creation, setCreation] = useState<PendingCreation | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingStage, setLoadingStage] = useState(
    "Checking workspace access…",
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<RequestError | null>(null);
  const [view, setView] = useState<View>("network");
  const [modal, setModal] = useState<Modal>(null);
  const [template, setTemplate] = useState<ScenarioTemplate | undefined>();
  const [draftInput, setDraftInput] = useState<
    CreateSimulationInput | undefined
  >();
  const [actorId, setActorId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [running, setRunning] = useState(false);

  const [parent, setParent] = useState<Simulation | null>(null);
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [focusedEvent, setFocusedEvent] = useState<string | null>(null);
  const activeId = useRef<string | null>(null);
  const requestEpoch = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const [online, setOnline] = useState(true);
  const [parentError, setParentError] = useState(false);
  const [parentAttempt, setParentAttempt] = useState(0);
  const [pauseRequested, setPauseRequested] = useState(false);
  const runLoop = useRef(false);
  const operationBusy = useRef(false);
  const closeModal = useCallback(() => setModal(null), []);

  const sidebarRef = useRef<HTMLElement>(null);

  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useOverlayFocus(sidebarRef, sidebarOpen && !modal, closeSidebar);

  const refreshRuns = useCallback(async () => {
    const list = await api<SimulationSummary[]>("/api/simulations");
    setRuns(list);
  }, []);
  const accept = useCallback(
    (sim: Simulation, epoch = requestEpoch.current) => {
      if (epoch !== requestEpoch.current) return;
      activeId.current = sim.id;
      setCreation(null);
      setSimulation(sim);
      try {
        localStorage.setItem("branchlab-last-run", sim.id);
      } catch {
        /* Storage is optional. */
      }
      setRuns((current) => [
        {
          id: sim.id,
          title: sim.title,
          question: sim.question,
          status: sim.status,
          roundCount: sim.rounds.length,
          maxRounds: sim.maxRounds,
          provider: sim.model.provider,
          updatedAt: sim.updatedAt,
          parentId: sim.parentId,
          metrics: sim.rounds.at(-1)?.metrics ?? null,
        },
        ...current.filter((r) => r.id !== sim.id),
      ]);
    },
    [],
  );

  const initialize = useCallback(async () => {
    const epoch = ++requestEpoch.current;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    setLoading(true);
    setLoadingStage("Checking workspace access…");
    setError(null);
    try {
      const settings = await api<AppConfig>("/api/config", {
        signal: controller.signal,
      });
      if (epoch !== requestEpoch.current) return;
      setConfig(settings);
      setLoadingStage("Loading saved chats…");
      const list = await api<SimulationSummary[]>("/api/simulations", {
        signal: controller.signal,
      });
      if (epoch !== requestEpoch.current) return;
      setRuns(list);
      let remembered: string | null = null;
      try {
        remembered = localStorage.getItem("branchlab-last-run");
      } catch {
        /* Optional preference. */
      }
      const id = list.some((r) => r.id === remembered)
        ? remembered
        : list[0]?.id;
      if (id) {
        setLoadingStage("Restoring your last simulation…");
        accept(
          await api<Simulation>(`/api/simulations/${id}`, {
            signal: controller.signal,
          }),
          epoch,
        );
      }
    } catch (e) {
      if (epoch !== requestEpoch.current || controller.signal.aborted) return;
      const failure = requestError(e);
      setError(failure);
      if (failure.status === 401 && !isDatabaseSetupError(failure)) {
        setSimulation(null);
        setRuns([]);
        activeId.current = null;
        setConfig((current) =>
          current ? { ...current, authenticated: false } : current,
        );
      }
    } finally {
      if (epoch === requestEpoch.current) setLoading(false);
    }
  }, [accept]);

  useEffect(() => {
    let mounted = true;
    const epochRef = requestEpoch;
    void Promise.resolve().then(() => {
      if (mounted) return initialize();
    });
    return () => {
      mounted = false;
      epochRef.current++;
      readController.current?.abort();
      runLoop.current = false;
    };
  }, [initialize]);

  useEffect(() => {
    const controller = new AbortController();
    const epoch = requestEpoch.current;
    if (simulation?.parentId)
      void api<Simulation>(`/api/simulations/${simulation.parentId}`, {
        signal: controller.signal,
      })
        .then((value) => {
          if (epoch === requestEpoch.current) {
            setParent(value);
            setParentError(false);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted && epoch === requestEpoch.current) {
            setParent(null);
            setParentError(true);
          }
        });
    return () => controller.abort();
  }, [simulation?.parentId, parentAttempt]);

  useEffect(() => {
    const update = () => {
      setOnline(navigator.onLine);
      if (!navigator.onLine) {
        runLoop.current = false;
        setRunning(false);
        setPauseRequested(true);
      }
    };
    void Promise.resolve().then(update);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    if (!busy || busy === "load") return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  useEffect(() => {
    if (view !== "timeline" || !focusedEvent) return;
    const element = document.getElementById(focusedEvent);
    element?.scrollIntoView({
      block: "center",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
    element?.focus({ preventScroll: true });
  }, [view, focusedEvent]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        event.key.toLowerCase() !== "n" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        busy ||
        modal ||
        target.closest("input, textarea, select, [contenteditable=true]")
      )
        return;
      event.preventDefault();
      setTemplate(undefined);
      setDraftInput(undefined);
      setModal("new");
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [busy, modal]);

  function stop() {
    if (busy === "step") setPauseRequested(true);
    runLoop.current = false;
    setRunning(false);
  }
  async function selectRun(id: string) {
    const epoch = requestEpoch.current;
    if (operationBusy.current) return;
    stop();
    setBusy("load");
    setError(null);
    setSidebarOpen(false);
    setActorId(null);
    setComparisonOpen(false);
    operationBusy.current = true;
    try {
      accept(await api<Simulation>(`/api/simulations/${id}`), epoch);
    } catch (e) {
      if (epoch !== requestEpoch.current) return;
      setError(requestError(e));
    } finally {
      if (epoch === requestEpoch.current) {
        setBusy(null);
        operationBusy.current = false;
      }
    }
  }
  async function step(start: Simulation, auto = false) {
    const epoch = requestEpoch.current;
    if (
      operationBusy.current ||
      !online ||
      start.rounds.length >= start.maxRounds
    )
      return;
    operationBusy.current = true;
    runLoop.current = auto;
    setRunning(auto);
    setPauseRequested(false);
    setError(null);
    setBusy("step");
    let current = start;
    try {
      do {
        const next = await api<Simulation>(
          `/api/simulations/${current.id}/step`,
          post({ expectedRound: current.rounds.length }),
        );
        if (epoch !== requestEpoch.current) return;
        if (activeId.current === next.id) accept(next, epoch);
        if (next.rounds.length <= current.rounds.length)
          throw new Error(
            "Another operation may still be completing. Refresh the simulation before resuming.",
          );
        current = next;
      } while (
        runLoop.current &&
        current.rounds.length < current.maxRounds &&
        activeId.current === current.id
      );
    } catch (e) {
      if (epoch !== requestEpoch.current) return;
      setError(requestError(e));
    } finally {
      if (epoch === requestEpoch.current) {
        runLoop.current = false;
        setRunning(false);
        setBusy(null);
        operationBusy.current = false;
      }
    }
  }
  function create(
    input: CreateSimulationInput,
    runImmediately = false,
    previous?: PendingCreation,
  ) {
    if (operationBusy.current || loading || !online)
      throw new RequestError(
        "WORKSPACE_BUSY",
        "Wait for the current request to finish and check your connection.",
      );
    const epoch = ++requestEpoch.current;
    const draft: PendingCreation = {
      id: previous?.id ?? crypto.randomUUID(),
      input: structuredClone(input),
      runImmediately,
      requestId: previous?.requestId ?? input.requestId ?? null,
      error: null,
    };
    readController.current?.abort();
    operationBusy.current = true;
    runLoop.current = false;
    activeId.current = null;
    setSimulation(null);
    setCreation(draft);
    setParent(null);
    setActorId(null);
    setComparisonOpen(false);
    setSidebarOpen(false);
    setRunning(false);
    setBusy("create");
    setError(null);
    setModal(null);
    // The request helper publishes its durable ID before issuing the POST.
    // Capture only this creation's identity; never show a previous run's trace.
    const unsubscribe = subscribeRequestIdentity(() => {
      if (epoch !== requestEpoch.current) return;
      const requestId = getRequestIdentity();
      setCreation((current) =>
        current?.id === draft.id ? { ...current, requestId } : current,
      );
      unsubscribe();
    });
    void (async () => {
      try {
        const sim = await api<Simulation>(
          "/api/simulations",
          post(draft.input),
        );
        if (epoch !== requestEpoch.current) return;
        accept(sim, epoch);
        setView("network");
        operationBusy.current = false;
        setBusy(null);
        if (runImmediately) await step(sim, true);
      } catch (reason) {
        if (epoch !== requestEpoch.current) return;
        const failure = requestError(reason);
        if (failure.status === 401 && !isDatabaseSetupError(failure)) {
          setConfig((current) =>
            current ? { ...current, authenticated: false } : current,
          );
          setRuns([]);
        }
        setCreation((current) =>
          current?.id === draft.id ? { ...current, error: failure } : current,
        );
      } finally {
        unsubscribe();
        if (epoch === requestEpoch.current) {
          operationBusy.current = false;
          setBusy(null);
        }
      }
    })();
  }
  function exploreDemo() {
    const model =
      config?.providers.find((p) => p.id === "demo")?.models[0]?.id ??
      "branchlab-demo";
    create(
      {
        ...TEMPLATES[0].input,
        model: { provider: "demo", model },
        seed: 42,
        maxRounds: 6,
        actorCount: 8,
        privacy: { allowCloud: false },
      },
      true,
    );
  }
  function retryCreation() {
    if (!creation || operationBusy.current || !online) return;
    create(creation.input, creation.runImmediately, creation);
  }
  function editCreation() {
    if (!creation || operationBusy.current) return;
    setDraftInput(creation.input);
    setTemplate(undefined);
    setModal("new");
  }
  async function branch(intervention: string, title: string) {
    const epoch = requestEpoch.current;
    if (!simulation || operationBusy.current || !online)
      throw new RequestError(
        "WORKSPACE_BUSY",
        "Wait for the current request to finish and check your connection.",
      );
    operationBusy.current = true;
    setBusy("branch");
    try {
      const next = await api<Simulation>(
        `/api/simulations/${simulation.id}/branch`,
        post({ intervention, title }),
      );
      if (epoch !== requestEpoch.current) return;
      accept(next, epoch);
      setModal(null);
      setActorId(null);
      setView("network");
      setComparisonOpen(true);
    } finally {
      if (epoch === requestEpoch.current) {
        operationBusy.current = false;
        setBusy(null);
      }
    }
  }
  async function report() {
    const epoch = requestEpoch.current;
    if (!simulation || operationBusy.current || !online) return;
    operationBusy.current = true;
    setBusy("report");
    setError(null);
    try {
      accept(
        await api<Simulation>(
          `/api/simulations/${simulation.id}/report`,
          post({}),
        ),
        epoch,
      );
    } catch (e) {
      if (epoch !== requestEpoch.current) return;
      setError(requestError(e));
    } finally {
      if (epoch === requestEpoch.current) {
        operationBusy.current = false;
        setBusy(null);
      }
    }
  }
  async function sendMessage(message: string) {
    const epoch = requestEpoch.current;
    if (!simulation || operationBusy.current || !online)
      throw new RequestError(
        "WORKSPACE_BUSY",
        "Wait for the current request to finish and check your connection.",
      );
    operationBusy.current = true;
    setBusy("chat");
    try {
      accept(
        await api<Simulation>(
          `/api/simulations/${simulation.id}/chat`,
          post({ message, ...(actorId ? { actorId } : {}) }),
        ),
        epoch,
      );
    } finally {
      if (epoch === requestEpoch.current) {
        operationBusy.current = false;
        setBusy(null);
      }
    }
  }
  async function deleteSimulation() {
    const epoch = requestEpoch.current;
    if (!simulation || operationBusy.current || !online)
      throw new RequestError(
        "WORKSPACE_BUSY",
        "Wait for the current request to finish and check your connection.",
      );
    operationBusy.current = true;
    setBusy("delete");
    setError(null);
    try {
      await api(`/api/simulations/${simulation.id}`, { method: "DELETE" });
      if (epoch !== requestEpoch.current) return;
      setModal(null);
      setSimulation(null);
      activeId.current = null;
      setActorId(null);
      try {
        localStorage.removeItem("branchlab-last-run");
      } catch {
        /* Optional preference. */
      }
      await refreshRuns();
    } catch (e) {
      if (epoch !== requestEpoch.current) return;
      throw e;
    } finally {
      if (epoch === requestEpoch.current) {
        operationBusy.current = false;
        setBusy(null);
      }
    }
  }
  async function eraseWorkspace() {
    await api("/api/workspace", {
      method: "DELETE",
      body: JSON.stringify({ confirmation: "DELETE MY WORKSPACE" }),
    });
    ++requestEpoch.current;
    readController.current?.abort();
    runLoop.current = false;
    operationBusy.current = false;
    resetMutationRequests();
    setSimulation(null);
    setCreation(null);
    setRuns([]);
    setParent(null);
    setDraftInput(undefined);
    setTemplate(undefined);
    setComparisonOpen(false);
    setActorId(null);
    activeId.current = null;
    setRunning(false);
    setBusy(null);
    setError(null);
    setModal(null);
    try {
      localStorage.removeItem("branchlab-last-run");
    } catch {
      /* Optional preference. */
    }
    await initialize();
  }

  function beginChat() {
    if (operationBusy.current || loading) return;
    stop();
    setSimulation(null);
    setCreation(null);
    setDraftInput(undefined);
    activeId.current = null;
    setActorId(null);
    setSidebarOpen(false);
    setError(null);
  }
  function newRun(t?: ScenarioTemplate) {
    if (operationBusy.current || loading || !online) return;
    stop();
    setSidebarOpen(false);
    setTemplate(t);
    setDraftInput(undefined);
    setModal("new");
  }
  const needsUnlock = error?.status === 401 && !isDatabaseSetupError(error);
  const setupFailed = error !== null && isDatabaseSetupError(error);
  const latest = simulation?.rounds.at(-1);
  const validParent = parent?.id === simulation?.parentId ? parent : null;
  const canStep = simulation && simulation.rounds.length < simulation.maxRounds;

  return (
    <div
      className={`app-shell chat-app-shell ${sidebarOpen ? "sidebar-visible" : ""}`}
    >
      <a className="skip-workspace" href="#chat-workspace">
        Skip to conversation
      </a>
      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={closeSidebar}
        />
      )}
      <aside
        className="sidebar chat-sidebar"
        ref={sidebarRef}
        inert={Boolean(modal)}
        role={sidebarOpen ? "dialog" : undefined}
        aria-modal={sidebarOpen || undefined}
        aria-label={sidebarOpen ? "Workspace navigation" : "Chat history"}
      >
        <div className="chat-brand-row">
          <button
            className="brand"
            onClick={beginChat}
            disabled={Boolean(busy) || loading}
            aria-label="Branchlab home"
          >
            <Mark />
            <span>Branchlab</span>
          </button>
          <button
            className="icon-button mobile-nav-toggle"
            aria-label="Close navigation"
            onClick={closeSidebar}
          >
            <PanelLeftClose size={17} />
          </button>
        </div>
        <button
          className="new-chat-button"
          disabled={Boolean(busy) || loading || !online}
          onClick={beginChat}
        >
          <span>
            <Plus size={18} />
          </span>
          New chat
        </button>
        <div className="chat-history-heading">Chats</div>
        <nav className="run-list" aria-label="Saved chats">
          {runs.length ? (
            runs.map((run) => (
              <button
                key={run.id}
                className={`run-item ${simulation?.id === run.id ? "is-active" : ""}`}
                disabled={Boolean(busy) || loading || !online}
                onClick={() => void selectRun(run.id)}
                aria-current={simulation?.id === run.id ? "page" : undefined}
              >
                <span className="run-copy">
                  <strong>{run.title}</strong>
                </span>
                {run.parentId && <GitBranch size={12} />}
              </button>
            ))
          ) : (
            <p className="empty-runs">Your conversations will be saved here.</p>
          )}
        </nav>
        <div className="chat-sidebar-footer">
          <button className="sidebar-link" onClick={() => setModal("settings")}>
            <Settings2 size={16} />
            <span>Settings & privacy</span>
          </button>
          <span className="history-privacy-note">
            Saved to this browser’s workspace
          </span>
        </div>
      </aside>
      <main
        className="main-workspace chat-main"
        id="chat-workspace"
        tabIndex={-1}
        inert={Boolean(modal) || sidebarOpen}
      >
        <header className="topbar chat-topbar">
          <button
            className="icon-button mobile-nav-toggle"
            aria-label="Toggle navigation"
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <PanelLeftOpen size={18} />
          </button>
          <span className="chat-current-title">
            {simulation?.title ?? creation?.input.title ?? ""}
          </span>
          <div className="topbar-right">
            {simulation && (
              <button
                className="button secondary small"
                onClick={() => setModal("workspace")}
              >
                <Network size={14} />
                Open simulation
              </button>
            )}
            <button
              className="icon-button"
              aria-label="Open settings"
              onClick={() => setModal("settings")}
            >
              <Settings2 size={17} />
            </button>
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <div className="error-copy">
              <span>{error.message}</span>
              <small>
                {recoveryHint(error, simulation ? "simulation" : "workspace")}
              </small>
              {error.requestId && (
                <small className="error-request-id">
                  Request ID <code>{error.requestId}</code>
                </small>
              )}
            </div>
            <button
              className="text-button"
              disabled={Boolean(busy) || loading || !online}
              onClick={() =>
                needsUnlock
                  ? setModal("settings")
                  : simulation && !setupFailed
                    ? void selectRun(simulation.id)
                    : void initialize()
              }
            >
              <RotateCcw size={13} />
              {needsUnlock
                ? "Unlock workspace"
                : simulation && !setupFailed
                  ? "Refresh saved state"
                  : "Reload workspace"}
            </button>
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setError(null)}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {!online && (
          <div className="connection-banner" role="status">
            You’re offline. Auto-run is paused. Reconnect and refresh saved
            state before continuing.
          </div>
        )}
        {loading ? (
          <div className="workspace-loading" role="status" aria-live="polite">
            <LoaderCircle size={18} className="spin" />
            <span>{loadingStage}</span>
          </div>
        ) : (
          <ChatWorkspace
            key={simulation?.id ?? creation?.id ?? "new"}
            config={config}
            simulation={simulation}
            creation={creation}
            onRetryCreation={retryCreation}
            onEditCreation={editCreation}
            actorId={actorId}
            onActorChange={setActorId}
            busy={busy}
            running={running}
            pauseRequested={pauseRequested}
            online={online}
            onSend={sendMessage}
            onStart={(input) => create(input, true)}
            onConfigure={(input) => {
              setDraftInput(input);
              setTemplate(undefined);
              setModal("new");
            }}
            onTemplate={newRun}
            onDemo={exploreDemo}
            onOpenWorkspace={(nextView) => {
              setView(nextView ?? "network");
              setModal("workspace");
            }}
            onRun={(auto) =>
              simulation ? step(simulation, auto) : Promise.resolve()
            }
            onPause={stop}
            onBranch={() => setModal("branch")}
            onDelete={() => setModal("delete")}
          />
        )}
      </main>
      {modal === "workspace" && simulation && (
        <Dialog
          title={simulation.title}
          eyebrow="SIMULATION WORKSPACE"
          onClose={closeModal}
          wide
          className="workspace-dialog"
        >
          <div className="drawer-description">
            <span>{simulation.question}</span>
            <button
              className="text-button"
              disabled={Boolean(busy) || simulation.rounds.length >= 24}
              onClick={() => setModal("branch")}
            >
              <GitBranch size={14} />
              Branch scenario
            </button>
          </div>
          {simulation.parentId && (
            <div className="branch-banner">
              <GitBranch size={14} />
              <span>Branched at round {simulation.forkRound}</span>
              {validParent && (
                <button
                  className="text-button"
                  onClick={() => setComparisonOpen(!comparisonOpen)}
                >
                  {comparisonOpen ? "Hide comparison" : "Compare outcomes"}
                </button>
              )}
              {!validParent && parentError && (
                <button
                  className="text-button"
                  onClick={() => setParentAttempt((value) => value + 1)}
                >
                  Retry baseline
                </button>
              )}
            </div>
          )}
          {comparisonOpen && validParent && (
            <Comparison parent={validParent} simulation={simulation} />
          )}
          <div className="workspace-columns">
            {" "}
            <section className="simulation-canvas">
              <div className="canvas-navigation">
                <nav className="view-tabs" aria-label="Simulation views">
                  {(
                    [
                      { id: "network", label: "Network", Icon: Network },
                      { id: "timeline", label: "Timeline", Icon: Clock3 },
                      { id: "sources", label: "Sources", Icon: FileText },
                      { id: "report", label: "Report", Icon: Layers3 },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      className={view === tab.id ? "is-active" : ""}
                      onClick={() => setView(tab.id)}
                      aria-current={view === tab.id ? "page" : undefined}
                    >
                      <tab.Icon size={15} />
                      {tab.label}
                      {tab.id === "sources" && (
                        <span className="tab-count">
                          {simulation.sources.length}
                        </span>
                      )}
                    </button>
                  ))}
                </nav>
                <button
                  className="icon-button inspector-toggle"
                  aria-label="Return to conversation"
                  onClick={() => setModal(null)}
                >
                  <MessageSquare size={18} />
                </button>
              </div>
              {view === "network" && (
                <div className="network-view">
                  <div className="canvas-topline">
                    <div>
                      <span className="eyebrow">THE SOCIAL LANDSCAPE</span>
                      <p>
                        {simulation.world.actors.length} perspectives. One
                        unfolding scenario.
                      </p>
                    </div>
                    <span className="round-tag">
                      ROUND {String(simulation.rounds.length).padStart(2, "0")}{" "}
                      <span>
                        / {String(simulation.maxRounds).padStart(2, "0")}
                      </span>
                    </span>
                  </div>
                  <div className="network-stage">
                    <ActorNetwork
                      actors={simulation.world.actors}
                      relationships={simulation.world.relationships}
                      selected={actorId}
                      onSelect={(id) => {
                        setActorId(actorId === id ? null : id);
                        setModal(null);
                      }}
                    />
                    <div className="network-legend">
                      <span>
                        <i className="supportive" /> Supportive
                      </span>
                      <span>
                        <i className="undecided" /> Undecided
                      </span>
                      <span>
                        <i className="skeptical" /> Skeptical
                      </span>
                    </div>
                    <span className="network-hint">
                      Select an actor to explore their perspective
                    </span>
                  </div>
                  <div className="metrics-strip">
                    <Metric
                      label="Simulated support"
                      value={
                        latest ? `${Math.round(latest.metrics.support)}%` : "—"
                      }
                      detail="Mean actor stance"
                    />
                    <Metric
                      label="Disagreement"
                      value={
                        latest
                          ? `${Math.round(latest.metrics.polarization)}%`
                          : "—"
                      }
                      detail="Spread of actor stances"
                    />
                    <Metric
                      label="Interactions"
                      value={String(
                        simulation.rounds.reduce(
                          (n, r) => n + r.events.length,
                          0,
                        ),
                      ).padStart(2, "0")}
                      detail={`Across ${simulation.rounds.length} rounds`}
                    />
                  </div>
                  <Trajectory rounds={simulation.rounds} />
                  {latest && (
                    <div className="round-takeaway">
                      <span className="eyebrow">LATEST OBSERVATION</span>
                      <p>{latest.summary}</p>
                      <button
                        className="text-button"
                        onClick={() => setView("timeline")}
                      >
                        Read the conversation <ArrowRight size={13} />
                      </button>
                    </div>
                  )}
                </div>
              )}
              {view === "timeline" && (
                <Timeline
                  key={simulation.id}
                  simulation={simulation}
                  onSelectActor={(id) => {
                    setActorId(id);
                    setModal(null);
                  }}
                />
              )}
              {view === "sources" && <Sources simulation={simulation} />}
              {view === "report" && (
                <ReportView
                  simulation={simulation}
                  onGenerate={() => void report()}
                  busy={busy}
                  onEvent={(id) => {
                    setFocusedEvent(id);
                    setView("timeline");
                  }}
                />
              )}
              <div className="simulation-controls">
                <div className="progress-info">
                  <div className="round-progress">
                    {Array.from({ length: simulation.maxRounds }, (_, i) => (
                      <span
                        key={i}
                        className={
                          i < simulation.rounds.length
                            ? "is-complete"
                            : i === simulation.rounds.length && busy === "step"
                              ? "is-running"
                              : ""
                        }
                      />
                    ))}
                  </div>
                  <span>
                    {busy === "step"
                      ? `Processing round ${simulation.rounds.length + 1}…`
                      : `${simulation.rounds.length} of ${simulation.maxRounds} rounds complete`}
                  </span>
                </div>
                <div className="playback-controls">
                  <button
                    className="icon-button outlined"
                    aria-label="Run one round"
                    title="Run one round"
                    disabled={!canStep || Boolean(busy) || !online}
                    onClick={() => void step(simulation)}
                  >
                    <SkipForward size={16} />
                  </button>
                  {running ? (
                    <button className="button primary" onClick={stop}>
                      <Pause size={14} /> Pause
                    </button>
                  ) : (
                    <button
                      className="button primary"
                      disabled={!canStep || Boolean(busy) || !online}
                      onClick={() => void step(simulation, true)}
                    >
                      {busy === "step" ? (
                        <LoaderCircle className="spin" size={15} />
                      ) : canStep ? (
                        <Play size={14} fill="currentColor" />
                      ) : (
                        <Check size={16} />
                      )}{" "}
                      {busy === "step"
                        ? "Finishing round"
                        : canStep
                          ? simulation.rounds.length
                            ? "Continue"
                            : "Run simulation"
                          : "Completed"}
                    </button>
                  )}
                </div>
              </div>
              <div className="canvas-footnote">
                <ShieldCheck size={12} /> Simulated perspectives, not calibrated
                predictions.{" "}
                <span>{simulation.usage.modelCalls} model operations</span>
              </div>
            </section>
          </div>
        </Dialog>
      )}
      {modal === "new" && (
        <NewSimulationDialog
          config={config}
          initialTemplate={template}
          initialDraft={draftInput}
          onClose={closeModal}
          onCreate={create}
          busy={busy === "create"}
        />
      )}
      {modal === "settings" && (
        <SettingsDialog
          config={config}
          onClose={closeModal}
          workspaceBusy={Boolean(busy) || loading}
          onEraseWorkspace={eraseWorkspace}
          onAuthenticate={async (password) => {
            await api("/api/session", post({ password }));
            if (creation) {
              setConfig(await api<AppConfig>("/api/config"));
              await refreshRuns();
            } else await initialize();
          }}
          onLock={async () => {
            if (operationBusy.current)
              throw new Error(
                "Wait for the current operation to finish before locking.",
              );
            stop();
            ++requestEpoch.current;
            readController.current?.abort();
            await api("/api/session", { method: "DELETE" });
            resetMutationRequests();
            setSimulation(null);
            setCreation(null);
            setRuns([]);
            setParent(null);
            setDraftInput(undefined);
            setTemplate(undefined);
            setComparisonOpen(false);
            activeId.current = null;
            setActorId(null);
            setError(null);
            setConfig(await api<AppConfig>("/api/config"));
          }}
        />
      )}
      {modal === "branch" && simulation && (
        <BranchDialog
          simulation={simulation}
          onClose={closeModal}
          onBranch={branch}
          busy={busy === "branch"}
        />
      )}
      {modal === "delete" && simulation && (
        <DeleteDialog
          title={simulation.title}
          onClose={closeModal}
          onDelete={deleteSimulation}
          busy={busy === "delete"}
        />
      )}
      {modal === "about" && (
        <Dialog
          title="A laboratory for possible futures."
          eyebrow="ABOUT BRANCHLAB"
          onClose={closeModal}
        >
          <div className="dialog-content about-content">
            <Mark />
            <p>
              Branchlab lets you build a cast of simulated actors, observe their
              interactions, and explore how a change could play out.
            </p>
            <h3>Read the result in context</h3>
            <p>
              Each world reflects your sources, assumptions, model and
              simulation rules. Support and disagreement describe the simulated
              actors. They are not population estimates or probabilities of
              real-world outcomes.
            </p>
            <h3>Follow the evidence</h3>
            <p>
              Inspect source documents, actor memories and the event timeline.
              Branch from a completed round to compare an intervention with its
              starting world.
            </p>
            <h3>Keep your experiments</h3>
            <p>
              Rounds are saved as they complete. Pause stops scheduling the next
              round; a round already in progress finishes first. Export the full
              simulation to preserve the record.
            </p>
            <div className="mode-note">
              <FlaskConical size={17} />
              <span>
                Demo mode is deterministic and uses no language model. Live mode
                uses your configured provider.
              </span>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function Timeline({
  simulation,
  onSelectActor,
}: {
  simulation: Simulation;
  onSelectActor: (id: string) => void;
}) {
  const [filter, setFilter] = useState("all");
  return (
    <div className="detail-view timeline-view">
      <div className="view-heading">
        <div>
          <span className="eyebrow">THE CONVERSATION</span>
          <h2>How the world responds.</h2>
        </div>
        <label className="sr-only" htmlFor="timeline-filter">
          Filter by actor
        </label>
        <select
          id="timeline-filter"
          className="compact-select"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">All actors</option>
          {simulation.world.actors.map((a) => (
            <option value={a.id} key={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      {!simulation.rounds.length ? (
        <EmptyState
          Icon={MessageSquare}
          title="The conversation starts here."
          description="Run the first round to see what each actor says and does."
        />
      ) : (
        [...simulation.rounds].reverse().map((round) => (
          <section className="timeline-round" key={round.number}>
            <div className="timeline-round-heading">
              <span className="round-number">
                {String(round.number).padStart(2, "0")}
              </span>
              <div>
                <h3>Round {round.number}</h3>
                <p>{round.summary}</p>
              </div>
              <span className="round-support">
                {Math.round(round.metrics.support)}%<small>support</small>
              </span>
            </div>
            {simulation.interventions
              .filter((i) => i.afterRound === round.number - 1)
              .map((i) => (
                <div className="timeline-intervention" key={i.id}>
                  <GitBranch size={15} />
                  <span>Intervention: {i.content}</span>
                </div>
              ))}
            <div className="event-list">
              {round.events
                .filter((e) => filter === "all" || filter === e.actorId)
                .map((event) => {
                  const actor =
                    round.actors.find((a) => a.id === event.actorId) ??
                    simulation.world.actors.find((a) => a.id === event.actorId);
                  return (
                    <article
                      key={event.id}
                      id={event.id}
                      tabIndex={-1}
                      className="event"
                    >
                      <button
                        className={`actor-avatar ${event.stance < -0.2 ? "skeptical" : ""}`}
                        aria-label={`Inspect ${actor?.name ?? "actor"}`}
                        onClick={() => onSelectActor(event.actorId)}
                      >
                        {initials(actor?.name ?? "A")}
                      </button>
                      <div className="event-body">
                        <div className="event-byline">
                          <button onClick={() => onSelectActor(event.actorId)}>
                            {actor?.name ?? "Unknown actor"}
                          </button>
                          <span>{event.kind}</span>
                        </div>
                        <p>{event.content}</p>
                        <div className="event-meta">
                          <span>{actor?.role}</span>
                          {event.targetId && (
                            <span>
                              →{" "}
                              {simulation.world.actors.find(
                                (a) => a.id === event.targetId,
                              )?.name ?? "actor"}
                            </span>
                          )}
                          {event.sourceIds.length > 0 && (
                            <span>
                              <FileText size={11} />
                              {event.sourceIds.length} source
                              {event.sourceIds.length > 1 ? "s" : ""}
                            </span>
                          )}
                          <code>{event.id}</code>
                        </div>
                      </div>
                    </article>
                  );
                })}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

function Sources({ simulation }: { simulation: Simulation }) {
  return (
    <div className="detail-view sources-view">
      <div className="view-heading">
        <div>
          <span className="eyebrow">THE WORLD’S FOUNDATION</span>
          <h2>Sources & assumptions.</h2>
        </div>
        <span className="document-count">
          {simulation.sources.length} document
          {simulation.sources.length !== 1 ? "s" : ""}
        </span>
      </div>
      <p className="view-description">
        Source text is the input to this world. Model-generated assumptions are
        listed separately below. Full source text is stored and exported; model
        context uses excerpts of up to 6,000 characters per source, 24,000
        combined. The analyst sees the latest four rounds.
      </p>
      <div className="source-documents">
        {simulation.sources.length ? (
          simulation.sources.map((source) => (
            <details className="source-document" key={source.id}>
              <summary>
                <FileText size={19} />
                <span>
                  <strong>{source.name}</strong>
                  <small>
                    {source.content.length.toLocaleString()} characters ·{" "}
                    {source.id} ·{" "}
                    {source.access === "analyst-only"
                      ? "Analyst only"
                      : "Actor evidence"}
                  </small>
                </span>
                <ChevronDown size={16} />
              </summary>
              <div className="source-content">
                <pre>{source.content}</pre>
                <code className="source-hash">SHA-256 · {source.hash}</code>
              </div>
            </details>
          ))
        ) : (
          <div className="no-sources">
            <FileText size={22} />
            <p>
              No source documents were supplied. This world is based on the
              scenario brief and generated assumptions.
            </p>
          </div>
        )}
      </div>
      <section className="assumptions">
        <span className="eyebrow">GENERATED ASSUMPTIONS</span>
        <h3>What this simulation takes as given</h3>
        <ol>
          {simulation.world.assumptions.map((assumption, i) => (
            <li key={i}>
              <span>{String(i + 1).padStart(2, "0")}</span>
              <p>{assumption}</p>
            </li>
          ))}
        </ol>
      </section>
      {simulation.context && (
        <details className="context-details">
          <summary>
            Original scenario context <ChevronDown size={14} />
          </summary>
          <p>{simulation.context}</p>
        </details>
      )}
      <div className="run-manifest">
        <span className="eyebrow">RUN RECORD</span>
        <dl>
          <div>
            <dt>Seed</dt>
            <dd>{simulation.seed}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>
              {simulation.model.provider}/{simulation.model.model}
            </dd>
          </div>
          <div>
            <dt>Engine</dt>
            <dd>{simulation.manifest.engineVersion}</dd>
          </div>
          <div>
            <dt>Prompt</dt>
            <dd>{simulation.manifest.promptVersion}</dd>
          </div>
        </dl>
        <p className="run-privacy-policy">
          Cloud model processing:{" "}
          {simulation.privacy?.allowCloud === false
            ? "blocked for this run"
            : "allowed"}
          . Web search:{" "}
          {simulation.privacy?.allowWebSearch
            ? "allowed"
            : "blocked for this run"}
          . Source access controls apply to model observations; full exports
          include all stored sources.
        </p>
        <p>
          Stored events can be replayed exactly. Live model outputs may differ
          when rerun, even with the same seed.
        </p>
      </div>
      <ExecutionHistory key={simulation.id} simulationId={simulation.id} />
    </div>
  );
}

function ReportView({
  simulation,
  onGenerate,
  busy,
  onEvent,
}: {
  simulation: Simulation;
  onGenerate: () => void;
  busy: string | null;
  onEvent: (id: string) => void;
}) {
  const report = simulation.report;
  return (
    <div className="detail-view report-view">
      <div className="view-heading">
        <div>
          <span className="eyebrow">THE RESEARCH NOTE</span>
          <h2>
            {report ? "What emerged." : "Turn interactions into insight."}
          </h2>
        </div>
        {report && (
          <span className="report-saved">
            <Check size={13} /> Saved report
          </span>
        )}
      </div>
      {!report ? (
        <div className="report-empty">
          <div className="report-illustration">
            <FileText size={35} strokeWidth={1} />
            <span />
            <span />
            <span />
          </div>
          <h3>Every conversation leaves a pattern.</h3>
          <p>
            Generate a research note with findings grounded in recorded events,
            source references and remaining uncertainties.
          </p>
          <button
            className="button primary"
            disabled={Boolean(busy) || !simulation.rounds.length}
            onClick={onGenerate}
          >
            {busy === "report" ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Layers3 size={16} />
            )}{" "}
            {busy === "report" ? "Writing research note…" : "Generate report"}
          </button>
          {!simulation.rounds.length && (
            <small>Complete at least one round first.</small>
          )}
        </div>
      ) : (
        <article className="research-report">
          <div className="report-masthead">
            <Mark small />
            <span>BRANCHLAB / RESEARCH NOTE</span>
            <span>
              {simulation.model.provider === "demo" ? "DEMO" : "SIMULATION"}
            </span>
          </div>
          <h3>{report.headline}</h3>
          <p className="report-summary">{report.summary}</p>
          <div className="report-findings">
            {report.findings.map((f, i) => (
              <section key={i}>
                <span className="finding-number">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div>
                  <h4>{f.title}</h4>
                  <p>{f.detail}</p>
                  <div className="evidence-links">
                    {f.eventIds.map((id) => (
                      <button key={id} onClick={() => onEvent(id)}>
                        <ArrowUpRight size={11} />
                        {id}
                      </button>
                    ))}
                  </div>
                </div>
              </section>
            ))}
          </div>
          <section className="report-uncertainties">
            <h4>What remains uncertain</h4>
            <ul>
              {report.uncertainties.map((u, i) => (
                <li key={i}>{u}</li>
              ))}
            </ul>
          </section>
          <div className="report-source-list">
            <span className="eyebrow">SOURCE REFERENCES</span>
            {report.sourceIds.length ? (
              report.sourceIds.map((id) => (
                <p key={id}>
                  <FileText size={13} />
                  {simulation.sources.find((s) => s.id === id)?.name ?? id}
                </p>
              ))
            ) : (
              <p>No document sources cited.</p>
            )}
          </div>
          <p className="report-disclaimer">
            This note describes a simulated scenario. It does not establish
            real-world probabilities or causal effects.
          </p>
        </article>
      )}
    </div>
  );
}

function Comparison({
  parent,
  simulation,
}: {
  parent: Simulation;
  simulation: Simulation;
}) {
  const metrics = simulation.rounds.at(-1)?.metrics,
    baseline = parent.rounds.at(-1)?.metrics;
  return (
    <section className="comparison-panel">
      <div>
        <span className="eyebrow">SCENARIO COMPARISON</span>
        <p>{simulation.interventions.at(-1)?.content}</p>
      </div>
      <div className="comparison-values">
        <div>
          <span>
            Baseline support<small>Round {parent.rounds.length}</small>
          </span>
          <strong>{baseline ? `${Math.round(baseline.support)}%` : "—"}</strong>
        </div>
        <ArrowRight size={19} />
        <div>
          <span>
            Branch support<small>Round {simulation.rounds.length}</small>
          </span>
          <strong>{metrics ? `${Math.round(metrics.support)}%` : "—"}</strong>
        </div>
        <div className="comparison-delta">
          <strong>
            {metrics && baseline
              ? `${metrics.support - baseline.support >= 0 ? "+" : ""}${Math.round(metrics.support - baseline.support)}pp`
              : "—"}
          </strong>
          <span>simulated difference</span>
        </div>
      </div>
      <small>
        Compares latest saved rounds; different horizons can affect the
        comparison.
      </small>
    </section>
  );
}

function EmptyState({
  Icon,
  title,
  description,
}: {
  Icon: typeof MessageSquare;
  title: string;
  description: string;
}) {
  return (
    <div className="empty-state">
      <Icon size={30} strokeWidth={1.2} />
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
