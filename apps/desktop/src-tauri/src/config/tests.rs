use super::env_export::{
    combined_env_for_supervisor, public_env_overrides, secret_env_overrides,
    supervisor_config_push, unset_env_for_supervisor,
};
use super::impact::{compute_restart_services, restart_application_needed};
use super::schema::{redact_supervisor_error, SecretMutationResult, SupervisorSyncStatus};
use super::schema::{
    MemoryBackend, MemoryLlmProvider, MemoryLlmSettingsPatch, MemorySettingsPatch,
    ProactiveSettingsPatch, ServiceMode, SttProvider, UserSettings, UserSettingsPatch,
    SCHEMA_VERSION,
};
use super::secrets::{
    MemorySecretStore, SecretStore, SECRET_DATABASE_URL, SECRET_DEEPSEEK_API_KEY,
    SECRET_MEMORY_LLM_API_KEY, SECRET_OPENAI_COMPATIBLE_API_KEY, SECRET_POSTGRES_LOCAL_PASSWORD,
    WIN_CRED_MEMORY_LLM_API_KEY,
};
use super::service::{atomic_write_json, replace_file, ConfigService};
use super::validate::{apply_patch, validate_settings};
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tempfile::tempdir;

const MEMORY_LLM_TEST_SECRET: &str = "P3_MEMORY_LLM_SECRET_NEVER_EXPOSE";

fn service_with_memory() -> (
    tempfile::TempDir,
    Arc<ConfigService>,
    Arc<MemorySecretStore>,
) {
    let dir = tempdir().expect("tempdir");
    let secrets = Arc::new(MemorySecretStore::default());
    let service = Arc::new(ConfigService::open(
        dir.path().to_path_buf(),
        secrets.clone() as Arc<dyn SecretStore>,
    ));
    (dir, service, secrets)
}

#[test]
fn defaults_when_no_file() {
    let (_dir, service, _) = service_with_memory();
    let view = service.get_view().unwrap();
    assert_eq!(view.settings.schema_version, SCHEMA_VERSION);
    assert_eq!(view.settings.chat.provider, "openai-compatible");
    assert_eq!(
        view.settings.chat.model,
        "deepseek-ai/DeepSeek-V4-Flash-0731"
    );
    assert_eq!(view.settings.cognition.provider, "openai-compatible");
    assert_eq!(view.settings.cognition.model, "zai-org/GLM-5.3-Flash");
    assert!(!view.secrets.openai_compatible_api_key);
    assert!(!view.settings.proactive.enabled);
    assert!(!view.secrets.deepseek_api_key);
    assert!(view.load_error.is_none());
}

#[test]
fn save_and_reload_roundtrip() {
    let dir = tempdir().unwrap();
    let secrets = Arc::new(MemorySecretStore::default());
    let service = ConfigService::open(dir.path().to_path_buf(), secrets.clone());
    let mut patch = UserSettingsPatch::default();
    patch.chat = Some(super::schema::ChatSettingsPatch {
        provider: Some("deepseek".into()),
        model: Some("deepseek-v4-flash".into()),
    });
    patch.memory = Some(super::schema::MemorySettingsPatch {
        base_url: Some("http://127.0.0.1:6131".into()),
        subject_user_id: Some("local-user".into()),
        persona_id: Some("lumi".into()),
        ..Default::default()
    });
    let result = service.update_settings(patch).unwrap();
    assert!(result.saved);
    assert_eq!(result.settings.chat.model, "deepseek-v4-flash");

    let reloaded = ConfigService::open(dir.path().to_path_buf(), secrets);
    let view = reloaded.get_view().unwrap();
    assert_eq!(view.settings.chat.model, "deepseek-v4-flash");
    assert_eq!(view.settings.memory.base_url, "http://127.0.0.1:6131");
    assert_eq!(view.settings.memory.subject_user_id, "local-user");
}

#[test]
fn cognition_selection_persists_and_projects_shared_openai_connection() {
    let dir = tempdir().unwrap();
    let secrets = Arc::new(MemorySecretStore::default());
    let service = ConfigService::open(dir.path().to_path_buf(), secrets.clone());
    let mut patch = UserSettingsPatch::default();
    patch.cognition = Some(super::schema::CognitionSettingsPatch {
        provider: Some("openai-compatible".into()),
        model: Some("zai-org/GLM-5.3-Flash".into()),
    });
    patch.openai_compatible = Some(super::schema::OpenAiCompatibleSettingsPatch {
        base_url: Some("https://gateway.example/v1".into()),
    });

    let result = service.update_settings(patch).unwrap();
    assert!(result.restart_services.contains(&"runtime".to_string()));
    assert_eq!(result.settings.cognition.model, "zai-org/GLM-5.3-Flash");

    service
        .set_secret(SECRET_OPENAI_COMPATIBLE_API_KEY, "shared-api-key")
        .unwrap();
    let reloaded = ConfigService::open(dir.path().to_path_buf(), secrets);
    let view = reloaded.get_view().unwrap();
    assert_eq!(
        view.settings.openai_compatible.base_url,
        "https://gateway.example/v1"
    );
    assert!(view.secrets.openai_compatible_api_key);

    let env = reloaded.supervisor_env().unwrap();
    assert_eq!(
        env.get("DEFAULT_CHAT_PROVIDER").map(String::as_str),
        Some("openai-compatible")
    );
    assert_eq!(
        env.get("CHAT_PROVIDER_CHAIN").map(String::as_str),
        Some("openai-compatible")
    );
    assert_eq!(
        env.get("DEFAULT_REASONING_PROVIDER").map(String::as_str),
        Some("openai-compatible")
    );
    assert_eq!(
        env.get("REASONING_PROVIDER_CHAIN").map(String::as_str),
        Some("openai-compatible")
    );
    assert_eq!(
        env.get("OPENAI_COMPATIBLE_API_BASEURL").map(String::as_str),
        Some("https://gateway.example/v1")
    );
    assert_eq!(
        env.get("OPENAI_COMPATIBLE_CHAT_MODEL").map(String::as_str),
        Some("deepseek-ai/DeepSeek-V4-Flash-0731")
    );
    assert_eq!(
        env.get("OPENAI_COMPATIBLE_REASONING_MODEL")
            .map(String::as_str),
        Some("zai-org/GLM-5.3-Flash")
    );
    assert_eq!(
        env.get("OPENAI_COMPATIBLE_API_KEY").map(String::as_str),
        Some("shared-api-key")
    );
    let view_json = serde_json::to_string(&view).unwrap();
    assert!(!view_json.contains("shared-api-key"));
}

