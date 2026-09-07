import { describe, it, expect, vi } from "vitest";
import { LumiPresentationMotion } from "./lumi-presentation-motion.js";
import {
  LUMI_PRESENTATION_CALIBRATION as C,
  LUMI_EXPRESSION_PROFILES,
  type LumiExpression
} from "./lumi-presentation-calibration.js";
import {
  LumiController,
  LumiPresentationController,
  type LumiPresenceAnimation
} from "./lumi-live2d.js";
import { createInitialCompanionPresence } from "./companion-presence.js";
import { composeLumiMotionTransform } from "./lumi-cubism-model.js";
import { computeLumiFramingTransform } from "./lumi-framing.js";

const request = (id = "effect-a", intent: LumiExpression = "excited", at = 1, turn = "turn-a") => ({
  version: "embodied-presentation-request-7ad.v1" as const,
  effectId: id,
  behavior: {
    version: "embodied-behavior-7b.v1" as const,
    behavior: {
      version: "embodied-behavior-7a.v1" as const,
      kind: "EXPRESSION" as const,
      cause: { kind: "character" as const, reference: "proposal-a" },
      intent
    },
    sourceInstance: { reference: "proposal-a", createdAtMs: at },
    correlation: { kind: "turn" as const, reference: turn }
  }
});
function sample(
  motion: LumiPresentationMotion,
  end = 2000,
  state: "idle" | "speaking" | "interrupted" = "idle",
  start = 0
) {
  const frames: LumiPresenceAnimation[] = [];
  for (let now = start; now <= end; now += 16)
    frames.push(motion.sample({ blink: 0.3, eyeBallX: 0.7, headAngleX: 12 }, state, now, 16));
  return frames;
}
describe("Campaign F composed Presentation", () => {
  it.each(Object.keys(LUMI_EXPRESSION_PROFILES) as LumiExpression[])(
    "renders %s with bounded pose/gaze and completes once after settling",
    (intent) => {
      const report = vi.fn();
      const motion = new LumiPresentationMotion(report);
      motion.replace(request("a", intent), intent, 0);
      const frames = sample(motion, 10000);
      for (const f of frames) {
        expect(Math.abs(f.translateX!)).toBeLessThanOrEqual(C.maxX);
        expect(Math.abs(f.translateY!)).toBeLessThanOrEqual(C.maxY);
        expect(Math.abs(f.headAngleX!)).toBeLessThanOrEqual(C.headAngle);
        expect(Math.abs(f.bodyAngleZ!)).toBeLessThanOrEqual(C.bodyAngle);
        expect(f.eyeBallX).toBe(0.7);
        expect(f.blink).toBe(0.3);
      }
      expect(frames.at(-1)?.mouthForm).toBe(0);
      expect(report).toHaveBeenCalledOnce();
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ effectId: "a", outcome: "COMPLETED" })
      );
    }
  );
  it("has clearly visible HIGH X sway and Y bounce while speech and smile coexist", () => {
    const motion = new LumiPresentationMotion();
    motion.replace(request(), "excited", 0);
    const frames = sample(motion, 2200, "speaking");
    expect(
      Math.max(...frames.map((f) => f.translateX!)) - Math.min(...frames.map((f) => f.translateX!))
    ).toBeGreaterThan(0.08);
    expect(Math.max(...frames.map((f) => f.translateY!))).toBeGreaterThan(0.025);
    expect(Math.max(...frames.map((f) => f.mouthForm!))).toBeGreaterThan(0.9);
    expect(frames.every((f) => !("mouthOpen" in f))).toBe(true);
    expect(C.intensity.high).toBeGreaterThan(1);
  });
  it("repeated peaks never accumulate and settle back to the same idle trajectory", () => {
    const motion = new LumiPresentationMotion();
    for (let i = 0; i < 100; i++) {
      motion.replace(request(`effect-${i}`), "excited", i * 500);
      sample(motion, i * 500 + 496, "idle", i * 500);
    }
    const actual = sample(motion, 70000, "idle", 50000).at(-1)!;
    const baseline = sample(new LumiPresentationMotion(), 70000, "idle", 50000).at(-1)!;
    expect(actual.translateX).toBeCloseTo(baseline.translateX!, 6);
    expect(actual.translateY).toBeCloseTo(baseline.translateY!, 6);
    expect(actual.mouthForm).toBe(0);
  });
  it("replacement and interruption cannot complete or restore the old effect", () => {
    const report = vi.fn();
    const motion = new LumiPresentationMotion(report);
    motion.replace(request("a"), "excited", 0);
    sample(motion);
    motion.replace(request("b", "thinking"), "thinking", 2000);
    sample(motion, 2500, "idle", 2000);
    const stopped = sample(motion, 4000, "interrupted", 2500).at(-1)!;
    expect(Math.abs(stopped.translateX!)).toBeLessThan(0.0001);
    expect(Math.abs(stopped.translateY!)).toBeLessThan(0.0001);
    sample(motion, 15000, "idle", 4000);
    expect(report.mock.calls.map((c) => [c[0].effectId, c[0].outcome])).toEqual([
      ["a", "INTERRUPTED"],
      ["b", "INTERRUPTED"]
    ]);
  });
  it("translation clamps finite values and does not mutate or compound the framing transform", () => {
    const base = computeLumiFramingTransform("half", 320, 420, 2, 3);
    const original = { ...base };
    for (let i = 0; i < 1000; i++) {
      const f = composeLumiMotionTransform(base, 999, -999);
      expect(f.translateX).toBeCloseTo(base.translateX * C.headroomScale + C.maxX);
      expect(f.translateY).toBeCloseTo(base.translateY * C.headroomScale - C.maxY);
    }
    expect(base).toEqual(original);
    expect(composeLumiMotionTransform(base, NaN, Infinity).translateX).toBeCloseTo(
      base.translateX * C.headroomScale
    );
  });
  it("hide/show and a suspended frame reset blink/gaze/offsets and fence a disposed callback", () => {
    let now = 0;
    let hidden = false;
    let callback: (now: number) => void = () => {};
    const apply = vi.fn();
    const report = vi.fn();
    const controller = new LumiPresentationController(
      apply,
      {
        now: () => now,
        random: () => 0.5,
        requestFrame: (cb) => {
          callback = cb;
          return 1;
        },
        cancelFrame: vi.fn(),
        isHidden: () => hidden
      },
      report
    );
    controller.start();
    controller.setExpression(request(), "excited");
    for (now = 0; now < 800; now += 16) callback(now);
    hidden = true;
    callback(now);
    expect(apply).toHaveBeenLastCalledWith(
      expect.objectContaining({ blink: 0, translateX: 0, translateY: 0, mouthForm: 0, eyeBallX: 0 })
    );
    hidden = false;
    now = 10000;
    callback(now);
    expect(apply.mock.calls.at(-1)?.[0].translateY).toBe(0);
    const late = callback;
    controller.dispose();
    const count = apply.mock.calls.length;
    late(20000);
    expect(apply).toHaveBeenCalledTimes(count);
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ outcome: "INTERRUPTED" }));
  });
  it("uses turn/effect identity for duplicate, stale, foreign, cancelled and unmounted requests", async () => {
    const adapter = {
      load: vi.fn(async () => {}),
      setMouthOpen: vi.fn(),
      setMouthForm: vi.fn(),
      setParameter: vi.fn(),
      setBreath: vi.fn(),
      setFraming: vi.fn(),
      resetMouth: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn()
    };
    const report = vi.fn();
    const controller = new LumiController(
      () => adapter,
      "model",
      undefined,
      undefined,
      undefined,
      report
    );
    await controller.load();
    const projection = {
      ...createInitialCompanionPresence(),
      epoch: "turn-a",
      lifecycle: "active" as const
    };
    controller.setPresentationProjection(projection);
    expect(controller.executeEmbodiedPresentationRequest(request("a", "excited", 2)).outcome).toBe(
      "STARTED"
    );
    expect(controller.executeEmbodiedPresentationRequest(request("a", "excited", 2)).outcome).toBe(
      "STARTED"
    );
    expect(report).not.toHaveBeenCalled();
    expect(controller.executeEmbodiedPresentationRequest(request("old", "amused", 1)).outcome).toBe(
      "REJECTED"
    );
    expect(
      controller.executeEmbodiedPresentationRequest(request("foreign", "amused", 3, "other"))
        .outcome
    ).toBe("REJECTED");
    expect(controller.executeEmbodiedPresentationRequest(request("b", "amused", 3)).outcome).toBe(
      "STARTED"
    );
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({ effectId: "a", outcome: "INTERRUPTED" })
    );
    controller.setPresentationProjection({ ...projection, transition: "interrupted" });
    expect(controller.executeEmbodiedPresentationRequest(request("c", "amused", 4)).outcome).toBe(
      "REJECTED"
    );
    expect(controller.executeEmbodiedPresentationRequest(request("a", "excited", 2)).outcome).toBe(
      "INTERRUPTED"
    );
    controller.setPresentationProjection({
      ...projection,
      speech: "cancelled",
      transition: "none"
    });
    expect(
      controller.executeEmbodiedPresentationRequest(request("late-after-reset", "excited", 100))
        .outcome
    ).toBe("REJECTED");
    controller.dispose();
    expect(controller.executeEmbodiedPresentationRequest(request()).outcome).toBe("REJECTED");
    expect(adapter.dispose).toHaveBeenCalledOnce();
  });
});

