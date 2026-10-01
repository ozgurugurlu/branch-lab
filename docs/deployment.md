# Deploying Branchlab

Branchlab 0.3 supports a Next.js **Node** deployment on Vercel, Docker or a persistent Node server. Use Node **22.13 or newer**. Cloudflare Workers configuration is not supplied or claimed compatible.

## Prepare the database

From the repository directory, install dependencies, copy the example without overwriting an existing file, and configure your database:

```sh
npm ci
cp -n .env.example .env.local
# Edit .env.local for Neon/PostgreSQL or Turso; the default uses local SQLite.
npm run db:prepare
npm run dev
```

`db:prepare` calls the application's existing schema initializer and then closes the database connection. It checks PostgreSQL compatibility and creates missing application tables/indexes and the schema-version record. Repeating it preserves existing records; it does not reset data, create a browser session, run retention cleanup or contact an LLM. `npm run dev` runs preparation automatically through `predev`, so the separate command is optional. A failure prints a safe error category and guidance and prevents the development server from starting.

The command uses Next.js's environment loader. By default, its precedence is the existing shell environment, `.env.development.local`, `.env.local`, `.env.development`, then `.env`; variable expansion matches Next.js. Run `NODE_ENV=production npm run db:prepare` to check production environment files instead. Test mode omits `.env.local`. Keep database credentials in these server settings; the command never prints connection URLs or raw driver errors. [Next.js environment loading](https://nextjs.org/docs/app/guides/environment-variables).

Preparation is a separate process, not a persistent database service. It does not start a managed Neon service, reserve a warm connection, or eliminate session/configuration/history loading in the browser. Neon may suspend again after inactivity. On its next connection the app still validates PostgreSQL table metadata; a compatible complete schema with the current version skips redundant DDL and migration-record writes.

`npm ci` and `npm run build` never invoke database preparation. Production startup and the Docker image retain request-time initialization, so they need no preparation hook or development-only TypeScript runner. Use the optional command from a full source checkout with development dependencies installed; it is not included in the standalone runtime image. A successful preparation check does not verify model credentials or all runtime data-write permissions.

## Vercel

1. Import your repository as a Next.js project. Use `npm run build` and the framework's default output settings.
2. Configure **one database option** below. Hosted deployments reject filesystem SQLite; no writable application filesystem is needed with PostgreSQL or Turso.
3. Set a strong `APP_PASSWORD`. This protects demo workspaces too and is required for hosted live model connections. Each browser retains its own run collection; the password does not merge them.
4. Set `APP_ORIGIN=https://your-app.example`. When present, this is the authoritative accepted browser origin for mutations. Use the actual origin for each deployment, without credentials, a path, query or fragment. A production origin will block mutations from a differently named preview deployment.
5. Add the desired model credentials and, optionally, `BRAVE_SEARCH_API_KEY`. See [provider setup](models.md). Keep all secrets in server environment settings.
6. Deploy, check `/api/health`, unlock Settings and complete a demo run. Then validate a small live scenario using your own provider account.

Enable Fluid Compute and confirm your plan permits the routes' declared **240-second maximum**. Branchlab imposes a **180-second operation deadline** and a **210-second SQL lease**. These bounds do not guarantee that a slow model finishes. [Vercel function limits](https://vercel.com/docs/functions/limitations).

## Database options

| Backend                           | Server configuration                                   | Suitable deployment                      |
| --------------------------------- | ------------------------------------------------------ | ---------------------------------------- |
| Neon or another PostgreSQL server | `DATABASE_URL=postgresql://…`                          | Vercel, Docker, persistent Node          |
| Turso/libSQL                      | `TURSO_DATABASE_URL=libsql://…` and `TURSO_AUTH_TOKEN` | Vercel, Docker, persistent Node          |
| Local SQLite through libSQL       | `TURSO_DATABASE_URL=file:.data/branchlab.db`           | Local development or a persistent volume |

A nonempty **`DATABASE_URL` takes precedence** over the Turso settings. Changing the connection selects a different database; it does not transfer existing runs. Use a dedicated application database and credentials scoped to it. Startup creates tables, indexes and an additive schema-version record after checking existing application-table metadata; it does not reset or relocate existing runs.

### Neon / PostgreSQL

Use your Neon's **pooled** connection URL, with its actual username, encoded password and database name:

```dotenv
DATABASE_URL=postgresql://USER:PASSWORD@YOUR-ENDPOINT-pooler.neon.tech/DATABASE?sslmode=require&channel_binding=require
DATABASE_SCHEMA=branchlab
```

**Schema isolation:** PostgreSQL defaults to the dedicated `branchlab` schema. Other applications' `public.sessions` or similarly named tables are not read, modified or used as fallbacks. The database role needs permission to create the selected schema, or an operator must pre-create it with the required ownership/permissions. `DATABASE_SCHEMA` accepts one non-system ASCII identifier, up to 63 letters, digits or underscores, beginning with a letter or underscore; SQL fragments and search-path lists are rejected.

Every checked-out transaction—including a single query—sets its own search path to the selected schema, then `pg_temp`. PostgreSQL's catalog remains implicitly available; `public` is absent unless explicitly selected. This uses transaction-local state and does not rely on session settings surviving a Neon pooler handoff. Single queries retain READ COMMITTED isolation; explicit transactional writes use SERIALIZABLE.

