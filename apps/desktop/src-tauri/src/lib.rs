mod config;
mod lifecycle;
mod packaging;
mod supervisor;

/// Unix process-level owner lifecycle: SIGINT/SIGTERM must reach the graceful
/// exit path (`ExitRequested` → Supervisor drain → terminal exit) instead of
/// the default disposition, which would kill the shell and orphan the entire
/// owned process tree. The handler itself only writes one byte to a self-pipe
/// (async-signal-safe); a plain thread turns it into an app exit.
#[cfg(unix)]
mod signal_exit {
  use std::os::unix::io::RawFd;
  use std::sync::atomic::{AtomicI32, Ordering};

  static SIGNAL_PIPE_WRITE_FD: AtomicI32 = AtomicI32::new(-1);

  extern "C" fn on_termination_signal(sig: libc::c_int) {
    let fd = SIGNAL_PIPE_WRITE_FD.load(Ordering::SeqCst);
    if fd >= 0 {
      let byte = sig as u8;
      unsafe {
        libc::write(fd, &byte as *const u8 as *const libc::c_void, 1);
      }
    }
  }

  fn set_cloexec(fd: RawFd) {
    unsafe {
      libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
    }
  }

  /// Install SIGINT/SIGTERM handlers → self-pipe. Returns the read end.
  /// Handlers reset to default across exec, so the Supervisor child's own
  /// SIGTERM handling is unaffected.
  pub fn install() -> Option<RawFd> {
    unsafe {
      let mut fds: [libc::c_int; 2] = [0; 2];
      if libc::pipe(fds.as_mut_ptr()) != 0 {
        return None;
      }
      let (read_fd, write_fd) = (fds[0], fds[1]);
      set_cloexec(read_fd);
      set_cloexec(write_fd);
      SIGNAL_PIPE_WRITE_FD.store(write_fd, Ordering::SeqCst);

      let mut action: libc::sigaction = std::mem::zeroed();
      action.sa_sigaction = on_termination_signal as *const () as libc::sighandler_t;
      action.sa_flags = libc::SA_RESTART;
      libc::sigemptyset(&mut action.sa_mask);
      for sig in [libc::SIGTERM, libc::SIGINT] {
        if libc::sigaction(sig, &action, std::ptr::null_mut()) != 0 {
          return None;
        }
      }
      Some(read_fd)
    }
  }

  /// Turn pipe bytes into a graceful app exit on the main thread.
  pub fn spawn_exit_reader(app: tauri::AppHandle, read_fd: RawFd) {
    std::thread::Builder::new()
      .name("yuvi-signal-exit".into())
      .spawn(move || {
        let mut byte = [0u8; 1];
        loop {
          let n = unsafe { libc::read(read_fd, byte.as_mut_ptr().cast(), 1) };
          if n <= 0 {
            if n < 0
              && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR)
            {
              continue;
            }
            break;
          }
          eprintln!("[yuvi-desktop] termination signal received; exiting gracefully");
          let exit_app = app.clone();
          let scheduled = app.run_on_main_thread(move || {
            exit_app.exit(0);
          });
          if scheduled.is_err() {
            // Main loop already gone — the OS will reap what remains.
          }
          break;
        }
      })
      .ok();
  }
}

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

// TEMPORARY DIAG229/DIAG230 instrumentation (tray-quit exit-chain investigation).
// Emits one greppable stderr marker per exit-chain checkpoint (C1..C11).
// Error-tolerant on purpose: a broken stderr pipe must never panic here
// (release builds use panic=abort) and must not change control flow.
// Remove this helper and every diag229/emit_diag_line call once the
// investigation lands.
fn diag229(marker: &str) {
  emit_diag_line(&format!("DIAG229 {marker}"));
}

