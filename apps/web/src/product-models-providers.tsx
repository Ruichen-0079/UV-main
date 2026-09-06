import { useEffect, useRef, useState } from "react";
import {
  apiClient,
  type ProviderCapability,
  type ProviderHealth,
  type ProviderVerificationResponse,
  type ProvidersStatusResponse,
  type RuntimeSettingsResponse
} from "./api/client.js";
import { useAsyncData } from "./hooks/useAsyncData.js";

type ProductProviderField = {
  key: string;
  label: string;
  type?: "text" | "url" | "password";
  secret?: boolean;
  placeholder?: string;
};

type ProductProviderDefinition = {
  id: string;
  label: string;
  description: string;
  fields: ProductProviderField[];
  capabilities: ProviderCapability[];
};

const LIVE_VERIFICATION_CAPABILITIES = new Set<ProviderCapability>([
  "chat",
  "reasoning",
  "embedding"
]);

export const PRODUCT_PROVIDER_DEFINITIONS: ProductProviderDefinition[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    description: "Native DeepSeek chat and reasoning routes.",
    fields: [
      { key: "DEEPSEEK_API_BASEURL", label: "Base URL", type: "url" },
      {
        key: "DEEPSEEK_API_KEY",
        label: "API key",
        type: "password",
        secret: true,
        placeholder: "Leave blank to keep the saved key"
      },
      { key: "DEEPSEEK_CHAT_MODEL", label: "Chat model" },
      { key: "DEEPSEEK_REASONING_MODEL", label: "Reasoning model" }
    ],
    capabilities: ["chat", "reasoning"]
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible",
    description: "OpenAI-compatible endpoint used by Chat and Cognition.",
    fields: [
      { key: "OPENAI_COMPATIBLE_API_BASEURL", label: "Base URL", type: "url" },
      {
        key: "OPENAI_COMPATIBLE_API_KEY",
        label: "API key",
        type: "password",
        secret: true,
        placeholder: "Leave blank to keep the saved key"
      },
      { key: "OPENAI_COMPATIBLE_CHAT_MODEL", label: "Chat model" },
      { key: "OPENAI_COMPATIBLE_REASONING_MODEL", label: "Reasoning model" }
    ],
    capabilities: ["chat", "reasoning"]
  },
  {
    id: "nvidia",
    label: "NVIDIA API",
    description: "OpenAI-compatible NVIDIA routes supported by Runtime.",
    fields: [
      { key: "NVIDIA_API_BASEURL", label: "Base URL", type: "url" },
      {
        key: "NVIDIA_API_KEY",
        label: "API key",
        type: "password",
        secret: true,
        placeholder: "Leave blank to keep the saved key"
      },
      { key: "NVIDIA_CHAT_MODEL", label: "Chat model" },
      { key: "NVIDIA_REASONING_MODEL", label: "Reasoning model" },
      { key: "NVIDIA_EMBEDDING_MODEL", label: "Embedding model" },
      { key: "NVIDIA_EMBEDDING_DIMENSIONS", label: "Embedding dimensions" },
      { key: "NVIDIA_VISION_MODEL", label: "Vision model" }
    ],
    capabilities: ["chat", "reasoning", "embedding", "vision"]
  },
  {
    id: "local",
    label: "Local models",
    description: "Local OpenAI-compatible and local capability routes. Runtime owns processes.",
    fields: [
      { key: "LOCAL_MODEL_BASEURL", label: "Base URL", type: "url" },
      { key: "LOCAL_CHAT_MODEL", label: "Chat model" },
      { key: "LOCAL_REASONING_MODEL", label: "Reasoning model" },
      { key: "LOCAL_EMBEDDING_MODEL", label: "Embedding model" },
      { key: "LOCAL_EMBEDDING_DIMENSIONS", label: "Embedding dimensions" },
      { key: "LOCAL_TTS_MODEL", label: "TTS model" },
      { key: "LOCAL_STT_MODEL", label: "STT model" },
      { key: "LOCAL_VISION_MODEL", label: "Vision model" }
    ],
    capabilities: ["chat", "reasoning", "embedding", "tts", "stt", "vision"]
  },
  {
    id: "xai",
    label: "xAI",
    description: "Optional xAI routes currently supported for TTS and Vision.",
    fields: [
      { key: "XAI_API_BASEURL", label: "Base URL", type: "url" },
      {
        key: "XAI_API_KEY",
        label: "API key",
        type: "password",
        secret: true,
        placeholder: "Leave blank to keep the saved key"
      },
      { key: "XAI_TTS_MODEL", label: "TTS model" },
      { key: "XAI_TTS_VOICE", label: "TTS voice" },
      { key: "XAI_VISION_MODEL", label: "Vision model" }
    ],
    capabilities: ["tts", "vision"]
  },
  {
    id: "dashscope",
    label: "DashScope",
    description: "Optional Alibaba Cloud STT route currently supported by Runtime.",
    fields: [
      { key: "DASHSCOPE_API_BASEURL", label: "Base URL", type: "url" },
      {
        key: "DASHSCOPE_API_KEY",
        label: "API key",
        type: "password",
        secret: true,
        placeholder: "Leave blank to keep the saved key"
      },
      { key: "DASHSCOPE_STT_MODEL", label: "STT model" }
    ],
    capabilities: ["stt"]
  },
  {
    id: "embedding",
    label: "Embedding",
    description:
      "Current embedding connection. Provider chain selection stays with Runtime routing.",
    fields: [
      { key: "EMBEDDING_API_BASEURL", label: "Base URL", type: "url" },
      {
        key: "EMBEDDING_API_KEY",
        label: "API key",
        type: "password",
        secret: true,
        placeholder: "Leave blank to keep the saved key"
      },
      { key: "EMBEDDING_MODEL", label: "Model" },
      { key: "EMBEDDING_DIMENSIONS", label: "Dimensions" }
    ],
    capabilities: ["embedding"]
  }
];

