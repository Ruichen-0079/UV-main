import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { zhCN } from "./locale-zh-cn.js";

const PRODUCT_FILES = [
  "product-webui.tsx",
  "product-first-run-setup.tsx",
  "product-configuration.tsx",
  "product-models-providers.tsx",
  "product-live2d-models.tsx",
  "product-memory-settings.tsx",
  "product-vision-status.tsx",
  "product-compact-health.tsx",
  "companion-appearance-settings.tsx",
  "subtitle-appearance-settings.tsx",
  "locale-selector.tsx",
  "user-settings-panel.tsx",
  "user-settings-state.ts"
] as const;

function staticTranslationKeys(source: string): string[] {
  const keys: string[] = [];
  const pattern = /\bt\(\s*"((?:[^"\\]|\\.)*)"/gu;
  for (const match of source.matchAll(pattern)) {
    keys.push(JSON.parse(`"${match[1]}"`) as string);
  }
  return keys;
}

describe("zh-CN daily product coverage", () => {
  it("has a dictionary entry for every static t() key on normal product surfaces", () => {
    const missing: Array<{ file: string; key: string }> = [];
    for (const file of PRODUCT_FILES) {
      const source = readFileSync(
        fileURLToPath(new URL(`./${file}`, import.meta.url)),
        "utf8"
      );
      for (const key of staticTranslationKeys(source)) {
        if (!(key in zhCN)) missing.push({ file, key });
      }
    }
    expect(missing).toEqual([]);
  });

  it("translates representative high-traffic product copy instead of falling back to English", () => {
    for (const key of [
      "Product status refresh incomplete",
      "Provider → Model → Capability Route",
      "Provider display name",
      "Model display name",
      "Capability routes",
      "Save routes & apply",
      "Proactive",
      "Memory backend",
      "Saved (sync pending)",
      "Reading the current Runtime health projection.",
      "Partially configured",
      "Lumi renderer readiness is unknown right now."
    ]) {
      expect(zhCN[key], key).toBeTruthy();
      expect(zhCN[key], key).not.toBe(key);
    }
  });
});
