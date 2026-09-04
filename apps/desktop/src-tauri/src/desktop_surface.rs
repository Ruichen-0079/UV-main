use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::config;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DesktopSurface {
  Main,
  Companion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AlwaysOnTopPolicy {
  Default,
  CompanionSetting,
}

#[derive(Debug, Clone, Copy)]
struct SurfaceSpec {
  label: &'static str,
  url: &'static str,
  title: &'static str,
  width: f64,
  height: f64,
  min_width: f64,
  min_height: f64,
  decorations: Option<bool>,
  transparent: Option<bool>,
  always_on_top: AlwaysOnTopPolicy,
  resizable: Option<bool>,
}

const MAIN_SPEC: SurfaceSpec = SurfaceSpec {
  label: "main",
  url: "index.html#/main",
  title: "YUVI Chat",
  width: 960.0,
  height: 760.0,
  min_width: 640.0,
  min_height: 480.0,
  decorations: None,
  transparent: None,
  always_on_top: AlwaysOnTopPolicy::Default,
  resizable: None,
};

const COMPANION_SPEC: SurfaceSpec = SurfaceSpec {
  label: "companion",
  url: "index.html#/companion",
  title: "YUVI Companion",
  width: 480.0,
  height: 720.0,
  min_width: 320.0,
  min_height: 480.0,
  decorations: Some(false),
  transparent: Some(true),
  always_on_top: AlwaysOnTopPolicy::CompanionSetting,
  resizable: Some(true),
};

impl DesktopSurface {
  fn spec(self) -> SurfaceSpec {
    match self {
      Self::Main => MAIN_SPEC,
      Self::Companion => COMPANION_SPEC,
    }
  }
}

pub(crate) struct DesktopSurfaceManager<'a> {
  app: &'a AppHandle,
}

impl<'a> DesktopSurfaceManager<'a> {
  pub(crate) fn new(app: &'a AppHandle) -> Self {
    Self { app }
  }

  pub(crate) fn ensure(&self, surface: DesktopSurface) -> tauri::Result<WebviewWindow> {
    let spec = surface.spec();
    existing_or_create(self.app.get_webview_window(spec.label), || {
      self.build(surface)
    })
  }

  pub(crate) fn show(&self, surface: DesktopSurface) -> Result<(), String> {
    self
      .ensure(surface)
      .map_err(|error| error.to_string())?
      .show()
      .map_err(|error| error.to_string())
  }

  pub(crate) fn hide(&self, surface: DesktopSurface) -> Result<(), String> {
    let spec = surface.spec();
    if let Some(window) = self.app.get_webview_window(spec.label) {
      window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
  }

  pub(crate) fn toggle(&self, surface: DesktopSurface) -> Result<(), String> {
    let window = self.ensure(surface).map_err(|error| error.to_string())?;
    if window.is_visible().map_err(|error| error.to_string())? {
      window.hide().map_err(|error| error.to_string())
    } else {
      window.show().map_err(|error| error.to_string())?;
      window.set_focus().map_err(|error| error.to_string())
    }
  }

  pub(crate) fn focus(&self, surface: DesktopSurface) -> Result<(), String> {
    self
      .ensure(surface)
      .map_err(|error| error.to_string())?
      .set_focus()
      .map_err(|error| error.to_string())
  }

  fn build(&self, surface: DesktopSurface) -> tauri::Result<WebviewWindow> {
    let spec = surface.spec();
    let builder = WebviewWindowBuilder::new(self.app, spec.label, WebviewUrl::App(spec.url.into()))
      .title(spec.title)
      .inner_size(spec.width, spec.height)
      .min_inner_size(spec.min_width, spec.min_height);

    let builder = match spec.decorations {
      Some(value) => builder.decorations(value),
      None => builder,
    };
    let builder = match spec.transparent {
      Some(value) => builder.transparent(value),
      None => builder,
    };
    let builder = match spec.always_on_top {
      AlwaysOnTopPolicy::Default => builder,
      AlwaysOnTopPolicy::CompanionSetting => builder.always_on_top(self.companion_always_on_top()),
    };
    let builder = match spec.resizable {
      Some(value) => builder.resizable(value),
      None => builder,
    };

    builder.build()
  }

  fn companion_always_on_top(&self) -> bool {
    self
      .app
      .try_state::<config::ConfigState>()
      .and_then(|state| state.service.current_settings().ok())
      .map(|settings| settings.companion.always_on_top)
      .unwrap_or(true)
  }
}

fn existing_or_create<T, E>(
  existing: Option<T>,
  create: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
  existing.map_or_else(create, Ok)
}

#[cfg(test)]
mod tests {
  use super::{existing_or_create, AlwaysOnTopPolicy, DesktopSurface};

  #[test]
  fn surface_specs_keep_current_main_and_companion_contracts() {
    let main = DesktopSurface::Main.spec();
    assert_eq!(main.label, "main");
    assert_eq!(main.url, "index.html#/main");
    assert_eq!(main.title, "YUVI Chat");
    assert_eq!(main.always_on_top, AlwaysOnTopPolicy::Default);

    let companion = DesktopSurface::Companion.spec();
    assert_eq!(companion.label, "companion");
    assert_eq!(companion.url, "index.html#/companion");
    assert_eq!(companion.title, "YUVI Companion");
    assert_eq!(companion.always_on_top, AlwaysOnTopPolicy::CompanionSetting);
  }

  #[test]
  fn existing_surface_is_reused_without_creation() {
    let mut create_calls = 0;
    let existing = existing_or_create(Some("companion-window"), || {
      create_calls += 1;
      Ok::<_, ()>("new-window")
    })
    .expect("existing surface should be returned");

    assert_eq!(existing, "companion-window");
    assert_eq!(create_calls, 0);
  }

  #[test]
  fn missing_surface_is_created_lazily() {
    let mut create_calls = 0;
    let created = existing_or_create(None, || {
      create_calls += 1;
      Ok::<_, ()>("new-window")
    })
    .expect("missing surface should be created");

    assert_eq!(created, "new-window");
    assert_eq!(create_calls, 1);
  }
}
