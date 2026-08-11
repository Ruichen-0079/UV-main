import type { MemoryEvent, MemoryRetrievalOutcome, MemoryRetrievalStatus } from "@companion/memory";
import type { RetrievedMemoryForPrompt } from "@companion/prompt-builder";

/**
 * Prompt-facing projection of canonical evidence.
 *
 * The extra provenance fields are intentionally diagnostic-only. PromptBuilder
 * consumes the structural RetrievedMemoryForPrompt subset and never receives
 * raw backend records or semantic metadata.
 */
export type PromptMemoryCompatibility = RetrievedMemoryForPrompt & {
  provenanceId: string;
  source: string;
  sourceRecordId: string;
};

export type MemoryContextDropReason =
  | "missing-id"
  | "missing-source"
  | "missing-record-id"
  | "empty-content";

export type MemoryContextDiagnostics = {
  selectedCount: number;
  droppedCount: number;
  droppedReasons?: Partial<Record<MemoryContextDropReason, number>>;
  retrievalStatus?: MemoryRetrievalStatus;
  retrievalErrorCode?: string | null;
};

export type MemoryContext = {
  /** Canonical events retained for diagnostics and future Runtime wiring. */
  events: MemoryEvent[];
  /** Objects structurally accepted by the existing PromptBuilder input. */
  promptMemories: PromptMemoryCompatibility[];
  diagnostics: MemoryContextDiagnostics;
};

export type MemoryContextInput = MemoryEvent[] | MemoryRetrievalOutcome;

/**
 * Compatibility boundary between semantic evidence and the existing prompt
 * contract. It deliberately does not implement retrieval, ranking, dedupe,
 * prompt formatting, or token budgeting; those remain in their current owners.
 */
export class MemoryContextBuilder {
  build(input: MemoryContextInput): MemoryContext {
    const outcome = Array.isArray(input) ? undefined : input;
    const sourceEvents = Array.isArray(input) ? input : input.events;
    const events: MemoryEvent[] = [];
    const promptMemories: PromptMemoryCompatibility[] = [];
    const droppedReasons: Partial<Record<MemoryContextDropReason, number>> = {};

    for (const event of sourceEvents) {
      const reason = invalidEventReason(event);
      if (reason) {
        droppedReasons[reason] = (droppedReasons[reason] ?? 0) + 1;
        continue;
      }

      events.push(event);
      promptMemories.push(toPromptMemoryCompatibility(event));
    }

    const droppedCount = sourceEvents.length - events.length;
    return {
      events,
      promptMemories,
      diagnostics: {
        selectedCount: promptMemories.length,
        droppedCount,
        ...(Object.keys(droppedReasons).length > 0 ? { droppedReasons } : {}),
        ...(outcome
          ? {
              retrievalStatus: outcome.status,
              retrievalErrorCode: outcome.errorCode ?? null
            }
          : {})
      }
    };
  }
}

function toPromptMemoryCompatibility(event: MemoryEvent): PromptMemoryCompatibility {
  const content = event.content.trim();
  return {
    content,
    displayText: content,
    provenanceId: event.id,
    source: event.source,
    sourceRecordId: event.sourceRecordId
  };
}

function invalidEventReason(event: MemoryEvent): MemoryContextDropReason | undefined {
  if (!event.id?.trim()) return "missing-id";
  if (!event.source?.trim()) return "missing-source";
  if (!event.sourceRecordId?.trim()) return "missing-record-id";
  if (!event.content?.trim()) return "empty-content";
  return undefined;
}
