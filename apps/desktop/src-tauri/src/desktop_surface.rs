//! Presentation seam for the desktop surfaces that exist today: Main (chat),
//! Companion, WebUI, and Subtitle. `DesktopSurfaceManager` is the only authority
//! for ensure/show/hide/toggle/focus on these surfaces and for their window
//! construction inputs. Application Quit and Runtime/Supervisor lifecycle stay
//! outside this seam.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Window};

use crate::config;

/// Surfaces that exist in the product today. Adding a surface is an explicit
/// atom-level decision, not a convenience.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SurfaceId {
  Main,
  Companion,
  WebUI,
  Subtitle,
}

impl SurfaceId {
  fn window_label(self) -> &'static str {
    match self {
      SurfaceId::Main => "main",
      SurfaceId::Companion => "companion",
      SurfaceId::WebUI => "webui",
      SurfaceId::Subtitle => "subtitle",
    }
  }

  /// Window captions are load-bearing: the Linux KDE close/tray validation
  /// locates windows through KWin captions ("YUVI Chat").
  fn window_title(self) -> &'static str {
    match self {
      SurfaceId::Main => "YUVI Chat",
      SurfaceId::Companion => "YUVI Companion",
      SurfaceId::WebUI => "YUVI WebUI",
      SurfaceId::Subtitle => "YUVI Subtitle",
    }
  }

  /// Hash routing keeps the single static build working in both dev (Vite dev
  /// server) and packaged (frontendDist) mode.
  fn window_url(self) -> &'static str {
    match self {
      SurfaceId::Main => "index.html#/main",
      SurfaceId::Companion => "index.html#/companion",
      SurfaceId::WebUI => "index.html#/dashboard",
      SurfaceId::Subtitle => "index.html#/subtitle",
    }
  }

  /// Main / Companion / WebUI show and focus; Subtitle shows without stealing
  /// focus so chat/companion interaction stays uninterrupted.
  fn show_steals_focus(self) -> bool {
    !matches!(self, SurfaceId::Subtitle)
  }
}

/// Presentation-only surface commands. Nothing here may start, stop, or probe
/// Runtime/Supervisor state, and nothing here may exit the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SurfaceCommand {
  /// Ensure the surface exists and show it. Focus follows `SurfaceId` policy.
  Show,
  /// Hide the surface when it exists; absent surfaces stay absent.
  Hide,
  /// Show (with surface focus policy) when hidden, hide when visible.
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


const COMPANION_GEOMETRY_FILE: &str = "companion-window.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct CompanionWindowGeometry {
  x: Option<i32>,
  y: Option<i32>,
  width: u32,
  height: u32,
}

impl CompanionWindowGeometry {
  fn is_valid(self) -> bool {
    let position_valid = match (self.x, self.y) {
      (Some(x), Some(y)) => {
        (-100_000..=100_000).contains(&x) && (-100_000..=100_000).contains(&y)
      }
      (None, None) => true,
      _ => false,
    };
    (320..=16_384).contains(&self.width)
      && (480..=16_384).contains(&self.height)
      && position_valid
  }
}

fn companion_geometry_path(app: &AppHandle) -> Result<PathBuf, String> {
  app
    .path()
    .app_config_dir()
    .map(|dir| dir.join(COMPANION_GEOMETRY_FILE))
    .map_err(|error| format!("app_config_dir unavailable: {error}"))
}

fn read_companion_window_geometry(path: &Path) -> Option<CompanionWindowGeometry> {
  let text = fs::read_to_string(path).ok()?;
  let geometry = serde_json::from_str::<CompanionWindowGeometry>(&text).ok()?;
  geometry.is_valid().then_some(geometry)
}

fn write_companion_window_geometry(
  path: &Path,
  geometry: CompanionWindowGeometry,
) -> Result<(), String> {
  if !geometry.is_valid() {
    return Err("companion window geometry is out of bounds".into());
  }
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let bytes = serde_json::to_vec(&geometry).map_err(|error| error.to_string())?;
  fs::write(path, bytes).map_err(|error| error.to_string())
}

