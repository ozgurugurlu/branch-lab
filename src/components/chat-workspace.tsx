"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  FileText,
  FlaskConical,
  GitBranch,
  Globe2,
  LoaderCircle,
  Network,
  Paperclip,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  ShieldCheck,
  SkipForward,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import type {
  AppConfig,
  CreateSimulationInput,
  ModelConfig,
  Simulation,
} from "@/lib/types";
import {
  PROVIDERS,
  getInitialModelConfig,
  providerUnavailableReason,
} from "@/lib/providers";
import { ModelPicker } from "./model-picker";
import { CAPABILITY_PROFILES, capabilityProfileFor } from "@/lib/capabilities";
import { TEMPLATES, type ScenarioTemplate } from "@/lib/templates";
import { initials, stanceLabel } from "./network";
import { InlineRequestError } from "./request-error";
import { ProcessTrace } from "./process-trace";
import { InlineSimulationReport } from "./simulation-report";
import type { RequestError } from "./client-api";

type View = "network" | "timeline" | "sources" | "report";
export interface PendingCreation {
  id: string;
  input: CreateSimulationInput;
  runImmediately: boolean;
  requestId: string | null;
  error: RequestError | null;
}
interface Props {
  config: AppConfig | null;
  simulation: Simulation | null;
  creation: PendingCreation | null;
  onRetryCreation: () => void;
  onEditCreation: () => void;
  actorId: string | null;
  busy: string | null;
  running: boolean;
  pauseRequested: boolean;
  online: boolean;
  onActorChange: (id: string | null) => void;
  onSend: (message: string) => Promise<void>;
  onStart: (input: CreateSimulationInput) => void;
  onConfigure: (input: CreateSimulationInput) => void;
  onTemplate: (template: ScenarioTemplate) => void;
  onDemo: () => void;
  onOpenWorkspace: (view?: View) => void;
  onGenerateReport: () => void;
  onViewEvent: (id: string) => void;
  onViewSource: (id: string) => void;
  reportError: RequestError | null;
  onRun: (auto: boolean) => Promise<void>;
  onPause: () => void;
  onBranch: () => void;
  onDelete: () => void;
}

