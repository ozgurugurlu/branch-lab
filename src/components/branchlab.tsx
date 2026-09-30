"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileText,
  FlaskConical,
  GitBranch,
  Globe2,
  Layers3,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
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
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type {
  Actor,
  AppConfig,
  CreateSimulationInput,
  Simulation,
  SimulationSummary,
} from "@/lib/types";
import { TEMPLATES, type ScenarioTemplate } from "@/lib/templates";
import {
  ActorNetwork,
  initials,
  PREVIEW_ACTORS,
  PREVIEW_RELATIONSHIPS,
  stanceLabel,
  Trajectory,
} from "./network";
import {
  BranchDialog,
  DeleteDialog,
  Dialog,
  NewSimulationDialog,
  SettingsDialog,
} from "./dialogs";

type View = "network" | "timeline" | "sources" | "report";
type Modal = "new" | "settings" | "branch" | "delete" | "about" | null;

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
      ...options?.headers,
    },
    cache: "no-store",
  });
  const result = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      result?.error?.message ??
        `The request could not be completed (${response.status}).`,
    );
  return result.data as T;
}
const post = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
});

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
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("network");
  const [modal, setModal] = useState<Modal>(null);
  const [template, setTemplate] = useState<ScenarioTemplate | undefined>();
  const [actorId, setActorId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [parent, setParent] = useState<Simulation | null>(null);
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [focusedEvent, setFocusedEvent] = useState<string | null>(null);
  const activeId = useRef<string | null>(null);
  const runLoop = useRef(false);
  const operationBusy = useRef(false);
  const closeModal = useCallback(() => setModal(null), []);

  const refreshRuns = useCallback(async () => {
    const list = await api<SimulationSummary[]>("/api/simulations");
    setRuns(list);
  }, []);
  const accept = useCallback((sim: Simulation) => {
    activeId.current = sim.id;
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
  }, []);

  const initialize = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const settings = await api<AppConfig>("/api/config");
      setConfig(settings);
      const list = await api<SimulationSummary[]>("/api/simulations");
      setRuns(list);
      let remembered: string | null = null;
      try {
        remembered = localStorage.getItem("branchlab-last-run");
      } catch {
        /* Private mode can deny storage. */
      }
      const id = list.some((r) => r.id === remembered)
        ? remembered
        : list[0]?.id;
      if (id) accept(await api<Simulation>(`/api/simulations/${id}`));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not open the workspace.",
      );
    } finally {
      setLoading(false);
    }
  }, [accept]);

  useEffect(() => {
    void Promise.resolve().then(initialize);
    return () => {
      runLoop.current = false;
    };
  }, [initialize]);
  useEffect(() => {
    let cancelled = false;
    if (simulation?.parentId)
      void api<Simulation>(`/api/simulations/${simulation.parentId}`)
        .then((p) => {
          if (!cancelled) setParent(p);
        })
        .catch(() => {
          if (!cancelled) setParent(null);
        });
    return () => {
      cancelled = true;
    };
  }, [simulation?.parentId]);

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
      setModal("new");
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [busy, modal]);

  function stop() {
    runLoop.current = false;
    setRunning(false);
  }
  async function selectRun(id: string) {
    if (operationBusy.current) return;
    stop();
    setBusy("load");
    setError(null);
    setSidebarOpen(false);
    setActorId(null);
    setComparisonOpen(false);
    operationBusy.current = true;
    try {
      accept(await api<Simulation>(`/api/simulations/${id}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open simulation.");
    } finally {
      setBusy(null);
      operationBusy.current = false;
    }
  }
  async function step(start: Simulation, auto = false) {
    if (operationBusy.current || start.rounds.length >= start.maxRounds) return;
    operationBusy.current = true;
    runLoop.current = auto;
    setRunning(auto);
    setError(null);
    setBusy("step");
    let current = start;
    try {
      do {
        const next = await api<Simulation>(
          `/api/simulations/${current.id}/step`,
          post({ expectedRound: current.rounds.length }),
        );
        if (activeId.current === next.id) accept(next);
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
      setError(
        e instanceof Error
          ? e.message
          : "This round could not complete. Your previous rounds are saved.",
      );
    } finally {
      runLoop.current = false;
      setRunning(false);
      setBusy(null);
      operationBusy.current = false;
    }
  }
  async function create(input: CreateSimulationInput, runImmediately = false) {
    if (operationBusy.current) return;
    operationBusy.current = true;
    setBusy("create");
    setError(null);
    try {
      const sim = await api<Simulation>("/api/simulations", post(input));
      accept(sim);
      setModal(null);
      setView("network");
      setActorId(null);
      setComparisonOpen(false);
      operationBusy.current = false;
      setBusy(null);
      if (runImmediately) await step(sim, true);
    } catch (e) {
      if (runImmediately)
        setError(e instanceof Error ? e.message : "Could not create demo.");
      else throw e;
    } finally {
      operationBusy.current = false;
      setBusy(null);
    }
  }
  async function exploreDemo() {
    const model =
      config?.providers.find((p) => p.id === "demo")?.models[0]?.id ??
      "branchlab-demo";
    await create(
      {
        ...TEMPLATES[0].input,
        model: { provider: "demo", model },
        seed: 42,
        maxRounds: 6,
        actorCount: 8,
      },
      true,
    );
  }
  async function branch(intervention: string, title: string) {
    if (!simulation || operationBusy.current) return;
    operationBusy.current = true;
    setBusy("branch");
    try {
      const next = await api<Simulation>(
        `/api/simulations/${simulation.id}/branch`,
        post({ intervention, title }),
      );
      accept(next);
      setModal(null);
      setActorId(null);
      setView("network");
      setComparisonOpen(true);
    } finally {
      operationBusy.current = false;
      setBusy(null);
    }
  }
  async function report() {
    if (!simulation || operationBusy.current) return;
    operationBusy.current = true;
    setBusy("report");
    setError(null);
    try {
      accept(
        await api<Simulation>(
          `/api/simulations/${simulation.id}/report`,
          post({}),
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not generate report.");
    } finally {
      operationBusy.current = false;
      setBusy(null);
    }
  }
  async function sendMessage(message: string) {
    if (!simulation || operationBusy.current) return;
    operationBusy.current = true;
    setBusy("chat");
    try {
      accept(
        await api<Simulation>(
          `/api/simulations/${simulation.id}/chat`,
          post({ message, ...(actorId ? { actorId } : {}) }),
        ),
      );
    } finally {
      operationBusy.current = false;
      setBusy(null);
    }
  }
  async function deleteSimulation() {
    if (!simulation || operationBusy.current) return;
    operationBusy.current = true;
    setBusy("delete");
    setError(null);
    try {
      await api(`/api/simulations/${simulation.id}`, { method: "DELETE" });
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
      setError(e instanceof Error ? e.message : "Could not delete simulation.");
    } finally {
      operationBusy.current = false;
      setBusy(null);
    }
  }
  function newRun(t?: ScenarioTemplate) {
    stop();
    setTemplate(t);
    setModal("new");
  }
  const selectedActor =
    simulation?.world.actors.find((a) => a.id === actorId) ?? null;
  const latest = simulation?.rounds.at(-1);
  const validParent = parent?.id === simulation?.parentId ? parent : null;
  const canStep = simulation && simulation.rounds.length < simulation.maxRounds;
  const currentModel =
    config?.providers
      .find((p) => p.id === simulation?.model.provider)
      ?.models.find((m) => m.id === simulation?.model.model)?.name ??
    simulation?.model.model;
  const statusText =
    busy === "step"
      ? running
        ? "Simulation running"
        : "Finishing round"
      : simulation?.status === "completed"
        ? "Simulation complete"
        : "Ready to explore";

  return (
    <div className={`app-shell ${sidebarOpen ? "sidebar-visible" : ""}`}>
      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className="sidebar">
        <Link className="brand" href="/" aria-label="Branchlab home">
          <Mark />
          <span>
            branchlab<span className="brand-period">.</span>
          </span>
        </Link>
        <div className="workspace-label">
          <span className="workspace-dot" /> Personal laboratory{" "}
          <span className="version-label">v0.1</span>
        </div>
        <button
          className="button new-run-button"
          disabled={Boolean(busy)}
          onClick={() => newRun()}
        >
          <Plus size={17} /> New simulation{" "}
          <span className="button-shortcut">N</span>
        </button>
        <div className="sidebar-section-title">
          YOUR SIMULATIONS{" "}
          <span>{runs.length.toString().padStart(2, "0")}</span>
        </div>
        <nav className="run-list" aria-label="Saved simulations">
          {runs.length ? (
            runs.map((run) => (
              <button
                key={run.id}
                disabled={Boolean(busy)}
                className={`run-item ${simulation?.id === run.id ? "is-active" : ""}`}
                onClick={() => void selectRun(run.id)}
              >
                <span className="run-symbol">
                  {run.parentId ? (
                    <GitBranch size={16} />
                  ) : (
                    <Globe2 size={16} />
                  )}
                </span>
                <span className="run-copy">
                  <strong>{run.title}</strong>
                  <small>
                    {run.roundCount}/{run.maxRounds} rounds <span>·</span>{" "}
                    {run.provider === "demo"
                      ? "Demo"
                      : run.provider === "google"
                        ? "Gemini"
                        : run.provider}
                  </small>
                </span>
                {simulation?.id === run.id && (
                  <span className="run-active-dot" />
                )}
              </button>
            ))
          ) : (
            <p className="empty-runs">Your experiments will appear here.</p>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="lab-note">
            <Mark small />
            <p>
              A space to ask
              <br />
              <em>what happens next?</em>
            </p>
          </div>
          <button className="sidebar-link" onClick={() => setModal("settings")}>
            <Settings2 size={16} /> Model settings{" "}
            <span className="connection-dot" />
          </button>
          <button className="sidebar-link" onClick={() => setModal("about")}>
            <CircleHelp size={16} /> About the laboratory{" "}
            <ArrowUpRight size={13} />
          </button>
          <div className="sidebar-footer">
            <span className="avatar-mini">Y</span>
            <span>
              Your workspace
              <small>
                {config?.storage === "remote"
                  ? "Remote persistence"
                  : "Local persistence"}
              </small>
            </span>
            <button
              className="icon-button"
              aria-label="Workspace settings"
              onClick={() => setModal("settings")}
            >
              <MoreHorizontal size={18} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main-workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-nav-toggle"
              aria-label="Toggle navigation"
              onClick={() => setSidebarOpen(!sidebarOpen)}
            >
              {sidebarOpen ? (
                <PanelLeftClose size={18} />
              ) : (
                <PanelLeftOpen size={18} />
              )}
            </button>
            <Layers3 size={15} />
            <span>Laboratory</span>
            <ChevronRight size={13} />
            <strong>{simulation ? "Simulation workspace" : "Overview"}</strong>
          </div>
          <div className="topbar-right">
            <span className="open-source-label">
              <span /> Open source
            </span>
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
            <span>{error}</span>
            <button
              className="text-button"
              disabled={Boolean(busy)}
              onClick={() =>
                simulation ? void selectRun(simulation.id) : void initialize()
              }
            >
              <RotateCcw size={13} /> Retry
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
        {loading ? (
          <div className="workspace-loading">
            <Mark />
            <LoaderCircle size={18} className="spin" />
            <span>Opening your laboratory…</span>
          </div>
        ) : simulation ? (
          <>
            <section className="simulation-heading">
              <div>
                <div className="eyebrow simulation-eyebrow">
                  <span className={`status-dot ${running ? "pulsing" : ""}`} />
                  {statusText}
                  <span className="eyebrow-divider">/</span>
                  <span>
                    {simulation.model.provider === "demo"
                      ? "DETERMINISTIC DEMO"
                      : currentModel}
                  </span>
                </div>
                <h1>{simulation.title}</h1>
                <p>{simulation.question}</p>
              </div>
              <div className="heading-actions">
                <button
                  className="button secondary"
                  disabled={Boolean(busy) || simulation.rounds.length >= 24}
                  onClick={() => setModal("branch")}
                >
                  <GitBranch size={15} /> Branch
                  <span className="desktop-only"> scenario</span>
                </button>
                <div className="export-wrap">
                  <button
                    className="icon-button outlined"
                    aria-label="Export and manage simulation"
                    aria-expanded={exportOpen}
                    onClick={() => setExportOpen(!exportOpen)}
                  >
                    <MoreHorizontal size={18} />
                  </button>
                  {exportOpen && (
                    <>
                      <button
                        className="menu-dismiss"
                        aria-label="Close export menu"
                        onClick={() => setExportOpen(false)}
                      />
                      <div className="dropdown-menu">
                        <a
                          href={`/api/simulations/${simulation.id}/export?format=markdown`}
                          onClick={() => setExportOpen(false)}
                        >
                          <FileText size={15} /> Export Markdown
                        </a>
                        <a
                          href={`/api/simulations/${simulation.id}/export?format=json`}
                          onClick={() => setExportOpen(false)}
                        >
                          <ArrowDownToLine size={15} /> Export full JSON
                        </a>
                        <button
                          disabled={Boolean(busy)}
                          onClick={() => {
                            setModal("delete");
                            setExportOpen(false);
                          }}
                        >
                          <Trash2 size={15} /> Delete simulation
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </section>
            {simulation.parentId && (
              <div className="branch-banner">
                <GitBranch size={14} />
                <span>
                  Branched from {validParent?.title ?? "a saved simulation"} at
                  round {simulation.forkRound}
                </span>
                {validParent && (
                  <button
                    className="text-button"
                    onClick={() => setComparisonOpen(!comparisonOpen)}
                  >
                    {comparisonOpen ? "Hide comparison" : "Compare outcomes"}
                    <ChevronDown
                      className={comparisonOpen ? "rotate-180" : ""}
                      size={14}
                    />
                  </button>
                )}
              </div>
            )}
            {comparisonOpen && validParent && (
              <Comparison parent={validParent} simulation={simulation} />
            )}
            <div className="workspace-columns">
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
                    aria-label="Open conversation panel"
                    onClick={() => setInspectorOpen(true)}
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
                        ROUND{" "}
                        {String(simulation.rounds.length).padStart(2, "0")}{" "}
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
                          setInspectorOpen(true);
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
                          latest
                            ? `${Math.round(latest.metrics.support)}%`
                            : "—"
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
                      setInspectorOpen(true);
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
                              : i === simulation.rounds.length &&
                                  busy === "step"
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
                      disabled={!canStep || Boolean(busy)}
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
                        disabled={!canStep || Boolean(busy)}
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
                  <ShieldCheck size={12} /> Simulated perspectives, not
                  calibrated predictions.{" "}
                  <span>{simulation.usage.modelCalls} model operations</span>
                </div>
              </section>
              <aside
                className={`inspector ${inspectorOpen ? "inspector-visible" : ""}`}
              >
                <button
                  className="icon-button inspector-close"
                  aria-label="Close conversation panel"
                  onClick={() => setInspectorOpen(false)}
                >
                  <X size={18} />
                </button>
                <Inspector
                  key={`${simulation.id}-${actorId ?? "analyst"}`}
                  simulation={simulation}
                  actor={selectedActor}
                  onDeselect={() => setActorId(null)}
                  busy={busy}
                  onSend={sendMessage}
                />
              </aside>
            </div>
          </>
        ) : (
          <Welcome
            busy={busy}
            onDemo={() => void exploreDemo()}
            onNew={newRun}
          />
        )}
      </main>
      {modal === "new" && (
        <NewSimulationDialog
          config={config}
          initialTemplate={template}
          onClose={closeModal}
          onCreate={create}
          busy={busy === "create"}
        />
      )}
      {modal === "settings" && (
        <SettingsDialog
          config={config}
          onClose={closeModal}
          workspaceBusy={Boolean(busy)}
          onAuthenticate={async (password) => {
            await api("/api/session", post({ password }));
            await initialize();
          }}
          onLock={async () => {
            if (operationBusy.current)
              throw new Error(
                "Wait for the current operation to finish before locking.",
              );
            stop();
            await api("/api/session", { method: "DELETE" });
            setSimulation(null);
            setRuns([]);
            setParent(null);
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

function Welcome({
  busy,
  onDemo,
  onNew,
}: {
  busy: string | null;
  onDemo: () => void;
  onNew: (template?: ScenarioTemplate) => void;
}) {
  return (
    <section className="welcome">
      <div className="welcome-heading">
        <div className="eyebrow">
          <span className="status-dot" /> YOUR SCENARIO LABORATORY
        </div>
        <h1>
          One question.
          <br />
          Many possible futures<span>.</span>
        </h1>
        <p>
          Build a world of different perspectives.
          <br />
          Introduce a change. Follow what happens next.
        </p>
        <div className="welcome-actions">
          <button
            className="button primary"
            onClick={onDemo}
            disabled={Boolean(busy)}
          >
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Play size={14} fill="currentColor" />
            )}
            {busy ? "Building your world…" : "Explore a demo"}
          </button>
          <button
            className="button text"
            onClick={() => onNew()}
            disabled={Boolean(busy)}
          >
            Create your own <ArrowRight size={15} />
          </button>
        </div>
        <span className="demo-note">
          <FlaskConical size={13} /> No API key needed for the demo
        </span>
      </div>
      <div className="welcome-network">
        <div className="preview-corner">
          <span className="eyebrow">A WORLD OF PERSPECTIVES</span>
          <span className="preview-caption">
            Illustrative network · 8 actors
          </span>
        </div>
        <ActorNetwork
          actors={PREVIEW_ACTORS}
          relationships={PREVIEW_RELATIONSHIPS}
          selected={null}
          onSelect={onDemo}
          preview
        />
        <div className="preview-bottom">
          <span className="preview-live-dot" /> The four-day experiment{" "}
          <ArrowUpRight size={15} />
        </div>
      </div>
      <div className="welcome-templates">
        <div className="section-label">
          <span>START WITH A QUESTION</span>
          <span className="muted">Or bring your own.</span>
        </div>
        {TEMPLATES.map((t, i) => (
          <button
            className="template-row"
            key={t.id}
            disabled={Boolean(busy)}
            onClick={() => onNew(t)}
          >
            <span className="template-number">0{i + 1}</span>
            <span className="template-info">
              <small>{t.category}</small>
              <strong>{t.label}</strong>
            </span>
            <span className="template-description">{t.description}</span>
            <ArrowUpRight size={19} />
          </button>
        ))}
      </div>
      <div className="welcome-footer">
        <span>
          Ground your scenario in sources. Keep your assumptions visible.
        </span>
        <span>
          <ShieldCheck size={13} /> Simulation, with perspective.
        </span>
      </div>
    </section>
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
                    {source.id}
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
        <p>
          Stored events can be replayed exactly. Live model outputs may differ
          when rerun, even with the same seed.
        </p>
      </div>
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

function Inspector({
  simulation,
  actor,
  onDeselect,
  busy,
  onSend,
}: {
  simulation: Simulation;
  actor: Actor | null;
  onDeselect: () => void;
  busy: string | null;
  onSend: (message: string) => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = simulation.messages.filter(
    (m) => m.actorId === (actor?.id ?? null),
  );
  useEffect(() => {
    if (scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, busy]);
  async function submit(text: string) {
    if (!text.trim() || busy) return;
    setError("");
    try {
      await onSend(text.trim());
      setMessage("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send your message.");
    }
  }
  const suggestions = actor
    ? ["What matters most to you?", "What would change your mind?"]
    : ["Where do the actors disagree?", "What should I try changing?"];
  return (
    <>
      <div className="inspector-heading">
        {actor ? (
          <button className="text-button" onClick={onDeselect}>
            <ArrowLeft size={14} /> Back to analyst
          </button>
        ) : (
          <span className="eyebrow">A CLOSER LOOK</span>
        )}
        <div className="inspector-identity">
          <span className={actor ? "actor-avatar large" : "analyst-icon"}>
            {actor ? (
              initials(actor.name)
            ) : (
              <Sparkles size={22} strokeWidth={1.5} />
            )}
          </span>
          <div>
            <h2>{actor?.name ?? "Your research partner"}</h2>
            <span>{actor?.role ?? "Ask the simulation analyst"}</span>
          </div>
        </div>
        {actor ? (
          <>
            <p className="actor-description">{actor.description}</p>
            <div className="actor-stance">
              <span>{stanceLabel(actor.stance)}</span>
              <div>
                <span style={{ left: `${(actor.stance + 1) * 50}%` }} />
              </div>
            </div>
            <details className="actor-details">
              <summary>
                Goals & memory <ChevronDown size={13} />
              </summary>
              <h4>Current goal</h4>
              <p>{actor.goal}</p>
              <h4>Recent memories</h4>
              {actor.memory.length ? (
                actor.memory.slice(-4).map((m, i) => (
                  <p key={i} className="memory-entry">
                    {m}
                  </p>
                ))
              ) : (
                <p>No experiences recorded yet.</p>
              )}
              {actor.sourceIds.length > 0 && (
                <>
                  <h4>Source grounding</h4>
                  {actor.sourceIds.map((id) => (
                    <p key={id}>
                      {simulation.sources.find((s) => s.id === id)?.name ?? id}
                    </p>
                  ))}
                </>
              )}
            </details>
          </>
        ) : (
          <p className="inspector-description">
            Make sense of the conversation, explore a perspective, or find the
            next question to ask.
          </p>
        )}
      </div>
      <div
        className="chat-history"
        ref={scrollRef}
        aria-live="polite"
        aria-label="Conversation"
      >
        {!messages.length && (
          <div className="chat-welcome">
            <span className="chat-section-label">
              {actor ? "INTERVIEW THIS ACTOR" : "START A CONVERSATION"}
            </span>
            <p>
              {actor
                ? `Ask ${actor.name.split(" ")[0]} about their experience in this world.`
                : simulation.rounds.length
                  ? "The world is taking shape. What would you like to understand?"
                  : "Your world is ready. Run a round, or ask about its starting assumptions."}
            </p>
            <div className="suggestions">
              {suggestions.map((s) => (
                <button
                  key={s}
                  disabled={Boolean(busy)}
                  onClick={() => void submit(s)}
                >
                  {s}
                  <ArrowUpRight size={13} />
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div className={`chat-message ${m.role}`} key={m.id}>
            <div className="chat-message-label">
              <span>
                {m.role === "user" ? "You" : (actor?.name ?? "Analyst")}
              </span>
              <small>Round {m.round}</small>
            </div>
            <p>{m.content}</p>
          </div>
        ))}
        {busy === "chat" && (
          <div className="chat-thinking">
            <span />
            <span />
            <span />
            <small>
              {actor ? "Considering your question" : "Reading the simulation"}
            </small>
          </div>
        )}
      </div>
      <div className="chat-composer-area">
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <form
          className="chat-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(message);
          }}
        >
          <label className="sr-only" htmlFor="chat-message">
            {actor ? `Message ${actor.name}` : "Message analyst"}
          </label>
          <textarea
            id="chat-message"
            rows={2}
            maxLength={2000}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={
              actor
                ? `Ask ${actor.name.split(" ")[0]}…`
                : "Ask about this world…"
            }
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit(message);
              }
            }}
          />
          <div className="composer-footer">
            <span>
              <MessageSquare size={12} />{" "}
              {actor ? "Actor interview" : "Simulation context"}
            </span>
            <button
              type="submit"
              className="send-button"
              aria-label="Send message"
              disabled={Boolean(busy) || !message.trim()}
            >
              {busy === "chat" ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <ArrowRight size={16} />
              )}
            </button>
          </div>
        </form>
        <p className="chat-disclaimer">
          {simulation.model.provider === "demo"
            ? "Demo responses · no language model"
            : "Generated responses · verify against sources"}
        </p>
      </div>
    </>
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
