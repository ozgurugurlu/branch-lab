"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronRight,
  FileText,
  FlaskConical,
  GitBranch,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Plus,
  Server,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type {
  AppConfig,
  CreateSimulationInput,
  ProviderId,
  ProviderStatus,
  Simulation,
  PrivacyInfo,
} from "@/lib/types";
import { api } from "./client-api";
import { InlineRequestError } from "./request-error";
import { ProcessTrace } from "./process-trace";
import { PROVIDERS } from "@/lib/providers";
import { TEMPLATES, type ScenarioTemplate } from "@/lib/templates";

export function Dialog({
  title,
  eyebrow,
  onClose,
  children,
  wide = false,
  pending = false,
  className = "",
}: {
  title: string;
  eyebrow: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
  pending?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!returnFocus.current)
      returnFocus.current = document.activeElement as HTMLElement | null;
    const prior = returnFocus.current;
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (!pending) onClose();
      }
      if (e.key !== "Tab") return;
      const focusable = Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex="0"]',
        ) ?? [],
      ).filter((item) => item.getClientRects().length > 0);
      const first = focusable[0],
        last = focusable[focusable.length - 1];
      if (!first) {
        e.preventDefault();
        return;
      }
      if (
        e.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === ref.current)
      ) {
        e.preventDefault();
        last.focus();
      } else if (
        !e.shiftKey &&
        (document.activeElement === last ||
          document.activeElement === ref.current)
      ) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handle);
    return () => {
      document.body.style.overflow = bodyOverflow;
      document.removeEventListener("keydown", handle);
      queueMicrotask(() => {
        if (prior?.isConnected && !prior.closest("[inert]")) prior.focus();
      });
    };
  }, [onClose, pending]);
  return (
    <div
      className="dialog-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !pending) onClose();
      }}
    >
      <div
        className={`dialog ${wide ? "dialog-wide" : ""} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-busy={pending}
        tabIndex={-1}
        ref={ref}
      >
        <div className="dialog-heading">
          <div>
            <span className="eyebrow">{eyebrow}</span>
            <h2 id={headingId}>{title}</h2>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close dialog"
            disabled={pending}
          >
            <X size={20} />
          </button>
        </div>
        {pending && (
          <div className="dialog-pending">
            <p role="status">
              This operation is running. Keep this dialog open until it
              finishes.
            </p>
            {(eyebrow === "NEW SIMULATION" ||
              eyebrow.startsWith("BRANCH FROM")) && (
              <ProcessTrace busy="operation" />
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

const FALLBACK_PROVIDER: ProviderStatus = PROVIDERS[0];

export function NewSimulationDialog({
  config,
  initialTemplate,
  initialDraft,
  onClose,
  onCreate,
  busy,
}: {
  config: AppConfig | null;
  initialTemplate?: ScenarioTemplate;
  initialDraft?: CreateSimulationInput;
  onClose: () => void;
  onCreate: (input: CreateSimulationInput) => Promise<void>;
  busy: boolean;
}) {
  const first = initialDraft
    ? { input: initialDraft }
    : (initialTemplate ?? TEMPLATES[0]);
  const providers = config?.providers.length
    ? config.providers
    : [FALLBACK_PROVIDER];
  const [title, setTitle] = useState(first.input.title);
  const [question, setQuestion] = useState(first.input.question);
  const [context, setContext] = useState(first.input.context);
  const [sources, setSources] = useState<CreateSimulationInput["sources"]>(
    first.input.sources,
  );
  const [allowCloud, setAllowCloud] = useState(false);
  const [allowWebSearch, setAllowWebSearch] = useState(false);
  const [provider, setProvider] = useState<ProviderId>(
    initialDraft?.model.provider ?? "demo",
  );
  const [model, setModel] = useState(
    initialDraft?.model.model ??
      providers.find((p) => p.id === "demo")?.models[0]?.id ??
      "branchlab-demo",
  );
  const [count, setCount] = useState(8);
  const [rounds, setRounds] = useState(6);
  const [seed, setSeed] = useState(42);
  const [error, setError] = useState<unknown>(null);
  const [advanced, setAdvanced] = useState(false);
  const [importing, setImporting] = useState(false);
  const selectedProvider =
    providers.find((p) => p.id === provider) ?? FALLBACK_PROVIDER;
  const isLocal = provider === "ollama" || provider === "lmstudio";
  const fileRef = useRef<HTMLInputElement>(null);
  function selectTemplate(template: ScenarioTemplate) {
    setTitle(template.input.title);
    setQuestion(template.input.question);
    setContext(template.input.context);
    setSources(template.input.sources);
  }
  async function importFiles(files: FileList | null) {
    if (!files || importing) return;
    setImporting(true);
    setError("");
    try {
      const next: typeof sources = [];
      for (const file of Array.from(files)) {
        if (file.name.length > 120)
          throw new Error("Shorten the filename to 120 characters or fewer.");
        if (!/\.(txt|md|csv)$/i.test(file.name))
          throw new Error("Choose a text, Markdown or CSV document.");
        if (file.size > 64_000)
          throw new Error(
            `${file.name} is too large. Use documents under 16,000 characters.`,
          );
        const content = await file.text();
        if (!content.trim()) throw new Error(`${file.name} is empty.`);
        if (content.length > 16_000)
          throw new Error(
            `${file.name} exceeds 16,000 characters. Shorten it before importing.`,
          );
        next.push({ name: file.name, content });
      }
      if (sources.length + next.length > 6)
        throw new Error("Add up to 6 source documents.");
      if (
        [...sources, ...next].reduce(
          (sum, source) => sum + source.content.length,
          0,
        ) > 48_000
      )
        throw new Error(
          "Combined source text must stay under 48,000 characters.",
        );
      setSources([...sources, ...next]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read this file.");
    }
    if (fileRef.current) fileRef.current.value = "";
    setImporting(false);
  }
  return (
    <Dialog
      title="Set a scenario in motion."
      eyebrow="NEW SIMULATION"
      onClose={onClose}
      pending={busy}
      wide
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (importing) return;
          setError("");
          try {
            if ((provider === "openai" || provider === "google") && !allowCloud)
              throw new Error(
                "Allow cloud model processing or choose a local/demo provider.",
              );
            if (!/^[a-zA-Z0-9_.:/+-]{1,200}$/.test(model.trim()))
              throw new Error(
                "Enter a valid model identifier using letters, numbers, dots, slashes, colons, plus signs or hyphens.",
              );
            await onCreate({
              title: title.trim(),
              question: question.trim(),
              context: context.trim(),
              model: { provider, model: model.trim() },
              seed,
              actorCount: count,
              maxRounds: rounds,
              sources,
              privacy: {
                allowCloud,
                allowWebSearch: Boolean(
                  config?.webSearchConfigured &&
                  provider !== "demo" &&
                  allowWebSearch,
                ),
              },
            });
          } catch (err) {
            setError(err);
          }
        }}
      >
        <fieldset
          className="dialog-content new-simulation form-fields"
          disabled={busy}
        >
          <div className="template-switcher">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                disabled={importing}
                className={title === t.input.title ? "is-active" : ""}
                onClick={() => selectTemplate(t)}
              >
                {t.label}
                <ChevronRight size={13} />
              </button>
            ))}
            <button
              type="button"
              disabled={importing}
              onClick={() => {
                setTitle("");
                setQuestion("");
                setContext("");
                setSources([]);
              }}
            >
              <Plus size={13} /> Start from scratch
            </button>
          </div>
          <div className="form-grid">
            <label className="field full">
              Simulation name
              <input
                required
                minLength={3}
                maxLength={100}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="A short name for your experiment"
              />
            </label>
            <label className="field full">
              What do you want to explore?
              <textarea
                required
                minLength={12}
                maxLength={2000}
                rows={3}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="What might happen if…"
              />
            </label>
            <label className="field full">
              Context & assumptions <span className="optional">Optional</span>
              <textarea
                rows={3}
                maxLength={12000}
                value={context}
                onChange={(e) => setContext(e.target.value)}
                placeholder="Set the scene. What is known, who is involved, and what is uncertain?"
              />
            </label>
          </div>
          <div className="source-upload">
            <div className="section-label">
              <span>Source documents</span>
              <button
                className="text-button"
                type="button"
                disabled={importing}
                onClick={() => fileRef.current?.click()}
              >
                <Upload size={14} /> Add files
              </button>
            </div>
            <input
              hidden
              ref={fileRef}
              type="file"
              multiple
              accept=".txt,.md,.csv,text/plain,text/markdown,text/csv"
              onChange={(e) => void importFiles(e.target.files)}
            />
            {sources.length ? (
              sources.map((s, i) => (
                <div className="source-file" key={`${s.name}-${i}`}>
                  <FileText size={15} />
                  <span>
                    {s.name}
                    <small>
                      {s.content.length.toLocaleString()} characters
                    </small>
                  </span>
                  <label className="source-access">
                    <span className="sr-only">Access for {s.name}</span>
                    <select
                      value={s.access ?? "actors"}
                      disabled={importing}
                      onChange={(event) =>
                        setSources((current) =>
                          current.map((source, index) =>
                            index === i
                              ? {
                                  ...source,
                                  access: event.target.value as
                                    "actors" | "analyst-only",
                                }
                              : source,
                          ),
                        )
                      }
                    >
                      <option value="actors">World & actors</option>
                      <option value="analyst-only">Analyst only</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={importing}
                    onClick={() =>
                      setSources(sources.filter((_, index) => index !== i))
                    }
                    aria-label={`Remove ${s.name}`}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))
            ) : (
              <button
                type="button"
                className="upload-empty"
                disabled={importing}
                onClick={() => fileRef.current?.click()}
              >
                <Upload size={20} />
                <span>
                  Add context from your own documents
                  <small>
                    Plain text, Markdown or CSV · 16k characters each
                  </small>
                </span>
              </button>
            )}
          </div>
          <p className="source-upload-note">
            Analyst-only documents are excluded from world creation and actor
            observations. The analyst, reports, you and full exports can still
            access them.
          </p>
          <div className="form-grid model-fields">
            <label className="field">
              Model provider
              <select
                value={provider}
                onChange={(e) => {
                  const id = e.target.value as ProviderId;
                  setProvider(id);
                  setModel(
                    providers.find((p) => p.id === id)?.models[0]?.id ?? "",
                  );
                }}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.configured}>
                    {p.name}
                    {!p.configured ? " · not configured" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Model
              {isLocal ? (
                <input
                  required
                  maxLength={200}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="Your installed model ID"
                />
              ) : (
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                >
                  {selectedProvider.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {m.preview ? " (preview)" : ""}
                    </option>
                  ))}
                </select>
              )}
            </label>
          </div>
          <section
            className="source-disclosure"
            aria-label="Data processing for this run"
          >
            <h3>
              <ShieldCheck size={15} /> Where your data goes
            </h3>
            <p>
              The brief, full source text, conversations and results are stored
              in this workspace’s{" "}
              {config?.storage === "remote" ? "remote" : "local"} database.{" "}
              {provider === "demo"
                ? "Demo mode makes no model requests."
                : isLocal
                  ? "Model inputs go to the operator-configured local-model endpoint. Local-model selection does not make remote database storage local."
                  : `Relevant source excerpts, scenario details and conversation context will be sent to ${selectedProvider.name} for processing.`}
            </p>
            <label className="consent-checkbox">
              <input
                type="checkbox"
                checked={allowCloud}
                onChange={(event) => setAllowCloud(event.target.checked)}
              />
              <span>Allow cloud model processing for this run</span>
            </label>
            <small>
              {allowCloud
                ? "Cloud processing is allowed by this run’s policy. Provider retention terms apply."
                : "Cloud model requests are blocked by this run’s policy. The server and configured local endpoint still receive their relevant inputs."}
            </small>
            <label className="consent-checkbox">
              <input
                type="checkbox"
                checked={allowWebSearch}
                disabled={!config?.webSearchConfigured || provider === "demo"}
                onChange={(event) => setAllowWebSearch(event.target.checked)}
              />
              <span>Allow research agents to search the web</span>
            </label>
            <small>
              {!config?.webSearchConfigured
                ? "Web search is unavailable until the operator configures Brave Search."
                : provider === "demo"
                  ? "Demo mode does not search the web."
                  : "Search queries and result snippets are exchanged with Brave Search. This is a separate permission from cloud model processing."}
            </small>
          </section>
          <div className="mode-note">
            {provider === "demo" ? (
              <>
                <FlaskConical size={15} />
                <span>
                  Demo uses a deterministic engine. No LLM calls or API key.
                </span>
              </>
            ) : (
              <>
                <Server size={15} />
                <span>
                  {selectedProvider.models.find((m) => m.id === model)
                    ?.description ??
                    "Runs through the server’s configured model endpoint."}{" "}
                  Usage may incur provider costs.
                </span>
              </>
            )}
          </div>
          {provider !== "demo" &&
            config?.passwordRequired &&
            !config.authenticated && (
              <p className="inline-error">
                Unlock this workspace in Model settings before starting a live
                run.
              </p>
            )}
          <button
            type="button"
            className="text-button advanced-toggle"
            onClick={() => setAdvanced(!advanced)}
            aria-expanded={advanced}
          >
            <ChevronRight className={advanced ? "rotate-90" : ""} size={14} />{" "}
            Simulation parameters{" "}
            <span>
              {count} actors · {rounds} rounds
            </span>
          </button>
          {advanced && (
            <div className="parameter-fields">
              <label className="field">
                Actors
                <input
                  type="number"
                  min={4}
                  max={12}
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                />
              </label>
              <label className="field">
                Rounds
                <input
                  type="number"
                  min={1}
                  max={12}
                  value={rounds}
                  onChange={(e) => setRounds(Number(e.target.value))}
                />
              </label>
              <label className="field">
                Seed
                <input
                  type="number"
                  min={0}
                  max={2147483647}
                  value={seed}
                  onChange={(e) => setSeed(Number(e.target.value))}
                />
              </label>
            </div>
          )}
          <p className="source-upload-note">
            {importing
              ? "Reading selected documents…"
              : "Up to 6 documents and 48k characters total. CSV is read as plain text."}
          </p>
          <InlineRequestError error={error} />
        </fieldset>
        <div className="dialog-footer">
          <span>Explore possibilities. Make assumptions visible.</span>
          <button
            className="button primary"
            disabled={
              busy ||
              importing ||
              ((provider === "openai" || provider === "google") &&
                !allowCloud) ||
              (provider !== "demo" &&
                Boolean(config?.passwordRequired && !config.authenticated))
            }
          >
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <ArrowRight size={16} />
            )}{" "}
            {busy ? "Building your world…" : "Create simulation"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function SettingsDialog({
  config,
  onClose,
  onAuthenticate,
  onLock,
  workspaceBusy,
  onEraseWorkspace,
}: {
  config: AppConfig | null;
  onClose: () => void;
  onAuthenticate: (password: string) => Promise<void>;
  onLock: () => Promise<void>;
  workspaceBusy: boolean;
  onEraseWorkspace: () => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [privacy, setPrivacy] = useState<PrivacyInfo | null>(null);
  const [privacyError, setPrivacyError] = useState<unknown>(null);
  const [privacyAttempt, setPrivacyAttempt] = useState(0);
  const [confirmation, setConfirmation] = useState("");
  useEffect(() => {
    if (config?.passwordRequired && !config.authenticated) return;
    const controller = new AbortController();
    void api<PrivacyInfo>("/api/privacy", { signal: controller.signal })
      .then((value) => {
        setPrivacy(value);
        setPrivacyError(null);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setPrivacyError(reason);
      });
    return () => controller.abort();
  }, [config?.authenticated, config?.passwordRequired, privacyAttempt]);
  const envNames: Record<ProviderId, string> = {
    demo: "No configuration needed",
    openai: "OPENAI_API_KEY",
    google: "GOOGLE_GENERATIVE_AI_API_KEY",
    ollama: "OLLAMA_BASE_URL",
    lmstudio: "LMSTUDIO_BASE_URL",
  };
  return (
    <Dialog
      title="Model settings"
      eyebrow="WORKSPACE"
      onClose={onClose}
      pending={busy}
    >
      <div className="dialog-content settings-content">
        <p className="muted">
          Model credentials stay on your server. Add environment variables to
          enable a provider, then restart your deployment. Configured means
          settings are present; connectivity has not been tested.
        </p>
        <div className="provider-list">
          {config?.providers.map((p) => (
            <div key={p.id} className="provider-row">
              <div className="provider-symbol">
                {p.id === "demo" ? (
                  <FlaskConical size={19} />
                ) : p.id === "ollama" || p.id === "lmstudio" ? (
                  <Server size={19} />
                ) : (
                  <span>{p.name[0]}</span>
                )}
              </div>
              <div>
                <strong>{p.name}</strong>
                <code>{envNames[p.id]}</code>
                {p.reason && <small>{p.reason}</small>}
              </div>
              <span
                className={`provider-state ${p.configured ? "configured" : ""}`}
              >
                {p.configured ? (
                  <>
                    <Check size={13} /> Configured
                  </>
                ) : (
                  "Not configured"
                )}
              </span>
            </div>
          ))}
        </div>
        <p className="settings-hint">
          Ollama and LM Studio run on the server’s network. A hosted deployment
          cannot reach your laptop’s localhost. Use a local deployment or a
          private reachable endpoint.
        </p>
        {config?.passwordRequired ? (
          <section className="auth-settings">
            <h3>
              <LockKeyhole size={17} /> Workspace access
            </h3>
            {config.authenticated ? (
              <div className="auth-unlocked">
                <span>
                  <Check size={15} /> Live model access unlocked
                </span>
                <button
                  className="button secondary small"
                  disabled={busy || workspaceBusy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await onLock();
                    } catch (e) {
                      setError(e);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Lock workspace
                </button>
              </div>
            ) : (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  setError("");
                  try {
                    await onAuthenticate(password);
                    setPassword("");
                  } catch (err) {
                    setError(err);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <p className="muted">
                  Enter the instance password to use live models.
                </p>
                <div className="password-field">
                  <input
                    type="password"
                    autoComplete="current-password"
                    required
                    aria-label="Workspace password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    className="button primary"
                    disabled={busy || workspaceBusy}
                  >
                    {busy ? (
                      <LoaderCircle className="spin" size={15} />
                    ) : (
                      <KeyRound size={15} />
                    )}{" "}
                    Unlock
                  </button>
                </div>
              </form>
            )}
          </section>
        ) : (
          <p className="settings-hint">
            <KeyRound size={14} /> Set APP_PASSWORD to protect live model access
            on shared deployments.
          </p>
        )}
        <InlineRequestError error={error} />
        <div className="settings-storage">
          <span>Persistence</span>
          <span>
            {config?.storage === "remote"
              ? "Remote SQL database"
              : "Local SQL database"}
          </span>
        </div>
        {(!config?.passwordRequired || config.authenticated) && (
          <section className="privacy-settings">
            <h3>
              <ShieldCheck size={16} /> Privacy & workspace data
            </h3>
            {privacyError ? (
              <>
                <InlineRequestError error={privacyError} />
                <button
                  className="text-button"
                  onClick={() => setPrivacyAttempt((value) => value + 1)}
                >
                  Retry privacy details
                </button>
              </>
            ) : privacy ? (
              <>
                <dl>
                  <div>
                    <dt>Saved simulations</dt>
                    <dd>{privacy.simulationCount}</dd>
                  </div>
                  <div>
                    <dt>Active operations</dt>
                    <dd>{privacy.activeOperations}</dd>
                  </div>
                  <div>
                    <dt>Browser session expires</dt>
                    <dd>
                      {new Date(privacy.sessionExpiresAt).toLocaleDateString()}
                    </dd>
                  </div>
                  <div>
                    <dt>Retention window</dt>
                    <dd>{privacy.retentionDays} days</dd>
                  </div>
                </dl>
                <p>{privacy.providerDataPolicy}</p>
                <p>
                  Access belongs to this browser session. Export important runs
                  before clearing browser data. Exports include source text and
                  conversations.
                </p>
                <details className="erase-workspace">
                  <summary>
                    <Trash2 size={14} /> Erase workspace data
                  </summary>
                  <p>
                    Delete all simulations, documents, conversations and
                    operation records in this workspace, and revoke this
                    browser’s session. This cannot be undone.
                  </p>
                  {(workspaceBusy || privacy.activeOperations > 0) && (
                    <p className="privacy-active-note">
                      Work is currently in progress. Erasing revokes access
                      immediately and prevents pending work from being saved. It
                      cannot undo requests already sent to a model provider.
                    </p>
                  )}
                  <form
                    onSubmit={async (event) => {
                      event.preventDefault();
                      if (confirmation !== "DELETE MY WORKSPACE" || busy)
                        return;
                      setBusy(true);
                      setError(null);
                      try {
                        await onEraseWorkspace();
                      } catch (reason) {
                        setError(reason);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <label className="field">
                      Type DELETE MY WORKSPACE to confirm
                      <input
                        autoComplete="off"
                        spellCheck={false}
                        value={confirmation}
                        onChange={(event) =>
                          setConfirmation(event.target.value)
                        }
                        disabled={busy}
                      />
                    </label>
                    <button
                      className="button danger"
                      disabled={busy || confirmation !== "DELETE MY WORKSPACE"}
                    >
                      {busy ? (
                        <LoaderCircle size={14} className="spin" />
                      ) : (
                        <Trash2 size={14} />
                      )}{" "}
                      Erase all workspace data
                    </button>
                  </form>
                </details>
              </>
            ) : (
              <p className="privacy-loading" role="status">
                Loading storage and privacy details…
              </p>
            )}
          </section>
        )}
      </div>
    </Dialog>
  );
}

export function BranchDialog({
  simulation,
  onClose,
  onBranch,
  busy,
}: {
  simulation: Simulation;
  onClose: () => void;
  onBranch: (intervention: string, title: string) => Promise<void>;
  busy: boolean;
}) {
  const [title, setTitle] = useState(
    `${simulation.title.slice(0, 85)} · alternative`,
  );
  const [intervention, setIntervention] = useState("");
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog
      pending={busy}
      title="Change one thing."
      eyebrow={`BRANCH FROM ROUND ${String(simulation.rounds.length).padStart(2, "0")}`}
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            await onBranch(intervention, title);
          } catch (err) {
            setError(err);
          }
        }}
      >
        <fieldset className="dialog-content form-fields" disabled={busy}>
          <p className="muted">
            Keep this world’s history and explore a new direction. Your original
            simulation stays available for comparison.
          </p>
          <label className="field">
            Branch name
            <input
              required
              minLength={3}
              value={title}
              maxLength={100}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="field">
            What changes?
            <textarea
              required
              minLength={12}
              maxLength={2000}
              rows={5}
              value={intervention}
              onChange={(e) => setIntervention(e.target.value)}
              placeholder="For example: leadership introduces a rotating coverage schedule and shares the pilot’s success criteria…"
            />
          </label>
          <div className="mode-note">
            <GitBranch size={16} />
            <span>
              Forks the latest completed state and adds up to 3 new rounds.
            </span>
          </div>
          <InlineRequestError error={error} />
        </fieldset>
        <div className="dialog-footer">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <GitBranch size={16} />
            )}{" "}
            Create branch
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function DeleteDialog({
  title,
  onClose,
  onDelete,
  busy,
}: {
  title: string;
  onClose: () => void;
  onDelete: () => Promise<void>;
  busy: boolean;
}) {
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog
      pending={busy}
      title="Delete this simulation?"
      eyebrow="MANAGE SIMULATION"
      onClose={onClose}
    >
      <div className="dialog-content">
        <p>
          “{title}” and its stored sources, events and conversations will be
          deleted. Export a copy first if you need it.
        </p>
        <InlineRequestError error={error} />
      </div>
      <div className="dialog-footer">
        <button className="button secondary" disabled={busy} onClick={onClose}>
          Keep simulation
        </button>
        <button
          className="button primary"
          disabled={busy}
          onClick={async () => {
            setError(null);
            try {
              await onDelete();
            } catch (reason) {
              setError(reason);
            }
          }}
        >
          {busy ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <Trash2 size={15} />
          )}{" "}
          Delete simulation
        </button>
      </div>
    </Dialog>
  );
}