export function ChatWorkspace(props: Props) {
  const { simulation, creation, config, busy, actorId } = props;
  const [text, setText] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [model, setModel] = useState<ModelConfig>(() =>
    getInitialModelConfig(config?.providers ?? PROVIDERS),
  );
  const [manualModel, setManualModel] = useState(false);
  const [menu, setMenu] = useState(false);
  const creationFocus = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const creationId = creation?.id;
  useEffect(() => {
    if (!creationId) return;
    const frame = requestAnimationFrame(() =>
      creationFocus.current?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [creationId]);
  const menuRef = useRef<HTMLDivElement>(null);
  const providers = config?.providers ?? PROVIDERS;
  const selectedModel = simulation?.model ?? creation?.input.model ?? model;
  const actor = simulation?.world.actors.find((item) => item.id === actorId);
  const messages =
    simulation?.messages.filter((item) => item.actorId === (actorId ?? null)) ??
    [];
  const last = simulation?.rounds.at(-1);
  const profile = actor ? capabilityProfileFor(actor) : null;
  const capability = profile ? CAPABILITY_PROFILES[profile] : null;
  const canRun = simulation && simulation.rounds.length < simulation.maxRounds;
  const disabled = Boolean(busy) || !props.online;
  useEffect(() => {
    const panel = scroll.current;
    if (panel) panel.scrollTop = panel.scrollHeight;
  }, [messages.length, actorId]);
  useEffect(() => {
    if (!menu) return;
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenu(false);
        menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", escape);
    };
  }, [menu]);
  function draft(question = text): CreateSimulationInput {
    return {
      title: "",
      question: question.trim(),
      context: "",
      model,
      actorCount: 8,
      maxRounds: 6,
      seed: 42,
      sources: [],
      privacy: { allowCloud: false },
    };
  }
  async function submit(question = text) {
    if (disabled || creation || !question.trim()) return;
    setError(null);
    try {
      if (!simulation) {
        const provider = providers.find((item) => item.id === model.provider);
        if (!provider?.configured)
          throw new Error(
            provider
              ? providerUnavailableReason(provider)
              : "Choose an available model.",
          );
        if (question.trim().length < 12)
          throw new Error("Describe your scenario in at least 12 characters.");
        if (model.provider === "openai" || model.provider === "google") {
          props.onConfigure(draft(question));
          return;
        }
        props.onStart(draft(question));
        return;
      } else await props.onSend(question.trim());
      if (!mounted.current) return;
      setText((current) => (current.trim() === question.trim() ? "" : current));
    } catch (reason) {
      if (mounted.current) setError(reason);
    }
  }
  const composer = (
    <form
      className="conversation-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <textarea
        ref={input}
        aria-label={
          simulation || creation
            ? actor
              ? `Message ${actor.name}`
              : "Message analyst"
            : "Describe a scenario"
        }
        value={text}
        disabled={Boolean(creation)}
        onChange={(event) => setText(event.target.value)}
        rows={simulation || creation ? 2 : 3}
        maxLength={2000}
        placeholder={
          creation
            ? creation.error
              ? "Resolve scenario creation before sending a message…"
              : "Preparing your simulation…"
            : simulation
              ? actor
                ? `Ask ${actor.name.split(" ")[0]} about this world…`
                : "Ask a question about this simulation…"
              : "What would you like to explore?"
        }
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="conversation-composer-toolbar">
        <button
          type="button"
          className="composer-add"
          aria-label={
            simulation
              ? "Open source documents"
              : "Add sources and configure scenario"
          }
          disabled={disabled || Boolean(creation)}
          onClick={() =>
            simulation
              ? props.onOpenWorkspace("sources")
              : props.onConfigure(draft())
          }
        >
          <Plus size={19} />
        </button>
        {simulation ? (
          <label className="composer-recipient">
            <Users size={14} />
            <span className="sr-only">Conversation recipient</span>
            <select
              aria-label="Conversation recipient"
              value={actorId ?? "analyst"}
              disabled={Boolean(busy)}
              onChange={(event) =>
                props.onActorChange(
                  event.target.value === "analyst" ? null : event.target.value,
                )
              }
            >
              <option value="analyst">Simulation analyst</option>
              {simulation.world.actors.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <button
            type="button"
            className="composer-context"
            disabled={disabled || Boolean(creation)}
            onClick={() => props.onConfigure(draft())}
          >
            <Paperclip size={14} />
            <span>Add context</span>
          </button>
        )}
        <div className="composer-right">
          {simulation || creation ? (
            <span className="composer-model-static">
              {providers
                .find((provider) => provider.id === selectedModel.provider)
                ?.models.find((item) => item.id === selectedModel.model)
                ?.name ?? selectedModel.model}
            </span>
          ) : (
            <ModelPicker
              value={model}
              providers={providers}
              disabled={disabled}
              onChange={(next) => {
                setModel(next);
                setManualModel(true);
              }}
            />
          )}
          {props.running ? (
            <button
              className="composer-submit stop"
              type="button"
              aria-label="Pause simulation after current round"
              onClick={props.onPause}
            >
              <Pause size={15} />
            </button>
          ) : (
            <button
              className="composer-submit"
              type="submit"
              aria-label={
                simulation || creation ? "Send message" : "Start simulation"
              }
              disabled={disabled || Boolean(creation) || !text.trim()}
            >
              {busy ? (
                <LoaderCircle size={17} className="spin" />
              ) : (
                <ArrowUp size={19} />
              )}
            </button>
          )}
        </div>
      </div>
    </form>
  );
  return (
    <div
      className={`conversation-layout ${simulation || creation ? "has-conversation" : "new-conversation"}`}
    >
      <div className="conversation-scroll" ref={scroll}>
        {!simulation && !creation ? (
          <div className="chat-home">
            <div className="chat-home-greeting">
              <span className="chat-home-symbol">
                <Sparkles size={27} strokeWidth={1.6} />
              </span>
              <h1>What happens if…</h1>
            </div>
            <p className="chat-home-subtitle">
              Explore a question through a world of different perspectives.
            </p>
            <div className="home-composer">{composer}</div>
            {!manualModel &&
              model.provider === "demo" &&
              !providers.find((provider) => provider.id === "google")
                ?.configured && (
                <p className="model-default-note">
                  Gemini isn’t configured here. Demo is selected and makes no
                  model requests.
                </p>
              )}
            <div className="chat-starters">
              {TEMPLATES.map((template) => (
                <button
                  key={template.id}
                  disabled={disabled}
                  onClick={() => props.onTemplate(template)}
                >
                  {template.id === "pricing" ? (
                    <Globe2 size={14} />
                  ) : template.id === "car-free" ? (
                    <Network size={14} />
                  ) : (
                    <Users size={14} />
                  )}{" "}
                  {template.label}
                </button>
              ))}
            </div>
            <button
              className="explore-demo-link"
              disabled={disabled}
              onClick={() => {
                setError(null);
                try {
                  props.onDemo();
                } catch (reason) {
                  setError(reason);
                }
              }}
            >
              <FlaskConical size={14} />
              Explore a demo<span>· No API key needed</span>
              <ArrowRight size={13} />
            </button>
            <p className="home-data-note">
              <ShieldCheck size={12} />
              Demo runs stay in the configured workspace database. Cloud models
              require explicit consent.
            </p>
            <InlineRequestError error={error} context="draft" />
          </div>
        ) : (
          <div className="conversation-content">
            <div className="conversation-user-message">
              <span>You</span>
              <p>{simulation?.question ?? creation?.input.question}</p>
            </div>
            {creation && (
              <div
                ref={creationFocus}
                tabIndex={-1}
                className="creation-summary"
                aria-label="Scenario creation"
              >
                <span>
                  {providers.find(
                    (provider) => provider.id === creation.input.model.provider,
                  )?.name ?? creation.input.model.provider}{" "}
                  · {creation.input.actorCount} actors ·{" "}
                  {creation.input.maxRounds} rounds
                  {creation.input.sources.length
                    ? ` · ${creation.input.sources.length} source documents`
                    : ""}
                </span>
              </div>
            )}
            <ProcessTrace
              simulationId={simulation?.id}
              requestId={creation ? creation.requestId : undefined}
              busy={busy}
            />
            {creation &&
              (creation.error ? (
                <section
                  className="creation-recovery"
                  aria-label="Scenario needs attention"
                >
                  <InlineRequestError error={creation.error} context="draft" />
                  <p>
                    Your scenario, source documents and settings are kept in
                    this tab.
                  </p>
                  <div>
                    <button
                      className="button primary small"
                      disabled={disabled}
                      onClick={props.onRetryCreation}
                    >
                      <RotateCcw size={14} />
                      Retry simulation
                    </button>
                    <button
                      className="button secondary small"
                      disabled={Boolean(busy)}
                      onClick={props.onEditCreation}
                    >
                      <Settings2 size={14} />
                      Edit scenario
                    </button>
                  </div>
                </section>
              ) : (
                <p className="creation-status" role="status">
                  Creating your simulation. Activity appears here as it is
                  recorded.
                </p>
              ))}
            {simulation && (
              <>
                <div className="conversation-assistant-intro">
                  <span className="assistant-brand">
                    <Sparkles size={17} />
                    {simulation.model.provider === "demo"
                      ? "Branchlab · deterministic demo"
                      : "Branchlab"}
                  </span>
                  <p>{simulation.world.summary}</p>
                </div>
                <article className="simulation-artifact">
                  <div className="artifact-header">
                    <span className="artifact-symbol">
                      <Network size={19} />
                    </span>
                    <div>
                      <h2>{simulation.title}</h2>
                      <span>
                        {simulation.world.actors.length} actors ·{" "}
                        {simulation.rounds.length}/{simulation.maxRounds} rounds
                        ·{" "}
                        {simulation.status === "completed"
                          ? "Complete"
                          : busy === "step"
                            ? "Running"
                            : "Ready"}
                      </span>
                    </div>
                    <div className="artifact-more" ref={menuRef}>
                      <button
                        className="icon-button"
                        aria-label="Export and manage simulation"
                        aria-expanded={menu}
                        onClick={() => setMenu(!menu)}
                      >
                        <ChevronDown size={15} />
                      </button>
                      {menu && (
                        <div className="artifact-menu">
                          <a
                            href={`/api/simulations/${simulation.id}/export?format=json`}
                            onClick={() => setMenu(false)}
                          >
                            <ArrowDownToLine size={14} />
                            Export full JSON
                          </a>
                          <a
                            href={`/api/simulations/${simulation.id}/export?format=markdown`}
                            onClick={() => setMenu(false)}
                          >
                            <FileText size={14} />
                            Export Markdown
                          </a>
                          <button
                            disabled={disabled}
                            onClick={() => {
                              setMenu(false);
                              props.onDelete();
                            }}
                          >
                            <Trash2 size={14} />
                            Delete simulation
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="artifact-metrics">
                    <div>
                      <span>Simulated support</span>
                      <strong>
                        {last ? `${Math.round(last.metrics.support)}%` : "—"}
                      </strong>
                    </div>
                    <div>
                      <span>Disagreement</span>
                      <strong>
                        {last
                          ? `${Math.round(last.metrics.polarization)}%`
                          : "—"}
                      </strong>
                    </div>
                    <div>
                      <span>Interactions</span>
                      <strong>
                        {simulation.rounds.reduce(
                          (total, round) => total + round.events.length,
                          0,
                        )}
                      </strong>
                    </div>
                  </div>
                  <div className="artifact-tabs">
                    {(
                      [
                        { id: "network", label: "Network", Icon: Network },
                        { id: "timeline", label: "Timeline", Icon: Globe2 },
                        { id: "sources", label: "Sources", Icon: FileText },
                        { id: "report", label: "Report", Icon: Sparkles },
                      ] as const
                    ).map((tab) => (
                      <button
                        key={tab.id}
                        onClick={() => props.onOpenWorkspace(tab.id)}
                      >
                        <tab.Icon size={14} />
                        {tab.label}
                        <ArrowRight size={12} />
                      </button>
                    ))}
                  </div>
                  <div className="artifact-controls">
                    <span>
                      {simulation.rounds.length} of {simulation.maxRounds}{" "}
                      rounds complete
                    </span>
                    <button
                      className="text-button"
                      disabled={disabled || simulation.rounds.length >= 24}
                      onClick={props.onBranch}
                    >
                      <GitBranch size={14} />
                      Branch scenario
                    </button>
                    <button
                      className="button secondary small"
                      title="Run a single round and pause"
                      aria-label="Run one round"
                      disabled={disabled || !canRun}
                      onClick={() => void props.onRun(false)}
                    >
                      <SkipForward size={15} /> Run one round
                    </button>
                    {props.running ? (
                      <button
                        className="button secondary small"
                        onClick={props.onPause}
                      >
                        <Pause size={13} />
                        Pause
                      </button>
                    ) : (
                      <button
                        className="button primary small"
                        disabled={disabled || !canRun}
                        onClick={() => void props.onRun(true)}
                      >
                        {canRun ? <Play size={12} /> : <Check size={13} />}{" "}
                        {canRun
                          ? simulation.rounds.length
                            ? "Resume simulation"
                            : "Run simulation"
                          : "Completed"}
                      </button>
                    )}
                  </div>
                </article>
                <InlineSimulationReport
                  simulation={simulation}
                  busy={busy}
                  error={props.reportError}
                  online={props.online}
                  onGenerate={props.onGenerateReport}
                  onEvent={props.onViewEvent}
                  onSource={props.onViewSource}
                />
                {busy === "step" && (
                  <p className="conversation-operation-note" role="status">
                    {props.pauseRequested
                      ? "Pause requested. This round will finish and be saved; the next round will not start."
                      : props.running
                        ? `Running round ${simulation.rounds.length + 1} of ${simulation.maxRounds}. Remaining rounds and the report will follow automatically.`
                        : "Running one round. Each completed round is saved."}
                  </p>
                )}
                {actor && (
                  <div className="conversation-actor-context">
                    <span className="actor-avatar">{initials(actor.name)}</span>
                    <div>
                      <strong>{actor.name}</strong>
                      <span>
                        {actor.role} · {stanceLabel(actor.stance)}
                      </span>
                      <details>
                        <summary>Perspective & memory</summary>
                        <p>{actor.description}</p>
                        <p>Goal: {actor.goal}</p>
                        {actor.memory.slice(-4).map((memory, index) => (
                          <p key={index}>{memory}</p>
                        ))}
                      </details>
                      {capability && (
                        <details className="actor-tool-access">
                          <summary>Tools & access · {capability.label}</summary>
                          <p>{capability.description}</p>
                          <ul>
                            {capability.tools.map((tool) => (
                              <li key={tool}>
                                <Check size={12} />
                                <span>{tool.replaceAll("_", " ")}</span>
                              </li>
                            ))}
                            {profile === "research" && (
                              <li>
                                <Globe2 size={12} />
                                <span>
                                  Web search{" "}
                                  <small>
                                    {simulation.model.provider === "demo"
                                      ? "Unavailable in demo"
                                      : !simulation.privacy?.allowWebSearch
                                        ? "Disabled · run consent not granted"
                                        : !config?.webSearchConfigured
                                          ? "Disabled · server not configured"
                                          : "Allowed · Brave Search"}
                                  </small>
                                </span>
                              </li>
                            )}
                          </ul>
                          <p>
                            These are this role’s available tools. Recorded
                            execution activity shows which tools actually ran.
                          </p>
                        </details>
                      )}
                    </div>
                    <button
                      className="icon-button"
                      aria-label="Back to analyst"
                      onClick={() => props.onActorChange(null)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}
                {messages.map((message) => (
                  <article
                    className={`conversation-message ${message.role}`}
                    key={message.id}
                  >
                    <span>
                      {message.role === "user"
                        ? "You"
                        : (actor?.name ?? "Branchlab")}
                      <small>Round {message.round}</small>
                    </span>
                    <p>{message.content}</p>
                  </article>
                ))}
                {!messages.length && !busy && (
                  <div className="follow-up-prompts">
                    {(actor
                      ? [
                          "What matters most to you?",
                          "What would change your mind?",
                        ]
                      : [
                          "Where do the actors disagree?",
                          "What should I try changing?",
                        ]
                    ).map((question) => (
                      <button
                        key={question}
                        disabled={disabled}
                        onClick={() => void submit(question)}
                      >
                        {question}
                        <ArrowRight size={12} />
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {(simulation || creation) && (
        <div className="conversation-bottom">
          <InlineRequestError error={error} />
          {composer}
          <div className="conversation-bottom-note">
            <span>
              {selectedModel.provider === "demo"
                ? "Deterministic demo · no language model"
                : "Generated perspectives · verify against sources"}
            </span>
            <span>
              {simulation
                ? `${simulation.usage.modelCalls} model operations`
                : creation?.error
                  ? "Scenario draft preserved"
                  : "Preparing scenario"}
            </span>
          </div>
          {simulation && !actor && (
            <details className="conversation-context-note">
              <summary>Analyst context</summary>
              <p>
                Analyst context uses the latest 4 rounds, up to 48 events and
                bounded source excerpts.
              </p>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
