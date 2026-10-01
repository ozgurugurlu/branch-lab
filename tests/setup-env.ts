// Never inherit a developer's production DB, paid-provider credentials or hosted flags.
// Individual tests provide explicit temporary configuration. Only the opt-in
// PostgreSQL suite reads TEST_DATABASE_URL and requires a disposable *_test DB.
for (const name of [
  "DATABASE_URL",
  "DATABASE_SCHEMA",
  "DATABASE_SSL_CA",
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "BRAVE_SEARCH_API_KEY",
  "OLLAMA_API_KEY",
  "LMSTUDIO_API_KEY",
  "OLLAMA_BASE_URL",
  "LMSTUDIO_BASE_URL",
  "ENABLE_LOCAL_MODELS",
  "APP_PASSWORD",
  "APP_ORIGIN",
  "VERCEL",
  "CF_PAGES",
  "WORKERS_CI",
])
  delete process.env[name];
process.env.NEXT_TELEMETRY_DISABLED = "1";
