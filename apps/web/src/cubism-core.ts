export type CubismCoreGlobal = {
  Version?: string;
  [key: string]: unknown;
};

export type CubismCoreLoaderOptions = {
  source?: string;
  timeoutMs?: number;
  document?: Document;
  global?: typeof globalThis;
};

export type CubismCoreLoader = {
  load(): Promise<CubismCoreGlobal>;
  resetAfterFailure(): void;
};

import { resolveRuntimeAssetUrl } from "./desktop-runtime.js";

const defaultSource = "/api/live2d-core/live2dcubismcore.min.js";

export function createCubismCoreLoader(options: CubismCoreLoaderOptions = {}): CubismCoreLoader {
  let inFlight: Promise<CubismCoreGlobal> | null = null;
  let ownedScript: HTMLScriptElement | null = null;

  const load = (): Promise<CubismCoreGlobal> => {
    const targetGlobal = options.global ?? globalThis;
    const existing = getCore(targetGlobal);
    if (existing) return Promise.resolve(existing);
    if (inFlight) return inFlight;

    const doc = options.document ?? (typeof document === "undefined" ? undefined : document);
    if (!doc) return Promise.reject(new Error("Live2D Core requires a browser document."));
    const source = resolveRuntimeAssetUrl(options.source ?? defaultSource);
    const timeoutMs = options.timeoutMs ?? 10_000;

    inFlight = new Promise<CubismCoreGlobal>((resolve, reject) => {
      const script = doc.createElement("script");
      ownedScript = script;
      let settled = false;
      const timeout = setTimeout(
        () => finish(new Error("Live2D Core loading timed out.")),
        timeoutMs
      );
      const cleanup = () => {
        clearTimeout(timeout);
        script.onload = null;
        script.onerror = null;
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          if (script.parentNode) script.parentNode.removeChild(script);
          if (ownedScript === script) ownedScript = null;
          inFlight = null;
          reject(error);
          return;
        }
        const core = getCore(targetGlobal);
        if (!core) {
          if (script.parentNode) script.parentNode.removeChild(script);
          if (ownedScript === script) ownedScript = null;
          inFlight = null;
          reject(new Error("Live2D Core script loaded without a Core global."));
          return;
        }
        resolve(core);
      };
      script.async = true;
      script.src = source;
      script.onload = () => finish();
      script.onerror = () => finish(new Error("Live2D Core script could not be loaded."));
      (doc.head ?? doc.documentElement).appendChild(script);
    });

    return inFlight;
  };

  return {
    load,
    resetAfterFailure: () => {
      if (ownedScript?.parentNode) ownedScript.parentNode.removeChild(ownedScript);
      ownedScript = null;
      inFlight = null;
    }
  };
}

const defaultLoader = createCubismCoreLoader();

export function loadCubismCore(): Promise<CubismCoreGlobal> {
  return defaultLoader.load();
}

export function resetCubismCoreLoaderForTests(): void {
  defaultLoader.resetAfterFailure();
}

function getCore(targetGlobal: typeof globalThis): CubismCoreGlobal | null {
  const core = (targetGlobal as typeof globalThis & { Live2DCubismCore?: CubismCoreGlobal })
    .Live2DCubismCore;
  return core && typeof core === "object" ? core : null;
}