#[test]
fn chat_and_cognition_provider_selection_projects_separate_models() {
    let secrets = MemorySecretStore::default();
    secrets
        .set(SECRET_DEEPSEEK_API_KEY, "deepseek-key")
        .unwrap();
    secrets
        .set(SECRET_OPENAI_COMPATIBLE_API_KEY, "shared-key")
        .unwrap();
    let mut settings = UserSettings::default();
    settings.chat.provider = "deepseek".into();
    settings.chat.model = "deepseek-chat".into();
    settings.cognition.provider = "openai-compatible".into();
    settings.cognition.model = "zai-org/GLM-5.3-Flash".into();

    let env = combined_env_for_supervisor(&settings, &secrets).unwrap();
    assert_eq!(
        env.get("DEEPSEEK_CHAT_MODEL").map(String::as_str),
        Some("deepseek-chat")
    );
    assert_eq!(
        env.get("OPENAI_COMPATIBLE_REASONING_MODEL")
            .map(String::as_str),
        Some("zai-org/GLM-5.3-Flash")
    );
    assert!(env.get("OPENAI_COMPATIBLE_CHAT_MODEL").is_none());
    assert!(env.get("DEEPSEEK_REASONING_MODEL").is_none());
    assert_eq!(
        env.get("DEEPSEEK_API_KEY").map(String::as_str),
        Some("deepseek-key")
    );
    assert_eq!(
        env.get("OPENAI_COMPATIBLE_API_KEY").map(String::as_str),
        Some("shared-key")
    );
}

#[test]
fn cognition_configuration_validation_rejects_unsupported_provider_and_endpoint_credentials() {
    let mut unsupported = UserSettings::default();
    unsupported.cognition.provider = "nvidia".into();
    assert!(validate_settings(&unsupported)
        .unwrap_err()
        .contains("cognition.provider"));

    let mut missing_model = UserSettings::default();
    missing_model.cognition.model.clear();
    assert!(validate_settings(&missing_model)
        .unwrap_err()
        .contains("cognition.model"));

    let mut credentials = UserSettings::default();
    credentials.openai_compatible.base_url = "https://user:password@gateway.example/v1".into();
    let error = validate_settings(&credentials).unwrap_err();
    assert!(error.contains("credentials"));
    assert!(!error.contains("password"));
}

#[test]
fn rejects_invalid_url() {
    let base = UserSettings::default();
    let mut patch = UserSettingsPatch::default();
    patch.runtime = Some(super::schema::RuntimeSettingsPatch {
        url: Some("not-a-url".into()),
        ..Default::default()
    });
    let err = apply_patch(&base, &patch).unwrap_err();
    assert!(err.contains("runtime.url"));
}

#[test]
fn rejects_empty_required_fields() {
    let mut settings = UserSettings::default();
    settings.memory.subject_user_id = "  ".into();
    assert!(validate_settings(&settings).is_err());
}

#[test]
fn corrupt_json_falls_back_and_quarantines() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    fs::write(&path, "{not-json").unwrap();
    let secrets = Arc::new(MemorySecretStore::default());
    let service = ConfigService::open(dir.path().to_path_buf(), secrets);
    let view = service.get_view().unwrap();
    assert!(view.load_error.is_some());
    assert_eq!(view.settings.chat.provider, "openai-compatible");
    // invalid backup exists
    let backups: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("settings.invalid-")
        })
        .collect();
    assert_eq!(backups.len(), 1);
}

#[test]
fn atomic_write_creates_settings_file() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let settings = UserSettings::default();
    atomic_write_json(&path, &settings).unwrap();
    assert!(path.exists());
    assert!(!path.with_extension("json.tmp").exists());
    let loaded: UserSettings = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(loaded.schema_version, SCHEMA_VERSION);
}

#[test]
fn secrets_set_status_delete_memory_store() {
    let (_dir, service, _) = service_with_memory();
    assert!(!service.secret_status().unwrap().deepseek_api_key);
    service
        .set_secret(SECRET_DEEPSEEK_API_KEY, "sk-test-key")
        .unwrap();
    let status = service.secret_status().unwrap();
    assert!(status.deepseek_api_key);
    // get_view must not leak secret values
    let view_json = serde_json::to_string(&service.get_view().unwrap()).unwrap();
    assert!(!view_json.contains("sk-test-key"));
    service.delete_secret(SECRET_DEEPSEEK_API_KEY).unwrap();
    assert!(!service.secret_status().unwrap().deepseek_api_key);
}

#[test]
fn restart_services_impact() {
    let before = UserSettings::default();
    let mut after = before.clone();
    after.chat.model = "other-model".into();
    let services = compute_restart_services(&before, &after);
    assert!(services.contains(&"runtime".to_string()));

    let mut after_mem = before.clone();
    // Custom URL distinct from product default (6131) — verifies impact, not migration.
    after_mem.memory.base_url = "http://127.0.0.1:6199".into();
    let services = compute_restart_services(&before, &after_mem);
    assert!(services.contains(&"memory".to_string()));
    assert!(!services.contains(&"runtime".to_string()));

    let mut after_stt = before.clone();
    after_stt.stt.provider = SttProvider::Local;
    after_stt.stt.mode = ServiceMode::Managed;
    after_stt.stt.autostart = true;
    let services = compute_restart_services(&before, &after_stt);
    assert_eq!(services, vec!["runtime", "local_stt"]);
}

