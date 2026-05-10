# AI Companion Runtime

[English](README.md) | [简体中文](README.zh-CN.md)

A local-first, event-driven AI companion runtime inspired by Project AIRI architecture goals, without copying AIRI code.

This repository starts as a small runnable TypeScript monorepo:

- `apps/server`: Fastify HTTP and WebSocket runtime server.
- `packages/protocol`: event types and schemas.
- `packages/event-bus`: event bus abstraction and in-memory implementation.
- `packages/memory`: memory repository/service interfaces and MVP in-memory implementation.
- `packages/prompt-builder`: dynamic prompt assembly.
- `packages/providers`: provider interfaces, registry, normalized errors, and local echo provider for development.
- `packages/core`: runtime orchestrator and agent loop boundary.

## Getting Started

```bash
pnpm install
pnpm dev
```

The server defaults to `http://127.0.0.1:3000`.

## Scripts

- `pnpm dev`: run the Fastify server in development mode.
- `pnpm build`: build all workspace packages.
- `pnpm check`: type-check all workspace packages.
- `pnpm test`: run package tests where present.

## Infrastructure

```bash
docker compose -f infra/docker-compose.yml up -d
```

This starts PostgreSQL with pgvector, Redis, and NATS for future event bus work.
