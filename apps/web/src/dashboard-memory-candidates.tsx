import type { MemoryCandidateReview } from "./api/client.js";
import { formatDate } from "./dashboard-format.js";
import { shortTrace } from "./dashboard-memory-view.js";

function relationshipPreviews(
  candidate: MemoryCandidateReview
): Array<{ id: string; relation: string; contentPreview: string }> {
  const value = candidate.metadata?.["relationshipMemoryPreviews"];
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }
      const record = entry as Record<string, unknown>;
      if (
        typeof record["id"] !== "string" ||
        typeof record["relation"] !== "string" ||
        typeof record["contentPreview"] !== "string"
      ) {
        return null;
      }
      return {
        id: record["id"],
        relation: record["relation"],
        contentPreview: record["contentPreview"]
      };
    })
    .filter((entry): entry is { id: string; relation: string; contentPreview: string } =>
      Boolean(entry)
    );
}

export function MemoryCandidateList(props: {
  candidates: MemoryCandidateReview[];
  compact?: boolean;
  busyCandidateId?: string | null;
  onAccept?(candidate: MemoryCandidateReview): void;
  onReject?(candidate: MemoryCandidateReview): void;
  onEdit?(candidate: MemoryCandidateReview): void;
}): JSX.Element {
  return (
    <div className="max-h-[360px] space-y-3 overflow-auto">
      {props.candidates.map((candidate) => (
        <div key={candidate.id} className="rounded-md border border-ink-100 bg-white p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="badge">{candidate.decision}</span>
            <span className="font-mono text-ink-500">{candidate.type}</span>
            <span className="text-ink-500">{candidate.subtype ?? "none"}</span>
            <span className="text-ink-500">
              {candidate.memoryLayer ?? "unknown"} · {candidate.scope ?? "user"}
              {candidate.scopeId ? `/${candidate.scopeId}` : ""}
            </span>
            <span className="text-ink-500">importance {candidate.importance.toFixed(2)}</span>
            {candidate.confidence !== undefined && (
              <span className="text-ink-500">confidence {candidate.confidence.toFixed(2)}</span>
            )}
            <span className="font-mono text-ink-500">
              trace {shortTrace(candidate.sourceTraceId ?? candidate.traceId)}
            </span>
            {!props.compact && (
              <>
                <span className="text-ink-500">extractor {candidate.extractorMode ?? "n/a"}</span>
                <span className="text-ink-500">
                  fallback {String(candidate.fallbackUsed ?? false)}
                </span>
              </>
            )}
          </div>
          <p className="whitespace-pre-wrap text-sm text-ink-700">
            {props.compact ? candidate.contentPreview : candidate.content}
          </p>
          {!props.compact && candidate.temporalStatus === "unresolved" && (
            <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
              Relative time detected. Consider resolving it to an absolute date before saving.
              {candidate.temporalSuggestion ? ` Suggested: ${candidate.temporalSuggestion}` : ""}
            </div>
          )}
          {candidate.summary && (
            <p className="mt-2 text-xs text-ink-500">Summary: {candidate.summary}</p>
          )}
          <div className="mt-2 text-xs text-ink-500">
            Reason: {candidate.reason}
            {candidate.storageReason ? ` · Stored: ${candidate.storageReason}` : ""}
            {candidate.rejectedReason ? ` · Rejected: ${candidate.rejectedReason}` : ""}
          </div>
          {!props.compact && (
            <div className="mt-2 text-xs text-ink-500">
              Origin: {candidate.originRole ?? "n/a"} · Explicit remember:{" "}
              {String(candidate.explicitRememberRequested ?? false)} · Correction:{" "}
              {String(candidate.correctionRequested ?? false)}
              {candidate.canonicalFingerprint
                ? ` · Fingerprint: ${candidate.canonicalFingerprint}`
                : ""}
            </div>
          )}
          {!props.compact && (
            <div className="mt-2 text-xs text-ink-500">
              Tags: {candidate.tags.join(", ") || "none"}
            </div>
          )}
          {!props.compact && candidate.createdAt && (
            <div className="mt-2 text-xs text-ink-500">
              Created: {formatDate(candidate.createdAt)} · Source: {candidate.source ?? "runtime"}
              {candidate.extractorProvider ? ` · Provider: ${candidate.extractorProvider}` : ""}
            </div>
          )}
          {!props.compact && (
            <div className="mt-2 text-xs text-ink-500">
              Observed: {formatDate(candidate.observedAt ?? "")} · Valid:{" "}
              {formatDate(candidate.validFrom ?? "") || "now"} →{" "}
              {formatDate(candidate.validUntil ?? "") || "open"}
              {candidate.expiresAt ? ` · Expires: ${formatDate(candidate.expiresAt)}` : ""}
            </div>
          )}
          {!props.compact &&
            ((candidate.possibleSupersedes?.length ?? 0) > 0 ||
              (candidate.possibleContradictions?.length ?? 0) > 0) && (
              <div className="mt-2 text-xs text-ink-500">
                Possible supersedes: {candidate.possibleSupersedes?.join(", ") || "none"} ·
                Contradictions: {candidate.possibleContradictions?.join(", ") || "none"}
                {candidate.relationshipConfidence !== undefined
                  ? ` · Confidence: ${candidate.relationshipConfidence.toFixed(2)}`
                  : ""}
                {candidate.relationshipReason ? ` · Reason: ${candidate.relationshipReason}` : ""}
              </div>
            )}
          {!props.compact && relationshipPreviews(candidate).length > 0 && (
            <div className="mt-2 space-y-1 text-xs text-ink-500">
              {relationshipPreviews(candidate).map((preview) => (
                <div key={`${preview.relation}-${preview.id}`}>
                  {preview.relation}: {preview.contentPreview}
                </div>
              ))}
            </div>
          )}
          {(props.onAccept || props.onReject || props.onEdit) && (
            <div className="mt-3 flex flex-wrap gap-2">
              {props.onAccept && (
                <button
                  className="button-secondary"
                  type="button"
                  disabled={
                    props.busyCandidateId === candidate.id || Boolean(candidate.storedMemoryId)
                  }
                  onClick={() => props.onAccept?.(candidate)}
                >
                  {candidate.storedMemoryId ? "Stored" : "Accept"}
                </button>
              )}
              {props.onEdit && (
                <button
                  className="button-secondary"
                  type="button"
                  onClick={() => props.onEdit?.(candidate)}
                >
                  Edit & Save
                </button>
              )}
              {props.onReject && (
                <button
                  className="button-secondary"
                  type="button"
                  disabled={props.busyCandidateId === candidate.id}
                  onClick={() => props.onReject?.(candidate)}
                >
                  Reject
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
