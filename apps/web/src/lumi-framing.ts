/**
 * Head-safe portrait framing and full-body contain for Lumi.
 *
 * Coordinate contract
 * -------------------
 * Model space: Cubism canvas coordinates with origin at the model center,
 * X right, Y up. getCanvasWidth/Height report the full canvas extent; the
 * drawable typically lives in [-mw/2, mw/2] × [-mh/2, mh/2].
 *
 * Viewport space: CSS pixels, origin top-left (for diagnostics only).
 *
 * NDC / clip space: X,Y in [-1, 1], origin center, Y up (Cubism MVP).
 *
 * Uniform transform
 * -----------------
 * Characters must never be non-uniformly scaled. We compute one
 * `uniformScale` in **pixels per model unit**, then convert to NDC:
 *
 *   ndcScaleX = uniformScale * 2 / viewportWidth
 *   ndcScaleY = uniformScale * 2 / viewportHeight
 *
 * Those NDC components differ on non-square viewports so that on-screen
 * pixels-per-model-unit stay equal on both axes.
 */

export type LumiFramingMode = "half" | "full";

/** Axis-aligned head box in model units (origin at model canvas center). */
export type LumiHeadBounds = {
  /** Left edge of the head (hair / side decoration included). */
  left: number;
  /** Right edge of the head (hair / side decoration included). */
  right: number;
  /** Top of the crown / ears / headwear. */
  top: number;
  /** Bottom of the chin (body below may be cropped). */
  bottom: number;
};

export type LumiFramingMargins = {
  /** Horizontal inset from the viewport edges (CSS px). */
  horizontal: number;
  /** Top inset so the crown is not clipped (CSS px). */
  top: number;
  /** Bottom inset so the chin stays inside the safe area (CSS px). */
  bottom: number;
};

/**
 * Uniform model→screen transform.
 *
 * `ndcScaleX` and `ndcScaleY` may differ, but only as the inverse of the
 * viewport aspect so that `uniformScale` (pixels per model unit) is identical
 * on both axes.
 */
export type LumiUniformTransform = {
  /** Pixels per model unit — the single source of scale. */
  uniformScale: number;
  /** Model unit → NDC X. */
  ndcScaleX: number;
  /** Model unit → NDC Y. */
  ndcScaleY: number;
  /** NDC translation X (after scale). */
  translateX: number;
  /** NDC translation Y (after scale). */
  translateY: number;
  framing: LumiFramingMode;
  viewportWidth: number;
  viewportHeight: number;
  modelWidth: number;
  modelHeight: number;
};

export type LumiProjectedRect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  centerX: number;
  centerY: number;
};

/**
 * Lumi portrait head-safe bounds (model space, origin center, Y up).
 *
 * Calibrated for the upper head region including crown / side hair so the
 * body may extend below the viewport. Not derived from live drawable bounds.
 *
 * Historical half-body framing (zoom≈3.35, ty≈-1.25) roughly framed model
 * Y ∈ [0.07, 0.67]. Head-safe tightens around the head while keeping ears
 * and chin inside the box.
 */
export const LUMI_PORTRAIT_HEAD_BOUNDS: LumiHeadBounds = {
  left: -0.4,
  right: 0.4,
  top: 0.88,
  bottom: 0.1
};

export const LUMI_PORTRAIT_MARGINS: LumiFramingMargins = {
  horizontal: 14,
  top: 20,
  bottom: 18
};

/** Soft inset for full-body contain (still uniform). */
export const LUMI_FULL_BODY_FIT = 0.92;

export const LUMI_FULL_BODY_MARGINS: LumiFramingMargins = {
  horizontal: 16,
  top: 16,
  bottom: 16
};

/** @deprecated Use LUMI_FULL_BODY_FIT. */
export const LUMI_FULL_BODY_ZOOM = LUMI_FULL_BODY_FIT;
/** @deprecated Full-body now centers; kept for legacy test imports. */
export const LUMI_FULL_BODY_TRANSLATE_Y = 0;

export function getHeadBoundsWidth(bounds: LumiHeadBounds): number {
  return Math.max(0.001, bounds.right - bounds.left);
}

