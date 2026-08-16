# Providers

The runtime uses provider interfaces and a `ProviderRegistry` so core orchestration can call model capabilities without knowing which vendor SDK or HTTP API is behind them.

## Default Mapping

- Chat: DeepSeek API
- Reasoning: DeepSeek API
- TTS: xAI
- STT: Alibaba Cloud DashScope
- Vision: xAI
- Embedding: OpenAI-compatible when configured; mock only for explicit tests, CI, or offline mode

Provider Priority/Fallback v1 lets each capability define an ordered provider chain:

```env
CHAT_PROVIDER_CHAIN=deepseek,nvidia,local,mock
REASONING_PROVIDER_CHAIN=deepseek,nvidia,local,mock
EMBEDDING_PROVIDER_CHAIN=openai-compatible,nvidia,local,mock
TTS_PROVIDER_CHAIN=xai,local,mock
STT_PROVIDER_CHAIN=dashscope,local,mock
VISION_PROVIDER_CHAIN=xai,nvidia,local,mock
```

The current runtime fallback path is implemented for chat, reasoning, embedding, TTS, STT, and vision. Mock providers are skipped unless `PROVIDER_ALLOW_MOCKS=true`, and unconfigured real providers are reported as unavailable in the attempted-provider trace instead of silently pretending to be real.

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

Provider status deliberately separates local readiness from remote
observation. `readiness` is `ready` when the selected route has the required
local configuration (or intentional mock mode), otherwise it is `not_ready`.
`observed` is one of `unknown`, `available`, `degraded`, or `unavailable` and
starts as `unknown` for real providers. The legacy `available` field remains a
readiness compatibility projection; it does not mean that a remote provider
was contacted successfully. `ProviderRegistry.getStatus()` and ordinary
`GET /health` perform no provider network calls and do not consume quota.

When a chain is used, calls try configured providers by priority. The response includes safe fallback metadata such as `fallbackUsed`, `attemptedProviders`, and `finalProvider`. `fallbackUsed` is true only when the successful provider identity differs from the first attempted provider identity. A total failure is not a successful fallback. Attempt records include provider name, status, safe error code, and latency, but never API keys, Authorization headers, `DATABASE_URL`, or raw secret values.

`ProviderRouteStatus.fallbackEligible` is a P7-2 route/readiness projection: the configured identity is locally ready to occupy a chain slot. It is not call-error permission and is not consulted by `runProviderChain`. `ProviderError.fallbackEligible` is the separate error-level permission to switch provider identity after a failed call.

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

NVIDIA API and local model providers use OpenAI-compatible request shapes in v1 where the capability is currently wired:

```env
NVIDIA_API_BASEURL=https://integrate.api.nvidia.com/v1
NVIDIA_API_KEY=...
NVIDIA_CHAT_MODEL=...
NVIDIA_REASONING_MODEL=...
NVIDIA_EMBEDDING_MODEL=...
NVIDIA_EMBEDDING_DIMENSIONS=1536

LOCAL_MODEL_BASEURL=http://localhost:11434/v1
LOCAL_CHAT_MODEL=...
LOCAL_REASONING_MODEL=...
LOCAL_EMBEDDING_MODEL=...
LOCAL_EMBEDDING_DIMENSIONS=1536
```

Local means a developer-controlled OpenAI-compatible gateway such as Ollama, llama.cpp server, vLLM, LM Studio, or another local adapter. Configuration does not prove the local server is running; explicit Verify actions are the check.

