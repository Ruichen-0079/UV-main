//! Build env overrides for the desktop supervisor / managed child processes.
//! Never puts secrets into logs or command-line arguments.

use super::schema::{MemoryBackend, MemoryLlmProvider, ServiceMode, UserSettings};
use super::secrets::{
    SecretStore, SECRET_DATABASE_URL, SECRET_DEEPSEEK_API_KEY, SECRET_MEMORY_LLM_API_KEY,
};
use serde::Serialize;
use std::collections::BTreeMap;

/// Public (non-secret) env overrides derived from user settings.
pub fn public_env_overrides(settings: &UserSettings) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();

    env.insert(
        "YUVI_AUTOSTART_RUNTIME".into(),
        bool_flag(settings.runtime.autostart && settings.runtime.mode == ServiceMode::Managed),
    );
    env.insert(
        "YUVI_AUTOSTART_MEM0".into(),
        bool_flag(
            settings.memory.enabled
                && settings.memory.mode == ServiceMode::Managed
                && matches!(settings.memory.backend, MemoryBackend::Mem0),
        ),
    );
    env.insert(
        "YUVI_AUTOSTART_TTS".into(),
        bool_flag(settings.tts.enabled && settings.tts.mode == ServiceMode::Managed),
    );

    // Runtime URL → host/port when possible.
    if let Some((host, port)) = split_http_host_port(&settings.runtime.url) {
        env.insert("SERVER_HOST".into(), host);
        env.insert("SERVER_PORT".into(), port);
    }

    env.insert(
        "MEMORY_BACKEND".into(),
        match settings.memory.backend {
            MemoryBackend::Mem0 => "mem0".into(),
            MemoryBackend::Legacy => "legacy".into(),
        },
    );
    env.insert("MEM0_BASE_URL".into(), settings.memory.base_url.clone());
    env.insert(
        "MEMORY_SUBJECT_USER_ID".into(),
        settings.memory.subject_user_id.clone(),
    );
    env.insert(
        "MEMORY_PERSONA_ID".into(),
        settings.memory.persona_id.clone(),
    );
    env.insert(
        "MEM0_OLLAMA_BASE_URL".into(),
        settings.memory.ollama_url.clone(),
    );
    env.insert("OLLAMA_HOST".into(), settings.memory.ollama_url.clone());

    env.insert(
        "GPT_SOVITS_TTS_BASE_URL".into(),
        settings.tts.wrapper_url.clone(),
    );
    env.insert(
        "GPT_SOVITS_TTS_UPSTREAM_URL".into(),
        settings.tts.upstream_url.clone(),
    );

    // The packaged desktop ships with the local Alice GPT-SoVITS stack as its
    // TTS deployment. Keep the provider chain explicit so an unset xAI key does
    // not make /v1/tts fail before it reaches the healthy local wrapper.
    env.insert("DEFAULT_TTS_PROVIDER".into(), "local".into());
    env.insert("TTS_PROVIDER_CHAIN".into(), "local".into());
    env.insert("LOCAL_TTS_MODEL".into(), "alice-v4".into());

    if memory_llm_active(settings) {
        env.insert(
            "MEM0_LLM_PROVIDER".into(),
            memory_llm_provider_name(settings).into(),
        );
        env.insert(
            "MEM0_LLM_MODEL".into(),
            settings.memory.llm.model.trim().into(),
        );
        let base_url = settings.memory.llm.base_url.trim();
        if !base_url.is_empty() {
            env.insert("MEM0_LLM_BASE_URL".into(), base_url.into());
        }
    }

    if settings.chat.provider == "deepseek" {
        env.insert("DEEPSEEK_CHAT_MODEL".into(), settings.chat.model.clone());
    }

    env
}

/// Secrets injected only for managed services that need them.
pub fn secret_env_overrides(
    settings: &UserSettings,
    secrets: &dyn SecretStore,
) -> Result<BTreeMap<String, String>, String> {
    let mut env = BTreeMap::new();

    // Chat key: only when runtime is managed (Runtime process will read DEEPSEEK_API_KEY).
    if settings.runtime.mode == ServiceMode::Managed {
        if let Some(key) = secrets.get(SECRET_DEEPSEEK_API_KEY)? {
            if !key.trim().is_empty() {
                env.insert("DEEPSEEK_API_KEY".into(), key);
            }
        }
    }

    // DATABASE_URL only for managed memory consumers we own — never for external.
    if settings.memory.mode == ServiceMode::Managed {
        if let Some(url) = secrets.get(SECRET_DATABASE_URL)? {
            if !url.trim().is_empty() {
                env.insert("DATABASE_URL".into(), url);
            }
        }
    }

    if memory_llm_active(settings) {
        if let Some(key) = secrets.get(SECRET_MEMORY_LLM_API_KEY)? {
            if !key.trim().is_empty() {
                env.insert("MEM0_LLM_API_KEY".into(), key.trim().into());
            }
        }
    }

    Ok(env)
}

