import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../context.js";
import { registerMediaRoutes } from "./media.js";

const routeCases = ["/v1/audio/transcriptions", "/v1/voice/message"] as const;

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
