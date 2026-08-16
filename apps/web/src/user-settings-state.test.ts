import { describe, expect, it } from "vitest";
import { setUserSecret, USER_SETTINGS_MUTATION_COMMANDS } from "./user-settings-client.js";
import {
  assertNoSecretMaterial,
  buildSaveMessage,
  defaultUserSettingsForm,
  emptySecretStatus,
  formFromView,
  initialUserSettingsUiState,
  mergeRestartServices,
  patchFromForm,
  reduceUserSettings,
  validateUserSettingsForm,
  type SettingsViewDto,
  type UpdateSettingsResultDto
} from "./user-settings-state.js";

const sampleView = (): SettingsViewDto => ({
  settings: {
    schemaVersion: 1,
    app: { language: "en" },
    chat: { provider: "deepseek", model: "deepseek-chat" },
    runtime: { mode: "managed", autostart: true, url: "http://127.0.0.1:6121" },
    memory: {
      enabled: true,
      backend: "mem0",
      mode: "managed",
      baseUrl: "http://127.0.0.1:6131",
      subjectUserId: "local-owner",
      personaId: "alice",
      ollamaUrl: "http://127.0.0.1:11434",
      llm: { provider: "none", model: "", baseUrl: "" }
    },
    tts: {
      enabled: true,
      mode: "external",
      wrapperUrl: "http://127.0.0.1:9881",
      upstreamUrl: "http://127.0.0.1:9880"
    },
    companion: { alwaysOnTop: true }
  },
  secrets: { deepseekApiKey: false, databaseUrl: false, memoryLlmApiKey: false },
  revision: 1,
  configPath: "C:/Users/test/AppData/Roaming/com.yuvi.companion/settings.json",
  loadError: null
});

