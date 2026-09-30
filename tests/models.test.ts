import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MODEL_CONFIG,
  PROVIDERS,
  isSupportedModel,
} from "../src/lib/providers";
import {
  getProviderStatuses,
  ModelConfigurationError,
  resolveModel,
} from "../src/server/models";

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "ENABLE_LOCAL_MODELS",
  "OLLAMA_BASE_URL",
  "OLLAMA_API_KEY",
  "LMSTUDIO_BASE_URL",
  "LMSTUDIO_API_KEY",
  "VERCEL",
  "CF_PAGES",
  "WORKERS_CI",
];

beforeEach(() => {
  for (const key of ENV_KEYS) vi.stubEnv(key, undefined);
});

afterEach(() => vi.unstubAllEnvs());

describe("public model catalog", () => {
  it("starts with a usable demo and no implicit live provider", () => {
    expect(isSupportedModel(DEFAULT_MODEL_CONFIG)).toBe(true);
    expect(
      getProviderStatuses()
        .filter((provider) => provider.configured)
        .map((provider) => provider.id),
    ).toEqual(["demo"]);
    expect(() => resolveModel(DEFAULT_MODEL_CONFIG)).toThrow("demo engine");
  });

  it("requires catalog cloud models while allowing namespaced local identifiers", () => {
    expect(
      isSupportedModel({ provider: "openai", model: "unknown-cloud-model" }),
    ).toBe(false);
    expect(
      isSupportedModel({
        provider: "ollama",
        model: "namespace/qwen3:8b-q4_K_M",
      }),
    ).toBe(true);
    for (const model of [
      "",
      "bad model",
      "model\nInjected",
      "model?api_key=x",
      "a".repeat(201),
    ]) {
      expect(isSupportedModel({ provider: "lmstudio", model })).toBe(false);
    }
    expect(() =>
      resolveModel({ provider: "openai", model: "unknown-cloud-model" }),
    ).toThrow(ModelConfigurationError);
  });

  it("does not mutate the public catalog or expose credentials in statuses", () => {
    vi.stubEnv("OPENAI_API_KEY", "test-secret-never-return");
    const statuses = getProviderStatuses();
    expect(
      statuses.find((provider) => provider.id === "openai")?.configured,
    ).toBe(true);
    expect(JSON.stringify(statuses)).not.toContain("test-secret-never-return");
    statuses[0].models[0].name = "mutated by consumer";
    expect(PROVIDERS[0].models[0].name).toBe("Branchlab demo");
    expect(
      PROVIDERS.find((provider) => provider.id === "openai")?.configured,
    ).toBe(false);
  });
});

describe("native cloud adapters", () => {
  it("uses the Responses adapter for GPT-6", () => {
    vi.stubEnv("OPENAI_API_KEY", "unit-test-key");
    const model = resolveModel({ provider: "openai", model: "gpt-6-luna" });
    expect(model.modelId).toBe("gpt-6-luna");
    expect(model.provider).toBe("openai.responses");
  });

  it("accepts the Gemini key alias without changing process environment", () => {
    vi.stubEnv("GEMINI_API_KEY", "unit-test-key");
    expect(
      getProviderStatuses().find((provider) => provider.id === "google")
        ?.configured,
    ).toBe(true);
    const model = resolveModel({
      provider: "google",
      model: "gemini-3.8-flash",
    });
    expect(model.modelId).toBe("gemini-3.8-flash");
    expect(model.provider).toBe("google.generative-ai");
    expect(process.env.GOOGLE_GENERATIVE_AI_API_KEY).toBeUndefined();
  });

  it("fails before inference when a key is absent", () => {
    expect(() =>
      resolveModel({ provider: "openai", model: "gpt-6-luna" }),
    ).toThrow("OPENAI_API_KEY");
    expect(() =>
      resolveModel({ provider: "google", model: "gemini-3.8-flash" }),
    ).toThrow("GEMINI_API_KEY");
  });
});

