import { describe, expect, it, vi } from "vitest";
import { ProviderErrorCode } from "../types/errors.js";
import { GPTSoVITSTTSProvider } from "./GPTSoVITSTTSProvider.js";

const options = {
  wrapperBaseUrl: "http://127.0.0.1:9881",
  upstreamBaseUrl: "http://127.0.0.1:9880",
  model: "alice-v4",
  referenceAudioPath: "D:/alice.wav",
  referenceText: "reference",
  referenceLanguage: "ja"
};

describe("GPTSoVITSTTSProvider", () => {
  it("uses the managed wrapper for Japanese text", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "audio/wav" }
      })
    );
    const output = await new GPTSoVITSTTSProvider(options).synthesizeSpeech({ text: "はい。" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9881/tts",
      expect.objectContaining({ method: "POST" })
    );
    expect(output.audio).toEqual(new Uint8Array([1, 2, 3]));
    fetchMock.mockRestore();
  });

  it("preserves wrapper WAV compatibility and normalizes MIME parameters", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "Audio/WAV; codecs=1" }
      })
    );

    const output = await new GPTSoVITSTTSProvider(options).synthesizeSpeech({
      text: "はい。",
      format: "wav"
    });
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<
      string,
      unknown
    >;

    expect(requestBody).toMatchObject({ text: "はい。", language: "ja" });
    expect(requestBody).not.toHaveProperty("format");
    expect(output).toMatchObject({
      mimeType: "audio/wav",
      audio: new Uint8Array([1, 2, 3]),
      audioBuffer: new Uint8Array([1, 2, 3]),
      audioBase64: "AQID"
    });
    expect(new Uint8Array(Buffer.from(output.audioBase64 ?? "", "base64"))).toEqual(output.audio);
    fetchMock.mockRestore();
  });

  it("uses api_v2 with the Japanese reference for English text", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([4, 5]), {
        status: 200,
        headers: { "content-type": "audio/wav" }
      })
    );
    await new GPTSoVITSTTSProvider(options).synthesizeSpeech({
      text: "Hello.",
      metadata: { language: "en" }
    });
    const request = fetchMock.mock.calls[0]?.[1];
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:9880/tts");
    expect(JSON.parse(String(request?.body))).toMatchObject({
      text_lang: "en",
      prompt_lang: "ja",
      ref_audio_path: "D:/alice.wav",
      prompt_text: "reference"
    });
    // English must never be forced through the Japanese-only wrapper.
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("9881");
    fetchMock.mockRestore();
  });

  it("maps API-v2 PCM and speed to the upstream full-buffer request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([4, 5]), {
        status: 200,
        headers: { "content-type": "Audio/RAW; charset=binary" }
      })
    );

    const output = await new GPTSoVITSTTSProvider(options).synthesizeSpeech({
      text: "Hello.",
      format: "pcm",
      speed: 0.9,
      metadata: { language: "en" }
    });
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<
      string,
      unknown
    >;

    expect(requestBody).toMatchObject({
      media_type: "raw",
      streaming_mode: false,
      speed_factor: 0.9
    });
    expect(output.mimeType).toBe("audio/raw");
    expect(output.audioBase64).toBe("BAU=");
    fetchMock.mockRestore();
  });

  it.each(["mp3", "opus", "mulaw", "alaw"] as const)(
    "rejects unsupported API-v2 format %s instead of substituting WAV",
    async (format) => {
      const fetchMock = vi.spyOn(globalThis, "fetch");

      await expect(
        new GPTSoVITSTTSProvider(options).synthesizeSpeech({
          text: "Hello.",
          format,
          metadata: { language: "en" }
        })
      ).rejects.toMatchObject({
        code: ProviderErrorCode.UnsupportedInput,
        retryable: false,
        effectState: "not_started"
      });
      expect(fetchMock).not.toHaveBeenCalled();
      fetchMock.mockRestore();
    }
  );

  it("rejects unsupported wrapper formats instead of substituting WAV", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(
      new GPTSoVITSTTSProvider(options).synthesizeSpeech({ text: "はい。", format: "mp3" })
    ).rejects.toMatchObject({
      code: ProviderErrorCode.UnsupportedInput,
      retryable: false,
      effectState: "not_started"
    });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("rejects wrapper speed because the managed wrapper has no speed field", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(
      new GPTSoVITSTTSProvider(options).synthesizeSpeech({ text: "はい。", speed: 1.1 })
    ).rejects.toMatchObject({
      code: ProviderErrorCode.UnsupportedInput,
      retryable: false,
      effectState: "not_started"
    });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("does not mark English synthesis as Japanese", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([4, 5]), {
        status: 200,
        headers: { "content-type": "audio/wav" }
      })
    );
    const output = await new GPTSoVITSTTSProvider(options).synthesizeSpeech({
      text: "Hello.",
      metadata: { language: "en" }
    });
    expect(output.providerMetadata).toMatchObject({
      language: "en",
      transport: "api_v2"
    });
    fetchMock.mockRestore();
  });

  it("uses the managed wrapper for non-Japanese text when no API-v2 reference is configured", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([6, 7]), {
        status: 200,
        headers: { "content-type": "audio/wav" }
      })
    );
    const output = await new GPTSoVITSTTSProvider({
      ...options,
      referenceAudioPath: undefined,
      referenceText: undefined
    }).synthesizeSpeech({
      text: "你好。",
      metadata: { language: "zh" }
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:9881/tts");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      language: "ja",
      text: "你好。"
    });
    expect(output.providerMetadata).toMatchObject({
      language: "zh",
      transport: "wrapper-fallback"
    });
    fetchMock.mockRestore();
  });

  it("maps an aborted request to CANCELLED without leaking the upstream error", async () => {
    const controller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        })
    );
    const promise = new GPTSoVITSTTSProvider(options).synthesizeSpeech({
      text: "はい。",
      signal: controller.signal
    });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: ProviderErrorCode.Cancelled });
    fetchMock.mockRestore();
  });

  it("redacts local filesystem paths from upstream errors", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          message: "failed to read D:\\AI\\GPT-SoVITS\\GPT_weights_v4\\alice.ckpt"
        }),
        {
          status: 500,
          headers: { "content-type": "application/json" }
        }
      )
    );
    await expect(
      new GPTSoVITSTTSProvider(options).synthesizeSpeech({
        text: "Hello.",
        metadata: { language: "en" }
      })
    ).rejects.toMatchObject({
      message: expect.not.stringContaining("D:\\AI\\GPT-SoVITS")
    });
    fetchMock.mockRestore();
  });
});
