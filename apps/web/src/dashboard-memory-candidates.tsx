import { t } from "./locale.js";
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
            <span className="text-ink-500">{t("importance")}{" "}{candidate.importance.toFixed(2)}</span>
            {candidate.confidence !== undefined && (
              <span className="text-ink-500">{t("confidence")}{" "}{candidate.confidence.toFixed(2)}</span>
            )}
            <span className="font-mono text-ink-500">{t("trace")}{" "}{shortTrace(candidate.sourceTraceId ?? candidate.traceId)}
            </span>
            {!props.compact && (
              <>
                <span className="text-ink-500">{t("extractor")}{" "}{candidate.extractorMode ?? "n/a"}</span>
                <span className="text-ink-500">{t("fallback")}{" "}{String(candidate.fallbackUsed ?? false)}
                </span>
              </>
            )}
          </div>
          <p className="whitespace-pre-wrap text-sm text-ink-700">
            {props.compact ? candidate.contentPreview : candidate.content}
          </p>
          {!props.compact && candidate.temporalStatus === "unresolved" && (
            <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">{t("Relative time detected. Consider resolving it to an absolute date before saving.")}{" "}{candidate.temporalSuggestion ? t(" Suggested: {0}", candidate.temporalSuggestion) : ""}
            </div>
          )}
          {candidate.summary && (
            <p className="mt-2 text-xs text-ink-500">{t("Summary:")}{" "}{candidate.summary}</p>
          )}
          <div className="mt-2 text-xs text-ink-500">{t("Reason:")}{" "}{candidate.reason}
            {candidate.storageReason ? t(" · Stored: {0}", candidate.storageReason) : ""}
            {candidate.rejectedReason ? t(" · Rejected: {0}", candidate.rejectedReason) : ""}
          </div>
          {!props.compact && (
            <div className="mt-2 text-xs text-ink-500">{t("Origin:")}{" "}{candidate.originRole ?? "n/a"}{t("· Explicit remember:")}{" "}
              {String(candidate.explicitRememberRequested ?? false)}{t("· Correction:")}{" "}
              {String(candidate.correctionRequested ?? false)}
              {candidate.canonicalFingerprint
                ? t(" · Fingerprint: {0}", candidate.canonicalFingerprint)
                : ""}
            </div>
          )}
          {!props.compact && (
            <div className="mt-2 text-xs text-ink-500">{t("Tags:")}{" "}{candidate.tags.join(", ") || "none"}
            </div>
          )}
          {!props.compact && candidate.createdAt && (
            <div className="mt-2 text-xs text-ink-500">{t("Created:")}{" "}{formatDate(candidate.createdAt)}{t("· Source:")}{" "}{candidate.source ?? "runtime"}
              {candidate.extractorProvider ? t(" · Provider: {0}", candidate.extractorProvider) : ""}
            </div>
          )}
          {!props.compact && (
            <div className="mt-2 text-xs text-ink-500">{t("Observed:")}{" "}{formatDate(candidate.observedAt ?? "")}{t("· Valid:")}{" "}
              {formatDate(candidate.validFrom ?? "") || "now"} →{" "}
              {formatDate(candidate.validUntil ?? "") || "open"}
              {candidate.expiresAt ? t(" · Expires: {0}", formatDate(candidate.expiresAt)) : ""}
            </div>
          )}
          {!props.compact &&
            ((candidate.possibleSupersedes?.length ?? 0) > 0 ||
              (candidate.possibleContradictions?.length ?? 0) > 0) && (
              <div className="mt-2 text-xs text-ink-500">{t("Possible supersedes:")}{" "}{candidate.possibleSupersedes?.join(", ") || "none"}{t("· Contradictions:")}{" "}{candidate.possibleContradictions?.join(", ") || "none"}
                {candidate.relationshipConfidence !== undefined
                  ? t(" · Confidence: {0}", candidate.relationshipConfidence.toFixed(2))
                  : ""}
                {candidate.relationshipReason ? t(" · Reason: {0}", candidate.relationshipReason) : ""}
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
                  {candidate.storedMemoryId ? t("Stored") : t("Accept")}
                </button>
              )}
              {props.onEdit && (
                <button
                  className="button-secondary"
                  type="button"
                  onClick={() => props.onEdit?.(candidate)}
                >{t("Edit & Save")}</button>
              )}
              {props.onReject && (
                <button
                  className="button-secondary"
                  type="button"
                  disabled={props.busyCandidateId === candidate.id}
                  onClick={() => props.onReject?.(candidate)}
                >{t("Reject")}</button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
