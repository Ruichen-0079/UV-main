import { execFile } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { captureKdeScreen, screenCaptureAvailable } from "./screen-capture.js";
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:fs", () => ({ accessSync: vi.fn(), constants: { X_OK: 1 } }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
function kde() {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
  vi.stubEnv("KDE_FULL_SESSION", "true");
}
it.each(["success", "failure", "abort", "invalid"])(
  "cleans the private temporary capture on %s",
  async (mode) => {
    kde();
    let capturedPath = "";
    const controller = new AbortController();
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null) => void
    ) => {
      capturedPath = args.at(-1)!;
      expect(args).toEqual([
        "--background",
        "--nonotify",
        "--fullscreen",
        "--output",
        capturedPath
      ]);
      void writeFile(
        capturedPath,
        mode === "invalid" ? Buffer.from("bad") : Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
      ).then(() => {
        if (mode === "abort") controller.abort();
        callback(mode === "failure" ? new Error("failure") : null);
      });
    }) as typeof execFile);
    const pending = captureKdeScreen(controller.signal);
    if (mode === "success") expect((await pending).byteLength).toBe(9);
    else await expect(pending).rejects.toThrow();
    expect(execFile).toHaveBeenCalledTimes(1);
    await expect(access(dirname(capturedPath))).rejects.toThrow();
  }
);
it("unavailable and pre-cancelled requests do not execute a screenshot", async () => {
  vi.stubEnv("XDG_SESSION_TYPE", "x11");
  expect(screenCaptureAvailable()).toBe(false);
  await expect(captureKdeScreen(new AbortController().signal)).rejects.toThrow("unavailable");
  kde();
  const controller = new AbortController();
  controller.abort();
  await expect(captureKdeScreen(controller.signal)).rejects.toThrow();
  expect(execFile).not.toHaveBeenCalled();
});
