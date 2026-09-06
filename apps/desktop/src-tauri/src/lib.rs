mod config;
mod desktop_surface;
mod lifecycle;
mod packaging;
mod supervisor;
mod tray;

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

use tauri::{Manager, RunEvent};

use crate::desktop_surface::{DesktopSurfaceManager, SurfaceCommand, SurfaceId};

static APP_SHUTDOWN: lifecycle::ShutdownGate = lifecycle::ShutdownGate::new();

fn claim_app_shutdown() -> bool {
  APP_SHUTDOWN.claim()
}

fn app_shutdown_started() -> bool {
  APP_SHUTDOWN.is_claimed()
}

fn begin_app_shutdown(app: &tauri::AppHandle) {
  if !claim_app_shutdown() {
    return;
  }
  supervisor::shutdown_supervisor(app);
}

/// App exit authority. Tray `Quit` routes here directly — never through the
/// desktop surface seam — so the graceful exit gate stays on the lifecycle
/// path.
pub(crate) fn request_app_exit(app: &tauri::AppHandle) {
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

/// Frontend surface commands stay thin: all window manipulation belongs to
/// the desktop surface seam.
#[tauri::command]
fn show_companion(app: tauri::AppHandle) -> Result<(), String> {
  DesktopSurfaceManager::execute(&app, SurfaceId::Companion, SurfaceCommand::Show)
}

#[tauri::command]
fn hide_companion(app: tauri::AppHandle) -> Result<(), String> {
  DesktopSurfaceManager::execute(&app, SurfaceId::Companion, SurfaceCommand::Hide)
}

#[tauri::command]
fn toggle_companion(app: tauri::AppHandle) -> Result<(), String> {
  DesktopSurfaceManager::execute(&app, SurfaceId::Companion, SurfaceCommand::Toggle)
}

#[tauri::command]
fn reopen_companion(app: tauri::AppHandle) -> Result<(), String> {
  DesktopSurfaceManager::execute(&app, SurfaceId::Companion, SurfaceCommand::Show)
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
      let env_overrides = config_service.supervisor_env().ok();
      app.manage(config::ConfigState::new(config_service));

      #[cfg(unix)]
      if let Some(read_fd) = signal_read_fd {
        signal_exit::spawn_exit_reader(app.handle().clone(), read_fd);
      }

      // Paint Main and Companion immediately — do not block on service
      // startup. WebUI and Subtitle stay lazy and are ensured by their
      // presentation commands. Construction inputs (including Companion
      // always-on-top and Subtitle overlay policy) resolve inside the surface
      // seam, as before.
      let main_window = DesktopSurfaceManager::ensure(&app.handle(), SurfaceId::Main)?;
      DesktopSurfaceManager::ensure(&app.handle(), SurfaceId::Companion)?;
      main_window.set_focus()?;
      tray::build_tray(&app.handle())?;

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
