# Providers

The runtime uses provider interfaces and a `ProviderRegistry` so core orchestration can call model capabilities without knowing which vendor SDK or HTTP API is behind them.

## Default Mapping

- Chat: DeepSeek API
- Reasoning: DeepSeek API
- TTS: xAI
- STT: Alibaba Cloud DashScope
- Vision: xAI
- Embedding: OpenAI-compatible when configured; mock only for explicit tests, CI, or offline mode

## Why Core Does Not Import Provider SDKs

`packages/core` must stay provider-neutral. It should not import DeepSeek, xAI, Alibaba, OpenAI-compatible clients, or vendor SDKs directly.

This keeps the runtime:

- easier to test with mock providers
- safer to run locally without all API keys configured
- easier to swap providers later
- less likely to leak vendor-specific response shapes into prompts, memory, or protocol events
- resilient when one provider API changes

Concrete provider code belongs in `packages/providers/src/<vendor>/`.

## ProviderRegistry

`ProviderRegistry` is the composition boundary. It owns provider selection, env parsing, and fallback behavior. The runtime core depends on the `ProviderResolver` shape, not concrete vendor classes.

Runtime code should ask for a capability:

```ts
const chat = providers.getChatProvider();
const reply = await chat.generateReply(input);
```

The registry decides whether that provider is DeepSeek, xAI, DashScope, a mock, or an unavailable placeholder.

Internally, provider construction is organized as provider-name factory maps per capability. Adding another chat, TTS, STT, vision, or embedding provider should add a new factory entry instead of branching through runtime code.

Current registry entrypoint:

```ts
const providers = createProviderRegistryFromEnv();
```

## Required Environment

For the MVP, these are required in production-like mode:

```env
NODE_ENV=production
SERVER_HOST=127.0.0.1
SERVER_PORT=6121

DATABASE_URL=postgres://...
REDIS_URL=redis://...

DEFAULT_CHAT_PROVIDER=deepseek
DEEPSEEK_API_BASEURL=https://api.deepseek.com
DEEPSEEK_API_KEY=...
DEEPSEEK_CHAT_MODEL=...
```

Reasoning defaults to DeepSeek too:

```env
DEFAULT_REASONING_PROVIDER=deepseek
DEEPSEEK_REASONING_MODEL=...
```

Memory extraction defaults to LLM-assisted mode:

```env
MEMORY_EXTRACTOR=llm
```

`MEMORY_EXTRACTOR=llm` uses DeepSeek Reasoning only when the reasoning provider is configured and a message turn has `writeMemory=true`. It is not called from `/health` or `/providers/status`. If DeepSeek Reasoning is missing, YUVI falls back safely to the rule-based extractor. Use `MEMORY_EXTRACTOR=rule-based` for deterministic extraction with no token usage.

## Optional Providers

These are optional for the first text-chat MVP:

```env
DEFAULT_TTS_PROVIDER=xai
XAI_API_BASEURL=https://api.x.ai/v1
XAI_API_KEY=...
XAI_TTS_MODEL=...
XAI_TTS_VOICE=...

DEFAULT_STT_PROVIDER=dashscope
DASHSCOPE_API_BASEURL=https://dashscope.aliyuncs.com/api/v1
DASHSCOPE_API_KEY=...
DASHSCOPE_STT_MODEL=...

DEFAULT_VISION_PROVIDER=xai
XAI_VISION_MODEL=...

EMBEDDING_PROVIDER=openai-compatible
EMBEDDING_API_BASEURL=...
EMBEDDING_API_KEY=...
EMBEDDING_MODEL=...
EMBEDDING_DIMENSIONS=1536
```