fn restore_companion_window_geometry(app: &AppHandle, window: &tauri::WebviewWindow) {
  let Some(geometry) = companion_geometry_path(app)
    .ok()
    .and_then(|path| read_companion_window_geometry(&path))
  else {
    return;
  };
  let _ = window.set_size(PhysicalSize::new(geometry.width, geometry.height));
  if let (Some(x), Some(y)) = (geometry.x, geometry.y) {
    let _ = window.set_position(PhysicalPosition::new(x, y));
  }
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
  let window = tauri::WebviewWindowBuilder::new(
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
  .build()?;
  restore_companion_window_geometry(app, &window);
  Ok(window)
}

fn build_webui_window(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
  tauri::WebviewWindowBuilder::new(
    app,
    SurfaceId::WebUI.window_label(),
    tauri::WebviewUrl::App(SurfaceId::WebUI.window_url().into()),
  )
  .title(SurfaceId::WebUI.window_title())
  .inner_size(1280.0, 820.0)
  .min_inner_size(800.0, 600.0)
  .resizable(true)
  .build()
}

/// Subtitle overlay construction inputs. Pure policy helpers below keep these
/// values testable without a live Tauri runtime.
fn subtitle_window_policy() -> SubtitleWindowPolicy {
  SubtitleWindowPolicy {
    width: 720.0,
    height: 140.0,
    decorations: false,
    transparent: true,
    always_on_top: true,
    resizable: false,
    skip_taskbar: true,
    focused_on_create: false,
    visible_on_create: false,
    click_through: true,
  }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct SubtitleWindowPolicy {
  width: f64,
  height: f64,
  decorations: bool,
  transparent: bool,
  always_on_top: bool,
  resizable: bool,
  skip_taskbar: bool,
  focused_on_create: bool,
  visible_on_create: bool,
  click_through: bool,
}

fn build_subtitle_window(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
  let policy = subtitle_window_policy();
  let window = tauri::WebviewWindowBuilder::new(
    app,
    SurfaceId::Subtitle.window_label(),
    tauri::WebviewUrl::App(SurfaceId::Subtitle.window_url().into()),
  )
  .title(SurfaceId::Subtitle.window_title())
  .inner_size(policy.width, policy.height)
  .min_inner_size(policy.width, policy.height)
  .max_inner_size(policy.width, policy.height)
  .decorations(policy.decorations)
  .transparent(policy.transparent)
  .always_on_top(policy.always_on_top)
  .resizable(policy.resizable)
  .skip_taskbar(policy.skip_taskbar)
  .focused(policy.focused_on_create)
  .visible(policy.visible_on_create)
  .build()?;

  // Best-effort lower-center placement. Failure must not block ensure/show.
  if let Ok(Some(monitor)) = window.primary_monitor() {
    let size = monitor.size();
    let scale = monitor.scale_factor();
    let width = (policy.width * scale) as i32;
    let height = (policy.height * scale) as i32;
    let margin = (48.0 * scale) as i32;
    let x = (size.width as i32 - width) / 2;
    let y = (size.height as i32 - height - margin).max(0);
    let _ = window.set_position(PhysicalPosition::new(x, y));
  }

  Ok(window)
}

/// Toggle semantics: hidden → show (with surface focus policy), visible → hide.
fn toggle_window_visible(
  window: &tauri::WebviewWindow,
  steal_focus: bool,
) -> Result<(), String> {
  let visible = window.is_visible().map_err(|error| error.to_string())?;
  if visible {
    window.hide().map_err(|error| error.to_string())
  } else {
    show_window(window, steal_focus)
  }
}

fn show_window(window: &tauri::WebviewWindow, steal_focus: bool) -> Result<(), String> {
  window.show().map_err(|error| error.to_string())?;
  // Tao/GTK requires a realized native window before applying the input shape.
  // A lazily constructed, hidden Subtitle has none until Show is processed.
  if window.label() == SurfaceId::Subtitle.window_label() && subtitle_window_policy().click_through {
    window.set_ignore_cursor_events(true).map_err(|error| error.to_string())?;
  }
  if steal_focus {
    window.set_focus().map_err(|error| error.to_string())?;
  }
  Ok(())
}

/// Desktop presentation infrastructure: the single owner of Main, Companion,
/// WebUI, and Subtitle window creation and show/hide/toggle/focus behavior.
/// Zero state — window identity lives in the Tauri window registry; this type
/// only routes presentation commands onto it.
pub(crate) struct DesktopSurfaceManager;

impl DesktopSurfaceManager {
  /// Ensure an existing surface exists, reusing the live window instead of
  /// rebuilding it. Window construction inputs (including Companion
  /// always-on-top and Subtitle overlay policy) resolve inside this seam.
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
      SurfaceId::WebUI => existing_or_create(
        app.get_webview_window(SurfaceId::WebUI.window_label()),
        || build_webui_window(app),
      ),
      SurfaceId::Subtitle => existing_or_create(
        app.get_webview_window(SurfaceId::Subtitle.window_label()),
        || build_subtitle_window(app),
      ),
    }
  }

  /// Dispatch one presentation command onto one existing surface.
  pub(crate) fn execute(
    app: &AppHandle,
    surface: SurfaceId,
    command: SurfaceCommand,
  ) -> Result<(), String> {
    match command {
      SurfaceCommand::Show => Self::show(app, surface),
      SurfaceCommand::Hide => Self::hide(app, surface),
      SurfaceCommand::Toggle => Self::toggle(app, surface),
    }
  }

  /// Persist only Companion presentation geometry. Runtime/User settings remain
  /// under their existing authorities; this file is desktop-surface state.
  pub(crate) fn persist_companion_geometry(window: &Window) {
    if window.label() != SurfaceId::Companion.window_label() {
      return;
    }
    let Ok(size) = window.inner_size() else {
      return;
    };
    let Ok(path) = companion_geometry_path(window.app_handle()) else {
      return;
    };
    let previous = read_companion_window_geometry(&path);
    let position = window.outer_position().ok();
    let geometry = CompanionWindowGeometry {
      x: position.map(|value| value.x).or_else(|| previous.and_then(|value| value.x)),
      y: position.map(|value| value.y).or_else(|| previous.and_then(|value| value.y)),
      width: size.width,
      height: size.height,
    };
    if let Err(error) = write_companion_window_geometry(&path, geometry) {
      eprintln!("[yuvi-desktop] companion geometry persistence skipped: {error}");
    }
  }

  /// Apply the configured Companion always-on-top presentation to the live
  /// window when settings change. Best-effort, as before.
  pub(crate) fn apply_companion_always_on_top(app: &AppHandle, always_on_top: bool) {
    if let Some(window) = app.get_webview_window(SurfaceId::Companion.window_label()) {
      let _ = window.set_always_on_top(always_on_top);
    }
  }

  fn show(app: &AppHandle, surface: SurfaceId) -> Result<(), String> {
    let window = Self::ensure(app, surface).map_err(|error| error.to_string())?;
    show_window(&window, surface.show_steals_focus())
  }

  fn hide(app: &AppHandle, surface: SurfaceId) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(surface.window_label()) {
      window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
  }

  fn toggle(app: &AppHandle, surface: SurfaceId) -> Result<(), String> {
    let window = Self::ensure(app, surface).map_err(|error| error.to_string())?;
    toggle_window_visible(&window, surface.show_steals_focus())
  }
}

