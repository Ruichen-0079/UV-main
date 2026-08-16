import type { ProviderEffectState } from "./types/errors.js";

/** The first condition that aborted a provider transport operation. */
export type TransportAbortSource = "caller" | "timeout" | null;

export type CreateTransportAbortOptions = {
  /** `ProviderCallOptions.signal`, the canonical caller cancellation channel. */
  signal?: AbortSignal | undefined;
  /** Maximum duration for the entire transport operation, including response-body parsing. */
  timeoutMs: number;
};

/**
 * A caller-owned lifetime guard for one provider transport operation.
 *
 * Call `markStarted()` immediately before the first network I/O. Keep this
 * guard alive through response-body consumption, then call `cleanup()` in a
 * `finally` block. The first abort source is retained for later error
 * classification; callers must not infer it from their original signal.
 */
export type TransportAbort = {
  readonly signal: AbortSignal;
  readonly source: TransportAbortSource;
  readonly effectState: ProviderEffectState | null;
  /**
   * Marks the operation as having started and returns false if it was already
   * aborted, allowing callers to avoid network I/O for pre-start cancellation.
   */
  markStarted(): boolean;
  /** Releases the timer and caller listener. Safe to call more than once. */
  cleanup(): void;
};

/**
 * Creates a single transport abort signal that distinguishes caller
 * cancellation from a timeout. Lifetime ownership stays with the caller so
 * the timeout also covers `response.json()`, `response.text()`, and
 * `response.arrayBuffer()`.
 */
export function createTransportAbort(options: CreateTransportAbortOptions): TransportAbort {
  const controller = new AbortController();
  let source: TransportAbortSource = null;
  let started = false;
  let cleanedUp = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const abort = (nextSource: Exclude<TransportAbortSource, null>): void => {
    if (cleanedUp || source !== null) {
      return;
    }
    source = nextSource;
    controller.abort();
  };

  const onCallerAbort = (): void => {
    abort("caller");
  };

  const cleanup = (): void => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
    options.signal?.removeEventListener("abort", onCallerAbort);
  };

  if (options.signal?.aborted) {
    abort("caller");
  } else {
    options.signal?.addEventListener("abort", onCallerAbort, { once: true });
    timeout = setTimeout(() => {
      abort("timeout");
    }, options.timeoutMs);
  }

  return {
    signal: controller.signal,
    get source(): TransportAbortSource {
      return source;
    },
    get effectState(): ProviderEffectState | null {
      if (source === null) {
        return null;
      }
      return source === "caller" && !started ? "not_started" : "unknown";
    },
    markStarted(): boolean {
      if (source !== null || cleanedUp) {
        return false;
      }
      started = true;
      return true;
    },
    cleanup
  };
}
