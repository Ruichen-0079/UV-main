import { describe, expect, it, vi } from "vitest";
import { startLiveSpeechCapture, type LiveSpeechFrame } from "./live-speech-capture.js";

describe("live speech capture", () => {
  it("opens the microphone and posts PCM frames for one captureEpoch", async () => {
    const tracks = [
      {
        stop: vi.fn(),
        getSettings: () => ({
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false
        })
      }
    ];
    const stream = { getTracks: () => tracks, getAudioTracks: () => tracks };
    const getUserMedia = vi.fn(async () => stream as unknown as MediaStream);
    const processor = {
      onaudioprocess: null as null | ((event: unknown) => void),
      connect: vi.fn(),
      disconnect: vi.fn()
    };
    const source = {
      connect: vi.fn(),
      disconnect: vi.fn()
    };
    const gain = {
      gain: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn()
    };
    const context = {
      destination: {},
      createMediaStreamSource: vi.fn(() => source),
      createScriptProcessor: vi.fn(() => processor),
      createGain: vi.fn(() => gain),
      close: vi.fn(async () => undefined)
    };
    const postFrame = vi.fn(async (_frame: LiveSpeechFrame) => ({ speechActive: true }));

    const capture = await startLiveSpeechCapture({
      sessionId: "s",
      postFrame,
      createId: () => "epoch-live",
      getUserMedia,
      createAudioContext: () => context as unknown as AudioContext
    });

    expect(capture.captureEpoch).toBe("epoch-live");
    expect(capture.trackSettings).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false
    });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    expect(source.connect).toHaveBeenCalled();
    expect(processor.connect).toHaveBeenCalledWith(gain);
    expect(gain.connect).toHaveBeenCalledWith(context.destination);
    expect(gain.gain.value).toBe(0);
    expect(typeof processor.onaudioprocess).toBe("function");

    const samples = new Float32Array(128);
    samples[0] = 0.5;
    processor.onaudioprocess?.({
      inputBuffer: {
        getChannelData: () => samples,
        sampleRate: 48_000
      }
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(postFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s",
        captureEpoch: "epoch-live",
        sampleRate: 16_000
      })
    );
    const firstPayload = postFrame.mock.calls[0]?.[0];
    expect(firstPayload).toBeDefined();
    expect(firstPayload!.pcmBase64.length).toBeGreaterThan(0);

    await capture.stop();
    expect(tracks[0]?.stop).toHaveBeenCalled();
    expect(context.close).toHaveBeenCalled();
  });
});
