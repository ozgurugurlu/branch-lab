# Implementation contract

Internal interfaces for Branchlab v0.1. Public JSON routes return `{ data: T }`; errors return `{ error: { code, message, retryable } }`. No browser API keys or base URLs. All timestamps ISO UTC.

## HTTP

- GET `/api/config`: AppConfig (also establishes HttpOnly browser session).
- POST `/api/session`: `{password}` unlocks instance; DELETE locks it.
- GET `/api/simulations`: SimulationSummary[].
- POST `/api/simulations`: CreateSimulationInput → Simulation. Architect executes before storage.
- GET `/api/simulations/:id`: Simulation.
- DELETE `/api/simulations/:id`: `{deleted:true}`.
- POST `/api/simulations/:id/step`: `{expectedRound:number}` → Simulation. Completed stale round returns current state, concurrent active operation is 409. One whole round per request.
- POST `/api/simulations/:id/branch`: `{intervention:string, title?:string}` → Simulation; forks latest completed snapshot, copies history, adds three future rounds (cap 24).
- POST `/api/simulations/:id/chat`: `{message:string, actorId?:string}` → Simulation (history persisted). No actorId means analyst.
- POST `/api/simulations/:id/report`: `{}` → Simulation with report.
- GET `/api/simulations/:id/export?format=json|markdown`: downloadable artifact.
- GET `/api/health`: DB readiness, no secrets.

Every route scopes ownership to browser session. Mutation operations validate origin when supplied and content type, size and Zod input. Live operations require unlocked session if APP_PASSWORD configured; on Vercel live providers additionally require APP_PASSWORD. Authentication and global live-call limits are persisted in SQL.

## Engine module, owned by engine agent

`src/mastra/simulation.ts` exports:

```ts
buildWorld(input: CreateSimulationInput, sources: Source[], signal?: AbortSignal): Promise<World>
executeRound(simulation: Simulation, signal?: AbortSignal): Promise<Round>
generateReport(simulation: Simulation, signal?: AbortSignal): Promise<Report>
answerQuestion(simulation: Simulation, message: string, actorId?: string, signal?: AbortSignal): Promise<string>
```

Mastra agents and a per-round workflow orchestrate model execution; deterministic reducer owns metrics. Every actor observes frozen previous-round state, own memories, source facts and connected actors' recent public actions. Validate entity references and finite ranges. Native cloud structured outputs and local JSON validation. Parallelism at most 3; total timeout is controlled by route (180s), individual calls at most 40s. Demo must implement same interfaces with deterministic original data and explicitly marked generated responses; no cloud fallback on failure. Demo custom scenario actors may be archetypes but must address provided question/context. Sources are provided with stable IDs and SHA-256 hashes. Engine does not write database.

## Models module, owned by providers agent

`src/lib/providers.ts`: export `PROVIDERS` (client-safe ProviderStatus[] base catalog, configured false except demo), optional helpers.
`src/server/models.ts`: `resolveModel(config: ModelConfig)` → Mastra-compatible SDK model, `getProviderStatuses(): ProviderStatus[]`. Native OpenAI Responses and Google SDK preferred, OpenAI-compatible for local. Env-owned endpoints only. No demo resolution, clear safe errors. Custom local model IDs accepted; cloud IDs restricted catalog. No filesystem/database dependencies in this module.

## Frontend, owned by frontend agent

Own `src/components/**`, `src/app/page.tsx`, `src/app/layout.tsx`, `src/app/globals.css`, `src/app/icon.svg`, `src/lib/templates.ts` and `public/**`. Do not touch API, schemas/types, package/config files. Use types above. Accessible responsive warm paper/ink/vermilion composition, sidebar runs, central relationship graph/timeline/sources/report and right analyst/actor chat. New-run modal with model, scenario, actor count, rounds, seed and text/Markdown file import. API configuration and authentication settings dialog. Resume browser-driven auto-run rounds; pause stops scheduling next round. Branch scenario and compare parent metrics. Export menu. No fake model claims, demo clear. No marketing landing page.

## Persistence and routes, root-owned

Local libSQL file or remote Turso web client. SQL CAS revision + fencing-token lease (210s) for all mutations with model calls. Complete snapshots persisted atomically, failures release lease and preserve previous snapshot. Mid-round crash retries can repeat provider charges; no exactly-once call claim. Source documents stored transactionally with run aggregate; bounded text imports, not unrestricted binary object storage. Domain snapshots are durable; Mastra workflow itself is ephemeral.
