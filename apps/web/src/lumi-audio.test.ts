import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioMouthEnvelope, type MouthParameterTarget } from "./lumi-audio.js";

type FakeSource = {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

type FakeAnalyser = {
  fftSize: number;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  getByteTimeDomainData: ReturnType<typeof vi.fn>;
};

function createAudioContext() {
  const sources = new Map<HTMLAudioElement, FakeSource>();
  const analysers: FakeAnalyser[] = [];
  const context = {
    state: "suspended",
    destination: {},
    createMediaElementSource: vi.fn((audio: HTMLAudioElement) => {
      const source = sources.get(audio) ?? {
        connect: vi.fn(),
        disconnect: vi.fn()
      };
      sources.set(audio, source);
      return source;
    }),
    createAnalyser: vi.fn(() => {
      const analyser: FakeAnalyser = {
        fftSize: 0,
        connect: vi.fn(),
        disconnect: vi.fn(),
        getByteTimeDomainData: vi.fn((samples: Uint8Array) => samples.fill(164))
      };
      analysers.push(analyser);
      return analyser;
    }),
    resume: vi.fn(async () => {
      context.state = "running";
    }),
    close: vi.fn(async () => {
      context.state = "closed";
    })
  };
  return { context, sources, analysers };
}

function createTarget(): MouthParameterTarget & { mouthValues: number[] } {
  const mouthValues: number[] = [];
  return {
    mouthValues,
    setMouthOpen: (value) => mouthValues.push(value),
    setMouthForm: vi.fn(),
    resetMouth: vi.fn(() => mouthValues.push(0))
  };
}

describe("AudioMouthEnvelope playback binding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("binds the analyser when playback starts and samples the same audio element", async () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    vi.stubGlobal("window", {});
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      callbacks.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
    const { context, sources, analysers } = createAudioContext();
    const target = createTarget();
    const envelope = new AudioMouthEnvelope(target, undefined, () => context);
    const audio = {} as HTMLAudioElement;

    envelope.attach(audio);
    expect(context.createMediaElementSource).not.toHaveBeenCalled();
    expect(analysers[0]!.connect).not.toHaveBeenCalled();
    expect(callbacks.size).toBe(0);

    envelope.startPlayback?.(audio);
    await Promise.resolve();
    await Promise.resolve();
    expect(context.resume).toHaveBeenCalled();
    expect(context.createMediaElementSource).toHaveBeenCalledWith(audio);
    expect(sources.get(audio)?.connect).toHaveBeenCalledWith(analysers[0]);
    expect(analysers[0]!.connect).toHaveBeenCalledWith(context.destination);
    expect(callbacks.size).toBe(1);
    const frame = callbacks.keys().next().value as number;
    callbacks.get(frame)?.(16);
    expect(target.mouthValues.at(-1)).toBeGreaterThan(0);
  });

  it("does not recreate a source for the same Audio and disconnects old sources", async () => {
    vi.stubGlobal("window", {});
    const { context, sources, analysers } = createAudioContext();
    const target = createTarget();
    const envelope = new AudioMouthEnvelope(target, undefined, () => context);
    const firstAudio = {} as HTMLAudioElement;
    const secondAudio = {} as HTMLAudioElement;

    envelope.attach(firstAudio);
    envelope.startPlayback?.(firstAudio);
    await Promise.resolve();
    await Promise.resolve();
    envelope.detach();
    envelope.attach(firstAudio);
    envelope.startPlayback?.(firstAudio);
    await Promise.resolve();
    await Promise.resolve();
    envelope.attach(secondAudio);
    envelope.startPlayback?.(secondAudio);
    await Promise.resolve();
    await Promise.resolve();

    expect(context.createMediaElementSource).toHaveBeenCalledTimes(2);
    expect(sources.get(firstAudio)?.disconnect).toHaveBeenCalled();
    expect(sources.get(secondAudio)?.connect).toHaveBeenCalledWith(analysers[0]);
  });

  it("stops the RAF and resets the mouth when playback stops or is disposed", async () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    vi.stubGlobal("window", {});
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      callbacks.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
    const { context } = createAudioContext();
    const target = createTarget();
    const envelope = new AudioMouthEnvelope(target, undefined, () => context);
    const audio = {} as HTMLAudioElement;
    envelope.attach(audio);
    envelope.startPlayback?.(audio);
    await Promise.resolve();
    await Promise.resolve();
    expect(callbacks.size).toBe(1);
    envelope.stop();
    expect(callbacks.size).toBe(0);
    expect(target.resetMouth).toHaveBeenCalled();
    expect(target.mouthValues.at(-1)).toBe(0);
    envelope.dispose();
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("does not start an old Audio after a newer segment is attached", async () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    vi.stubGlobal("window", {});
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.set(callbacks.size + 1, callback);
      return callbacks.size;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
    const { context } = createAudioContext();
    const target = createTarget();
    const envelope = new AudioMouthEnvelope(target, undefined, () => context);
    const firstAudio = {} as HTMLAudioElement;
    const secondAudio = {} as HTMLAudioElement;

    envelope.attach(firstAudio);
    envelope.attach(secondAudio);
    envelope.startPlayback?.(firstAudio);
    await Promise.resolve();
    expect(callbacks.size).toBe(0);
    envelope.startPlayback?.(secondAudio);
    await Promise.resolve();
    await Promise.resolve();
    expect(callbacks.size).toBe(1);
  });
});
