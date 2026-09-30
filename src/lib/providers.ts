import type { ModelConfig, ProviderId, ProviderStatus } from "./types";

/** Public metadata only. Credentials and endpoint addresses never belong here. */
export const PROVIDERS: ProviderStatus[] = [
  {
    id: "demo",
    name: "Demo engine",
    configured: true,
    models: [
      {
        id: "branchlab-demo",
        name: "Branchlab demo",
        description:
          "Deterministic simulation with generated example dialogue. No API key required.",
      },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    configured: false,
    models: [
      {
        id: "gpt-6-luna",
        name: "GPT-6 Luna",
        description:
          "Efficient model for focused actor decisions and frequent runs.",
      },
      {
        id: "gpt-6.1-sol",
        name: "GPT-6.1 Sol",
        description: "Balanced reasoning for scenarios and reports.",
      },
      {
        id: "gpt-6-astra",
        name: "GPT-6 Astra",
        description: "Deeper reasoning for demanding scenario analysis.",
      },
    ],
  },
  {
    id: "google",
    name: "Google Gemini",
    configured: false,
    models: [
      {
        id: "gemini-3.5-flash-lite",
        name: "Gemini 3.5 Flash-Lite",
        description: "Efficient stable model for frequent actor decisions.",
      },
      {
        id: "gemini-3.8-flash",
        name: "Gemini 3.8 Flash",
        description: "Stable model for complex agent workflows and analysis.",
      },
      {
        id: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro",
        description:
          "Preview reasoning model; availability and limits may change.",
        preview: true,
      },
    ],
  },
  {
    id: "ollama",
    name: "Ollama",
    configured: false,
    models: [
      {
        id: "qwen3:8b",
        name: "Qwen3 8B",
        description:
          "Example local model. Install it in Ollama or enter your installed model ID.",
      },
      {
        id: "gpt-oss:20b",
        name: "gpt-oss 20B",
        description:
          "Example local reasoning model; requires sufficient machine memory.",
      },
    ],
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    configured: false,
    models: [
      {
        id: "qwen/qwen3-8b",
        name: "Qwen3 8B",
        description:
          "Example only. Enter the model identifier shown by your LM Studio server.",
      },
    ],
  },
];

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  provider: "demo",
  model: "branchlab-demo",
};

export function isLocalProvider(provider: ProviderId): boolean {
  return provider === "ollama" || provider === "lmstudio";
}

export function isProviderId(value: unknown): value is ProviderId {
  return (
    typeof value === "string" &&
    PROVIDERS.some((provider) => provider.id === value)
  );
}

/** Local server identifiers may include namespaces and quantization tags. */
export function isValidLocalModelId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/.test(value);
}

export function isSupportedModel(config: ModelConfig): boolean {
  if (!isProviderId(config.provider) || typeof config.model !== "string")
    return false;
  if (isLocalProvider(config.provider))
    return isValidLocalModelId(config.model);
  return (
    PROVIDERS.find((provider) => provider.id === config.provider)?.models.some(
      (model) => model.id === config.model,
    ) ?? false
  );
}
