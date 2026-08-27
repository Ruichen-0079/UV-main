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
        <div className="font-semibold">{verificationModeLabel(result)}</div>
        <div className="mt-1 text-ink-600">{verificationModeExplanation(result)}</div>
      </div>
      <Definition label="Result" value={verificationOutcomeLabel(result)} />
      <Definition label="Capability" value={result.capability} />
      <Definition label="Provider" value={result.provider} />
      <Definition label="Mode" value={result.mock ? "mock" : "real"} />
      <Definition label="Model" value={result.model ?? "unknown"} />
      <Definition label="Latency" value={formatLatency(result.latencyMs)} />
      <Definition label="Local readiness" value={providerReadinessLabel(result.readiness)} />
      <Definition label="Cached observation" value={providerObservationLabel(result.observed)} />
      <div className="col-span-4">
        <Definition label="Cached observation metadata" value={cachedObservationDetail(result)} />
      </div>
      {result.capability === "embedding" && (
        <>
          <Definition
            label="Expected Dims"
            value={String(
              result.expectedDimensions ??
                result.configuredDimensions ??
                result.dimensions ??
                "unknown"
            )}
          />
          <Definition
            label="Actual Dims"
            value={String(result.actualDimensions ?? result.dimensions ?? "unknown")}
          />
          <Definition label="Semantic" value={String(result.semanticEmbedding ?? false)} />
          {result.mock && (
            <div className="col-span-6 text-amber-700">
              Mock embeddings validate the pipeline but do not provide real semantic similarity.
            </div>
          )}
          {result.expectedDimensions &&
            result.actualDimensions &&
            result.expectedDimensions !== result.actualDimensions && (
              <div className="col-span-6 text-rose-700">
                Provider returned {result.actualDimensions} dimensions while YUVI expected{" "}
                {result.expectedDimensions}. Check EMBEDDING_DIMENSIONS and model/provider
                compatibility.
              </div>
            )}
        </>
      )}
      {result.tokenUsage && (
        <div className="col-span-3">
          <Definition label="Token Usage" value={formatTokenUsage(result.tokenUsage)} />
        </div>
      )}
      {result.message && (
        <div className="col-span-6 text-ink-600">
          <span className="font-semibold">Inspection note:</span> {result.message}
        </div>
      )}
      {result.errorCode && (
        <div className="col-span-6 text-rose-700">
          <span className="font-semibold">Error code:</span> {result.errorCode}
        </div>
      )}
      {result.error && (
        <div className="col-span-6 text-rose-700">
          <span className="font-semibold">Error:</span> {result.error}
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
