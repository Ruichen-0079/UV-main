import type { ProactiveTurnStreamRequest } from "./api/client.js";
import type { ProactiveTurnAdmission } from "./proactive-turn-admission.js";

export type RequestOrigin = "user" | "proactive";

/**
 * Browser-local ownership for one in-flight Runtime request. The mutable
 * completion bit is deliberately kept with the identity so a late promise
 * settlement cannot be mistaken for a newer request.
 */
export type ActiveRequestOwnership = {
  id: string;
  assistantId: string;
  controller: AbortController;
  completedObserved: boolean;
  origin: RequestOrigin;
};

export type RequestIdentity = Pick<
  ActiveRequestOwnership,
  "id" | "assistantId" | "controller" | "origin"
>;

export type ProactiveRuntimeContext = {
  sessionId: string;
  readMemory: boolean;
  promptPreview?: boolean;
};

export type ProactiveTurnEffect = {
  decisionId: string;
  requestId: string;
  assistantId: string;
  idempotencyKey: string;
  request: ProactiveTurnStreamRequest;
  ownership: ActiveRequestOwnership;
};

export type ProactiveTurnCommitResult =
  | {
      kind: "not-admitted";
      admission: ProactiveTurnAdmission;
    }
  | {
      kind: "suppressed";
      reason: "decision-claimed" | "user-active" | "execution-busy";
    }
  | {
      kind: "committed";
      effect: ProactiveTurnEffect;
    };

export type ProactiveTurnExecutionOptions = {
  createRequestId?: () => string;
  createAssistantId?: () => string;
  createIdempotencyKey?: () => string;
  createAbortController?: () => AbortController;
};

export type ProactiveTurnExecution = {
  /**
   * Admission is supplied by the caller because this helper is execution
   * plumbing, not consent or policy authority.
   */
  tryCommit(input: {
    decisionId: string;
    admission: ProactiveTurnAdmission;
    active: ActiveRequestOwnership | null;
    context: ProactiveRuntimeContext;
  }): ProactiveTurnCommitResult;
  isDecisionClaimed(decisionId: string): boolean;
  isCurrent(active: ActiveRequestOwnership | null, effect: ProactiveTurnEffect): boolean;
};

let fallbackIdSequence = 0;

/** Create an opaque browser-local identity without using a clock. */
function createOpaqueId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  fallbackIdSequence += 1;
  return `${prefix}-${fallbackIdSequence}`;
}

function createDefaultIdempotencyKey(): string {
  return createOpaqueId("runtime");
}

function ensureRuntimeKeyIsDistinct(candidate: string, decisionId: string): string {
  if (candidate.trim().length > 0 && candidate !== decisionId) return candidate;
  return createDefaultIdempotencyKey();
}

/**
 * Page-lifetime arbitration for proactive text effects. Claims are retained
 * after completion, failure, or cancellation; they are intentionally not
 * durable and are never released for retry.
 */
export function createProactiveTurnExecution(
  options: ProactiveTurnExecutionOptions = {}
): ProactiveTurnExecution {
  const claimedDecisionIds = new Set<string>();
  const createRequestId = options.createRequestId ?? (() => createOpaqueId("proactive-turn"));
  const createAssistantId =
    options.createAssistantId ?? (() => createOpaqueId("proactive-assistant"));
  const createIdempotencyKey =
    options.createIdempotencyKey ?? (() => createDefaultIdempotencyKey());
  const createAbortController = options.createAbortController ?? (() => new AbortController());

  return {
    tryCommit({ decisionId, admission, active, context }): ProactiveTurnCommitResult {
      if (admission.decision !== "accepted") {
        return { kind: "not-admitted", admission };
      }
      if (claimedDecisionIds.has(decisionId)) {
        return { kind: "suppressed", reason: "decision-claimed" };
      }
      if (active?.origin === "user") {
        return { kind: "suppressed", reason: "user-active" };
      }
      if (active !== null) {
        return { kind: "suppressed", reason: "execution-busy" };
      }

      // Keep this order explicit: the bus decision is claimed before any
      // Runtime identity or local chat/effect work is created.
      claimedDecisionIds.add(decisionId);
      const idempotencyKey = ensureRuntimeKeyIsDistinct(createIdempotencyKey(), decisionId);
      const requestId = createRequestId();
      const assistantId = createAssistantId();
      const controller = createAbortController();
      const ownership: ActiveRequestOwnership = {
        id: requestId,
        assistantId,
        controller,
        completedObserved: false,
        origin: "proactive"
      };
      const request: ProactiveTurnStreamRequest = {
        sessionId: context.sessionId,
        idempotencyKey,
        modality: "text",
        options: {
          readMemory: context.readMemory,
          ...(context.promptPreview === undefined ? {} : { promptPreview: context.promptPreview })
        }
      };

      return {
        kind: "committed",
        effect: {
          decisionId,
          requestId,
          assistantId,
          idempotencyKey,
          request,
          ownership
        }
      };
    },

    isDecisionClaimed(decisionId: string): boolean {
      return claimedDecisionIds.has(decisionId);
    },

    isCurrent(active: ActiveRequestOwnership | null, effect: ProactiveTurnEffect): boolean {
      return isCurrentRequest(active, effect.ownership);
    }
  };
}

/** Identity fence shared by user and proactive async stream finalizers. */
export function isCurrentRequest(
  active: ActiveRequestOwnership | null,
  expected: RequestIdentity
): boolean {
  return (
    active !== null &&
    active.id === expected.id &&
    active.assistantId === expected.assistantId &&
    active.controller === expected.controller &&
    active.origin === expected.origin
  );
}

export function isCurrentProactiveEffect(
  active: ActiveRequestOwnership | null,
  effect: ProactiveTurnEffect
): boolean {
  return isCurrentRequest(active, effect.ownership);
}

/** Abort only a proactive request; callers clear ownership separately. */
export function preemptProactiveRequest(active: ActiveRequestOwnership | null): boolean {
  if (active?.origin !== "proactive") return false;
  active.controller.abort();
  return true;
}