#[test]
fn managed_env_includes_secrets_external_runtime_skips_chat_key() {
    let secrets = MemorySecretStore::default();
    secrets.set(SECRET_DEEPSEEK_API_KEY, "sk-secret").unwrap();
    secrets
        .set(
            SECRET_DATABASE_URL,
            "postgres://yuvi:pass@127.0.0.1:5432/yuvi",
        )
        .unwrap();

    let mut managed = UserSettings::default();
    managed.chat.provider = "deepseek".into();
    managed.runtime.mode = ServiceMode::Managed;
    managed.memory.mode = ServiceMode::Managed;
    let env = combined_env_for_supervisor(&managed, &secrets).unwrap();
    assert_eq!(
        env.get("DEEPSEEK_API_KEY").map(String::as_str),
        Some("sk-secret")
    );
    assert!(env.get("DATABASE_URL").is_some());
    assert_eq!(
        env.get("YUVI_AUTOSTART_RUNTIME").map(String::as_str),
        Some("true")
    );

    let mut external = managed.clone();
    external.runtime.mode = ServiceMode::External;
    external.memory.mode = ServiceMode::External;
    let env = secret_env_overrides(&external, &secrets).unwrap();
    assert!(env.get("DEEPSEEK_API_KEY").is_none());
    // external memory should not force DB injection via managed path
    assert!(env.get("DATABASE_URL").is_none());

    let public = public_env_overrides(&managed);
    let public_json = serde_json::to_string(&public).unwrap();
    assert!(!public_json.contains("sk-secret"));
    assert!(!public_json.contains("postgres://"));
    assert_eq!(
        public.get("DEFAULT_TTS_PROVIDER").map(String::as_str),
        Some("local")
    );
    assert_eq!(
        public.get("TTS_PROVIDER_CHAIN").map(String::as_str),
        Some("local")
    );
    assert_eq!(
        public.get("LOCAL_TTS_MODEL").map(String::as_str),
        Some("alice-v4")
    );

    let mut local_stt = managed.clone();
    local_stt.stt.provider = SttProvider::Local;
    local_stt.stt.mode = ServiceMode::Managed;
    local_stt.stt.autostart = true;
    let public = public_env_overrides(&local_stt);
    assert_eq!(
        public.get("DEFAULT_STT_PROVIDER").map(String::as_str),
        Some("local")
    );
    assert_eq!(
        public.get("STT_PROVIDER_CHAIN").map(String::as_str),
        Some("local")
    );
    assert_eq!(
        public.get("LOCAL_STT_BASE_URL").map(String::as_str),
        Some("http://127.0.0.1:9876")
    );
    assert_eq!(
        public.get("LOCAL_MODEL_BASEURL").map(String::as_str),
        Some("http://127.0.0.1:9876")
    );
    assert_eq!(
        public.get("YUVI_AUTOSTART_LOCAL_STT").map(String::as_str),
        Some("true")
    );

    let public = public_env_overrides(&managed);
    assert_eq!(
        public.get("DEFAULT_STT_PROVIDER").map(String::as_str),
        Some("dashscope")
    );
    assert_eq!(
        public.get("YUVI_AUTOSTART_LOCAL_STT").map(String::as_str),
        Some("false")
    );
    let unset = unset_env_for_supervisor(&managed, &secrets).unwrap();
    assert!(unset.iter().any(|key| key == "LOCAL_MODEL_BASEURL"));
}

#[test]
fn partial_patch_merges_defaults() {
    let base = UserSettings::default();
    let mut patch = UserSettingsPatch::default();
    patch.app = Some(super::schema::AppSettingsPatch {
        language: Some("zh".into()),
    });
    let next = apply_patch(&base, &patch).unwrap();
    assert_eq!(next.app.language, "zh");
    assert_eq!(next.chat.provider, "openai-compatible");
    assert_eq!(next.memory.backend, MemoryBackend::Mem0);
}

#[test]
fn proactive_defaults_false_and_roundtrips_true_and_false() {
    let dir = tempdir().unwrap();
    let secrets = Arc::new(MemorySecretStore::default());
    let service = ConfigService::open(dir.path().to_path_buf(), secrets.clone());
    let defaults = service.current_settings().unwrap();
    assert!(!defaults.proactive.enabled);
    assert_eq!(
        serde_json::to_value(&defaults).unwrap()["proactive"]["enabled"],
        false
    );

    let mut enable = UserSettingsPatch::default();
    enable.proactive = Some(ProactiveSettingsPatch {
        enabled: Some(true),
    });
    service.update_settings(enable).unwrap();
    let reloaded = ConfigService::open(dir.path().to_path_buf(), secrets.clone());
    assert!(reloaded.current_settings().unwrap().proactive.enabled);

    let mut disable = UserSettingsPatch::default();
    disable.proactive = Some(ProactiveSettingsPatch {
        enabled: Some(false),
    });
    reloaded.update_settings(disable).unwrap();
    let reloaded_again = ConfigService::open(dir.path().to_path_buf(), secrets);
    assert!(!reloaded_again.current_settings().unwrap().proactive.enabled);
}

#[test]
fn proactive_patch_preserves_omitted_value_and_rejects_unknown_nested_fields() {
    let mut base = UserSettings::default();
    base.proactive.enabled = true;

    let omitted = apply_patch(&base, &UserSettingsPatch::default()).unwrap();
    assert!(omitted.proactive.enabled);

    let mut empty_section = UserSettingsPatch::default();
    empty_section.proactive = Some(ProactiveSettingsPatch::default());
    let empty_section_result = apply_patch(&base, &empty_section).unwrap();
    assert!(empty_section_result.proactive.enabled);

    let unknown = serde_json::from_str::<UserSettingsPatch>(
        r#"{"proactive":{"enabled":false,"unexpected":true}}"#,
    );
    assert!(unknown.is_err());
}

#[test]
fn proactive_only_change_reports_no_restart_or_supervisor_env() {
    let (_dir, service, _) = service_with_memory();
    let before = service.current_settings().unwrap();
    let mut patch = UserSettingsPatch::default();
    patch.proactive = Some(ProactiveSettingsPatch {
        enabled: Some(true),
    });
    let result = service.update_settings(patch).unwrap();

    assert!(result.restart_services.is_empty());
    assert!(!result.restart_application);
    let event = service.changed_event(&before, &result.settings, result.restart_services.clone());
    assert_eq!(event.changed_sections, vec!["proactive"]);
    assert!(event.restart_services.is_empty());

    let env = service.supervisor_env().unwrap();
    assert!(env
        .keys()
        .all(|key| !key.to_ascii_lowercase().contains("proactive")));
    let push = service.supervisor_config_push().unwrap();
    assert!(push
        .env
        .keys()
        .chain(push.unset_env.iter())
        .all(|key| !key.to_ascii_lowercase().contains("proactive")));
}