export function productSettingValue(
  settings: Pick<RuntimeSettingsResponse, "settings"> | null | undefined,
  key: string,
  fallback = ""
): string {
  const value = settings?.settings[key];
  if (value && "effective" in value && typeof value.effective === "string" && value.effective) {
    return value.effective;
  }
  return fallback;
}

export function productSettingConfigured(
  settings: Pick<RuntimeSettingsResponse, "settings"> | null | undefined,
  key: string
): boolean {
  const value = settings?.settings[key];
  return Boolean(value && "effectiveConfigured" in value && value.effectiveConfigured);
}

export function productProviderStatusLabel(status: ProviderHealth | undefined): string {
  if (!status) return "unknown";
  if (status.readiness === "not_ready") return "Not configured";
  if (status.mock) return "Ready · mock (remote unverified)";
  if (status.observed === "available") return "Verified available";
  if (status.observed === "unavailable") return "Verified unavailable";
  if (status.observed === "degraded") return "Verified degraded";
  if (status.readiness === "ready") return "Ready · unverified";
  return "unknown";
}

export function productVerificationSummary(
  result: Pick<ProviderVerificationResponse, "ok" | "verificationMode" | "provider" | "error">
): string {
  if (result.verificationMode === "config_only") {
    return result.ok
      ? "Configuration ready · no provider call was made"
      : "Configuration is not ready · no provider call was made";
  }
  return result.ok
    ? `Connected · ${result.provider}`
    : result.error
      ? `Connection failed · ${result.error}`
      : "Connection failed";
}

function productProviderStatusTone(
  status: ProviderHealth | undefined
): "ok" | "warn" | "bad" | "idle" {
  if (!status) return "idle";
  if (status.readiness === "not_ready" || status.observed === "unavailable") return "bad";
  if (status.observed === "degraded") return "warn";
  if (status.mock || status.observed === "available") return "ok";
  return "warn";
}

