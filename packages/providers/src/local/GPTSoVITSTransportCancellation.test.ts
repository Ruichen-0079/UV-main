import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderErrorCode } from "../types/errors.js";
import { GPTSoVITSTTSProvider } from "./GPTSoVITSTTSProvider.js";

const options = {
  wrapperBaseUrl: "http://127.0.0.1:9881",
  upstreamBaseUrl: "http://127.0.0.1:9880",
  model: "alice-v4",
  timeoutMs: 100,
  referenceAudioPath: "D:/alice.wav",
  referenceText: "reference",
  referenceLanguage: "ja"
};

const input = { text: "はい。" };

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return {
    promise,
    resolve(value: T): void {
      resolve?.(value);
    },
    reject(reason?: unknown): void {
      reject?.(reason);
    }
  };
}

function audioResponse(bytes = new Uint8Array([1, 2, 3])): Response {
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": "audio/wav" }
  });
}

describe("GPT-SoVITS transport cancellation", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns Cancelled without fetch I/O for a pre-aborted canonical caller", async () => {
    const caller = new AbortController();
    caller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new GPTSoVITSTTSProvider(options).synthesizeSpeech(input, { signal: caller.signal })
    ).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "not_started"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns Cancelled without fetch I/O for a pre-aborted deprecated input signal", async () => {
    const caller = new AbortController();
    caller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new GPTSoVITSTTSProvider(options).synthesizeSpeech({ ...input, signal: caller.signal })
    ).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "not_started"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives options.signal precedence over an already-aborted input.signal", async () => {
    const canonical = new AbortController();
    const deprecated = new AbortController();
    deprecated.abort();
    let receivedSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        receivedSignal = init?.signal;
        return audioResponse();
      })
    );

    await expect(
      new GPTSoVITSTTSProvider(options).synthesizeSpeech(
        { ...input, signal: deprecated.signal },
        { signal: canonical.signal }
      )
    ).resolves.toMatchObject({ audio: new Uint8Array([1, 2, 3]) });
    expect(receivedSignal?.aborted).toBe(false);
    expect(receivedSignal).not.toBe(deprecated.signal);
  });

  it("gives an already-aborted options.signal precedence over an active input.signal", async () => {
    const canonical = new AbortController();
    const deprecated = new AbortController();
    canonical.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new GPTSoVITSTTSProvider(options).synthesizeSpeech(
        { ...input, signal: deprecated.signal },
        { signal: canonical.signal }
      )
    ).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "not_started"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns Cancelled when the caller aborts while fetch is pending", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const fetchStarted = deferred<void>();
    let receivedSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        receivedSignal = init?.signal;
        fetchStarted.resolve();
        return new Promise<Response>((_resolve, reject) => {
          receivedSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          );
        });
      })
    );

    const pending = new GPTSoVITSTTSProvider(options).synthesizeSpeech(input, {
      signal: caller.signal
    });
    await fetchStarted.promise;
    caller.abort();

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "unknown"
    });
  });

  it("returns Timeout when timeout wins while fetch is pending", async () => {
    vi.useFakeTimers();
    const fetchStarted = deferred<void>();
    let receivedSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        receivedSignal = init?.signal;
        fetchStarted.resolve();
        return new Promise<Response>((_resolve, reject) => {
          receivedSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          );
        });
      })
    );

    const pending = new GPTSoVITSTTSProvider(options).synthesizeSpeech(input);
    await fetchStarted.promise;
    vi.advanceTimersByTime(100);

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Timeout,
      effectState: "unknown"
    });
  });

  it("keeps caller-first race classification after timeout advances", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const fetchStarted = deferred<void>();
    let receivedSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        receivedSignal = init?.signal;
        fetchStarted.resolve();
        return new Promise<Response>((_resolve, reject) => {
          receivedSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          );
        });
      })
    );

    const pending = new GPTSoVITSTTSProvider(options).synthesizeSpeech(input, {
      signal: caller.signal
    });
    await fetchStarted.promise;
    caller.abort();
    vi.advanceTimersByTime(100);

    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      effectState: "unknown"
    });
  });

  it("keeps timeout-first race classification after caller aborts", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const fetchStarted = deferred<void>();
    let receivedSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        receivedSignal = init?.signal;
        fetchStarted.resolve();
        return new Promise<Response>((_resolve, reject) => {
          receivedSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          );
        });
      })
    );

    const pending = new GPTSoVITSTTSProvider(options).synthesizeSpeech(input, {
      signal: caller.signal
    });
    await fetchStarted.promise;
    vi.advanceTimersByTime(100);
    caller.abort();

    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Timeout,
      effectState: "unknown"
    });
  });

  it("keeps caller cancellation active while arrayBuffer is pending", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const bodyStarted = deferred<void>();
    let receivedSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        receivedSignal = init?.signal;
        return {
          ok: true,
          headers: new Headers({ "content-type": "audio/wav" }),
          arrayBuffer: () =>
            new Promise<ArrayBuffer>((_resolve, reject) => {
              receivedSignal?.addEventListener(
                "abort",
                () => reject(new DOMException("aborted", "AbortError")),
                { once: true }
              );
              bodyStarted.resolve();
            })
        } as Response;
      })
    );

    const pending = new GPTSoVITSTTSProvider(options).synthesizeSpeech(input, {
      signal: caller.signal
    });
    await bodyStarted.promise;
    caller.abort();

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      effectState: "unknown"
    });
  });

  it("does not return audio when caller wins during an abort-ignoring arrayBuffer", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const bodyStarted = deferred<void>();
    const body = deferred<ArrayBuffer>();
    let receivedSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        receivedSignal = init?.signal;
        return {
          ok: true,
          headers: new Headers({ "content-type": "audio/wav" }),
          arrayBuffer: () => {
            bodyStarted.resolve();
            return body.promise;
          }
        } as Response;
      })
    );

    const pending = new GPTSoVITSTTSProvider(options).synthesizeSpeech(input, {
      signal: caller.signal
    });
    await bodyStarted.promise;
    caller.abort();
    vi.advanceTimersByTime(100);
    body.resolve(new Uint8Array([1, 2, 3]).buffer);

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "unknown"
    });
  });

  it("does not return audio when timeout wins during an abort-ignoring arrayBuffer", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const bodyStarted = deferred<void>();
    const body = deferred<ArrayBuffer>();
    let receivedSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        receivedSignal = init?.signal;
        return {
          ok: true,
          headers: new Headers({ "content-type": "audio/wav" }),
          arrayBuffer: () => {
            bodyStarted.resolve();
            return body.promise;
          }
        } as Response;
      })
    );

    const pending = new GPTSoVITSTTSProvider(options).synthesizeSpeech(input, {
      signal: caller.signal
    });
    await bodyStarted.promise;
    vi.advanceTimersByTime(100);
    caller.abort();
    body.resolve(new Uint8Array([1, 2, 3]).buffer);

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Timeout,
      effectState: "unknown"
    });
  });

  it("classifies an ordinary started fetch failure as NetworkError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("synthetic GPT-SoVITS network failure");
      })
    );

    await expect(new GPTSoVITSTTSProvider(options).synthesizeSpeech(input)).rejects.toMatchObject({
      code: ProviderErrorCode.NetworkError,
      effectState: "unknown"
    });
  });

  it.each([
    [400, ProviderErrorCode.UnsupportedInput, false],
    [401, ProviderErrorCode.InvalidApiKey, false],
    [408, ProviderErrorCode.Timeout, true],
    [429, ProviderErrorCode.RateLimited, true],
    [500, ProviderErrorCode.ProviderUnavailable, true]
  ])("normalizes GPT-SoVITS HTTP %i through the shared mapper", async (status, code, retryable) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("provider error", { status })));

    await expect(new GPTSoVITSTTSProvider(options).synthesizeSpeech(input)).rejects.toMatchObject({
      code,
      statusCode: status,
      retryable,
      fallbackEligible: true,
      effectState: "unknown"
    });
  });

  it("keeps a timeout winner when a non-OK response body ignores abort", async () => {
    vi.useFakeTimers();
    const errorBodyStarted = deferred<void>();
    const errorBody = deferred<string>();
    let receivedSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        receivedSignal = init?.signal;
        return {
          ok: false,
          status: 429,
          text: () => {
            errorBodyStarted.resolve();
            return errorBody.promise;
          }
        } as Response;
      })
    );

    const pending = new GPTSoVITSTTSProvider(options).synthesizeSpeech(input);
    await errorBodyStarted.promise;
    vi.advanceTimersByTime(100);
    errorBody.resolve("late provider error");

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Timeout,
      effectState: "unknown"
    });
  });

  it("returns MalformedResponse for empty successful audio", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => audioResponse(new Uint8Array())));

    await expect(new GPTSoVITSTTSProvider(options).synthesizeSpeech(input)).rejects.toMatchObject({
      code: ProviderErrorCode.MalformedResponse,
      retryable: false,
      effectState: "unknown"
    });
  });

  it("preserves normal wrapper output semantics", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => audioResponse(new Uint8Array([4, 5]))));

    await expect(new GPTSoVITSTTSProvider(options).synthesizeSpeech(input)).resolves.toMatchObject({
      audio: new Uint8Array([4, 5]),
      mimeType: "audio/wav",
      model: "alice-v4",
      finalProvider: "local",
      providerMetadata: { language: "ja", transport: "wrapper" }
    });
  });

  it("preserves empty-text local validation before network start", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(new GPTSoVITSTTSProvider(options).synthesizeSpeech({ text: "   " })).rejects.toMatchObject({
      code: ProviderErrorCode.UnsupportedInput,
      retryable: false,
      effectState: "not_started"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a healthy local model from the /health probe", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ model_loaded: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );

    await expect(new GPTSoVITSTTSProvider(options).healthCheck()).resolves.toMatchObject({
      status: "healthy",
      available: true,
      model: "alice-v4"
    });
  });

  it("reports unavailable when health fetch times out", async () => {
    vi.useFakeTimers();
    const fetchStarted = deferred<void>();
    let receivedSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        receivedSignal = init?.signal;
        fetchStarted.resolve();
        return new Promise<Response>((_resolve, reject) => {
          receivedSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          );
        });
      })
    );

    const pending = new GPTSoVITSTTSProvider(options).healthCheck();
    await fetchStarted.promise;
    vi.advanceTimersByTime(100);

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ status: "unavailable" });
  });

  it("keeps health unavailable when timeout wins before an abort-ignoring fetch resolves", async () => {
    vi.useFakeTimers();
    const fetchStarted = deferred<void>();
    const fetchResult = deferred<Response>();
    let receivedSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        receivedSignal = init?.signal;
        fetchStarted.resolve();
        return fetchResult.promise;
      })
    );

    const pending = new GPTSoVITSTTSProvider(options).healthCheck();
    await fetchStarted.promise;
    vi.advanceTimersByTime(100);
    fetchResult.resolve(
      new Response(JSON.stringify({ model_loaded: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ status: "unavailable" });
  });

  it("keeps health unavailable when timeout wins during an abort-ignoring JSON body", async () => {
    vi.useFakeTimers();
    const bodyStarted = deferred<void>();
    const body = deferred<unknown>();
    let receivedSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        receivedSignal = init?.signal;
        return {
          ok: true,
          json: () => {
            bodyStarted.resolve();
            return body.promise;
          }
        } as Response;
      })
    );

    const pending = new GPTSoVITSTTSProvider(options).healthCheck();
    await bodyStarted.promise;
    vi.advanceTimersByTime(100);
    body.resolve({ model_loaded: true });

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ status: "unavailable" });
  });
});