#[test]
fn empty_secret_deletes() {
    let store = MemorySecretStore::default();
    store.set(SECRET_DEEPSEEK_API_KEY, "abc").unwrap();
    store.set(SECRET_DEEPSEEK_API_KEY, "   ").unwrap();
    assert!(!store.is_configured(SECRET_DEEPSEEK_API_KEY).unwrap());
}

#[test]
fn settings_path_is_under_config_dir() {
    let dir = tempdir().unwrap();
    let secrets = Arc::new(MemorySecretStore::default());
    let service = ConfigService::open(dir.path().to_path_buf(), secrets);
    assert_eq!(
        service.settings_path(),
        PathBuf::from(dir.path()).join("settings.json")
    );
}

#[test]
fn secret_delete_appears_in_unset_env_for_supervisor() {
    let secrets = MemorySecretStore::default();
    secrets.set(SECRET_DEEPSEEK_API_KEY, "sk-A").unwrap();
    let mut settings = UserSettings::default();
    settings.chat.provider = "deepseek".into();
    settings.runtime.mode = ServiceMode::Managed;
    let push = supervisor_config_push(&settings, &secrets).unwrap();
    assert_eq!(
        push.env.get("DEEPSEEK_API_KEY").map(String::as_str),
        Some("sk-A")
    );
    assert!(!push.unset_env.iter().any(|k| k == "DEEPSEEK_API_KEY"));

    secrets.delete(SECRET_DEEPSEEK_API_KEY).unwrap();
    let push2 = supervisor_config_push(&settings, &secrets).unwrap();
    assert!(push2.env.get("DEEPSEEK_API_KEY").is_none());
    assert!(push2.unset_env.iter().any(|k| k == "DEEPSEEK_API_KEY"));
    // Payload serialization must not invent secret values after delete.
    let json = serde_json::to_string(&push2).unwrap();
    assert!(!json.contains("sk-A"));
}

#[test]
fn external_mode_unsets_managed_secrets() {
    let secrets = MemorySecretStore::default();
    secrets.set(SECRET_DEEPSEEK_API_KEY, "sk-keep").unwrap();
    secrets
        .set(SECRET_DATABASE_URL, "postgres://yuvi:x@127.0.0.1:5432/yuvi")
        .unwrap();
    let mut settings = UserSettings::default();
    settings.chat.provider = "deepseek".into();
    settings.runtime.mode = ServiceMode::External;
    settings.memory.mode = ServiceMode::External;
    let unset = unset_env_for_supervisor(&settings, &secrets).unwrap();
    assert!(unset.contains(&"DEEPSEEK_API_KEY".to_string()));
    assert!(unset.contains(&"DATABASE_URL".to_string()));
    let env = secret_env_overrides(&settings, &secrets).unwrap();
    assert!(env.is_empty());
}

#[test]
fn atomic_write_succeeds_three_times_no_tmp_left() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let mut settings = UserSettings::default();
    for i in 0..3 {
        settings.chat.model = format!("model-{i}");
        atomic_write_json(&path, &settings).unwrap();
        assert!(path.exists());
        let loaded: UserSettings =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(loaded.chat.model, format!("model-{i}"));
    }
    // No leftover *.tmp files.
    let leftovers: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "tmp leftovers: {leftovers:?}");
}

#[test]
fn atomic_replace_failure_preserves_existing_settings() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let mut settings = UserSettings::default();
    settings.chat.model = "keep-me".into();
    atomic_write_json(&path, &settings).unwrap();
    let before = fs::read_to_string(&path).unwrap();
    assert!(before.contains("keep-me"));

    // Missing tmp → replace must fail without touching the live file.
    let missing_tmp = dir.path().join("settings.missing.json.tmp");
    let err = replace_file(&missing_tmp, &path);
    assert!(err.is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), before);
    let reloaded: UserSettings = serde_json::from_str(&before).unwrap();
    assert_eq!(reloaded.chat.model, "keep-me");
}

#[test]
fn atomic_write_source_never_removes_target_first() {
    // Guard against regressing to remove(target) + rename.
    let src = include_str!("service.rs");
    let atomic_fn = src
        .split("pub fn atomic_write_json")
        .nth(1)
        .and_then(|s| s.split("pub fn replace_file").next())
        .expect("atomic_write_json body");
    assert!(
        !atomic_fn.contains("remove_file(path)") && !atomic_fn.contains("remove_file(&path)"),
        "atomic_write_json must not delete the live target before replace"
    );
    assert!(
        atomic_fn.contains("replace_file")
            || src.contains("MoveFileExW")
            || src.contains("fs::rename"),
        "atomic write must use replace/rename, not delete+rename"
    );
}

#[test]
fn supervisor_sync_status_redacts_and_shortens() {
    let ok = SupervisorSyncStatus::applied_ok();
    assert!(ok.applied);
    assert!(ok.error.is_none());

    let failed = SupervisorSyncStatus::failed("desktop supervisor is not running");
    assert!(!failed.applied);
    assert_eq!(failed.error.as_deref(), Some("Supervisor unavailable"));

    let bearer = redact_supervisor_error("Authorization: Bearer super-secret-token-value");
    assert_eq!(bearer, "Supervisor sync failed");
    assert!(!bearer.contains("secret"));
    assert!(!bearer.contains("Bearer"));
}

#[test]
fn update_settings_result_includes_supervisor_sync_and_saved() {
    let (_dir, service, _) = service_with_memory();
    let mut patch = UserSettingsPatch::default();
    patch.chat = Some(super::schema::ChatSettingsPatch {
        provider: Some("deepseek".into()),
        model: Some("deepseek-v4".into()),
    });
    let result = service.update_settings(patch).unwrap();
    assert!(result.saved);
    // Default before command-layer push: applied placeholder; command overwrites.
    assert!(result.supervisor_sync.applied);
    let json = serde_json::to_string(&result).unwrap();
    assert!(json.contains("supervisorSync"));
    assert!(!json.contains("sk-"));
}

#[test]
fn secret_status_json_never_includes_secret_values() {
    let (_dir, service, _) = service_with_memory();
    service
        .set_secret(SECRET_DEEPSEEK_API_KEY, "sk-very-secret-value")
        .unwrap();
    let status = service.secret_status().unwrap();
    let json = serde_json::to_string(&status).unwrap();
    assert!(!json.contains("sk-very-secret-value"));
    assert!(json.contains("true") || json.contains("deepseekApiKey"));
}

