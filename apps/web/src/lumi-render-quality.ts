/**
 * Central Live2D WebGL render-quality settings for YUVI Companion.
 *
 * Keep all AA / mask supersampling knobs here — do not scatter magic numbers
 * across the Cubism host. Framing / MVP still use CSS viewport only;
 * canvasRenderScale affects the GL backing store size, never the model matrix.
 */

export type Live2dRenderQualityProfile = "balanced" | "high";

export type Live2dRenderQualityConfig = {
  /** Multiplier on top of effective DPR for canvas backing store. */
  canvasRenderScale: number;
  /** Multiplier applied to Cubism default mask buffer (256). */
  maskScale: number;
  /** Preferred MSAA sample count for future WebGL2 mask paths. */
  preferredMsaaSamples: number;
  /**
   * Soft edge width in mask texels. Official Cubism mask shaders already
   * sample continuously (no hard threshold); retained for diagnostics /
   * future shader hooks — not applied as a model texture blur.
   */
  maskFeatherTexels: number;
  /** Official Cubism default clipping mask buffer edge length. */
  baseMaskBufferSize: number;
};

/**
 * Visibility-first safe baseline. Always valid when higher AA settings fail.
 * Used for automatic fallback so the model never goes fully blank.
 */
export const LIVE2D_RENDER_QUALITY_SAFE: Live2dRenderQualityConfig = {
  canvasRenderScale: 1,
  maskScale: 1,
  preferredMsaaSamples: 0,
  maskFeatherTexels: 0.75,
  baseMaskBufferSize: 256
};

/** Default profile values — balanced is the product default. */
export const LIVE2D_RENDER_QUALITY_PROFILES = {
  balanced: {
    canvasRenderScale: 1.25,
    maskScale: 2,
    preferredMsaaSamples: 4,
    maskFeatherTexels: 0.75,
    baseMaskBufferSize: 256
  },
  high: {
    canvasRenderScale: 1.5,
    maskScale: 4,
    preferredMsaaSamples: 4,
    maskFeatherTexels: 0.75,
    baseMaskBufferSize: 256
  }
} as const satisfies Record<Live2dRenderQualityProfile, Live2dRenderQualityConfig>;

/** Active product default (not scattered elsewhere). */
export const LIVE2D_RENDER_QUALITY: Live2dRenderQualityConfig =
  LIVE2D_RENDER_QUALITY_PROFILES.balanced;

export const LUMI_DEVICE_PIXEL_RATIO_CAP = 2;

/**
 * Preferred WebGL2 attributes. Matches the last known-good companion path
 * (alpha + antialias + premultiplied) and only adds preserveDrawingBuffer:false.
 * Avoid requiring stencil/depth so WebView2 is less likely to reject the context.
 */
export const LIVE2D_WEBGL_CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  antialias: true,
  premultipliedAlpha: true,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false
};

/** Minimal attributes used when the preferred set fails to create a context. */
export const LIVE2D_WEBGL_CONTEXT_ATTRIBUTES_FALLBACK: WebGLContextAttributes = {
  alpha: true,
  antialias: true,
  premultipliedAlpha: true
};

/**
 * Create a WebGL2 context with preferred attrs, then progressive fallbacks.
 * Never pretends antialias is on if the runtime reports false.
 */
