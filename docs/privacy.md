# Privacy, permissions and data lifecycle

Branchlab is designed for a personal or small trusted instance. Its protections are implemented in the server and tested against SQLite and PostgreSQL; it does not implement organization accounts, team roles, invitations, account recovery or a compliance certification.

## Who can see what

| Subject                      | Allowed access                                                                                         | Excluded access                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Workspace owner              | All sources, synthetic memories, messages, reports, traces and exports in their browser workspace      | Other browser workspaces                                                                          |
| Scenario architect           | Scenario question/context and sources marked for actors                                                | Analyst-only source content and names                                                             |
| Simulated actor / interview  | Own profile/memory, assigned actor-visible documents, direct contacts and bounded recent public events | Analyst-only sources, other actors’ private memory, unobserved events and other interview threads |
| Analyst                      | Complete source collection, public actor state, trajectory metrics and a bounded recent-event window   | Unrelated workspaces and secret server configuration                                              |
| Research actor’s search tool | A bounded model-authored query, only when enabled for that run                                         | Arbitrary URL fetching, filesystem/shell execution and user accounts                              |
| Database/server operator     | Server storage and deployment configuration                                                            | No cryptographic isolation from the operator is promised                                          |

Actor capability profiles are modeling assumptions. Actual permissions are the data captured in each tool closure and the allowed tool registry, enforced again by evidence validation. A prompt alone is not the security boundary. Supplied documents and tool/search results are untrusted data, even when they contain role labels or instructions.

## Processing consent

A new OpenAI or Gemini run requires `privacy.allowCloud: true`. Withholding it is rejected before a provider call; existing saved runs retain their prior behavior. Branches inherit permissions. The selected provider is immutable for an existing run. Importing a file sends its text to this application server and stores it in the configured database; no inference runs solely because a file was selected.

`privacy.allowWebSearch` defaults to false and is independent of model-processing consent. The operator must also configure `BRAVE_SEARCH_API_KEY`. Only the research profile receives web search. Queries are model-authored and can include information derived from an allowed source, so do not enable search for material you cannot disclose to the search provider. The server contacts one pinned Brave endpoint, refuses redirects, limits each response, and never fetches search-result URLs. Returned snippets are unverified external claims. Result titles and URLs can appear in owner-visible execution history and exports.

Ollama and LM Studio connect from the application server to the operator’s configured endpoint. That endpoint may run on another machine. Remote database storage and hosting logs also depend on deployment choices. Branchlab does not promise that choosing a local model keeps every byte on a laptop.

## Browser sessions and instance access

A 256-bit random HttpOnly, SameSite=Strict cookie identifies a workspace for 30 days. HTTPS deployments use Secure cookies. Every read, export and mutation includes the owner predicate. `APP_PASSWORD` gates the instance, and password changes invalidate previously unlocked sessions. Locking also interrupts registered operations and invalidates active write leases, so a model response already in progress cannot commit after a lock/unlock cycle.

When configured, `APP_ORIGIN` is the authoritative accepted browser mutation origin. Same-origin checks, body limits, fixed-window SQL budgets, content security headers and server-owned endpoints reduce the exposed surface. CLI requests without an Origin remain supported. This is not a substitute for a production identity provider when opening a multi-tenant public service.

## What is stored

The database stores scenario/source text, hashes, artificial actors and memories, recorded events, messages, reports, request-content hashes used for idempotency, and bounded execution metadata. It does not store API keys or model prompts in the operation/trace tables. Execution events contain role, tool, status, timing and safe activity summaries; they do not contain private chain-of-thought. A run’s initial engine/prompt manifest is preserved, with current versions recorded for later execution.

Application error logs contain safe codes, normalized route names and generated request IDs. They do not intentionally include request bodies, source text, raw upstream error objects, provider URLs or credentials. Hosting infrastructure may retain its own access logs. Credentials remain in environment settings. Remote PostgreSQL uses verified TLS; local SQLite is not application-level encrypted. Protect the host account and backups accordingly.

Mastra's default diagnostic loggers are explicitly disabled on agents, internal model runtimes, structured output and workflows. The application keeps its own bounded, sanitized activity feed. Regression tests check that secret sentinels in sources and upstream failures do not reach console output.

## Erasure and retention

Settings requires typing `DELETE MY WORKSPACE` before calling the erasure endpoint. One transaction revokes the session and deletes its simulations, operations, traces and session-specific rate-limit entries. Write fences and operation tokens prevent late inference from restoring erased data. Active network requests are not remotely recalled, and provider-side data already sent cannot be retracted by deleting local records.

Expired sessions and their data are cleaned lazily on application traffic, at most every five minutes per process. An idle deployment does not run a background cleanup job; use an operator maintenance schedule if you require a fixed deletion deadline. Revocation tombstones contain only an opaque token and timestamp and are retained for one day to fence late requests. Operator backups and cloud-provider retention policies are outside this erasure operation.

Runs are bounded to 100 per workspace, operation metadata to 5,000 records, and execution emission to 300 events per operation. The trace API and exports show the latest 100 operations and 600 events for a run. Clearing a browser cookie alone loses access; it does not immediately delete the old workspace. Use explicit erasure before clearing cookies when possible.

## Recovery and limitations

A stable request UUID prevents duplicate completed create, branch and chat operations. Reusing an ID with different input is rejected. A failed or interrupted model attempt may have already incurred charges; retrying it can call the provider again. Completed checkpoints and their operation records commit atomically. There is no exactly-once guarantee for external inference.

No URL ingestion, arbitrary browsing, connectors, email, shell, code execution or autonomous external writes are enabled. Web search is an explicit bounded capability. Provider access and behavioral realism still need validation with your own deployment and models.