fn active_memory_settings(
    provider: MemoryLlmProvider,
    model: &str,
    base_url: &str,
) -> UserSettings {
    let mut settings = UserSettings::default();
    settings.memory.llm.provider = provider;
    settings.memory.llm.model = model.into();
    settings.memory.llm.base_url = base_url.into();
    settings
}

#[test]
fn memory_llm_defaults_and_serialization_are_additive() {
    let settings = UserSettings::default();
    assert_eq!(settings.memory.llm.provider, MemoryLlmProvider::None);
    assert!(settings.memory.llm.model.is_empty());
    assert!(settings.memory.llm.base_url.is_empty());
    assert_eq!(settings.schema_version, 1);

    let json = serde_json::to_value(&settings).unwrap();
    assert_eq!(json["memory"]["llm"]["provider"], "none");
    assert_eq!(json["memory"]["llm"]["model"], "");
    assert_eq!(json["memory"]["llm"]["baseUrl"], "");
    assert!(json["memory"]["llm"].get("apiKey").is_none());
}

#[test]
fn old_settings_without_memory_llm_load_and_save_without_quarantine() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let old = json!({
        "schemaVersion": 1,
        "app": {"language": "zh"},
        "chat": {"provider": "deepseek", "model": "deepseek-chat"},
        "runtime": {"mode": "managed", "autostart": true, "url": "http://127.0.0.1:6121"},
        "memory": {
            "enabled": true,
            "backend": "mem0",
            "mode": "managed",
            "baseUrl": "http://127.0.0.1:6131",
            "subjectUserId": "legacy-user",
            "personaId": "legacy-persona",
            "ollamaUrl": "http://127.0.0.1:11434"
        },
        "tts": {
            "enabled": true,
            "mode": "external",
            "wrapperUrl": "http://127.0.0.1:9881",
            "upstreamUrl": "http://127.0.0.1:9880"
        },
        "companion": {"alwaysOnTop": true}
    });
    let original = serde_json::to_string_pretty(&old).unwrap();
    fs::write(&path, &original).unwrap();

    let service = ConfigService::open(
        dir.path().to_path_buf(),
        Arc::new(MemorySecretStore::default()),
    );
    let view = service.get_view().unwrap();
    assert!(view.load_error.is_none());
    assert_eq!(view.settings.memory.llm.provider, MemoryLlmProvider::None);
    assert!(!view.settings.proactive.enabled);
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    assert!(fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|entry| entry.ok())
        .all(|entry| !entry
            .file_name()
            .to_string_lossy()
            .starts_with("settings.invalid-")));

    let mut patch = UserSettingsPatch::default();
    patch.app = Some(super::schema::AppSettingsPatch {
        language: Some("en".into()),
    });
    service.update_settings(patch).unwrap();
    let saved = fs::read_to_string(path).unwrap();
    let saved_json: serde_json::Value = serde_json::from_str(&saved).unwrap();
    assert_eq!(saved_json["memory"]["llm"]["provider"], "none");
    assert_eq!(saved_json["proactive"]["enabled"], false);
    assert_eq!(saved_json["memory"]["subjectUserId"], "legacy-user");
    assert_eq!(saved_json["memory"]["personaId"], "legacy-persona");
    assert!(!saved.contains("apiKey"));
}

#[test]
fn memory_llm_patch_is_partial_and_trimmed() {
    let mut base = active_memory_settings(MemoryLlmProvider::Deepseek, "base-model", "");
    base.memory.llm.base_url = "https://memory.example/v1".into();

    let mut patch = UserSettingsPatch::default();
    patch.memory = Some(MemorySettingsPatch {
        llm: Some(MemoryLlmSettingsPatch {
            provider: Some(MemoryLlmProvider::Openai),
            ..Default::default()
        }),
        ..Default::default()
    });
    let next = apply_patch(&base, &patch).unwrap();
    assert_eq!(next.memory.llm.provider, MemoryLlmProvider::Openai);
    assert_eq!(next.memory.llm.model, "base-model");
    assert_eq!(next.memory.llm.base_url, "https://memory.example/v1");

    let mut patch = UserSettingsPatch::default();
    patch.memory = Some(MemorySettingsPatch {
        llm: Some(MemoryLlmSettingsPatch {
            model: Some("  trimmed-model  ".into()),
            base_url: Some("  http://127.0.0.1:9000/v1  ".into()),
            ..Default::default()
        }),
        ..Default::default()
    });
    let next = apply_patch(&next, &patch).unwrap();
    assert_eq!(next.memory.llm.provider, MemoryLlmProvider::Openai);
    assert_eq!(next.memory.llm.model, "trimmed-model");
    assert_eq!(next.memory.llm.base_url, "http://127.0.0.1:9000/v1");
}

#[test]
fn memory_llm_patch_rejects_api_key_field() {
    let result = serde_json::from_str::<MemoryLlmSettingsPatch>(
        r#"{"provider":"deepseek","apiKey":"P3_MEMORY_LLM_SECRET_NEVER_EXPOSE"}"#,
    );
    assert!(result.is_err());
    let result = serde_json::from_str::<MemorySettingsPatch>(
        r#"{"llm":{"provider":"deepseek"},"apiKey":"P3_MEMORY_LLM_SECRET_NEVER_EXPOSE"}"#,
    );
    assert!(result.is_err());
}

#[test]
fn memory_llm_validation_rules_are_provider_aware() {
    let mut none = UserSettings::default();
    none.memory.llm.model = "residual-model".into();
    none.memory.llm.base_url = "not-a-url".into();
    assert!(validate_settings(&none).is_ok());

    for provider in [MemoryLlmProvider::Deepseek, MemoryLlmProvider::Openai] {
        let mut missing_model = active_memory_settings(provider, "", "");
        let error = validate_settings(&missing_model).unwrap_err();
        assert!(error.contains("memory.llm.model"));
        missing_model.memory.llm.model = "model".into();
        assert!(validate_settings(&missing_model).is_ok());

        let http = active_memory_settings(provider, "model", "http://memory.example/v1");
        assert!(validate_settings(&http).is_ok());
        let https = active_memory_settings(provider, "model", "https://memory.example/v1");
        assert!(validate_settings(&https).is_ok());

        let invalid = active_memory_settings(provider, "model", "ftp://memory.example/v1");
        assert!(validate_settings(&invalid).is_err());
        let credentials = active_memory_settings(
            provider,
            "model",
            "https://user:password@memory.example/v1?token=secret",
        );
        let error = validate_settings(&credentials).unwrap_err();
        assert!(error.contains("credentials"));
        assert!(!error.contains("password"));
        assert!(!error.contains("token=secret"));
    }
}