YUVI is real-provider-first by default. `EMBEDDING_PROVIDER=openai-compatible` uses an OpenAI-style `/embeddings` endpoint when `EMBEDDING_API_BASEURL`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`, and `EMBEDDING_DIMENSIONS` are configured. DashScope `text-embedding-v4` can be used through compatible mode:

```env
EMBEDDING_PROVIDER=openai-compatible
EMBEDDING_API_BASEURL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBEDDING_API_KEY=<DashScope API key>
EMBEDDING_MODEL=text-embedding-v4
EMBEDDING_DIMENSIONS=1536
```

`EMBEDDING_PROVIDER=mock` is deterministic and requires no network, but it reports `semanticEmbedding=false` because it validates the retrieval pipeline without real semantic similarity. Embedding status reports provider, model, dimensions, mock/configured/available state, semantic/non-semantic mode, and never returns API keys.

`POST /providers/verify/embedding` is explicit and may consume provider usage. It calls the active embedding provider with a small test string and returns only safe metadata: provider, model, expected dimensions, actual dimensions, latency, mock/real mode, `verificationMode: "live"`, readiness, observed state, semanticEmbedding, and a redacted error if verification fails. If the provider returns a vector dimension that does not match `EMBEDDING_DIMENSIONS`, YUVI returns `ok=false` and does not expose the raw vector.

If optional providers are missing and mocks are disabled, the registry returns an unavailable provider. `healthCheck()` reports `unavailable`, and actual calls throw normalized `ProviderError`s.

## Media Runtime Routes

Media routes are developer/runtime surfaces, not a finished voice product:

- `POST /v1/audio/transcriptions` uses the STT chain: DashScope, local, then mock when explicitly enabled.
- `POST /v1/voice/message` transcribes through STT, then sends the transcript through the normal message runtime. It preserves `speakerId`, `voiceProfileId`, `subjectUserId`, `createdByUserId`, and `sessionId` metadata for future identity-aware memory. It does not implement diarization or voiceprint recognition.
- `POST /v1/tts` uses the TTS chain: xAI, local, then mock when explicitly enabled.
- `POST /v1/vision/analyze` uses the vision chain: xAI, NVIDIA, local, then mock when explicitly enabled.

All media responses include safe fallback metadata:

- `capability`
- `fallbackUsed`
- `attemptedProviders`
- `finalProvider`
- `provider`
- `model`
- `mock`
- `latencyMs`

Attempt records include provider, model, status, safe error code, latency, and priority where known. They never include raw audio, images, API keys, Authorization headers, `DATABASE_URL`, or dashboard tokens.

NVIDIA vision is a fallback interface in v1. Configure model IDs explicitly; suitable candidates may include chat-style vision models such as `meta/llama-3.2-11b-vision-instruct` or `nvidia/cosmos-reason2-8b` when available through the selected API. `nvclip` is image-text embedding/retrieval, not a chat-style vision analysis model.

Local media providers are interface boundaries in v1. A local OpenAI-compatible server may be configured and reported in status, but STT/TTS/Vision runtime adapters can still return a clear unavailable error until a compatible adapter is implemented. Mock media providers remain deterministic test/offline tools only.

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

Each `ProviderError` carries three independent policy axes:

- `retryable` — the same provider may plausibly succeed later. P7-4B never auto-retries.
- `fallbackEligible` — the error itself permits switching provider identity.
- `effectState` — `not_started`, `unknown`, or `committed`. Replay safety is derived as `effectState !== "committed"` and is not a separately mutable field.

`Cancelled` never retries and never falls back. Local `UNSUPPORTED_INPUT` (no HTTP status) stops the chain; a vendor HTTP input rejection may fall back. Chat streaming still allows pre-first-visible fallback, including `INVALID_API_KEY`, and never falls back after a visible text-delta. A visible Chat delta is a `committed` business effect even though the stream event named `completed` has not been emitted yet.

Runtime code should not inspect vendor-specific error bodies. Internal policy fields (`fallbackEligible`, `effectState`, derived replay safety) are not part of public SSE/JSON payloads.

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
- Provider verification buttons call `POST /providers/verify/chat`, `POST /providers/verify/reasoning`, `POST /providers/verify/embedding`, `POST /providers/verify/stt`, `POST /providers/verify/tts`, or `POST /providers/verify/vision` explicitly.
- `POST /providers/verify-chain/:capability` returns safe configured route order and config-only attempted-provider metadata for the selected chain.
- Save writes `.env.local`; **Apply Now** reloads hot-reloadable provider config; **Verify** is a separate explicit remote/provider call and may consume tokens.
- `/health` and `/providers/status` do not consume provider tokens. `/health` reports cached provider observation honestly: a ready provider with `observed: "unknown"` can keep the local health response `ok`, while a cached `observed: "unavailable"` makes required chat health fail. The compatibility `providers.chat` field remains the default route; `providers.chatCapability` summarizes whether any locally ready chat route keeps the capability operational.
- Provider config changes can be applied with **Apply Now / Reload Runtime Config**. Memory repository, server host/port, and event bus changes remain restart-required.
- If DeepSeek config is saved but chat still reports mock mode, click **Apply Now** or restart the dev server.
- `GET /settings/runtime` reports safe config layering: base `.env`, local override `.env.local`, effective merged values, and active runtime values.
- The Dashboard does not automatically copy `.env.local` back into `.env`. This prevents accidental secret commits and makes local overrides explicit.
- In dev supervisor mode, Dashboard **Deep Restart Runtime** can request a graceful local restart after settings changes that need a process restart. It is non-production/localhost-only, requires `Authorization: Bearer <DASHBOARD_DEV_TOKEN>` when configured, and is unsupported unless `scripts/dev.sh` is running with `YUVI_DEV_SUPERVISOR=1`.
- **Apply Now** reloads hot-reloadable runtime config in the current process. **Deep Restart** exits with the restart-specific code after responding, then the `scripts/dev.sh` supervisor reloads `.env`/`.env.local`, optionally runs `pnpm db:migrate`, and starts the server again.

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

## Provider contract notes

The runtime keeps provider, model, and capability separate. Capability
contracts are typed in `@companion/providers`, selected by
`ProviderResolver`, and implemented by vendor or local adapters.

For reasoning, `ReasoningOutput.answer` is the authoritative final business
result and must be non-empty on success. The `reasoning` field is retained as
a legacy compatibility field, not as a public raw chain-of-thought channel;
raw provider internal reasoning is discarded by normalization. Memory remains
read-only and continues to prefer `answer`.

Tool/function calling is currently unsupported. Existing `tool` message roles
and `tool_call` finish reasons are reserved type affordances, not an
implemented normalized tool protocol.
