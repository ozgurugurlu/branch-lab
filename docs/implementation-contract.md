# Implementation contract

Current runtime: application/engine **0.3.0**, prompt protocol **2026-10-01.1**, SQL schema **3**. Shared DTOs live in `src/lib/types.ts`; request validation lives in `src/lib/schemas.ts`. Engine provenance is recorded independently of the application release. Timestamps are ISO UTC strings unless a SQL expiry column explicitly stores epoch milliseconds.

## HTTP envelopes and ownership

Ordinary successful JSON routes return `{ data: T }`. Errors return `{ error: { code, message, retryable, requestId, retryAfterSeconds? } }`. The API wrapper sets a server-generated `X-Request-ID`, no-store headers and security headers; throttling may also return `Retry-After`. The public health endpoint has its own minimal readiness envelope. Downloads return file responses rather than the ordinary data envelope.

The browser supplies no provider keys, model base URLs or database URLs. Protected reads and mutations are scoped to the HttpOnly session owner. `APP_PASSWORD`, when configured, gates access to that owner's workspace; hosted live inference additionally requires the instance password. Mutation origins/fetch metadata, uncompressed JSON content type, UTF-8, request-body deadlines and a 256,000-byte streamed body limit are validated before execution. Authentication and limits are persisted in SQL.

## HTTP routes

| Method and route                              | Input / result                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| GET `/api/config`                             | `AppConfig`; establishes session; model and web-search availability                         |
| POST `/api/session`                           | `{ password }`; unlocks current workspace                                                   |
| DELETE `/api/session`                         | Locks workspace and fences active work                                                      |
| GET `/api/simulations`                        | `SimulationSummary[]`, at most 100                                                          |
| POST `/api/simulations`                       | `CreateSimulationInput` → `Simulation`; journal exists during architect work                |
| GET `/api/simulations/:id`                    | `Simulation`                                                                                |
| DELETE `/api/simulations/:id`                 | `{ deleted: true }`; rejects an active run lease                                            |
| POST `/api/simulations/:id/step`              | `{ expectedRound, requestId? }` → `Simulation`; one complete round                          |
| POST `/api/simulations/:id/branch`            | `{ intervention, title?, requestId? }` → independent child `Simulation`                     |
| POST `/api/simulations/:id/chat`              | `{ message, actorId?, requestId? }` → `Simulation`; omitted actor means analyst             |
| POST `/api/simulations/:id/report`            | `{ requestId?, refresh?, expectedRound? }` → `Simulation` with report                       |
| GET `/api/simulations/:id/operations`         | Most recent 100 `OperationRecord` values                                                    |
| GET `/api/simulations/:id/trace`              | `ExecutionFeed` for the run                                                                 |
| GET `/api/operations/:requestId/trace`        | Owner-scoped feed by request UUID, including creation before a run exists                   |
| GET `/api/simulations/:id/export?format=json` | JSON download; use `format=markdown` for Markdown                                           |
| GET `/api/privacy`                            | `PrivacyInfo` for current workspace                                                         |
| DELETE `/api/workspace`                       | `{ confirmation: "DELETE MY WORKSPACE" }` → `{ deleted: true }`; erase and revoke workspace |
| GET `/api/health`                             | Public database readiness; no credentials                                                   |

New runs accept 4–12 actors, 1–12 initial rounds, at most six text sources, 16,000 characters per source and 48,000 source characters total. New cloud runs require `privacy.allowCloud: true`; web search separately requires `privacy.allowWebSearch: true` and server configuration. Existing legacy runs without privacy fields remain readable and executable; explicit false cloud consent is always enforced. Text/Markdown imports are bounded strings, not arbitrary binary uploads or automatic URL fetching.

Creation and branching accept an optional `title`, trimmed and limited to 100 characters. Empty or omitted titles save as `Untitled simulation` for a new run or the parent title followed by ` · branch` for a branch. Saved `Simulation.title` remains a nonempty string; the question is never copied into it. A scenario question and branch intervention remain required.

Every source receives a stable run-local ID and SHA-256 content hash. `access: "actors"` is the default and permits deliberate actor assignment. `access: "analyst-only"` excludes the source from architect and actor inputs/tools. Analysts, the human workspace owner and exports can inspect all sources. Context and world assumptions are shared scenario data, not private-source fields.

## Idempotency and operation journal

Create, step, branch, chat and report accept an optional UUID `requestId`. The journal binds `(owner, requestId)` to a hash of action kind, target and input. Identical completed requests return the current saved result; a different payload with the same UUID returns `IDEMPOTENCY_CONFLICT`. Running operations return busy; failed, interrupted or expired attempts may be reclaimed with a new token and incremented attempt. Without a supplied UUID, each request gets a new operation key. The server's error-correlation `X-Request-ID` is a different identifier.

`expectedRound` independently makes an already-completed step retry a no-op and rejects future/out-of-sync rounds. Journal records include status, attempt, safe error code, timestamps and engine/prompt versions, without raw request bodies. A creation can be inspected by request UUID before the world exists. A workspace has a 5,000-operation journal limit. A crash after model execution but before commit may repeat provider charges on retry; neither journal nor lease promises exactly-once inference.

