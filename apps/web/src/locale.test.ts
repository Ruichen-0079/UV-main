import { afterEach, expect, it, vi } from "vitest";
import { zhCN } from "./locale-zh-cn.js";
import { t, initializeLocale, getLocale, setLocale, LOCALE_STORAGE_KEY } from "./locale.js";
afterEach(() => vi.unstubAllGlobals());
it("defaults to Chinese, persists language, and keeps user/model identifiers intact", () => {
  const saved = new Map<string, string>();
  const reload = vi.fn();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value)
  });
  vi.stubGlobal("document", { documentElement: { lang: "" } });
  vi.stubGlobal("window", { location: { reload } });
  initializeLocale();
  expect(getLocale()).toBe("zh-CN");
  expect(document.documentElement.lang).toBe("zh-CN");
  expect(t("Models & Providers")).toBe("模型与提供方");
  expect(t("Default model: {0}", "meta-llama/Llama-3.3-70B-Instruct-Turbo")).toBe(
    "默认模型：meta-llama/Llama-3.3-70B-Instruct-Turbo"
  );
  expect(t("User-authored text {0}")).toBe("User-authored text {0}");
  setLocale("en");
  expect(saved.get(LOCALE_STORAGE_KEY)).toBe("en");
  expect(reload).toHaveBeenCalledOnce();
  initializeLocale();
  expect(t("Models & Providers")).toBe("Models & Providers");
});
it("preserves template substitutions in every translation", () => {
  for (const [key, value] of Object.entries(zhCN)) {
    expect(value.trim(), key).not.toBe("");
    expect(value.match(/\{\d+\}/gu)?.sort() ?? [], key).toEqual(
      key.match(/\{\d+\}/gu)?.sort() ?? []
    );
  }
});
