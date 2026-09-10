import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { emptyProductConfiguration } from "@companion/providers";
import {
  defaultProductSettings,
  productEnvironment,
  productPath,
  readProductSettings,
  writePrivateJson
} from "./services/product-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function portableSettings() {
  const settings = defaultProductSettings();
  const configuration = emptyProductConfiguration();
  configuration.providers = [
    {
      id: "portable-provider",
      displayName: "Portable provider",
      adapter: "openai-compatible",
      baseUrl: "https://portable.example.test/v1",
      apiKey: "A8_PORTABLE_PROVIDER_SECRET"
    }
  ];
  configuration.models = [
    {
      id: "portable-chat",
      providerId: "portable-provider",
      displayName: "Portable chat",
      modelId: "portable-model",
      temperature: 0.4,
      contextWindow: null,
      capabilities: ["chat"],
      enabled: true
    }
  ];
  configuration.routes.chat = ["portable-chat"];
  settings.configuration = configuration;
  settings.revision = 7;
  return settings;
}

it("Portable rejects persisted Installed STT/TTS endpoints while retaining remote providers", () => {
  const env = {YUVI_PORTABLE_VERSION: "0.1.2", LOCAL_STT_BASE_URL: "http://127.0.0.1:19876"};
  const settings = portableSettings();
  expect(productEnvironment(env, settings)["YUVI_PRODUCT_CONFIGURATION"]).toBeTruthy();
  settings.configuration.providers = [{id: "stt", displayName: "Local", adapter: "local-stt", baseUrl: "http://127.0.0.1:9876"}];
  expect(() => productEnvironment(env, settings)).toThrow("own managed endpoint");
  settings.configuration.providers[0]!.baseUrl = env.LOCAL_STT_BASE_URL;
  expect(productEnvironment(env, settings)["YUVI_PRODUCT_CONFIGURATION"]).toBeTruthy();
  settings.configuration.providers = [{id: "tts", displayName: "Local", adapter: "gpt-sovits", baseUrl: "http://127.0.0.1:9881"}];
  expect(() => productEnvironment(env, settings)).toThrow("owned local TTS");
  settings.configuration.providers[0]!.baseUrl = "https://tts.example.test";
  expect(productEnvironment(env, settings)["YUVI_PRODUCT_CONFIGURATION"]).toBeTruthy();
  expect(productEnvironment({}, settings)["YUVI_PRODUCT_CONFIGURATION"]).toBeTruthy();
});

it("Portable Product provider configuration and credentials survive restart in its own config root", () => {
  const portableRoot = mkdtempSync(join(tmpdir(), "yuvi-a8-portable-"));
  const installedRoot = mkdtempSync(join(tmpdir(), "yuvi-a8-installed-"));
  roots.push(portableRoot, installedRoot);

  const portableEnv = { YUVI_RUNTIME_ENV_DIR: portableRoot };
  const installedEnv = { YUVI_RUNTIME_ENV_DIR: installedRoot };
  const path = productPath(portableEnv);
  writePrivateJson(path, portableSettings());

  if (process.platform !== "win32") {
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(portableRoot).mode & 0o077).toBe(0);
  }

  // Simulate a new Runtime process reading the same version-scoped config root.
  const reloaded = readProductSettings(portableEnv);
  expect(reloaded?.revision).toBe(7);
  expect(reloaded?.configuration.routes.chat).toEqual(["portable-chat"]);
  expect(reloaded?.configuration.providers[0]?.apiKey).toBe("A8_PORTABLE_PROVIDER_SECRET");

  const bootEnv = productEnvironment({}, reloaded);
  const projected = JSON.parse(String(bootEnv["YUVI_PRODUCT_CONFIGURATION"]));
  expect(projected.routes.chat).toEqual(["portable-chat"]);
  expect(projected.providers[0].apiKey).toBe("A8_PORTABLE_PROVIDER_SECRET");

  // A separate Installed config root cannot see the Portable provider file.
  expect(readProductSettings(installedEnv)).toBeNull();
  expect(productPath(installedEnv)).not.toBe(path);
});