describe("local endpoint boundaries", () => {
  it("requires explicit opt-in and preserves the chosen local model ID", () => {
    expect(() =>
      resolveModel({ provider: "ollama", model: "qwen3:8b" }),
    ).toThrow("ENABLE_LOCAL_MODELS");
    vi.stubEnv("ENABLE_LOCAL_MODELS", "true");
    const model = resolveModel({
      provider: "ollama",
      model: "namespace/qwen3:8b",
    });
    expect(model.modelId).toBe("namespace/qwen3:8b");
    expect(model.provider).toBe("ollama.chat");
    expect(
      getProviderStatuses().find((provider) => provider.id === "ollama")
        ?.configured,
    ).toBe(true);
  });

  it("allows the local Docker host", () => {
    vi.stubEnv("ENABLE_LOCAL_MODELS", "true");
    vi.stubEnv("LMSTUDIO_BASE_URL", "http://host.docker.internal:1234/v1/");
    expect(
      resolveModel({ provider: "lmstudio", model: "local-model" }).modelId,
    ).toBe("local-model");
  });

  it.each([
    "http://127.0.0.1:11434/v1",
    "http://localhost:11434/v1",
    "http://host.docker.internal:11434/v1",
    "https://10.1.2.3/v1",
    "https://192.168.1.4/v1",
    "https://172.20.0.1/v1",
    "https://169.254.169.254/v1",
    "https://[::1]/v1",
    "https://[::ffff:127.0.0.1]/v1",
    "https://inference.internal/v1",
    "https://inference.local/v1",
  ])("rejects inaccessible/private hosted endpoint %s", (endpoint) => {
    vi.stubEnv("ENABLE_LOCAL_MODELS", "true");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("OLLAMA_BASE_URL", endpoint);
    vi.stubEnv("OLLAMA_API_KEY", "unit-test-key");
    expect(() =>
      resolveModel({ provider: "ollama", model: "qwen3:8b" }),
    ).toThrow("Hosted deployments");
  });

  it("recognizes Cloudflare Pages as hosted", () => {
    vi.stubEnv("ENABLE_LOCAL_MODELS", "true");
    vi.stubEnv("CF_PAGES", "1");
    expect(
      getProviderStatuses().find((provider) => provider.id === "lmstudio")
        ?.reason,
    ).toContain("Hosted deployments");
  });

  it("requires HTTPS and a key for remote inference", () => {
    vi.stubEnv("ENABLE_LOCAL_MODELS", "true");
    vi.stubEnv("OLLAMA_BASE_URL", "http://inference.example.com/v1");
    expect(() =>
      resolveModel({ provider: "ollama", model: "qwen3:8b" }),
    ).toThrow("HTTPS");
    vi.stubEnv("OLLAMA_BASE_URL", "https://inference.example.com/v1");
    expect(() =>
      resolveModel({ provider: "ollama", model: "qwen3:8b" }),
    ).toThrow("OLLAMA_API_KEY");
    vi.stubEnv("OLLAMA_API_KEY", "unit-test-key");
    vi.stubEnv("VERCEL", "1");
    expect(
      resolveModel({ provider: "ollama", model: "qwen3:8b" }).modelId,
    ).toBe("qwen3:8b");
  });

  it.each([
    "not-a-url",
    "file:///v1",
    "http://user:secret@localhost:11434/v1",
    "http://localhost:11434/v1?token=secret",
    "http://localhost:11434/v1#secret",
    "http://localhost:11434/v1/chat/completions",
  ])(
    "rejects malformed configuration without leaking its contents",
    (endpoint) => {
      vi.stubEnv("ENABLE_LOCAL_MODELS", "true");
      vi.stubEnv("OLLAMA_BASE_URL", endpoint);
      const status = getProviderStatuses().find(
        (provider) => provider.id === "ollama",
      );
      expect(status?.configured).toBe(false);
      expect(status?.reason).not.toContain("secret");
      expect(status?.reason).not.toContain(endpoint);
      expect(() =>
        resolveModel({ provider: "ollama", model: "qwen3:8b" }),
      ).toThrow(ModelConfigurationError);
    },
  );
});

describe("provider transport privacy", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["openai", "gpt-6-luna", "https://api.openai.com/v1/responses"],
    [
      "google",
      "gemini-3.8-flash",
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
    ],
    ["ollama", "qwen3:8b", "http://127.0.0.1:11434/v1/chat/completions"],
    ["lmstudio", "local-model", "http://127.0.0.1:1234/v1/chat/completions"],
  ] as const)(
    "pins the %s endpoint and refuses automatic prompt-bearing redirects",
    async (provider, modelId, endpoint) => {
      vi.stubEnv("OPENAI_API_KEY", "unit-test-key");
      vi.stubEnv("GEMINI_API_KEY", "unit-test-key");
      vi.stubEnv("ENABLE_LOCAL_MODELS", "true");
      vi.stubEnv("OPENAI_BASE_URL", "https://unexpected-proxy.example/v1");
      const fetchSpy = vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error("Offline transport interception"));
      vi.stubGlobal("fetch", fetchSpy);
      const model = resolveModel({ provider, model: modelId }) as unknown as {
        doGenerate(options: {
          prompt: { role: "user"; content: { type: "text"; text: string }[] }[];
        }): Promise<unknown>;
      };
      await expect(
        model.doGenerate({
          prompt: [
            {
              role: "user",
              content: [{ type: "text", text: "Private fixture source text" }],
            },
          ],
        }),
      ).rejects.toBeDefined();
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(String(fetchSpy.mock.calls[0][0])).toBe(endpoint);
      expect(fetchSpy.mock.calls[0][1]?.redirect).toBe("error");
    },
  );

  it.each([
    "http://2130706433:11434/v1",
    "http://0x7f000001:11434/v1",
    "https://[::ffff:7f00:1]/v1",
    "https://127.1/v1",
  ])("rejects alternate hosted private-address syntax %s", (endpoint) => {
    vi.stubEnv("ENABLE_LOCAL_MODELS", "true");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("OLLAMA_BASE_URL", endpoint);
    vi.stubEnv("OLLAMA_API_KEY", "unit-test-key");
    expect(() =>
      resolveModel({ provider: "ollama", model: "qwen3:8b" }),
    ).toThrow("Hosted deployments");
  });
});
