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

Google also accepts `GEMINI_API_KEY` and `GOOGLE_API_KEY`, in that precedence order after `GOOGLE_GENERATIVE_AI_API_KEY`. None use a `NEXT_PUBLIC_` prefix. Keys are not accepted from the browser, stored in simulations, or included in configuration responses. Cloud API base URLs are pinned to their official endpoints; `OPENAI_BASE_URL` does not override this. Provider HTTP redirects are rejected so prompts and credentials cannot follow them to another destination. Restart the development server after environment changes. On a hosting platform, update deployment secrets and redeploy.

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

Select the installed model ID, such as `qwen3:8b` or `gpt-oss:20b`. Catalog entries are suggestions, not a claim that these models are installed. Model size and quantization must fit the available hardware. Local unauthenticated Ollama does not need `OLLAMA_API_KEY`. Select a model/runtime combination that supports both **tool calling and structured responses**; a model that only produces chat text cannot run this protocol.

[Ollama's OpenAI-compatible API](https://docs.ollama.com/api/openai-compatibility) supports the chat endpoint used here. [Structured output](https://docs.ollama.com/capabilities/structured-outputs) is exposed through `response_format`.

## LM Studio

Download and load a model in LM Studio, then start the local server from the Developer tab or with `lms server start`. Copy its exact API model identifier into Branchlab's custom model field.

```dotenv
ENABLE_LOCAL_MODELS=true
LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1
```

Branchlab uses the OpenAI-compatible chat endpoint. LM Studio's tool-calling and structured-output support depends on the selected model and runtime; both are required, and the application still validates every generated object. [LM Studio endpoints](https://lmstudio.ai/docs/developer/openai-compat), [structured output](https://lmstudio.ai/docs/developer/openai-compat/structured-output).

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

Validation checks URL syntax and literal addresses; it does not resolve DNS or verify gateway authentication. Deployment operators control and must trust these environment settings. Model endpoint URLs are never accepted from application users. Provider redirects are rejected. Selecting a “local” provider does not prove that data stays on the laptop: the configured endpoint may be a remote gateway.

## Tool protocol and structured responses

Each live agent runs a bounded Mastra tool loop. Its first step must call its assigned read-only tool; subsequent work can use another permitted tool before returning a typed proposal. The engine allows at most **three model steps and two tool calls per agent execution**, with a **40-second execution deadline** and at most three actors running concurrently. Agent/workflow/SDK retries are disabled; user retries are separate operations.

A local model must support tool calls, the selected tool-choice controls and structured responses through its OpenAI-compatible API. A server accepting `/chat/completions` alone is insufficient. The engine rejects a model that skips the required scoped tool with `MODEL_CAPABILITY_UNSUPPORTED`; it does not pretend that an ordinary text response executed the tool. Try a small live scenario to verify your particular model/runtime/quantization combination.

Mastra receives strict typed output schemas and `jsonPromptInjection: true` to include JSON guidance alongside native schema support. Ordinary code validates values, source/event IDs and actor permissions before committing a complete checkpoint. Valid JSON alone does not establish correct evidence or scientific validity.

## Optional web search

Set `BRAVE_SEARCH_API_KEY` to enable the server capability, then explicitly allow web search for the individual scenario. Both settings are required. Only an eligible research actor receives `search_web`; other tools inspect bounded scenario state. Demo runs stay deterministic and make no external search requests.

A model-authored query is sent to Brave's fixed search endpoint. Private observations or source excerpts can influence that query, so do not enable search for material you cannot share with that provider. The response supplies at most five result titles, URLs and short snippets; Branchlab does not visit the result URLs. Search-result links in the process trace establish provenance, not factual verification. The operation permits at most three searches, subject to additional server/session budgets. Cloud-model consent and web-search consent are separate controls. [Privacy and deletion](privacy.md).

## Failure handling and accounting

Invalid output, refusal, missing tools, timeout, authentication rejection, unavailable models and exhausted quotas fail visibly. Completed rounds remain saved. There is no automatic switch to demo or another provider. Correct the configuration, wait for the reported limit reset, or choose another supported model for a new scenario.

The server reserves up to three model requests per agent before execution, including work that later fails; reservations are not refunded when fewer steps are used. Saved simulation call counts record committed successful work. Failed attempts can consume provider capacity or incur charges without appearing in that saved-run total; process traces and the provider's own usage records supply additional context. Retrying an unfinished operation can repeat paid calls.

“Configured” checks environment settings only. This release's tests intercept provider transports and exercise deterministic simulations; they do not validate your live cloud keys, model access, gateway authentication or local-model compatibility. Stored seeds and demo replay do not imply deterministic live LLM output. Model names do not imply predictive accuracy.

[Mastra models](https://mastra.ai/models), [Mastra structured output](https://mastra.ai/docs/agents/structured-output), [AI SDK OpenAI-compatible providers](https://ai-sdk.dev/providers/openai-compatible-providers).
