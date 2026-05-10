# @companion/event-bus

Event bus abstraction for runtime communication.

Responsibilities:

- Publish and subscribe to runtime events.
- Provide an in-memory implementation for the MVP.
- Preserve an interface that can later support NATS without changing core runtime code.

## Publishing

Modules publish `RuntimeEvent` objects. Events carry `traceId`, so follow-up events can preserve the same runtime trace.

```ts
await eventBus.publish(createEvent("user.message", {
  sessionId: "session-1",
  content: "hello"
}));
```

## Subscribing

Modules subscribe with an exact type or wildcard pattern:

- `user.*`
- `memory.*`
- `agent.*`
- `tts.*`
- `stt.*`
- `vision.*`
- `provider.*`
- `*`

```ts
const subscription = eventBus.subscribe("user.*", async (event) => {
  // handle user events
});

subscription.unsubscribe();
```

## Example

See `src/example.ts` for a minimal `user.message -> agent.reply` flow.
