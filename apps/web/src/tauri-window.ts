/**
 * Tauri-only window helpers. Every call is guarded by isTauriRuntime() so the
 * browser /companion debug page (and any non-Tauri test environment) never
 * touches the Tauri IPC bridge.
 */
import { withActionDeadline } from "./action-deadline.js";

export async function invokeDesktop<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  return withActionDeadline(
    (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      return args === undefined ? invoke<T>(command) : invoke<T>(command, args);
    })()
  );
}

/** Subscribe before the initial read; focus recovers from a missed desktop event. */
export function subscribeSurfaceChanged(
  refresh: () => void,
  onError: (error: unknown) => void
): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  window.addEventListener("focus", refresh);
  void import("@tauri-apps/api/event")
    .then(async ({ listen }) => {
      if (disposed) return;
      const remove = await listen("desktop-surface.changed", refresh);
      if (disposed) remove();
      else {
        unlisten = remove;
        refresh();
      }
    })
    .catch((error) => {
      if (!disposed) onError(error);
    });
  return () => {
    disposed = true;
    unlisten?.();
    window.removeEventListener("focus", refresh);
  };
}

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

export async function startWindowDragging(): Promise<void> {
  if (!isTauriRuntime()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().startDragging();
}

export type CompanionWindowAction =
  | "show_companion"
  | "hide_companion"
  | "toggle_companion"
  | "reopen_companion";

export async function controlCompanionWindow(action: CompanionWindowAction): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeDesktop(action);
}

export type CompanionPresentationState = {
  visible: boolean;
};

export async function getCompanionPresentationState(): Promise<CompanionPresentationState> {
  if (!isTauriRuntime()) return { visible: false };
  return invokeDesktop<CompanionPresentationState>("get_companion_presentation_state");
}

/** Show the existing lazy WebUI desktop surface. Settings live there, not in Main Chat. */
export async function controlWebUIWindow(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeDesktop("show_webui");
}

export type SubtitlePresentationState = {
  visible: boolean;
  locked: boolean;
};

export async function controlSubtitleWindow(action: "show" | "hide"): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeDesktop(action === "show" ? "show_subtitle" : "hide_subtitle");
}

export async function getSubtitlePresentationState(): Promise<SubtitlePresentationState> {
  if (!isTauriRuntime()) return { visible: false, locked: false };
  return invokeDesktop<SubtitlePresentationState>("get_subtitle_presentation_state");
}

export async function setSubtitleLocked(locked: boolean): Promise<SubtitlePresentationState> {
  if (!isTauriRuntime()) return { visible: false, locked };
  return invokeDesktop<SubtitlePresentationState>("set_subtitle_locked", { locked });
}
