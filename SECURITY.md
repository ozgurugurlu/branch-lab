# Security and deployment model

Branchlab is for local use or a **small trusted instance**. Browser-session isolation and a shared `APP_PASSWORD` are not individual accounts, enterprise RBAC or a public SaaS identity system. Set a strong password and use HTTPS for an accessible deployment. Hosted live model connections require the password; removing it opens that instance's session-owned workspaces to whoever holds their cookies.

## Sessions and requests

A random 256-bit HttpOnly, SameSite=Strict cookie identifies each browser workspace. It expires 30 days after creation; activity does not extend it. HTTPS/hosted deployments use Secure cookies. Password changes invalidate previously unlocked sessions. Losing the cookie loses access to that workspace; there is no account recovery or cross-device synchronization.

Every run, export, operation and trace read is scoped to the session owner. Locking interrupts existing operation records and revokes their write leases; unlocking does not revive those operation tokens. Workspace erasure atomically removes owned data and fences late commits. It cannot retract work already received by a model provider. [Retention and deletion](docs/privacy.md).

Mutations reject cross-site Fetch Metadata and mismatched supplied origins. When configured, `APP_ORIGIN` is authoritative; otherwise the request destination origin is used. Arbitrary `X-Forwarded-Host` is not trusted. Non-browser clients may omit Origin, but still need the session and authentication. JSON input has schema, encoding, byte-size and receive-time limits. Password attempts and request/model/search budgets are persisted in SQL, including global limits that survive cookie resets.

API responses use `no-store`, safe error codes and server-generated correlation IDs. Logs omit prompts, provider bodies and user-controlled path segments. The browser receives nosniff, frame restrictions, a restrictive permissions policy and a same-origin CSP. The static Next.js shell still permits inline bootstrap scripts/styles; this is not a nonce-based strict CSP. Configure TLS and any HSTS policy at your deployment edge.

## Secrets, tools and source material

Credentials and model endpoints belong in server environment variables, never `NEXT_PUBLIC_*`, issue reports or exported scenarios. Cloud inference uses fixed provider URLs; local endpoints are operator-controlled and validated. Redirects are rejected. URL validation does not resolve DNS, so operators must trust their configured gateways.

Agents have bounded, read-only tools for authorized scenario observations. They have no shell, filesystem, arbitrary HTTP fetch or account-operation tools. Optional Brave search requires its server credential and explicit per-run consent, and is restricted to eligible research actors. Queries can reveal information from their observations. Result snippets remain untrusted data; the server does not fetch linked pages.

Source documents and search results can contain prompt injection. Scope checks, output schemas, entity validation and deterministic state updates limit its impact; they do not guarantee that generated prose or decisions resist malicious instructions. Treat outputs as synthetic claims and verify consequential conclusions independently.

The application database stores full source text, simulation histories and actor memories. It does not add application-level encryption to these records. Protect database credentials, storage and backups. Exports contain private scenario material. Operation traces omit raw prompts/tool arguments but may contain public search-result titles and URLs.

PostgreSQL uses verified TLS for remote connections and short SERIALIZABLE transactions with bounded conflict retries. SQLite/Turso use short write transactions. Ownership predicates, revisions, lease tokens and revocation checks prevent stale writes; external model calls are not exactly-once. [Deployment details and verification limits](docs/deployment.md).

## Reporting vulnerabilities

Use your hosting repository's private vulnerability reporting feature if enabled, or contact its maintainer privately. Share a minimal reproduction and a request correlation ID when useful. Do not publish credentials, browser cookies, database URLs or private source documents. This template does not designate an external recipient or promise a response time.