function capabilityLabel(capability: ProviderCapability): string {
  return capability === "stt"
    ? "STT"
    : capability === "tts"
      ? "TTS"
      : capability.charAt(0).toUpperCase() + capability.slice(1);
}

function routeStatus(
  providerStatus: ProvidersStatusResponse | null,
  provider: string,
  capability: ProviderCapability
): ProviderHealth | undefined {
  return providerStatus?.routes?.[capability]?.find((route) => route.provider === provider);
}

function fallbackFor(settings: RuntimeSettingsResponse, key: string): string {
  switch (key) {
    case "DEEPSEEK_API_BASEURL":
      return settings.providers.deepseek.baseUrl;
    case "DEEPSEEK_CHAT_MODEL":
      return settings.providers.deepseek.chatModel;
    case "DEEPSEEK_REASONING_MODEL":
      return settings.providers.deepseek.reasoningModel;
    case "OPENAI_COMPATIBLE_API_BASEURL":
      return settings.providers.openaiCompatible.baseUrl;
    case "OPENAI_COMPATIBLE_CHAT_MODEL":
      return settings.providers.openaiCompatible.chatModel;
    case "OPENAI_COMPATIBLE_REASONING_MODEL":
      return settings.providers.openaiCompatible.reasoningModel;
    case "XAI_API_BASEURL":
      return settings.providers.xai.baseUrl;
    case "XAI_TTS_MODEL":
      return settings.providers.xai.ttsModel;
    case "XAI_TTS_VOICE":
      return settings.providers.xai.ttsVoice;
    case "XAI_VISION_MODEL":
      return settings.providers.xai.visionModel;
    case "DASHSCOPE_API_BASEURL":
      return settings.providers.dashscope.baseUrl;
    case "DASHSCOPE_STT_MODEL":
      return settings.providers.dashscope.sttModel;
    case "EMBEDDING_PROVIDER":
      return settings.providers.embedding.provider;
    case "EMBEDDING_API_BASEURL":
      return settings.providers.embedding.baseUrl;
    case "EMBEDDING_MODEL":
      return settings.providers.embedding.model;
    case "EMBEDDING_DIMENSIONS":
      return settings.providers.embedding.dimensions;
    default:
      return "";
  }
}

function draftFromSettings(settings: RuntimeSettingsResponse): Record<string, string> {
  const draft: Record<string, string> = {};
  for (const provider of PRODUCT_PROVIDER_DEFINITIONS) {
    for (const field of provider.fields) {
      draft[field.key] = field.secret
        ? ""
        : productSettingValue(settings, field.key, fallbackFor(settings, field.key));
    }
  }
  return draft;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Request failed";
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
    .replace(/(api[-_]?key|authorization|token|password|secret)=([^&\s]+)/gi, "$1=[REDACTED]")
    .slice(0, 300);
}

function isConfigOnlyCapability(capability: ProviderCapability): boolean {
  return capability === "tts" || capability === "stt" || capability === "vision";
}