export function getHeadBoundsHeight(bounds: LumiHeadBounds): number {
  return Math.max(0.001, bounds.top - bounds.bottom);
}

export function getHeadBoundsCenterX(bounds: LumiHeadBounds): number {
  return (bounds.left + bounds.right) / 2;
}

export function getHeadBoundsCenterY(bounds: LumiHeadBounds): number {
  return (bounds.top + bounds.bottom) / 2;
}

/**
 * Convert a uniform pixel scale into NDC scale components so that one model
 * unit maps to the same number of CSS pixels on both axes.
 */
export function uniformScaleToNdc(
  uniformScale: number,
  viewportWidth: number,
  viewportHeight: number
): { ndcScaleX: number; ndcScaleY: number } {
  const w = Math.max(1, viewportWidth);
  const h = Math.max(1, viewportHeight);
  const s = Number.isFinite(uniformScale) && uniformScale > 0 ? uniformScale : 1;
  return {
    ndcScaleX: (s * 2) / w,
    ndcScaleY: (s * 2) / h
  };
}

/** Pixel length of one model unit implied by the NDC scales (must match). */
export function pixelsPerModelUnit(
  transform: Pick<LumiUniformTransform, "ndcScaleX" | "ndcScaleY" | "viewportWidth" | "viewportHeight">
): { x: number; y: number } {
  return {
    x: (transform.ndcScaleX * transform.viewportWidth) / 2,
    y: (transform.ndcScaleY * transform.viewportHeight) / 2
  };
}

export function projectModelToNdc(
  modelX: number,
  modelY: number,
  transform: Pick<LumiUniformTransform, "ndcScaleX" | "ndcScaleY" | "translateX" | "translateY">
): { x: number; y: number } {
  return {
    x: modelX * transform.ndcScaleX + transform.translateX,
    y: modelY * transform.ndcScaleY + transform.translateY
  };
}

/** Project model → CSS viewport pixels (origin top-left, Y down). */
export function projectModelToViewportPx(
  modelX: number,
  modelY: number,
  transform: Pick<
    LumiUniformTransform,
    "ndcScaleX" | "ndcScaleY" | "translateX" | "translateY" | "viewportWidth" | "viewportHeight"
  >
): { x: number; y: number } {
  const ndc = projectModelToNdc(modelX, modelY, transform);
  return {
    x: ((ndc.x + 1) / 2) * transform.viewportWidth,
    y: ((1 - ndc.y) / 2) * transform.viewportHeight
  };
}

export function projectHeadBoundsToViewportPx(
  head: LumiHeadBounds,
  transform: LumiUniformTransform
): LumiProjectedRect {
  const tl = projectModelToViewportPx(head.left, head.top, transform);
  const br = projectModelToViewportPx(head.right, head.bottom, transform);
  const left = Math.min(tl.x, br.x);
  const right = Math.max(tl.x, br.x);
  const top = Math.min(tl.y, br.y);
  const bottom = Math.max(tl.y, br.y);
  return {
    left,
    right,
    top,
    bottom,
    centerX: (left + right) / 2,
    centerY: (top + bottom) / 2
  };
}

export type LumiPortraitFitInput = {
  viewportWidth: number;
  viewportHeight: number;
  modelWidth: number;
  modelHeight: number;
  headBounds?: LumiHeadBounds;
  margins?: Partial<LumiFramingMargins>;
};

/**
 * Portrait head-safe fit.
 *
 * Priority:
 * 1. Full configured head box stays inside the safe viewport.
 * 2. Uniform scale only (no stretch).
 * 3. Maximize scale (fill width when height allows).
 * 4. Body may be cropped at the bottom.
 */
