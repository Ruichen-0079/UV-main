import { afterEach, describe, expect, it, vi } from "vitest";

const { startResizeDragging, invoke } = vi.hoisted(() => ({
  startResizeDragging: vi.fn(),
  invoke: vi.fn()
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startResizeDragging })
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  isTauriRuntime,
  preloadTauriWindowApi,
  startWindowResizeDragging,
  controlCompanionWindow,
  type TauriResizeDirection
} from "./tauri-window.js";

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
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

describe("isTauriRuntime", () => {
  it("is false when no Tauri bridge exists", () => {
    expect(isTauriRuntime()).toBe(false);
  });

  it("is true when __TAURI_INTERNALS__ is present", () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    expect(isTauriRuntime()).toBe(true);
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
