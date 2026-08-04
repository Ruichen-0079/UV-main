import { describe, expect, it } from "vitest";
import { USER_SETTINGS_MUTATION_COMMANDS } from "./user-settings-client.js";
import {
  assertNoSecretMaterial,
  buildSaveMessage,
  defaultUserSettingsForm,
  formFromView,
  initialUserSettingsUiState,
  patchFromForm,
  reduceUserSettings,
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
      ollamaUrl: "http://127.0.0.1:11434"
    },
    tts: {
      enabled: true,
      mode: "external",
      wrapperUrl: "http://127.0.0.1:9881",
      upstreamUrl: "http://127.0.0.1:9880"
    },
    companion: { alwaysOnTop: true }
  },
  secrets: { deepseekApiKey: false, databaseUrl: false },
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
      secrets: { deepseekApiKey: true, databaseUrl: false },
      supervisorSync: { applied: true, error: null }
    };
    state = reduceUserSettings(state, {
      type: "save-success",
      result,
      clearSecrets: true
    });
    expect(state.saving).toBe(false);
    expect(state.lastRestartServices).toEqual(["runtime", "memory"]);
    expect(state.saveMessage).toMatch(/Restart recommended/);
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
      secrets: { deepseekApiKey: false, databaseUrl: false },
      supervisorSync: { applied: false, error: "Supervisor unavailable" }
    };
    state = reduceUserSettings(state, {
      type: "save-success",
      result,
      clearSecrets: true
    });
    expect(result.saved).toBe(true);
    expect(state.saveMessage).toBe(
      "Settings saved, but running services were not refreshed. Restart YUVI to apply them."
    );
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
      secrets: { deepseekApiKey: true, databaseUrl: false },
      restartServices: ["runtime"],
      supervisorSync: { applied: true, error: null },
      saved: true
    });
    expect(state.form.deepseekApiKeyInput).toBe("");
    expect(state.secrets.deepseekApiKey).toBe(true);
    expect(state.saveMessage).toMatch(/Restart recommended/);
  });

  it("buildSaveMessage covers success and sync failure", () => {
    expect(
      buildSaveMessage({
        saved: true,
        restartServices: ["runtime"],
        supervisorSync: { applied: true, error: null }
      })
    ).toMatch(/Restart recommended: runtime/);
    expect(
      buildSaveMessage({
        saved: true,
        restartServices: ["runtime"],
        supervisorSync: { applied: false, error: "Supervisor unavailable" }
      })
    ).toMatch(/were not refreshed/);
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
});
