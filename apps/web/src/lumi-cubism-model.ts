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

const shaderDirectory = "/cubism-shaders/";

export type LumiFraming = LumiFramingMode;

export const LUMI_DEVICE_PIXEL_RATIO_CAP = 2;

/** Convert CSS pixels to a capped canvas backing-store size. */
export function getLumiRenderMetrics(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio
): {
  cssWidth: number;
  cssHeight: number;
  devicePixelRatio: number;
  pixelWidth: number;
  pixelHeight: number;
} {
  const safeWidth = Math.max(1, Math.round(cssWidth));
  const safeHeight = Math.max(1, Math.round(cssHeight));
  const ratio = Math.min(
    LUMI_DEVICE_PIXEL_RATIO_CAP,
    Math.max(1, Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1)
  );
  return {
    cssWidth: safeWidth,
    cssHeight: safeHeight,
    devicePixelRatio: ratio,
    pixelWidth: Math.max(1, Math.round(safeWidth * ratio)),
    pixelHeight: Math.max(1, Math.round(safeHeight * ratio))
  };
}

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
  setParameter(id: string, value: number): void;
  /** Development/diagnostics: last value staged for the next Core update. */
  getPendingParameter(id: string): number | undefined;
  setFraming(framing: LumiFraming): void;
  getFraming(): LumiFraming;
  resize(width: number, height: number): void;
  render(deltaSeconds: number): void;
  dispose(): void;
  /** Last computed framing transform (null before first render). */
  getFramingTransform(): LumiUniformTransform | null;
  /** Development-only projection diagnostics. */
  getFramingDiagnostics(): LumiFramingDiagnostics | null;
};

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
  for (const [id, value] of pending) {
    coreModel.setParameterValueById(getId(id), value);
  }
  coreModel.update();
}

/** @deprecated Use applyYuviParametersThenUpdate. Kept name only for migration. */
export const updateAndApplyFinalCubismParameters = applyYuviParametersThenUpdate;

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
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: true,
    premultipliedAlpha: true
  });
  if (!gl) throw new Error("WebGL2 is unavailable.");

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
  renderer.startUp(gl);
  renderer.setIsPremultipliedAlpha(true);
  const textures = await Promise.all(
    Array.from({ length: setting.getTextureCount() }, async (_, index) => {
      const name = setting.getTextureFileName(index);
      if (!name) throw new Error(`The model texture ${index} is missing.`);
      return createTexture(gl, await fetchBlob(resolveResource(modelUrl, name), signal));
    })
  );
  textures.forEach((texture, index) => renderer.bindTexture(index, texture));
  renderer.loadShaders(shaderDirectory);

  const ids = [
    "ParamMouthOpenY",
    "ParamMouthForm",
    "ParamBreath",
    "ParamEyeLOpen",
    "ParamEyeROpen"
  ];
  const parameterIds = new Set(
    ids.filter(
      (id) =>
        model.getModel().getParameterIndex(runtime.CubismFramework.getIdManager().getId(id)) >= 0
    )
  );
  const pending = new Map<string, number>();
  // CSS viewport for model matrix; pixel size for the GL backing store only.
  let cssWidth = Math.max(1, canvas.clientWidth || 320);
  let cssHeight = Math.max(1, canvas.clientHeight || 420);
  let pixelWidth = Math.max(1, canvas.width || cssWidth);
  let pixelHeight = Math.max(1, canvas.height || cssHeight);
  let devicePixelRatio = 1;
  // Default portrait (half). Full-body only after an explicit user toggle.
  let framing: LumiFraming = "half";
  let disposed = false;
  let fitCacheKey: LumiFitCacheKey | null = null;
  let cachedMatrix: unknown = null;
  let cachedTransform: LumiUniformTransform | null = null;
  let cachedDiagnostics: LumiFramingDiagnostics | null = null;

  const resize = (nextWidth: number, nextHeight: number) => {
    if (disposed || nextWidth <= 0 || nextHeight <= 0) return;
    const metrics = getLumiRenderMetrics(nextWidth, nextHeight);
    cssWidth = metrics.cssWidth;
    cssHeight = metrics.cssHeight;
    pixelWidth = metrics.pixelWidth;
    pixelHeight = metrics.pixelHeight;
    devicePixelRatio = metrics.devicePixelRatio;
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
    setParameter(id, value) {
      if (!disposed && parameterIds.has(id)) pending.set(id, value);
    },
    getPendingParameter(id) {
      return pending.get(id);
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
    render(deltaSeconds) {
      if (disposed) return;
      const coreModel = model.getModel();
      // Official Cubism order: restore baseline → physics → YUVI overrides →
      // Core update (bake mesh) → draw.
      coreModel.loadParameters();
      model._physics?.evaluate(coreModel, Math.min(0.1, Math.max(0, deltaSeconds)));
      applyYuviParametersThenUpdate(
        coreModel,
        (id) => runtime.CubismFramework.getIdManager().getId(id),
        pending
      );
      const modelWidth = Math.max(0.001, coreModel.getCanvasWidth());
      const modelHeight = Math.max(0.001, coreModel.getCanvasHeight());
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
          };
          debugWindow.__yuviFramingDiagnostics = cachedDiagnostics;
        }
      }
      // DPR only for the backing store / gl.viewport — never re-multiplied into
      // the model matrix (matrix uses CSS viewport dimensions above).
      gl.viewport(0, 0, pixelWidth, pixelHeight);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      renderer.setRenderState(null, [0, 0, pixelWidth, pixelHeight]);
      renderer.setMvpMatrix(cachedMatrix);
      renderer.drawModel(shaderDirectory);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pending.clear();
      fitCacheKey = null;
      cachedMatrix = null;
      cachedTransform = null;
      cachedDiagnostics = null;
      for (const texture of textures) gl.deleteTexture(texture);
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
