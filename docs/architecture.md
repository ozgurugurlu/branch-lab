# Architecture

## Decision

Branchlab is a small-population scenario lab, implemented as one Next.js application with Mastra agent execution and explicit SQL persistence. This document describes v0.3.0 and prompt protocol 2026-09-30.3. The design was selected after comparing social-agent research frameworks, forecasting benchmarks, current Mastra integrations and serverless execution constraints on 2026-09-30. These are engineering decisions, not claims made by the research sources.

## Separation of responsibilities

The scenario architect produces a typed world: actors, their objectives, initial stances, relationships and assumptions. Sources have stable run-local IDs and SHA-256 content hashes. Its tools inspect world constraints and actor-visible documents. It cannot see analyst-only sources, fetch arbitrary URLs, execute code or operate the user's accounts.

Every actor receives a bounded observation from a frozen previous-round snapshot. Its own private memories and assigned sources accompany public actions of connected actors. The entire simulation object is never passed to an actor. The round workflow collects independent proposals, validates them and applies a deterministic reducer. Histories contain public events; actor memory is recorded to support inspection by the human operator.

The analyst receives aggregate metrics for the complete run and a bounded window of detailed public events: at most the latest four rounds and 48 events. Report and analyst-chat event references must appear in this supplied window, rather than merely existing somewhere in the database. Actor interviews use only that actor's authorized observations and matching conversation thread. Conversation messages capture the round at which they were asked. A report lists findings with event IDs, uncertainties and source references, which are checked before saving.

## Capabilities and agent tools

New actors carry explicit `community`, `research`, `operations` or `policy` capability profiles. The client-safe catalog is in `src/lib/capabilities.ts`. Community actors inspect neighbors and contacts; researchers inspect assigned evidence and observed stances; operations actors inspect interventions and evidence; policy actors inspect contacts and interventions. Each profile includes personal-memory access scoped to the current actor. When omitted, a profile is inferred from fictional role/goal descriptions with a stable actor-number fallback. This is a modeling assumption, not a verified characteristic of real people. Older saved worlds remain usable.

Each actual Mastra tool has an explicit permitted-data closure. Read tools inspect data already present in the bounded observation; requesting a tool does not itself grant new information. Actors sharing a profile still have different own-memory, source and neighborhood permissions. The analyst has separate metrics/events/evidence tools. See [agent-runtime.md](agent-runtime.md) for the tool table.

Only research-profile actors receive `search_web`, and only with server configuration and explicit per-run consent. Bounded queries go to one configured Brave endpoint; the server returns up to five snippets/links and never fetches result URLs. Queries may contain scenario-derived information. Results are unverified outside evidence, cannot create stored source/event IDs, and are not automatically shared with every actor. A whole operation has a three-search ceiling plus persistent session/global limits. Demo mode never searches the web.

Scenario text, imported sources, memories, history and tool results are serialized as untrusted data. Trusted instructions separately specify roles, output schemas and citation rules. Code enforces the tools and data available to each actor; prompt text alone is not an authorization boundary. Schema and reference validation reject invented, hidden or undeclared citation-shaped IDs. Tests verify software boundaries, not universal resistance to model prompt injection.

## Context and evidence limits

Each actor sees its own profile, up to eight retained memory notes, assigned source documents, connected actors' public actions from the previous two rounds, and applicable interventions. Other actors' private memory, objectives, assigned documents, and interview threads are excluded. An actor may cite an older **own** action when its event ID is still explicitly present in one of its retained memory notes. These remembered IDs are derived from the actor's actual recorded actions; they do not grant access to older neighbor events or forgotten events.

`Source.access` defaults to `actors`; assignment still requires its ID in the actor's source list. `analyst-only` documents are filtered before architect generation, actor observation and tool construction, even if a stored actor assignment erroneously includes them. Reports and analyst chat can read all sources. This controls agent inputs: the workspace owner and exports can inspect every source and actor memory. Shared scenario context and assumptions are not private-source fields.

Live model inputs use the first **up to 6,000 characters per source document**, with a **24,000-character total document-content budget** divided evenly across the selected source collection. An actor's selected collection contains only its assigned documents. The full imported text and its SHA-256 hash remain stored and available in exports; this release does not retrieve passages by semantic relevance. A source ID establishes which document was supplied, not that an omitted passage was considered or that a generated claim is entailed by it. Payloads identify truncated documents explicitly. Reports and live chat answers surface context-limit notices when documents or detailed event history were omitted. The source view should be interpreted alongside these limits.

Initial serialized model payloads are capped at 160,000 characters. Interview history contains at most eight matching-thread messages, 2,000 characters per message and 12,000 characters overall. Prior assistant replies citing no-longer-accessible evidence are omitted from model context but retained in storage. User messages are questions or hypotheses, not new simulation observations.

