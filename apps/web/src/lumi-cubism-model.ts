import { type CubismFrameworkRuntime, loadCubismFramework } from "./cubism-framework.js";
import {
  buildFramingDiagnostics,
  computeLumiFramingTransform,
  LUMI_FULL_BODY_FIT,
  LUMI_PORTRAIT_HEAD_BOUNDS,
  LUMI_PORTRAIT_MARGINS,
  sameFitKey,
  type LumiFitCacheKey,
  type LumiFramingDiagnostics,
  type LumiFramingMode,
  type LumiUniformTransform
} from "./lumi-framing.js";
import {
  clampMaskFeatherTexels,
  createLumiWebgl2Context,
  getLive2dRenderQuality,
  getLumiRenderMetrics,
  LIVE2D_RENDER_QUALITY_SAFE,
  LUMI_DEVICE_PIXEL_RATIO_CAP,
  readFirstGlError,
  readWebglContextAttributes,
  resolveLive2dRenderQualityProfile,
  resolveMaskBufferSize,
  resolveMsaaSamples,
  type Live2dRenderQualityConfig,
  type Live2dRenderQualityDiagnostics
} from "./lumi-render-quality.js";

export {
  getLumiRenderMetrics,
  LUMI_DEVICE_PIXEL_RATIO_CAP,
  LIVE2D_RENDER_QUALITY,
  LIVE2D_RENDER_QUALITY_PROFILES,
  LIVE2D_RENDER_QUALITY_SAFE,
  LIVE2D_WEBGL_CONTEXT_ATTRIBUTES,
  getLive2dRenderQuality,
  resolveMaskBufferSize,
  resolveMsaaSamples,
  clampMaskFeatherTexels,
  readWebglContextAttributes,
  createLumiWebgl2Context,
  readFirstGlError
} from "./lumi-render-quality.js";

const shaderDirectory = "/cubism-shaders/";

export type LumiFraming = LumiFramingMode;

/**
 * Legacy zoom helper used by older tests. Portrait no longer uses a fixed
 * zoom — head-safe fit computes a uniform pixel scale instead.
 */
export function getLumiFramingZoom(framing: LumiFraming): number {
  return framing === "half" ? 3.35 : LUMI_FULL_BODY_FIT;
}

type CubismModel = {
  loadParameters(): void;
  saveParameters(): void;
  update(): void;
  getParameterIndex(id: unknown): number;
  getParameterMinimumValue?(parameterIndex: number): number;
  getParameterMaximumValue?(parameterIndex: number): number;
  getParameterDefaultValue?(parameterIndex: number): number;
  getParameterValueById?(id: unknown): number;
  getParameterValueByIndex?(parameterIndex: number): number;
  setParameterValueById(id: unknown, value: number, weight?: number): void;
  getCanvasWidth(): number;
  getCanvasHeight(): number;
};

type CubismRenderer = {
  startUp(gl: WebGL2RenderingContext): void;
  loadShaders(path: string): void;
  bindTexture(index: number, texture: WebGLTexture): void;
  setIsPremultipliedAlpha(value: boolean): void;
  setRenderState(framebuffer: WebGLFramebuffer | null, viewport: number[]): void;
  setMvpMatrix(matrix: unknown): void;
  drawModel(shaderPath: string): void;
  release(): void;
  /** Official Cubism API: square clipping-mask buffer edge length in texels. */
  setClippingMaskBufferSize?(size: number): void;
  getClippingMaskBufferSize?(): number;
};

type UserModel = {
  loadModel(buffer: ArrayBuffer, shouldCheckMocConsistency?: boolean): void;
  loadPhysics(buffer: ArrayBuffer, size: number): void;
  getModel(): CubismModel;
  createRenderer(width: number, height: number, maskBufferCount?: number): void;
  getRenderer(): CubismRenderer;
  release(): void;
  _physics?: { evaluate(model: CubismModel, delta: number): void };
};