function ProviderCard(props: {
  definition: ProductProviderDefinition;
  settings: RuntimeSettingsResponse;
  providerStatus: ProvidersStatusResponse | null;
  draft: Record<string, string>;
  busy: boolean;
  verifying: ProviderCapability | null;
  onChange(key: string, value: string): void;
  onSave(): void;
  onVerify(capability: ProviderCapability): void;
}): JSX.Element {
  const statusFor = (capability: ProviderCapability): ProviderHealth | undefined => {
    if (props.definition.id === "embedding") {
      return props.providerStatus?.providers.embedding;
    }
    return routeStatus(props.providerStatus, props.definition.id, capability);
  };

  return (
    <section className="yuvi-product-provider-card">
      <div className="yuvi-product-provider-card-header">
        <div>
          <h2>{props.definition.label}</h2>
          <p>{props.definition.description}</p>
        </div>
        <span className="yuvi-product-provider-id">{props.definition.id}</span>
      </div>

      <div className="yuvi-product-provider-fields">
        {props.definition.fields.map((field) => {
          const configured = field.secret
            ? productSettingConfigured(props.settings, field.key)
            : undefined;
          return (
            <label key={field.key} className="yuvi-product-provider-field">
              <span>{field.label}</span>
              <input
                type={field.type ?? "text"}
                value={props.draft[field.key] ?? ""}
                placeholder={
                  field.secret && configured
                    ? (field.placeholder ?? "Leave blank to keep the saved key")
                    : field.placeholder
                }
                autoComplete={field.secret ? "new-password" : undefined}
                onChange={(event) => props.onChange(field.key, event.target.value)}
              />
              {field.secret ? (
                <small>
                  {configured ? "Key configured · value is never returned" : "Key not configured"}
                </small>
              ) : null}
            </label>
          );
        })}
      </div>

      <div className="yuvi-product-provider-statuses">
        {props.definition.capabilities.map((capability) => {
          const status = statusFor(capability);
          return (
            <div key={capability} className="yuvi-product-provider-status">
              <span>{capabilityLabel(capability)}</span>
              <span className={`yuvi-provider-state is-${productProviderStatusTone(status)}`}>
                {productProviderStatusLabel(status)}
              </span>
            </div>
          );
        })}
      </div>

      <div className="yuvi-product-provider-actions">
        <button
          type="button"
          className="yuvi-product-button is-primary"
          disabled={props.busy}
          onClick={props.onSave}
        >
          {props.busy ? "Saving…" : "Save & apply"}
        </button>
        {props.definition.capabilities.map((capability) => (
          <button
            key={capability}
            type="button"
            className="yuvi-product-button"
            disabled={props.busy || props.verifying !== null}
            onClick={() => props.onVerify(capability)}
          >
            {props.verifying === capability
              ? "Checking…"
              : LIVE_VERIFICATION_CAPABILITIES.has(capability)
                ? `Test connection · active ${capabilityLabel(capability)}`
                : `Inspect ${capabilityLabel(capability)} config`}
          </button>
        ))}
      </div>
    </section>
  );
}

