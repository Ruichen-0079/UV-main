mod config;
mod lifecycle;
mod packaging;
mod supervisor;

use std::thread;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, RunEvent};

/// Main chat window surface. Hash routing keeps the single static build
/// working in both dev (Vite dev server) and packaged (frontendDist) mode.
const MAIN_WINDOW_URL: &str = "index.html#/main";

/// Companion window surface that exclusively owns Lumi, speech playback and
/// the Web Audio analysis chain.
const COMPANION_WINDOW_URL: &str = "index.html#/companion";

const TRAY_ID: &str = "yuvi-tray";
const TRAY_OPEN_MAIN: &str = "tray-open-main";
const TRAY_HIDE_MAIN: &str = "tray-hide-main";
const TRAY_SHOW_COMPANION: &str = "tray-show-companion";
const TRAY_HIDE_COMPANION: &str = "tray-hide-companion";
const TRAY_QUIT: &str = "tray-quit";

static APP_SHUTDOWN: lifecycle::ShutdownGate = lifecycle::ShutdownGate::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayAction {
  OpenMain,
  HideMain,
  ShowCompanion,
  HideCompanion,
  Quit,
}

fn tray_action(id: &str) -> Option<TrayAction> {
  match id {
    TRAY_OPEN_MAIN => Some(TrayAction::OpenMain),
    TRAY_HIDE_MAIN => Some(TrayAction::HideMain),
    TRAY_SHOW_COMPANION => Some(TrayAction::ShowCompanion),
    TRAY_HIDE_COMPANION => Some(TrayAction::HideCompanion),
    TRAY_QUIT => Some(TrayAction::Quit),
    _ => None,
  }
}

fn claim_app_shutdown() -> bool {
  APP_SHUTDOWN.claim()
}

fn app_shutdown_started() -> bool {
  APP_SHUTDOWN.is_claimed()
}

fn build_main_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
  tauri::WebviewWindowBuilder::new(
    app,
    "main",
    tauri::WebviewUrl::App(MAIN_WINDOW_URL.into()),
  )
  .title("YUVI Chat")
  .inner_size(960.0, 760.0)
  .min_inner_size(640.0, 480.0)
  .build()
}

fn ensure_main_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
  if let Some(window) = app.get_webview_window("main") {
    return Ok(window);
  }
  build_main_window(app)
}

fn build_companion_window(
  app: &tauri::AppHandle,
  always_on_top: bool,
) -> tauri::Result<tauri::WebviewWindow> {
  tauri::WebviewWindowBuilder::new(
    app,
    "companion",
    tauri::WebviewUrl::App(COMPANION_WINDOW_URL.into()),
  )
  .title("YUVI Companion")
  .inner_size(480.0, 720.0)
  .min_inner_size(320.0, 480.0)
  .decorations(false)
  .transparent(true)
  .always_on_top(always_on_top)
  .resizable(true)
  .build()
}

fn ensure_companion_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
  if let Some(window) = app.get_webview_window("companion") {
    return Ok(window);
  }
  let always_on_top = app
    .try_state::<config::ConfigState>()
    .and_then(|state| state.service.current_settings().ok())
    .map(|s| s.companion.always_on_top)
    .unwrap_or(true);
  build_companion_window(app, always_on_top)
}

fn show_main(app: &tauri::AppHandle) -> Result<(), String> {
  let window = ensure_main_window(app).map_err(|error| error.to_string())?;
  window.show().map_err(|error| error.to_string())?;
  window.set_focus().map_err(|error| error.to_string())
}

fn hide_main(app: &tauri::AppHandle) -> Result<(), String> {
  if let Some(window) = app.get_webview_window("main") {
    window.hide().map_err(|error| error.to_string())?;
  }
  Ok(())
}

