# AGENTS.md

Durable instructions for Codex and other coding agents working on this repository.

## Project

AI Companion Runtime is an original implementation inspired by Project AIRI architecture goals. Do not copy AIRI code.

The target product is a one-piece cross-platform desktop app for Windows, macOS, and Linux.

## Core Goals

- Event-driven runtime
- Memory subsystem
- Prompt builder
- Provider abstraction
- Web dashboard
- Future Tauri desktop app
- Future Live2D, VRM, voice, and vision integration
- Final packaging for Windows, macOS, and Linux

## Default Providers

- Chat: DeepSeek API
- Reasoning: DeepSeek API
- TTS: xAI
- STT: Alibaba Cloud DashScope
- Vision: xAI
- Development memory: PostgreSQL + pgvector
- Production memory target: embedded local store, such as SQLite + vector extension or LanceDB

## Architecture Rules

1. Runtime core must not import DeepSeek, xAI, or Alibaba concrete classes directly.
2. Runtime core depends on interfaces only.
3. Provider-specific code belongs in `packages/providers`.
4. Memory should never be raw chat logs dumped into prompts.
5. Memory must be retrieved, ranked, compressed, and reconstructed before prompt injection.
6. All major input/output should be represented as runtime events.
7. HTTP and WebSocket handlers must stay thin.
8. Business logic belongs in `packages/core` and services.
9. Do not log API keys or Authorization headers.
10. Do not commit `.env` files.
11. Keep development mode and future desktop mode separate.
12. Production desktop mode must not require WSL, Docker, Node.js, pnpm, PostgreSQL, Redis, or NATS.

## Development Rules

- Prefer TypeScript.
- Use the pnpm workspace.
- Keep modules small and testable.
- Add or update docs when architecture changes.
- Add validation steps after each change.
- Do not rewrite the whole repository when a small refactor is enough.
- Do not add heavy frameworks unless clearly needed.

## Expected Repository Layout

```text
apps/
  server/
  web/
  desktop/         # future Tauri app

packages/
  protocol/
  event-bus/
  providers/
  memory/
  prompt-builder/
  core/
  config/
  local-store/     # future embedded storage

infra/
  docker-compose.yml

scripts/
  start-dev.cmd
  stop-dev.cmd
  dev.sh
  stop.sh
  health.sh

docs/
```

## Agent Notes

- Treat the current repository shape as the source of truth when planning changes.
- Prefer incremental implementation over broad rewrites.
- Keep provider implementations behind interfaces and registries.
- Keep runtime orchestration independent from vendor SDKs and API details.
- Keep development infrastructure separate from future packaged desktop runtime assumptions.
