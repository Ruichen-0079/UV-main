import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderError,
  ProviderErrorCode,
  type ProviderCallOptions,
  type STTInput,
  type STTOutput,
  type TTSInput,
  type TTSOutput
} from "@companion/providers";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { AppContext } from "../context.js";
import { registerMediaRoutes } from "./media.js";

const routeCases = ["/v1/audio/transcriptions", "/v1/voice/message"] as const;

type TestSTTTranscriber = (
  input: STTInput,
  options?: ProviderCallOptions
) => Promise<STTOutput>;

type TestTTSSynthesizer = (input: TTSInput, options?: ProviderCallOptions) => Promise<TTSOutput>;

type RequestCapture = {
  raw: IncomingMessage | undefined;
  socket: Socket | undefined;
  rawAbortedListenersBefore: number | undefined;
  socketCloseListenersBefore: number | undefined;
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve(value: T): void {
      resolvePromise?.(value);
    },
    reject(reason?: unknown): void {
      rejectPromise?.(reason);
    }
  };
}

function recognizedOutput(): STTOutput {
  return {
    text: "recognized speech",
    language: "en",
    confidence: 0.9,
    model: "test-stt",
    providerMetadata: { sourceKind: "base64" }
  };
}

function speechOutput(): TTSOutput {
  return {
    audio: new Uint8Array([1, 2, 3]),
    audioBase64: "AQID",
    mimeType: "audio/wav",
    durationMs: 42,
    model: "test-tts",
    finalProvider: "test-tts",
    providerMetadata: { sourceKind: "test" }
  };
}

function cancelledProviderError(effectState: "not_started" | "unknown"): ProviderError {
  return new ProviderError({
    provider: "test-stt",
    capability: "stt",
    code: ProviderErrorCode.Cancelled,
    message: "STT operation cancelled.",
    retryable: false,
    fallbackEligible: false,
    effectState
  });
}

function cancelledTTSError(effectState: "not_started" | "unknown"): ProviderError {
  return new ProviderError({
    provider: "test-tts",
    capability: "tts",
    code: ProviderErrorCode.Cancelled,
    message: "TTS operation cancelled.",
    retryable: false,
    fallbackEligible: false,
    effectState
  });
}

function createContext() {
  const transcribeAudio = vi.fn(async () => ({
    text: "recognized speech",
    language: "en",
    confidence: 0.9,
    model: "test-stt",
    providerMetadata: { sourceKind: "base64" }
  }));
  const context = {
    providers: { getSTTProvider: () => ({ transcribeAudio }) },
    runtime: {
      handleUserMessage: vi.fn(async () => ({
        payload: { content: "reply", provider: "mock" },
        traceId: "trace-1"
      })),
      getLatestPromptPreview: vi.fn(() => undefined)
    }
  } as unknown as AppContext;
  return { context, transcribeAudio };
}

async function createApp() {
  const { context, transcribeAudio } = createContext();
  const app = Fastify({ logger: false });
  await registerMediaRoutes(app, context);
  return { app, transcribeAudio };
}

async function createLifecycleApp(
  route: (typeof routeCases)[number],
  transcribeAudio: TestSTTTranscriber,
  runtimeHandler?: (...args: never[]) => Promise<unknown>,
  configureRequest?: (raw: IncomingMessage, socket: Socket | undefined) => void
): Promise<{
  app: ReturnType<typeof Fastify>;
  transcribeAudio: TestSTTTranscriber;
  handleUserMessage: ReturnType<typeof vi.fn>;
  request: RequestCapture;
}> {
  const handleUserMessage = vi.fn(
    runtimeHandler ??
      (async () => ({
        payload: { content: "reply", provider: "mock" },
        traceId: "trace-1"
      }))
  );
  const context = {
    providers: { getSTTProvider: () => ({ transcribeAudio }) },
    runtime: {
      handleUserMessage,
      getLatestPromptPreview: vi.fn(() => undefined)
    }
  } as unknown as AppContext;
  const request: RequestCapture = {
    raw: undefined,
    socket: undefined,
    rawAbortedListenersBefore: undefined,
    socketCloseListenersBefore: undefined
  };
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (incomingRequest) => {
    request.raw = incomingRequest.raw;
    request.socket = incomingRequest.raw.socket ?? undefined;
    request.rawAbortedListenersBefore = request.raw.listenerCount("aborted");
    request.socketCloseListenersBefore = request.socket?.listenerCount("close");
    configureRequest?.(request.raw, request.socket);
  });
  await registerMediaRoutes(app, context);
  return { app, transcribeAudio, handleUserMessage, request };
}

