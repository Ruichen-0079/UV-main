/**
 * Frontend DTO + reducer for Tauri user settings.
 * Secrets never appear as values — only configured flags.
 */

export type ServiceMode = "managed" | "external";
export type MemoryBackend = "mem0" | "legacy";

export type UserSettingsDto = {
  schemaVersion: number;
  app: { language: string };
  chat: { provider: string; model: string };
  runtime: { mode: ServiceMode; autostart: boolean; url: string };
  memory: {
    enabled: boolean;
    backend: MemoryBackend;
    mode: ServiceMode;
    baseUrl: string;
    subjectUserId: string;
    personaId: string;
    ollamaUrl: string;
  };
  tts: {
    enabled: boolean;
    mode: ServiceMode;
    wrapperUrl: string;
    upstreamUrl: string;
  };
  companion: { alwaysOnTop: boolean };
};

export type SecretStatusDto = {
  deepseekApiKey: boolean;
  databaseUrl: boolean;
};

export type SettingsViewDto = {
  settings: UserSettingsDto;
  secrets: SecretStatusDto;
  revision: number;
  configPath: string;
  loadError: string | null;
};

export type SupervisorSyncStatusDto = {
  applied: boolean;
  error: string | null;
};

export type UpdateSettingsResultDto = {
  saved: boolean;
  restartServices: string[];
  restartApplication: boolean;
  revision: number;
  settings: UserSettingsDto;
  secrets: SecretStatusDto;
  supervisorSync: SupervisorSyncStatusDto;
};

export type SecretMutationResultDto = {
  saved: boolean;
  secrets: SecretStatusDto;
  restartServices: string[];
  supervisorSync: SupervisorSyncStatusDto;
};

/** User-facing save notice: persistence vs live supervisor refresh. */
export function buildSaveMessage(input: {
  saved: boolean;
  restartServices: string[];
  supervisorSync?: SupervisorSyncStatusDto | null;
  kind?: "settings" | "secret";
}): string {
  const prefix = input.kind === "secret" ? "Secret updated" : "Settings saved";
  if (input.saved && input.supervisorSync && !input.supervisorSync.applied) {
    return `${prefix}, but Supervisor was unavailable. Close other YUVI windows, reopen this app, then Save again so Runtime gets the key.`;
  }
  if (input.kind === "secret" && input.supervisorSync?.applied) {
    return `${prefix}. Runtime is reloading with the new key — Providers should leave “unavailable” once healthy.`;
  }
  if (input.restartServices.length > 0) {
    return `${prefix}. Services may reload: ${input.restartServices.join(", ")}.`;
  }
  return `${prefix}.`;
}

export type UserSettingsForm = {
  language: string;
  chatProvider: string;
  chatModel: string;
  deepseekApiKeyInput: string;
  runtimeMode: ServiceMode;
  runtimeAutostart: boolean;
  runtimeUrl: string;
  memoryEnabled: boolean;
  memoryBackend: MemoryBackend;
  memoryMode: ServiceMode;
  memoryBaseUrl: string;
  subjectUserId: string;
  personaId: string;
  ollamaUrl: string;
  databaseUrlInput: string;
  ttsEnabled: boolean;
  ttsMode: ServiceMode;
  ttsWrapperUrl: string;
  ttsUpstreamUrl: string;
  companionAlwaysOnTop: boolean;
};

export type UserSettingsUiState = {
  loading: boolean;
  saving: boolean;
  error: string | null;
  loadError: string | null;
  configPath: string | null;
  revision: number;
  secrets: SecretStatusDto;
  form: UserSettingsForm;
  lastRestartServices: string[];
  saveMessage: string | null;
};

export const emptySecretStatus = (): SecretStatusDto => ({
  deepseekApiKey: false,
  databaseUrl: false
});

export const defaultUserSettingsForm = (): UserSettingsForm => ({
  language: "en",
  chatProvider: "deepseek",
  chatModel: "deepseek-chat",
  deepseekApiKeyInput: "",
  runtimeMode: "managed",
  runtimeAutostart: true,
  runtimeUrl: "http://127.0.0.1:6121",
  memoryEnabled: true,
  memoryBackend: "mem0",
  memoryMode: "managed",
  memoryBaseUrl: "http://127.0.0.1:6131",
  subjectUserId: "local-owner",
  personaId: "alice",
  ollamaUrl: "http://127.0.0.1:11434",
  databaseUrlInput: "",
  ttsEnabled: true,
  ttsMode: "external",
  ttsWrapperUrl: "http://127.0.0.1:9881",
  ttsUpstreamUrl: "http://127.0.0.1:9880",
  companionAlwaysOnTop: true
});

export const initialUserSettingsUiState = (): UserSettingsUiState => ({
  loading: true,
  saving: false,
  error: null,
  loadError: null,
  configPath: null,
  revision: 0,
  secrets: emptySecretStatus(),
  form: defaultUserSettingsForm(),
  lastRestartServices: [],
  saveMessage: null
});

