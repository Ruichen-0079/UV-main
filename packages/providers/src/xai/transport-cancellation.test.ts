import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderErrorCode } from "../types/errors.js";
import { XAITTSProvider } from "./XAITTSProvider.js";
import { XAIVisionProvider } from "./XAIVisionProvider.js";
import { healthCheckXAI } from "./common.js";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

const ttsInput = { text: "hello" };
const visionInput = {
  imageBase64: "AQID",
  mimeType: "image/png",
  prompt: "describe"
};
const readFileMock = readFile as unknown as ReturnType<typeof vi.fn>;

function createTTSProvider(timeoutMs = 100): XAITTSProvider {
  return new XAITTSProvider({
    apiKey: "xai-key",
    baseUrl: "https://xai.test/v1",
    model: "xai-tts",
    timeoutMs
  });
}

function createVisionProvider(timeoutMs = 100): XAIVisionProvider {
  return new XAIVisionProvider({
    apiKey: "xai-key",
    baseUrl: "https://xai.test/v1",
    model: "xai-vision",
    timeoutMs
  });
}

function visionPayload(content = "scene"): Record<string, unknown> {
  return {
    model: "xai-vision-model",
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
  };
}

function visionResponse(content = "scene"): Response {
  return new Response(JSON.stringify(visionPayload(content)), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("xAI transport cancellation", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    readFileMock.mockReset();
  });

  it("returns unavailable when a timeout wins before an abort-ignoring health fetch resolves", async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | null | undefined;
    let resolveFetch: ((value: Response) => void) | undefined;
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        receivedSignal = init?.signal;
        markFetchStarted?.();
        return new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        });
      })
    );

    const pending = healthCheckXAI("xai", "tts", {
      apiKey: "xai-key",
      baseUrl: "https://xai.test/v1",
      model: "xai-tts",
      timeoutMs: 100
    });
    await fetchStarted;
    vi.advanceTimersByTime(100);

    expect(receivedSignal?.aborted).toBe(true);
    resolveFetch?.(new Response(null, { status: 200 }));

    await expect(pending).resolves.toMatchObject({ status: "unavailable" });
  });

  it("returns Cancelled without fetch I/O for an already-aborted TTS caller", async () => {
    const caller = new AbortController();
    caller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createTTSProvider().synthesizeSpeech(ttsInput, { signal: caller.signal })
    ).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "not_started"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns Cancelled when the TTS caller aborts while fetch is pending", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          receivedSignal = init?.signal;
          markFetchStarted?.();
          return new Promise<Response>((_resolve, reject) => {
            receivedSignal?.addEventListener(
              "abort",
              () => reject(new Error("mock TTS fetch aborted")),
              { once: true }
            );
          });
        }
      )
    );

    const pending = createTTSProvider().synthesizeSpeech(ttsInput, { signal: caller.signal });
    await fetchStarted;
    caller.abort();

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "unknown"
    });
  });

  it("keeps caller cancellation active while the TTS arrayBuffer body is pending", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    let markBodyStarted: (() => void) | undefined;
    const bodyStarted = new Promise<void>((resolve) => {
      markBodyStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        receivedSignal = init?.signal;
        return {
          ok: true,
          headers: new Headers({ "content-type": "audio/mpeg" }),
          arrayBuffer: () =>
            new Promise<ArrayBuffer>((_resolve, reject) => {
              receivedSignal?.addEventListener(
                "abort",
                () => reject(new Error("mock TTS body aborted")),
                { once: true }
              );
              markBodyStarted?.();
            })
        } as Response;
      })
    );

    const pending = createTTSProvider().synthesizeSpeech(ttsInput, { signal: caller.signal });
    await bodyStarted;
    caller.abort();

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "unknown"
    });
  });

  it("does not return TTS success when caller wins during an abort-ignoring arrayBuffer body", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    let resolveBody: ((value: ArrayBuffer) => void) | undefined;
    let markBodyStarted: (() => void) | undefined;
    const bodyStarted = new Promise<void>((resolve) => {
      markBodyStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        receivedSignal = init?.signal;
        return {
          ok: true,
          headers: new Headers({ "content-type": "audio/mpeg" }),
          arrayBuffer: () =>
            new Promise<ArrayBuffer>((resolve) => {
              resolveBody = resolve;
              markBodyStarted?.();
            })
        } as Response;
      })
    );

    const pending = createTTSProvider().synthesizeSpeech(ttsInput, { signal: caller.signal });
    await bodyStarted;
    caller.abort();
    vi.advanceTimersByTime(100);

    expect(receivedSignal?.aborted).toBe(true);
    resolveBody?.(new Uint8Array([1, 2, 3]).buffer);

    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "unknown"
    });
  });

  it("returns Timeout while the TTS arrayBuffer body is pending", async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | null | undefined;
    let markBodyStarted: (() => void) | undefined;
    const bodyStarted = new Promise<void>((resolve) => {
      markBodyStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        receivedSignal = init?.signal;
        return {
          ok: true,
          headers: new Headers(),
          arrayBuffer: () =>
            new Promise<ArrayBuffer>((_resolve, reject) => {
              receivedSignal?.addEventListener(
                "abort",
                () => reject(new Error("mock TTS body aborted")),
                { once: true }
              );
              markBodyStarted?.();
            })
        } as Response;
      })
    );

    const pending = createTTSProvider().synthesizeSpeech(ttsInput);
    await bodyStarted;
    vi.advanceTimersByTime(100);

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Timeout,
      effectState: "unknown"
    });
  });

  it("does not return TTS success when timeout wins during an abort-ignoring arrayBuffer body", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    let resolveBody: ((value: ArrayBuffer) => void) | undefined;
    let markBodyStarted: (() => void) | undefined;
    const bodyStarted = new Promise<void>((resolve) => {
      markBodyStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        receivedSignal = init?.signal;
        return {
          ok: true,
          headers: new Headers(),
          arrayBuffer: () =>
            new Promise<ArrayBuffer>((resolve) => {
              resolveBody = resolve;
              markBodyStarted?.();
            })
        } as Response;
      })
    );

    const pending = createTTSProvider().synthesizeSpeech(ttsInput, { signal: caller.signal });
    await bodyStarted;
    vi.advanceTimersByTime(100);
    caller.abort();

    expect(receivedSignal?.aborted).toBe(true);
    resolveBody?.(new Uint8Array([1, 2, 3]).buffer);

    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Timeout,
      effectState: "unknown"
    });
  });

  it.each([
    [401, ProviderErrorCode.InvalidApiKey, false],
    [429, ProviderErrorCode.RateLimited, true]
  ])("normalizes remote TTS HTTP %i through the shared mapping", async (status, code, retryable) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("provider error", { status })));

    await expect(createTTSProvider().synthesizeSpeech(ttsInput)).rejects.toMatchObject({
      code,
      statusCode: status,
      retryable,
      fallbackEligible: true,
      effectState: "unknown"
    });
  });

  it("classifies an ordinary started TTS failure as NetworkError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("mock TTS network failure");
      })
    );

    await expect(createTTSProvider().synthesizeSpeech(ttsInput)).rejects.toMatchObject({
      code: ProviderErrorCode.NetworkError,
      effectState: "unknown"
    });
  });

  it("returns Cancelled without fetch I/O for an already-aborted Vision caller", async () => {
    const caller = new AbortController();
    caller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createVisionProvider().analyzeImage(visionInput, { signal: caller.signal })
    ).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "not_started"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates Vision caller cancellation to fetch", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          receivedSignal = init?.signal;
          markFetchStarted?.();
          return new Promise<Response>((_resolve, reject) => {
            receivedSignal?.addEventListener(
              "abort",
              () => reject(new Error("mock Vision fetch aborted")),
              { once: true }
            );
          });
        }
      )
    );

    const pending = createVisionProvider().analyzeImage(visionInput, { signal: caller.signal });
    await fetchStarted;
    caller.abort();

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "unknown"
    });
  });

  it("does not fetch when Vision caller aborts during local file preprocessing", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let resolveFile: ((value: Buffer) => void) | undefined;
    let markReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    readFileMock.mockImplementation(
      () =>
        new Promise<Buffer>((resolve) => {
          resolveFile = resolve;
          markReadStarted?.();
        })
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const pending = createVisionProvider().analyzeImage(
      { localFilePath: "/tmp/vision.png", prompt: "describe" },
      { signal: caller.signal }
    );
    await readStarted;
    caller.abort();
    resolveFile?.(Buffer.from([1, 2, 3]));

    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "not_started"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves a local Vision file-read failure without classifying it as NetworkError", async () => {
    const localError = new Error("synthetic local file read failure");
    readFileMock.mockRejectedValueOnce(localError);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createVisionProvider().analyzeImage({
        localFilePath: "/tmp/missing-vision.png",
        prompt: "describe"
      })
    ).rejects.toBe(localError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not return Vision success when caller wins during an abort-ignoring JSON body", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    let resolveJson: ((value: unknown) => void) | undefined;
    let markJsonStarted: (() => void) | undefined;
    const jsonStarted = new Promise<void>((resolve) => {
      markJsonStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        receivedSignal = init?.signal;
        return {
          ok: true,
          json: () =>
            new Promise<unknown>((resolve) => {
              resolveJson = resolve;
              markJsonStarted?.();
            })
        } as Response;
      })
    );

    const pending = createVisionProvider().analyzeImage(visionInput, { signal: caller.signal });
    await jsonStarted;
    caller.abort();
    vi.advanceTimersByTime(100);

    expect(receivedSignal?.aborted).toBe(true);
    resolveJson?.(visionPayload("late scene"));

    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "unknown"
    });
  });

  it("does not return Vision success when timeout wins during an abort-ignoring JSON body", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    let resolveJson: ((value: unknown) => void) | undefined;
    let markJsonStarted: (() => void) | undefined;
    const jsonStarted = new Promise<void>((resolve) => {
      markJsonStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        receivedSignal = init?.signal;
        return {
          ok: true,
          json: () =>
            new Promise<unknown>((resolve) => {
              resolveJson = resolve;
              markJsonStarted?.();
            })
        } as Response;
      })
    );

    const pending = createVisionProvider().analyzeImage(visionInput, { signal: caller.signal });
    await jsonStarted;
    vi.advanceTimersByTime(100);
    caller.abort();

    expect(receivedSignal?.aborted).toBe(true);
    resolveJson?.(visionPayload("late scene"));

    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Timeout,
      effectState: "unknown"
    });
  });

  it.each([
    [400, ProviderErrorCode.UnsupportedInput, false],
    [401, ProviderErrorCode.InvalidApiKey, false],
    [429, ProviderErrorCode.RateLimited, true]
  ])("normalizes remote Vision HTTP %i through the shared mapping", async (status, code, retryable) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("provider error", { status })));

    await expect(createVisionProvider().analyzeImage(visionInput)).rejects.toMatchObject({
      code,
      statusCode: status,
      retryable,
      fallbackEligible: true,
      effectState: "unknown"
    });
  });

  it("classifies malformed successful Vision JSON as MalformedResponse", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not JSON", { status: 200 })));

    await expect(createVisionProvider().analyzeImage(visionInput)).rejects.toMatchObject({
      code: ProviderErrorCode.MalformedResponse,
      retryable: false,
      effectState: "unknown"
    });
  });

  it("preserves normal Vision output semantics", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => visionResponse("a bright scene")));

    await expect(createVisionProvider().analyzeImage(visionInput)).resolves.toMatchObject({
      text: "a bright scene",
      sceneSummary: "a bright scene",
      model: "xai-vision-model",
      tokenUsage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }
    });
  });
});
