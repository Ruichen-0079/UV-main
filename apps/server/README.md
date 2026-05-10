# @companion/server

Fastify runtime server for the AI Companion Runtime.

Responsibilities:

- Accept HTTP and WebSocket input.
- Convert transport messages into protocol events.
- Delegate runtime behavior to `@companion/core`.
- Keep route handlers thin.
- Avoid logging secrets such as API keys and authorization headers.

The current MVP exposes:

- `GET /health`
- `POST /v1/messages`
- `GET /v1/events` WebSocket endpoint
