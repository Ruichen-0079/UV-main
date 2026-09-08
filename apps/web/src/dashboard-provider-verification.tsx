import { t } from "./locale.js";
import type { ProviderVerificationResponse } from "./api/client.js";
import {
  cachedObservationDetail,
  providerObservationLabel,
  providerReadinessLabel,
  verificationModeExplanation,
  verificationModeLabel,
  verificationOutcomeLabel
} from "./provider-diagnostics.js";
import { Definition } from "./dashboard-ui.js";

export function ProviderVerificationResult(props: { result: ProviderVerificationResponse }): JSX.Element {
  const result = props.result;
  return (
    <div className="grid grid-cols-6 gap-3 rounded-md border border-ink-100 bg-ink-50 p-3 text-sm">
      <div className="col-span-6 rounded-md border border-ink-200 bg-white px-3 py-2 text-xs text-ink-700">
        <div className="font-semibold">{t(verificationModeLabel(result))}</div>
        <div className="mt-1 text-ink-600">{t(verificationModeExplanation(result))}</div>
      </div>
      <Definition label={t("Result")} value={verificationOutcomeLabel(result)} />
      <Definition label={t("Capability")} value={result.capability} />
      <Definition label={t("Provider")} value={result.provider} />
      <Definition label={t("Mode")} value={result.mock ? "mock" : "real"} />
      <Definition label={t("Model")} value={result.model ?? "unknown"} />
      <Definition label={t("Latency")} value={formatLatency(result.latencyMs)} />
      <Definition label={t("Local readiness")} value={providerReadinessLabel(result.readiness)} />
      <Definition label={t("Cached observation")} value={providerObservationLabel(result.observed)} />
      <div className="col-span-4">
        <Definition label={t("Cached observation metadata")} value={cachedObservationDetail(result)} />
      </div>
      {result.capability === "embedding" && (
        <>
          <Definition
            label={t("Expected Dims")}
            value={String(
              result.expectedDimensions ??
                result.configuredDimensions ??
                result.dimensions ??
                "unknown"
            )}
          />
          <Definition
            label={t("Actual Dims")}
            value={String(result.actualDimensions ?? result.dimensions ?? "unknown")}
          />
          <Definition label={t("Semantic")} value={String(result.semanticEmbedding ?? false)} />
          {result.mock && (
            <div className="col-span-6 text-amber-700">{t("Mock embeddings validate the pipeline but do not provide real semantic similarity.")}</div>
          )}
          {result.expectedDimensions &&
            result.actualDimensions &&
            result.expectedDimensions !== result.actualDimensions && (
              <div className="col-span-6 text-rose-700">{t("Provider returned")}{" "}{result.actualDimensions}{t("dimensions while YUVI expected")}{" "}
                {result.expectedDimensions}{t(". Check EMBEDDING_DIMENSIONS and model/provider compatibility.")}</div>
            )}
        </>
      )}
      {result.tokenUsage && (
        <div className="col-span-3">
          <Definition label={t("Token Usage")} value={formatTokenUsage(result.tokenUsage)} />
        </div>
      )}
      {result.message && (
        <div className="col-span-6 text-ink-600">
          <span className="font-semibold">{t("Inspection note:")}</span> {result.message}
        </div>
      )}
      {result.errorCode && (
        <div className="col-span-6 text-rose-700">
          <span className="font-semibold">{t("Error code:")}</span> {result.errorCode}
        </div>
      )}
      {result.error && (
        <div className="col-span-6 text-rose-700">
          <span className="font-semibold">{t("Error:")}</span> {result.error}
        </div>
      )}
    </div>
  );
}

export function formatLatency(latencyMs: number | undefined): string {
  return typeof latencyMs === "number" ? `${latencyMs}ms` : "unknown";
}

export function formatTokenUsage(tokenUsage: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}): string {
  if (typeof tokenUsage.totalTokens === "number") {
    return String(tokenUsage.totalTokens);
  }
  const input = tokenUsage.inputTokens ?? 0;
  const output = tokenUsage.outputTokens ?? 0;
  return String(input + output);
}