export function formFromView(view: SettingsViewDto): UserSettingsForm {
  const s = view.settings;
  return {
    language: s.app.language,
    chatProvider: s.chat.provider,
    chatModel: s.chat.model,
    deepseekApiKeyInput: "",
    runtimeMode: s.runtime.mode,
    runtimeAutostart: s.runtime.autostart,
    runtimeUrl: s.runtime.url,
    memoryEnabled: s.memory.enabled,
    memoryBackend: s.memory.backend,
    memoryMode: s.memory.mode,
    memoryBaseUrl: s.memory.baseUrl,
    subjectUserId: s.memory.subjectUserId,
    personaId: s.memory.personaId,
    ollamaUrl: s.memory.ollamaUrl,
    databaseUrlInput: "",
    ttsEnabled: s.tts.enabled,
    ttsMode: s.tts.mode,
    ttsWrapperUrl: s.tts.wrapperUrl,
    ttsUpstreamUrl: s.tts.upstreamUrl,
    companionAlwaysOnTop: s.companion.alwaysOnTop
  };
}

export function patchFromForm(form: UserSettingsForm): Record<string, unknown> {
  return {
    app: { language: form.language },
    chat: { provider: form.chatProvider, model: form.chatModel },
    runtime: {
      mode: form.runtimeMode,
      autostart: form.runtimeAutostart,
      url: form.runtimeUrl
    },
    memory: {
      enabled: form.memoryEnabled,
      backend: form.memoryBackend,
      mode: form.memoryMode,
      baseUrl: form.memoryBaseUrl,
      subjectUserId: form.subjectUserId,
      personaId: form.personaId,
      ollamaUrl: form.ollamaUrl
    },
    tts: {
      enabled: form.ttsEnabled,
      mode: form.ttsMode,
      wrapperUrl: form.ttsWrapperUrl,
      upstreamUrl: form.ttsUpstreamUrl
    },
    companion: { alwaysOnTop: form.companionAlwaysOnTop }
  };
}

/** Ensure no secret field names/values leak into serialised DTO snapshots. */
export function assertNoSecretMaterial(payload: unknown): void {
  const text = JSON.stringify(payload);
  if (/"deepseekApiKey"\s*:\s*"[^"]+"/.test(text) && !text.includes('"deepseekApiKey":false') && !text.includes('"deepseekApiKey":true')) {
    // only boolean flags allowed under secrets.deepseekApiKey
  }
  if (text.includes("sk-") && text.includes("apiKey")) {
    throw new Error("secret material must not appear in settings DTO");
  }
  if (/postgres(ql)?:\/\/[^:]+:[^@]+@/i.test(text)) {
    throw new Error("database password must not appear in settings DTO");
  }
}

export type UserSettingsAction =
  | { type: "load-start" }
  | { type: "load-success"; view: SettingsViewDto }
  | { type: "load-error"; error: string }
  | { type: "field"; key: keyof UserSettingsForm; value: string | boolean }
  | { type: "save-start" }
  | { type: "save-success"; result: UpdateSettingsResultDto; clearSecrets: boolean }
  | { type: "save-error"; error: string }
  | {
      type: "secrets-updated";
      secrets: SecretStatusDto;
      restartServices?: string[];
      supervisorSync?: SupervisorSyncStatusDto | null;
      saved?: boolean;
    };

export function reduceUserSettings(
  state: UserSettingsUiState,
  action: UserSettingsAction
): UserSettingsUiState {
  switch (action.type) {
    case "load-start":
      return { ...state, loading: true, error: null };
    case "load-success":
      return {
        ...state,
        loading: false,
        error: null,
        loadError: action.view.loadError,
        configPath: action.view.configPath,
        revision: action.view.revision,
        secrets: action.view.secrets,
        form: formFromView(action.view),
        saveMessage: null
      };
    case "load-error":
      return { ...state, loading: false, error: action.error };
    case "field":
      return {
        ...state,
        form: { ...state.form, [action.key]: action.value },
        saveMessage: null
      };
    case "save-start":
      return { ...state, saving: true, error: null, saveMessage: null };
    case "save-success": {
      const form = formFromView({
        settings: action.result.settings,
        secrets: action.result.secrets,
        revision: action.result.revision,
        configPath: state.configPath ?? "",
        loadError: null
      });
      if (action.clearSecrets) {
        form.deepseekApiKeyInput = "";
        form.databaseUrlInput = "";
      }
      const restart = action.result.restartServices;
      return {
        ...state,
        saving: false,
        revision: action.result.revision,
        secrets: action.result.secrets,
        form,
        lastRestartServices: restart,
        saveMessage: buildSaveMessage({
          saved: action.result.saved,
          restartServices: restart,
          supervisorSync: action.result.supervisorSync,
          kind: "settings"
        })
      };
    }
    case "save-error":
      return { ...state, saving: false, error: action.error };
    case "secrets-updated": {
      const restart = action.restartServices ?? state.lastRestartServices;
      return {
        ...state,
        secrets: action.secrets,
        form: {
          ...state.form,
          deepseekApiKeyInput: "",
          databaseUrlInput: ""
        },
        lastRestartServices: restart,
        saveMessage: buildSaveMessage({
          saved: action.saved !== false,
          restartServices: restart,
          ...(action.supervisorSync !== undefined
            ? { supervisorSync: action.supervisorSync }
            : {}),
          kind: "secret"
        })
      };
    }
    default:
      return state;
  }
}
