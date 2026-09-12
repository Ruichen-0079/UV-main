import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioMouthEnvelope, type MouthParameterTarget } from "./lumi-audio.js";

vi.mock("./speech-queue.js", () => ({ getSpeechAudioData: () => new ArrayBuffer(44) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const decoded = {
  sampleRate: 48000,
  length: 48000,
  numberOfChannels: 1,
  getChannelData: () => new Float32Array(48000).fill(0.2)
} as unknown as AudioBuffer;

function audio() {
  return { currentTime: 0.1, volume: 1, paused: false, ended: false, muted: false, readyState: 4 } as HTMLAudioElement;
}

describe("AudioMouthEnvelope passive playback observation", () => {
  let frames: Map<number, FrameRequestCallback>;
  let target: MouthParameterTarget;
  let form: number;
  let open: number;
  beforeEach(() => {
    frames = new Map();
    let next = 1;
    vi.stubGlobal("window", {});
    vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => {
      const id = next++; frames.set(id, frame); return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    form = 0.6; open = 0;
    target = {
      setMouthOpen: vi.fn((value: number) => { open = value; }),
      setMouthForm: vi.fn((value: number) => { form = value; }),
      resetMouth: vi.fn(() => { open = 0; form = 0; })
    };
  });
  afterEach(() => vi.unstubAllGlobals());
  function frame() {
    const entry = frames.entries().next().value;
    expect(entry).toBeDefined();
    const [id, callback] = entry!;
    frames.delete(id); callback(16);
  }
  function make() {
    const decode = deferred<AudioBuffer>();
    // These forbidden operations are traps: analysis has no right to route audio.
    const decoder = {
      decodeAudioData: vi.fn(() => decode.promise),
      createMediaElementSource: vi.fn(() => { throw new Error("must never route playback"); }),
      close: vi.fn(() => { throw new Error("must never close playback"); })
    };
    const envelope = new AudioMouthEnvelope(target, undefined, () => decoder);
    return { envelope, decode, decoder };
  }

  it("drives only OpenY after real playback starts, preserving expression-owned Form", async () => {
    const { envelope, decode, decoder } = make(); const element = audio();
    envelope.attach(element); decode.resolve(decoded); await Promise.resolve();
    expect(frames.size).toBe(0);
    envelope.startPlayback(element); frame();
    expect(open).toBeGreaterThan(0); expect(form).toBe(0.6);
    envelope.stop(); expect(open).toBe(0); expect(frames.size).toBe(0);
    envelope.dispose();
    expect(target.setMouthForm).not.toHaveBeenCalled();
    expect(target.resetMouth).not.toHaveBeenCalled();
    expect(decoder.createMediaElementSource).not.toHaveBeenCalled();
    expect(decoder.close).not.toHaveBeenCalled();
  });

  it("uses the media clock, not elapsed wall time or synthesis state", async () => {
    const { envelope, decode } = make(); const element = audio();
    const data = new Float32Array(48000); data.fill(0.2, 0, 12000);
    envelope.attach(element); decode.resolve({ ...decoded, getChannelData: () => data } as AudioBuffer);
    await Promise.resolve(); envelope.startPlayback(element); frame(); expect(open).toBeGreaterThan(0);
    envelope.stop(); element.currentTime = 0.8; envelope.startPlayback(element); frame(); expect(open).toBe(0);
  });

  it.each(["stop", "detach", "dispose"] as const)("late decoding cannot revive speech after %s", async (terminal) => {
    const { envelope, decode } = make(); const element = audio();
    envelope.attach(element); envelope.startPlayback(element); envelope[terminal]();
    decode.resolve(decoded); await Promise.resolve();
    expect(frames.size).toBe(0); expect(open).toBe(0); expect(form).toBe(0.6);
  });

  it("ignores old decode results and old start events after replacement", async () => {
    const first = deferred<AudioBuffer>(), second = deferred<AudioBuffer>();
    const decoder = { decodeAudioData: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise) };
    const envelope = new AudioMouthEnvelope(target, undefined, () => decoder);
    const a = audio(), b = audio(); envelope.attach(a); envelope.startPlayback(a); envelope.attach(b);
    first.resolve(decoded); await Promise.resolve(); envelope.startPlayback(a); expect(frames.size).toBe(0);
    second.resolve(decoded); await Promise.resolve(); expect(frames.size).toBe(0);
    envelope.startPlayback(b); frame(); expect(open).toBeGreaterThan(0);
  });

  it.each(["paused", "ended", "muted"] as const)("closes immediately when media is %s", async (property) => {
    const { envelope, decode } = make(); const element = audio();
    envelope.attach(element); decode.resolve(decoded); await Promise.resolve(); envelope.startPlayback(element); frame();
    Object.assign(element, { [property]: true }); frame(); expect(open).toBe(0);
  });

  it("decoder rejection loses only lip-sync", async () => {
    const { envelope, decode } = make(); const element = Object.freeze(audio());
    envelope.attach(element); envelope.startPlayback(element); decode.reject(new Error("unsupported codec"));
    await Promise.resolve(); expect(frames.size).toBe(0); expect(open).toBe(0);
    expect(element.paused).toBe(false); expect(element.currentTime).toBe(0.1);
  });

  it("a hanging offline decode never routes, pauses, or seeks audible playback", async () => {
    const { envelope, decoder } = make();
    const element = Object.freeze(audio());
    envelope.attach(element);
    envelope.startPlayback(element);
    await Promise.resolve();
    expect(frames.size).toBe(0);
    expect(open).toBe(0);
    expect(form).toBe(0.6);
    expect(element.paused).toBe(false);
    expect(element.ended).toBe(false);
    expect(element.currentTime).toBe(0.1);
    expect(decoder.createMediaElementSource).not.toHaveBeenCalled();
    expect(decoder.close).not.toHaveBeenCalled();
    envelope.dispose();
    expect(open).toBe(0);
  });

  it("visibility cannot start a mouth before playback or after its terminal event", async () => {
    let visible!: () => void;
    vi.stubGlobal("document", { hidden: false, addEventListener: (_: string, handler: () => void) => { visible = handler; }, removeEventListener: vi.fn() });
    const { envelope, decode } = make(); const element = audio();
    envelope.attach(element); decode.resolve(decoded); await Promise.resolve(); visible(); expect(frames.size).toBe(0);
    envelope.startPlayback(element); frame(); envelope.stop(); visible(); expect(frames.size).toBe(0); expect(open).toBe(0);
  });
});
