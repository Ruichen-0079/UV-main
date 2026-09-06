//! Presentation seam for the desktop surfaces that exist today: Main (chat)
//! and Companion. `DesktopSurfaceManager` is the only authority for
//! ensure/show/hide/toggle/focus on these surfaces and for their window
//! construction inputs. Application Quit and Runtime/Supervisor lifecycle
//! stay outside this seam.

use tauri::{AppHandle, Manager};

use crate::config;

/// Surfaces that exist in the product today. Adding a surface is an explicit
/// atom-level decision, not a convenience.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SurfaceId {
  Main,
  Companion,
}

impl SurfaceId {
  fn window_label(self) -> &'static str {
    match self {
      SurfaceId::Main => "main",
      SurfaceId::Companion => "companion",
    }
  }

  /// Window captions are load-bearing: the Linux KDE close/tray validation
  /// locates windows through KWin captions ("YUVI Chat").
  fn window_title(self) -> &'static str {
    match self {
      SurfaceId::Main => "YUVI Chat",
      SurfaceId::Companion => "YUVI Companion",
    }
  }

  /// Hash routing keeps the single static build working in both dev (Vite dev
  /// server) and packaged (frontendDist) mode.
  fn window_url(self) -> &'static str {
    match self {
      SurfaceId::Main => "index.html#/main",
      SurfaceId::Companion => "index.html#/companion",
    }
  }
}

/// Presentation-only surface commands. Nothing here may start, stop, or probe
/// Runtime/Supervisor state, and nothing here may exit the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SurfaceCommand {
  /// Ensure the surface exists, show it, and focus it.
  Show,
  /// Hide the surface when it exists; absent surfaces stay absent.
  Hide,
  /// Show-and-focus when hidden, hide when visible.
  Toggle,
}

fn existing_or_create<T>(
  existing: Option<T>,
  create: impl FnOnce() -> tauri::Result<T>,
) -> tauri::Result<T> {
  match existing {
    Some(window) => Ok(window),
    None => create(),
  }
}

/// Companion presentation default: always-on-top unless the configured
/// settings say otherwise (including when settings are unavailable).
fn companion_always_on_top_or_default(configured: Option<bool>) -> bool {
  configured.unwrap_or(true)
}

fn companion_always_on_top_from_state(app: &AppHandle) -> bool {
  let configured = app
    .try_state::<config::ConfigState>()
    .and_then(|state| state.service.current_settings().ok())
    .map(|s| s.companion.always_on_top);
  companion_always_on_top_or_default(configured)
}

fn build_main_window(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
  tauri::WebviewWindowBuilder::new(
    app,
    SurfaceId::Main.window_label(),
    tauri::WebviewUrl::App(SurfaceId::Main.window_url().into()),
  )
  .title(SurfaceId::Main.window_title())
  .inner_size(960.0, 760.0)
  .min_inner_size(640.0, 480.0)
  .build()
}

fn build_companion_window(
  app: &AppHandle,
  always_on_top: bool,
) -> tauri::Result<tauri::WebviewWindow> {
  tauri::WebviewWindowBuilder::new(
    app,
    SurfaceId::Companion.window_label(),
    tauri::WebviewUrl::App(SurfaceId::Companion.window_url().into()),
  )
  .title(SurfaceId::Companion.window_title())
  .inner_size(480.0, 720.0)
  .min_inner_size(320.0, 480.0)
  .decorations(false)
  .transparent(true)
  .always_on_top(always_on_top)
  .resizable(true)
  .build()
}

/// Toggle semantics shared by every surface: hidden → show-and-focus,
/// visible → hide.
fn toggle_window_visible(window: &tauri::WebviewWindow) -> Result<(), String> {
  let visible = window.is_visible().map_err(|error| error.to_string())?;
  if visible {
    window.hide().map_err(|error| error.to_string())
  } else {
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
  }
}

/// Desktop presentation infrastructure: the single owner of Main/Companion
/// window creation and show/hide/toggle/focus behavior. Zero state — window
/// identity lives in the Tauri window registry; this type only routes
/// presentation commands onto it.
pub(crate) struct DesktopSurfaceManager;

