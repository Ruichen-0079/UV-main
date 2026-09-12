import { afterEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mock.listen }));
import { subscribeSurfaceChanged } from "./tauri-window.js";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("refreshes on registration, desktop changes and focus, and removes listeners", async () => {
  const target = new EventTarget();
  vi.stubGlobal("window", target);
  const remove = vi.fn();
  const refresh = vi.fn();
  const error = vi.fn();
  let changed!: () => void;
  mock.listen.mockImplementation(async (_name, fn) => {
    changed = fn;
    return remove;
  });
  const stop = subscribeSurfaceChanged(refresh, error);
  await vi.dynamicImportSettled();
  expect(mock.listen).toHaveBeenCalledWith("desktop-surface.changed", refresh);
  expect(refresh).toHaveBeenCalledTimes(1);
  changed();
  target.dispatchEvent(new Event("focus"));
  expect(refresh).toHaveBeenCalledTimes(3);
  stop();
  target.dispatchEvent(new Event("focus"));
  expect(refresh).toHaveBeenCalledTimes(3);
  expect(remove).toHaveBeenCalledOnce();
  expect(error).not.toHaveBeenCalled();
});
it("cleans up registration that resolves after navigation", async () => {
  vi.stubGlobal("window", new EventTarget());
  let finish!: (remove: () => void) => void;
  mock.listen.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const refresh = vi.fn();
  const stop = subscribeSurfaceChanged(refresh, vi.fn());
  await vi.dynamicImportSettled();
  stop();
  const remove = vi.fn();
  finish(remove);
  await Promise.resolve();
  expect(remove).toHaveBeenCalledOnce();
  expect(refresh).not.toHaveBeenCalled();
});
