import { ProductConfigurationPanel } from "./product-configuration.js";
import { t } from "./locale.js";
import {
  type ProviderCapability,
  type ProviderHealth,
  type ProviderVerificationResponse,
  type RuntimeSettingsResponse
} from "./api/client.js";

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

export function ProductModelsProviders(): JSX.Element { return <ProductConfigurationPanel sections={["models"]} />; }
