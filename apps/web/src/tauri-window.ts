/**
 * Tauri-only window helpers. Every call is guarded by isTauriRuntime() so the
 * browser /companion debug page (and any non-Tauri test environment) never
 * touches the Tauri IPC bridge.
 */

/** Mirrors @tauri-apps/api/window's ResizeDirection (not exported in v2.11). */
export type TauriResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Warm the window API module so a pointerdown can start resizing in the same gesture. */
export async function preloadTauriWindowApi(): Promise<void> {
  if (!isTauriRuntime()) return;
  await import("@tauri-apps/api/window");
}

export async function startWindowResizeDragging(direction: TauriResizeDirection): Promise<void> {
  if (!isTauriRuntime()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().startResizeDragging(direction);
}