#[cfg(test)]
mod tests {
  use super::{
    companion_always_on_top_or_default, existing_or_create, read_companion_window_geometry,
    subtitle_window_policy, write_companion_window_geometry, CompanionWindowGeometry, SurfaceId,
  };
  use std::fs;

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


  #[test]
  fn companion_geometry_roundtrips_and_rejects_invalid_state() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("companion-window.json");
    let geometry = CompanionWindowGeometry {
      x: Some(120),
      y: Some(80),
      width: 640,
      height: 900,
    };
    write_companion_window_geometry(&path, geometry).expect("write geometry");
    assert_eq!(read_companion_window_geometry(&path), Some(geometry));

    fs::write(&path, r#"{"x":null,"y":null,"width":640,"height":900}"#).expect("write size-only");
    assert_eq!(
      read_companion_window_geometry(&path),
      Some(CompanionWindowGeometry { x: None, y: None, width: 640, height: 900 })
    );

    fs::write(&path, r#"{"x":0,"y":null,"width":640,"height":900}"#).expect("write partial position");
    assert_eq!(read_companion_window_geometry(&path), None);
  }

  /// Validated Linux desktop contract: Main, Companion, WebUI, and Subtitle
  /// exist, with the labels/captions/routes the KDE harness locates them by.
  #[test]
  fn surface_contracts_cover_main_companion_webui_and_subtitle() {
    assert_eq!(SurfaceId::Main.window_label(), "main");
    assert_eq!(SurfaceId::Main.window_title(), "YUVI Chat");
    assert_eq!(SurfaceId::Main.window_url(), "index.html#/main");
    assert_eq!(SurfaceId::Companion.window_label(), "companion");
    assert_eq!(SurfaceId::Companion.window_title(), "YUVI Companion");
    assert_eq!(SurfaceId::Companion.window_url(), "index.html#/companion");
    assert_eq!(SurfaceId::WebUI.window_label(), "webui");
    assert_eq!(SurfaceId::WebUI.window_title(), "YUVI WebUI");
    assert_eq!(SurfaceId::WebUI.window_url(), "index.html#/dashboard");
    assert_eq!(SurfaceId::Subtitle.window_label(), "subtitle");
    assert_eq!(SurfaceId::Subtitle.window_title(), "YUVI Subtitle");
    assert_eq!(SurfaceId::Subtitle.window_url(), "index.html#/subtitle");
  }

  #[test]
  fn subtitle_show_does_not_steal_focus_while_others_do() {
    assert!(SurfaceId::Main.show_steals_focus());
    assert!(SurfaceId::Companion.show_steals_focus());
    assert!(SurfaceId::WebUI.show_steals_focus());
    assert!(!SurfaceId::Subtitle.show_steals_focus());
  }

  #[test]
  fn subtitle_window_policy_is_overlay_bounded_and_non_chrome() {
    let policy = subtitle_window_policy();
    assert!(!policy.decorations);
    assert!(policy.transparent);
    assert!(policy.always_on_top);
    assert!(!policy.resizable);
    assert!(policy.skip_taskbar);
    assert!(!policy.focused_on_create);
    assert!(!policy.visible_on_create);
    assert!(policy.click_through);
    assert!(policy.width > 0.0 && policy.height > 0.0);
    assert!(policy.height <= 200.0, "subtitle stays a short overlay band");
  }

  #[test]
  fn main_companion_webui_contracts_unchanged_from_atom_04() {
    assert_eq!(SurfaceId::Main.window_label(), "main");
    assert_eq!(SurfaceId::Companion.window_label(), "companion");
    assert_eq!(SurfaceId::WebUI.window_label(), "webui");
    assert_eq!(SurfaceId::Main.window_title(), "YUVI Chat");
    assert_eq!(SurfaceId::Companion.window_title(), "YUVI Companion");
    assert_eq!(SurfaceId::WebUI.window_title(), "YUVI WebUI");
  }
}
