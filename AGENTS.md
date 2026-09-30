# Working on Branchlab

- Read `docs/architecture.md` and `docs/implementation-contract.md` before changing execution or persistence contracts.
- Read `docs/agent-runtime.md` and `docs/privacy.md` before changing tool capabilities, model prompts, source access or data retention.
- Keep all source documents, keys and database files out of Git. Provider endpoints and credentials are server-owned environment settings.
- Simulation actors must receive explicit, bounded observations, never the full run or another actor's private memory. Every round uses one frozen prior snapshot.
- LLM responses propose typed actions. Ordinary code validates IDs and ranges, computes metrics, and owns state writes.
- Preserve owner predicates, revision checks and lease fencing on all existing-run updates. Never hold a SQL transaction during model inference.
- Keep deterministic demo behavior separate and visibly labeled. Never silently fall back to demo data after live-provider failures.
- Support and disagreement are simulated indices, not calibrated real-world probabilities. Do not claim scientific forecasting accuracy from software tests.
- Use `npm run check` and `npm run test:e2e` for behavioral changes. Test providers offline; live integration checks require explicit local configuration.
- PostgreSQL integration tests require an explicit disposable `TEST_DATABASE_URL` ending in `_test`. Tests must never inherit production database connections or provider credentials.
- Format changed files with Prettier. Keep API responses, schemas and client types synchronized; document deployment/runtime limits honestly.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
