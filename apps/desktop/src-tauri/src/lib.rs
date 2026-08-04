use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Main chat window surface. Hash routing keeps the single static build
/// working in both dev (Vite dev server) and packaged (frontendDist) mode.
const MAIN_WINDOW_URL: &str = "index.html#/main";

/// Companion window surface that exclusively owns Lumi, speech playback and
/// the Web Audio analysis chain.
const COMPANION_WINDOW_URL: &str = "index.html#/companion";

fn build_companion_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(
        app,
        "companion",
        WebviewUrl::App(COMPANION_WINDOW_URL.into()),
    )
    .title("YUVI Companion")
    .inner_size(480.0, 720.0)
    .min_inner_size(320.0, 480.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .resizable(true)
    .build()
}

fn ensure_companion_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window("companion") {
        return Ok(window);
    }
    build_companion_window(app)
}

#[tauri::command]
fn show_companion(app: AppHandle) -> Result<(), String> {
    let window = ensure_companion_window(&app).map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
fn hide_companion(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("companion") {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn toggle_companion(app: AppHandle) -> Result<(), String> {
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
fn reopen_companion(app: AppHandle) -> Result<(), String> {
    let window = ensure_companion_window(&app).map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let main_window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App(MAIN_WINDOW_URL.into()))
                    .title("YUVI Chat")
                    .inner_size(960.0, 760.0)
                    .min_inner_size(640.0, 480.0)
                    .build()?;

            build_companion_window(&app.handle())?;

            main_window.set_focus()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            show_companion,
            hide_companion,
            toggle_companion,
            reopen_companion
        ])
        .run(tauri::generate_context!())
        .expect("error while running YUVI desktop app");
}