#[test]
fn memory_secret_store_is_independent_and_uses_fixed_target() {
    let store = MemorySecretStore::default();
    store.set(SECRET_DEEPSEEK_API_KEY, "chat-secret").unwrap();
    store
        .set(SECRET_MEMORY_LLM_API_KEY, MEMORY_LLM_TEST_SECRET)
        .unwrap();
    assert_eq!(
        store.get(SECRET_MEMORY_LLM_API_KEY).unwrap().as_deref(),
        Some(MEMORY_LLM_TEST_SECRET)
    );
    assert!(store.is_configured(SECRET_MEMORY_LLM_API_KEY).unwrap());
    assert_eq!(WIN_CRED_MEMORY_LLM_API_KEY, "YUVI/memory/llm-api-key");

    store.set(SECRET_MEMORY_LLM_API_KEY, "   ").unwrap();
    assert!(!store.is_configured(SECRET_MEMORY_LLM_API_KEY).unwrap());
    store.delete(SECRET_MEMORY_LLM_API_KEY).unwrap();
    assert_eq!(
        store.get(SECRET_DEEPSEEK_API_KEY).unwrap().as_deref(),
        Some("chat-secret")
    );
    let (_dir, service, _) = service_with_memory();
    assert!(service.set_secret("memory.unknown", "value").is_err());
}

#[test]
fn memory_secret_status_is_boolean_only() {
    let (_dir, service, _) = service_with_memory();
    service
        .set_secret(SECRET_MEMORY_LLM_API_KEY, MEMORY_LLM_TEST_SECRET)
        .unwrap();
    let status = service.secret_status().unwrap();
    assert!(status.memory_llm_api_key);
    let json = serde_json::to_string(&status).unwrap();
    assert!(json.contains("memoryLlmApiKey"));
    assert!(!json.contains(MEMORY_LLM_TEST_SECRET));
    assert!(!json.contains(WIN_CRED_MEMORY_LLM_API_KEY));
}

#[test]
fn memory_llm_public_env_uses_strict_provider_names_and_activation() {
    let deepseek = active_memory_settings(MemoryLlmProvider::Deepseek, "  mem-deepseek  ", "");
    let env = public_env_overrides(&deepseek);
    assert_eq!(
        env.get("MEM0_LLM_PROVIDER").map(String::as_str),
        Some("deepseek")
    );
    assert_eq!(
        env.get("MEM0_LLM_MODEL").map(String::as_str),
        Some("mem-deepseek")
    );
    assert!(env.get("MEM0_LLM_BASE_URL").is_none());

    let openai = active_memory_settings(
        MemoryLlmProvider::Openai,
        "mem-openai",
        "https://memory.example/v1",
    );
    let env = public_env_overrides(&openai);
    assert_eq!(
        env.get("MEM0_LLM_PROVIDER").map(String::as_str),
        Some("openai")
    );
    assert_eq!(
        env.get("MEM0_LLM_MODEL").map(String::as_str),
        Some("mem-openai")
    );
    assert_eq!(
        env.get("MEM0_LLM_BASE_URL").map(String::as_str),
        Some("https://memory.example/v1")
    );

    for mut inactive in [
        UserSettings::default(),
        active_memory_settings(MemoryLlmProvider::Deepseek, "", "https://memory.example/v1"),
    ] {
        assert!(public_env_overrides(&inactive)
            .keys()
            .all(|key| !key.starts_with("MEM0_LLM_")));
        inactive.memory.enabled = false;
        assert!(public_env_overrides(&inactive)
            .keys()
            .all(|key| !key.starts_with("MEM0_LLM_")));
    }

    let mut external = openai.clone();
    external.memory.mode = ServiceMode::External;
    assert!(public_env_overrides(&external)
        .keys()
        .all(|key| !key.starts_with("MEM0_LLM_")));
    let mut legacy = openai.clone();
    legacy.memory.backend = MemoryBackend::Legacy;
    assert!(public_env_overrides(&legacy)
        .keys()
        .all(|key| !key.starts_with("MEM0_LLM_")));
}

#[test]
fn memory_llm_secret_env_never_reuses_chat_key() {
    let mut settings = active_memory_settings(MemoryLlmProvider::Deepseek, "mem-model", "");
    settings.chat.provider = "deepseek".into();
    let secrets = MemorySecretStore::default();
    secrets.set(SECRET_DEEPSEEK_API_KEY, "chat-secret").unwrap();
    let env = secret_env_overrides(&settings, &secrets).unwrap();
    assert!(env.get("MEM0_LLM_API_KEY").is_none());
    assert!(env.get("DEEPSEEK_API_KEY").is_some());

    secrets
        .set(SECRET_MEMORY_LLM_API_KEY, MEMORY_LLM_TEST_SECRET)
        .unwrap();
    let env = secret_env_overrides(&settings, &secrets).unwrap();
    assert_eq!(
        env.get("MEM0_LLM_API_KEY").map(String::as_str),
        Some(MEMORY_LLM_TEST_SECRET)
    );
    assert_eq!(
        env.get("DEEPSEEK_API_KEY").map(String::as_str),
        Some("chat-secret")
    );
    let push = supervisor_config_push(&settings, &secrets).unwrap();
    assert_eq!(
        push.env.get("MEM0_LLM_API_KEY").map(String::as_str),
        Some(MEMORY_LLM_TEST_SECRET)
    );
}

#[test]
fn memory_llm_secret_env_skips_inactive_modes() {
    let secrets = MemorySecretStore::default();
    secrets
        .set(SECRET_MEMORY_LLM_API_KEY, MEMORY_LLM_TEST_SECRET)
        .unwrap();
    let mut cases = vec![UserSettings::default()];
    let active = active_memory_settings(MemoryLlmProvider::Openai, "model", "");
    let mut external = active.clone();
    external.memory.mode = ServiceMode::External;
    let mut legacy = active.clone();
    legacy.memory.backend = MemoryBackend::Legacy;
    let mut disabled = active.clone();
    disabled.memory.enabled = false;
    cases.extend([external, legacy, disabled]);

    for settings in cases {
        let env = secret_env_overrides(&settings, &secrets).unwrap();
        assert!(env.get("MEM0_LLM_API_KEY").is_none());
    }
}

