import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RUNTIME_HTTP,
  resolveApiBaseUrl,
  resolveRuntimeAssetUrl,
  surfaceFromLocation
} from "./desktop-runtime.js";

describe("desktop-runtime API base", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses Vite /api proxy outside Tauri", () => {
    vi.stubGlobal("window", {});
    expect(resolveApiBaseUrl({})).toBe("/api");
  });

  it("uses loopback Runtime inside Tauri when env unset", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    expect(resolveApiBaseUrl({})).toBe(DEFAULT_RUNTIME_HTTP);
  });

  it("prefers explicit VITE_API_BASE_URL", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    expect(resolveApiBaseUrl({ VITE_API_BASE_URL: "http://127.0.0.1:6999/" })).toBe(
      "http://127.0.0.1:6999"
    );
  });

  it("rewrites /api live2d paths for Tauri", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    expect(resolveRuntimeAssetUrl("/api/live2d/Lumi/Lumi.model3.json")).toBe(
      "http://127.0.0.1:6121/live2d/Lumi/Lumi.model3.json"
    );
    expect(resolveRuntimeAssetUrl("/api/live2d-core/live2dcubismcore.min.js")).toBe(
      "http://127.0.0.1:6121/live2d-core/live2dcubismcore.min.js"
    );
  });

  it("leaves /api paths unchanged outside Tauri", () => {
    vi.stubGlobal("window", {});
    expect(resolveRuntimeAssetUrl("/api/live2d/Lumi/Lumi.model3.json")).toBe(
      "/api/live2d/Lumi/Lumi.model3.json"
    );
  });
});

describe("desktop surface routing", () => {
  it("defaults the browser to Product UI instead of the developer dashboard", () => {
    expect(surfaceFromLocation({ hash: "", pathname: "/" })).toBe("main");
    expect(surfaceFromLocation({ hash: "#/main/settings/memory", pathname: "/" })).toBe("main");
    expect(surfaceFromLocation({ hash: "#/dashboard", pathname: "/" })).toBe("dashboard");
    expect(surfaceFromLocation({ hash: "", pathname: "/", tauriLabel: "companion" })).toBe(
      "companion"
    );
  });
});
