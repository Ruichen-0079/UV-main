use super::schema::{UserSettings, UserSettingsPatch, SCHEMA_VERSION};
use url::Url;

pub fn validate_settings(settings: &UserSettings) -> Result<(), String> {
  if settings.schema_version != SCHEMA_VERSION {
    return Err(format!(
      "unsupported schemaVersion {} (expected {})",
      settings.schema_version, SCHEMA_VERSION
    ));
  }
  validate_http_url(&settings.runtime.url, "runtime.url")?;
  validate_http_url(&settings.memory.base_url, "memory.baseUrl")?;
  validate_http_url(&settings.memory.ollama_url, "memory.ollamaUrl")?;
  validate_http_url(&settings.tts.wrapper_url, "tts.wrapperUrl")?;
  validate_http_url(&settings.tts.upstream_url, "tts.upstreamUrl")?;
  if settings.chat.provider.trim().is_empty() {
    return Err("chat.provider is required".into());
  }
  if settings.chat.model.trim().is_empty() {
    return Err("chat.model is required".into());
  }
  if settings.memory.subject_user_id.trim().is_empty() {
    return Err("memory.subjectUserId is required".into());
  }
  if settings.memory.persona_id.trim().is_empty() {
    return Err("memory.personaId is required".into());
  }
  let _ = settings.memory.backend;
  let _ = settings.runtime.mode;
  Ok(())
}

pub fn apply_patch(base: &UserSettings, patch: &UserSettingsPatch) -> Result<UserSettings, String> {
  let mut next = base.clone();
  if let Some(app) = &patch.app {
    if let Some(language) = &app.language {
      next.app.language = language.trim().to_string();
    }
  }
  if let Some(chat) = &patch.chat {
    if let Some(provider) = &chat.provider {
      next.chat.provider = provider.trim().to_string();
    }
    if let Some(model) = &chat.model {
      next.chat.model = model.trim().to_string();
    }
  }
  if let Some(runtime) = &patch.runtime {
    if let Some(mode) = runtime.mode {
      next.runtime.mode = mode;
    }
    if let Some(autostart) = runtime.autostart {
      next.runtime.autostart = autostart;
    }
    if let Some(url) = &runtime.url {
      next.runtime.url = url.trim().to_string();
    }
  }
  if let Some(memory) = &patch.memory {
    if let Some(enabled) = memory.enabled {
      next.memory.enabled = enabled;
    }
    if let Some(backend) = memory.backend {
      next.memory.backend = backend;
    }
    if let Some(mode) = memory.mode {
      next.memory.mode = mode;
    }
    if let Some(url) = &memory.base_url {
      next.memory.base_url = url.trim().to_string();
    }
    if let Some(id) = &memory.subject_user_id {
      next.memory.subject_user_id = id.trim().to_string();
    }
    if let Some(id) = &memory.persona_id {
      next.memory.persona_id = id.trim().to_string();
    }
    if let Some(url) = &memory.ollama_url {
      next.memory.ollama_url = url.trim().to_string();
    }
  }
  if let Some(tts) = &patch.tts {
    if let Some(enabled) = tts.enabled {
      next.tts.enabled = enabled;
    }
    if let Some(mode) = tts.mode {
      next.tts.mode = mode;
    }
    if let Some(url) = &tts.wrapper_url {
      next.tts.wrapper_url = url.trim().to_string();
    }
    if let Some(url) = &tts.upstream_url {
      next.tts.upstream_url = url.trim().to_string();
    }
  }
  if let Some(companion) = &patch.companion {
    if let Some(always_on_top) = companion.always_on_top {
      next.companion.always_on_top = always_on_top;
    }
  }
  next.schema_version = SCHEMA_VERSION;
  validate_settings(&next)?;
  Ok(next)
}

fn validate_http_url(raw: &str, field: &str) -> Result<(), String> {
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return Err(format!("{field} is required"));
  }
  let parsed = Url::parse(trimmed).map_err(|_| format!("{field} is not a valid URL"))?;
  match parsed.scheme() {
    "http" | "https" => Ok(()),
    other => Err(format!("{field} must be http/https (got {other})")),
  }
}
