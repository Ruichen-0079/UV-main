use super::env_export::{
  combined_env_for_supervisor, public_env_overrides, secret_env_overrides,
  supervisor_config_push, unset_env_for_supervisor,
};
use super::impact::compute_restart_services;
use super::schema::{
  MemoryBackend, ServiceMode, UserSettings, UserSettingsPatch, SCHEMA_VERSION,
};
use super::secrets::{
  MemorySecretStore, SecretStore, SECRET_DATABASE_URL, SECRET_DEEPSEEK_API_KEY,
};
use super::schema::{redact_supervisor_error, SupervisorSyncStatus};
use super::service::{atomic_write_json, replace_file, ConfigService};
use super::validate::{apply_patch, validate_settings};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tempfile::tempdir;

fn service_with_memory() -> (tempfile::TempDir, Arc<ConfigService>, Arc<MemorySecretStore>) {
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
  assert_eq!(view.settings.chat.provider, "deepseek");
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
  assert_eq!(view.settings.chat.provider, "deepseek");
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
}

#[test]
fn managed_env_includes_secrets_external_runtime_skips_chat_key() {
  let secrets = MemorySecretStore::default();
  secrets
    .set(SECRET_DEEPSEEK_API_KEY, "sk-secret")
    .unwrap();
  secrets
    .set(SECRET_DATABASE_URL, "postgres://yuvi:pass@127.0.0.1:5432/yuvi")
    .unwrap();

  let mut managed = UserSettings::default();
  managed.runtime.mode = ServiceMode::Managed;
  managed.memory.mode = ServiceMode::Managed;
  let env = combined_env_for_supervisor(&managed, &secrets).unwrap();
  assert_eq!(env.get("DEEPSEEK_API_KEY").map(String::as_str), Some("sk-secret"));
  assert!(env.get("DATABASE_URL").is_some());
  assert_eq!(env.get("YUVI_AUTOSTART_RUNTIME").map(String::as_str), Some("true"));

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
  assert_eq!(public.get("DEFAULT_TTS_PROVIDER").map(String::as_str), Some("local"));
  assert_eq!(public.get("TTS_PROVIDER_CHAIN").map(String::as_str), Some("local"));
  assert_eq!(public.get("LOCAL_TTS_MODEL").map(String::as_str), Some("alice-v4"));
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
  assert_eq!(next.chat.provider, "deepseek");
  assert_eq!(next.memory.backend, MemoryBackend::Mem0);
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
  secrets
    .set(SECRET_DEEPSEEK_API_KEY, "sk-A")
    .unwrap();
  let mut settings = UserSettings::default();
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
  secrets
    .set(SECRET_DEEPSEEK_API_KEY, "sk-keep")
    .unwrap();
  secrets
    .set(SECRET_DATABASE_URL, "postgres://yuvi:x@127.0.0.1:5432/yuvi")
    .unwrap();
  let mut settings = UserSettings::default();
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
    atomic_fn.contains("replace_file") || src.contains("MoveFileExW") || src.contains("fs::rename"),
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
