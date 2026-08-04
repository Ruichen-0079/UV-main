/**
 * Tauri invoke bridge for user settings. No file I/O, no secret values returned.
 * Intentional: field keystrokes never call these helpers — only explicit Save / secret actions.
 */

import { isTauriRuntime } from "./tauri-window.js";
import type {
  SecretMutationResultDto,
  SecretStatusDto,
  SettingsViewDto,
  UpdateSettingsResultDto
} from "./user-settings-state.js";

/** Commands that mutate settings or secrets on the Rust side. */
export const USER_SETTINGS_MUTATION_COMMANDS = [
  "update_user_settings",
  "set_user_secret",
  "delete_user_secret"
] as const;

export async function fetchUserSettings(): Promise<SettingsViewDto> {
  if (!isTauriRuntime()) {
    throw new Error("User settings require the Tauri desktop shell.");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SettingsViewDto>("get_user_settings");
}

export async function saveUserSettings(
  patch: Record<string, unknown>
): Promise<UpdateSettingsResultDto> {
  if (!isTauriRuntime()) {
    throw new Error("User settings require the Tauri desktop shell.");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<UpdateSettingsResultDto>("update_user_settings", { patch });
}

export async function setUserSecret(
  key: string,
  value: string
): Promise<SecretMutationResultDto> {
  if (!isTauriRuntime()) {
    throw new Error("User settings require the Tauri desktop shell.");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SecretMutationResultDto>("set_user_secret", { key, value });
}

export async function deleteUserSecret(key: string): Promise<SecretMutationResultDto> {
  if (!isTauriRuntime()) {
    throw new Error("User settings require the Tauri desktop shell.");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SecretMutationResultDto>("delete_user_secret", { key });
}

export async function fetchUserSecretStatus(): Promise<SecretStatusDto> {
  if (!isTauriRuntime()) {
    throw new Error("User settings require the Tauri desktop shell.");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SecretStatusDto>("get_user_secret_status");
}