pub fn combined_env_for_supervisor(
    settings: &UserSettings,
    secrets: &dyn SecretStore,
) -> Result<BTreeMap<String, String>, String> {
    let mut env = public_env_overrides(settings);
    for (k, v) in secret_env_overrides(settings, secrets)? {
        env.insert(k, v);
    }
    Ok(env)
}

/// Keys that must be removed from Supervisor/child env when not actively injected.
/// Critical for secret delete and managed→external so old values are not inherited.
pub fn unset_env_for_supervisor(
    settings: &UserSettings,
    secrets: &dyn SecretStore,
) -> Result<Vec<String>, String> {
    let mut unset = Vec::new();
    let inject_deepseek = settings.runtime.mode == ServiceMode::Managed
        && secrets
            .is_configured(SECRET_DEEPSEEK_API_KEY)
            .unwrap_or(false);
    if !inject_deepseek {
        unset.push("DEEPSEEK_API_KEY".into());
    }

    let inject_db = settings.memory.mode == ServiceMode::Managed
        && secrets.is_configured(SECRET_DATABASE_URL).unwrap_or(false);
    if !inject_db {
        unset.push("DATABASE_URL".into());
    }

    let memory_llm_active = memory_llm_active(settings);
    if !memory_llm_active {
        push_unique(&mut unset, "MEM0_LLM_PROVIDER");
        push_unique(&mut unset, "MEM0_LLM_MODEL");
        push_unique(&mut unset, "MEM0_LLM_BASE_URL");
        push_unique(&mut unset, "MEM0_LLM_API_KEY");
    } else {
        if settings.memory.llm.base_url.trim().is_empty() {
            push_unique(&mut unset, "MEM0_LLM_BASE_URL");
        }
        if !secrets
            .is_configured(SECRET_MEMORY_LLM_API_KEY)
            .unwrap_or(false)
        {
            push_unique(&mut unset, "MEM0_LLM_API_KEY");
        }
    }

    Ok(unset)
}

fn memory_llm_active(settings: &UserSettings) -> bool {
    settings.memory.enabled
        && settings.memory.mode == ServiceMode::Managed
        && matches!(settings.memory.backend, MemoryBackend::Mem0)
        && !matches!(settings.memory.llm.provider, MemoryLlmProvider::None)
        && !settings.memory.llm.model.trim().is_empty()
}

fn memory_llm_provider_name(settings: &UserSettings) -> &'static str {
    match settings.memory.llm.provider {
        MemoryLlmProvider::Deepseek => "deepseek",
        MemoryLlmProvider::Openai => "openai",
        MemoryLlmProvider::None => "none",
    }
}

fn push_unique(unset: &mut Vec<String>, key: &str) {
    if !unset.iter().any(|existing| existing == key) {
        unset.push(key.into());
    }
}

/// Payload for Supervisor POST /v1/config (secrets only in env map, never logged).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorConfigPush {
    pub env: BTreeMap<String, String>,
    pub unset_env: Vec<String>,
}

pub fn supervisor_config_push(
    settings: &UserSettings,
    secrets: &dyn SecretStore,
) -> Result<SupervisorConfigPush, String> {
    Ok(SupervisorConfigPush {
        env: combined_env_for_supervisor(settings, secrets)?,
        unset_env: unset_env_for_supervisor(settings, secrets)?,
    })
}

fn bool_flag(value: bool) -> String {
    if value {
        "true".into()
    } else {
        "false".into()
    }
}

fn split_http_host_port(url: &str) -> Option<(String, String)> {
    let parsed = url::Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_string();
    let port = parsed
        .port_or_known_default()
        .map(|p| p.to_string())
        .unwrap_or_else(|| "80".into());
    Some((host, port))
}
