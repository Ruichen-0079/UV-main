import { zhCN } from "./locale-zh-cn.js";
export type Locale = "zh-CN" | "en";
export const LOCALE_STORAGE_KEY = "yuvi.ui.locale";
function initialLocale(): Locale {
  try {
    return typeof localStorage === "undefined"
      ? "en"
      : localStorage.getItem(LOCALE_STORAGE_KEY) === "en"
        ? "en"
        : "zh-CN";
  } catch {
    return "zh-CN";
  }
}
let locale: Locale = initialLocale();
const dictionary: Readonly<Record<string, string>> = zhCN;
export function t(text: string, ...values: unknown[]): string {
  const translated = locale === "zh-CN" ? (dictionary[text] ?? text) : text;
  return values.length
    ? translated.replace(/\{(\d+)\}/gu, (match, index: string) =>
        Number(index) < values.length ? String(values[Number(index)]) : match
      )
    : translated;
}
export function getLocale(): Locale {
  return locale;
}
export function initializeLocale(): void {
  try {
    locale = localStorage.getItem(LOCALE_STORAGE_KEY) === "en" ? "en" : "zh-CN";
  } catch {
    locale = "zh-CN";
  }
  document.documentElement.lang = locale;
}
/** Reloading changes all module-level UI labels consistently; provider and user data stay untouched. */
export function setLocale(next: Locale): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, next);
  if (locale !== next) window.location.reload();
}