YUVI is real-provider-first by default. `EMBEDDING_PROVIDER=openai-compatible` uses an OpenAI-style `/embeddings` endpoint when `EMBEDDING_API_BASEURL`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`, and `EMBEDDING_DIMENSIONS` are configured. DashScope `text-embedding-v4` can be used through compatible mode:

```env
EMBEDDING_PROVIDER=openai-compatible
EMBEDDING_API_BASEURL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBEDDING_API_KEY=<DashScope API key>
EMBEDDING_MODEL=text-embedding-v4
EMBEDDING_DIMENSIONS=1536
```

`EMBEDDING_PROVIDER=mock` is deterministic and requires no network, but it reports `semanticEmbedding=false` because it validates the retrieval pipeline without real semantic similarity. Embedding status reports provider, model, dimensions, mock/configured/available state, semantic/non-semantic mode, and never returns API keys.

`POST /providers/verify/embedding` is explicit and may consume provider usage. It calls the active embedding provider with a small test string and returns only safe metadata: provider, model, expected dimensions, actual dimensions, latency, mock/real mode, semanticEmbedding, and a redacted error if verification fails. If the provider returns a vector dimension that does not match `EMBEDDING_DIMENSIONS`, YUVI returns `ok=false` and does not expose the raw vector.

If optional providers are missing and mocks are disabled, the registry returns an unavailable provider. `healthCheck()` reports `unavailable`, and actual calls throw normalized `ProviderError`s.

## Swapping Providers

To add or replace a provider:

1. Implement the capability interface in `packages/providers/src/types/*`.
2. Keep vendor-specific request/response formatting inside `packages/providers/src/<vendor>/`.
3. Normalize output into `ChatOutput`, `ReasoningOutput`, `TTSOutput`, `STTOutput`, `VisionOutput`, or embedding arrays.
4. Register the implementation in `ProviderRegistry`.
5. Add env vars to `.env.example`.

Do not change `packages/core` just to swap vendors.

## Error Normalization

Provider implementations should throw `ProviderError` with one of these codes:

- `MISSING_API_KEY`
- `INVALID_API_KEY`
- `PERMISSION_DENIED`
- `MODEL_NOT_FOUND`
- `RATE_LIMITED`
- `TIMEOUT`
- `NETWORK_ERROR`
- `MALFORMED_RESPONSE`
- `UNSUPPORTED_INPUT`
- `PROVIDER_UNAVAILABLE`

Runtime code should not inspect vendor-specific error bodies.

## Security Rules

- Never log API keys.
- Never commit `.env`.
- Redact `Authorization` headers.
- Do not return raw provider errors to clients without normalization.
- Keep raw provider responses only in optional debug fields.
- Treat local file paths and uploaded media as sensitive user data.

Fastify logging is configured to redact authorization headers and key-like fields.

## Mock Providers

Normal development/runtime no longer silently falls back to mock providers. Development tests, CI, and intentional offline sessions can run without real provider credentials by opting in:

```env
NODE_ENV=development
PROVIDER_ALLOW_MOCKS=true
MEMORY_REPOSITORY=in-memory
EMBEDDING_PROVIDER=mock
```

Mock providers are useful for:

- local server smoke tests
- route tests
- runtime orchestration tests
- CI without vendor credentials

Mocks should be deterministic and provider-neutral. They should not pretend to be production quality.

## Raw Provider Responses

Normalized provider outputs do not include raw vendor responses by default. For local debugging only, set:

```env
PROVIDER_INCLUDE_RAW_RESPONSES=true
```

Runtime events must not include raw provider responses. Treat them as sensitive because they can contain prompts, transcripts, media metadata, or vendor-specific payload details.

## Dashboard Provider Settings

The Dashboard `Settings` page can write local development settings to `.env.local`.

- Full API keys are never returned by `GET /settings/runtime`.
- Secret previews use a fixed-length mask such as `••••••••••••abcd`; the raw value and full key length are not exposed.
- `scripts/dev.sh` loads `.env` first and `.env.local` second, so `.env.local` overrides base local values after restart.
- `POST /settings/runtime` only accepts an allowlist of development provider and memory keys.
- `POST /settings/runtime/reload` reloads `.env` and `.env.local`, rebuilds the active provider registry, and applies provider config without restarting the HTTP server.
- Provider verification buttons call `POST /providers/verify/chat`, `POST /providers/verify/reasoning`, or `POST /providers/verify/embedding` explicitly.
- Save writes `.env.local`; **Apply Now** reloads hot-reloadable provider config; **Verify** is a separate explicit remote/provider call and may consume tokens.
- `/health` and `/providers/status` do not consume provider tokens.
- Provider config changes can be applied with **Apply Now / Reload Runtime Config**. Memory repository, server host/port, and event bus changes remain restart-required.
- If DeepSeek config is saved but chat still reports mock mode, click **Apply Now** or restart the dev server.
- `GET /settings/runtime` reports safe config layering: base `.env`, local override `.env.local`, effective merged values, and active runtime values.
- The Dashboard does not automatically copy `.env.local` back into `.env`. This prevents accidental secret commits and makes local overrides explicit.

The reload endpoint never returns API keys, raw `.env` contents, request headers, `Authorization` headers, tokens, or passwords. It returns only safe active provider metadata such as configured state, model name, mock/real mode, and restart-required boundaries.

There is intentionally no automatic “sync `.env.local` into `.env`” behavior. A future manual promotion command may copy non-secret allowlisted values only, but API keys and other secrets should remain local overrides unless the developer explicitly edits their private `.env`.

## Future Work

Planned provider extensions:

- streaming TTS over WebSocket or chunked audio events
- streaming STT for live microphone input
- vision screen sharing and frame sampling
- local embedding models for fully local memory search
- NATS-backed provider task events for long-running jobs

These should preserve the same boundary: core uses interfaces, registry wires implementations.