For an **existing, compatible Branchlab installation whose data is already in `public`**, explicitly set `DATABASE_SCHEMA=public` to continue using it. Changing the default to `branchlab` selects a separate workspace store; existing public-schema data remains in place. There is no automatic migration or fallback. Do not choose `public` when its tables belong to another application. Startup rejects incompatible application columns, types, defaults or uniqueness requirements with `DATABASE_SCHEMA` before application-table initialization or retention cleanup; existing tables are not repaired or deleted automatically.

Only `sslmode` and `channel_binding` URL options are accepted. Remote connections always verify the TLS certificate and hostname, including when `sslmode=require` is supplied. `sslmode=verify-full` is also accepted. Plain connections and `sslmode=disable` are permitted only for loopback or `host.docker.internal`; a private LAN address still requires TLS. An optional `DATABASE_SSL_CA` can contain a private server's PEM certificate authority. Ambient `PGHOST` and `PGPASSWORD` settings are not used.

`channel_binding=disable|prefer|require` is accepted; the Node driver negotiates SCRAM channel binding when offered unless disabled. This is not a promise of libpq's strict `require` enforcement. The driver uses a pool of at most five connections per application process, with 10-second connection/idle limits and 15-second statement/idle-transaction limits. A hosted fleet can contain multiple processes; use provider pooling and appropriate database capacity.

Checkpoint and operation writes use short PostgreSQL `SERIALIZABLE` transactions, with bounded retries for serialization conflicts and deadlocks. No model inference runs inside a transaction. SQLite uses serialized short write transactions; both adapters use numbered parameters without runtime SQL rewriting. [node-postgres transactions](https://node-postgres.com/features/transactions), [pool lifecycle](https://node-postgres.com/apis/pool).

### Turso / SQLite

Leave `DATABASE_URL` empty to select libSQL. For Turso, replace the example file URL with your remote URL and set its auth token. Local SQLite files are created automatically and require persistent storage. Back up SQLite using a SQLite-aware backup procedure; use the hosted database's backup/export facilities for remote storage. JSON/Markdown run exports are useful archives, not a database restore mechanism.

## Docker / persistent Node

For persistent SQLite:

```sh
docker build -t branchlab .
docker volume create branchlab-data
docker run --rm -p 3000:3000 \
  --env-file .env.local \
  -e DATABASE_URL= \
  -e TURSO_DATABASE_URL=file:/app/.data/branchlab.db \
  -v branchlab-data:/app/.data \
  branchlab
```

The image runs as an unprivileged user. For Neon/Turso, supply the remote settings instead; the local database volume is unnecessary. Put an HTTPS reverse proxy in front of an Internet-facing instance, preserve its destination host, and set `APP_PASSWORD` and `APP_ORIGIN`. The container binds to `0.0.0.0:3000`.

For a non-container host, run `npm ci`, `npm run build`, then `npm start`. The start script loads production/local environment files while preserving existing shell variables and keeps relative SQLite paths outside the replaceable build directory. Docker receives runtime variables through `--env-file`; environment secrets are excluded from the image build.

For host inference on macOS/Windows Docker, use `http://host.docker.internal:11434/v1` or port `1234`. Linux may require `--add-host=host.docker.internal:host-gateway`. A Vercel function cannot reach your laptop using `localhost`; use a trusted authenticated HTTPS inference gateway or run the app locally. [Endpoint rules](models.md#local-inference-and-hosted-applications).

## Operations and limits

- `/api/health` checks database readiness without returning connection credentials.
- JSON bodies are limited to **256,000 bytes**, uncompressed UTF-8, with a **30-second receive deadline**. Individual agent executions allow up to **40 seconds**, three model steps and two tool calls; actor concurrency is at most three.
- `DAILY_MODEL_CALL_LIMIT` defaults to **1,000 reserved model requests per fixed 24-hour window**; a session is capped at the smaller of that limit and 300 per hour. Up to three requests are reserved per agent before work starts. Failures consume reservations; unused capacity is not refunded. SDK and workflow retries are disabled. Manually retrying unfinished inference can incur further charges. Saved-run call counts cover committed successes and are not a billing total.
- Optional Brave search needs both the server key and per-run consent. It permits at most three searches per operation, 30 per session per hour and 200 globally per 24-hour window. Queries leave the server; result URLs are not fetched. Demo runs do not perform web searches.
- SQL rate-limit responses include the actual reset interval in `Retry-After` and `error.retryAfterSeconds`. A provider rate limit without reset metadata uses a conservative 60-second suggestion. Errors include a safe code and correlation ID; do not add raw provider payloads to logs.
- Session ownership expires **30 days after creation**, without sliding renewal. Settings can lock the session or erase its workspace. Locking invalidates existing operation commits. Erasure removes owned runs, operations and traces and prevents their late recreation.
- Expired workspace cleanup runs on session traffic, at most once every five minutes per process. No scheduled cleanup worker is required; an idle deployment does not purge on a wall-clock schedule. Operator backups and provider-held records need their own retention policy. See [privacy](privacy.md).

## Verification boundary

Local SQLite and a real PostgreSQL 17 server were exercised, including transactions, ownership, quotas, lease fencing, concurrent deletion and isolation from incompatible public-schema tables. CI supplies its own PostgreSQL service. The PostgreSQL suite uses an explicit `TEST_DATABASE_URL` and requires a disposable database name ending in `_test`; it truncates application tables.

A configured Neon pooled endpoint was also checked with schema initialization, workspace authentication, demo creation, a saved round and erasure of the temporary verification workspace. This checks that particular connection; validate your own account and permissions. Remote Turso, cloud-model credentials, Brave credentials, DNS/TLS proxy setup and deployment to Vercel still need verification with your configuration. Automated demo tests establish software behavior, not forecasting accuracy or provider availability.
