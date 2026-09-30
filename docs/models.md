# Models and provider configuration

Branchlab runs without credentials in **Demo engine** mode. Its generated dialogue and deterministic state updates are examples, not live model inference. Cloud and local model runs are selected explicitly; provider errors never switch a live run into demo mode.

## Cloud models

The catalog was checked against official documentation on **2026-09-30**. Account access, regional availability, quotas and billing remain provider-specific. Branchlab's “configured” status means required server configuration is present; it does not test a key or contact an endpoint.

| Provider | Model ID                 | Intended starting point                              |
| -------- | ------------------------ | ---------------------------------------------------- |
| OpenAI   | `gpt-6-luna`             | Efficient actor decisions                            |
| OpenAI   | `gpt-6.1-sol`            | Balanced scenario analysis                           |
| OpenAI   | `gpt-6-astra`            | Demanding reasoning                                  |
| Google   | `gemini-3.5-flash-lite`  | Efficient stable model                               |
| Google   | `gemini-3.8-flash`       | Stable agent workflows                               |
| Google   | `gemini-3.1-pro-preview` | Optional preview; limits and availability may change |

These use native AI SDK providers with Mastra. OpenAI explicitly uses the **Responses API**, which supports the GPT-6 tool-calling route. Google uses its native API adapter. Cloud model selection is restricted to the catalog in `src/lib/providers.ts`; update that catalog when adopting another model.

Set one or both server environment variables:

```dotenv
OPENAI_API_KEY=your-openai-key
GOOGLE_GENERATIVE_AI_API_KEY=your-google-key
```

Google also accepts `GEMINI_API_KEY` and `GOOGLE_API_KEY`, in that precedence order after `GOOGLE_GENERATIVE_AI_API_KEY`. None use a `NEXT_PUBLIC_` prefix. Keys are not accepted from the browser, stored in simulations, or included in configuration responses. Restart the development server after environment changes. On a hosting platform, update deployment secrets and redeploy.

Official references: [OpenAI catalog](https://developers.openai.com/api/docs/models), [GPT-6 endpoint guidance](https://developers.openai.com/api/docs/guides/latest-model), [Gemini model catalog](https://ai.google.dev/gemini-api/docs/models?hl=en). Google currently limits Gemini 2.5 access to previous users and recommends newer models for new projects.

## Ollama

Run the application and Ollama on the same machine, start Ollama, and install a model:

```sh
ollama pull qwen3:8b
ollama serve
```

If the desktop application already started the service, another `ollama serve` is unnecessary. Enable the provider in the application's server environment:

```dotenv
ENABLE_LOCAL_MODELS=true
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
```

Select the installed model ID, such as `qwen3:8b` or `gpt-oss:20b`. Catalog entries are suggestions, not a claim that these models are installed. Model size and quantization must fit the available hardware. Local unauthenticated Ollama does not need `OLLAMA_API_KEY`.

[Ollama's OpenAI-compatible API](https://docs.ollama.com/api/openai-compatibility) supports the chat endpoint used here. [Structured output](https://docs.ollama.com/capabilities/structured-outputs) is exposed through `response_format`.

## LM Studio

Download and load a model in LM Studio, then start the local server from the Developer tab or with `lms server start`. Copy its exact API model identifier into Branchlab's custom model field.

```dotenv
ENABLE_LOCAL_MODELS=true
LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1
```

Branchlab uses the OpenAI-compatible chat endpoint. LM Studio's structured output support depends on the selected model and runtime; the application still validates every generated object. [LM Studio endpoints](https://lmstudio.ai/docs/developer/openai-compat), [structured output](https://lmstudio.ai/docs/developer/openai-compat/structured-output).

## Local inference and hosted applications

Local providers are disabled until `ENABLE_LOCAL_MODELS=true` is set, including development. Enabling them activates the default loopback endpoints if no base URLs are provided. Both provider statuses may therefore read configured even if only one inference server is running; configuration status is not a connectivity test.

Localhost is relative to **the application server**. A Vercel deployment cannot reach your laptop through `127.0.0.1`. Run Branchlab locally alongside inference, or operate an authenticated remote inference gateway and configure its HTTPS URL:

```dotenv
ENABLE_LOCAL_MODELS=true
OLLAMA_BASE_URL=https://inference.example.com/v1
OLLAMA_API_KEY=your-gateway-key
```

Use `LMSTUDIO_BASE_URL` and `LMSTUDIO_API_KEY` for the equivalent LM Studio setup. Branchlab sends the key as a Bearer token; the gateway must enforce it. Do not publicly expose an unauthenticated inference server.

Endpoint validation rules:

- URLs come exclusively from server environment variables.
- Use a base URL ending in `/v1`, not `/v1/chat/completions`.
- Embedded credentials, query parameters and fragments are rejected.
- HTTP is allowed only for loopback hosts, `localhost` names, or `host.docker.internal` for a local Docker application.
- Other endpoints require HTTPS and the corresponding API key.
- Detected hosted deployments (`VERCEL`, `CF_PAGES`, or `WORKERS_CI`) reject loopback, private-address, internal-name and IPv6-literal endpoints. Use a public DNS hostname for remote IPv6 inference.

Validation checks URL syntax and literal addresses; it does not resolve DNS or verify gateway authentication. Deployment operators control and must trust these environment settings. Private endpoints are never accepted from application users.

## Structured responses and failure handling

Mastra runs agent calls with typed output schemas; the engine validates their values and entity references. Local models use the OpenAI-compatible SDK with schema support enabled. Mastra's `jsonPromptInjection: "auto"` can select prompt-based JSON when its capability registry does not recognize a model. This does not guarantee that a small or incompatible model can satisfy the schema.

An invalid response, refusal, timeout, missing model, authentication failure or exhausted quota fails the operation visibly. Previously completed rounds remain saved. There is no automatic cross-provider fallback: doing so would change the experiment and potentially send source material to a different provider. Inspect the configuration and provider account or server, then retry. A retried incomplete round may incur another model charge.

The engine bounds calls and retries independently of provider configuration. Reproducible demo runs and stored event replay do not imply deterministic live LLM output. Model labels are not predictive-accuracy guarantees.

[Mastra models](https://mastra.ai/models), [Mastra structured output](https://mastra.ai/docs/agents/structured-output), [AI SDK OpenAI-compatible providers](https://ai-sdk.dev/providers/openai-compatible-providers).
