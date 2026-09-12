//! Linux WebKitGTK policy for the app's existing Web capture and playback paths.
use tauri::WebviewWindow;
use webkit2gtk::{glib::Cast, PermissionRequestExt, SettingsExt, UserMediaPermissionRequest,
  UserMediaPermissionRequestExt, WebViewExt};

fn permits_microphone(label: &str, uri: &str, audio: bool, video: bool) -> bool {
  let Ok(url) = url::Url::parse(uri) else { return false };
  label == "main" && audio && !video && url.scheme() == "tauri"
    && url.host_str() == Some("localhost") && url.username().is_empty()
    && url.password().is_none() && url.port().is_none()
}

pub(crate) fn configure(window: &WebviewWindow) -> tauri::Result<()> {
  let label = window.label().to_owned();
  window.with_webview(move |native| {
    let view = native.inner();
    if let Some(settings) = view.settings() {
      settings.set_enable_media_stream(true);
      // Main's click reaches Companion over the bus, which cannot transfer
      // browser user activation. Product/Runtime still admit speech; this
      // only lets that admitted audio play in its owning desktop surface.
      if label == "companion" {
        settings.set_media_playback_requires_user_gesture(false);
      }
    }
    view.connect_permission_request(move |view, request| {
      let Some(media) = request.downcast_ref::<UserMediaPermissionRequest>() else {
        return false;
      };
      // Clicking Voice Mode in our bundled Main is the request for microphone
      // capture. Never grant camera or microphone access to a navigated site.
      let allowed = permits_microphone(&label, view.uri().as_deref().unwrap_or(""),
        media.is_for_audio_device(), media.is_for_video_device());
      if allowed { request.allow(); } else { request.deny(); }
      eprintln!("[yuvi-desktop] microphone permission: {}", if allowed { "allowed" } else { "denied" });
      true
    });
  })
}

#[cfg(test)]
mod tests {
  use super::permits_microphone;
  #[test]
  fn only_bundled_main_audio_capture_is_allowed() {
    assert!(permits_microphone("main", "tauri://localhost/index.html", true, false));
    for uri in ["https://example.com", "tauri://foreign/index.html", "tauri://user@localhost", "http://localhost:5173"] {
      assert!(!permits_microphone("main", uri, true, false));
    }
    assert!(!permits_microphone("companion", "tauri://localhost", true, false));
    assert!(!permits_microphone("main", "tauri://localhost", true, true));
    assert!(!permits_microphone("main", "tauri://localhost", false, false));
  }
}