it("gaze and expression coexist, recenter and report completion; external gaze replaces admitted gaze", () => {
  let now = 0;
  let callback: (now: number) => void = () => {};
  const apply = vi.fn();
  const report = vi.fn();
  const controller = new LumiPresentationController(
    apply,
    {
      now: () => now,
      random: () => 0.5,
      requestFrame: (cb) => {
        callback = cb;
        return 1;
      },
      cancelFrame: vi.fn(),
      isHidden: () => false
    },
    report
  );
  controller.start();
  const gaze = {
    ...request("gaze"),
    behavior: {
      ...request().behavior,
      behavior: {
        version: "embodied-behavior-7a.v1" as const,
        kind: "GAZE" as const,
        cause: request().behavior.behavior.cause,
        target: "away-right" as const,
        strength: 2 as const
      }
    }
  };
  controller.setSemanticGaze(gaze, { x: 0.65, y: 0.2, strength: 2 });
  controller.setExpression(request(), "soft-smile");
  for (now = 0; now < 1000; now += 16) callback(now);
  expect(apply.mock.calls.at(-1)?.[0].mouthForm).toBeGreaterThan(0.9);
  expect(controller.getDebug().gaze.targetX).toBeGreaterThan(0.5);
  for (; now < 10000; now += 16) callback(now);
  expect(report).toHaveBeenCalledWith(
    expect.objectContaining({ effectId: "gaze", outcome: "COMPLETED" })
  );
  controller.setSemanticGaze({ ...gaze, effectId: "gaze-2" }, { x: -0.65, y: 0, strength: 2 });
  controller.setGazeTarget(null);
  expect(report).toHaveBeenLastCalledWith(
    expect.objectContaining({ effectId: "gaze-2", outcome: "INTERRUPTED" })
  );
  controller.dispose();
});

it("speaking start/end changes body motion without restarting or clearing expression", () => {
  const active = new LumiPresentationMotion();
  const idle = new LumiPresentationMotion();
  active.replace(request(), "soft-smile", 0);
  idle.replace(request(), "soft-smile", 0);
  sample(active, 1000);
  sample(idle, 1000);
  const speaking = sample(active, 2500, "speaking", 1000).at(-1)!;
  const quiet = sample(idle, 2500, "idle", 1000).at(-1)!;
  expect(speaking.mouthForm).toBe(quiet.mouthForm);
  expect(speaking.translateX).not.toBeCloseTo(quiet.translateX!, 3);
  const ended = sample(active, 12000, "idle", 2500).at(-1)!;
  const baseline = sample(idle, 12000, "idle", 2500).at(-1)!;
  expect(ended).toEqual(baseline);
});
