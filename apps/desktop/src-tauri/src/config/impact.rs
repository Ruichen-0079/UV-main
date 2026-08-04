use super::schema::{ServiceMode, UserSettings};

/// Compute which managed services should be restarted after a settings change.
pub fn compute_restart_services(before: &UserSettings, after: &UserSettings) -> Vec<String> {
  let mut out = Vec::new();

  if before.chat != after.chat
    || before.runtime.url != after.runtime.url
    || before.runtime.mode != after.runtime.mode
    || before.runtime.autostart != after.runtime.autostart
  {
    out.push("runtime".into());
  }

  if before.memory != after.memory {
    out.push("memory".into());
  }

  if before.tts != after.tts {
    out.push("tts".into());
  }

  // companion.alwaysOnTop is applied immediately — no service restart.
  // app.language is frontend-only.

  out
}

pub fn restart_application_needed(before: &UserSettings, after: &UserSettings) -> bool {
  // Switching runtime mode managed<->external may require app restart for clean ownership.
  before.runtime.mode != after.runtime.mode
    && matches!(
      (before.runtime.mode, after.runtime.mode),
      (ServiceMode::Managed, ServiceMode::External)
        | (ServiceMode::External, ServiceMode::Managed)
    )
}
