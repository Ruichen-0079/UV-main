import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { zhCN } from "./locale-zh-cn.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PRODUCT_SURFACES = [
  "product-webui.tsx",
  "product-first-run-setup.tsx",
  "product-compact-health.tsx",
  "product-models-providers.tsx",
  "product-memory-settings.tsx",
  "product-configuration.tsx",
  "product-live2d-models.tsx",
  "product-vision-status.tsx",
  "user-settings-panel.tsx",
  "companion-appearance-settings.tsx",
  "subtitle-appearance-settings.tsx",
  "locale-selector.tsx"
] as const;

function literalTranslationKeys(source: string): string[] {
  const keys: string[] = [];
  for (const match of source.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/gu)) {
    try {
      keys.push(JSON.parse(`"${match[1]}"`) as string);
    } catch {
      // Invalid string syntax is a compiler concern, not locale coverage.
    }
  }
  return keys;
}

describe("zh-CN normal product coverage", () => {
  it("covers every literal t() key used by daily-use product surfaces", () => {
    const missing: string[] = [];
    for (const file of PRODUCT_SURFACES) {
      const source = fs.readFileSync(path.join(here, file), "utf8");
      for (const key of literalTranslationKeys(source)) {
        if (!(key in zhCN)) missing.push(`${file}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("keeps the highest-value health/status strings translated", () => {
    for (const key of [
      "Checking",
      "Unknown",
      "Available",
      "Unavailable",
      "Degraded",
      "Observed available",
      "Configured · unverified",
      "Partially configured",
      "Runtime health unavailable",
      "Product status refresh incomplete"
    ]) {
      expect(zhCN[key], key).toBeTruthy();
    }
  });
});
