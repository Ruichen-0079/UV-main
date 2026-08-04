import { describe, expect, it } from "vitest";
import {
  clampMaskFeatherTexels,
  clampRenderScale,
  getLive2dRenderQuality,
  getLumiRenderMetrics,
  LIVE2D_RENDER_QUALITY,
  LIVE2D_RENDER_QUALITY_PROFILES,
  LIVE2D_RENDER_QUALITY_SAFE,
  LIVE2D_WEBGL_CONTEXT_ATTRIBUTES,
  LUMI_DEVICE_PIXEL_RATIO_CAP,
  readFirstGlError,
  readWebglContextAttributes,
  resolveLive2dRenderQualityProfile,
  resolveMaskBufferSize,
  resolveMsaaSamples
} from "./lumi-render-quality.js";
import { createFitMatrixFromTransform } from "./lumi-cubism-model.js";
import { computeLumiFramingTransform } from "./lumi-framing.js";

describe("Live2D render quality config", () => {
  it("requests transparent premultiplied WebGL with antialias", () => {
    expect(LIVE2D_WEBGL_CONTEXT_ATTRIBUTES).toMatchObject({
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false
    });
  });

  it("defaults to balanced profile values in one place", () => {
    expect(LIVE2D_RENDER_QUALITY).toEqual(LIVE2D_RENDER_QUALITY_PROFILES.balanced);
    expect(LIVE2D_RENDER_QUALITY.canvasRenderScale).toBe(1.25);
    expect(LIVE2D_RENDER_QUALITY.maskScale).toBe(2);
    expect(LIVE2D_RENDER_QUALITY.preferredMsaaSamples).toBe(4);
    expect(LIVE2D_RENDER_QUALITY.maskFeatherTexels).toBe(0.75);
    expect(getLive2dRenderQuality("high").canvasRenderScale).toBe(1.5);
    expect(getLive2dRenderQuality("high").maskScale).toBe(4);
    expect(resolveLive2dRenderQualityProfile()).toBe("balanced");
  });

  it("exposes a visibility-first SAFE baseline (scale 1 / mask 1)", () => {
    expect(LIVE2D_RENDER_QUALITY_SAFE.canvasRenderScale).toBe(1);
    expect(LIVE2D_RENDER_QUALITY_SAFE.maskScale).toBe(1);
    expect(resolveMaskBufferSize(256, LIVE2D_RENDER_QUALITY_SAFE.maskScale, 8192)).toBe(256);
  });

  it("maps gl.getError codes without throwing on a stub context", () => {
    let calls = 0;
    const gl = {
      NO_ERROR: 0,
      INVALID_OPERATION: 0x0502,
      INVALID_ENUM: 0x0500,
      INVALID_VALUE: 0x0501,
      OUT_OF_MEMORY: 0x0505,
      CONTEXT_LOST_WEBGL: 0x9242,
      getError: () => {
        calls += 1;
        return calls === 1 ? 0x0502 : 0;
      }
    } as unknown as WebGLRenderingContext;
    expect(readFirstGlError(gl)).toBe("INVALID_OPERATION");
    expect(readFirstGlError(null)).toBeNull();
  });

  it("clamps feather and renderScale to safe ranges", () => {
    expect(clampMaskFeatherTexels(-1)).toBe(0);
    expect(clampMaskFeatherTexels(0.75)).toBe(0.75);
    expect(clampMaskFeatherTexels(9)).toBe(2);
    expect(clampRenderScale(0.5)).toBe(1);
    expect(clampRenderScale(1.25)).toBe(1.25);
    expect(clampRenderScale(3)).toBe(2);
  });
});

