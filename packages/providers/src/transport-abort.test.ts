import { afterEach, describe, expect, it, vi } from "vitest";
import { createTransportAbort } from "./transport-abort.js";

describe("createTransportAbort", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a usable signal and arms its timeout without a caller signal", () => {
    vi.useFakeTimers();
    const transport = createTransportAbort({ timeoutMs: 100 });

    expect(transport.signal.aborted).toBe(false);
    expect(transport.source).toBeNull();
    expect(vi.getTimerCount()).toBe(1);

    transport.cleanup();
  });

  it("identifies an already-aborted caller as pre-start cancellation", () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    caller.abort();

    const transport = createTransportAbort({ signal: caller.signal, timeoutMs: 100 });

    expect(transport.source).toBe("caller");
    expect(transport.signal.aborted).toBe(true);
    expect(transport.effectState).toBe("not_started");
    expect(transport.markStarted()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    transport.cleanup();
  });

  it("aborts the shared signal when the caller cancels in flight", () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const transport = createTransportAbort({ signal: caller.signal, timeoutMs: 100 });

    expect(transport.markStarted()).toBe(true);
    caller.abort();

    expect(transport.source).toBe("caller");
    expect(transport.signal.aborted).toBe(true);
    expect(transport.effectState).toBe("unknown");

    transport.cleanup();
  });

  it("identifies timeout and aborts the shared signal", () => {
    vi.useFakeTimers();
    const transport = createTransportAbort({ timeoutMs: 100 });

    expect(transport.markStarted()).toBe(true);
    vi.advanceTimersByTime(100);

    expect(transport.source).toBe("timeout");
    expect(transport.signal.aborted).toBe(true);
    expect(transport.effectState).toBe("unknown");

    transport.cleanup();
  });

  it("keeps caller as the first trigger when timeout follows", () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const transport = createTransportAbort({ signal: caller.signal, timeoutMs: 100 });

    caller.abort();
    vi.advanceTimersByTime(100);

    expect(transport.source).toBe("caller");

    transport.cleanup();
  });

  it("keeps timeout as the first trigger when caller cancellation follows", () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const transport = createTransportAbort({ signal: caller.signal, timeoutMs: 100 });

    vi.advanceTimersByTime(100);
    caller.abort();

    expect(transport.source).toBe("timeout");

    transport.cleanup();
  });

  it("does not allow a cleared timeout to change state", () => {
    vi.useFakeTimers();
    const transport = createTransportAbort({ timeoutMs: 100 });

    transport.cleanup();
    vi.advanceTimersByTime(100);

    expect(transport.source).toBeNull();
    expect(transport.signal.aborted).toBe(false);
  });

  it("removes the caller listener during cleanup", () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const transport = createTransportAbort({ signal: caller.signal, timeoutMs: 100 });

    transport.cleanup();
    caller.abort();

    expect(transport.source).toBeNull();
    expect(transport.signal.aborted).toBe(false);
  });

  it("allows cleanup to be called repeatedly", () => {
    vi.useFakeTimers();
    const transport = createTransportAbort({ timeoutMs: 100 });

    expect(() => {
      transport.cleanup();
      transport.cleanup();
    }).not.toThrow();
  });

  it("remains active through a response body phase", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const transport = createTransportAbort({ signal: caller.signal, timeoutMs: 100 });
    let resolveFetch: ((response: { json(): Promise<void> }) => void) | undefined;
    let resolveBody: (() => void) | undefined;
    let bodyStarted: (() => void) | undefined;
    const fetchPhase = new Promise<{ json(): Promise<void> }>((resolve) => {
      resolveFetch = resolve;
    });
    const bodyPhase = new Promise<void>((resolve) => {
      resolveBody = resolve;
    });
    const bodyStartedPhase = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });

    const operation = (async (): Promise<void> => {
      expect(transport.markStarted()).toBe(true);
      const response = await fetchPhase;
      await response.json();
    })();

    resolveFetch?.({
      json: async (): Promise<void> => {
        bodyStarted?.();
        await bodyPhase;
      }
    });
    await bodyStartedPhase;

    caller.abort();
    expect(transport.source).toBe("caller");
    expect(transport.signal.aborted).toBe(true);

    resolveBody?.();
    await operation;
    transport.cleanup();
  });
});