describe("user settings reducer", () => {
  it("initializes from view without secret values", () => {
    let state = initialUserSettingsUiState();
    state = reduceUserSettings(state, { type: "load-success", view: sampleView() });
    expect(state.loading).toBe(false);
    expect(state.form.chatModel).toBe("deepseek-chat");
    expect(state.form.deepseekApiKeyInput).toBe("");
    expect(state.secrets.deepseekApiKey).toBe(false);
    assertNoSecretMaterial(state);
  });

  it("load-success carries only the configured Memory LLM boolean", () => {
    const view = sampleView();
    view.secrets.memoryLlmApiKey = true;
    const state = reduceUserSettings(initialUserSettingsUiState(), {
      type: "load-success",
      view
    });
    expect(state.secrets.memoryLlmApiKey).toBe(true);
    expect(state.form.memoryLlmApiKeyInput).toBe("");
  });

  it("tracks save pending and restart services", () => {
    let state = reduceUserSettings(initialUserSettingsUiState(), {
      type: "load-success",
      view: sampleView()
    });
    state = reduceUserSettings(state, { type: "save-start" });
    expect(state.saving).toBe(true);
    const result: UpdateSettingsResultDto = {
      saved: true,
      restartServices: ["runtime", "memory"],
      restartApplication: false,
      revision: 2,
      settings: sampleView().settings,
      secrets: { deepseekApiKey: true, databaseUrl: false, memoryLlmApiKey: false },
      supervisorSync: { applied: true, error: null }
    };
    state = reduceUserSettings(state, {
      type: "save-success",
      result,
      clearSecrets: true
    });
    expect(state.saving).toBe(false);
    expect(state.lastRestartServices).toEqual(["runtime", "memory"]);
    expect(state.saveMessage).toMatch(/Services may reload: runtime, memory/);
    expect(state.form.deepseekApiKeyInput).toBe("");
  });

  it("shows sync-failed notice when saved but supervisor unavailable", () => {
    let state = reduceUserSettings(initialUserSettingsUiState(), {
      type: "load-success",
      view: sampleView()
    });
    const result: UpdateSettingsResultDto = {
      saved: true,
      restartServices: ["runtime"],
      restartApplication: false,
      revision: 3,
      settings: sampleView().settings,
      secrets: { deepseekApiKey: false, databaseUrl: false, memoryLlmApiKey: false },
      supervisorSync: { applied: false, error: "Supervisor unavailable" }
    };
    state = reduceUserSettings(state, {
      type: "save-success",
      result,
      clearSecrets: true
    });
    expect(result.saved).toBe(true);
    expect(state.saveMessage).toMatch(/Supervisor was unavailable/);
    const text = JSON.stringify(result);
    expect(text).not.toContain("sk-");
    expect(text).not.toContain("postgres://");
  });

  it("clears secret inputs after secrets-updated", () => {
    let state = reduceUserSettings(initialUserSettingsUiState(), {
      type: "load-success",
      view: sampleView()
    });
    state = reduceUserSettings(state, {
      type: "field",
      key: "deepseekApiKeyInput",
      value: "sk-should-clear"
    });
    state = reduceUserSettings(state, {
      type: "secrets-updated",
      key: "chat.deepseekApiKey",
      secrets: { deepseekApiKey: true, databaseUrl: false, memoryLlmApiKey: false },
      restartServices: ["runtime"],
      supervisorSync: { applied: true, error: null },
      saved: true
    });
    expect(state.form.deepseekApiKeyInput).toBe("");
    expect(state.secrets.deepseekApiKey).toBe(true);
    expect(state.saveMessage).toMatch(/Applying changes to: runtime/);
  });

  it("buildSaveMessage covers success and sync failure", () => {
    expect(
      buildSaveMessage({
        saved: true,
        restartServices: ["runtime"],
        supervisorSync: { applied: true, error: null },
        kind: "secret"
      })
    ).toMatch(/Applying changes to: runtime/);
    expect(
      buildSaveMessage({
        saved: true,
        restartServices: ["runtime"],
        supervisorSync: { applied: false, error: "Supervisor unavailable" }
      })
    ).toMatch(/Supervisor was unavailable/);
  });

  it("surfaces save errors", () => {
    let state = reduceUserSettings(initialUserSettingsUiState(), { type: "save-start" });
    state = reduceUserSettings(state, { type: "save-error", error: "invalid url" });
    expect(state.saving).toBe(false);
    expect(state.error).toBe("invalid url");
  });

  it("patchFromForm never includes secret fields", () => {
    const form = defaultUserSettingsForm();
    form.deepseekApiKeyInput = "sk-leak";
    form.databaseUrlInput = "postgres://u:p@h/db";
    const patch = patchFromForm(form);
    const text = JSON.stringify(patch);
    expect(text).not.toContain("sk-leak");
    expect(text).not.toContain("postgres://");
    expect(text).not.toContain("apiKey");
  });

  it("formFromView maps DTO fields", () => {
    const form = formFromView(sampleView());
    expect(form.memoryBaseUrl).toBe("http://127.0.0.1:6131");
    expect(form.companionAlwaysOnTop).toBe(true);
  });

  it("field edits only update form local state (no secret leak)", () => {
    let state = reduceUserSettings(initialUserSettingsUiState(), {
      type: "load-success",
      view: sampleView()
    });
    state = reduceUserSettings(state, {
      type: "field",
      key: "chatModel",
      value: "deepseek-v4-flash"
    });
    expect(state.form.chatModel).toBe("deepseek-v4-flash");
    expect(state.revision).toBe(1);
    assertNoSecretMaterial(state);
    // Same revision after field-only edit — Save is what persists.
    expect(state.saving).toBe(false);
  });

  it("default Mem0 URL is product port 6131", () => {
    expect(defaultUserSettingsForm().memoryBaseUrl).toBe("http://127.0.0.1:6131");
  });

  it("patchFromForm is the only payload shape used for update_user_settings", () => {
    const form = defaultUserSettingsForm();
    form.chatModel = "typed-locally";
    form.deepseekApiKeyInput = "sk-must-not-ship";
    const patch = patchFromForm(form);
    expect(patch).toMatchObject({
      chat: { model: "typed-locally" }
    });
    expect(JSON.stringify(patch)).not.toContain("sk-must-not-ship");
    // Typing is local; Save is a separate explicit action (see client helpers).
    expect(USER_SETTINGS_MUTATION_COMMANDS).toContain("update_user_settings");
  });

  it("defaults Memory LLM to disabled with empty non-secret fields", () => {
    const form = defaultUserSettingsForm();
    expect(form.memoryLlmProvider).toBe("none");
    expect(form.memoryLlmModel).toBe("");
    expect(form.memoryLlmBaseUrl).toBe("");
    expect(form.memoryLlmApiKeyInput).toBe("");
    expect(emptySecretStatus().memoryLlmApiKey).toBe(false);
  });

  it("maps Memory LLM DTO fields and never restores an API key", () => {
    const view = sampleView();
    view.settings.memory.llm = {
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "https://api.example.test/v1"
    };
    view.secrets.memoryLlmApiKey = true;
    const form = formFromView(view);
    expect(form.memoryLlmProvider).toBe("openai");
    expect(form.memoryLlmModel).toBe("gpt-4o-mini");
    expect(form.memoryLlmBaseUrl).toBe("https://api.example.test/v1");
    expect(form.memoryLlmApiKeyInput).toBe("");
    expect(JSON.stringify(form)).not.toContain("Configured");
  });

  it("patch contains strict Memory LLM values but no secret fields", () => {
    const form = defaultUserSettingsForm();
    form.memoryLlmProvider = "deepseek";
    form.memoryLlmModel = "deepseek-chat";
    form.memoryLlmBaseUrl = "https://api.deepseek.com/v1";
    form.deepseekApiKeyInput = "chat-secret";
    form.databaseUrlInput = "postgres://user:password@example.test/db";
    form.memoryLlmApiKeyInput = "P3_UI_MEMORY_LLM_SECRET_NEVER_EXPOSE";
    const patch = patchFromForm(form);
    expect(patch).toMatchObject({
      memory: {
        llm: {
          provider: "deepseek",
          model: "deepseek-chat",
          baseUrl: "https://api.deepseek.com/v1"
        }
      }
    });
    const text = JSON.stringify(patch);
    expect(text).not.toContain("chat-secret");
    expect(text).not.toContain("password");
    expect(text).not.toContain("P3_UI_MEMORY_LLM_SECRET_NEVER_EXPOSE");
    expect(text).not.toContain("memoryLlmApiKeyInput");
    expect(text).not.toContain("memory.llmApiKey");
  });

  it("validates disabled, active, URL, and credential cases without echoing input", () => {
    const form = defaultUserSettingsForm();
    expect(validateUserSettingsForm(form)).toBeNull();
    form.memoryLlmModel = "retained-model";
    expect(validateUserSettingsForm(form)).toBeNull();
    form.memoryLlmProvider = "deepseek";
    form.memoryLlmModel = "";
    expect(validateUserSettingsForm(form)).toMatch(/model is required/i);
    form.memoryLlmProvider = "openai";
    expect(validateUserSettingsForm(form)).toMatch(/model is required/i);
    form.memoryLlmModel = "deepseek-chat";
    expect(validateUserSettingsForm(form)).toBeNull();
    form.memoryLlmBaseUrl = "http://127.0.0.1:8080/v1";
    expect(validateUserSettingsForm(form)).toBeNull();
    form.memoryLlmBaseUrl = "https://api.example.test/v1";
    expect(validateUserSettingsForm(form)).toBeNull();
    form.memoryLlmBaseUrl = "not a URL";
    expect(validateUserSettingsForm(form)).toMatch(/valid HTTP\(S\) URL/i);
    form.memoryLlmBaseUrl = "https://user:password@example.test/v1";
    const error = validateUserSettingsForm(form);
    expect(error).toMatch(/without credentials/i);
    expect(error).not.toContain("password");
    expect(error).not.toContain("example.test");
  });

  it("clears only the secret input named by a successful mutation", () => {
    let state = reduceUserSettings(initialUserSettingsUiState(), {
      type: "load-success",
      view: sampleView()
    });
    state = reduceUserSettings(state, { type: "field", key: "deepseekApiKeyInput", value: "chat" });
    state = reduceUserSettings(state, { type: "field", key: "databaseUrlInput", value: "db" });
    state = reduceUserSettings(state, {
      type: "field",
      key: "memoryLlmApiKeyInput",
      value: "P3_UI_MEMORY_LLM_SECRET_NEVER_EXPOSE"
    });
    const base = {
      deepseekApiKey: true,
      databaseUrl: true,
      memoryLlmApiKey: true
    };
    state = reduceUserSettings(state, {
      type: "secrets-updated",
      key: "memory.llmApiKey",
      secrets: base,
      restartServices: ["memory"],
      supervisorSync: { applied: true, error: null }
    });
    expect(state.form.memoryLlmApiKeyInput).toBe("");
    expect(state.form.deepseekApiKeyInput).toBe("chat");
    expect(state.form.databaseUrlInput).toBe("db");
    expect(JSON.stringify(state)).not.toContain("P3_UI_MEMORY_LLM_SECRET_NEVER_EXPOSE");
  });

  it("full save success clears all secret inputs, while save error preserves them", () => {
    let state = reduceUserSettings(initialUserSettingsUiState(), {
      type: "load-success",
      view: sampleView()
    });
    state = reduceUserSettings(state, { type: "field", key: "deepseekApiKeyInput", value: "chat" });
    state = reduceUserSettings(state, { type: "field", key: "databaseUrlInput", value: "db" });
    state = reduceUserSettings(state, {
      type: "field",
      key: "memoryLlmApiKeyInput",
      value: "memory"
    });
    const saveResult: UpdateSettingsResultDto = {
      saved: true,
      restartServices: [],
      restartApplication: false,
      revision: 2,
      settings: sampleView().settings,
      secrets: { deepseekApiKey: true, databaseUrl: true, memoryLlmApiKey: true },
      supervisorSync: { applied: true, error: null }
    };
    const saved = reduceUserSettings(state, {
      type: "save-success",
      result: saveResult,
      clearSecrets: true
    });
    expect(saved.form.deepseekApiKeyInput).toBe("");
    expect(saved.form.databaseUrlInput).toBe("");
    expect(saved.form.memoryLlmApiKeyInput).toBe("");
    expect(
      reduceUserSettings(state, { type: "save-error", error: "failed" }).form.memoryLlmApiKeyInput
    ).toBe("memory");
  });

  it("chat and database mutations do not clear an unsaved Memory key", () => {
    let state = reduceUserSettings(initialUserSettingsUiState(), {
      type: "load-success",
      view: sampleView()
    });
    state = reduceUserSettings(state, {
      type: "field",
      key: "memoryLlmApiKeyInput",
      value: "unsaved-memory-key"
    });
    const secrets = { deepseekApiKey: true, databaseUrl: true, memoryLlmApiKey: false };
    state = reduceUserSettings(state, {
      type: "secrets-updated",
      key: "chat.deepseekApiKey",
      secrets,
      saved: true
    });
    expect(state.form.memoryLlmApiKeyInput).toBe("unsaved-memory-key");
    state = reduceUserSettings(state, {
      type: "secrets-updated",
      key: "memory.databaseUrl",
      secrets,
      saved: true
    });
    expect(state.form.memoryLlmApiKeyInput).toBe("unsaved-memory-key");
  });

  it("delete Memory key updates its configured flag without restoring a value", () => {
    let state = reduceUserSettings(initialUserSettingsUiState(), {
      type: "load-success",
      view: sampleView()
    });
    state = reduceUserSettings(state, {
      type: "field",
      key: "memoryLlmApiKeyInput",
      value: "replace"
    });
    state = reduceUserSettings(state, {
      type: "secrets-updated",
      key: "memory.llmApiKey",
      secrets: { deepseekApiKey: false, databaseUrl: false, memoryLlmApiKey: false },
      restartServices: ["memory"],
      supervisorSync: { applied: true, error: null },
      saved: true
    });
    expect(state.secrets.memoryLlmApiKey).toBe(false);
    expect(state.form.memoryLlmApiKeyInput).toBe("");
  });

  it("uses service-neutral Memory secret messages and stable restart ordering", () => {
    expect(
      buildSaveMessage({
        saved: true,
        restartServices: ["memory"],
        supervisorSync: { applied: true, error: null },
        kind: "secret"
      })
    ).toBe("Secret updated. Applying changes to: memory.");
    expect(
      buildSaveMessage({
        saved: true,
        restartServices: [],
        supervisorSync: { applied: false, error: "offline" },
        kind: "secret"
      })
    ).toMatch(/Supervisor was unavailable/);
    expect(mergeRestartServices(["tts", "runtime"], ["memory", "runtime"], ["tts"])).toEqual([
      "runtime",
      "memory",
      "tts"
    ]);
  });

  it("accepts configured flags but rejects secret strings and env names", () => {
    expect(() => assertNoSecretMaterial({ secrets: emptySecretStatus() })).not.toThrow();
    expect(() => assertNoSecretMaterial({ memoryLlmApiKey: "secret" })).toThrow();
    expect(() => assertNoSecretMaterial({ memoryLlmApiKeyInput: "secret" })).toThrow();
    expect(() => assertNoSecretMaterial({ databaseUrl: "postgres://host/db" })).toThrow();
    expect(() => assertNoSecretMaterial({ env: "MEM0_LLM_API_KEY" })).toThrow();
    expect(() =>
      assertNoSecretMaterial({ marker: "P3_UI_MEMORY_LLM_SECRET_NEVER_EXPOSE" })
    ).toThrow();
  });

  it("does not let an older load overwrite newer persisted settings", () => {
    let state = reduceUserSettings(initialUserSettingsUiState(), {
      type: "load-success",
      view: {
        ...sampleView(),
        revision: 4,
        settings: {
          ...sampleView().settings,
          tts: { ...sampleView().settings.tts, enabled: false }
        }
      }
    });
    const stale = reduceUserSettings(state, {
      type: "load-success",
      view: {
        ...sampleView(),
        revision: 3,
        settings: { ...sampleView().settings, tts: { ...sampleView().settings.tts, enabled: true } }
      }
    });
    expect(stale).toBe(state);
    expect(stale.form.ttsEnabled).toBe(false);
  });

  it("does not let an older save result replace newer settings", () => {
    let state = reduceUserSettings(initialUserSettingsUiState(), {
      type: "load-success",
      view: { ...sampleView(), revision: 4 }
    });
    state = reduceUserSettings(state, { type: "save-start" });
    const stale = reduceUserSettings(state, {
      type: "save-success",
      clearSecrets: true,
      result: {
        saved: true,
        restartServices: [],
        restartApplication: false,
        revision: 3,
        settings: {
          ...sampleView().settings,
          tts: { ...sampleView().settings.tts, enabled: false }
        },
        secrets: emptySecretStatus(),
        supervisorSync: { applied: true, error: null }
      }
    });
    expect(stale.revision).toBe(4);
    expect(stale.form.ttsEnabled).toBe(true);
    expect(stale.saving).toBe(false);
  });

  it("exposes only the supported secret mutation keys to TypeScript callers", () => {
    const acceptsSecretKey = (key: Parameters<typeof setUserSecret>[0]): string => key;
    expect(acceptsSecretKey("memory.llmApiKey")).toBe("memory.llmApiKey");
    // @ts-expect-error Unsupported secret names must fail the client type contract.
    acceptsSecretKey("memory.unknownSecret");
  });
});
