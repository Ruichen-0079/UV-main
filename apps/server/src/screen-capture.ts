import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const executable = "/usr/bin/spectacle";

/** Configuration/capability inspection only: no capture or provider I/O. */
export function screenCaptureAvailable(): boolean {
  if (
    process.platform !== "linux" ||
    process.env["XDG_SESSION_TYPE"] !== "wayland" ||
    !process.env["WAYLAND_DISPLAY"] ||
    !(
      process.env["KDE_FULL_SESSION"] === "true" ||
      process.env["XDG_CURRENT_DESKTOP"]?.includes("KDE")
    )
  )
    return false;
  try {
    accessSync(executable, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** One process, one private temporary image, deleted before returning bytes. */
export async function captureKdeScreen(signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  if (!screenCaptureAvailable()) throw new Error("KDE Wayland screen capture is unavailable.");
  const directory = await mkdtemp(join(tmpdir(), "yuvi-grounding-"));
  try {
    const path = join(directory, "screen.png");
    await new Promise<void>((resolve, reject) => {
      execFile(
        executable,
        ["--background", "--nonotify", "--fullscreen", "--output", path],
        { signal, timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 },
        (error) => (error ? reject(new Error("Screen capture failed.")) : resolve())
      );
    });
    signal.throwIfAborted();
    const info = await stat(path);
    if (!info.isFile() || info.size === 0 || info.size > 20 * 1024 * 1024)
      throw new Error("Invalid capture size.");
    const image = await readFile(path);
    if (!image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new Error("Invalid PNG capture.");
    signal.throwIfAborted();
    return image;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
