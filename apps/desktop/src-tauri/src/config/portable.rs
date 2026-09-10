//! Portable transport constraints inside the existing configuration authority.
use super::schema::{ServiceMode, SttProvider, UserSettings};

pub(super) fn rebase_endpoints(settings: &mut UserSettings) {
    settings.runtime.url = "http://127.0.0.1:16121".into();
    settings.memory.base_url = "http://127.0.0.1:16131".into();
    settings.stt.base_url = "http://127.0.0.1:19876".into();
    settings.tts.wrapper_url = "http://127.0.0.1:19881".into();
    settings.tts.upstream_url = "http://127.0.0.1:19880".into();
}

pub(super) fn validate(settings: &UserSettings) -> Result<(), String> {
    let mut expected = settings.clone();
    rebase_endpoints(&mut expected);
    if settings.runtime.url != expected.runtime.url
        || settings.memory.base_url != expected.memory.base_url
        || settings.stt.base_url != expected.stt.base_url
        || settings.tts.wrapper_url != expected.tts.wrapper_url
        || settings.tts.upstream_url != expected.tts.upstream_url
        || settings.runtime.mode != ServiceMode::Managed
        || (settings.memory.enabled && settings.memory.mode != ServiceMode::Managed)
        || (settings.stt.provider == SttProvider::Local && settings.stt.mode != ServiceMode::Managed)
        || settings.tts.enabled
    {
        return Err("Portable requires its own managed service endpoints; external local services and unbundled local TTS are unavailable.".into());
    }
    Ok(())
}
