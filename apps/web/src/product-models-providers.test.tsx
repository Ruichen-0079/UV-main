import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProviderHealth, RuntimeSettingsResponse } from "./api/client.js";
import {
  PRODUCT_PROVIDER_DEFINITIONS,
  ProductModelsProviders,
  productProviderStatusLabel,
  productSettingConfigured,
  productSettingValue,
  productVerificationSummary
} from "./product-models-providers.js";

function settingsFixture(): Pick<RuntimeSettingsResponse, "settings"> {
  return {
    settings: {
      DEEPSEEK_API_BASEURL: {
        base: "",
        localOverride: "",
        effective: "https://api.deepseek.com",
        source: "process.env/default"
      },
      DEEPSEEK_API_KEY: {
        baseConfigured: false,
        localOverrideConfigured: true,
        effectiveConfigured: true,
        maskedValue: "••••••••••••cret",
        source: ".env.local"
      }
    }
  };
}

function providerHealth(input: Partial<ProviderHealth>): ProviderHealth {
  return {
    provider: "deepseek",
    status: "degraded",
    readiness: "ready",
    observed: "unknown",
    checkedAt: "2026-09-06T00:00:00.000Z",
    ...input
  };
}

describe("Product Models & Providers", () => {
  it("covers current-main provider connections without creating a product backend", () => {
    expect(PRODUCT_PROVIDER_DEFINITIONS.map((provider) => provider.id)).toEqual([
      "deepseek",
      "openai-compatible",
      "nvidia",
      "local",
      "xai",
      "dashscope",
      "embedding"
    ]);
    const openAi = PRODUCT_PROVIDER_DEFINITIONS.find(
      (provider) => provider.id === "openai-compatible"
    );
    expect(openAi?.fields.map((field) => field.key)).toEqual([
      "OPENAI_COMPATIBLE_API_BASEURL",
      "OPENAI_COMPATIBLE_API_KEY",
      "OPENAI_COMPATIBLE_CHAT_MODEL",
      "OPENAI_COMPATIBLE_REASONING_MODEL"
    ]);
  });

  it("reads only the safe current-main settings projection", () => {
    const settings = settingsFixture();
    expect(productSettingValue(settings, "DEEPSEEK_API_BASEURL")).toBe("https://api.deepseek.com");
    expect(productSettingValue(settings, "MISSING", "fallback")).toBe("fallback");
    expect(productSettingConfigured(settings, "DEEPSEEK_API_KEY")).toBe(true);
    expect(productSettingValue(settings, "DEEPSEEK_API_KEY")).toBe("");
  });

  it("keeps readiness, observation, mock mode, and config-only verification honest", () => {
    expect(productProviderStatusLabel(providerHealth({ observed: "unknown" }))).toBe(
      "Ready · unverified"
    );
    expect(productProviderStatusLabel(providerHealth({ readiness: "not_ready" }))).toBe(
      "Not configured"
    );
    expect(
      productVerificationSummary({
        ok: true,
        provider: "xai",
        verificationMode: "config_only"
      })
    ).toContain("no provider call");
    expect(
      productVerificationSummary({
        ok: true,
        provider: "deepseek",
        verificationMode: "live"
      })
    ).toBe("Connected · deepseek");
  });

  it("renders a product page shell while current-main data is loading", () => {
    const markup = renderToStaticMarkup(<ProductModelsProviders />);
    expect(markup).toContain("Models &amp; Providers");
    expect(markup).toContain("Loading current settings");
    expect(markup).toContain("Automatic model discovery is not available");
  });
});
