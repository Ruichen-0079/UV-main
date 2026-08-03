import { describe, expect, it, vi } from "vitest";
import {
  applyYuviParametersThenUpdate,
  getLumiFramingZoom,
  getLumiRenderMetrics,
  LUMI_DEVICE_PIXEL_RATIO_CAP
} from "./lumi-cubism-model.js";

describe("Lumi render sizing", () => {
  it("keeps CSS dimensions while using a capped high-resolution backing store", () => {
    expect(getLumiRenderMetrics(281, 420, 1.5)).toEqual({
      cssWidth: 281,
      cssHeight: 420,
      devicePixelRatio: 1.5,
      pixelWidth: 422,
      pixelHeight: 630
    });
  });

  it("caps very dense displays at the configured DPR limit", () => {
    const metrics = getLumiRenderMetrics(320, 480, 4);
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
});