The deterministic demo executes real scoped read functions but does not interpret documents or call a model. Its activity explicitly says demo and reports zero model requests. Its reports describe recorded synthetic events and aggregate statistics; the same reference checks prevent fabricated citations. Neither source inclusion nor repeated synthetic agent agreement verifies a real-world claim.

## Execution and durability

One whole round runs per POST request. The application deadline is 180 seconds, with a 210-second SQL lease and a declared route maximum of 240 seconds; the hosting plan must support that duration. Each agent turn has a 40-second total deadline, at most three model steps and at most two tool executions. The first step requires a scoped read; the last permits only final synthesis. Tool concurrency is one per agent and actor concurrency is at most three. SDK and workflow retries are disabled. Slow models can still time out; these bounds do not guarantee every population finishes within a hosting deadline.

Mastra JSON prompt injection supports tools followed by structured output across configured cloud and local adapters. Final responses always pass Zod and domain validation; native provider JSON-schema enforcement is not assumed. Models ignoring required tool calls fail visibly without demo substitution. An actor failure aborts in-flight peers and stops scheduling the remaining actors; no partial round reaches the reducer.

The application stores a complete bounded simulation aggregate as JSON. SQL columns index ownership, title, revision and timestamps. This prioritizes a portable, inspectable first version over complex event-sourcing infrastructure. It is not optimized for million-agent data volumes. Source text, chat, manifests and snapshots share the same atomic aggregate; there is no separate object bucket to configure.

Model-bearing updates to existing runs acquire a lease through a conditional SQL update. A commit must match the original revision, a random fencing token and an unexpired lease. An old request cannot overwrite a new lease holder. Creation and branching atomically insert new records; deletion rejects an active lease. Different simulations can progress independently. No database transaction stays open while an LLM runs.

`expectedRound` makes completed step retries idempotent: an already committed round returns the newest state without another call. Create, step, branch, chat and report also accept an optional UUID `requestId`. The operation journal binds it to the owner and a hash of action kind, target and input. Reusing a key for different input conflicts; a completed key returns the current saved result; an active key remains busy. Failed/interrupted attempts can reclaim the operation with a new token and incremented attempt. An expired running operation is displayed as interrupted. Checkpoint writes and journal completion commit in the same SQL transaction; known committed success skips a redundant completion write.

External model calls are **not exactly-once**: retries after failure or process loss can repeat charges even without a saved checkpoint. Durable state consists of complete domain snapshots and operation metadata. The Mastra workflow remains ephemeral, without native durable storage, per-actor recovery or suspend/resume.

The browser schedules auto-run requests and stops after the current round when paused. There is no background worker. Closing a tab may interrupt a request; the last committed snapshot remains authoritative. The app never calls a model in a fire-and-forget background promise.

## Execution activity and provenance

The journal records operation kind, status, attempt, start/end timestamps, safe error code and engine/prompt versions. It stores a hash rather than the original input body. Awaited runtime callbacks record actual phase starts, tool starts/results, duration, failures and model-step counts. Fixed summaries exclude prompts, source bodies, tool result bodies and private chain-of-thought. Successful searches may attach actual result titles/URLs; snippets remain model context rather than stored trace bodies.

Trace writes require the current owner, operation token, running status and expiry. Each attempt is capped at 300 emitted events. Run activity and JSON/Markdown exports include the most recent **100 operations and 600 events**, a bounded window rather than exhaustive history. New-run activity can be polled by request UUID before its simulation ID exists. A model phase completion means a typed proposal was received; validation and checkpoint commit must still succeed.

The creation manifest preserves original engine/prompt versions; each newly generated round records its own execution versions. Compatible upgrades do not invalidate older saved runs solely because the current prompt version differs.

## Branches

A branch is a deep copy of the latest completed snapshot, with `parentId`, `forkRound` and a new intervention. The parent is immutable from the branch's perspective. Recorded rounds, sources, privacy settings and accumulated usage are copied; conversation and report reset. New execution activity belongs to the branch. The next three rounds execute under the intervention, up to a 24-round lineage limit. Comparisons are conditional simulation differences, not measured causal effects on real people.

## Metrics

Let actor stance be `x` in `[-1, 1]`:

- `support = (mean(x) + 1) × 50`, in percent of the normalized stance scale.
- `polarization = standardDeviation(x) × 100`, bounded to `[0, 100]`, shown as disagreement.
- `activity` counts actions whose kind is not `observe`.

Influence and graph weights are simulation assumptions; they are not estimates obtained from human-population calibration. Source references establish provenance IDs, not factual entailment guarantees.

## Storage