Report requests also accept optional `expectedRound` (integer 0–24). The browser always supplies the current saved round count, binding the request hash and UUID to that snapshot. A failed retry at the same round retains its UUID; advancing rounds creates a different request identity, so a lost response from an earlier completed report cannot suppress the final report. The server checks round equality both before returning a cached report and against the freshly leased state before inference, returning `409 ROUND_MISMATCH` on mismatch. Legacy API clients may omit this field.

## Engine interfaces

`src/mastra/simulation.ts` exports:

```ts
buildWorld(input: CreateSimulationInput, sources: Source[], signal?: AbortSignal, hooks?: EngineRuntimeHooks): Promise<World>
executeRound(simulation: Simulation, signal?: AbortSignal, hooks?: EngineRuntimeHooks): Promise<Round>
generateReport(simulation: Simulation, signal?: AbortSignal, hooks?: EngineRuntimeHooks): Promise<Report>
answerQuestion(simulation: Simulation, message: string, actorId?: string, signal?: AbortSignal, hooks?: EngineRuntimeHooks): Promise<string>
```

The engine does not write the database. Mastra agents and an ephemeral per-round `decide → reduce` workflow execute against a frozen snapshot. Only the deterministic reducer changes simulated state. It calculates `support = (mean stance + 1) × 50`, `polarization = min(100, standard deviation × 100)` and activity as the number of non-observe actions. These are simulated indices, not forecast probabilities.

Actors receive their own bounded memory, assigned actor-visible sources, direct contacts and previous two rounds of visible public events. Remembered older event IDs must identify actual own events still cited in retained memory. Report/analyst references must come from the supplied latest four rounds / 48 events. Sources are clipped to 6,000 characters each and 24,000 total per selected collection. Initial model payloads and interview history are bounded. Report coverage metadata and the chat interface disclose these boundaries; live replies receive instructions to explain material omissions in the current question's language. Schema, reference, range and inline-citation checks run before persistence.

Actor profiles select actual distinct tool sets from the client-safe `CAPABILITY_PROFILES` catalog. `src/mastra/tools.ts` constructs read-only Mastra tools over permitted closures. Architect tools exclude analyst-only sources; analyst tools may read them. Research actors alone may receive opt-in `search_web`; the server owns its provider endpoint and budgets. No tools expose arbitrary URL fetch, shell execution, filesystem access, account actions or world mutation. See [agent-runtime.md](agent-runtime.md) for the tool table.

Every live agent first performs a required scoped read and may perform one more tool call before final synthesis. Limits are **three model steps, two tool executions, tool concurrency one and actor concurrency three**. SDK/workflow retries are disabled. Each agent has a 40-second deadline; the route bounds a complete operation to 180 seconds. Mastra JSON prompt injection supports tool/structured interoperability; strict Zod and domain validation establish the output contract. Tool-incompatible models fail visibly; no cloud/local failure silently becomes demo output.

Live worlds contain scenario-specific generated fictional personas. Their role, goal, description, stance/influence, assigned sources and bounded memory are modeling assumptions. The demo uses fixed scenario-category archetypes, seeded decisions and the same reducer/reference rules. It executes real deterministic read functions and emits explicitly labeled demo activity with zero model calls. No model inference or external search is simulated in the trace.

New report generation requires an `answer` string of 1–6,000 characters that directly addresses the scenario question, alongside the existing headline, summary, findings, uncertainties and source references. `Report.answer` is optional in the persisted DTO so older reports remain readable. Optional `Report.contextNotes: string[]` contains server-generated English coverage metadata, attached only after strict model-output and citation validation; it is not a model-output field and is displayed outside narrative/uncertainties. Report requests return an existing report unless `refresh: true` is supplied; an explicit refresh uses the normal journal, lease, consent and model budgets and preserves the saved report if generation fails. Refresh is part of the request input used for idempotency. These JSON-field additions do not change SQL schema version 3.

World, actor-action and report prompts use the original scenario's dominant language. Chat/interview prompts use the latest question's language, including material context/history-limit explanations. Validated live chat text receives only bare appended reference tokens such as `[event-id]`; the engine does not append English `Evidence:` or `Context limits:` labels to generated prose.

## Runtime events

`EngineRuntimeHooks` contains optional awaited `onEvent(event)` and optional `searchWeb(query, signal)` functions. Only a configured, consented server runtime provides the latter. `EngineTraceEvent` identifies a phase (`architect`, `actor`, `analyst`, `interview`, `research`) and kind (`phase-start`, `tool-start`, `tool-result`, `phase-end`, `error`), with optional actor/tool/call IDs, duration, status and model-step count. The server may attach actual web result `{ title, url }` entries. It adds event ID, operation ID, timestamp and per-operation sequence for `ExecutionTrace`.

Summaries are fixed application metadata. Do not put raw model prompts, source bodies, query strings, tool-result bodies, provider errors or private chain-of-thought into events. A phase completion precedes domain validation/commit and is not a checkpoint acknowledgement. Trace inserts require a matching owner, active token and unexpired operation; each attempt is capped at 300 emitted events.

