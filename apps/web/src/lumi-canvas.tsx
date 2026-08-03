import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import {
  LumiController,
  CubismLive2DAdapter,
  type LumiControllerHandle,
  type PresenceState
} from "./lumi-live2d.js";
import type { LumiFraming } from "./lumi-cubism-model.js";

const defaultModelUrl = "/api/live2d/Lumi/Lumi.model3.json";

export const LumiCanvas = forwardRef(function LumiCanvas(
  props: { requestedPresence: PresenceState; className?: string },
  ref: Ref<LumiControllerHandle>
): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<LumiController | null>(null);
  const [state, setState] = useState<PresenceState>("unavailable");
  const [framing, setFraming] = useState<LumiFraming>("half");

  useImperativeHandle(ref, () => {
    return {
      // Resolve the controller at call time. The imperative handle is created
      // before the mount effect installs the controller instance.
      load: () => controllerRef.current?.load() ?? Promise.resolve(),
      runMouthCalibration: () => controllerRef.current?.runMouthCalibration() ?? Promise.resolve(),
      setFraming: (next) => controllerRef.current?.setFraming(next),
      setPresence: (next) => controllerRef.current?.setPresence(next),
      resumeAudio: () => controllerRef.current?.resumeAudio(),
      handlePlaybackEvent: (event) => controllerRef.current?.handlePlaybackEvent(event),
      resize: (width, height) => controllerRef.current?.resize(width, height),
      dispose: () => controllerRef.current?.dispose(),
      getPresence: () => controllerRef.current?.getPresence() ?? "unavailable"
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    let disposed = false;
    const source = import.meta.env["VITE_LIVE2D_MODEL_URL"]?.trim() || defaultModelUrl;
    const controller = new LumiController(
      () => new CubismLive2DAdapter(canvas),
      source,
      (next) => {
        if (!disposed) setState(next);
      }
    );
    controllerRef.current = controller;
    const resize = () => controller.resize(container.clientWidth, container.clientHeight);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    observer?.observe(container);
    resize();
    void controller.load();
    return () => {
      disposed = true;
      observer?.disconnect();
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.setPresence(props.requestedPresence);
  }, [props.requestedPresence]);

  useEffect(() => {
    controllerRef.current?.setFraming(framing);
  }, [framing]);

  return (
    <div
      ref={containerRef}
      className={props.className ?? "relative min-h-[280px] overflow-hidden rounded-md bg-ink-900"}
      aria-label="Lumi avatar"
      data-presence={state}
      data-framing={framing}
    >
      <canvas ref={canvasRef} className="h-full w-full" aria-hidden="true" />
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
      <button
        type="button"
        className="absolute right-2 bottom-2 rounded bg-ink-900/70 px-2 py-1 text-xs text-white"
        aria-pressed={framing === "full"}
        onClick={() => setFraming((current) => (current === "half" ? "full" : "half"))}
      >
        {framing === "half" ? "显示全身" : "显示半身"}
      </button>
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