async function createTTSLifecycleApp(
  synthesizeSpeech: TestTTSSynthesizer,
  configureRequest?: (raw: IncomingMessage, socket: Socket | undefined) => void
): Promise<{
  app: ReturnType<typeof Fastify>;
  synthesizeSpeech: TestTTSSynthesizer;
  request: RequestCapture;
}> {
  const context = {
    providers: { getTTSProvider: () => ({ name: "test-tts", synthesizeSpeech }) },
    runtime: {
      handleUserMessage: vi.fn(),
      getLatestPromptPreview: vi.fn(() => undefined)
    }
  } as unknown as AppContext;
  const request: RequestCapture = {
    raw: undefined,
    socket: undefined,
    rawAbortedListenersBefore: undefined,
    socketCloseListenersBefore: undefined
  };
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (incomingRequest) => {
    request.raw = incomingRequest.raw;
    request.socket = incomingRequest.raw.socket ?? undefined;
    request.rawAbortedListenersBefore = request.raw.listenerCount("aborted");
    request.socketCloseListenersBefore = request.socket?.listenerCount("close");
    configureRequest?.(request.raw, request.socket);
  });
  await registerMediaRoutes(app, context);
  return { app, synthesizeSpeech, request };
}

function emitDisconnect(request: RequestCapture, event: "aborted" | "socket-close"): void {
  if (event === "aborted") {
    request.raw?.emit("aborted");
    return;
  }
  request.socket?.emit("close");
}

