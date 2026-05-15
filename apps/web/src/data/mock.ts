export const mockEvents = [
  {
    id: "mock-event-1",
    traceId: "mock-trace-overview",
    type: "runtime.started",
    createdAt: new Date().toISOString(),
    payload: { source: "web-mock", note: "Backend event history endpoint is not implemented yet." }
  },
  {
    id: "mock-event-2",
    traceId: "mock-trace-provider",
    type: "provider.health.checked",
    createdAt: new Date().toISOString(),
    payload: { source: "web-mock", provider: "deepseek" }
  }
];

export const promptPreviewPlaceholder = [
  {
    title: "Identity",
    content: "This section will show the companion identity and behavior frame."
  },
  {
    title: "Memory Context",
    content: "Retrieved, ranked, compressed, and reconstructed memories will appear here."
  },
  {
    title: "Current Turn",
    content: "The final user request and runtime context will appear here before provider dispatch."
  }
];
