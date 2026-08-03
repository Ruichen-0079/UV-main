use tauri::{WebviewUrl, WebviewWindowBuilder};

/// Main chat window surface. Hash routing keeps the single static build
/// working in both dev (Vite dev server) and packaged (frontendDist) mode.
const MAIN_WINDOW_URL: &str = "index.html#/main";

/// Companion window surface that exclusively owns Lumi, speech playback and
/// the Web Audio analysis chain.
const COMPANION_WINDOW_URL: &str = "index.html#/companion";

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let main_window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App(MAIN_WINDOW_URL.into()))
                    .title("YUVI Chat")
                    .inner_size(960.0, 760.0)
                    .min_inner_size(640.0, 480.0)
                    .build()?;

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
            .build()?;

            main_window.set_focus()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running YUVI desktop app");
}
