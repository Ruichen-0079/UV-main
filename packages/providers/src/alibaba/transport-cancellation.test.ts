import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderErrorCode } from "../types/errors.js";
import { DashScopeSTTProvider } from "./DashScopeSTTProvider.js";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

const sttInput = {
  audioBase64: "AQID",
  mimeType: "audio/wav",
  language: "zh",
  metadata: { enableItn: true }
};
const readFileMock = readFile as unknown as ReturnType<typeof vi.fn>;

function createProvider(timeoutMs = 100): DashScopeSTTProvider {
  return new DashScopeSTTProvider({
    apiKey: "dashscope-key",
    baseUrl: "https://dashscope.test/api/v1",
    model: "dashscope-asr",
    timeoutMs
  });
}

function transcriptPayload(text = "recognized text"): Record<string, unknown> {
  return {
    model: "dashscope-asr-remote",
    choices: [
      {
        message: {
          content: text,
          annotations: [{ type: "audio_info", language: "en", confidence: 0.92 }]
        }
      }
    ],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, seconds: 1.5 }
  };
}

function transcriptResponse(text = "recognized text"): Response {
  return new Response(JSON.stringify(transcriptPayload(text)), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

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

describe("DashScope STT transport cancellation", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    readFileMock.mockReset();
  });

  it("returns Cancelled without fetch I/O for an already-aborted STT caller", async () => {
    const caller = new AbortController();
    caller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(createProvider().transcribeAudio(sttInput, { signal: caller.signal })).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "not_started"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates caller cancellation while the STT fetch is pending", async () => {
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
            () => reject(new Error("mock STT fetch aborted")),
            { once: true }
          );
        });
      })
    );

    const pending = createProvider().transcribeAudio(sttInput, { signal: caller.signal });
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

  it("does not fetch when caller cancellation wins during local audio preprocessing", async () => {
    const caller = new AbortController();
    const readStarted = deferred<void>();
    const file = deferred<Buffer>();
    readFileMock.mockImplementation(() => {
      readStarted.resolve();
      return file.promise;
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const pending = createProvider().transcribeAudio(
      { localFilePath: "/tmp/audio.wav", language: "en" },
      { signal: caller.signal }
    );
    await readStarted.promise;
    caller.abort();
    file.resolve(Buffer.from([1, 2, 3]));

    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "not_started"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves a local audio read failure without classifying it as NetworkError", async () => {
    const localError = new Error("synthetic local audio read failure");
    readFileMock.mockRejectedValueOnce(localError);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createProvider().transcribeAudio({ localFilePath: "/tmp/missing-audio.wav" })
    ).rejects.toBe(localError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps caller cancellation active while the STT JSON body is pending", async () => {
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
          json: () =>
            new Promise<unknown>((_resolve, reject) => {
              receivedSignal?.addEventListener(
                "abort",
                () => reject(new Error("mock STT body aborted")),
                { once: true }
              );
              bodyStarted.resolve();
            })
        } as Response;
      })
    );

    const pending = createProvider().transcribeAudio(sttInput, { signal: caller.signal });
    await bodyStarted.promise;
    caller.abort();

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "unknown"
    });
  });

  it("does not return STT success when caller wins during an abort-ignoring JSON body", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
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

    const pending = createProvider().transcribeAudio(sttInput, { signal: caller.signal });
    await bodyStarted.promise;
    caller.abort();
    vi.advanceTimersByTime(100);
    body.resolve(transcriptPayload("late caller transcript"));

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "unknown"
    });
  });

  it("returns Timeout while the STT JSON body is pending", async () => {
    vi.useFakeTimers();
    const bodyStarted = deferred<void>();
    let receivedSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        receivedSignal = init?.signal;
        return {
          ok: true,
          json: () =>
            new Promise<unknown>((_resolve, reject) => {
              receivedSignal?.addEventListener(
                "abort",
                () => reject(new Error("mock STT body aborted")),
                { once: true }
              );
              bodyStarted.resolve();
            })
        } as Response;
      })
    );

    const pending = createProvider().transcribeAudio(sttInput);
    await bodyStarted.promise;
    vi.advanceTimersByTime(100);

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Timeout,
      effectState: "unknown"
    });
  });

  it("does not return STT success when timeout wins during an abort-ignoring JSON body", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
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

    const pending = createProvider().transcribeAudio(sttInput, { signal: caller.signal });
    await bodyStarted.promise;
    vi.advanceTimersByTime(100);
    caller.abort();
    body.resolve(transcriptPayload("late timeout transcript"));

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Timeout,
      effectState: "unknown"
    });
  });

  it("classifies an ordinary started STT fetch failure as NetworkError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("mock STT network failure");
      })
    );

    await expect(createProvider().transcribeAudio(sttInput)).rejects.toMatchObject({
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
  ])("normalizes remote STT HTTP %i through the shared mapping", async (status, code, retryable) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("provider error", { status })));

    await expect(createProvider().transcribeAudio(sttInput)).rejects.toMatchObject({
      code,
      statusCode: status,
      retryable,
      fallbackEligible: true,
      effectState: "unknown"
    });
  });

  it("keeps the timeout winner when a non-OK response body ignores abort", async () => {
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

    const pending = createProvider().transcribeAudio(sttInput);
    await errorBodyStarted.promise;
    vi.advanceTimersByTime(100);
    errorBody.resolve("late provider error");

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Timeout,
      effectState: "unknown"
    });
  });

  it("classifies malformed successful STT JSON as MalformedResponse", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not JSON", { status: 200 })));

    await expect(createProvider().transcribeAudio(sttInput)).rejects.toMatchObject({
      code: ProviderErrorCode.MalformedResponse,
      retryable: false,
      effectState: "unknown"
    });
  });

  it("preserves normalized DashScope STT output semantics", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => transcriptResponse("recognized speech")));

    await expect(createProvider().transcribeAudio(sttInput)).resolves.toMatchObject({
      text: "recognized speech",
      language: "en",
      confidence: 0.92,
      model: "dashscope-asr",
      tokenUsage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      providerMetadata: {
        sourceKind: "base64",
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, seconds: 1.5 }
      }
    });
  });

  it("preserves local STT input validation before network start", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(createProvider().transcribeAudio({})).rejects.toMatchObject({
      code: ProviderErrorCode.UnsupportedInput,
      retryable: false,
      effectState: "not_started"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
