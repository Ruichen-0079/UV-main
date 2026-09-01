import { afterEach, describe, expect, it, vi } from "vitest";
import {
  releaseMicrophoneCapture,
  resolveAudioRecordingMimeType,
  startMicrophoneCapture,
  stopMicrophoneCapture
} from "./audio-capture.js";

class FakeTrack {
  stopped = false;

  stop(): void {
    this.stopped = true;
  }
}

class FakeStream {
  constructor(readonly tracks: FakeTrack[]) {}

  getTracks(): FakeTrack[] {
    return this.tracks;
  }
}

class FakeAudioContext {
  async decodeAudioData(): Promise<AudioBuffer> {
    const samples = new Float32Array([0, 0.5, -0.5, 1]);
    return {
      length: samples.length,
      numberOfChannels: 1,
      sampleRate: 16_000,
      getChannelData: () => samples
    } as unknown as AudioBuffer;
  }

  async close(): Promise<void> {}
}

class FakeMediaRecorder extends EventTarget {
  static isTypeSupported(mimeType: string): boolean {
    return mimeType === "audio/webm;codecs=opus";
  }

  state: RecordingState = "inactive";
  readonly mimeType: string;

  constructor(
    private readonly stream: FakeStream,
    options?: MediaRecorderOptions
  ) {
    super();
    this.mimeType = options?.mimeType ?? "audio/webm";
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    const data = new Event("dataavailable");
    Object.defineProperty(data, "data", {
      value: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType })
    });
    this.dispatchEvent(data);
    this.dispatchEvent(new Event("stop"));
    void this.stream;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("microphone capture", () => {
  it("selects the first browser-supported recording format", () => {
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    expect(resolveAudioRecordingMimeType()).toBe("audio/webm;codecs=opus");
  });

  it("records browser audio, encodes it, and releases the microphone", async () => {
    const track = new FakeTrack();
    const stream = new FakeStream([track]);
    const getUserMedia = vi.fn(async () => stream as unknown as MediaStream);
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    const capture = await startMicrophoneCapture();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(track.stopped).toBe(false);

    const recording = await stopMicrophoneCapture(capture);

    expect(recording).toMatchObject({
      mimeType: "audio/wav"
    });
    const wav = Uint8Array.from(atob(recording.audioBase64), (character) =>
      character.charCodeAt(0)
    );
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(recording.durationMs).toBeGreaterThanOrEqual(0);
    expect(track.stopped).toBe(true);
  });

  it("releases an active capture during page cleanup", async () => {
    const track = new FakeTrack();
    const stream = new FakeStream([track]);
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(async () => stream as unknown as MediaStream) }
    });

    const capture = await startMicrophoneCapture();
    releaseMicrophoneCapture(capture);

    expect(track.stopped).toBe(true);
  });
});
