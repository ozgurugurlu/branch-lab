# Architecture

## Decision

Branchlab is a small-population scenario lab, implemented as one Next.js application with Mastra agent execution and explicit SQL persistence. This design was selected after comparing social-agent research frameworks, forecasting benchmarks, current Mastra integrations and serverless execution constraints on 2026-09-30. The choices below are engineering analysis, not claims made by the research sources.

## Separation of responsibilities

The scenario architect produces a typed world: actors, their objectives, initial stances, relationships and assumptions. Sources have stable run-local IDs and SHA-256 content hashes. The architect can interpret supplied material; it cannot fetch a URL, execute code or operate the user's accounts.

Every actor receives a bounded observation from a frozen previous-round snapshot. Its own private memories and assigned sources accompany public actions of connected actors. The entire simulation object is never passed to an actor. The round workflow collects independent proposals, validates them and applies a deterministic reducer. Histories contain public events; actor memory is recorded to support inspection by the human operator.

The analyst receives aggregate metrics for the complete run and a bounded window of detailed public events: at most the latest four rounds and 48 events. Report and analyst-chat event references must appear in this supplied window, rather than merely existing somewhere in the database. Actor interviews use only that actor's authorized observations and matching conversation thread. Conversation messages capture the round at which they were asked. A report lists findings with event IDs, uncertainties and source references, which are checked before saving.

## Context and evidence limits

Each actor sees its own profile, up to eight retained memory notes, assigned source documents, connected actors' public actions from the previous two rounds, and applicable interventions. Other actors' private memory, objectives, assigned documents, and interview threads are excluded. An actor may cite an older **own** action when its event ID is still explicitly present in one of its retained memory notes. These remembered IDs are derived from the actor's actual recorded actions; they do not grant access to older neighbor events or forgotten events.

Live model inputs use the first **up to 6,000 characters per source document**, with a **24,000-character total document-content budget** divided evenly across the selected source collection. An actor's selected collection contains only its assigned documents. The full imported text and its SHA-256 hash remain stored and available in exports; this release does not retrieve passages by semantic relevance. A source ID establishes which document was supplied, not that an omitted passage was considered or that a generated claim is entailed by it. Payloads identify truncated documents explicitly. Reports and live chat answers surface context-limit notices when documents or detailed event history were omitted. The source view should be interpreted alongside these limits.

The deterministic demo does not interpret documents or call a model. Its reports describe recorded synthetic events and aggregate statistics; the same reference checks prevent fabricated citations. Neither source inclusion nor repeated synthetic agent agreement verifies a real-world claim.

## Execution and durability

One round per POST request keeps execution within Vercel's Node function limits. The request deadline is 180 seconds, with a 210-second SQL lease and a route maximum of 240 seconds. Actor calls are bounded and concurrency is at most three. These bounds can still produce a timeout on slow local hardware; reduce the population or select a faster model.

The application stores a complete bounded simulation aggregate as JSON. SQL columns index ownership, title, revision and timestamps. This prioritizes a portable, inspectable first version over complex event-sourcing infrastructure. It is not optimized for million-agent data volumes. Source text, chat, manifests and snapshots share the same atomic aggregate; there is no separate object bucket to configure.

Model-bearing updates to existing runs acquire a lease through a conditional SQL update. A commit must match the original revision, a random fencing token and an unexpired lease. An old request cannot overwrite a new lease holder. Creation and branching atomically insert new records; deletion rejects an active lease. Different simulations can progress independently. No database transaction stays open while an LLM runs.

`expectedRound` makes completed step retries idempotent: an already committed round returns the newest state without another call. If an operation crashes before committing, its lease expires and the operation can be retried. External model calls are **not exactly-once**: retries can repeat provider charges. Domain checkpoints are durable; Mastra workflow execution itself is not configured with native durable storage or suspend/resume.

The browser schedules auto-run requests and stops after the current round when paused. There is no background worker. Closing a tab may interrupt a request; the last committed snapshot remains authoritative. The app never calls a model in a fire-and-forget background promise.

## Branches

A branch is a deep copy of the latest completed snapshot, with `parentId`, `forkRound` and a new intervention. The parent is immutable from the branch's perspective. Recorded pre-branch history is copied; the next three rounds execute under the added condition, up to a 24-round lineage limit. Comparisons are conditional simulation differences, not measured causal effects on real people.

## Metrics

Let actor stance be `x` in `[-1, 1]`:

- `support = (mean(x) + 1) × 50`, in percent of the normalized stance scale.
- `polarization = standardDeviation(x) × 100`, bounded to `[0, 100]`, shown as disagreement.
- `activity` counts actions whose kind is not `observe`.

Influence and graph weights are simulation assumptions; they are not estimates obtained from human-population calibration. Source references establish provenance IDs, not factual entailment guarantees.

## Storage

Local development uses `@libsql/client` with a file database and WAL. Hosted execution uses `@libsql/client/web` and a remote Turso/libSQL database. We avoid a Mastra filesystem store in serverless deployments; [Mastra's web deployment documentation](https://mastra.ai/docs/deployment/web-framework) warns about filesystem-backed storage. The separate [Turso client](https://docs.turso.tech/sdk/ts/reference) provides the conditional SQL operations needed for fencing and rate limits.

Schema v1 is created idempotently on first access. There is no destructive reset endpoint. Future schema changes should introduce versioned migrations rather than editing existing columns in place. Back up local SQLite files with a SQLite-aware backup operation; use the hosted database's backup/export facilities in production.

## Authentication, secrets and limits

Each browser has a random 256-bit, HttpOnly, SameSite=Strict session token, expiring after 30 days. Every simulation read, mutation and export includes the owner predicate. There is no account synchronization or recovery when the browser cookie is lost; export important runs. `APP_PASSWORD` gates the instance, not individual accounts. Password changes invalidate previously unlocked sessions.

Hosted live model usage requires an instance password. Global SQL model-call reservations prevent resetting the browser cookie from bypassing the instance budget. Reservations count logical calls, including failures; SDK retries can add provider requests. Per-session request/create/chat limits cap routine usage. These controls are appropriate for a personal or small trusted deployment, not a public SaaS identity system.

All credentials and model base URLs live in environment variables. Browser requests cannot select a network destination. Mutations validate same-origin context, content type, streamed body size and Zod schema. Errors never return provider response objects, source prompts or credentials. Logs record only an error code and route.

## Alternatives considered

- **Persistent Python simulation process:** useful for very large environments; adds a service and process lifecycle incompatible with the single serverless deployment goal.
- **Mastra-native durable workflow + Postgres/Inngest:** a sensible next stage for unattended jobs and per-actor retry caching. Adds infrastructure not needed for bounded interactive runs.
- **Cloudflare Workers:** a different runtime compatibility target. This release chooses Vercel Node and documents it as the supported path.
- **Hosted graph/vector dependency:** not required for small bounded source collections; explicit relationships and source IDs are simpler and also work offline. Full graph retrieval and embeddings can be introduced when evidence volume warrants them.

## Verification boundary

Automated tests validate software contracts and deterministic demo behavior. They do not establish real-world forecasting accuracy. A forecasting extension would require timestamped unresolved questions, resolution rules, held-out outcomes, comparison baselines and proper scoring rules, as used by [ForecastBench](https://www.forecastbench.org/docs/). See the research notes for the conceptual distinction.
