//! Secret store abstraction. Never log secret values.

use std::collections::HashMap;
use std::sync::Mutex;

pub const SECRET_DEEPSEEK_API_KEY: &str = "chat.deepseekApiKey";
pub const SECRET_DATABASE_URL: &str = "memory.databaseUrl";

pub const WIN_CRED_DEEPSEEK: &str = "YUVI/chat/deepseek-api-key";
pub const WIN_CRED_DATABASE: &str = "YUVI/memory/database-url";

pub trait SecretStore: Send + Sync {
  fn get(&self, key: &str) -> Result<Option<String>, String>;
  fn set(&self, key: &str, value: &str) -> Result<(), String>;
  fn delete(&self, key: &str) -> Result<(), String>;
  fn is_configured(&self, key: &str) -> Result<bool, String> {
    Ok(self.get(key)?.map(|v| !v.trim().is_empty()).unwrap_or(false))
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

/// Windows Credential Manager via `keyring`. Other platforms return unsupported.
pub struct PlatformSecretStore;

impl PlatformSecretStore {
  fn map_key(key: &str) -> Result<&'static str, String> {
    match key {
      SECRET_DEEPSEEK_API_KEY => Ok(WIN_CRED_DEEPSEEK),
      SECRET_DATABASE_URL => Ok(WIN_CRED_DATABASE),
      other => Err(format!("unsupported secret key: {other}")),
    }
  }
}

impl SecretStore for PlatformSecretStore {
  fn get(&self, key: &str) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
      let target = Self::map_key(key)?;
      let entry = keyring::Entry::new("YUVI", target).map_err(|e| e.to_string())?;
      match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
      }
    }
    #[cfg(not(windows))]
    {
      let _ = Self::map_key(key)?;
      Err("Credential Manager secrets are only supported on Windows".to_string())
    }
  }

  fn set(&self, key: &str, value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
      return self.delete(key);
    }
    #[cfg(windows)]
    {
      let target = Self::map_key(key)?;
      let entry = keyring::Entry::new("YUVI", target).map_err(|e| e.to_string())?;
      entry.set_password(trimmed).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
      let _ = Self::map_key(key)?;
      Err("Credential Manager secrets are only supported on Windows".to_string())
    }
  }

  fn delete(&self, key: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
      let target = Self::map_key(key)?;
      let entry = keyring::Entry::new("YUVI", target).map_err(|e| e.to_string())?;
      match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
      }
    }
    #[cfg(not(windows))]
    {
      let _ = Self::map_key(key)?;
      Err("Credential Manager secrets are only supported on Windows".to_string())
    }
  }
}
