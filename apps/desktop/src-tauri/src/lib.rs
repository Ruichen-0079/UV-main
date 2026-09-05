mod config;
mod desktop_surface;
mod lifecycle;
mod packaging;
mod supervisor;
mod tray;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, RunEvent};

static APP_SHUTDOWN: lifecycle::ShutdownGate = lifecycle::ShutdownGate::new();

fn claim_app_shutdown() -> bool {
  APP_SHUTDOWN.claim()
}

fn app_shutdown_started() -> bool {
  APP_SHUTDOWN.is_claimed()
}

#[tauri::command]
fn show_companion(app: tauri::AppHandle) -> Result<(), String> {
  let surfaces = desktop_surface::DesktopSurfaceManager::new(&app);
  surfaces.show(desktop_surface::DesktopSurface::Companion)?;
  surfaces.focus(desktop_surface::DesktopSurface::Companion)
}

#[tauri::command]
fn hide_companion(app: tauri::AppHandle) -> Result<(), String> {
  desktop_surface::DesktopSurfaceManager::new(&app).hide(desktop_surface::DesktopSurface::Companion)
}

#[tauri::command]
fn toggle_companion(app: tauri::AppHandle) -> Result<(), String> {
  desktop_surface::DesktopSurfaceManager::new(&app)
    .toggle(desktop_surface::DesktopSurface::Companion)
}

#[tauri::command]
fn reopen_companion(app: tauri::AppHandle) -> Result<(), String> {
  let surfaces = desktop_surface::DesktopSurfaceManager::new(&app);
  surfaces.show(desktop_surface::DesktopSurface::Companion)?;
  surfaces.focus(desktop_surface::DesktopSurface::Companion)
}

fn begin_app_shutdown(app: &tauri::AppHandle) {
  if !claim_app_shutdown() {
    return;
  }
  supervisor::shutdown_supervisor(app);
}

fn request_app_exit(app: &tauri::AppHandle) {
  if !app_shutdown_started() {
    // A tray menu listener runs while Tauri is dispatching the menu event.
    // Queue the exit request as a later main-thread task so the nested
    // RequestExit event is not posted from inside that dispatch.
    let app = app.clone();
    std::thread::spawn(move || {
      let exit_app = app.clone();
      let fallback_app = app.clone();
      let result = app.run_on_main_thread(move || {
        exit_app.exit(0);
      });
      if let Err(error) = result {
        eprintln!("[yuvi-desktop] failed to schedule app exit: {error}");
        fallback_app.exit(0);
      }
    });
  }
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
  let open_main = MenuItem::with_id(app, tray::TRAY_OPEN_MAIN, "Open YUVI", true, None::<&str>)?;
  let hide_main_item =
    MenuItem::with_id(app, tray::TRAY_HIDE_MAIN, "Hide YUVI", true, None::<&str>)?;
  let show_companion_item =
    MenuItem::with_id(app, tray::TRAY_SHOW_COMPANION, "Show Companion", true, None::<&str>)?;
  let hide_companion_item =
    MenuItem::with_id(app, tray::TRAY_HIDE_COMPANION, "Hide Companion", true, None::<&str>)?;
  let quit = MenuItem::with_id(app, tray::TRAY_QUIT, "Quit", true, None::<&str>)?;
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

  TrayIconBuilder::with_id(tray::TRAY_ID)
    .icon(icon)
    .tooltip("YUVI")
    .menu(&menu)
    .on_menu_event(|app, event| {
      if let Some(command) = tray::command_for_id(event.id.as_ref()) {
        if let Err(error) = tray::dispatch(app, command, request_app_exit) {
          eprintln!("[yuvi-desktop] tray command failed: {error}");
        }
      }
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
      let env_overrides = config_service.supervisor_env().ok();
      app.manage(config::ConfigState::new(config_service));

      // Paint main window immediately — do not block on service startup.
      let surfaces = desktop_surface::DesktopSurfaceManager::new(&app.handle());
      surfaces.ensure(desktop_surface::DesktopSurface::Main)?;
      surfaces.ensure(desktop_surface::DesktopSurface::Companion)?;
      surfaces
        .focus(desktop_surface::DesktopSurface::Main)
        .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
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
  #[test]
  fn tray_icon_asset_is_a_valid_png_resource() {
    let icon = include_bytes!("../icons/icon.png");
    assert_eq!(&icon[..8], b"\x89PNG\r\n\x1a\n");
  }
}
