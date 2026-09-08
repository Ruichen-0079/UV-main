import { useState } from "react";
import { getLocale, setLocale, t, type Locale } from "./locale.js";
import { isTauriRuntime } from "./tauri-window.js";
import { saveUserSettings } from "./user-settings-client.js";
export function LocaleSelector(): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function change(next: Locale) {
    setBusy(true);
    setError("");
    try {
      if (isTauriRuntime()) await saveUserSettings({ app: { language: next } });
      setLocale(next);
    } catch {
      setError(t("Language could not be saved."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <label className="inline-flex items-center gap-2">
        {t("UI language")}
        <select
          aria-label={t("UI language")}
          disabled={busy}
          value={getLocale()}
          onChange={(event) => void change(event.target.value as Locale)}
        >
          <option value="zh-CN">简体中文</option>
          <option value="en">English</option>
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
