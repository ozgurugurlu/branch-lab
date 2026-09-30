# Deploying Branchlab

## Vercel + Turso

1. Put this repository in your own Git hosting account and import it into Vercel as a Next.js project.
2. Create a remote Turso/libSQL database and an authentication token. Set `TURSO_DATABASE_URL=libsql://…` and `TURSO_AUTH_TOKEN` in Vercel. Do not deploy the default `file:` URL; the app intentionally rejects it on Vercel.
3. Set a strong `APP_PASSWORD`. Live provider calls on hosted deployments stay disabled until this is configured. Each browser still has its own isolated run collection.
4. Add `OPENAI_API_KEY` and/or `GOOGLE_GENERATIVE_AI_API_KEY` for the providers you want. Leave unused providers unset. Keys never enter the browser.
5. Use Node.js 22 or newer and enable Fluid Compute. The build command is `npm run build`; framework defaults supply the start/output settings. No cron job or additional worker is required.
6. Deploy, visit `/api/health`, unlock the instance in Settings, and run the demo first. Then validate one short live scenario against your provider account.

`APP_ORIGIN` can specify the public `https://…` origin when a reverse proxy changes the internal request origin. Limit it to the actual application origin.

Vercel documents a 300-second Hobby maximum under Fluid Compute. Branchlab routes declare 240 seconds and impose their own 180-second execution deadline. These are upper bounds, not a promise that every model completes. Slow calls leave the previous checkpoint intact. [Current Vercel limits](https://vercel.com/docs/functions/limitations).

The first request creates SQL tables and indexes using idempotent statements. For an existing production deployment, use a database token scoped to the application database. Do not point the app at unrelated shared tables.

## Docker / persistent Node server

```sh
docker build -t branchlab .
docker volume create branchlab-data
docker run --rm -p 3000:3000 \
  --env-file .env.local \
  -e TURSO_DATABASE_URL=file:/app/.data/branchlab.db \
  -v branchlab-data:/app/.data \
  branchlab
```

The image runs as an unprivileged user and stores local data in the named volume. Put an HTTPS reverse proxy in front of any Internet-facing server and set `APP_PASSWORD`. The server binds to `0.0.0.0` inside the container. For host inference on macOS/Windows Docker, use `http://host.docker.internal:11434/v1` or port `1234`; Linux may need `--add-host=host.docker.internal:host-gateway`.

For a non-container host:

```sh
npm ci
npm run build
npm start
```

Next.js reads `.env.local`. With Docker, `--env-file` passes variables at runtime; secrets are excluded from the image build.

## Local models from a cloud deployment

`localhost` in Vercel refers to Vercel's machine. It cannot reach an Ollama or LM Studio server on your laptop. Run the entire app locally, or configure a public **HTTPS, authenticated** OpenAI-compatible endpoint you operate. Keep access control at that endpoint; never expose an unauthenticated local model service to the Internet. [Detailed provider setup](models.md).

## Operations

- `/api/health` tests database readiness without exposing credentials.
- `DAILY_MODEL_CALL_LIMIT` defaults to 1,000 reserved logical calls per 24-hour window. A session is also capped at 300 reservations per hour. Failed calls consume reservations; provider retries can cost extra.
- An interrupted mutation can remain locked for at most 210 seconds. Wait for expiry, reload and retry. Do not delete database locks manually while requests are active.
- Runs are owned by a 30-day browser session. This version has no account recovery or cross-device synchronization. Export JSON/Markdown before clearing cookies.
- Back up the database. Deleting a run is permanent; deleting a parent leaves independent branches available but removes their live parent comparison.
- Source text is stored as provided in the database and sent to the selected provider for live runs. Local providers keep inference on your configured server; telemetry/network behavior of dependencies and local servers is outside the simulation engine.
- There is no scheduled cleanup in this release. Operators can apply retention to expired sessions, orphaned runs and rate-limit entries using their own database maintenance policy.

## Scope of deployment verification

The supported artifact is a standard Next.js production build. CI builds and tests it without cloud keys. Remote Turso connectivity, provider-account access, domain configuration and a real Vercel deployment must be validated with your credentials. Cloudflare Workers configuration is not supplied or claimed tested.