export function computePortraitHeadFit(input: LumiPortraitFitInput): LumiUniformTransform {
  const viewportWidth = Math.max(1, input.viewportWidth);
  const viewportHeight = Math.max(1, input.viewportHeight);
  const modelWidth = Math.max(0.001, input.modelWidth);
  const modelHeight = Math.max(0.001, input.modelHeight);
  const head = input.headBounds ?? LUMI_PORTRAIT_HEAD_BOUNDS;
  const margins: LumiFramingMargins = {
    ...LUMI_PORTRAIT_MARGINS,
    ...input.margins
  };

  const headWidth = getHeadBoundsWidth(head);
  const headHeight = getHeadBoundsHeight(head);
  const availableWidth = Math.max(1, viewportWidth - margins.horizontal * 2);
  const availableHeight = Math.max(1, viewportHeight - margins.top - margins.bottom);

  // Pixels per model unit — single uniform value.
  const scaleByWidth = availableWidth / headWidth;
  const scaleByHeight = availableHeight / headHeight;
  const uniformScale = Math.min(scaleByWidth, scaleByHeight);

  const { ndcScaleX, ndcScaleY } = uniformScaleToNdc(uniformScale, viewportWidth, viewportHeight);

  // Horizontal: head center → viewport center (NDC x = 0).
  const headCenterX = getHeadBoundsCenterX(head);
  const translateX = -headCenterX * ndcScaleX;

  // Vertical: place crown at top safe edge; clamp chin into bottom safe edge.
  const topNdc = 1 - (margins.top / viewportHeight) * 2;
  const bottomNdc = -1 + (margins.bottom / viewportHeight) * 2;
  let translateY = topNdc - head.top * ndcScaleY;
  const chinNdc = head.bottom * ndcScaleY + translateY;
  if (chinNdc < bottomNdc) {
    translateY += bottomNdc - chinNdc;
  }

  return {
    uniformScale,
    ndcScaleX,
    ndcScaleY,
    translateX,
    translateY,
    framing: "half",
    viewportWidth,
    viewportHeight,
    modelWidth,
    modelHeight
  };
}

export type LumiFullBodyFitInput = {
  viewportWidth: number;
  viewportHeight: number;
  modelWidth: number;
  modelHeight: number;
  margins?: Partial<LumiFramingMargins>;
  /** Soft inset in (0, 1]; default LUMI_FULL_BODY_FIT. */
  fit?: number;
};

/**
 * Full-body contain: entire model canvas stays inside the viewport with
 * uniform scale and optional soft inset. Independent of portrait head bounds.
 */
export function computeFullBodyFit(input: LumiFullBodyFitInput): LumiUniformTransform {
  const viewportWidth = Math.max(1, input.viewportWidth);
  const viewportHeight = Math.max(1, input.viewportHeight);
  const modelWidth = Math.max(0.001, input.modelWidth);
  const modelHeight = Math.max(0.001, input.modelHeight);
  const margins: LumiFramingMargins = {
    ...LUMI_FULL_BODY_MARGINS,
    ...input.margins
  };
  const fitFactor = Math.min(1, Math.max(0.05, input.fit ?? LUMI_FULL_BODY_FIT));

  const availableWidth = Math.max(1, viewportWidth - margins.horizontal * 2);
  const availableHeight = Math.max(1, viewportHeight - margins.top - margins.bottom);

  // Model canvas spans modelWidth × modelHeight around the origin.
  const uniformScale =
    Math.min(availableWidth / modelWidth, availableHeight / modelHeight) * fitFactor;
  const { ndcScaleX, ndcScaleY } = uniformScaleToNdc(uniformScale, viewportWidth, viewportHeight);

  // Center the model canvas in the viewport.
  const translateX = 0;
  const translateY = 0;

  return {
    uniformScale,
    ndcScaleX,
    ndcScaleY,
    translateX,
    translateY,
    framing: "full",
    viewportWidth,
    viewportHeight,
    modelWidth,
    modelHeight
  };
}

export function computeLumiFramingTransform(
  framing: LumiFramingMode,
  viewportWidth: number,
  viewportHeight: number,
  modelWidth: number,
  modelHeight: number
): LumiUniformTransform {
  if (framing === "full") {
    return computeFullBodyFit({
      viewportWidth,
      viewportHeight,
      modelWidth,
      modelHeight
    });
  }
  return computePortraitHeadFit({
    viewportWidth,
    viewportHeight,
    modelWidth,
    modelHeight
  });
}

