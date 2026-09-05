import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalSTTProvider } from "./LocalSTTProvider.js";
import { ProviderErrorCode } from "../types/errors.js";

afterEach(() => vi.unstubAllGlobals());

const BASE_URL = "http://127.0.0.1:9876";

function sidecarResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

async function transcribeWithSidecar(
  body: Record<string, unknown>,
  requestMetadata?: Record<string, unknown>
) {
  const fetchMock = vi.fn(async () => sidecarResponse(body));
  vi.stubGlobal("fetch", fetchMock);
  const provider = new LocalSTTProvider({ baseUrl: BASE_URL, model: "sense-voice" });
  const output = await provider.transcribeAudio({
    audioBase64: Buffer.from("RIFF").toString("base64"),
    ...requestMetadata
  });
  return { output, fetchMock };
}

describe("LocalSTTProvider", () => {
  it("posts PCM frames to the sidecar Silero VAD endpoint", async () => {
    const fetchMock = vi.fn(async () => sidecarResponse({ active: true, captureEpoch: "epoch-1" }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new LocalSTTProvider({ baseUrl: BASE_URL, model: "sense-voice" });
    const output = await provider.detectVoiceActivity({
      captureEpoch: "epoch-1",
      pcmBase64: "AAEC",
      sampleRate: 16000
    });
    expect(output).toEqual({ active: true, captureEpoch: "epoch-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9876/vad",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("requires audio input before contacting the sidecar", async () => {
    const provider = new LocalSTTProvider({
      baseUrl: "http://127.0.0.1:65534",
      model: "sense-voice"
    });
    await expect(provider.transcribeAudio({})).rejects.toMatchObject({
      code: ProviderErrorCode.UnsupportedInput
    });
  });

  it("normalizes diarization spans into typed speaker-aware segments", async () => {
    const { output } = await transcribeWithSidecar({
      text: "你好 hello",
      language: "zh",
      latencyMs: 12,
      segments: [
        { startMs: 0, endMs: 1500, speaker: "0" },
        { startMs: 1600, endMs: 3100, speaker: "1" }
      ]
    });

    expect(output.observationId).toEqual(expect.any(String));
    expect(output.segments).toHaveLength(2);
    const [first, second] = output.segments ?? [];
    expect(first).toMatchObject({ startMs: 0, endMs: 1500, speakerClusterId: "0" });
    expect(second).toMatchObject({ startMs: 1600, endMs: 3100, speakerClusterId: "1" });
    // Diarization spans carry time + cluster evidence; they have no per-span
    // transcript of their own.
    expect(first?.text).toBeUndefined();
    expect(second?.text).toBeUndefined();
    expect(first?.segmentId).toEqual(expect.any(String));
    expect(second?.segmentId).toEqual(expect.any(String));
    expect(first?.segmentId).not.toBe(second?.segmentId);
  });

  it("keeps providerMetadata free of semantic speaker contracts", async () => {
    const { output } = await transcribeWithSidecar({
      text: "hello",
      language: "en",
      identity: { identity: "KNOWN", speakerId: "ruichen", score: 0.9 },
      segments: [{ startMs: 0, endMs: 900, speaker: "0" }],
      embedding: [0.1, 0.2]
    });

    expect(output.providerMetadata).toEqual({ device: "cpu" });
    const serialized = JSON.stringify(output);
    // No raw sidecar DTO, no acoustic template match result, no raw embedding
    // vector may leak as semantic metadata.
    expect(serialized).not.toContain("diarization");
    expect(serialized).not.toContain('"identity"');
    expect(serialized).not.toContain("speakerId");
    expect(serialized).not.toContain("ruichen");
    expect(serialized).not.toContain("0.1");
  });

  it("never presents a cluster label or template match as person identity", async () => {
    const { output } = await transcribeWithSidecar({
      text: "two speakers",
      language: "en",
      identity: { identity: "KNOWN", speakerId: "ruichen", score: 0.93 },
      segments: [
        { startMs: 0, endMs: 1000, speaker: "0" },
        { startMs: 1100, endMs: 2600, speaker: "0" }
      ]
    });

    // Cluster labels stay verbatim capture-local diarization evidence; nothing
    // in the output names a person or a voice profile.
    for (const segment of output.segments ?? []) {
      expect(segment.speakerClusterId).toBe("0");
    }
    expect(output).not.toHaveProperty("personId");
    expect(output).not.toHaveProperty("identity");
    expect(output).not.toHaveProperty("voiceProfileId");
  });

  it("gives two identical transcripts distinct observation identity", async () => {
    const sidecarBody = { text: "same words", language: "en", latencyMs: 5 };
    const first = await transcribeWithSidecar(sidecarBody);
    const second = await transcribeWithSidecar(sidecarBody);

    expect(first.output.text).toBe(second.output.text);
    expect(first.output.observationId).toEqual(expect.any(String));
    expect(second.output.observationId).toEqual(expect.any(String));
    expect(first.output.observationId).not.toBe(second.output.observationId);
  });

  it("omits segments when the sidecar reports no diarization", async () => {
    const { output } = await transcribeWithSidecar({ text: "solo speech", language: "en" });

    expect(output.segments).toBeUndefined();
    expect(output.observationId).toEqual(expect.any(String));
  });
});