`ExecutionFeed` is `{ operations, events }`. Run feeds and exports include at most the most recent **100 operations and 600 events**. JSON exports add an `execution` property to the complete saved simulation; Markdown includes execution summaries and available web result titles/URLs. This bounded feed is not a full provider billing ledger or exhaustive historical trace.

## Model and search adapters

`src/lib/providers.ts` supplies the client-safe provider catalog. `src/server/models.ts` exports `resolveModel(config)` and provider availability. Cloud model IDs are allowlisted; valid custom local model IDs are accepted. OpenAI/Google use native SDK adapters; Ollama/LM Studio use an OpenAI-compatible adapter and require tool-calling plus JSON-output support. All endpoints and credentials are environment-owned. Local endpoints can be remote when explicitly configured; local-provider selection alone does not establish offline operation.

`src/server/web-search.ts` uses the configured Brave service, a 15-second deadline, bounded response size and at most five results. It never fetches result URLs. The runtime permits at most three searches per operation plus persistent owner/global limits. Search outputs remain unverified external evidence and do not mint simulation source IDs.

Before live inference, the server reserves three model requests per agent, or three times the population per round. Reservations include failures and are not refunded when fewer requests execute. Saved usage records actual model steps from completed successful work; failed/aborted provider charges may be absent. It must not be presented as an invoice or exact total spending.

## Persistence and transaction boundaries

`DATABASE_URL` selects PostgreSQL/Neon through `pg`; otherwise libSQL/Turso is selected, with a local SQLite file as the development default. Hosted runtimes reject file-backed storage. Remote PostgreSQL requires verified TLS. The adapter uses numbered bound parameters and a shared statement/transaction interface; PostgreSQL pool size is five per process.

PostgreSQL transaction callbacks run at `SERIALIZABLE` and can retry serialization failures/deadlocks up to eight attempts. Those callbacks must contain only short SQL work: quota/revocation guards, checkpoint writes, journal completion and trace writes. Never run inference, search or external side effects inside a retriable callback. Simple single-statement calls use a short `READ COMMITTED` transaction. Every transaction sets a local search path to the validated `DATABASE_SCHEMA` (default `branchlab`), without a `public` fallback; this works with pooled connections. Legacy compatible tables in `public` require explicit `DATABASE_SCHEMA=public`. No data moves automatically when selecting another namespace. libSQL queues work per client and uses explicit write transactions. Schema initialization records version 3, uses a PostgreSQL advisory transaction lock, and validates existing application table metadata before table creation or session cleanup.

Database driver failures are normalized at the outer database boundary, after transaction retries. Safe authentication, permission, schema, TLS and connection error codes replace raw driver details. Domain `AppError` instances retain their semantics. Readiness reports the safe database error category, and bootstrap recovery guidance does not claim an existing simulation checkpoint.

Existing-run model mutations acquire a 210-second lease with owner, revision and random token fencing. Commit requires all predicates, a live operation and current authorization; checkpoint and operation completion commit together. The operation marks in-memory completion only after the transaction commits, avoiding a redundant follow-up write that could turn a committed success into an error. Successful no-op retries still complete their journal record. Failures preserve the previous complete snapshot. Expired work can be retried, but there is no per-actor durable recovery. Mastra workflow execution itself is ephemeral.

Branches deep-copy the latest completed state, retain source/privacy settings and recorded rounds, reset conversation/report, and permit three future rounds up to a 24-round lineage cap. They cannot mutate their parent. Workspace erasure atomically revokes and deletes owned data so late work cannot recreate it. Thirty-day expiry cleanup runs lazily on application traffic, not through a scheduler; backups and provider records remain outside its scope.

## Frontend and verification

The browser manages run creation, graph/timeline/source/report inspection, actor capabilities, analyst/actor chat, execution-feed polling, branching, export and privacy controls. Reconnect loads saved checkpoints and journal states. Auto-run schedules one bounded round request at a time; pause stops scheduling after the current request. There is no automatic unattended worker and no claim that closing the browser leaves an indefinitely running simulation.

When a user-started run reaches `maxRounds`, including a manual final step, the browser awaits `POST /api/simulations/:id/report` after saving the final step, provided the run is still active and online and auto-run was not paused. It then presents the scenario question and direct answer in chat before supporting findings and metrics. `status: "completed"` describes round completion; the separate report may be missing or failed. A report failure leaves that round saved and enables inline retry. Viewing/reloading an existing run never starts inference. An explicit **Update report** sends `refresh: true` to upgrade a legacy report; it does not replay simulation rounds.

Engine/protocol tests verify actual local HTTP adapter → Mastra tool call → result → typed output exchanges, privacy/reference bounds and cancellation. SQL tests verify ownership, idempotency, leases and revocation. PostgreSQL integration requires an explicitly configured disposable test database; a passing local adapter test does not establish a deployed Neon account or real cloud-model quality. Use the repository check/build/browser workflows before release. Simulation software tests do not establish scientific forecasting accuracy. Any local reference-source folder is excluded from the application and has no runtime dependency role.
