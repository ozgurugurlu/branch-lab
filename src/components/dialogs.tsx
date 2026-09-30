"use client";

import { useEffect, useRef, useState } from "react";
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
} from "@/lib/types";
import { PROVIDERS } from "@/lib/providers";
import { TEMPLATES, type ScenarioTemplate } from "@/lib/templates";

export function Dialog({
  title,
  eyebrow,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  eyebrow: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab") return;
      const focusable = Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]',
        ) ?? [],
      );
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
      prior?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="dialog-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`dialog ${wide ? "dialog-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <div className="dialog-heading">
          <div>
            <span className="eyebrow">{eyebrow}</span>
            <h2>{title}</h2>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const FALLBACK_PROVIDER: ProviderStatus = PROVIDERS[0];

export function NewSimulationDialog({
  config,
  initialTemplate,
  onClose,
  onCreate,
  busy,
}: {
  config: AppConfig | null;
  initialTemplate?: ScenarioTemplate;
  onClose: () => void;
  onCreate: (input: CreateSimulationInput) => Promise<void>;
  busy: boolean;
}) {
  const first = initialTemplate ?? TEMPLATES[0];
  const providers = config?.providers.length
    ? config.providers
    : [FALLBACK_PROVIDER];
  const [title, setTitle] = useState(first.input.title);
  const [question, setQuestion] = useState(first.input.question);
  const [context, setContext] = useState(first.input.context);
  const [sources, setSources] = useState(first.input.sources);
  const [provider, setProvider] = useState<ProviderId>("demo");
  const [model, setModel] = useState(
    providers.find((p) => p.id === "demo")?.models[0]?.id ?? "branchlab-demo",
  );
  const [count, setCount] = useState(8);
  const [rounds, setRounds] = useState(6);
  const [seed, setSeed] = useState(42);
  const [error, setError] = useState("");
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
      wide
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (importing) return;
          setError("");
          try {
            await onCreate({
              title,
              question,
              context,
              model: { provider, model },
              seed,
              actorCount: count,
              maxRounds: rounds,
              sources,
            });
          } catch (err) {
            setError(
              err instanceof Error
                ? err.message
                : "Could not create simulation.",
            );
          }
        }}
      >
        <div className="dialog-content new-simulation">
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
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-footer">
          <span>Explore possibilities. Make assumptions visible.</span>
          <button
            className="button primary"
            disabled={
              busy ||
              importing ||
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
}: {
  config: AppConfig | null;
  onClose: () => void;
  onAuthenticate: (password: string) => Promise<void>;
  onLock: () => Promise<void>;
  workspaceBusy: boolean;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const envNames: Record<ProviderId, string> = {
    demo: "No configuration needed",
    openai: "OPENAI_API_KEY",
    google: "GOOGLE_GENERATIVE_AI_API_KEY",
    ollama: "OLLAMA_BASE_URL",
    lmstudio: "LMSTUDIO_BASE_URL",
  };
  return (
    <Dialog title="Model settings" eyebrow="WORKSPACE" onClose={onClose}>
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
                      setError(
                        e instanceof Error
                          ? e.message
                          : "Could not lock workspace.",
                      );
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
                    setError(
                      err instanceof Error
                        ? err.message
                        : "Could not unlock workspace.",
                    );
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
                  <button className="button primary" disabled={busy}>
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
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        <div className="settings-storage">
          <span>Persistence</span>
          <span>
            {config?.storage === "remote"
              ? "Remote SQL database"
              : "Local SQL database"}
          </span>
        </div>
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
  const [error, setError] = useState("");
  return (
    <Dialog
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
            setError(
              err instanceof Error ? err.message : "Could not create branch.",
            );
          }
        }}
      >
        <div className="dialog-content">
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
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-footer">
          <button type="button" className="button secondary" onClick={onClose}>
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
  return (
    <Dialog
      title="Delete this simulation?"
      eyebrow="MANAGE SIMULATION"
      onClose={onClose}
    >
      <div className="dialog-content">
        <p>
          “{title}” and its stored sources, events and conversations will be
          deleted. Export a copy first if you need it.
        </p>
      </div>
      <div className="dialog-footer">
        <button className="button secondary" onClick={onClose}>
          Keep simulation
        </button>
        <button
          className="button primary"
          disabled={busy}
          onClick={() => void onDelete()}
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