export type LumiCubismModel = {
  readonly parameterIds: ReadonlySet<string>;
  readonly parameterInfo: ReadonlyMap<string, LumiParameterInfo>;
  setParameter(id: string, value: number): void;
  /** Development/diagnostics: last value staged for the next Core update. */
  getPendingParameter(id: string): number | undefined;
  getParameterInfo?(id: string): LumiParameterInfo | undefined;
  /** Live Cubism core value (post set, pre or post update depending on call site). */
  getCoreParameterValue?(id: string): number | undefined;
  /** Snapshot of values applied immediately before the last coreModel.update(). */
  getLastPreUpdateParameters?(): Readonly<Record<string, number>>;
  setFraming(framing: LumiFraming): void;
  getFraming(): LumiFraming;
  resize(width: number, height: number): void;
  render(deltaSeconds: number): void;
  dispose(): void;
  /** Last computed framing transform (null before first render). */
  getFramingTransform(): LumiUniformTransform | null;
  /** Development-only projection diagnostics. */
  getFramingDiagnostics(): LumiFramingDiagnostics | null;
  /** Live2D WebGL quality diagnostics (AA / mask supersampling). */
  getRenderQualityDiagnostics(): Live2dRenderQualityDiagnostics;
};

export type LumiParameterInfo = {
  id: string;
  min: number;
  max: number;
  defaultValue: number;
};

/**
 * Write YUVI-owned parameters onto the Core model without baking the mesh.
 *
 * Physics inputs such as ParamEyeBallX / ParamAngle* must be present **before**
 * physics.evaluate(); final authority values (mouth, eye open, gaze, head) are
 * re-applied after physics and before update().
 */
export function applyYuviParameters(
  coreModel: Pick<CubismModel, "setParameterValueById">,
  getId: (id: string) => unknown,
  pending: ReadonlyMap<string, number>
): void {
  for (const [id, value] of pending) {
    coreModel.setParameterValueById(getId(id), value);
  }
}

/**
 * Apply YUVI-owned parameters, then run Cubism Core update so the same-frame
 * draw uses those values. Core `update()` bakes current parameter values into
 * drawable vertices; writing after update leaves the mesh on the previous
 * values and the next `loadParameters()` wipes the pending override.
 */
export function applyYuviParametersThenUpdate(
  coreModel: Pick<CubismModel, "update" | "setParameterValueById">,
  getId: (id: string) => unknown,
  pending: ReadonlyMap<string, number>
): void {
  applyYuviParameters(coreModel, getId, pending);
  coreModel.update();
}

/** @deprecated Use applyYuviParametersThenUpdate. Kept name only for migration. */
export const updateAndApplyFinalCubismParameters = applyYuviParametersThenUpdate;

/**
 * Official YUVI frame parameter order for models whose physics takes gaze/head
 * as inputs (Lumi: ParamEyeBallX → ParamEyeBallPhysicsX, ParamAngle* → body).
 *
 * 1. loadParameters — restore baseline
 * 2. apply pending — physics inputs available this frame
 * 3. physics.evaluate — secondary outputs (hair, eye physics channels)
 * 4. apply pending again — final authority for YUVI-owned channels
 * 5. update — bake mesh for draw
 */
export function runYuviCubismParameterFrame(
  coreModel: Pick<CubismModel, "loadParameters" | "update" | "setParameterValueById">,
  getId: (id: string) => unknown,
  pending: ReadonlyMap<string, number>,
  evaluatePhysics: (() => void) | null | undefined
): void {
  coreModel.loadParameters();
  applyYuviParameters(coreModel, getId, pending);
  evaluatePhysics?.();
  applyYuviParameters(coreModel, getId, pending);
  coreModel.update();
}

/**
 * Minimal, official-Framework model host.  It intentionally has no motion or
 * expression layer: YUVI owns only Presence, breath and audio-derived mouth
 * parameters.  Physics runs before these values are reapplied each frame.
 */
