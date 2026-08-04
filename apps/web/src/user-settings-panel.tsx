import { memo, useCallback, useEffect, useReducer } from "react";
import { Field, Notice, Panel, Pill } from "./surface-ui.js";
import { isTauriRuntime } from "./tauri-window.js";
import {
  deleteUserSecret,
  fetchUserSettings,
  saveUserSettings,
  setUserSecret
} from "./user-settings-client.js";
import {
  initialUserSettingsUiState,
  patchFromForm,
  reduceUserSettings,
  type UserSettingsForm
} from "./user-settings-state.js";

/**
 * Formal Settings panel for the Tauri main window.
 * Companion must not mount this component.
 * Local reducer only — keystrokes never invoke Rust until Save.
 */
export const UserSettingsPanel = memo(function UserSettingsPanel(): JSX.Element | null {
  const [state, dispatch] = useReducer(reduceUserSettings, undefined, initialUserSettingsUiState);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    dispatch({ type: "load-start" });
    void fetchUserSettings()
      .then((view) => {
        if (!cancelled) dispatch({ type: "load-success", view });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          dispatch({
            type: "load-error",
            error: error instanceof Error ? error.message : String(error)
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setField = useCallback(
    <K extends keyof UserSettingsForm>(key: K, value: UserSettingsForm[K]): void => {
      dispatch({ type: "field", key, value });
    },
    []
  );

  const onSave = useCallback(async (): Promise<void> => {
    dispatch({ type: "save-start" });
    try {
      const form = state.form;
      let lastSecretSyncFailed = false;
      if (form.deepseekApiKeyInput.trim()) {
        const mutation = await setUserSecret(
          "chat.deepseekApiKey",
          form.deepseekApiKeyInput.trim()
        );
        lastSecretSyncFailed = !mutation.supervisorSync.applied;
        dispatch({
          type: "secrets-updated",
          secrets: mutation.secrets,
          restartServices: mutation.restartServices,
          supervisorSync: mutation.supervisorSync,
          saved: mutation.saved
        });
      }
      if (form.databaseUrlInput.trim()) {
        const mutation = await setUserSecret(
          "memory.databaseUrl",
          form.databaseUrlInput.trim()
        );
        lastSecretSyncFailed = lastSecretSyncFailed || !mutation.supervisorSync.applied;
        dispatch({
          type: "secrets-updated",
          secrets: mutation.secrets,
          restartServices: mutation.restartServices,
          supervisorSync: mutation.supervisorSync,
          saved: mutation.saved
        });
      }
      const result = await saveUserSettings(patchFromForm(form));
      const merged =
        lastSecretSyncFailed && result.supervisorSync.applied
          ? {
              ...result,
              supervisorSync: {
                applied: false,
                error: "Supervisor unavailable"
              }
            }
          : result;
      dispatch({ type: "save-success", result: merged, clearSecrets: true });
    } catch (error) {
      dispatch({
        type: "save-error",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }, [state.form]);

  const clearSecret = useCallback(
    async (key: "chat.deepseekApiKey" | "memory.databaseUrl"): Promise<void> => {
      try {
        const mutation = await deleteUserSecret(key);
        dispatch({
          type: "secrets-updated",
          secrets: mutation.secrets,
          restartServices: mutation.restartServices,
          supervisorSync: mutation.supervisorSync,
          saved: mutation.saved
        });
      } catch (error) {
        dispatch({
          type: "save-error",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    },
    []
  );

  if (!isTauriRuntime()) {
    return null;
  }

  const form = state.form;

  return (
    <Panel
      title="Settings"
      actions={
        <div className="flex items-center gap-2">
          {state.saving ? <Pill status="saving" /> : null}
          <button
            type="button"
            className="button-primary text-xs"
            disabled={state.loading || state.saving}
            onClick={() => void onSave()}
          >
            Save
          </button>
        </div>
      }
    >
      <div className="settings-banner space-y-2">
        {state.loading && (
          <Notice tone="info" title="Loading" message="Reading user settings…" />
        )}
        {state.loadError && (
          <Notice tone="error" title="Settings file issue" message={state.loadError} />
        )}
        {state.error && <Notice tone="error" title="Save failed" message={state.error} />}
        {state.saveMessage && (
          <Notice
            tone={state.saveMessage.includes("were not refreshed") ? "warning" : "info"}
            title={
              state.saveMessage.includes("were not refreshed")
                ? "Saved (sync pending)"
                : "Saved"
            }
            message={state.saveMessage}
          />
        )}
      </div>

      <div className="settings-grid">
        <section className="settings-card">
          <h3>Chat</h3>
          <Field label="Provider">
            <select
              className="setting-input"
              value={form.chatProvider}
              onChange={(e) => setField("chatProvider", e.target.value)}
            >
              <option value="deepseek">deepseek</option>
            </select>
          </Field>
          <Field label="Model">
            <input
              className="setting-input"
              value={form.chatModel}
              onChange={(e) => setField("chatModel", e.target.value)}
            />
          </Field>
          <Field label="DeepSeek API key">
            <input
              className="setting-input"
              type="password"
              autoComplete="off"
              placeholder={
                state.secrets.deepseekApiKey ? "Enter to replace" : "Paste API key"
              }
              value={form.deepseekApiKeyInput}
              onChange={(e) => setField("deepseekApiKeyInput", e.target.value)}
            />
          </Field>
          <div className="setting-secret-status">
            <span>{state.secrets.deepseekApiKey ? "Configured" : "Not configured"}</span>
            {state.secrets.deepseekApiKey ? (
              <button
                type="button"
                className="button-secondary text-xs"
                onClick={() => void clearSecret("chat.deepseekApiKey")}
              >
                Clear key
              </button>
            ) : null}
          </div>
        </section>

        <section className="settings-card">
          <h3>Memory</h3>
          <label className="setting-checkbox">
            <input
              type="checkbox"
              checked={form.memoryEnabled}
              onChange={(e) => setField("memoryEnabled", e.target.checked)}
            />
            Enabled
          </label>
          <Field label="Mode">
            <select
              className="setting-input"
              value={form.memoryMode}
              onChange={(e) => setField("memoryMode", e.target.value as "managed" | "external")}
            >
              <option value="managed">managed</option>
              <option value="external">external</option>
            </select>
          </Field>
          <Field label="Backend">
            <select
              className="setting-input"
              value={form.memoryBackend}
              onChange={(e) => setField("memoryBackend", e.target.value as "mem0" | "legacy")}
            >
              <option value="mem0">mem0</option>
              <option value="legacy">legacy</option>
            </select>
          </Field>
          <Field label="Mem0 URL">
            <input
              className="setting-input"
              value={form.memoryBaseUrl}
              onChange={(e) => setField("memoryBaseUrl", e.target.value)}
            />
          </Field>
          <Field label="Ollama URL">
            <input
              className="setting-input"
              value={form.ollamaUrl}
              onChange={(e) => setField("ollamaUrl", e.target.value)}
            />
          </Field>
          <Field label="Subject User ID">
            <input
              className="setting-input"
              value={form.subjectUserId}
              onChange={(e) => setField("subjectUserId", e.target.value)}
            />
          </Field>
          <Field label="Persona ID">
            <input
              className="setting-input"
              value={form.personaId}
              onChange={(e) => setField("personaId", e.target.value)}
            />
          </Field>
          <Field label="DATABASE_URL">
            <input
              className="setting-input"
              type="password"
              autoComplete="off"
              placeholder={
                state.secrets.databaseUrl ? "Enter to replace" : "Paste connection string"
              }
              value={form.databaseUrlInput}
              onChange={(e) => setField("databaseUrlInput", e.target.value)}
            />
          </Field>
          <div className="setting-secret-status">
            <span>{state.secrets.databaseUrl ? "Configured" : "Not configured"}</span>
            {state.secrets.databaseUrl ? (
              <button
                type="button"
                className="button-secondary text-xs"
                onClick={() => void clearSecret("memory.databaseUrl")}
              >
                Clear URL
              </button>
            ) : null}
          </div>
        </section>

        <section className="settings-card">
          <h3>TTS</h3>
          <label className="setting-checkbox">
            <input
              type="checkbox"
              checked={form.ttsEnabled}
              onChange={(e) => setField("ttsEnabled", e.target.checked)}
            />
            Enabled
          </label>
          <Field label="Mode">
            <select
              className="setting-input"
              value={form.ttsMode}
              onChange={(e) => setField("ttsMode", e.target.value as "managed" | "external")}
            >
              <option value="managed">managed</option>
              <option value="external">external</option>
            </select>
          </Field>
          <Field label="Wrapper URL">
            <input
              className="setting-input"
              value={form.ttsWrapperUrl}
              onChange={(e) => setField("ttsWrapperUrl", e.target.value)}
            />
          </Field>
          <Field label="Upstream URL">
            <input
              className="setting-input"
              value={form.ttsUpstreamUrl}
              onChange={(e) => setField("ttsUpstreamUrl", e.target.value)}
            />
          </Field>
        </section>

        <section className="settings-card">
          <h3>Desktop</h3>
          <label className="setting-checkbox">
            <input
              type="checkbox"
              checked={form.companionAlwaysOnTop}
              onChange={(e) => setField("companionAlwaysOnTop", e.target.checked)}
            />
            Companion always on top
          </label>
          <Field label="Runtime mode">
            <select
              className="setting-input"
              value={form.runtimeMode}
              onChange={(e) => setField("runtimeMode", e.target.value as "managed" | "external")}
            >
              <option value="managed">managed</option>
              <option value="external">external</option>
            </select>
          </Field>
          <label className="setting-checkbox">
            <input
              type="checkbox"
              checked={form.runtimeAutostart}
              onChange={(e) => setField("runtimeAutostart", e.target.checked)}
            />
            Runtime autostart
          </label>
          <Field label="Runtime URL">
            <input
              className="setting-input"
              value={form.runtimeUrl}
              onChange={(e) => setField("runtimeUrl", e.target.value)}
            />
          </Field>
          <Field label="UI language">
            <input
              className="setting-input"
              value={form.language}
              onChange={(e) => setField("language", e.target.value)}
            />
          </Field>
        </section>
      </div>
    </Panel>
  );
});