fn emit_diag_line(line: &str) {
  use std::io::Write;
  let mut stderr = std::io::stderr();
  let _ = writeln!(
    stderr,
    "{line} pid={} thread={:?}",
    std::process::id(),
    std::thread::current().id()
  );
}

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
  diag229("C10 begin_app_shutdown_enter");
  if !claim_app_shutdown() {
    diag229("C9 shutdown_gate_rejected");
    return;
  }
  diag229("C9 shutdown_gate_claimed");
  let supervisor_shutdown_started = std::time::Instant::now();
  supervisor::shutdown_supervisor(app);
  emit_diag_line(&format!(
    "DIAG230 C11 shutdown_supervisor_returned elapsed_ms={}",
    supervisor_shutdown_started.elapsed().as_millis()
  ));
}

fn request_app_exit(app: &tauri::AppHandle) {
  let already_started = app_shutdown_started();
  diag229(&format!(
    "C4 request_app_exit_enter already_started={already_started}"
  ));
  if !already_started {
    // A tray menu listener runs while Tauri is dispatching the menu event.
    // Queue the exit request as a later main-thread task so the nested
    // RequestExit event is not posted from inside that dispatch.
    let app = app.clone();
    diag229("C5 exit_deferred_scheduled");
    std::thread::spawn(move || {
      diag229("C6 exit_deferred_running");
      let exit_app = app.clone();
      let fallback_app = app.clone();
      let result = app.run_on_main_thread(move || {
        diag229("C7 app_exit_call");
        exit_app.exit(0);
      });
      diag229(&format!("C7r run_on_main_thread_done ok={}", result.is_ok()));
      if let Err(error) = result {
        eprintln!("[yuvi-desktop] failed to schedule app exit: {error}");
        diag229("C7 app_exit_call");
        fallback_app.exit(0);
      }
    });
  } else {
    diag229("C4b exit_suppressed_already_started");
  }
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
    .on_menu_event(|app, event| {
      diag229(&format!("C1 menu_event id={}", event.id.as_ref()));
      let action = tray_action(event.id.as_ref());
      diag229(&format!("C2 mapped={action:?}"));
      match action {
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
        Some(TrayAction::Quit) => {
          diag229("C3 dispatch_quit_enter");
          request_app_exit(app);
        }
        None => {}
      }
    })
    .build(app)?;

  Ok(())
}

pub fn run() {
  // Owner lifecycle: route termination signals into the graceful exit path
  // before any thread exists, so the Supervisor tree is always drained.
  #[cfg(unix)]
  let signal_read_fd = signal_exit::install();

  tauri::Builder::default()
    .manage(supervisor::SupervisorState::default())
    .setup(move |app| {
      // Config must load even when Runtime/Supervisor are unavailable.
      let config_service = config::init_config_service(&app.handle())
        .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
      let always_on_top = config_service
        .current_settings()
        .map(|s| s.companion.always_on_top)
        .unwrap_or(true);
      let env_overrides = config_service.supervisor_env().ok();
      app.manage(config::ConfigState::new(config_service));

      #[cfg(unix)]
      if let Some(read_fd) = signal_read_fd {
        signal_exit::spawn_exit_reader(app.handle().clone(), read_fd);
      }

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
      if let RunEvent::ExitRequested { code, .. } = event {
        diag229(&format!("C8 exit_requested code={code:?}"));
        begin_app_shutdown(app_handle);
      }
      if let RunEvent::Exit = event {
        diag229("C8x run_event_exit");
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

  /// SIGTERM must land in the self-pipe so the reader thread can start the
  /// graceful exit; a dead default disposition would orphan the owned tree.
  #[cfg(unix)]
  #[test]
  fn termination_signal_reaches_the_exit_self_pipe() {
    let read_fd = super::signal_exit::install().expect("self-pipe installed");
    unsafe {
      assert_eq!(libc::raise(libc::SIGTERM), 0);
      let mut byte = [0u8; 1];
      let n = libc::read(read_fd, byte.as_mut_ptr().cast(), 1);
      assert_eq!(n, 1);
    }
  }
}
