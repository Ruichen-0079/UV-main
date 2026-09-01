import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalSTTProvider } from "./LocalSTTProvider.js";
import { ProviderErrorCode } from "../types/errors.js";

afterEach(() => vi.unstubAllGlobals());

describe("LocalSTTProvider", () => {
  it("requires audio input before contacting the sidecar", async () => {
    const provider = new LocalSTTProvider({ baseUrl: "http://127.0.0.1:65534", model: "sense-voice" });
    await expect(provider.transcribeAudio({})).rejects.toMatchObject({
      code: ProviderErrorCode.UnsupportedInput
    });
  });

  it("maps transcription and excludes raw embedding fields", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          text: "你好 hello",
          language: "zh",
          latencyMs: 12,
          identity: { identity: "KNOWN", speakerId: "ruichen" },
          embedding: [0.1, 0.2]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new LocalSTTProvider({ baseUrl: "http://127.0.0.1:9876", model: "sense-voice" });
    const output = await provider.transcribeAudio({
      audioBase64: Buffer.from("RIFF").toString("base64"),
      metadata: { identify: true }
    });
    expect(output.text).toBe("你好 hello");
    expect(output.providerMetadata?.["identity"]).toBe("KNOWN");
    expect(JSON.stringify(output)).not.toContain("0.1");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9876/transcribe",
      expect.objectContaining({ method: "POST" })
    );
  });
});