export async function loadLumiCubismModel(
  canvas: HTMLCanvasElement,
  source: string,
  signal?: AbortSignal
): Promise<LumiCubismModel> {
  const runtime = await loadCubismFramework();
  const qualityProfile = resolveLive2dRenderQualityProfile();
  const requestedQuality = getLive2dRenderQuality(qualityProfile);
  // Applied quality may fall back to SAFE (1/1) if mask or scale init fails.
  let quality: Live2dRenderQualityConfig = { ...requestedQuality };
  let qualityFallbackApplied = false;
  let qualityFallbackReason: string | null = null;
  let contextCreationError: string | null = null;
  let firstGlError: string | null = null;

  // Prefer WebGL2 with progressive attribute fallback. Do not assume antialias
  // stayed true — WebView2 may report false; canvasRenderScale then supersamples.
  const { gl, creationError } = createLumiWebgl2Context(canvas);
  contextCreationError = creationError;
  if (!gl) {
    throw new Error(
      `WebGL2 is unavailable${creationError ? ` (${creationError})` : ""}.`
    );
  }

  const contextInfo = readWebglContextAttributes(gl);
  const maxTextureSize = contextInfo.maxTextureSize ?? 4096;
  // Official Cubism mask path has no MSAA FBO API; main-canvas MSAA is browser-driven.
  const maskMsaaSamples = resolveMsaaSamples(
    quality.preferredMsaaSamples,
    contextInfo.maxSamples
  );
  const maskMsaaActive = false;

  const modelUrl = new URL(source, window.location.href);
  const modelBuffer = await fetchBuffer(modelUrl, signal);
  const setting = new runtime.CubismModelSettingJson(modelBuffer, modelBuffer.byteLength);
  const model = new runtime.CubismUserModel() as UserModel;
  const mocName = setting.getModelFileName();
  if (!mocName) throw new Error("The model setting does not declare a moc3 file.");
  model.loadModel(await fetchBuffer(resolveResource(modelUrl, mocName), signal), true);

  const physicsName = setting.getPhysicsFileName();
  if (physicsName) {
    const physics = await fetchBuffer(resolveResource(modelUrl, physicsName), signal);
    model.loadPhysics(physics, physics.byteLength);
  }

  model.createRenderer(canvas.width || 1, canvas.height || 1);
  const renderer = model.getRenderer();

  /**
   * CRITICAL: setClippingMaskBufferSize must run **before** startUp.
   *
   * Official Cubism recreates `_drawableClippingManager` without calling
   * setGL(gl). If size is changed after startUp, setupClippingContext does
   * `this.gl.viewport(...)` with gl === undefined and the whole draw aborts
   * (model fully invisible). startUp is the only place that setGL + creates
   * mask FBOs at the manager's current size.
   */
  let appliedMaskBufferSize = quality.baseMaskBufferSize;
  const desiredMaskSize = resolveMaskBufferSize(
    quality.baseMaskBufferSize,
    quality.maskScale,
    maxTextureSize
  );
  if (
    quality.maskScale > 1 &&
    desiredMaskSize !== quality.baseMaskBufferSize &&
    typeof renderer.setClippingMaskBufferSize === "function"
  ) {
    try {
      renderer.setClippingMaskBufferSize(desiredMaskSize);
      appliedMaskBufferSize = desiredMaskSize;
    } catch (error) {
      quality = { ...LIVE2D_RENDER_QUALITY_SAFE };
      qualityFallbackApplied = true;
      qualityFallbackReason = `setClippingMaskBufferSize failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      appliedMaskBufferSize = LIVE2D_RENDER_QUALITY_SAFE.baseMaskBufferSize;
      try {
        renderer.setClippingMaskBufferSize(appliedMaskBufferSize);
      } catch {
        /* keep default manager from createRenderer */
      }
      if (import.meta.env.DEV) {
        console.warn("[YUVI Live2D] mask supersampling disabled:", qualityFallbackReason);
      }
    }
  }

  renderer.startUp(gl);
  renderer.setIsPremultipliedAlpha(true);

  // Capture first GL error after startup (mask FBO creation happens in startUp).
  firstGlError = readFirstGlError(gl) ?? firstGlError;
  if (firstGlError && !qualityFallbackApplied && quality.maskScale > 1) {
    // Mask FBO may have failed at larger size — drop to safe quality for visibility.
    quality = { ...LIVE2D_RENDER_QUALITY_SAFE };
    qualityFallbackApplied = true;
    qualityFallbackReason = `GL error after startUp: ${firstGlError}`;
    appliedMaskBufferSize = LIVE2D_RENDER_QUALITY_SAFE.baseMaskBufferSize;
    if (import.meta.env.DEV) {
      console.warn("[YUVI Live2D] falling back to safe quality:", qualityFallbackReason);
    }
  }

  const textures = await Promise.all(
    Array.from({ length: setting.getTextureCount() }, async (_, index) => {
      const name = setting.getTextureFileName(index);
      if (!name) throw new Error(`The model texture ${index} is missing.`);
      return createTexture(gl, await fetchBlob(resolveResource(modelUrl, name), signal));
    })
  );
  textures.forEach((texture, index) => renderer.bindTexture(index, texture));
  renderer.loadShaders(shaderDirectory);
  firstGlError = firstGlError ?? readFirstGlError(gl);

  const ids = [
    "ParamMouthOpenY",
    "ParamMouthForm",
    "ParamBreath",
    "ParamEyeLOpen",
    "ParamEyeROpen",
    "ParamEyeBallX",
    "ParamEyeBallY",
    "ParamAngleX",
    "ParamAngleY",
    "ParamAngleZ",
    "ParamBodyAngleX",
    "ParamBodyAngleY",
    "ParamBodyAngleZ"
  ];
  const coreModel = model.getModel();
  const parameterInfo = new Map<string, LumiParameterInfo>();
  for (const id of ids) {
    const index = coreModel.getParameterIndex(runtime.CubismFramework.getIdManager().getId(id));
    if (index < 0) continue;
    const min = coreModel.getParameterMinimumValue?.(index);
    const max = coreModel.getParameterMaximumValue?.(index);
    const defaultValue = coreModel.getParameterDefaultValue?.(index);
    parameterInfo.set(id, {
      id,
      min: Number.isFinite(min) ? Number(min) : fallbackParameterRange(id).min,
      max: Number.isFinite(max) ? Number(max) : fallbackParameterRange(id).max,
      defaultValue: Number.isFinite(defaultValue)
        ? Number(defaultValue)
        : fallbackParameterRange(id).defaultValue
    });
  }
  const parameterIds = new Set(parameterInfo.keys());
  const pending = new Map<string, number>();
  // CSS viewport for model matrix; pixel size for the GL backing store only.
  // renderScale enlarges the backing store — never multiplies into the MVP.
  let cssWidth = Math.max(1, canvas.clientWidth || 320);
  let cssHeight = Math.max(1, canvas.clientHeight || 420);
  let pixelWidth = Math.max(1, canvas.width || cssWidth);
  let pixelHeight = Math.max(1, canvas.height || cssHeight);
  let devicePixelRatio = 1;
  let renderScale = quality.canvasRenderScale;
  let lastFrameMs: number | null = null;
  let avgFrameMs: number | null = null;
  // Default portrait (half). Full-body only after an explicit user toggle.
  let framing: LumiFraming = "half";
  let disposed = false;
  let fitCacheKey: LumiFitCacheKey | null = null;
  let cachedMatrix: unknown = null;
  let cachedTransform: LumiUniformTransform | null = null;
  let cachedDiagnostics: LumiFramingDiagnostics | null = null;
  let lastPreUpdateParameters: Record<string, number> = {};

  const buildQualityDiagnostics = (): Live2dRenderQualityDiagnostics => {
    const attrs = readWebglContextAttributes(gl);
    const reportedMask =
      typeof renderer.getClippingMaskBufferSize === "function"
        ? renderer.getClippingMaskBufferSize()
        : appliedMaskBufferSize;
    return {
      profile: qualityProfile,
      canvasRenderScale: renderScale,
      maskScale: quality.maskScale,
      qualityFallbackApplied,
      qualityFallbackReason,
      maskBufferSize:
        Number.isFinite(reportedMask) && (reportedMask as number) > 0
          ? (reportedMask as number)
          : appliedMaskBufferSize,
      baseMaskBufferSize: quality.baseMaskBufferSize,
      preferredMsaaSamples: quality.preferredMsaaSamples,
      maskMsaaSamples,
      maskMsaaActive,
      maskFeatherTexels: clampMaskFeatherTexels(quality.maskFeatherTexels),
      devicePixelRatio,
      cssWidth,
      cssHeight,
      backingWidth: pixelWidth,
      backingHeight: pixelHeight,
      contextAntialias: attrs.antialias,
      contextAlpha: attrs.alpha,
      contextPremultipliedAlpha: attrs.premultipliedAlpha,
      contextPreserveDrawingBuffer: attrs.preserveDrawingBuffer,
      webglVersion: attrs.webglVersion,
      maxTextureSize: attrs.maxTextureSize,
      maxSamples: attrs.maxSamples,
      firstGlError,
      contextCreationError,
      avgFrameMs,
      lastFrameMs
    };
  };

  const getId = (id: string) => runtime.CubismFramework.getIdManager().getId(id);

  const readCoreParameterValue = (id: string): number | undefined => {
    const live = model.getModel();
    const handle = getId(id);
    const index = live.getParameterIndex(handle);
    if (index < 0) return undefined;
    if (typeof live.getParameterValueById === "function") {
      const value = live.getParameterValueById(handle);
      return Number.isFinite(value) ? Number(value) : undefined;
    }
    if (typeof live.getParameterValueByIndex !== "function") return undefined;
    const value = live.getParameterValueByIndex(index);
    return Number.isFinite(value) ? Number(value) : undefined;
  };

  const resize = (nextWidth: number, nextHeight: number) => {
    if (disposed || nextWidth <= 0 || nextHeight <= 0) return;
    // Use *applied* quality.canvasRenderScale (may be SAFE after fallback).
    // Never call setClippingMaskBufferSize here — post-startUp size changes
    // drop the GL handle on the clipping manager (see init comment above).
    const metrics = getLumiRenderMetrics(
      nextWidth,
      nextHeight,
      typeof window === "undefined" ? devicePixelRatio : window.devicePixelRatio,
      quality.canvasRenderScale
    );
    cssWidth = metrics.cssWidth;
    cssHeight = metrics.cssHeight;
    pixelWidth = metrics.pixelWidth;
    pixelHeight = metrics.pixelHeight;
    devicePixelRatio = metrics.devicePixelRatio;
    renderScale = metrics.renderScale;
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    // Invalidate matrix cache so the next render recomputes head-safe fit.
    fitCacheKey = null;
    cachedMatrix = null;
    cachedTransform = null;
    cachedDiagnostics = null;
  };
  resize(cssWidth, cssHeight);

  return {
    parameterIds,
    parameterInfo,
    setParameter(id, value) {
      if (!disposed && parameterIds.has(id)) {
        const info = parameterInfo.get(id);
        pending.set(id, clampParameter(value, info?.min ?? -Infinity, info?.max ?? Infinity));
      }
    },
    getPendingParameter(id) {
      return pending.get(id);
    },
    getParameterInfo(id) {
      return parameterInfo.get(id);
    },
    getCoreParameterValue(id) {
      return readCoreParameterValue(id);
    },
    getLastPreUpdateParameters() {
      return lastPreUpdateParameters;
    },
    setFraming(nextFraming) {
      if (disposed || framing === nextFraming) return;
      framing = nextFraming;
      fitCacheKey = null;
      cachedMatrix = null;
      cachedTransform = null;
      cachedDiagnostics = null;
    },
    getFraming() {
      return framing;
    },
    resize,
    getFramingTransform() {
      return cachedTransform;
    },
    getFramingDiagnostics() {
      return cachedDiagnostics;
    },
    getRenderQualityDiagnostics() {
      return buildQualityDiagnostics();
    },
    render(deltaSeconds) {
      if (disposed) return;
      const frameStarted =
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : 0;
      try {
        const liveCore = model.getModel();
        // Gaze/head (ParamEyeBall*, ParamAngle*) are physics inputs on Lumi.
        // Write pending before physics so secondary channels (e.g.
        // ParamEyeBallPhysicsX) receive this frame's target, then re-apply
        // pending after physics as final authority before update().
        const delta = Math.min(0.1, Math.max(0, deltaSeconds));
        liveCore.loadParameters();
        applyYuviParameters(liveCore, getId, pending);
        model._physics?.evaluate(liveCore, delta);
        applyYuviParameters(liveCore, getId, pending);
        // Snapshot Core values immediately before update() bakes the mesh.
        const diagnosticIds = [
          ...parameterIds,
          "ParamEyeBallPhysicsX",
          "ParamEyeBallPhysicsY"
        ];
        lastPreUpdateParameters = {};
        for (const id of diagnosticIds) {
          const value = readCoreParameterValue(id);
          if (value !== undefined) lastPreUpdateParameters[id] = value;
        }
        if (import.meta.env.DEV && typeof window !== "undefined") {
          const debugWindow = window as typeof window & {
            __yuviCubismParameterFrame?: Record<string, unknown>;
          };
          debugWindow.__yuviCubismParameterFrame = {
            pending: Object.fromEntries(pending.entries()),
            preUpdate: { ...lastPreUpdateParameters },
            coreEyeBallX: lastPreUpdateParameters["ParamEyeBallX"] ?? null,
            coreEyeBallY: lastPreUpdateParameters["ParamEyeBallY"] ?? null,
            coreAngleX: lastPreUpdateParameters["ParamAngleX"] ?? null,
            coreAngleY: lastPreUpdateParameters["ParamAngleY"] ?? null,
            coreAngleZ: lastPreUpdateParameters["ParamAngleZ"] ?? null,
            coreBodyAngleX: lastPreUpdateParameters["ParamBodyAngleX"] ?? null,
            coreBodyAngleY: lastPreUpdateParameters["ParamBodyAngleY"] ?? null,
            coreBodyAngleZ: lastPreUpdateParameters["ParamBodyAngleZ"] ?? null,
            coreEyeBallPhysicsX: lastPreUpdateParameters["ParamEyeBallPhysicsX"] ?? null,
            coreEyeBallPhysicsY: lastPreUpdateParameters["ParamEyeBallPhysicsY"] ?? null,
            parameterIds: [...parameterIds]
          };
        }
        liveCore.update();
        const modelWidth = Math.max(0.001, liveCore.getCanvasWidth());
        const modelHeight = Math.max(0.001, liveCore.getCanvasHeight());
        const key: LumiFitCacheKey = {
          framing,
          cssWidth,
          cssHeight,
          modelWidth,
          modelHeight
        };
        if (!sameFitKey(fitCacheKey, key) || cachedMatrix === null || cachedTransform === null) {
          const transform = computeLumiFramingTransform(
            framing,
            cssWidth,
            cssHeight,
            modelWidth,
            modelHeight
          );
          cachedMatrix = createFitMatrixFromTransform(runtime, transform);
          cachedTransform = transform;
          fitCacheKey = key;
          cachedDiagnostics = buildFramingDiagnostics(transform, {
            backingWidth: pixelWidth,
            backingHeight: pixelHeight,
            devicePixelRatio,
            headBounds: LUMI_PORTRAIT_HEAD_BOUNDS,
            margins: LUMI_PORTRAIT_MARGINS
          });
          if (import.meta.env.DEV && typeof window !== "undefined") {
            const debugWindow = window as typeof window & {
              __yuviFramingDiagnostics?: LumiFramingDiagnostics;
              __yuviLive2dRenderQualityDiagnostics?: Live2dRenderQualityDiagnostics;
            };
            debugWindow.__yuviFramingDiagnostics = cachedDiagnostics;
            debugWindow.__yuviLive2dRenderQualityDiagnostics = buildQualityDiagnostics();
          }
        }
        // DPR * renderScale only for the backing store / gl.viewport — never
        // re-multiplied into the model matrix (matrix uses CSS viewport above).
        gl.viewport(0, 0, pixelWidth, pixelHeight);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        renderer.setRenderState(null, [0, 0, pixelWidth, pixelHeight]);
        renderer.setMvpMatrix(cachedMatrix);
        renderer.drawModel(shaderDirectory);
        if (firstGlError == null) {
          firstGlError = readFirstGlError(gl);
        }
      } catch (error) {
        // Never leave the companion blank due to a quality/mask draw fault.
        // Drop to SAFE metrics on the next resize path and surface the cause.
        if (!qualityFallbackApplied) {
          quality = { ...LIVE2D_RENDER_QUALITY_SAFE };
          qualityFallbackApplied = true;
          qualityFallbackReason = `render threw: ${
            error instanceof Error ? error.message : String(error)
          }`;
          renderScale = 1;
          if (import.meta.env.DEV) {
            console.error("[YUVI Live2D] render failed; quality forced to SAFE:", error);
          }
        }
        if (firstGlError == null) {
          firstGlError = readFirstGlError(gl) ?? qualityFallbackReason;
        }
      }
      if (frameStarted > 0 && typeof performance !== "undefined") {
        lastFrameMs = performance.now() - frameStarted;
        avgFrameMs =
          avgFrameMs == null ? lastFrameMs : avgFrameMs * 0.9 + lastFrameMs * 0.1;
      }
      if (import.meta.env.DEV && typeof window !== "undefined") {
        const debugWindow = window as typeof window & {
          __yuviLive2dRenderQualityDiagnostics?: Live2dRenderQualityDiagnostics;
        };
        debugWindow.__yuviLive2dRenderQualityDiagnostics = buildQualityDiagnostics();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pending.clear();
      lastPreUpdateParameters = {};
      fitCacheKey = null;
      cachedMatrix = null;
      cachedTransform = null;
      cachedDiagnostics = null;
      lastFrameMs = null;
      avgFrameMs = null;
      for (const texture of textures) gl.deleteTexture(texture);
      // model.release() frees Cubism renderer + mask FBOs / textures.
      model.release();
    }
  };
}

/**
 * Build a Cubism MVP matrix from a uniform transform.
 *
 * CubismMatrix44.scale(x,y) **assigns** the diagonal (it does not multiply).
 * CubismMatrix44.translate(x,y) **assigns** the translation. Therefore the
 * final matrix must be written in a single assign of scale then translate —
 * never "aspect scale" followed by a second scale() that would wipe it.
 *
 * Resulting map: ndc = model * ndcScale + translate
 */
export function createFitMatrixFromTransform(
  runtime: CubismFrameworkRuntime,
  transform: LumiUniformTransform
): unknown {
  const matrix = new runtime.CubismMatrix44();
  matrix.scale(transform.ndcScaleX, transform.ndcScaleY);
  matrix.translate(transform.translateX, transform.translateY);
  return matrix;
}

/**
 * @deprecated Prefer createFitMatrixFromTransform with computeLumiFramingTransform.
 * Kept so existing imports keep working.
 */
export function createFitMatrix(
  runtime: CubismFrameworkRuntime,
  modelWidth: number,
  modelHeight: number,
  cssWidth: number,
  cssHeight: number,
  framing: LumiFraming
): unknown {
  const transform = computeLumiFramingTransform(
    framing,
    cssWidth,
    cssHeight,
    modelWidth,
    modelHeight
  );
  return createFitMatrixFromTransform(runtime, transform);
}

function resolveResource(modelUrl: URL, name: string): URL {
  return new URL(name, modelUrl);
}

async function fetchBuffer(url: URL, signal?: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, signal ? { signal } : undefined);
  if (!response.ok) throw new Error(`Live2D resource is unavailable (${response.status}).`);
  return response.arrayBuffer();
}

async function fetchBlob(url: URL, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(url, signal ? { signal } : undefined);
  if (!response.ok) throw new Error(`Live2D texture is unavailable (${response.status}).`);
  return response.blob();
}

async function createTexture(gl: WebGL2RenderingContext, blob: Blob): Promise<WebGLTexture> {
  const bitmap = await createImageBitmap(blob);
  const texture = gl.createTexture();
  if (!texture) {
    bitmap.close();
    throw new Error("Unable to create a Live2D texture.");
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  bitmap.close();
  return texture;
}

function fallbackParameterRange(id: string): LumiParameterInfo {
  switch (id) {
    case "ParamEyeBallX":
    case "ParamEyeBallY":
      return { id, min: -1, max: 1, defaultValue: 0 };
    case "ParamAngleX":
    case "ParamAngleY":
    case "ParamAngleZ":
    case "ParamBodyAngleX":
    case "ParamBodyAngleY":
    case "ParamBodyAngleZ":
      return { id, min: -30, max: 30, defaultValue: 0 };
    case "ParamBreath":
      return { id, min: 0, max: 1, defaultValue: 0 };
    case "ParamEyeLOpen":
    case "ParamEyeROpen":
      return { id, min: 0, max: 1, defaultValue: 1 };
    case "ParamMouthOpenY":
      return { id, min: 0, max: 2.1, defaultValue: 0 };
    case "ParamMouthForm":
      return { id, min: -1, max: 1, defaultValue: 0 };
    default:
      return { id, min: -Infinity, max: Infinity, defaultValue: 0 };
  }
}

function clampParameter(value: number, min: number, max: number): number {
  const safe = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, safe));
}
