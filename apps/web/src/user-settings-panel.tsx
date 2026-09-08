import { AsyncProgress } from "./async-progress.js";
import { setLocale } from "./locale.js";
import { t } from "./locale.js";
import { memo, useCallback, useEffect, useReducer, useRef } from "react";
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
  mergeRestartServices,
  patchFromForm,
  reduceUserSettings,
  validateUserSettingsForm,
  type SupervisorSyncStatusDto,
  type TtsSettingsProjection,
  type UserSecretKey,
  type UserSettingsForm
} from "./user-settings-state.js";

/**
 * Formal Settings panel for the Tauri main window.
 * Companion must not mount this component.
 * Local reducer only — keystrokes never invoke Rust until Save.
 */
export const UserSettingsPanel = memo(function UserSettingsPanel(props: {
  onTtsSettings?: (settings: TtsSettingsProjection, revision: number) => void;
}): JSX.Element | null {
  const [state, dispatch] = useReducer(reduceUserSettings, undefined, initialUserSettingsUiState);
  const revisionRef = useRef(state.revision);
  revisionRef.current = state.revision;

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    dispatch({ type: "load-start" });
    void fetchUserSettings()
      .then((view) => {
        if (!cancelled) {
          dispatch({ type: "load-success", view });
          if (view.revision >= revisionRef.current) {
            props.onTtsSettings?.(view.settings.tts, view.revision);
          }
        }
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
  }, [props.onTtsSettings]);

  const setField = useCallback(
    <K extends keyof UserSettingsForm>(key: K, value: UserSettingsForm[K]): void => {
      dispatch({ type: "field", key, value });
    },
    []
  );

  const onSave = useCallback(async (): Promise<void> => {
    const form = state.form;
    const startingRevision = state.revision;
    const validationError = validateUserSettingsForm(form);
    if (validationError) {
      dispatch({ type: "save-error", error: validationError });
      return;
    }
    dispatch({ type: "save-start" });
    try {
      const secretInputs: Array<{ key: UserSecretKey; value: string }> = [
        { key: "chat.deepseekApiKey", value: form.deepseekApiKeyInput },
        { key: "models.openaiCompatibleApiKey", value: form.openaiCompatibleApiKeyInput },
        { key: "memory.databaseUrl", value: form.databaseUrlInput },
        { key: "memory.llmApiKey", value: form.memoryLlmApiKeyInput }
      ];
      let secretRestartServices: string[] = [];
      let secretSyncFailure: SupervisorSyncStatusDto | null = null;
      for (const secret of secretInputs) {
        if (!secret.value.trim()) continue;
        const mutation = await setUserSecret(secret.key, secret.value.trim());
        secretRestartServices = mergeRestartServices(
          secretRestartServices,
          mutation.restartServices
        );
        if (!mutation.supervisorSync.applied && !secretSyncFailure) {
          secretSyncFailure = mutation.supervisorSync;
        }
        dispatch({
          type: "secrets-updated",
          key: secret.key,
          secrets: mutation.secrets,
          restartServices: mutation.restartServices,
          supervisorSync: mutation.supervisorSync,
          saved: mutation.saved
        });
      }
      const result = await saveUserSettings(patchFromForm(form));
      const restartServices = mergeRestartServices(secretRestartServices, result.restartServices);
      const supervisorSync = secretSyncFailure
        ? {
            applied: false,
            error: secretSyncFailure.error ?? result.supervisorSync.error
          }
        : result.supervisorSync;
      const merged = { ...result, restartServices, supervisorSync };
      dispatch({ type: "save-success", result: merged, clearSecrets: true });
      setLocale(result.settings.app.language === "en" ? "en" : "zh-CN");
      if (result.revision >= startingRevision) {
        props.onTtsSettings?.(result.settings.tts, result.revision);
      }
    } catch (error) {
      dispatch({
        type: "save-error",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }, [props.onTtsSettings, state.form]);

  const clearSecret = useCallback(async (key: UserSecretKey): Promise<void> => {
    try {
      const mutation = await deleteUserSecret(key);
      dispatch({
        type: "secrets-updated",
        key,
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
  }, []);

  if (!isTauriRuntime()) {
    return null;
  }

  const form = state.form;

  const renderProviderConnection = (provider: string): JSX.Element => {
    if (provider === "openai-compatible") {
      return (
        <div className="mt-3 border-t border-ink-200 pt-3">
          <Field label={t("OpenAI-compatible base URL")}>
            <input
              className="setting-input"
              type="url"
              placeholder="https://provider.example/v1"
              value={form.openaiCompatibleBaseUrl}
              onChange={(e) => setField("openaiCompatibleBaseUrl", e.target.value)}
            />
          </Field>
          <Field label={t("OpenAI-compatible API key")}>
            <input
              className="setting-input"
              type="password"
              autoComplete="off"
              placeholder={
                state.secrets.openaiCompatibleApiKey ? "Enter to replace" : t("Paste API key")
              }
              value={form.openaiCompatibleApiKeyInput}
              onChange={(e) => setField("openaiCompatibleApiKeyInput", e.target.value)}
            />
          </Field>
          <div className="setting-secret-status">
            <span>{state.secrets.openaiCompatibleApiKey ? t("Configured") : t("Not configured")}</span>
            {state.secrets.openaiCompatibleApiKey ? (
              <button
                type="button"
                className="button-secondary text-xs"
                onClick={() => void clearSecret("models.openaiCompatibleApiKey")}
              >{t("Clear key")}</button>
            ) : null}
          </div>
          <p className="mt-2 text-xs text-ink-500">{t("This connection is shared by Chat and Cognition whenever either uses OpenAI-compatible.")}</p>
        </div>
      );
    }

    return (
      <div className="mt-3 border-t border-ink-200 pt-3">
        <Field label={t("DeepSeek API key")}>
          <input
            className="setting-input"
            type="password"
            autoComplete="off"
            placeholder={state.secrets.deepseekApiKey ? "Enter to replace" : t("Paste API key")}
            value={form.deepseekApiKeyInput}
            onChange={(e) => setField("deepseekApiKeyInput", e.target.value)}
          />
        </Field>
        <div className="setting-secret-status">
          <span>{state.secrets.deepseekApiKey ? t("Configured") : t("Not configured")}</span>
          {state.secrets.deepseekApiKey ? (
            <button
              type="button"
              className="button-secondary text-xs"
              onClick={() => void clearSecret("chat.deepseekApiKey")}
            >{t("Clear key")}</button>
          ) : null}
        </div>
        <p className="mt-2 text-xs text-ink-500">{t("This key is shared by Chat and Cognition whenever either uses DeepSeek.")}</p>
      </div>
    );
  };

  return (
    <Panel
      title={t("Desktop & User Settings")}
      actions={
        <div className="flex items-center gap-2">
          {state.saving ? <Pill status="saving" /> : null}
          <button
            type="button"
            className="button-primary text-xs"
            disabled={state.loading || state.saving}
            onClick={() => void onSave()}
          >{t("Save")}</button>
        </div>
      }
    >
      {state.saving && <AsyncProgress label="Saving…" />}
      <div className="settings-banner space-y-2">
        {state.loading && <Notice tone="info" title={t("Loading")} message={t("Reading user settings…")} />}
        {state.loadError && (
          <Notice tone="error" title={t("Settings file issue")} message={state.loadError} />
        )}
        {state.error && <Notice tone="error" title={t("Save failed")} message={state.error} />}
        {state.saveMessage && (
          <Notice
            tone={state.saveMessage.includes("Supervisor was unavailable") ? "warning" : "info"}
            title={
              state.saveMessage.includes("Supervisor was unavailable")
                ? "Saved (sync pending)"
                : t("Saved")
            }
            message={state.saveMessage}
          />
        )}
      </div>

      <div className="settings-grid">
        <section className="settings-card">
          <h3>{t("Chat")}</h3>
          <Field label={t("Provider")}>
            <select
              className="setting-input"
              value={form.chatProvider}
              onChange={(e) => setField("chatProvider", e.target.value)}
            >
              <option value="deepseek">deepseek</option>
              <option value="openai-compatible">OpenAI-compatible</option>
            </select>
          </Field>
          <Field label={t("Model")}>
            <input
              className="setting-input"
              value={form.chatModel}
              onChange={(e) => setField("chatModel", e.target.value)}
            />
          </Field>
          {renderProviderConnection(form.chatProvider)}
        </section>

        <section className="settings-card">
          <h3>{t("Cognition")}</h3>
          <Field label={t("Provider")}>
            <select
              className="setting-input"
              value={form.cognitionProvider}
              onChange={(e) => setField("cognitionProvider", e.target.value)}
            >
              <option value="openai-compatible">OpenAI-compatible</option>
              <option value="deepseek">deepseek</option>
            </select>
          </Field>
          <Field label={t("Model")}>
            <input
              className="setting-input"
              value={form.cognitionModel}
              onChange={(e) => setField("cognitionModel", e.target.value)}
            />
          </Field>
          {form.cognitionProvider === form.chatProvider ? (
            <p className="mt-3 border-t border-ink-200 pt-3 text-xs text-ink-500">{t("Uses the same")}{" "}{form.cognitionProvider === "openai-compatible" ? "OpenAI-compatible" : "DeepSeek"}{" "}{t("connection configured in Chat.")}</p>
          ) : (
            renderProviderConnection(form.cognitionProvider)
          )}
        </section>

        <section className="settings-card">
          <h3>{t("Memory")}</h3>
          <label className="setting-checkbox">
            <input
              type="checkbox"
              checked={form.memoryEnabled}
              onChange={(e) => setField("memoryEnabled", e.target.checked)}
            />{t("Enabled")}</label>
          <Field label={t("Mode")}>
            <select
              className="setting-input"
              value={form.memoryMode}
              onChange={(e) => setField("memoryMode", e.target.value as "managed" | "external")}
            >
              <option value="managed">{t("managed")}</option>
              <option value="external">{t("external")}</option>
            </select>
          </Field>
          <Field label={t("Backend")}>
            <select
              className="setting-input"
              value={form.memoryBackend}
              onChange={(e) => setField("memoryBackend", e.target.value as "mem0" | "legacy")}
            >
              <option value="mem0">mem0</option>
              <option value="legacy">{t("legacy")}</option>
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
          <Field label={t("Subject User ID")}>
            <input
              className="setting-input"
              value={form.subjectUserId}
              onChange={(e) => setField("subjectUserId", e.target.value)}
            />
          </Field>
          <Field label={t("Persona ID")}>
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
                state.secrets.databaseUrl ? "Enter to replace" : t("Paste connection string")
              }
              value={form.databaseUrlInput}
              onChange={(e) => setField("databaseUrlInput", e.target.value)}
            />
          </Field>
          <div className="setting-secret-status">
            <span>{state.secrets.databaseUrl ? t("Configured") : t("Not configured")}</span>
            {state.secrets.databaseUrl ? (
              <button
                type="button"
                className="button-secondary text-xs"
                onClick={() => void clearSecret("memory.databaseUrl")}
              >{t("Clear URL")}</button>
            ) : null}
          </div>
          <div className="mt-4 border-t border-ink-200 pt-4">
            <h4 className="text-sm font-semibold">{t("Memory inference")}</h4>
            <p className="mt-1 text-xs text-ink-500">{t("This LLM key is independent from the Chat DeepSeek key. It is only used for memory inference when Memory is Enabled, Managed, and Mem0.")}</p>
          </div>
          <Field label={t("Memory LLM Provider")}>
            <select
              className="setting-input"
              value={form.memoryLlmProvider}
              onChange={(e) =>
                setField("memoryLlmProvider", e.target.value as "none" | "deepseek" | "openai")
              }
            >
              <option value="none">{t("Disabled")}</option>
              <option value="deepseek">DeepSeek</option>
              <option value="openai">OpenAI-compatible</option>
            </select>
          </Field>
          <Field label={t("Memory LLM Model")}>
            <input
              className="setting-input"
              value={form.memoryLlmModel}
              required={form.memoryLlmProvider !== "none"}
              placeholder={t("Required model name")}
              onChange={(e) => setField("memoryLlmModel", e.target.value)}
            />
          </Field>
          <Field label={t("Memory LLM Base URL")}>
            <input
              className="setting-input"
              type="url"
              value={form.memoryLlmBaseUrl}
              placeholder={t("Optional custom API base URL")}
              onChange={(e) => setField("memoryLlmBaseUrl", e.target.value)}
            />
          </Field>
          <Field label={t("Memory LLM API key")}>
            <input
              className="setting-input"
              type="password"
              autoComplete="off"
              placeholder={
                state.secrets.memoryLlmApiKey ? "Enter to replace" : t("Paste Memory LLM API key")
              }
              value={form.memoryLlmApiKeyInput}
              onChange={(e) => setField("memoryLlmApiKeyInput", e.target.value)}
            />
          </Field>
          <div className="setting-secret-status">
            <span>{state.secrets.memoryLlmApiKey ? t("Configured") : t("Not configured")}</span>
            {state.secrets.memoryLlmApiKey ? (
              <button
                type="button"
                className="button-secondary text-xs"
                onClick={() => void clearSecret("memory.llmApiKey")}
              >{t("Clear key")}</button>
            ) : null}
          </div>
          {form.memoryLlmProvider === "none" ? (
            <p className="mt-2 text-xs text-ink-500">{t("Memory inference disabled. Model and base URL values can be retained without being sent to Mem0.")}</p>
          ) : null}
          {form.memoryLlmProvider !== "none" && !form.memoryLlmModel.trim() ? (
            <p className="mt-2 text-xs text-red-600">{t("Select a provider and enter a model name before saving.")}</p>
          ) : null}
          {form.memoryLlmProvider !== "none" &&
          !state.secrets.memoryLlmApiKey &&
          !form.memoryLlmApiKeyInput.trim() ? (
            <p className="mt-2 text-xs text-ink-500">{t("API key not configured; infer=true will remain unavailable.")}</p>
          ) : null}
          {!form.memoryEnabled ||
          form.memoryMode === "external" ||
          form.memoryBackend === "legacy" ? (
            <p className="mt-2 text-xs text-ink-500">{t("These Memory LLM settings take effect only when Memory is Enabled, Managed, and Mem0.")}</p>
          ) : null}
        </section>

        <section className="settings-card">
          <h3>TTS</h3>
          <label className="setting-checkbox">
            <input
              type="checkbox"
              checked={form.ttsEnabled}
              onChange={(e) => setField("ttsEnabled", e.target.checked)}
            />{t("Enabled")}</label>
          <Field label={t("Mode")}>
            <select
              className="setting-input"
              value={form.ttsMode}
              onChange={(e) => setField("ttsMode", e.target.value as "managed" | "external")}
            >
              <option value="managed">{t("managed")}</option>
              <option value="external">{t("external")}</option>
            </select>
          </Field>
          <Field label={t("Wrapper URL")}>
            <input
              className="setting-input"
              value={form.ttsWrapperUrl}
              onChange={(e) => setField("ttsWrapperUrl", e.target.value)}
            />
          </Field>
          <Field label={t("Upstream URL")}>
            <input
              className="setting-input"
              value={form.ttsUpstreamUrl}
              onChange={(e) => setField("ttsUpstreamUrl", e.target.value)}
            />
          </Field>
        </section>

        <section className="settings-card">
          <h3>{t("Speech input")}</h3>
          <Field label={t("Provider")}>
            <select
              className="setting-input"
              value={form.sttProvider}
              onChange={(e) => setField("sttProvider", e.target.value as "local" | "dashscope")}
            >
              <option value="local">{t("local CPU STT")}</option>
              <option value="dashscope">dashscope</option>
            </select>
          </Field>
          <Field label={t("Mode")}>
            <select
              className="setting-input"
              value={form.sttMode}
              onChange={(e) => setField("sttMode", e.target.value as "managed" | "external")}
            >
              <option value="managed">{t("managed")}</option>
              <option value="external">{t("external")}</option>
            </select>
          </Field>
          <label className="setting-checkbox">
            <input
              type="checkbox"
              checked={form.sttAutostart}
              onChange={(e) => setField("sttAutostart", e.target.checked)}
            />{t("Start local sidecar automatically")}</label>
          <Field label={t("Local STT URL")}>
            <input
              className="setting-input"
              type="url"
              value={form.sttBaseUrl}
              onChange={(e) => setField("sttBaseUrl", e.target.value)}
            />
          </Field>
          <Field label={t("Local STT model")}>
            <input
              className="setting-input"
              value={form.sttModel}
              onChange={(e) => setField("sttModel", e.target.value)}
            />
          </Field>
          <p className="mt-2 text-xs text-ink-500">{t("Local mode uses the existing Supervisor-owned local_stt service. Managed autostart takes effect only when an explicit sidecar start command is available; packaging the sidecar and model is the next B3c atom.")}</p>
        </section>

        <section className="settings-card">
          <h3>{t("Desktop")}</h3>
          <label className="setting-checkbox">
            <input
              type="checkbox"
              checked={form.companionAlwaysOnTop}
              onChange={(e) => setField("companionAlwaysOnTop", e.target.checked)}
            />{t("Companion always on top")}</label>
          <Field label={t("Connection mode")}>
            <select
              className="setting-input"
              value={form.runtimeMode}
              onChange={(e) => setField("runtimeMode", e.target.value as "managed" | "external")}
            >
              <option value="managed">{t("managed")}</option>
              <option value="external">{t("external")}</option>
            </select>
          </Field>
          <label className="setting-checkbox">
            <input
              type="checkbox"
              checked={form.runtimeAutostart}
              onChange={(e) => setField("runtimeAutostart", e.target.checked)}
            />{t("Start the local service automatically")}</label>
          <Field label={t("Service URL")}>
            <input
              className="setting-input"
              value={form.runtimeUrl}
              onChange={(e) => setField("runtimeUrl", e.target.value)}
            />
          </Field>
          <Field label={t("UI language")}>
            <select className="setting-input" value={form.language} onChange={e => setField("language", e.target.value)}>
              <option value="zh-CN">简体中文</option><option value="en">{t("English")}</option>
            </select>
          </Field>
        </section>

        <section className="settings-card">
          <h3>{t("Proactive messages")}</h3>
          <label className="setting-checkbox">
            <input
              type="checkbox"
              checked={form.proactiveEnabled}
              onChange={(e) => setField("proactiveEnabled", e.target.checked)}
            />{t("Allow proactive messages")}</label>
          <p className="mt-2 text-xs text-ink-500">{t("Allow YUVI to start text conversations on its own when eligible. Off by default. Voice remains disabled.")}</p>
        </section>
      </div>
    </Panel>
  );
});
