mod config;
mod packaging;
mod supervisor;

use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use tauri::{Manager, RunEvent};

/// Main chat window surface. Hash routing keeps the single static build
/// working in both dev (Vite dev server) and packaged (frontendDist) mode.
const MAIN_WINDOW_URL: &str = "index.html#/main";

/// Companion window surface that exclusively owns Lumi, speech playback and
/// the Web Audio analysis chain.
const COMPANION_WINDOW_URL: &str = "index.html#/companion";

static EXIT_CLEANUP_STARTED: AtomicBool = AtomicBool::new(false);

fn claim_app_shutdown() -> bool {
  !EXIT_CLEANUP_STARTED.swap(true, Ordering::SeqCst)
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
      let main_window = tauri::WebviewWindowBuilder::new(
        app,
        "main",
        tauri::WebviewUrl::App(MAIN_WINDOW_URL.into()),
      )
      .title("YUVI Chat")
      .inner_size(960.0, 760.0)
      .min_inner_size(640.0, 480.0)
      .build()?;

      build_companion_window(&app.handle(), always_on_top)?;
      main_window.set_focus()?;

      // Best-effort supervisor bootstrap with user settings env injection.
      if let Err(error) = supervisor::bootstrap_supervisor(&app.handle(), env_overrides) {
        eprintln!("[yuvi-desktop] supervisor bootstrap skipped: {error}");
      }

      Ok(())
    })
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == "companion" {
          // Closing companion must NOT shut down Runtime/Mem0/TTS.
          return;
        }
        if window.label() == "main" {
          // `WebviewWindow::destroy()` below emits another CloseRequested.
          // Let that internal close through after the cleanup claim, while
          // preventing the original user/system close until services stop.
          if !claim_app_shutdown() {
            return;
          }
          api.prevent_close();
          let app = window.app_handle().clone();
          let win = window.clone();
          thread::spawn(move || {
            supervisor::shutdown_supervisor(&app);
            thread::sleep(Duration::from_millis(1200));
            let _ = win.destroy();
            app.exit(0);
          });
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
