import { afterEach, describe, expect, it, vi } from "vitest";

const { startResizeDragging } = vi.hoisted(() => ({
  startResizeDragging: vi.fn()
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startResizeDragging })
}));

import {
  isTauriRuntime,
  preloadTauriWindowApi,
  startWindowResizeDragging,
  type TauriResizeDirection
} from "./tauri-window.js";

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  startResizeDragging.mockClear();
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
