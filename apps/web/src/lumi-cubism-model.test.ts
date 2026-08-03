import { describe, expect, it, vi } from "vitest";
import {
  applyYuviParameters,
  applyYuviParametersThenUpdate,
  getLumiFramingZoom,
  getLumiRenderMetrics,
  LUMI_DEVICE_PIXEL_RATIO_CAP,
  runYuviCubismParameterFrame
} from "./lumi-cubism-model.js";

describe("Lumi render sizing", () => {
  it("keeps CSS dimensions while using a capped high-resolution backing store", () => {
    // Explicit renderScale=1 matches the historical pixel math (CSS * DPR).
    expect(getLumiRenderMetrics(281, 420, 1.5, 1)).toEqual({
      cssWidth: 281,
      cssHeight: 420,
      devicePixelRatio: 1.5,
      renderScale: 1,
      pixelWidth: 422,
      pixelHeight: 630
    });
  });

  it("applies balanced canvasRenderScale on top of capped DPR by default", () => {
    const metrics = getLumiRenderMetrics(320, 480, 1);
    expect(metrics.renderScale).toBe(1.25);
    expect(metrics.pixelWidth).toBe(Math.round(320 * 1 * 1.25));
    expect(metrics.pixelHeight).toBe(Math.round(480 * 1 * 1.25));
  });

  it("caps very dense displays at the configured DPR limit", () => {
    const metrics = getLumiRenderMetrics(320, 480, 4, 1);
    expect(metrics.devicePixelRatio).toBe(LUMI_DEVICE_PIXEL_RATIO_CAP);
    expect(metrics.pixelWidth).toBe(640);
    expect(metrics.pixelHeight).toBe(960);
  });

  it("uses a closer default half-body framing without changing model assets", () => {
    expect(getLumiFramingZoom("half")).toBeGreaterThan(getLumiFramingZoom("full"));
  });

  it("writes YUVI eye values before Cubism update so the same-frame mesh uses them", () => {
    const order: string[] = [];
    const values = new Map<string, number>();
    const coreModel = {
      update: vi.fn(() => {
        order.push("update");
        // Simulate Core baking whatever is currently in the parameter map.
        values.set("bakedEye", values.get("ParamEyeLOpen") ?? -1);
      }),
      setParameterValueById: (id: unknown, value: number) => {
        order.push(`set:${String(id)}`);
        values.set(String(id), value);
      }
    };
    applyYuviParametersThenUpdate(
      coreModel,
      (id) => id,
      new Map([["ParamEyeLOpen", 0.05]])
    );
    expect(order).toEqual(["set:ParamEyeLOpen", "update"]);
    expect(values.get("ParamEyeLOpen")).toBe(0.05);
    expect(values.get("bakedEye")).toBe(0.05);
    expect(coreModel.update).toHaveBeenCalledOnce();
  });

  it("applies gaze/head pending before physics so physics inputs are non-zero this frame", () => {
    const order: string[] = [];
    const values = new Map<string, number>();
    const coreModel = {
      loadParameters: vi.fn(() => {
        order.push("load");
        values.clear();
      }),
      update: vi.fn(() => {
        order.push("update");
        values.set("bakedEyeBall", values.get("ParamEyeBallX") ?? -1);
        values.set("bakedAngle", values.get("ParamAngleX") ?? -1);
      }),
      setParameterValueById: (id: unknown, value: number) => {
        order.push(`set:${String(id)}=${value}`);
        values.set(String(id), value);
      }
    };
    const evaluatePhysics = vi.fn(() => {
      order.push("physics");
      // Physics reads ParamEyeBallX as an input; record what it saw.
      values.set("physicsSawEyeBall", values.get("ParamEyeBallX") ?? -1);
      values.set("physicsSawAngle", values.get("ParamAngleX") ?? -1);
      // Secondary output channel used by Lumi.
      values.set("ParamEyeBallPhysicsX", (values.get("ParamEyeBallX") ?? 0) * 0.5);
    });
    runYuviCubismParameterFrame(
      coreModel,
      (id) => id,
      new Map([
        ["ParamEyeBallX", 1],
        ["ParamAngleX", 20]
      ]),
      evaluatePhysics
    );
    expect(order[0]).toBe("load");
    expect(order).toContain("physics");
    expect(order.at(-1)).toBe("update");
    // Physics must observe the forced values from the pre-physics apply.
    expect(values.get("physicsSawEyeBall")).toBe(1);
    expect(values.get("physicsSawAngle")).toBe(20);
    // Final bake still has the YUVI-owned values.
    expect(values.get("bakedEyeBall")).toBe(1);
    expect(values.get("bakedAngle")).toBe(20);
    // Pending is applied both before and after physics.
    expect(order.filter((step) => step.startsWith("set:ParamEyeBallX")).length).toBe(2);
  });

  it("can stage parameters without immediately updating the mesh", () => {
    const coreModel = {
      update: vi.fn(),
      setParameterValueById: vi.fn()
    };
    applyYuviParameters(coreModel, (id) => id, new Map([["ParamAngleY", 10]]));
    expect(coreModel.setParameterValueById).toHaveBeenCalledWith("ParamAngleY", 10);
    expect(coreModel.update).not.toHaveBeenCalled();
  });
});
