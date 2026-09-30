import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { isIP } from "node:net";
import { isSupportedModel, PROVIDERS } from "../lib/providers";
import type { ModelConfig, ProviderId, ProviderStatus } from "../lib/types";
import { AppError } from "./errors";

type LocalProviderId = "ollama" | "lmstudio";
type LocalConnection = { baseURL: string; apiKey: string | undefined };

/** A redirect must never forward source text or credentials to another destination. */
const providerFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, redirect: "error" });

/** Messages are deliberately fixed: no credentials, raw URLs, or provider responses. */
export class ModelConfigurationError extends AppError {
  constructor(message: string) {
    super("MODEL_CONFIGURATION", message, 400, false);
    this.name = "ModelConfigurationError";
  }
}

function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function hostedRuntime(): boolean {
  return Boolean(env("VERCEL") || env("CF_PAGES") || env("WORKERS_CI"));
}

function googleKey(): string | undefined {
  return (
    env("GOOGLE_GENERATIVE_AI_API_KEY") ??
    env("GEMINI_API_KEY") ??
    env("GOOGLE_API_KEY")
  );
}

function cleanHostname(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

function isLoopback(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "host.docker.internal" ||
    (isIP(host) === 4 && host.split(".")[0] === "127")
  );
}

function isPrivateHost(host: string): boolean {
  if (isLoopback(host)) return true;
  if (
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    !host.includes(".")
  )
    return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  // IPv6 literals are excluded on hosted deployments, including mapped IPv4.
  // An operator can use a public DNS name for an authenticated remote server.
  return isIP(host) === 6;
}

function localConnection(provider: LocalProviderId): LocalConnection {
  if (env("ENABLE_LOCAL_MODELS") !== "true") {
    throw new ModelConfigurationError(
      "Set ENABLE_LOCAL_MODELS=true on the server to enable local providers.",
    );
  }

  const prefix = provider === "ollama" ? "OLLAMA" : "LMSTUDIO";
  const defaultURL =
    provider === "ollama"
      ? "http://127.0.0.1:11434/v1"
      : "http://127.0.0.1:1234/v1";
  const rawURL = env(`${prefix}_BASE_URL`) ?? defaultURL;
  const apiKey = env(`${prefix}_API_KEY`);
  let url: URL;
  try {
    url = new URL(rawURL);
  } catch {
    throw new ModelConfigurationError(
      `Set ${prefix}_BASE_URL to a valid OpenAI-compatible base URL ending in /v1.`,
    );
  }

  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol)
  ) {
    throw new ModelConfigurationError(
      `${prefix}_BASE_URL must use HTTP or HTTPS without embedded credentials, query parameters, or fragments.`,
    );
  }
  if (!url.pathname.replace(/\/+$/, "").endsWith("/v1")) {
    throw new ModelConfigurationError(
      `${prefix}_BASE_URL must end in /v1, not an individual API endpoint.`,
    );
  }

  const host = cleanHostname(url.hostname);
  const loopback = isLoopback(host);
  if (hostedRuntime() && isPrivateHost(host)) {
    throw new ModelConfigurationError(
      "Hosted deployments cannot use a private or loopback model endpoint. Configure an authenticated public HTTPS endpoint.",
    );
  }
  if (url.protocol === "http:" && !loopback) {
    throw new ModelConfigurationError(
      "Remote model endpoints must use HTTPS. HTTP is allowed only for localhost or host.docker.internal.",
    );
  }
  if (!loopback && !apiKey) {
    throw new ModelConfigurationError(
      `Set ${prefix}_API_KEY for the authenticated remote model endpoint.`,
    );
  }

  return { baseURL: url.toString().replace(/\/+$/, ""), apiKey };
}

function configurationReason(provider: ProviderId): string | undefined {
  switch (provider) {
    case "demo":
      return undefined;
    case "openai":
      return env("OPENAI_API_KEY")
        ? undefined
        : "Set OPENAI_API_KEY on the server.";
    case "google":
      return googleKey()
        ? undefined
        : "Set GOOGLE_GENERATIVE_AI_API_KEY or GEMINI_API_KEY on the server.";
    case "ollama":
    case "lmstudio":
      try {
        localConnection(provider);
        return undefined;
      } catch (error) {
        return error instanceof ModelConfigurationError
          ? error.message
          : "Local provider configuration is invalid.";
      }
  }
}

/** Configuration only: this does not check credentials, network access, or installed models. */
export function getProviderStatuses(): ProviderStatus[] {
  return PROVIDERS.map((provider) => {
    const reason = configurationReason(provider.id);
    return {
      ...provider,
      models: provider.models.map((model) => ({ ...model })),
      configured: !reason,
      ...(reason ? { reason } : {}),
    };
  });
}

/** Call only on the server. Model objects contain credentials and must never be serialized. */
export function resolveModel(config: ModelConfig) {
  if (!isSupportedModel(config)) {
    throw new ModelConfigurationError(
      "Select a supported cloud model or a valid installed local model identifier.",
    );
  }
  if (config.provider === "demo") {
    throw new ModelConfigurationError(
      "The demo engine runs without a language model.",
    );
  }
  const reason = configurationReason(config.provider);
  if (reason) throw new ModelConfigurationError(reason);

  switch (config.provider) {
    case "openai":
      return createOpenAI({
        apiKey: env("OPENAI_API_KEY"),
        baseURL: "https://api.openai.com/v1",
        fetch: providerFetch,
      }).responses(config.model);
    case "google":
      return createGoogleGenerativeAI({
        apiKey: googleKey(),
        baseURL: "https://generativelanguage.googleapis.com/v1beta",
        fetch: providerFetch,
      })(config.model);
    case "ollama":
    case "lmstudio": {
      const connection = localConnection(config.provider);
      return createOpenAICompatible({
        name: config.provider,
        baseURL: connection.baseURL,
        apiKey: connection.apiKey,
        fetch: providerFetch,
        supportsStructuredOutputs: true,
      }).chatModel(config.model);
    }
  }
}