export function ProductModelsProviders(): JSX.Element {
  const settings = useAsyncData((signal) => apiClient.getRuntimeSettings(signal), []);
  const providerStatus = useAsyncData((signal) => apiClient.getProviderStatus(signal), []);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [savingProvider, setSavingProvider] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<ProviderCapability | null>(null);
  const [verification, setVerification] = useState<ProviderVerificationResponse | null>(null);
  const [notice, setNotice] = useState<{ tone: "info" | "warning" | "error"; text: string } | null>(
    null
  );
  const seededRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (settings.data && !seededRef.current) {
      setDraft(draftFromSettings(settings.data));
      seededRef.current = true;
    }
  }, [settings.data]);

  const loadedSettings = settings.data;

  function setField(key: string, value: string): void {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function refreshSurfaces(): Promise<RuntimeSettingsResponse | null> {
    const [nextSettings] = await Promise.all([settings.refresh(), providerStatus.refresh()]);
    return nextSettings;
  }

  async function saveProvider(provider: ProductProviderDefinition): Promise<void> {
    if (!settings.data || savingProvider !== null) return;
    setSavingProvider(provider.id);
    setNotice(null);
    setVerification(null);
    const values: Record<string, string | null> = {};
    for (const field of provider.fields) {
      const value = draft[field.key] ?? "";
      if (field.secret && !value.trim()) continue;
      values[field.key] = field.secret ? value.trim() : value;
    }

    try {
      const saved = await apiClient.updateRuntimeSettings({ values });
      let applyError: string | null = null;
      let applied = null;
      try {
        applied = await apiClient.reloadRuntimeSettings();
      } catch (error) {
        applyError = safeErrorMessage(error);
      }
      const refreshed = await refreshSurfaces();
      const next = refreshed ?? saved.settings;
      if (mountedRef.current) {
        setDraft((current) => ({
          ...current,
          ...Object.fromEntries(
            provider.fields.map((field) => [
              field.key,
              field.secret ? "" : productSettingValue(next, field.key, fallbackFor(next, field.key))
            ])
          )
        }));
        if (applyError) {
          setNotice({ tone: "warning", text: `Saved, but Runtime apply failed: ${applyError}` });
        } else if (saved.restartRequired || applied?.restartRequired) {
          setNotice({
            tone: "warning",
            text: "Saved. Restart required before this provider change is active."
          });
        } else {
          setNotice({
            tone: "info",
            text: saved.changedKeys.length
              ? `Saved and applied: ${saved.changedKeys.join(", ")}`
              : "Saved and applied."
          });
        }
      }
    } catch (error) {
      if (mountedRef.current) {
        setNotice({ tone: "error", text: `Save failed: ${safeErrorMessage(error)}` });
      }
    } finally {
      if (mountedRef.current) setSavingProvider(null);
    }
  }

  async function verify(capability: ProviderCapability): Promise<void> {
    if (verifying !== null) return;
    setVerifying(capability);
    setVerification(null);
    setNotice(null);
    try {
      const result = await apiClient.verifyProvider(capability);
      if (mountedRef.current) setVerification(result);
      await providerStatus.refresh();
    } catch (error) {
      if (mountedRef.current) {
        setVerification({
          ok: false,
          provider: "unknown",
          capability,
          mock: false,
          verificationMode: isConfigOnlyCapability(capability) ? "config_only" : "live",
          error: safeErrorMessage(error)
        });
      }
    } finally {
      if (mountedRef.current) setVerifying(null);
    }
  }

  return (
    <section className="yuvi-product-settings">
      <header className="yuvi-product-page-header">
        <div>
          <div className="yuvi-product-eyebrow">Settings</div>
          <h1>Models &amp; Providers</h1>
          <p>
            Configure connections through current-main Runtime settings. Secrets stay masked;
            readiness and live observations remain separate.
          </p>
        </div>
        <div className="yuvi-product-provider-count">
          <span>Current providers</span>
          <strong>{PRODUCT_PROVIDER_DEFINITIONS.length}</strong>
        </div>
      </header>

      <div className="yuvi-product-authority-note">
        <strong>Current Runtime authority</strong>
        <span>
          Save &amp; apply uses <code>/settings/runtime</code> and Runtime reload. No Product UI
          configuration store is created.
        </span>
      </div>

      <div className="yuvi-product-gap-note">
        Model discovery is not available in current main. Enter a model ID manually; no discovery
        backend is added in this atom.
      </div>

      {settings.loading && !settings.data ? (
        <div className="yuvi-product-inline-state">Loading current settings…</div>
      ) : null}
      {settings.error ? (
        <div className="yuvi-product-inline-state is-error" role="alert">
          Settings unavailable: {settings.error}
        </div>
      ) : null}
      {providerStatus.error ? (
        <div className="yuvi-product-inline-state is-warning" role="alert">
          Provider observations unavailable: {providerStatus.error}
        </div>
      ) : null}
      {notice ? (
        <div className={`yuvi-product-inline-state is-${notice.tone}`} role="status">
          {notice.text}
        </div>
      ) : null}
      {verification ? (
        <div
          className={`yuvi-product-verification ${verification.ok ? "is-ok" : "is-error"}`}
          role="status"
        >
          <strong>{productVerificationSummary(verification)}</strong>
          <span>
            {verification.verificationMode === "live"
              ? "Live provider verification called the Runtime-selected route."
              : "This is a config-only observation and does not prove remote reachability."}
          </span>
        </div>
      ) : null}

      {loadedSettings ? (
        <div className="yuvi-product-provider-grid">
          {PRODUCT_PROVIDER_DEFINITIONS.map((provider) => (
            <ProviderCard
              key={provider.id}
              definition={provider}
              settings={loadedSettings}
              providerStatus={providerStatus.data}
              draft={draft}
              busy={savingProvider !== null}
              verifying={verifying}
              onChange={setField}
              onSave={() => void saveProvider(provider)}
              onVerify={(capability) => void verify(capability)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
