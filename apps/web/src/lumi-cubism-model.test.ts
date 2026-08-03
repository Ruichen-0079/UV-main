import { describe, expect, it } from "vitest";
import {
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
});