#[test]
fn memory_llm_unset_env_clears_stale_values_deterministically() {
    let secrets = MemorySecretStore::default();
    let inactive = UserSettings::default();
    let unset = unset_env_for_supervisor(&inactive, &secrets).unwrap();
    for key in [
        "MEM0_LLM_PROVIDER",
        "MEM0_LLM_MODEL",
        "MEM0_LLM_BASE_URL",
        "MEM0_LLM_API_KEY",
    ] {
        assert!(unset.iter().any(|value| value == key));
    }

    let active = active_memory_settings(MemoryLlmProvider::Openai, "model", "");
    let unset = unset_env_for_supervisor(&active, &secrets).unwrap();
    assert!(!unset.iter().any(|key| key == "MEM0_LLM_PROVIDER"));
    assert!(!unset.iter().any(|key| key == "MEM0_LLM_MODEL"));
    assert!(unset.iter().any(|key| key == "MEM0_LLM_BASE_URL"));
    assert!(unset.iter().any(|key| key == "MEM0_LLM_API_KEY"));

    secrets
        .set(SECRET_MEMORY_LLM_API_KEY, MEMORY_LLM_TEST_SECRET)
        .unwrap();
    let unset_with_key = unset_env_for_supervisor(&active, &secrets).unwrap();
    assert!(!unset_with_key.iter().any(|key| key == "MEM0_LLM_API_KEY"));

    let mut none = active.clone();
    none.memory.llm.provider = MemoryLlmProvider::None;
    let cleared = unset_env_for_supervisor(&none, &secrets).unwrap();
    for key in [
        "MEM0_LLM_PROVIDER",
        "MEM0_LLM_MODEL",
        "MEM0_LLM_BASE_URL",
        "MEM0_LLM_API_KEY",
    ] {
        assert!(cleared.iter().any(|value| value == key));
    }
    let mut sorted = cleared.clone();
    sorted.sort();
    assert_eq!(cleared.len(), sorted.len());
    for pair in cleared.windows(2) {
        assert_ne!(pair[0], pair[1]);
    }
}

#[test]
fn memory_llm_changes_restart_memory_only() {
    let before = UserSettings::default();
    let mut after = before.clone();
    after.memory.llm.provider = MemoryLlmProvider::Deepseek;
    after.memory.llm.model = "memory-model".into();
    let services = compute_restart_services(&before, &after);
    assert_eq!(services, vec!["memory"]);
    assert!(!restart_application_needed(&before, &after));

    let mut base_changed = after.clone();
    base_changed.memory.llm.base_url = "https://memory.example/v1".into();
    assert_eq!(
        compute_restart_services(&after, &base_changed),
        vec!["memory"]
    );
    assert!(!restart_application_needed(&after, &base_changed));
}

#[test]
fn memory_secret_restart_hint_is_memory_only() {
    assert_eq!(
        super::secret_restart_hint(SECRET_MEMORY_LLM_API_KEY),
        vec!["memory"]
    );
}

#[test]
fn memory_llm_secret_never_enters_settings_or_result_json() {
    let (_dir, service, _) = service_with_memory();
    service
        .set_secret(SECRET_MEMORY_LLM_API_KEY, MEMORY_LLM_TEST_SECRET)
        .unwrap();
    let view_json = serde_json::to_string(&service.get_view().unwrap()).unwrap();
    assert!(!view_json.contains(MEMORY_LLM_TEST_SECRET));

    let mut patch = UserSettingsPatch::default();
    patch.memory = Some(MemorySettingsPatch {
        llm: Some(MemoryLlmSettingsPatch {
            provider: Some(MemoryLlmProvider::Deepseek),
            model: Some("memory-model".into()),
            ..Default::default()
        }),
        ..Default::default()
    });
    let result = service.update_settings(patch).unwrap();
    let result_json = serde_json::to_string(&result).unwrap();
    assert!(!result_json.contains(MEMORY_LLM_TEST_SECRET));
    let mutation = SecretMutationResult {
        saved: true,
        secrets: service.secret_status().unwrap(),
        restart_services: vec!["memory".into()],
        supervisor_sync: SupervisorSyncStatus::applied_ok(),
    };
    let mutation_json = serde_json::to_string(&mutation).unwrap();
    assert!(!mutation_json.contains(MEMORY_LLM_TEST_SECRET));
    let settings_json = fs::read_to_string(service.settings_path()).unwrap();
    assert!(!settings_json.contains(MEMORY_LLM_TEST_SECRET));
    assert!(!settings_json.contains("apiKey"));
}

