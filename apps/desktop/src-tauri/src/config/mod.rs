pub mod env_export;
mod impact;
mod schema;
mod secrets;
mod service;
mod validate;

#[cfg(test)]
mod tests;

pub use schema::{
    SecretMutationResult, SecretStatus, SettingsChangedEvent, SettingsView, SupervisorSyncStatus,
    UpdateSettingsResult, UserSettingsPatch,
};
pub use secrets::{
    PlatformSecretStore, SecretStore, SECRET_DATABASE_URL, SECRET_DEEPSEEK_API_KEY,
    SECRET_MEMORY_LLM_API_KEY, SECRET_OPENAI_COMPATIBLE_API_KEY,
};
pub use service::ConfigService;

use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct ConfigState {
    pub service: Arc<ConfigService>,
}

impl ConfigState {
    pub fn new(service: Arc<ConfigService>) -> Self {
        Self { service }
    }
}

pub fn init_config_service(app: &AppHandle) -> Result<Arc<ConfigService>, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir unavailable: {e}"))?;
    let secrets: Arc<dyn SecretStore> = Arc::new(PlatformSecretStore);
    let service = Arc::new(ConfigService::open(config_dir, secrets));
    Ok(service)
}

#[tauri::command]
pub fn get_user_settings(state: State<'_, ConfigState>) -> Result<SettingsView, String> {
    state.service.get_view()
}

#[tauri::command]
pub fn update_user_settings(
    app: AppHandle,
    state: State<'_, ConfigState>,
    patch: UserSettingsPatch,
) -> Result<UpdateSettingsResult, String> {
    let before = state.service.current_settings()?;
    let mut result = state.service.update_settings(patch)?;
    let event =
        state
            .service
            .changed_event(&before, &result.settings, result.restart_services.clone());
    let _ = app.emit("settings.changed", &event);

    // Apply companion always-on-top immediately when changed.
    if before.companion.always_on_top != result.settings.companion.always_on_top {
        if let Some(window) = app.get_webview_window("companion") {
            let _ = window.set_always_on_top(result.settings.companion.always_on_top);
        }
    }

    // Persistence already succeeded; supervisor sync is best-effort and reported.
    result.supervisor_sync = push_supervisor_config(&app, &state);
    Ok(result)
}

#[tauri::command]
pub fn set_user_secret(
    app: AppHandle,
    state: State<'_, ConfigState>,
    key: String,
    value: String,
) -> Result<SecretMutationResult, String> {
    let secrets = state.service.set_secret(&key, &value)?;
    let restart_services = secret_restart_hint(&key);
    let _ = app.emit(
        "settings.changed",
        SettingsChangedEvent {
            revision: state.service.revision(),
            changed_sections: vec!["secrets".into()],
            restart_services: restart_services.clone(),
        },
    );
    let supervisor_sync = push_supervisor_config(&app, &state);
    Ok(SecretMutationResult {
        saved: true,
        secrets,
        restart_services,
        supervisor_sync,
    })
}

#[tauri::command]
pub fn delete_user_secret(
    app: AppHandle,
    state: State<'_, ConfigState>,
    key: String,
) -> Result<SecretMutationResult, String> {
    let secrets = state.service.delete_secret(&key)?;
    let restart_services = secret_restart_hint(&key);
    let _ = app.emit(
        "settings.changed",
        SettingsChangedEvent {
            revision: state.service.revision(),
            changed_sections: vec!["secrets".into()],
            restart_services: restart_services.clone(),
        },
    );
    let supervisor_sync = push_supervisor_config(&app, &state);
    Ok(SecretMutationResult {
        saved: true,
        secrets,
        restart_services,
        supervisor_sync,
    })
}

/// Best-effort live config sync. Settings page works even if Supervisor is down.
/// Returns applied status; never fails the caller's save path.
fn push_supervisor_config(app: &AppHandle, state: &State<'_, ConfigState>) -> SupervisorSyncStatus {
    match state.service.supervisor_config_push() {
        Ok(payload) => match crate::supervisor::push_runtime_config(app, &payload) {
            Ok(_) => SupervisorSyncStatus::applied_ok(),
            Err(error) => {
                // Do not log payload (may contain secrets). Redact error text.
                let status = SupervisorSyncStatus::failed(error);
                eprintln!(
                    "[yuvi-desktop] supervisor config push skipped: {}",
                    status.error.as_deref().unwrap_or("unknown")
                );
                status
            }
        },
        Err(error) => {
            let status = SupervisorSyncStatus::failed(error);
            eprintln!(
                "[yuvi-desktop] supervisor config build failed: {}",
                status.error.as_deref().unwrap_or("unknown")
            );
            status
        }
    }
}

#[tauri::command]
pub fn get_user_secret_status(state: State<'_, ConfigState>) -> Result<SecretStatus, String> {
    state.service.secret_status()
}

fn secret_restart_hint(key: &str) -> Vec<String> {
    match key {
        SECRET_DEEPSEEK_API_KEY | SECRET_OPENAI_COMPATIBLE_API_KEY => vec!["runtime".into()],
        SECRET_DATABASE_URL => vec!["memory".into(), "runtime".into()],
        SECRET_MEMORY_LLM_API_KEY => vec!["memory".into()],
        _ => Vec::new(),
    }
}
