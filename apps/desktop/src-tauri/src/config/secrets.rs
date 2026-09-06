//! Secret store abstraction. Never log secret values.

use std::collections::HashMap;
use std::sync::Mutex;

pub const SECRET_DEEPSEEK_API_KEY: &str = "chat.deepseekApiKey";
pub const SECRET_OPENAI_COMPATIBLE_API_KEY: &str = "models.openaiCompatibleApiKey";
pub const SECRET_DATABASE_URL: &str = "memory.databaseUrl";
pub const SECRET_MEMORY_LLM_API_KEY: &str = "memory.llmApiKey";
pub const SECRET_POSTGRES_LOCAL_PASSWORD: &str = "postgres.localPassword";

pub fn generate_postgres_password() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    fill_random(&mut bytes)?;
    Ok(base64url(&bytes))
}

fn fill_random(buf: &mut [u8]) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::io::Read;
        std::fs::File::open("/dev/urandom")
            .and_then(|mut file| file.read_exact(buf))
            .map_err(|error| error.to_string())
    }
    #[cfg(windows)]
    {
        type NtStatus = i32;
        #[link(name = "bcrypt")]
        extern "system" {
            fn BCryptGenRandom(
                h_algorithm: *mut core::ffi::c_void,
                pb_buffer: *mut u8,
                cb_buffer: u32,
                dw_flags: u32,
            ) -> NtStatus;
        }
        const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;
        let status = unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                buf.as_mut_ptr(),
                buf.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if status != 0 {
            return Err(format!("BCryptGenRandom failed ({status})"));
        }
        Ok(())
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = buf;
        Err("secure random is unavailable on this platform".into())
    }
}

fn base64url(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    let mut i = 0;
    while i < bytes.len() {
        let b0 = bytes[i];
        let b1 = if i + 1 < bytes.len() { bytes[i + 1] } else { 0 };
        let b2 = if i + 2 < bytes.len() { bytes[i + 2] } else { 0 };
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if i + 1 < bytes.len() {
            out.push(TABLE[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
        }
        if i + 2 < bytes.len() {
            out.push(TABLE[(b2 & 0x3f) as usize] as char);
        }
        i += 3;
    }
    out
}

pub const WIN_CRED_DEEPSEEK: &str = "YUVI/chat/deepseek-api-key";
pub const WIN_CRED_OPENAI_COMPATIBLE: &str = "YUVI/models/openai-compatible-api-key";
pub const WIN_CRED_DATABASE: &str = "YUVI/memory/database-url";
pub const WIN_CRED_MEMORY_LLM_API_KEY: &str = "YUVI/memory/llm-api-key";
pub const WIN_CRED_POSTGRES_LOCAL: &str = "YUVI/postgres/local";

pub trait SecretStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
    fn delete(&self, key: &str) -> Result<(), String>;
    fn is_configured(&self, key: &str) -> Result<bool, String> {
        Ok(self
            .get(key)?
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false))
    }
}

/// In-memory store for unit tests and non-Windows fallbacks.
#[derive(Default)]
#[allow(dead_code)] // exercised in unit tests; kept for SecretStore trait demos
pub struct MemorySecretStore {
    inner: Mutex<HashMap<String, String>>,
}

impl SecretStore for MemorySecretStore {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| "secret store lock poisoned".to_string())?;
        Ok(guard.get(key).cloned())
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return self.delete(key);
        }
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "secret store lock poisoned".to_string())?;
        guard.insert(key.to_string(), trimmed.to_string());
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "secret store lock poisoned".to_string())?;
        guard.remove(key);
        Ok(())
    }
}

/// Platform secret store via `keyring`: Windows Credential Manager or Linux Secret Service.
pub struct PlatformSecretStore;

impl PlatformSecretStore {
    fn map_key(key: &str) -> Result<&'static str, String> {
        match key {
            SECRET_DEEPSEEK_API_KEY => Ok(WIN_CRED_DEEPSEEK),
            SECRET_OPENAI_COMPATIBLE_API_KEY => Ok(WIN_CRED_OPENAI_COMPATIBLE),
            SECRET_DATABASE_URL => Ok(WIN_CRED_DATABASE),
            SECRET_MEMORY_LLM_API_KEY => Ok(WIN_CRED_MEMORY_LLM_API_KEY),
            SECRET_POSTGRES_LOCAL_PASSWORD => Ok(WIN_CRED_POSTGRES_LOCAL),
            other => Err(format!("unsupported secret key: {other}")),
        }
    }
}

impl SecretStore for PlatformSecretStore {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        #[cfg(any(windows, target_os = "linux"))]
        {
            let target = Self::map_key(key)?;
            let entry = keyring::Entry::new("YUVI", target).map_err(|e| e.to_string())?;
            match entry.get_password() {
                Ok(value) => Ok(Some(value)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(error) => Err(error.to_string()),
            }
        }

        #[cfg(not(any(windows, target_os = "linux")))]
        {
            let _ = Self::map_key(key)?;
            Err("Platform secret storage is not supported on this operating system".to_string())
        }
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return self.delete(key);
        }
        #[cfg(any(windows, target_os = "linux"))]
        {
            let target = Self::map_key(key)?;
            let entry = keyring::Entry::new("YUVI", target).map_err(|e| e.to_string())?;
            entry.set_password(trimmed).map_err(|e| e.to_string())
        }
        #[cfg(not(any(windows, target_os = "linux")))]
        {
            let _ = Self::map_key(key)?;
            Err("Platform secret storage is not supported on this operating system".to_string())
        }
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        #[cfg(any(windows, target_os = "linux"))]
        {
            let target = Self::map_key(key)?;
            let entry = keyring::Entry::new("YUVI", target).map_err(|e| e.to_string())?;
            match entry.delete_credential() {
                Ok(()) => Ok(()),
                Err(keyring::Error::NoEntry) => Ok(()),
                Err(error) => Err(error.to_string()),
            }
        }
        #[cfg(not(any(windows, target_os = "linux")))]
        {
            let _ = Self::map_key(key)?;
            Err("Platform secret storage is not supported on this operating system".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_llm_key_maps_to_fixed_credential_target() {
        assert_eq!(
            PlatformSecretStore::map_key(SECRET_OPENAI_COMPATIBLE_API_KEY).unwrap(),
            WIN_CRED_OPENAI_COMPATIBLE
        );
        assert_eq!(
            PlatformSecretStore::map_key(SECRET_MEMORY_LLM_API_KEY).unwrap(),
            WIN_CRED_MEMORY_LLM_API_KEY
        );
        assert_eq!(
            PlatformSecretStore::map_key(SECRET_POSTGRES_LOCAL_PASSWORD).unwrap(),
            WIN_CRED_POSTGRES_LOCAL
        );
        assert!(PlatformSecretStore::map_key("memory.unknown").is_err());
    }
}