/// Opt-in Windows-only integration coverage for the production Credential
/// Manager adapter and the ConfigService → Supervisor environment projection.
/// The default test run is deliberately side-effect free.
#[cfg(windows)]
#[test]
fn platform_credential_manager_roundtrip_and_config_push() {
    if std::env::var("YUVI_RUN_WINDOWS_CREDENTIAL_TEST")
        .ok()
        .as_deref()
        != Some("1")
    {
        return;
    }

    use std::panic::{catch_unwind, AssertUnwindSafe};

    const CHAT_SECRET: &str = "YUVI_CI_CHAT_SECRET_DO_NOT_LOG";
    const OPENAI_SECRET: &str = "YUVI_CI_OPENAI_SECRET_DO_NOT_LOG";
    const DATABASE_SECRET: &str = "YUVI_CI_DATABASE_SECRET_DO_NOT_LOG";
    const MEMORY_SECRET: &str = "YUVI_CI_MEMORY_SECRET_DO_NOT_LOG";
    let store = Arc::new(super::secrets::PlatformSecretStore);
    let keys = [
        super::secrets::SECRET_DEEPSEEK_API_KEY,
        super::secrets::SECRET_OPENAI_COMPATIBLE_API_KEY,
        super::secrets::SECRET_DATABASE_URL,
        super::secrets::SECRET_MEMORY_LLM_API_KEY,
    ];

    let run = catch_unwind(AssertUnwindSafe(|| {
        for key in keys {
            store
                .delete(key)
                .expect("pre-test Credential Manager cleanup");
        }
        store
            .set(super::secrets::SECRET_DEEPSEEK_API_KEY, CHAT_SECRET)
            .expect("set chat test credential");
        store
            .set(
                super::secrets::SECRET_OPENAI_COMPATIBLE_API_KEY,
                OPENAI_SECRET,
            )
            .expect("set OpenAI-compatible test credential");
        store
            .set(super::secrets::SECRET_DATABASE_URL, DATABASE_SECRET)
            .expect("set database test credential");
        store
            .set(super::secrets::SECRET_MEMORY_LLM_API_KEY, MEMORY_SECRET)
            .expect("set memory test credential");

        for key in keys {
            assert!(store.is_configured(key).expect("credential status"));
        }
        assert!(
            store
                .get(super::secrets::SECRET_DEEPSEEK_API_KEY)
                .expect("read chat test credential")
                .as_deref()
                == Some(CHAT_SECRET)
        );
        assert!(
            store
                .get(super::secrets::SECRET_DATABASE_URL)
                .expect("read database test credential")
                .as_deref()
                == Some(DATABASE_SECRET)
        );
        assert!(
            store
                .get(super::secrets::SECRET_MEMORY_LLM_API_KEY)
                .expect("read memory test credential")
                .as_deref()
                == Some(MEMORY_SECRET)
        );

        let dir = tempdir().expect("temp config directory");
        let service = ConfigService::open(
            dir.path().to_path_buf(),
            store.clone() as Arc<dyn SecretStore>,
        );
        let mut patch = UserSettingsPatch::default();
        patch.memory = Some(MemorySettingsPatch {
            llm: Some(MemoryLlmSettingsPatch {
                provider: Some(MemoryLlmProvider::Deepseek),
                model: Some("ci-memory-model".into()),
                base_url: Some("https://api.deepseek.com/v1".into()),
            }),
            ..Default::default()
        });
        let result = service
            .update_settings(patch)
            .expect("save active Memory LLM settings");
        let view = service.get_view().expect("read settings view");
        assert_eq!(view.settings.memory.backend, MemoryBackend::Mem0);
        assert_eq!(view.settings.memory.mode, ServiceMode::Managed);
        assert_eq!(
            view.settings.memory.llm.provider,
            MemoryLlmProvider::Deepseek
        );
        assert_eq!(view.settings.memory.llm.model, "ci-memory-model");
        assert!(view.secrets.deepseek_api_key);
        assert!(view.secrets.openai_compatible_api_key);
        assert!(view.secrets.database_url);
        assert!(view.secrets.memory_llm_api_key);

        let push = service
            .supervisor_config_push()
            .expect("build Supervisor config push");
        assert!(push.env.get("DEEPSEEK_API_KEY").map(String::as_str) == Some(CHAT_SECRET));
        assert!(
            push.env
                .get("OPENAI_COMPATIBLE_API_KEY")
                .map(String::as_str)
                == Some(OPENAI_SECRET)
        );
        assert!(push.env.get("DATABASE_URL").map(String::as_str) == Some(DATABASE_SECRET));
        assert!(push.env.get("MEM0_LLM_API_KEY").map(String::as_str) == Some(MEMORY_SECRET));

        let view_json = serde_json::to_string(&view).expect("serialize settings view");
        let result_json = serde_json::to_string(&result).expect("serialize update result");
        assert!(!view_json.contains(CHAT_SECRET));
        assert!(!view_json.contains(OPENAI_SECRET));
        assert!(!view_json.contains(DATABASE_SECRET));
        assert!(!view_json.contains(MEMORY_SECRET));
        assert!(!result_json.contains(CHAT_SECRET));
        assert!(!result_json.contains(OPENAI_SECRET));
        assert!(!result_json.contains(DATABASE_SECRET));
        assert!(!result_json.contains(MEMORY_SECRET));
        let settings_json =
            fs::read_to_string(service.settings_path()).expect("read settings JSON");
        assert!(!settings_json.contains(CHAT_SECRET));
        assert!(!settings_json.contains(OPENAI_SECRET));
        assert!(!settings_json.contains(DATABASE_SECRET));
        assert!(!settings_json.contains(MEMORY_SECRET));
    }));

    let cleanup = keys.iter().try_for_each(|key| store.delete(key));
    assert!(
        cleanup.is_ok(),
        "post-test Credential Manager cleanup failed"
    );
    for key in keys {
        assert!(!store
            .is_configured(key)
            .expect("post-test credential status"));
    }
    if run.is_err() {
        panic!("Credential Manager round-trip integration test failed");
    }
}

#[test]
fn postgres_password_is_not_user_editable_and_not_in_settings_view() {
    let (_dir, service, _) = service_with_memory();
    assert!(service
        .set_secret(SECRET_POSTGRES_LOCAL_PASSWORD, "should-fail")
        .is_err());
    let generated = service.ensure_private_postgres_password().unwrap();
    assert!(!generated.is_empty());
    let again = service.ensure_private_postgres_password().unwrap();
    assert_eq!(generated, again);
    let view = service.get_view().unwrap();
    let json = serde_json::to_string(&view).unwrap();
    assert!(!json.contains(&generated));
    assert!(!json.contains("postgres.localPassword"));
}

#[test]
fn postgres_password_unset_when_credential_missing() {
    let secrets = MemorySecretStore::default();
    secrets
        .set(SECRET_POSTGRES_LOCAL_PASSWORD, "pg-secret")
        .unwrap();
    let settings = UserSettings::default();
    let push = supervisor_config_push(&settings, &secrets).unwrap();
    assert_eq!(
        push.env.get("YUVI_POSTGRES_PASSWORD").map(String::as_str),
        Some("pg-secret")
    );
    assert!(!push
        .unset_env
        .iter()
        .any(|key| key == "YUVI_POSTGRES_PASSWORD"));

    secrets.delete(SECRET_POSTGRES_LOCAL_PASSWORD).unwrap();
    let push2 = supervisor_config_push(&settings, &secrets).unwrap();
    assert!(push2.env.get("YUVI_POSTGRES_PASSWORD").is_none());
    assert!(push2
        .unset_env
        .iter()
        .any(|key| key == "YUVI_POSTGRES_PASSWORD"));
    assert!(push2.unset_env.iter().any(|key| key == "PGPASSWORD"));
    let json = serde_json::to_string(&push2).unwrap();
    assert!(!json.contains("pg-secret"));
}
