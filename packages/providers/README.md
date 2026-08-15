# @companion/providers

Provider interfaces, registry, and future implementations.

Responsibilities:

- Define provider capability interfaces.
- Register concrete providers outside runtime core.
- Normalize provider errors.
- Keep vendor clients behind stable abstractions.
- Keep provider-specific response shapes out of runtime core.

Planned providers:

- DeepSeek chat and reasoning.
- xAI TTS and vision.
- Alibaba Cloud DashScope STT.
- Embedding providers for memory retrieval.

The MVP includes a `local-echo` chat provider so the server is runnable without API keys.

## Type Layout

- `src/types/common.ts`: shared health, metadata, token usage, and message types.
- `src/types/chat.ts`: chat provider contract.
- `src/types/reasoning.ts`: reasoning provider contract.
- `src/types/tts.ts`: text-to-speech provider contract.
- `src/types/stt.ts`: speech-to-text provider contract.
- `src/types/vision.ts`: vision provider contract.
- `src/types/embedding.ts`: embedding provider contract.
- `src/types/errors.ts`: normalized provider errors.

## Provider contracts

Provider contracts are capability-specific and are resolved through the
existing `ProviderRegistry` / `ProviderResolver` boundary. A provider adapter
must return the normalized business result for its capability rather than
vendor transport fields.

Reasoning has one authoritative business result: `ReasoningOutput.answer`.
The legacy `ReasoningOutput.reasoning` field remains for structural
compatibility, but is not a raw provider reasoning/internal-trace channel and
normalized adapters leave it empty. Raw vendor reasoning content is discarded
at the provider boundary. `packages/memory/src/extractor.ts` remains
answer-first and is not changed.

The current Runtime does not implement tool/function calling. `role: "tool"`
and `finishReason: "tool_call"` remain reserved compatibility values only;
they do not provide normalized tool definitions, calls, results, streaming
argument deltas, or execution.

Provider status has two independent axes. `readiness` is local configuration
state (`ready` or `not_ready`) based on required local fields being present;
it does not validate endpoint syntax or remote reachability. It is the only
state used to decide whether a provider route can be constructed. `observed` is cached explicit verification
state (`unknown`, `available`, `degraded`, or `unavailable`). A configured
provider starts with `readiness: "ready"` and `observed: "unknown"`; config
inspection never claims remote availability. The legacy `available` field is
retained as a compatibility projection of local readiness, not remote health.

`ProviderRegistry.getStatus()` is synchronous, local, and zero-I/O. It never
calls a provider `healthCheck()` or a remote endpoint. Only explicit live
verification updates the in-memory observation cache. Config-only verification
for TTS, STT, Vision, and provider chains reports `verificationMode:
"config_only"` and leaves `observed` unchanged. Ordinary `/health` is also
zero-cost and exposes readiness and cached observation separately.
