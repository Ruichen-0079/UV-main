use tauri::AppHandle;

use crate::desktop_surface::{DesktopSurface, DesktopSurfaceManager};

pub(crate) const TRAY_ID: &str = "yuvi-tray";
pub(crate) const TRAY_OPEN_MAIN: &str = "tray-open-main";
pub(crate) const TRAY_HIDE_MAIN: &str = "tray-hide-main";
pub(crate) const TRAY_SHOW_COMPANION: &str = "tray-show-companion";
pub(crate) const TRAY_HIDE_COMPANION: &str = "tray-hide-companion";
pub(crate) const TRAY_QUIT: &str = "tray-quit";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TrayCommand {
  ShowMain,
  HideMain,
  ShowCompanion,
  HideCompanion,
  Quit,
}

pub(crate) fn command_for_id(id: &str) -> Option<TrayCommand> {
  match id {
    TRAY_OPEN_MAIN => Some(TrayCommand::ShowMain),
    TRAY_HIDE_MAIN => Some(TrayCommand::HideMain),
    TRAY_SHOW_COMPANION => Some(TrayCommand::ShowCompanion),
    TRAY_HIDE_COMPANION => Some(TrayCommand::HideCompanion),
    TRAY_QUIT => Some(TrayCommand::Quit),
    _ => None,
  }
}

pub(crate) fn dispatch(
  app: &AppHandle,
  command: TrayCommand,
  request_quit: impl FnOnce(&AppHandle),
) -> Result<(), String> {
  match command {
    TrayCommand::Quit => {
      request_quit(app);
      Ok(())
    }
    TrayCommand::ShowMain => {
      let surfaces = DesktopSurfaceManager::new(app);
      surfaces.show(DesktopSurface::Main)?;
      surfaces.focus(DesktopSurface::Main)
    }
    TrayCommand::HideMain => DesktopSurfaceManager::new(app).hide(DesktopSurface::Main),
    TrayCommand::ShowCompanion => {
      let surfaces = DesktopSurfaceManager::new(app);
      surfaces.show(DesktopSurface::Companion)?;
      surfaces.focus(DesktopSurface::Companion)
    }
    TrayCommand::HideCompanion => DesktopSurfaceManager::new(app).hide(DesktopSurface::Companion),
  }
}

#[cfg(test)]
mod tests {
  use super::{command_for_id, TrayCommand};

  #[test]
  fn semantic_ids_map_to_commands_without_native_numeric_identity() {
    assert_eq!(
      command_for_id("tray-open-main"),
      Some(TrayCommand::ShowMain)
    );
    assert_eq!(
      command_for_id("tray-hide-main"),
      Some(TrayCommand::HideMain)
    );
    assert_eq!(
      command_for_id("tray-show-companion"),
      Some(TrayCommand::ShowCompanion)
    );
    assert_eq!(
      command_for_id("tray-hide-companion"),
      Some(TrayCommand::HideCompanion)
    );
    assert_eq!(command_for_id("tray-quit"), Some(TrayCommand::Quit));
    assert_eq!(command_for_id("1004"), None);
    assert_eq!(command_for_id("unknown"), None);
  }
}