impl DesktopSurfaceManager {
  /// Ensure an existing surface exists, reusing the live window instead of
  /// rebuilding it. Window construction inputs (including Companion
  /// always-on-top) resolve inside this seam, as before.
  pub(crate) fn ensure(
    app: &AppHandle,
    surface: SurfaceId,
  ) -> tauri::Result<tauri::WebviewWindow> {
    match surface {
      SurfaceId::Main => existing_or_create(
        app.get_webview_window(SurfaceId::Main.window_label()),
        || build_main_window(app),
      ),
      SurfaceId::Companion => existing_or_create(
        app.get_webview_window(SurfaceId::Companion.window_label()),
        || build_companion_window(app, companion_always_on_top_from_state(app)),
      ),
    }
  }

  /// Dispatch one presentation command onto one existing surface.
  pub(crate) fn execute(
    app: &AppHandle,
    surface: SurfaceId,
    command: SurfaceCommand,
  ) -> Result<(), String> {
    match surface {
      SurfaceId::Main => match command {
        SurfaceCommand::Show => Self::show_main(app),
        SurfaceCommand::Hide => Self::hide_main(app),
        SurfaceCommand::Toggle => Self::toggle_main(app),
      },
      SurfaceId::Companion => match command {
        SurfaceCommand::Show => Self::show_companion(app),
        SurfaceCommand::Hide => Self::hide_companion(app),
        SurfaceCommand::Toggle => Self::toggle_companion(app),
      },
    }
  }

  /// Apply the configured Companion always-on-top presentation to the live
  /// window when settings change. Best-effort, as before.
  pub(crate) fn apply_companion_always_on_top(app: &AppHandle, always_on_top: bool) {
    if let Some(window) = app.get_webview_window(SurfaceId::Companion.window_label()) {
      let _ = window.set_always_on_top(always_on_top);
    }
  }

  fn show_main(app: &AppHandle) -> Result<(), String> {
    let window = Self::ensure(app, SurfaceId::Main).map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
  }

  fn hide_main(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(SurfaceId::Main.window_label()) {
      window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
  }

  fn toggle_main(app: &AppHandle) -> Result<(), String> {
    let window = Self::ensure(app, SurfaceId::Main).map_err(|error| error.to_string())?;
    toggle_window_visible(&window)
  }

  fn show_companion(app: &AppHandle) -> Result<(), String> {
    let window = Self::ensure(app, SurfaceId::Companion).map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
  }

  fn hide_companion(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(SurfaceId::Companion.window_label()) {
      window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
  }

  fn toggle_companion(app: &AppHandle) -> Result<(), String> {
    let window = Self::ensure(app, SurfaceId::Companion).map_err(|error| error.to_string())?;
    toggle_window_visible(&window)
  }
}

#[cfg(test)]
mod tests {
  use super::{companion_always_on_top_or_default, existing_or_create, SurfaceId};

  #[test]
  fn existing_surface_is_reused_without_creation() {
    let mut create_calls = 0;
    let surface = existing_or_create(Some(7u32), || {
      create_calls += 1;
      Ok(7)
    })
    .expect("existing surface must be returned");
    assert_eq!(surface, 7);
    assert_eq!(create_calls, 0, "an existing surface must not be rebuilt");
  }

  #[test]
  fn missing_surface_is_created_lazily_exactly_once() {
    let mut create_calls = 0;
    let surface = existing_or_create(None::<u32>, || {
      create_calls += 1;
      Ok(7)
    })
    .expect("missing surface must be created");
    assert_eq!(surface, 7);
    assert_eq!(create_calls, 1);
  }

  #[test]
  fn companion_presentation_defaults_to_always_on_top() {
    assert!(companion_always_on_top_or_default(None));
    assert!(companion_always_on_top_or_default(Some(true)));
    assert!(!companion_always_on_top_or_default(Some(false)));
  }

  /// The validated Linux desktop contract: exactly Main and Companion exist,
  /// with the labels and captions the KDE close/tray harness locates them by.
  #[test]
  fn surface_contracts_cover_exactly_the_existing_main_and_companion() {
    assert_eq!(SurfaceId::Main.window_label(), "main");
    assert_eq!(SurfaceId::Main.window_title(), "YUVI Chat");
    assert_eq!(SurfaceId::Main.window_url(), "index.html#/main");
    assert_eq!(SurfaceId::Companion.window_label(), "companion");
    assert_eq!(SurfaceId::Companion.window_title(), "YUVI Companion");
    assert_eq!(SurfaceId::Companion.window_url(), "index.html#/companion");
  }
}