function expectDisconnectListenersCleaned(request: RequestCapture): void {
  expect(request.raw).toBeDefined();
  expect(request.raw?.listenerCount("aborted")).toBe(request.rawAbortedListenersBefore);
  if (request.socket) {
    expect(request.socket.listenerCount("close")).toBe(request.socketCloseListenersBefore);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("public batch STT input validation", () => {
  for (const route of routeCases) {
    it(`${route} rejects missing audio and mock text before provider invocation`, async () => {
      const { app, transcribeAudio } = await createApp();

      const response = await app.inject({ method: "POST", url: route, payload: {} });

      expect(response.statusCode).toBe(400);
      expect(transcribeAudio).not.toHaveBeenCalled();
      await app.close();
    });

    it(`${route} rejects empty audioBase64 before provider invocation`, async () => {
      const { app, transcribeAudio } = await createApp();

      const response = await app.inject({
        method: "POST",
        url: route,
        payload: { audioBase64: "" }
      });

      expect(response.statusCode).toBe(400);
      expect(transcribeAudio).not.toHaveBeenCalled();
      await app.close();
    });

    it(`${route} rejects whitespace-only mockText without audio`, async () => {
      const { app, transcribeAudio } = await createApp();

      const response = await app.inject({
        method: "POST",
        url: route,
        payload: { mockText: "   \n" }
      });

      expect(response.statusCode).toBe(400);
      expect(transcribeAudio).not.toHaveBeenCalled();
      await app.close();
    });

    it(`${route} preserves explicit non-empty mockText compatibility`, async () => {
      const { app, transcribeAudio } = await createApp();

      const response = await app.inject({
        method: "POST",
        url: route,
        payload: { mockText: "developer mock transcript" }
      });

      expect(response.statusCode).toBe(200);
      expect(transcribeAudio).toHaveBeenCalledOnce();
      await app.close();
    });

    it(`${route} rejects malformed audioBase64 even with mockText`, async () => {
      const { app, transcribeAudio } = await createApp();

      const response = await app.inject({
        method: "POST",
        url: route,
        payload: { audioBase64: "not base64!", mockText: "do not fall back" }
      });

      expect(response.statusCode).toBe(400);
      expect(transcribeAudio).not.toHaveBeenCalled();
      await app.close();
    });

    it(`${route} rejects non-canonical raw base64 before provider invocation`, async () => {
      const { app, transcribeAudio } = await createApp();

      const response = await app.inject({
        method: "POST",
        url: route,
        payload: { audioBase64: "AB" }
      });

      expect(response.statusCode).toBe(400);
      expect(transcribeAudio).not.toHaveBeenCalled();
      await app.close();
    });

    it(`${route} rejects non-canonical data URL base64 before provider invocation`, async () => {
      const { app, transcribeAudio } = await createApp();

      const response = await app.inject({
        method: "POST",
        url: route,
        payload: { audioBase64: "data:audio/wav;base64,AB" }
      });

      expect(response.statusCode).toBe(400);
      expect(transcribeAudio).not.toHaveBeenCalled();
      await app.close();
    });

    it(`${route} accepts canonical unpadded base64`, async () => {
      const { app, transcribeAudio } = await createApp();

      const response = await app.inject({
        method: "POST",
        url: route,
        payload: { audioBase64: "AQ" }
      });

      expect(response.statusCode).toBe(200);
      expect(transcribeAudio).toHaveBeenCalledOnce();
      await app.close();
    });

    it(`${route} accepts valid raw and data URL base64`, async () => {
      const { app, transcribeAudio } = await createApp();

      for (const audioBase64 of ["AQID", "data:audio/wav;base64,AQID"]) {
        const response = await app.inject({
          method: "POST",
          url: route,
          payload: { audioBase64, mimeType: "audio/wav" }
        });
        expect(response.statusCode).toBe(200);
      }

      expect(transcribeAudio).toHaveBeenCalledTimes(2);
      await app.close();
    });
  }
});

describe("public batch STT disconnect cancellation", () => {
  for (const route of routeCases) {
    it(`${route} passes a caller-owned AbortSignal to STT`, async () => {
      const transcribeAudio = vi.fn<TestSTTTranscriber>(async () => recognizedOutput());
      const { app } = await createLifecycleApp(route, transcribeAudio);

      try {
        const response = await app.inject({
          method: "POST",
          url: route,
          payload: { audioBase64: "AQID" }
        });

        expect(response.statusCode).toBe(200);
        const signal = transcribeAudio.mock.calls[0]?.[1]?.signal;
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal?.aborted).toBe(false);
      } finally {
        await app.close();
      }
    });

    for (const event of ["aborted", "socket-close"] as const) {
      it(`${route} cancels pending STT on ${event} without entering success handling`, async () => {
        const started = deferred<void>();
        let signal: AbortSignal | undefined;
        const transcribeAudio = vi.fn<TestSTTTranscriber>(async (_input, options) => {
          signal = options?.signal;
          started.resolve();
          if (!signal) {
            throw new Error("STT route did not provide a disconnect signal.");
          }
          if (signal.aborted) {
            throw cancelledProviderError("not_started");
          }
          return new Promise<STTOutput>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(cancelledProviderError("unknown")),
              { once: true }
            );
          });
        });
        const { app, handleUserMessage, request } = await createLifecycleApp(
          route,
          transcribeAudio
        );

        try {
          const responsePromise = app.inject({
            method: "POST",
            url: route,
            payload: { audioBase64: "AQID" }
          });
          await started.promise;

          emitDisconnect(request, event);

          expect(signal?.aborted).toBe(true);
          const response = await responsePromise;
          expect(response.statusCode).toBe(503);
          expect(response.statusCode).not.toBe(200);
          if (route === "/v1/voice/message") {
            expect(handleUserMessage).not.toHaveBeenCalled();
          }
        } finally {
          await app.close();
        }
      });
    }
  }

  for (const route of routeCases) {
    it(`${route} does not abort STT for request raw close during a normal POST`, async () => {
      const started = deferred<void>();
      const finishSTT = deferred<STTOutput>();
      let signal: AbortSignal | undefined;
      const transcribeAudio = vi.fn<TestSTTTranscriber>(async (_input, options) => {
        signal = options?.signal;
        started.resolve();
        return finishSTT.promise;
      });
      const { app, request } = await createLifecycleApp(route, transcribeAudio);

      try {
        const responsePromise = app.inject({
          method: "POST",
          url: route,
          payload: { audioBase64: "AQID" }
        });
        await started.promise;

        request.raw?.emit("close");
        expect(signal?.aborted).toBe(false);

        finishSTT.resolve(recognizedOutput());
        const response = await responsePromise;
        expect(response.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it(`${route} removes STT disconnect listeners after success`, async () => {
      const transcribeAudio = vi.fn<TestSTTTranscriber>(async () => recognizedOutput());
      const { app, request } = await createLifecycleApp(route, transcribeAudio);

      try {
        const response = await app.inject({
          method: "POST",
          url: route,
          payload: { audioBase64: "AQID" }
        });

        expect(response.statusCode).toBe(200);
        expectDisconnectListenersCleaned(request);
      } finally {
        await app.close();
      }
    });

    it(`${route} removes STT disconnect listeners after failure`, async () => {
      const transcribeAudio = vi.fn<TestSTTTranscriber>(async () => {
        throw new Error("synthetic STT failure");
      });
      const { app, request } = await createLifecycleApp(route, transcribeAudio);

      try {
        const response = await app.inject({
          method: "POST",
          url: route,
          payload: { audioBase64: "AQID" }
        });

        expect(response.statusCode).toBe(503);
        expectDisconnectListenersCleaned(request);
      } finally {
        await app.close();
      }
    });

    it(`${route} honors a request that was already aborted before STT`, async () => {
      let signal: AbortSignal | undefined;
      const transcribeAudio = vi.fn<TestSTTTranscriber>(async (_input, options) => {
        signal = options?.signal;
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal?.aborted).toBe(true);
        throw cancelledProviderError("not_started");
      });
      const { app, request } = await createLifecycleApp(
        route,
        transcribeAudio,
        undefined,
        (raw) => {
          raw.aborted = true;
        }
      );

      try {
        const response = await app.inject({
          method: "POST",
          url: route,
          payload: { audioBase64: "AQID" }
        });

        expect(response.statusCode).toBe(503);
        expect(signal?.aborted).toBe(true);
        expectDisconnectListenersCleaned(request);
      } finally {
        await app.close();
      }
    });
  }

  it("/v1/voice/message ends STT disconnect ownership before chat starts", async () => {
    const sttStarted = deferred<void>();
    const finishSTT = deferred<STTOutput>();
    const runtimeStarted = deferred<void>();
    const finishRuntime = deferred<unknown>();
    let sttSignal: AbortSignal | undefined;
    const transcribeAudio = vi.fn<TestSTTTranscriber>(async (_input, options) => {
      sttSignal = options?.signal;
      sttStarted.resolve();
      return finishSTT.promise;
    });
    const runtimeHandler = vi.fn(async () => {
      runtimeStarted.resolve();
      return finishRuntime.promise;
    });
    const { app, handleUserMessage, request } = await createLifecycleApp(
      "/v1/voice/message",
      transcribeAudio,
      runtimeHandler
    );

    try {
      const responsePromise = app.inject({
        method: "POST",
        url: "/v1/voice/message",
        payload: { audioBase64: "AQID" }
      });
      await sttStarted.promise;
      finishSTT.resolve(recognizedOutput());
      await runtimeStarted.promise;

      expectDisconnectListenersCleaned(request);
      expect(sttSignal?.aborted).toBe(false);
      request.raw?.emit("aborted");
      request.socket?.emit("close");
      expect(sttSignal?.aborted).toBe(false);
      expect(handleUserMessage.mock.calls[0]?.[1]).not.toHaveProperty("signal");

      finishRuntime.resolve({
        payload: { content: "reply", provider: "mock" },
        traceId: "trace-1"
      });
      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe("public TTS disconnect cancellation", () => {
  it("passes the canonical signal without putting it on TTSInput", async () => {
    let receivedInput: TTSInput | undefined;
    let receivedOptions: ProviderCallOptions | undefined;
    const synthesizeSpeech = vi.fn<TestTTSSynthesizer>(async (input, options) => {
      receivedInput = input;
      receivedOptions = options;
      return speechOutput();
    });
    const { app } = await createTTSLifecycleApp(synthesizeSpeech);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tts",
        payload: { sessionId: "tts-session", text: "hello", voice: "ara", format: "wav" }
      });

      expect(response.statusCode).toBe(200);
      expect(receivedInput).toMatchObject({
        text: "hello",
        voice: "ara",
        format: "wav",
        metadata: { sessionId: "tts-session" }
      });
      expect(receivedInput).not.toHaveProperty("signal");
      expect(receivedOptions?.signal).toBeInstanceOf(AbortSignal);
      expect(receivedOptions?.signal?.aborted).toBe(false);
      expect(response.json()).toMatchObject({
        audioBase64: "AQID",
        mimeType: "audio/wav",
        durationMs: 42,
        finalProvider: "test-tts",
        provider: "test-tts",
        model: "test-tts"
      });
    } finally {
      await app.close();
    }
  });

  it("does not start TTS when the request is already aborted", async () => {
    const synthesizeSpeech = vi.fn<TestTTSSynthesizer>(async () => speechOutput());
    const { app, request } = await createTTSLifecycleApp(synthesizeSpeech, (raw) => {
      raw.aborted = true;
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tts",
        payload: { text: "hello" }
      });

      expect(response.statusCode).toBe(503);
      expect(synthesizeSpeech).not.toHaveBeenCalled();
      expectDisconnectListenersCleaned(request);
    } finally {
      await app.close();
    }
  });

  it("does not start TTS when the request socket is already destroyed", async () => {
    const synthesizeSpeech = vi.fn<TestTTSSynthesizer>(async () => speechOutput());
    const { app, request } = await createTTSLifecycleApp(synthesizeSpeech, (_raw, socket) => {
      if (socket) {
        Object.defineProperty(socket, "destroyed", { configurable: true, value: true });
      }
    });

    try {
      const responsePromise = app.inject({
        method: "POST",
        url: "/v1/tts",
        payload: { text: "hello" }
      });
      void responsePromise.catch(() => undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(synthesizeSpeech).not.toHaveBeenCalled();
      expectDisconnectListenersCleaned(request);
    } finally {
      await app.close();
    }
  });

  for (const event of ["aborted", "socket-close"] as const) {
    it(`aborts pending TTS on ${event} and cleans up listeners`, async () => {
      const started = deferred<void>();
      let signal: AbortSignal | undefined;
      const synthesizeSpeech = vi.fn<TestTTSSynthesizer>(async (_input, options) => {
        signal = options?.signal;
        started.resolve();
        if (!signal) {
          throw new Error("TTS route did not provide a canonical signal.");
        }
        return new Promise<TTSOutput>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(cancelledTTSError("unknown")), {
            once: true
          });
        });
      });
      const { app, request } = await createTTSLifecycleApp(synthesizeSpeech);

      try {
        const responsePromise = app.inject({
          method: "POST",
          url: "/v1/tts",
          payload: { text: "hello" }
        });
        await started.promise;
        emitDisconnect(request, event);

        expect(signal?.aborted).toBe(true);
        const response = await responsePromise;
        expect(response.statusCode).toBe(503);
        expect(response.body).not.toContain("audioBase64");
        expectDisconnectListenersCleaned(request);
      } finally {
        await app.close();
      }
    });
  }

  it("does not treat normal request-body close as cancellation", async () => {
    const started = deferred<void>();
    const finish = deferred<TTSOutput>();
    let signal: AbortSignal | undefined;
    const synthesizeSpeech = vi.fn<TestTTSSynthesizer>(async (_input, options) => {
      signal = options?.signal;
      started.resolve();
      return finish.promise;
    });
    const { app, request } = await createTTSLifecycleApp(synthesizeSpeech);

    try {
      const responsePromise = app.inject({
        method: "POST",
        url: "/v1/tts",
        payload: { text: "hello" }
      });
      await started.promise;
      request.raw?.emit("close");
      expect(signal?.aborted).toBe(false);
      finish.resolve(speechOutput());

      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
      expectDisconnectListenersCleaned(request);
    } finally {
      await app.close();
    }
  });

  it("rejects a late provider result after request disconnect without serializing success", async () => {
    const started = deferred<void>();
    const finish = deferred<TTSOutput>();
    let signal: AbortSignal | undefined;
    const synthesizeSpeech = vi.fn<TestTTSSynthesizer>(async (_input, options) => {
      signal = options?.signal;
      started.resolve();
      return finish.promise;
    });
    const { app, request } = await createTTSLifecycleApp(synthesizeSpeech);

    try {
      const responsePromise = app.inject({
        method: "POST",
        url: "/v1/tts",
        payload: { text: "hello" }
      });
      await started.promise;
      request.raw?.emit("aborted");
      expect(signal?.aborted).toBe(true);
      finish.resolve(speechOutput());

      const response = await responsePromise;
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("audioBase64");
      expectDisconnectListenersCleaned(request);
    } finally {
      await app.close();
    }
  });

  it("cleans TTS disconnect listeners after provider failure", async () => {
    const synthesizeSpeech = vi.fn<TestTTSSynthesizer>(async () => {
      throw new Error("synthetic TTS failure");
    });
    const { app, request } = await createTTSLifecycleApp(synthesizeSpeech);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tts",
        payload: { text: "hello" }
      });

      expect(response.statusCode).toBe(503);
      expectDisconnectListenersCleaned(request);
    } finally {
      await app.close();
    }
  });
});