export function createLumiWebgl2Context(canvas: HTMLCanvasElement): {
  gl: WebGL2RenderingContext | null;
  attributesUsed: WebGLContextAttributes | null;
  creationError: string | null;
} {
  const attempts: WebGLContextAttributes[] = [
    LIVE2D_WEBGL_CONTEXT_ATTRIBUTES,
    LIVE2D_WEBGL_CONTEXT_ATTRIBUTES_FALLBACK,
    { alpha: true, premultipliedAlpha: true },
    {}
  ];
  let lastError: string | null = null;
  for (const attrs of attempts) {
    try {
      const gl = canvas.getContext("webgl2", attrs);
      if (gl) {
        return { gl, attributesUsed: attrs, creationError: null };
      }
      lastError = "getContext('webgl2') returned null";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { gl: null, attributesUsed: null, creationError: lastError };
}

/** Drain and return the first GL error as a string, or null if clean. */
export function readFirstGlError(
  gl: WebGLRenderingContext | WebGL2RenderingContext | null
): string | null {
  if (!gl) return null;
  try {
    const code = gl.getError();
    if (code === gl.NO_ERROR) return null;
    const names: Record<number, string> = {
      [gl.INVALID_ENUM]: "INVALID_ENUM",
      [gl.INVALID_VALUE]: "INVALID_VALUE",
      [gl.INVALID_OPERATION]: "INVALID_OPERATION",
      [gl.OUT_OF_MEMORY]: "OUT_OF_MEMORY",
      [gl.CONTEXT_LOST_WEBGL]: "CONTEXT_LOST_WEBGL"
    };
    // Drain remaining errors so later frames start clean.
    while (gl.getError() !== gl.NO_ERROR) {
      /* drain */
    }
    return names[code] ?? `GL_ERROR_${code}`;
  } catch {
    return "getError_threw";
  }
}

export type LumiRenderMetrics = {
  cssWidth: number;
  cssHeight: number;
  /** Effective device pixel ratio after cap (not including renderScale). */
  devicePixelRatio: number;
  /** Quality multiplier applied only to the backing store. */
  renderScale: number;
  /** css * dpr * renderScale */
  pixelWidth: number;
  pixelHeight: number;
};

export type Live2dRenderQualityDiagnostics = {
  profile: Live2dRenderQualityProfile;
  canvasRenderScale: number;
  maskScale: number;
  /** True when quality was reduced to SAFE (1 / 1) after a failure. */
  qualityFallbackApplied: boolean;
  qualityFallbackReason: string | null;
  maskBufferSize: number;
  baseMaskBufferSize: number;
  preferredMsaaSamples: number;
  maskMsaaSamples: number;
  maskMsaaActive: boolean;
  maskFeatherTexels: number;
  devicePixelRatio: number;
  cssWidth: number;
  cssHeight: number;
  backingWidth: number;
  backingHeight: number;
  contextAntialias: boolean | null;
  contextAlpha: boolean | null;
  contextPremultipliedAlpha: boolean | null;
  contextPreserveDrawingBuffer: boolean | null;
  webglVersion: 1 | 2 | null;
  maxTextureSize: number | null;
  maxSamples: number | null;
  firstGlError: string | null;
  contextCreationError: string | null;
  avgFrameMs: number | null;
  lastFrameMs: number | null;
};

/**
 * Resolve which profile is active.
 * Default is always balanced. In DEV, `window.__yuviLive2dRenderQuality = "high"`
 * switches to the high preset without a settings UI.
 */
export function resolveLive2dRenderQualityProfile(
  explicit?: Live2dRenderQualityProfile | null
): Live2dRenderQualityProfile {
  if (explicit === "balanced" || explicit === "high") return explicit;
  if (import.meta.env.DEV && typeof window !== "undefined") {
    const flag = (window as typeof window & {
      __yuviLive2dRenderQuality?: string;
    }).__yuviLive2dRenderQuality;
    if (flag === "high") return "high";
    if (flag === "balanced") return "balanced";
  }
  return "balanced";
}

export function getLive2dRenderQuality(
  profile?: Live2dRenderQualityProfile | null
): Live2dRenderQualityConfig {
  const resolved = resolveLive2dRenderQualityProfile(profile);
  return { ...LIVE2D_RENDER_QUALITY_PROFILES[resolved] };
}

/**
 * Convert CSS pixels to a capped high-resolution backing store.
 * `renderScale` enlarges the GL buffer only — callers must keep using
 * cssWidth/cssHeight for model framing / MVP.
 */
export function getLumiRenderMetrics(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio,
  renderScale = LIVE2D_RENDER_QUALITY.canvasRenderScale
): LumiRenderMetrics {
  const safeWidth = Math.max(1, Math.round(cssWidth));
  const safeHeight = Math.max(1, Math.round(cssHeight));
  const ratio = Math.min(
    LUMI_DEVICE_PIXEL_RATIO_CAP,
    Math.max(1, Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1)
  );
  const scale = clampRenderScale(renderScale);
  return {
    cssWidth: safeWidth,
    cssHeight: safeHeight,
    devicePixelRatio: ratio,
    renderScale: scale,
    pixelWidth: Math.max(1, Math.round(safeWidth * ratio * scale)),
    pixelHeight: Math.max(1, Math.round(safeHeight * ratio * scale))
  };
}

export function clampRenderScale(value: number): number {
  if (!Number.isFinite(value)) return LIVE2D_RENDER_QUALITY.canvasRenderScale;
  return Math.min(2, Math.max(1, value));
}

/**
 * Cubism default mask buffer is square. Scale then clamp to GPU max texture size.
 * Rebuilds only when size changes (framework recreates FBO when mismatched).
 */
export function resolveMaskBufferSize(
  baseMaskBufferSize: number,
  maskScale: number,
  maxTextureSize: number
): number {
  const base = Math.max(64, Math.round(Number.isFinite(baseMaskBufferSize) ? baseMaskBufferSize : 256));
  const scale = Math.max(1, Number.isFinite(maskScale) ? maskScale : 1);
  const maxTex = Math.max(
    64,
    Math.floor(Number.isFinite(maxTextureSize) && maxTextureSize > 0 ? maxTextureSize : 4096)
  );
  const scaled = Math.round(base * scale);
  return Math.min(maxTex, Math.max(64, scaled));
}

/**
 * Soft clamp for feather config (diagnostic / future shader use).
 * Values outside [0, 2] texels are not useful for 1-texel edges.
 */
export function clampMaskFeatherTexels(value: number): number {
  if (!Number.isFinite(value)) return LIVE2D_RENDER_QUALITY.maskFeatherTexels;
  return Math.min(2, Math.max(0, value));
}

/**
 * Resolve MSAA sample count for a WebGL2 context.
 * Returns 0 when multisampled renderbuffers are unavailable or samples < 2.
 */
export function resolveMsaaSamples(
  preferred: number,
  maxSamples: number | null | undefined
): number {
  const want = Math.max(0, Math.floor(Number.isFinite(preferred) ? preferred : 0));
  if (want < 2) return 0;
  if (maxSamples == null || !Number.isFinite(maxSamples) || maxSamples < 2) return 0;
  return Math.min(want, Math.floor(maxSamples), 8);
}

/** Read context attributes without assuming antialias succeeded. */
export function readWebglContextAttributes(
  gl: WebGLRenderingContext | WebGL2RenderingContext | null
): {
  webglVersion: 1 | 2 | null;
  antialias: boolean | null;
  alpha: boolean | null;
  premultipliedAlpha: boolean | null;
  preserveDrawingBuffer: boolean | null;
  maxTextureSize: number | null;
  maxSamples: number | null;
} {
  if (!gl) {
    return {
      webglVersion: null,
      antialias: null,
      alpha: null,
      premultipliedAlpha: null,
      preserveDrawingBuffer: null,
      maxTextureSize: null,
      maxSamples: null
    };
  }
  const attrs = gl.getContextAttributes?.() ?? null;
  const isWebgl2 =
    typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
  let maxSamples: number | null = null;
  if (isWebgl2) {
    try {
      maxSamples = gl.getParameter(gl.MAX_SAMPLES) as number;
    } catch {
      maxSamples = null;
    }
  }
  let maxTextureSize: number | null = null;
  try {
    maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  } catch {
    maxTextureSize = null;
  }
  return {
    webglVersion: isWebgl2 ? 2 : 1,
    antialias: attrs?.antialias ?? null,
    alpha: attrs?.alpha ?? null,
    premultipliedAlpha: attrs?.premultipliedAlpha ?? null,
    preserveDrawingBuffer: attrs?.preserveDrawingBuffer ?? null,
    maxTextureSize: Number.isFinite(maxTextureSize as number) ? (maxTextureSize as number) : null,
    maxSamples: Number.isFinite(maxSamples as number) ? (maxSamples as number) : null
  };
}
