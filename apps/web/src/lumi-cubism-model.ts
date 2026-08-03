import { type CubismFrameworkRuntime, loadCubismFramework } from "./cubism-framework.js";

const shaderDirectory = "/cubism-shaders/";

export type LumiFraming = "half" | "full";

export const LUMI_DEVICE_PIXEL_RATIO_CAP = 2;

/** Convert CSS pixels to a capped canvas backing-store size. */
export function getLumiRenderMetrics(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio
): { cssWidth: number; cssHeight: number; devicePixelRatio: number; pixelWidth: number; pixelHeight: number } {
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

export function getLumiFramingZoom(framing: LumiFraming): number {
  return framing === "half" ? 3.35 : 0.92;
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
  setFraming(framing: LumiFraming): void;
  resize(width: number, height: number): void;
  render(deltaSeconds: number): void;
  dispose(): void;
};

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
    ids.filter((id) => model.getModel().getParameterIndex(runtime.CubismFramework.getIdManager().getId(id)) >= 0)
  );
  const pending = new Map<string, number>();
  let width = Math.max(1, canvas.clientWidth || canvas.width || 320);
  let height = Math.max(1, canvas.clientHeight || canvas.height || 420);
  let framing: LumiFraming = "half";
  let disposed = false;

  const resize = (nextWidth: number, nextHeight: number) => {
    if (disposed || nextWidth <= 0 || nextHeight <= 0) return;
    const metrics = getLumiRenderMetrics(nextWidth, nextHeight);
    width = metrics.pixelWidth;
    height = metrics.pixelHeight;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  };
  resize(width, height);

  return {
    parameterIds,
    setParameter(id, value) {
      if (!disposed && parameterIds.has(id)) pending.set(id, value);
    },
    setFraming(nextFraming) {
      if (!disposed) framing = nextFraming;
    },
    resize,
    render(deltaSeconds) {
      if (disposed) return;
      const coreModel = model.getModel();
      // Restore the baseline, apply physics, then reapply YUVI's final mouth
      // values so neither physics nor a future motion can overwrite speech.
      coreModel.loadParameters();
      model._physics?.evaluate(coreModel, Math.min(0.1, Math.max(0, deltaSeconds)));
      for (const [id, value] of pending) {
        coreModel.setParameterValueById(runtime.CubismFramework.getIdManager().getId(id), value);
      }
      coreModel.update();
      const matrix = createFitMatrix(runtime, coreModel, width, height, framing);
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      renderer.setRenderState(null, [0, 0, width, height]);
      renderer.setMvpMatrix(matrix);
      renderer.drawModel(shaderDirectory);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pending.clear();
      for (const texture of textures) gl.deleteTexture(texture);
      model.release();
    }
  };
}

function createFitMatrix(
  runtime: CubismFrameworkRuntime,
  model: CubismModel,
  width: number,
  height: number,
  framing: LumiFraming
): unknown {
  const matrix = new runtime.CubismMatrix44();
  const modelWidth = Math.max(0.001, model.getCanvasWidth());
  const modelHeight = Math.max(0.001, model.getCanvasHeight());
  const canvasAspect = width / height;
  const modelAspect = modelWidth / modelHeight;
  if (canvasAspect > modelAspect) matrix.scale(1 / canvasAspect, 1);
  else matrix.scale(1, canvasAspect);
  const zoom = getLumiFramingZoom(framing);
  matrix.scale(zoom / modelWidth * modelHeight, zoom);
  matrix.translate(0, framing === "half" ? -1.25 : -0.08);
  return matrix;
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
