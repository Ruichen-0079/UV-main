import { ProductConfigurationPanel } from "./product-configuration.js";
import { AsyncProgress } from "./async-progress.js";
import { t } from "./locale.js";
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
    description: t("Native DeepSeek chat and reasoning routes."),
    fields: [
      { key: "DEEPSEEK_API_BASEURL", label: t("Base URL"), type: "url" },
      {
        key: "DEEPSEEK_API_KEY",
        label: t("API key"),
        type: "password",
        secret: true,
        placeholder: t("Leave blank to keep the saved key")
      },
      { key: "DEEPSEEK_CHAT_MODEL", label: t("Chat model") },
      { key: "DEEPSEEK_REASONING_MODEL", label: t("Reasoning model") }
    ],
    capabilities: ["chat", "reasoning"]
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible",
    description: t("OpenAI-compatible endpoint used by Chat and Cognition."),
    fields: [
      { key: "OPENAI_COMPATIBLE_API_BASEURL", label: t("Base URL"), type: "url" },
      {
        key: "OPENAI_COMPATIBLE_API_KEY",
        label: t("API key"),
        type: "password",
        secret: true,
        placeholder: t("Leave blank to keep the saved key")
      },
      { key: "OPENAI_COMPATIBLE_CHAT_MODEL", label: t("Chat model") },
      { key: "OPENAI_COMPATIBLE_REASONING_MODEL", label: t("Reasoning model") },
      { key: "OPENAI_COMPATIBLE_PROACTIVE_DECISION_MODEL", label: t("Proactive decision model") }
    ],
    capabilities: ["chat", "reasoning"]
  },
  {
    id: "nvidia",
    label: "NVIDIA API",
    description: t("OpenAI-compatible NVIDIA routes supported by Runtime."),
    fields: [
      { key: "NVIDIA_API_BASEURL", label: t("Base URL"), type: "url" },
      {
        key: "NVIDIA_API_KEY",
        label: t("API key"),
        type: "password",
        secret: true,
        placeholder: t("Leave blank to keep the saved key")
      },
      { key: "NVIDIA_CHAT_MODEL", label: t("Chat model") },
      { key: "NVIDIA_REASONING_MODEL", label: t("Reasoning model") },
      { key: "NVIDIA_EMBEDDING_MODEL", label: t("Embedding model") },
      { key: "NVIDIA_EMBEDDING_DIMENSIONS", label: t("Embedding dimensions") },
      { key: "NVIDIA_VISION_MODEL", label: t("Vision model") }
    ],
    capabilities: ["chat", "reasoning", "embedding", "vision"]
  },
  {
    id: "local",
    label: t("Local models"),
    description:
      t("Local service connections. TTS is optional; no voice model is selected automatically."),
    fields: [
      { key: "LOCAL_MODEL_BASEURL", label: t("Base URL"), type: "url" },
      { key: "LOCAL_CHAT_MODEL", label: t("Chat model") },
      { key: "LOCAL_REASONING_MODEL", label: t("Reasoning model") },
      { key: "LOCAL_EMBEDDING_MODEL", label: t("Embedding model") },
      { key: "LOCAL_EMBEDDING_DIMENSIONS", label: t("Embedding dimensions") },
      { key: "LOCAL_TTS_MODEL", label: t("Local TTS model") },
      { key: "LOCAL_TTS_BASE_URL", label: t("Local TTS URL"), type: "url" },
      { key: "LOCAL_STT_BASE_URL", label: t("STT service URL"), type: "url" },
      { key: "LOCAL_STT_MODEL", label: t("STT model") },
      { key: "LOCAL_VISION_MODEL", label: t("Vision model") }
    ],
    capabilities: ["chat", "reasoning", "embedding", "tts", "stt", "vision"]
  },
  {
    id: "xai",
    label: "xAI",
    description: t("Optional xAI routes currently supported for TTS and Vision."),
    fields: [
      { key: "XAI_API_BASEURL", label: t("Base URL"), type: "url" },
      {
        key: "XAI_API_KEY",
        label: t("API key"),
        type: "password",
        secret: true,
        placeholder: t("Leave blank to keep the saved key")
      },
      { key: "XAI_TTS_MODEL", label: t("TTS model") },
      { key: "XAI_TTS_VOICE", label: t("TTS voice") },
      { key: "XAI_VISION_MODEL", label: t("Vision model") }
    ],
    capabilities: ["tts", "vision"]
  },
  {
    id: "dashscope",
    label: "DashScope",
    description: t("Optional Alibaba Cloud STT route currently supported by Runtime."),
    fields: [
      { key: "DASHSCOPE_API_BASEURL", label: t("Base URL"), type: "url" },
      {
        key: "DASHSCOPE_API_KEY",
        label: t("API key"),
        type: "password",
        secret: true,
        placeholder: t("Leave blank to keep the saved key")
      },
      { key: "DASHSCOPE_STT_MODEL", label: t("STT model") }
    ],
    capabilities: ["stt"]
  },
  {
    id: "embedding",
    label: t("Embedding"),
    description:
      t("Current embedding connection. Provider chain selection stays with Runtime routing."),
    fields: [
      { key: "EMBEDDING_API_BASEURL", label: t("Base URL"), type: "url" },
      {
        key: "EMBEDDING_API_KEY",
        label: t("API key"),
        type: "password",
        secret: true,
        placeholder: t("Leave blank to keep the saved key")
      },
      { key: "EMBEDDING_MODEL", label: t("Model") },
      { key: "EMBEDDING_DIMENSIONS", label: t("Dimensions") }
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
      ? t("Configuration ready · no provider call was made")
      : t("Configuration is not ready · no provider call was made");
  }
  return result.ok
    ? t("Connected · {0}", result.provider)
    : result.error
      ? t("Connection failed · {0}", result.error)
      : t("Connection failed");
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
              <span>{t(field.label)}</span>
              <input
                disabled={props.busy}
                type={field.type ?? "text"}
                value={props.draft[field.key] ?? ""}
                placeholder={
                  field.secret && configured
                    ? (field.placeholder ?? t("Leave blank to keep the saved key"))
                    : field.placeholder
                }
                autoComplete={field.secret ? "new-password" : undefined}
                onChange={(event) => props.onChange(field.key, event.target.value)}
              />
              {field.secret ? (
                <small>
                  {configured ? t("Key configured · value is never returned") : t("Key not configured")}
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
              <span>{t(capabilityLabel(capability))}</span>
              <span className={`yuvi-provider-state is-${productProviderStatusTone(status)}`}>
                {t(productProviderStatusLabel(status))}
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
          {props.busy ? t("Saving…") : t("Save & apply")}
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
              ? t("Checking…")
              : LIVE_VERIFICATION_CAPABILITIES.has(capability)
                ? t("Test connection · active {0}", capabilityLabel(capability))
                : t("Inspect {0} config", capabilityLabel(capability))}
          </button>
        ))}
      </div>
    </section>
  );
}

export function ProductModelsProviders(): JSX.Element { return <ProductConfigurationPanel sections={["models"]} />; }