describe("backing store metrics", () => {
  it("keeps CSS dimensions while applying capped DPR and renderScale", () => {
    const metrics = getLumiRenderMetrics(281, 420, 1.5, 1.25);
    expect(metrics).toEqual({
      cssWidth: 281,
      cssHeight: 420,
      devicePixelRatio: 1.5,
      renderScale: 1.25,
      pixelWidth: Math.round(281 * 1.5 * 1.25),
      pixelHeight: Math.round(420 * 1.5 * 1.25)
    });
    expect(metrics.pixelWidth).toBeGreaterThan(metrics.cssWidth * metrics.devicePixelRatio);
  });

  it("caps very dense displays at the configured DPR limit", () => {
    const metrics = getLumiRenderMetrics(320, 480, 4, 1);
    expect(metrics.devicePixelRatio).toBe(LUMI_DEVICE_PIXEL_RATIO_CAP);
    expect(metrics.pixelWidth).toBe(640);
    expect(metrics.pixelHeight).toBe(960);
  });

  it("does not feed renderScale into the model matrix (CSS framing only)", () => {
    const metrics = getLumiRenderMetrics(400, 600, 2, 1.5);
    const transform = computeLumiFramingTransform("half", metrics.cssWidth, metrics.cssHeight, 2, 2);
    // Fake CubismMatrix44-compatible runtime for scale/translate assigns.
    class FakeMatrix {
      m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      scale(x: number, y: number) {
        this.m[0] = x;
        this.m[5] = y;
      }
      translate(x: number, y: number) {
        this.m[12] = x;
        this.m[13] = y;
      }
    }
    const runtime = { CubismMatrix44: FakeMatrix } as never;
    const matrix = createFitMatrixFromTransform(runtime, transform) as FakeMatrix;
    // NDC scale comes from CSS fit only — backing pixels are larger by dpr*renderScale.
    const scaleX = matrix.m[0] ?? 0;
    expect(Math.abs(scaleX)).toBeCloseTo(Math.abs(transform.ndcScaleX), 6);
    expect(metrics.pixelWidth / metrics.cssWidth).toBeCloseTo(2 * 1.5, 5);
    expect(metrics.pixelWidth / metrics.cssWidth).not.toBeCloseTo(1, 3);
  });
});

describe("mask buffer sizing", () => {
  it("scales the official base size and clamps to max texture size", () => {
    expect(resolveMaskBufferSize(256, 2, 8192)).toBe(512);
    expect(resolveMaskBufferSize(256, 4, 8192)).toBe(1024);
    expect(resolveMaskBufferSize(256, 4, 512)).toBe(512);
    // maskScale is floored at 1 so we never undersize the official base.
    expect(resolveMaskBufferSize(256, 0.5, 4096)).toBe(256);
  });

  it("keeps a minimum size and rejects non-finite max texture", () => {
    expect(resolveMaskBufferSize(256, 2, Number.NaN)).toBe(512);
    expect(resolveMaskBufferSize(16, 1, 4096)).toBe(64);
  });

  it("resolves MSAA samples with graceful zero fallback", () => {
    expect(resolveMsaaSamples(4, 8)).toBe(4);
    expect(resolveMsaaSamples(4, 2)).toBe(2);
    expect(resolveMsaaSamples(4, 1)).toBe(0);
    expect(resolveMsaaSamples(4, null)).toBe(0);
    expect(resolveMsaaSamples(1, 8)).toBe(0);
  });
});

describe("WebGL attribute reader", () => {
  it("returns nulls without a context", () => {
    expect(readWebglContextAttributes(null).webglVersion).toBeNull();
    expect(readWebglContextAttributes(null).antialias).toBeNull();
  });

  it("reads attributes from a stub context", () => {
    const gl = {
      getContextAttributes: () => ({
        alpha: true,
        antialias: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false
      }),
      getParameter: (pname: number) => {
        if (pname === 0x0d33) return 8192; // MAX_TEXTURE_SIZE
        return 0;
      },
      MAX_TEXTURE_SIZE: 0x0d33,
      MAX_SAMPLES: 0x8d57
    } as unknown as WebGLRenderingContext;
    const info = readWebglContextAttributes(gl);
    expect(info.antialias).toBe(false);
    expect(info.alpha).toBe(true);
    expect(info.premultipliedAlpha).toBe(true);
    expect(info.maxTextureSize).toBe(8192);
  });
});