`DATABASE_URL` selects PostgreSQL through Node `pg`, including Neon PostgreSQL URLs. Otherwise `TURSO_DATABASE_URL` selects libSQL/Turso; absent either, local development uses `file:.data/branchlab.db` with WAL. Hosted execution rejects file-backed storage. A common adapter exposes parameterized statements, transactional batches and short SQL callbacks. The aggregate remains JSON text with indexed owner/revision columns across both backends.

PostgreSQL transaction callbacks run at `SERIALIZABLE` isolation; serialization failures and deadlocks may repeat the SQL callback for at most eight attempts with bounded backoff. This protects read-then-write quota/revocation predicates across connections. **Only the short SQL callback is retried**: it must never contain model inference, search or other external side effects. A simple `execute` call is one statement, not an implicit multi-statement serializable transaction. libSQL queues work per client and uses explicit write transactions. The PostgreSQL pool has five connections per process; remote connections require verified TLS and environment-owned settings.

Schema initialization is idempotent, records version 3 and uses a PostgreSQL advisory transaction lock. Tables cover simulations, sessions, revocations, rate limits, operations and trace events. Future incompatible changes need explicit migrations. Backups remain operator-owned; export is not a physical database backup. There is no unrestricted database-reset route; authenticated workspace erasure deletes only the caller's data and revokes that session.

## Authentication, secrets and limits

Each browser has a random 256-bit, HttpOnly, SameSite=Strict session token, expiring after 30 days. Every simulation read, mutation and export includes the owner predicate. There is no account synchronization or recovery when the browser cookie is lost; export important runs. `APP_PASSWORD` gates the instance, not individual accounts. Password changes invalidate previously unlocked sessions.

New cloud-model runs require explicit `privacy.allowCloud: true`; absent or false consent is denied. Saved legacy runs lacking a privacy object retain compatibility, while explicit false prevents cloud inference. Cloud and web-search consent are separate. Local inference uses the configured endpoint, which may be remote; provider selection alone does not promise offline operation. An analyst-only source may still be sent to the selected cloud model for analyst work when cloud processing is permitted.

Hosted live usage requires an instance password. Global/per-session SQL reservations allocate the maximum three requests per agent turn, or three times actor count per round. Failed and partially used reservations are not refunded. Saved usage counts actual successful model steps recorded by completed work, not provider billing or every failed/aborted attempt. SDK retries are disabled; user retries may still cost more. Limits include 100 runs, 5,000 journal operations per workspace and 40 saved chat questions per run. These controls target personal or small trusted deployments, not public SaaS identity management.

Session lock atomically revokes active operation states and lease tokens. Workspace erasure removes owned runs, journal and traces and adds a revocation marker so late work cannot recreate them. Expired workspaces are lazily cleaned on traffic, at most every five minutes per process; there is no scheduled retention worker. Provider records, operator backups and downloaded exports are outside that deletion boundary.

Credentials and model base URLs live in environment variables. Browser requests cannot select a network destination. Mutations validate same-origin context, JSON content type, streamed byte size and Zod schema. Responses are not cached. Errors expose fixed safe categories, retryability, generated correlation IDs and optional retry delays rather than provider bodies or credentials. Logs use safe codes, normalized routes and generated request IDs. Response correlation IDs are distinct from client UUIDs used for operation idempotency.

## Alternatives considered

- **Persistent Python simulation process:** useful for very large environments; adds a service and process lifecycle incompatible with the single serverless deployment goal.
- **Mastra-native durable workflow + job scheduler:** a possible next stage for unattended jobs and per-actor recovery. The current PostgreSQL adapter persists application data; it does not turn an ephemeral workflow into a durable worker.
- **Cloudflare Workers:** a different runtime compatibility target. This release chooses Vercel Node and documents it as the supported path.
- **Hosted graph/vector dependency:** not required for small bounded source collections; explicit relationships and source IDs are simpler and also work offline. Full graph retrieval and embeddings can be introduced when evidence volume warrants them.

## Verification boundary

Automated tests validate software contracts and deterministic demo behavior. They do not establish real-world forecasting accuracy. A forecasting extension would require timestamped unresolved questions, resolution rules, held-out outcomes, comparison baselines and proper scoring rules, as used by [ForecastBench](https://www.forecastbench.org/docs/). See the research notes for the conceptual distinction.

Offline protocol tests exercise the real provider adapter and Mastra Agent against an ephemeral OpenAI-compatible HTTP fixture, including actual tool-call/result exchanges. They do not validate external model quality or a live account. PostgreSQL integration requires an explicit disposable `TEST_DATABASE_URL` ending in `_test`; CI provides a PostgreSQL service. This tests adapter transactions and concurrency, not a deployed Neon account. Any local reference-source directory is excluded from the application and has no runtime dependency role.