/**
 * True when the configured head box projects fully inside the safe viewport
 * (CSS pixel space).
 */
export function isHeadFullyVisible(
  transform: LumiUniformTransform,
  head: LumiHeadBounds = LUMI_PORTRAIT_HEAD_BOUNDS,
  margins: LumiFramingMargins = LUMI_PORTRAIT_MARGINS,
  epsilonPx = 1.5
): boolean {
  const rect = projectHeadBoundsToViewportPx(head, transform);
  const left = margins.horizontal - epsilonPx;
  const right = transform.viewportWidth - margins.horizontal + epsilonPx;
  const top = margins.top - epsilonPx;
  const bottom = transform.viewportHeight - margins.bottom + epsilonPx;
  return (
    rect.left >= left &&
    rect.right <= right &&
    rect.top >= top &&
    rect.bottom <= bottom
  );
}

/** True when X/Y pixel scales match (uniform character proportions). */
export function isUniformPixelScale(transform: LumiUniformTransform, epsilon = 1e-6): boolean {
  const { x, y } = pixelsPerModelUnit(transform);
  return Math.abs(x - y) <= epsilon && Math.abs(x - transform.uniformScale) <= epsilon;
}

export type LumiFitCacheKey = {
  framing: LumiFramingMode;
  cssWidth: number;
  cssHeight: number;
  modelWidth: number;
  modelHeight: number;
};

export function sameFitKey(a: LumiFitCacheKey | null, b: LumiFitCacheKey): boolean {
  if (!a) return false;
  return (
    a.framing === b.framing &&
    a.cssWidth === b.cssWidth &&
    a.cssHeight === b.cssHeight &&
    a.modelWidth === b.modelWidth &&
    a.modelHeight === b.modelHeight
  );
}

/** Development diagnostics payload for overlay / console. */
export type LumiFramingDiagnostics = {
  framing: LumiFramingMode;
  cssWidth: number;
  cssHeight: number;
  backingWidth: number;
  backingHeight: number;
  devicePixelRatio: number;
  modelWidth: number;
  modelHeight: number;
  headBounds: LumiHeadBounds;
  margins: LumiFramingMargins;
  uniformScale: number;
  ndcScaleX: number;
  ndcScaleY: number;
  translateX: number;
  translateY: number;
  pixelsPerUnitX: number;
  pixelsPerUnitY: number;
  headProjectionPx: LumiProjectedRect;
  safeViewportPx: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  };
};

export function buildFramingDiagnostics(
  transform: LumiUniformTransform,
  options: {
    backingWidth: number;
    backingHeight: number;
    devicePixelRatio: number;
    headBounds?: LumiHeadBounds;
    margins?: LumiFramingMargins;
  }
): LumiFramingDiagnostics {
  const headBounds = options.headBounds ?? LUMI_PORTRAIT_HEAD_BOUNDS;
  const margins =
    options.margins ??
    (transform.framing === "full" ? LUMI_FULL_BODY_MARGINS : LUMI_PORTRAIT_MARGINS);
  const px = pixelsPerModelUnit(transform);
  return {
    framing: transform.framing,
    cssWidth: transform.viewportWidth,
    cssHeight: transform.viewportHeight,
    backingWidth: options.backingWidth,
    backingHeight: options.backingHeight,
    devicePixelRatio: options.devicePixelRatio,
    modelWidth: transform.modelWidth,
    modelHeight: transform.modelHeight,
    headBounds,
    margins,
    uniformScale: transform.uniformScale,
    ndcScaleX: transform.ndcScaleX,
    ndcScaleY: transform.ndcScaleY,
    translateX: transform.translateX,
    translateY: transform.translateY,
    pixelsPerUnitX: px.x,
    pixelsPerUnitY: px.y,
    headProjectionPx: projectHeadBoundsToViewportPx(headBounds, transform),
    safeViewportPx: {
      left: margins.horizontal,
      right: transform.viewportWidth - margins.horizontal,
      top: margins.top,
      bottom: transform.viewportHeight - margins.bottom
    }
  };
}
