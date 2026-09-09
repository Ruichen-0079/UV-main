import { afterEach, describe, expect, it, vi } from "vitest";

const { startDragging, startResizeDragging, invoke } = vi.hoisted(() => ({
  startDragging: vi.fn(),
  startResizeDragging: vi.fn(),
  invoke: vi.fn()
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging, startResizeDragging })
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  isTauriRuntime,
  preloadTauriWindowApi,
  startWindowDragging,
  startWindowResizeDragging,
  controlCompanionWindow,
  controlWebUIWindow,
  type TauriResizeDirection
} from "./tauri-window.js";

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  startDragging.mockClear();
  startResizeDragging.mockClear();
  invoke.mockClear();
});

describe("controlCompanionWindow", () => {
  it("does not touch Tauri IPC in a browser", async () => {
    await expect(controlCompanionWindow("show_companion")).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("invokes the requested command inside Tauri", async () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    await controlCompanionWindow("reopen_companion");
    expect(invoke).toHaveBeenCalledWith("reopen_companion");
  });
});

describe("controlWebUIWindow", () => {
  it("does not touch Tauri IPC in a browser", async () => {
    await expect(controlWebUIWindow()).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("shows the lazy WebUI surface inside Tauri", async () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    await controlWebUIWindow();
    expect(invoke).toHaveBeenCalledWith("show_webui");
  });
});

describe("isTauriRuntime", () => {
  it("is false when no Tauri bridge exists", () => {
    expect(isTauriRuntime()).toBe(false);
  });

  it("is true when __TAURI_INTERNALS__ is present", () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    expect(isTauriRuntime()).toBe(true);
  });
});

describe("startWindowDragging", () => {
  it("no-ops outside Tauri", async () => {
    await expect(startWindowDragging()).resolves.toBeUndefined();
    expect(startDragging).not.toHaveBeenCalled();
  });

  it("starts native dragging inside Tauri", async () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    await startWindowDragging();
    expect(startDragging).toHaveBeenCalledTimes(1);
  });
});

describe("startWindowResizeDragging", () => {
  it("no-ops outside Tauri and never calls the window API", async () => {
    await expect(
      startWindowResizeDragging("SouthEast" as TauriResizeDirection)
    ).resolves.toBeUndefined();
    await expect(preloadTauriWindowApi()).resolves.toBeUndefined();
    expect(startResizeDragging).not.toHaveBeenCalled();
  });

  it("starts SouthEast resize dragging inside Tauri", async () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    await startWindowResizeDragging("SouthEast" as TauriResizeDirection);
    expect(startResizeDragging).toHaveBeenCalledWith("SouthEast");
  });
});
