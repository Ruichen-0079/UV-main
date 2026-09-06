use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowCloseAction {
  Hide,
  AllowClose,
}

pub(crate) fn window_close_action(label: &str, shutdown_started: bool) -> WindowCloseAction {
  if shutdown_started {
    return WindowCloseAction::AllowClose;
  }

  match label {
    "main" | "companion" | "webui" => WindowCloseAction::Hide,
    _ => WindowCloseAction::AllowClose,
  }
}

pub(crate) struct ShutdownGate(AtomicBool);

impl ShutdownGate {
  pub(crate) const fn new() -> Self {
    Self(AtomicBool::new(false))
  }

  pub(crate) fn claim(&self) -> bool {
    !self.0.swap(true, Ordering::SeqCst)
  }

  pub(crate) fn is_claimed(&self) -> bool {
    self.0.load(Ordering::SeqCst)
  }
}

#[cfg(test)]
mod tests {
  use super::{window_close_action, ShutdownGate, WindowCloseAction};

  #[test]
  fn ordinary_main_close_is_a_hide() {
    assert_eq!(
      window_close_action("main", false),
      WindowCloseAction::Hide
    );
  }

  #[test]
  fn ordinary_companion_close_is_a_hide() {
    assert_eq!(
      window_close_action("companion", false),
      WindowCloseAction::Hide
    );
  }

  #[test]
  fn ordinary_webui_close_is_a_hide() {
    assert_eq!(
      window_close_action("webui", false),
      WindowCloseAction::Hide
    );
  }

  #[test]
  fn shutdown_allows_window_close() {
    assert_eq!(
      window_close_action("main", true),
      WindowCloseAction::AllowClose
    );
    assert_eq!(
      window_close_action("companion", true),
      WindowCloseAction::AllowClose
    );
    assert_eq!(
      window_close_action("webui", true),
      WindowCloseAction::AllowClose
    );
  }

  #[test]
  fn shutdown_gate_can_be_claimed_once() {
    let gate = ShutdownGate::new();

    assert!(gate.claim());
    assert!(!gate.claim());
    assert!(gate.is_claimed());
  }
}
