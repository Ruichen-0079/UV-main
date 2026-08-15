import { describe, expect, it, vi } from "vitest";
import { gatedEnvelope, rmsFromTimeDomain, smoothMouthEnvelope } from "./lumi-audio.js";
import {
  LUMI_PRESENCE_PARAMETER_MAP,
  LumiController,
  lumiMapping,
  reducePresence
} from "./lumi-live2d.js";

const playbackSegment = { requestId: "turn-a", sequence: 0 };
const nextPlaybackSegment = { requestId: "turn-a", sequence: 1 };

describe("Lumi presence and audio envelope", () => {
  it("keeps the presence lifecycle tied to real playback", () => {
    expect(reducePresence("idle", { type: "user-sent" })).toBe("thinking");
    expect(reducePresence("thinking", { type: "playback-started" })).toBe("speaking");
    expect(reducePresence("speaking", { type: "playback-ended" })).toBe("idle");
    expect(reducePresence("speaking", { type: "interrupted" })).toBe("interrupted");
    expect(reducePresence("unavailable", { type: "user-sent" })).toBe("unavailable");
  });

  it("gates noise and clamps mouth values to Lumi's parameter range", () => {
    const config = { noiseGate: 0.02, gain: 10, attack: 0.04, release: 0.12, maxValue: 2.1 };
    expect(rmsFromTimeDomain(new Uint8Array([128, 128, 128]))).toBe(0);
    expect(gatedEnvelope(0.01, config)).toBe(0);
    expect(gatedEnvelope(0.1, config)).toBeGreaterThan(0);
    expect(gatedEnvelope(1, config)).toBe(lumiMapping.mouthOpen.max);
    expect(smoothMouthEnvelope(0, 2.1, 1, config)).toBeCloseTo(2.1);
    expect(smoothMouthEnvelope(2.1, 0, 1, config)).toBeCloseTo(0);
  });

  it("does not require optional parameters to exist on a target", () => {
    const target = {
      setParameter: vi.fn(),
      setMouthOpen: vi.fn(),
      setMouthForm: vi.fn(),
      resetMouth: vi.fn()
    };
    target.setMouthOpen(0);
    target.setMouthForm(0);
    expect(target.setMouthOpen).toHaveBeenCalledWith(0);
    expect(target.setMouthForm).toHaveBeenCalledWith(0);
  });

  it("enters speaking only after playbackStarted and closes on stop", async () => {
    const adapter = {
      load: vi.fn(async () => undefined),
      setMouthOpen: vi.fn(),
      setMouthForm: vi.fn(),
      setParameter: vi.fn(),
      setBreath: vi.fn(),
      setFraming: vi.fn(),
      resetMouth: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn()
    };
    const envelope = {
      attach: vi.fn(),
      startPlayback: vi.fn(),
      detach: vi.fn(),
      stop: vi.fn(),
      dispose: vi.fn()
    };
    const states: string[] = [];
    const controller = new LumiController(
      () => adapter,
      "model3.json",
      (state) => states.push(state),
      () => envelope
    );
    await controller.load();
    const audio = {} as HTMLAudioElement;
    controller.handlePlaybackEvent({
      type: "audioElementAttached",
      sequence: 0,
      segment: playbackSegment,
      audio
    });
    expect(controller.getPresence()).toBe("idle");
    controller.handlePlaybackEvent({
      type: "playbackStarted",
      sequence: 0,
      segment: playbackSegment,
      audio
    });
    expect(controller.getPresence()).toBe("speaking");
    expect(envelope.attach).toHaveBeenCalledWith(audio);
    expect(envelope.startPlayback).toHaveBeenCalledWith(audio);
    controller.handlePlaybackEvent({
      type: "playbackStopped",
      sequence: 0,
      segment: playbackSegment,
      audio
    });
    expect(envelope.stop).toHaveBeenCalled();
    expect(controller.getPresence()).toBe("idle");
    expect(states).toContain("interrupted");
  });

  it("does not let text completion override an active audio mouth", async () => {
    const adapter = {
      load: vi.fn(async () => undefined),
      setMouthOpen: vi.fn(),
      setMouthForm: vi.fn(),
      setParameter: vi.fn(),
      setBreath: vi.fn(),
      setFraming: vi.fn(),
      resetMouth: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn()
    };
    const envelope = { attach: vi.fn(), detach: vi.fn(), stop: vi.fn(), dispose: vi.fn() };
    const controller = new LumiController(() => adapter, "model3.json", undefined, () => envelope);
    await controller.load();
    const audio = {} as HTMLAudioElement;
    controller.handlePlaybackEvent({
      type: "playbackStarted",
      sequence: 0,
      segment: playbackSegment,
      audio
    });
    adapter.resetMouth.mockClear();
    controller.setPresence("idle");
    expect(controller.getPresence()).toBe("speaking");
    expect(adapter.resetMouth).not.toHaveBeenCalled();
    controller.handlePlaybackEvent({
      type: "playbackEnded",
      sequence: 0,
      segment: playbackSegment,
      audio
    });
    expect(controller.getPresence()).toBe("idle");
    controller.handlePlaybackEvent({
      type: "audioElementDetached",
      sequence: 0,
      segment: playbackSegment,
      audio
    });
    expect(envelope.detach).toHaveBeenCalledTimes(1);
  });

  it("does not let an old segment detach a newer active analyser", async () => {
    const adapter = {
      load: vi.fn(async () => undefined),
      setMouthOpen: vi.fn(),
      setMouthForm: vi.fn(),
      setParameter: vi.fn(),
      setBreath: vi.fn(),
      setFraming: vi.fn(),
      resetMouth: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn()
    };
    const envelope = {
      attach: vi.fn(),
      startPlayback: vi.fn(),
      detach: vi.fn(),
      stop: vi.fn(),
      dispose: vi.fn()
    };
    const controller = new LumiController(
      () => adapter,
      "model3.json",
      undefined,
      () => envelope
    );
    await controller.load();
    const firstAudio = {} as HTMLAudioElement;
    const secondAudio = {} as HTMLAudioElement;

    controller.handlePlaybackEvent({
      type: "audioElementAttached",
      sequence: 0,
      segment: playbackSegment,
      audio: firstAudio
    });
    controller.handlePlaybackEvent({
      type: "playbackStarted",
      sequence: 0,
      segment: playbackSegment,
      audio: firstAudio
    });
    controller.handlePlaybackEvent({
      type: "playbackEnded",
      sequence: 0,
      segment: playbackSegment,
      audio: firstAudio
    });
    const detachCountAfterFirst = envelope.detach.mock.calls.length;
    controller.handlePlaybackEvent({
      type: "audioElementAttached",
      sequence: 1,
      segment: nextPlaybackSegment,
      audio: secondAudio
    });
    controller.handlePlaybackEvent({
      type: "playbackStarted",
      sequence: 1,
      segment: nextPlaybackSegment,
      audio: secondAudio
    });
    controller.handlePlaybackEvent({
      type: "audioElementDetached",
      sequence: 0,
      segment: playbackSegment,
      audio: firstAudio
    });

    expect(envelope.detach).toHaveBeenCalledTimes(detachCountAfterFirst);
    expect(controller.getPresence()).toBe("speaking");
  });

  it("keeps speaking mouth ownership with RMS while presence animates eyes and breath", async () => {
    const adapter = {
      load: vi.fn(async () => undefined),
      setMouthOpen: vi.fn(),
      setMouthForm: vi.fn(),
      setParameter: vi.fn(),
      setBreath: vi.fn(),
      setFraming: vi.fn(),
      resetMouth: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn()
    };
    const controller = new LumiController(() => adapter, "model3.json");
    await controller.load();
    adapter.setParameter.mockClear();
    adapter.setMouthOpen.mockClear();
    adapter.setBreath.mockClear();

    controller.setPresence("speaking");
    controller.setPresenceAnimation(0.7, 0.2);

    expect(adapter.setParameter.mock.calls[0]?.[0]).toBe(lumiMapping.eyeLeft);
    expect(adapter.setParameter.mock.calls[0]?.[1]).toBeCloseTo(0.3);
    expect(adapter.setParameter.mock.calls[1]?.[0]).toBe(lumiMapping.eyeRight);
    expect(adapter.setParameter.mock.calls[1]?.[1]).toBeCloseTo(0.3);
    expect(adapter.setBreath).toHaveBeenCalledWith(0.2);
    expect(adapter.setMouthOpen).not.toHaveBeenCalled();
  });

  it("keeps gaze/head ownership separate from blink, breath and RMS mouth", async () => {
    const adapter = {
      load: vi.fn(async () => undefined),
      setMouthOpen: vi.fn(),
      setMouthForm: vi.fn(),
      setParameter: vi.fn(),
      setBreath: vi.fn(),
      setFraming: vi.fn(),
      resetMouth: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn()
    };
    const controller = new LumiController(() => adapter, "model3.json");
    await controller.load();
    adapter.setParameter.mockClear();
    adapter.setMouthOpen.mockClear();
    controller.setPresenceAnimation({
      blink: 0.2,
      breath: 0.3,
      eyeBallX: 0.25,
      eyeBallY: -0.1,
      headAngleX: 4,
      headAngleY: -2,
      headAngleZ: 1
    });
    expect(adapter.setParameter.mock.calls.map(([id]) => id)).toEqual([
      lumiMapping.eyeLeft,
      lumiMapping.eyeRight,
      LUMI_PRESENCE_PARAMETER_MAP.eyeBallX.id,
      LUMI_PRESENCE_PARAMETER_MAP.eyeBallY.id,
      LUMI_PRESENCE_PARAMETER_MAP.headAngleX.id,
      LUMI_PRESENCE_PARAMETER_MAP.headAngleY.id,
      LUMI_PRESENCE_PARAMETER_MAP.headAngleZ.id
    ]);
    expect(adapter.setMouthOpen).not.toHaveBeenCalled();
  });

  it("clamps presence-owned gaze and head values to the centralized ranges", async () => {
    const adapter = {
      load: vi.fn(async () => undefined),
      setMouthOpen: vi.fn(),
      setMouthForm: vi.fn(),
      setParameter: vi.fn(),
      setBreath: vi.fn(),
      setFraming: vi.fn(),
      resetMouth: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn()
    };
    const controller = new LumiController(() => adapter, "model3.json");
    await controller.load();
    adapter.setParameter.mockClear();
    controller.setPresenceAnimation({ eyeBallX: 9, eyeBallY: -9, headAngleX: 99 });
    expect(adapter.setParameter).toHaveBeenCalledWith(
      LUMI_PRESENCE_PARAMETER_MAP.eyeBallX.id,
      LUMI_PRESENCE_PARAMETER_MAP.eyeBallX.max
    );
    expect(adapter.setParameter).toHaveBeenCalledWith(
      LUMI_PRESENCE_PARAMETER_MAP.eyeBallY.id,
      LUMI_PRESENCE_PARAMETER_MAP.eyeBallY.min
    );
    expect(adapter.setParameter).toHaveBeenCalledWith(
      LUMI_PRESENCE_PARAMETER_MAP.headAngleX.id,
      LUMI_PRESENCE_PARAMETER_MAP.headAngleX.max
    );
  });

  it("skips optional gaze channels when the loaded model does not expose them", async () => {
    const adapter = {
      load: vi.fn(async () => undefined),
      setMouthOpen: vi.fn(),
      setMouthForm: vi.fn(),
      setParameter: vi.fn(),
      getParameterInfo: vi.fn(() => undefined),
      setBreath: vi.fn(),
      setFraming: vi.fn(),
      resetMouth: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn()
    };
    const controller = new LumiController(() => adapter, "model3.json");
    await controller.load();
    adapter.setParameter.mockClear();
    controller.setPresenceAnimation({ eyeBallX: 0.2, headAngleX: 3 });
    expect(adapter.setParameter).not.toHaveBeenCalledWith(
      LUMI_PRESENCE_PARAMETER_MAP.eyeBallX.id,
      expect.anything()
    );
    expect(adapter.setParameter).not.toHaveBeenCalledWith(
      LUMI_PRESENCE_PARAMETER_MAP.headAngleX.id,
      expect.anything()
    );
  });

  it("does not write presence parameters after the controller is disposed", async () => {
    const adapter = {
      load: vi.fn(async () => undefined),
      setMouthOpen: vi.fn(),
      setMouthForm: vi.fn(),
      setParameter: vi.fn(),
      setBreath: vi.fn(),
      setFraming: vi.fn(),
      resetMouth: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn()
    };
    const controller = new LumiController(() => adapter, "model3.json");
    await controller.load();
    controller.dispose();
    adapter.setParameter.mockClear();
    adapter.setBreath.mockClear();
    controller.setPresenceAnimation(1, 0.2);
    expect(adapter.setParameter).not.toHaveBeenCalled();
    expect(adapter.setBreath).not.toHaveBeenCalled();
  });

  it("runs the controlled mouth range and restores zero", async () => {
    vi.useFakeTimers();
    try {
      const adapter = {
        load: vi.fn(async () => undefined),
        setMouthOpen: vi.fn(),
        setMouthForm: vi.fn(),
        setParameter: vi.fn(),
        setBreath: vi.fn(),
        setFraming: vi.fn(),
        resetMouth: vi.fn(),
        resize: vi.fn(),
        dispose: vi.fn()
      };
      const controller = new LumiController(
        () => adapter,
        "model3.json",
        undefined,
        () => ({ attach: vi.fn(), detach: vi.fn(), stop: vi.fn(), dispose: vi.fn() })
      );
      await controller.load();
      const calibration = controller.runMouthCalibration();
      await vi.advanceTimersByTimeAsync(2800);
      await calibration;
      expect(adapter.setMouthOpen).toHaveBeenLastCalledWith(0);
      expect(adapter.setMouthOpen.mock.calls.slice(-4).map(([value]) => value)).toEqual([0, 1, 2.1, 0]);
      expect(adapter.resetMouth).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a model failure unavailable without affecting its caller", async () => {
    const adapter = {
      load: vi.fn(async () => {
        throw new Error("model missing");
      }),
      setMouthOpen: vi.fn(),
      setMouthForm: vi.fn(),
      setParameter: vi.fn(),
      setBreath: vi.fn(),
      setFraming: vi.fn(),
      resetMouth: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn()
    };
    const controller = new LumiController(() => adapter, "model3.json");
    await controller.load();
    expect(controller.getPresence()).toBe("unavailable");
    expect(adapter.dispose).toHaveBeenCalledTimes(1);
  });
});
