import { AsyncProgress } from "./async-progress.js";
import { setLocale } from "./locale.js";
import { t } from "./locale.js";
import { memo, useCallback, useEffect, useReducer, useRef } from "react";
import { Field, Notice, Panel, Pill } from "./surface-ui.js";
import { isTauriRuntime } from "./tauri-window.js";
import { fetchUserSettings, saveUserSettings } from "./user-settings-client.js";
import {
  initialUserSettingsUiState,
  patchFromForm,
  reduceUserSettings,
  validateUserSettingsForm,
  type TtsSettingsProjection,
  type UserSettingsForm
} from "./user-settings-state.js";

/**
 * Formal Settings panel for the Tauri main window.
 * Companion must not mount this component.
 * Local reducer only — keystrokes never invoke Rust until Save.
 */
function localizeUserSettingsSaveMessage(message: string): string {
  if (message === "Settings saved.") return t("Settings saved.");
  if (message === "Secret updated.") return t("Secret updated.");
  if (
    message ===
    "Settings saved, but Supervisor was unavailable. Reopen YUVI or Save again to apply it to managed services."
  )
    return t(
      "Settings saved, but Supervisor was unavailable. Reopen YUVI or Save again to apply it to managed services."
    );
  if (
    message ===
    "Secret saved, but Supervisor was unavailable. Reopen YUVI or Save again to apply it to managed services."
  )
    return t(
      "Secret saved, but Supervisor was unavailable. Reopen YUVI or Save again to apply it to managed services."
    );
  const apply = message.match(/^Secret updated\. Applying changes to: (.+)\.$/u);
  if (apply) return t("Secret updated. Applying changes to: {0}.", apply[1]);
  const reload = message.match(/^Settings saved\. Services may reload: (.+)\.$/u);
  if (reload) return t("Settings saved. Services may reload: {0}.", reload[1]);
  return t(message);
}

export const UserSettingsPanel = memo(function UserSettingsPanel(props: {
  sections?: readonly ("memory" | "desktop" | "proactive")[];
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
      // A7 keeps infrastructure topology in the durable schema for compatibility,
      // but ordinary Product Settings no longer owns topology or secret mutation.
      // Saving visible product preferences round-trips the loaded hidden fields.
      const result = await saveUserSettings(patchFromForm(form));
      dispatch({ type: "save-success", result, clearSecrets: true });
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

  if (!isTauriRuntime()) {
    return null;
  }

  const form = state.form;

  return (
    <Panel
      title={t(
        props.sections?.length === 1
          ? props.sections[0] === "memory"
            ? "Memory"
            : props.sections[0] === "proactive"
              ? "Proactive messages"
              : "Desktop"
          : "Desktop & User Settings"
      )}
      actions={
        <div className="flex items-center gap-2">
          {state.saving ? <Pill status="saving" /> : null}
          <button
            type="button"
            className="button-primary text-xs"
            disabled={state.loading || state.saving}
            onClick={() => void onSave()}
          >
            {t("Save")}
          </button>
        </div>
      }
    >
      {state.saving && <AsyncProgress label={t("Saving…")} />}
      <div className="settings-banner space-y-2">
        {state.loading && (
          <Notice tone="info" title={t("Loading")} message={t("Reading user settings…")} />
        )}
        {state.loadError && (
          <Notice tone="error" title={t("Settings file issue")} message={state.loadError} />
        )}
        {state.error && <Notice tone="error" title={t("Save failed")} message={state.error} />}
        {state.saveMessage && (
          <Notice
            tone={state.saveMessage.includes("Supervisor was unavailable") ? "warning" : "info"}
            title={
              state.saveMessage.includes("Supervisor was unavailable")
                ? t("Saved (sync pending)")
                : t("Saved")
            }
            message={localizeUserSettingsSaveMessage(state.saveMessage)}
          />
        )}
      </div>

      <div className="settings-grid">
        {!props.sections && (
          <p>{t("Providers, models, and voice routes are configured in Product configuration.")}</p>
        )}

        {(!props.sections || props.sections.includes("memory")) && (
          <section className="settings-card">
            <h3>{t("Memory")}</h3>
            <label className="setting-checkbox">
              <input
                type="checkbox"
                checked={form.memoryEnabled}
                onChange={(e) => setField("memoryEnabled", e.target.checked)}
              />
              {t("Enabled")}
            </label>
            <p className="mt-2 text-xs text-ink-500">
              {t("YUVI manages Memory storage and service topology automatically.")}
            </p>
            <p className="mt-2 text-xs text-ink-500">
              {t(
                "Technical Memory connection settings remain available through developer diagnostics and deployment overrides."
              )}
            </p>
          </section>
        )}

        {(!props.sections || props.sections.includes("desktop")) && (
          <section className="settings-card">
            <h3>{t("Desktop")}</h3>
            <p className="mt-2 text-xs text-ink-500">
              {t("YUVI manages the Runtime lifecycle automatically.")}
            </p>
            <Field label={t("UI language")}>
              <select
                className="setting-input"
                value={form.language}
                onChange={(e) => setField("language", e.target.value)}
              >
                <option value="zh-CN">简体中文</option>
                <option value="en">{t("English")}</option>
              </select>
            </Field>
          </section>
        )}

        {(!props.sections || props.sections.includes("proactive")) && (
          <section className="settings-card">
            <h3>{t("Proactive messages")}</h3>
            <label className="setting-checkbox">
              <input
                type="checkbox"
                checked={form.proactiveEnabled}
                onChange={(e) => setField("proactiveEnabled", e.target.checked)}
              />
              {t("Allow proactive messages")}
            </label>
            <p className="mt-2 text-xs text-ink-500">
              {t(
                "Allow YUVI to start text conversations on its own when eligible. Off by default. Voice remains disabled."
              )}
            </p>
          </section>
        )}
      </div>
    </Panel>
  );
});
