import { useEffect, useState } from "react";
import { t } from "./locale.js";
import { isTauriRuntime } from "./tauri-window.js";
import { fetchUserSettings, saveUserSettings } from "./user-settings-client.js";

export function companionAlwaysOnTopPatch(alwaysOnTop: boolean): Record<string, unknown> {
  return { companion: { alwaysOnTop } };
}

/**
 * Thin Appearance projection over the existing Tauri ConfigService.
 * It owns no settings store and writes only the existing Companion presentation field.
 */
export function CompanionAppearanceSettings(): JSX.Element | null {
  const tauri = isTauriRuntime();
  const [alwaysOnTop, setAlwaysOnTop] = useState(true);
  const [loading, setLoading] = useState(tauri);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!tauri) return;
    let cancelled = false;
    setLoading(true);
    void fetchUserSettings()
      .then((view) => {
        if (!cancelled) {
          setAlwaysOnTop(view.settings.companion.alwaysOnTop);
          setNotice("");
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setNotice(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tauri]);

  if (!tauri) return null;

  const save = async (): Promise<void> => {
    setSaving(true);
    setNotice("");
    try {
      const result = await saveUserSettings(companionAlwaysOnTopPatch(alwaysOnTop));
      setAlwaysOnTop(result.settings.companion.alwaysOnTop);
      setNotice(t("Companion window setting saved."));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("Unable to save Companion window setting."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="yuvi-card grid gap-3" aria-label={t("Companion window")}>
      <div>
        <h2 className="m-0 text-lg font-semibold">{t("Companion window")}</h2>
        <p className="mb-0 mt-1 text-sm text-[var(--yuvi-muted)]">
          {t("The transparent Live2D window remembers its position and size automatically.")}
        </p>
      </div>
      <label className="setting-checkbox">
        <input
          type="checkbox"
          checked={alwaysOnTop}
          disabled={loading || saving}
          onChange={(event) => setAlwaysOnTop(event.target.checked)}
        />
        {t("Always on top")}
      </label>
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="button-primary text-xs"
          disabled={loading || saving}
          onClick={() => void save()}
        >
          {saving ? t("Saving…") : t("Save window setting")}
        </button>
        {notice ? <span className="text-xs text-[var(--yuvi-muted)]" role="status">{notice}</span> : null}
      </div>
    </section>
  );
}
