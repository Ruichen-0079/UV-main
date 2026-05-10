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