#[tauri::command]
fn show_companion(app: tauri::AppHandle) -> Result<(), String> {
  let window = ensure_companion_window(&app).map_err(|error| error.to_string())?;
  window.show().map_err(|error| error.to_string())?;
  window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
fn hide_companion(app: tauri::AppHandle) -> Result<(), String> {
  if let Some(window) = app.get_webview_window("companion") {
    window.hide().map_err(|error| error.to_string())?;
  }
  Ok(())
}

#[tauri::command]
fn toggle_companion(app: tauri::AppHandle) -> Result<(), String> {
  let window = ensure_companion_window(&app).map_err(|error| error.to_string())?;
  let visible = window.is_visible().map_err(|error| error.to_string())?;
  if visible {
    window.hide().map_err(|error| error.to_string())
  } else {
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
  }
}

#[tauri::command]
fn reopen_companion(app: tauri::AppHandle) -> Result<(), String> {
  let window = ensure_companion_window(&app).map_err(|error| error.to_string())?;
  window.show().map_err(|error| error.to_string())?;
  window.set_focus().map_err(|error| error.to_string())
}

fn begin_app_shutdown(app: &tauri::AppHandle) {
  if !claim_app_shutdown() {
    return;
  }
  supervisor::shutdown_supervisor(app);
}

fn request_app_exit(app: &tauri::AppHandle) {
  if !claim_app_shutdown() {
    return;
  }

  let app = app.clone();
  thread::spawn(move || {
    supervisor::shutdown_supervisor(&app);
    app.exit(0);
  });
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
  let open_main = MenuItem::with_id(app, TRAY_OPEN_MAIN, "Open YUVI", true, None::<&str>)?;
  let hide_main_item = MenuItem::with_id(app, TRAY_HIDE_MAIN, "Hide YUVI", true, None::<&str>)?;
  let show_companion_item =
    MenuItem::with_id(app, TRAY_SHOW_COMPANION, "Show Companion", true, None::<&str>)?;
  let hide_companion_item =
    MenuItem::with_id(app, TRAY_HIDE_COMPANION, "Hide Companion", true, None::<&str>)?;
  let quit = MenuItem::with_id(app, TRAY_QUIT, "Quit", true, None::<&str>)?;
  let menu = Menu::with_items(
    app,
    &[
      &open_main,
      &hide_main_item,
      &show_companion_item,
      &hide_companion_item,
      &quit,
    ],
  )?;
  let icon = app
    .default_window_icon()
    .cloned()
    .ok_or_else(|| tauri::Error::AssetNotFound("tray icon".into()))?;

  TrayIconBuilder::with_id(TRAY_ID)
    .icon(icon)
    .tooltip("YUVI")
    .menu(&menu)
    .on_menu_event(|app, event| match tray_action(event.id.as_ref()) {
      Some(TrayAction::OpenMain) => {
        if let Err(error) = show_main(app) {
          eprintln!("[yuvi-desktop] failed to open main window: {error}");
        }
      }
      Some(TrayAction::HideMain) => {
        if let Err(error) = hide_main(app) {
          eprintln!("[yuvi-desktop] failed to hide main window: {error}");
        }
      }
      Some(TrayAction::ShowCompanion) => {
        if let Err(error) = show_companion(app.clone()) {
          eprintln!("[yuvi-desktop] failed to show companion window: {error}");
        }
      }
      Some(TrayAction::HideCompanion) => {
        if let Err(error) = hide_companion(app.clone()) {
          eprintln!("[yuvi-desktop] failed to hide companion window: {error}");
        }
      }
      Some(TrayAction::Quit) => request_app_exit(app),
      None => {}
    })
    .build(app)?;

  Ok(())
}

pub fn run() {
  tauri::Builder::default()
    .manage(supervisor::SupervisorState::default())
    .setup(|app| {
      // Config must load even when Runtime/Supervisor are unavailable.
      let config_service = config::init_config_service(&app.handle())
        .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
      let always_on_top = config_service
        .current_settings()
        .map(|s| s.companion.always_on_top)
        .unwrap_or(true);
      let env_overrides = config_service.supervisor_env().ok();
      app.manage(config::ConfigState::new(config_service));

      // Paint main window immediately — do not block on service startup.
      let main_window = build_main_window(&app.handle())?;

      build_companion_window(&app.handle(), always_on_top)?;
      main_window.set_focus()?;
      build_tray(&app.handle())?;

      // Best-effort supervisor bootstrap with user settings env injection.
      if let Err(error) = supervisor::bootstrap_supervisor(&app.handle(), env_overrides) {
        eprintln!("[yuvi-desktop] supervisor bootstrap skipped: {error}");
      }

      Ok(())
    })
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        match lifecycle::window_close_action(window.label(), app_shutdown_started()) {
          lifecycle::WindowCloseAction::Hide => {
            // Ordinary window close is a presentation action. Runtime and its
            // owned children remain under Supervisor control.
            api.prevent_close();
            if let Err(error) = window.hide() {
              eprintln!(
                "[yuvi-desktop] failed to hide {} window on close: {error}",
                window.label()
              );
            }
          }
          lifecycle::WindowCloseAction::AllowClose => {}
        }
      }
    })
    .invoke_handler(tauri::generate_handler![
      show_companion,
      hide_companion,
      toggle_companion,
      reopen_companion,
      supervisor::get_service_status,
      supervisor::refresh_services,
      supervisor::service_action,
      config::get_user_settings,
      config::update_user_settings,
      config::set_user_secret,
      config::delete_user_secret,
      config::get_user_secret_status
    ])
    .build(tauri::generate_context!())
    .expect("error while building YUVI desktop app")
    .run(|app_handle, event| {
      if let RunEvent::ExitRequested { .. } = event {
        begin_app_shutdown(app_handle);
      }
      if let RunEvent::Exit = event {
        begin_app_shutdown(app_handle);
      }
    });
}

#[cfg(test)]
mod tests {
  use super::{tray_action, TrayAction};

  #[test]
  fn tray_actions_cover_every_user_control() {
    assert_eq!(tray_action("tray-open-main"), Some(TrayAction::OpenMain));
    assert_eq!(tray_action("tray-hide-main"), Some(TrayAction::HideMain));
    assert_eq!(
      tray_action("tray-show-companion"),
      Some(TrayAction::ShowCompanion)
    );
    assert_eq!(
      tray_action("tray-hide-companion"),
      Some(TrayAction::HideCompanion)
    );
    assert_eq!(tray_action("tray-quit"), Some(TrayAction::Quit));
    assert_eq!(tray_action("unknown"), None);
  }

  #[test]
  fn tray_icon_asset_is_a_valid_png_resource() {
    let icon = include_bytes!("../icons/icon.png");
    assert_eq!(&icon[..8], b"\x89PNG\r\n\x1a\n");
  }
}
