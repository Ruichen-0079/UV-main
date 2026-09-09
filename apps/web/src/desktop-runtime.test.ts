import { afterEach, describe, expect, it, vi } from "vitest";

const { getCurrentWindow } = vi.hoisted(() => ({
  getCurrentWindow: vi.fn()
}));

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow }));

import {
  DEFAULT_RUNTIME_HTTP,
  DesktopRuntimeBindingUnavailableError,
  setDesktopRuntimeBinding,
  setDesktopRuntimeHttpOverride,
  resolveApiBaseUrl,
  resolveRuntimeAssetUrl,
  resolveDesktopSurface
} from "./desktop-runtime.js";

describe("desktop-runtime API base", () => {
  afterEach(() => {
    setDesktopRuntimeBinding("owned", null);
    vi.unstubAllGlobals();
    getCurrentWindow.mockReset();
  });

  it("uses Vite /api proxy outside Tauri", () => {
    vi.stubGlobal("window", {});
    expect(resolveApiBaseUrl({})).toBe("/api");
  });

  it("uses loopback Runtime inside Tauri when env unset", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    expect(resolveApiBaseUrl({})).toBe(DEFAULT_RUNTIME_HTTP);
  });

  it("uses the attached Supervisor Runtime URL inside Tauri", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    setDesktopRuntimeBinding("attach", "http://127.0.0.1:16121/");
    expect(resolveApiBaseUrl({})).toBe("http://127.0.0.1:16121");
    expect(resolveRuntimeAssetUrl("/api/live2d/Lumi/Lumi.model3.json")).toBe(
      "http://127.0.0.1:16121/live2d/Lumi/Lumi.model3.json"
    );
  });

  it("fails closed in attach mode instead of using installed 6121", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    setDesktopRuntimeBinding("attach", null);
    expect(() => resolveApiBaseUrl({})).toThrow(DesktopRuntimeBindingUnavailableError);
    expect(() =>
      resolveApiBaseUrl({ VITE_API_BASE_URL: "http://127.0.0.1:6121" })
    ).toThrow(DesktopRuntimeBindingUnavailableError);
    expect(() =>
      resolveRuntimeAssetUrl("/api/live2d/Lumi/Lumi.model3.json")
    ).toThrow(DesktopRuntimeBindingUnavailableError);
  });

  it("rejects non-loopback desktop Runtime URLs", () => {
    expect(() => setDesktopRuntimeBinding("attach", "https://example.com:6121")).toThrow(/loopback/);
    expect(() => setDesktopRuntimeHttpOverride("http://192.0.2.10:16121")).toThrow(/loopback/);
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
  afterEach(() => {
    setDesktopRuntimeBinding("owned", null);
    vi.unstubAllGlobals();
    getCurrentWindow.mockReset();
  });

  it("keeps the existing dashboard hash route as the browser WebUI", async () => {
    vi.stubGlobal("window", { location: { hash: "#/dashboard", pathname: "/" } });
    await expect(resolveDesktopSurface()).resolves.toBe("dashboard");
  });

  it("maps the Tauri WebUI window label to the existing dashboard App", async () => {
    getCurrentWindow.mockReturnValue({ label: "webui" });
    vi.stubGlobal("window", {
      __TAURI_INTERNALS__: {},
      location: { hash: "#/main", pathname: "/main" }
    });
    await expect(resolveDesktopSurface()).resolves.toBe("webui");
  });

  it("maps the Tauri Subtitle window label and hash route", async () => {
    getCurrentWindow.mockReturnValue({ label: "subtitle" });
    vi.stubGlobal("window", {
      __TAURI_INTERNALS__: {},
      location: { hash: "#/main", pathname: "/main" }
    });
    await expect(resolveDesktopSurface()).resolves.toBe("subtitle");

    getCurrentWindow.mockReset();
    vi.stubGlobal("window", { location: { hash: "#/subtitle", pathname: "/" } });
    await expect(resolveDesktopSurface()).resolves.toBe("subtitle");
  });
});
