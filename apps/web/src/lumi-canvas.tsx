import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import {
  LumiController,
  CubismLive2DAdapter,
  type LumiControllerHandle,
  type LumiModelLifecycle,
  type LumiPresenceAnimation,
  type PresenceState
} from "./lumi-live2d.js";
import type { LumiFraming } from "./lumi-cubism-model.js";
import type { LumiFramingDiagnostics } from "./lumi-framing.js";
import type { CompanionPresenceProjection } from "./companion-presence.js";
import { resolveRuntimeAssetUrl } from "./desktop-runtime.js";

const DEFAULT_MODEL_PATH = "/api/live2d/Lumi/Lumi.model3.json";

function isHeadBoundsOverlayEnabled(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") return false;
  const flag = (window as typeof window & { __yuviShowHeadBounds?: boolean }).__yuviShowHeadBounds;
  return flag === true;
}

export const LumiCanvas = forwardRef(function LumiCanvas(
  props: {
    requestedPresence?: PresenceState;
    requestedProjection?: CompanionPresenceProjection;
    className?: string;
    onModelLifecycle?: (state: LumiModelLifecycle) => void;
    /** The companion window draws its own framing toggle outside the resize corner. */
    showFramingToggle?: boolean;
  },
  ref: Ref<LumiControllerHandle>
): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<LumiController | null>(null);
  const [state, setState] = useState<PresenceState>("idle");
  const [modelLifecycle, setModelLifecycle] = useState<LumiModelLifecycle>("loading");
  const onModelLifecycleRef = useRef(props.onModelLifecycle);
  onModelLifecycleRef.current = props.onModelLifecycle;
  // Default portrait (half). Full-body only after an explicit user toggle.
  const [framing, setFraming] = useState<LumiFraming>("half");
  const [overlay, setOverlay] = useState<LumiFramingDiagnostics | null>(null);

  useImperativeHandle(ref, () => {
    return {
      // Resolve the controller at call time. The imperative handle is created
      // before the mount effect installs the controller instance.
      load: () => controllerRef.current?.load() ?? Promise.resolve(),
      runMouthCalibration: () => controllerRef.current?.runMouthCalibration() ?? Promise.resolve(),
      setFraming: (next) => controllerRef.current?.setFraming(next),
      setPresence: (next) => controllerRef.current?.setPresence(next),
      setPresentationProjection: (projection) =>
        controllerRef.current?.setPresentationProjection(projection),
      setGazeTarget: (target) => controllerRef.current?.setGazeTarget(target),
      setPresenceAnimation: ((
        animationOrBlink: LumiPresenceAnimation | number,
        breath?: number
      ) => {
        if (typeof animationOrBlink === "number") {
          controllerRef.current?.setPresenceAnimation(animationOrBlink, breath ?? 0);
        } else {
          controllerRef.current?.setPresenceAnimation(animationOrBlink);
        }
      }) as LumiControllerHandle["setPresenceAnimation"],
      resumeAudio: () => controllerRef.current?.resumeAudio(),
      handlePlaybackEvent: (event) => controllerRef.current?.handlePlaybackEvent(event),
      resize: (width, height) => controllerRef.current?.resize(width, height),
      dispose: () => controllerRef.current?.dispose(),
      getPresence: () => controllerRef.current?.getPresence() ?? "idle",
      getModelLifecycle: () => controllerRef.current?.getModelLifecycle() ?? "loading",
      getFramingDiagnostics: () => controllerRef.current?.getFramingDiagnostics() ?? null,
      getDebugInfo: () =>
        controllerRef.current?.getDebugInfo() ?? {
          instanceId: 0,
          generation: 0
        }
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    let disposed = false;
    const source =
      import.meta.env["VITE_LIVE2D_MODEL_URL"]?.trim() ||
      resolveRuntimeAssetUrl(DEFAULT_MODEL_PATH);
    const controller = new LumiController(
      () => new CubismLive2DAdapter(canvas),
      source,
      (next) => {
        if (!disposed) setState(next);
      },
      undefined,
      (next) => {
        if (!disposed) {
          setModelLifecycle(next);
          onModelLifecycleRef.current?.(next);
        }
      }
    );
    controllerRef.current = controller;
    const resize = () => controller.resize(container.clientWidth, container.clientHeight);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    observer?.observe(container);
    // DPR / zoom changes do not always fire ResizeObserver; listen as well.
    window.addEventListener("resize", resize);
    resize();
    void controller.load();

    let overlayFrame = 0;
    const tickOverlay = () => {
      if (disposed) return;
      if (isHeadBoundsOverlayEnabled()) {
        setOverlay(controller.getFramingDiagnostics());
      } else {
        setOverlay((current) => (current === null ? current : null));
      }
      overlayFrame = requestAnimationFrame(tickOverlay);
    };
    if (import.meta.env.DEV) {
      overlayFrame = requestAnimationFrame(tickOverlay);
    }

    return () => {
      disposed = true;
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      if (overlayFrame) cancelAnimationFrame(overlayFrame);
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (props.requestedProjection) {
      controllerRef.current?.setPresentationProjection(props.requestedProjection);
    } else if (props.requestedPresence) {
      controllerRef.current?.setPresence(props.requestedPresence);
    }
  }, [props.requestedPresence, props.requestedProjection]);

  useEffect(() => {
    controllerRef.current?.setFraming(framing);
  }, [framing]);

  return (
    <div
      ref={containerRef}
      className={props.className ?? "relative min-h-[280px] overflow-hidden rounded-md bg-ink-900"}
      aria-label="Lumi avatar"
      data-presence={state}
      data-model-lifecycle={modelLifecycle}
      data-framing={framing}
    >
      {/*
        display:block avoids the inline-canvas baseline gap. No CSS transform /
        aspect-ratio so the WebGL buffer is never stretched by the browser.
      */}
      <canvas
        ref={canvasRef}
        className="block h-full w-full"
        style={{ display: "block", width: "100%", height: "100%" }}
        aria-hidden="true"
      />
      {overlay && (
        <div className="pointer-events-none absolute inset-0 z-10" aria-hidden="true">
          {/* Viewport safe margins */}
          <div
            className="absolute border border-cyan-400/70"
            style={{
              left: overlay.safeViewportPx.left,
              top: overlay.safeViewportPx.top,
              width: Math.max(0, overlay.safeViewportPx.right - overlay.safeViewportPx.left),
              height: Math.max(0, overlay.safeViewportPx.bottom - overlay.safeViewportPx.top)
            }}
          />
          {/* Projected head bounds */}
          <div
            className="absolute border-2 border-amber-400/90"
            style={{
              left: overlay.headProjectionPx.left,
              top: overlay.headProjectionPx.top,
              width: Math.max(0, overlay.headProjectionPx.right - overlay.headProjectionPx.left),
              height: Math.max(0, overlay.headProjectionPx.bottom - overlay.headProjectionPx.top)
            }}
          />
          <div className="absolute left-2 top-8 max-w-[90%] rounded bg-black/60 px-2 py-1 text-[10px] leading-snug text-white">
            framing={overlay.framing} css={overlay.cssWidth}×{overlay.cssHeight} dpr=
            {overlay.devicePixelRatio.toFixed(2)}
            <br />
            uniformScale={overlay.uniformScale.toFixed(2)} px/unit x=
            {overlay.pixelsPerUnitX.toFixed(2)} y={overlay.pixelsPerUnitY.toFixed(2)}
            <br />
            head px L{overlay.headProjectionPx.left.toFixed(0)} R
            {overlay.headProjectionPx.right.toFixed(0)} T{overlay.headProjectionPx.top.toFixed(0)} B
            {overlay.headProjectionPx.bottom.toFixed(0)}
          </div>
        </div>
      )}
      <div
        className="pointer-events-none absolute bottom-2 left-2 rounded bg-ink-900/70 px-2 py-1 text-xs text-white"
        aria-live="polite"
      >
        {presenceLabel(state)}
      </div>
      {import.meta.env.DEV && (
        <button
          type="button"
          className="absolute right-2 top-2 rounded bg-ink-900/70 px-2 py-1 text-xs text-white"
          onClick={() => void controllerRef.current?.runMouthCalibration()}
        >
          测试口型
        </button>
      )}
      {props.showFramingToggle !== false && (
        <button
          type="button"
          className="absolute right-2 bottom-2 rounded bg-ink-900/70 px-2 py-1 text-xs text-white"
          aria-pressed={framing === "full"}
          onClick={() => setFraming((current) => (current === "half" ? "full" : "half"))}
        >
          {/* Label is the action target, not the current mode. */}
          {framing === "half" ? "显示全身" : "显示半身"}
        </button>
      )}
    </div>
  );
});

function presenceLabel(state: PresenceState): string {
  switch (state) {
    case "thinking":
      return "正在思考";
    case "speaking":
      return "正在说话";
    case "interrupted":
      return "已中断";
    case "unavailable":
      return "形象暂不可用";
    case "idle":
      return "待机";
  }
}
