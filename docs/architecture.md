# Architecture

## Project Goal

AI Companion Runtime is an event-driven, local-first companion runtime.

It is inspired by the architectural ambition of Project AIRI, but this repository is an original implementation. The goal is not a simple chatbot. The goal is a runtime foundation that can support memory, prompt construction, provider abstraction, voice, vision, avatar presentation, and future game-agent behavior.

## Core Principle

The runtime is the core product.

Avatar rendering is presentation. A Live2D, VRM, game character, terminal client, or web UI should all talk to the same runtime.

Providers are replaceable. Runtime orchestration depends on small interfaces, including the provider resolver interface, not vendor SDKs.

Memory is not raw chat logs. Memory must be stored as structured records, retrieved, ranked, compressed, and reconstructed before it enters a prompt.

## Main Data Flow

```text
User input
  -> runtime event
  -> memory retrieval
  -> prompt builder
  -> DeepSeek chat/reasoning
  -> agent.reply event
  -> optional xAI TTS
  -> avatar.speak / avatar output
```

Voice and vision enter the same event model:

```text
Audio input
  -> Alibaba DashScope STT
  -> user.voice.transcript
  -> normal reply flow

Image or screen input
  -> xAI vision
  -> perception.vision
  -> runtime context
```

## Package Responsibilities

### `apps/server`

Fastify runtime server. Owns HTTP routes, WebSocket transport, health checks, startup, and graceful shutdown. Handlers should stay thin and delegate to `packages/core`.

### `packages/protocol`

Shared runtime event types and schemas. All runtime input and output should be represented as events.

### `packages/event-bus`

Event bus abstraction. The MVP uses an in-memory implementation with wildcard subscriptions. NATS can be added later behind the same interface.

### `packages/memory`

Memory repository and service layer. Uses PostgreSQL with pgvector for durable memory, plus an in-memory development fallback. Owns memory categories, retrieval, scoring placeholders, and prompt-safe reconstruction.

### `packages/prompt-builder`

Builds structured, provider-neutral prompts from identity, character style, relationship context, retrieved memories, current situation, tools, and user message.

### `packages/providers`

Provider interfaces, registry, normalized errors, and concrete provider implementations. Vendor-specific request/response handling stays here.

### `packages/core`

Runtime orchestration. Receives events, retrieves memory, builds prompts, calls provider interfaces, stores important interactions, and emits runtime events.

## Provider Mapping

Default provider choices:

- Chat: DeepSeek API
- Reasoning: DeepSeek API
- TTS: xAI
- Vision: xAI
- STT: Alibaba Cloud DashScope
- Embedding: configurable

`packages/core` must not import DeepSeek, xAI, or Alibaba classes directly. Provider-specific construction belongs in `packages/providers`, where factory maps bind configured provider names to implementations.

Provider failures are normalized into `provider.error` events. Non-critical side effects, such as memory persistence after a reply and optional TTS output, should not prevent an already generated agent reply from being returned.

## Future Modules

Planned modules and integrations:

- Live2D / VRM frontend
- autonomous loop
- screen perception
- Minecraft/game agent
- emotion engine
- procedural memory
- NATS event bus implementation

These should integrate through the protocol and event bus rather than bypassing runtime core.

## Non-Goals For MVP

- No full Live2D integration yet.
- No complex autonomous behavior yet.
- No multi-character system yet.
- No heavy microservice split yet.

The MVP should stay small, runnable, and easy to extend.
