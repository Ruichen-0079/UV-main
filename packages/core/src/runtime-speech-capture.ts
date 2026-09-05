import type { STTOutput, STTSegment } from "@companion/providers";

export const SPEECH_CAPTURE_CLAIM_LIMIT = 256;

export type SpeechCaptureClaimStatus = "accepted" | "duplicate" | "stale-epoch";

export type SpeechCaptureAdmitInput = Readonly<{
  observation: STTOutput;
  sessionId?: string | undefined;
  captureEpoch?: string | undefined;
  createId?: () => string;
}>;

export type SpeechCaptureAdmitResult = Readonly<{
  status: "accepted" | "duplicate";
  captureEpoch: string;
  observation: STTOutput;
}>;

export type SpeechCaptureStore = {
  liveEpochBySession: Map<string, string>;
  obsoleteEpochs: Set<string>;
  obsoleteOrder: string[];
  claims: Map<string, true>;
};

export function createSpeechCaptureStore(): SpeechCaptureStore {
  return {
    liveEpochBySession: new Map(),
    obsoleteEpochs: new Set(),
    obsoleteOrder: [],
    claims: new Map()
  };
}

export function claimKey(captureEpoch: string, segmentId: string): string {
  return `${captureEpoch}\0${segmentId}`;
}

/**
 * Bind a live capture generation to a session without a finalized segment.
 * A new epoch obsoletes the previous live epoch for that session.
 */
export function beginLiveSpeechCapture(
  store: SpeechCaptureStore,
  sessionId: string | undefined,
  captureEpoch: string
): string {
  const epoch = opaqueIdentity(captureEpoch, defaultCreateId, "captureEpoch");
  if (store.obsoleteEpochs.has(epoch)) {
    throw new SpeechCaptureFenceError("stale-epoch", epoch);
  }
  const session = normalizeSessionId(sessionId);
  const live = store.liveEpochBySession.get(session);
  if (live !== undefined && live !== epoch) {
    markObsolete(store, live);
  }
  store.liveEpochBySession.set(session, epoch);
  return epoch;
}

/**
 * Runtime-lifetime fence for one finalized speech observation.
 * Duplicate key is (captureEpoch, segmentId). Transcript text is never a key.
 */
export function admitFinalizedSpeechCapture(
  store: SpeechCaptureStore,
  input: SpeechCaptureAdmitInput
): SpeechCaptureAdmitResult {
  const createId = input.createId ?? defaultCreateId;
  const captureEpoch = opaqueIdentity(input.captureEpoch, createId, "captureEpoch");
  if (store.obsoleteEpochs.has(captureEpoch)) {
    throw new SpeechCaptureFenceError("stale-epoch", captureEpoch);
  }

  const sessionId = normalizeSessionId(input.sessionId);
  const live = store.liveEpochBySession.get(sessionId);
  if (live !== undefined && live !== captureEpoch) {
    markObsolete(store, live);
    store.liveEpochBySession.set(sessionId, captureEpoch);
  } else if (live === undefined) {
    store.liveEpochBySession.set(sessionId, captureEpoch);
  }

  const observation = normalizeObservation(input.observation, captureEpoch, createId);
  const segmentIds = (observation.segments ?? []).map((segment) => segment.segmentId ?? "");
  if (segmentIds.some((id) => id.length === 0)) {
    throw new Error("Finalized speech segments require a segmentId.");
  }

  let acceptedCount = 0;
  for (const segmentId of segmentIds) {
    const key = claimKey(captureEpoch, segmentId);
    if (store.claims.has(key)) {
      continue;
    }
    store.claims.set(key, true);
    acceptedCount += 1;
  }
  evictOldestClaims(store);

  if (acceptedCount === 0) {
    return { status: "duplicate", captureEpoch, observation };
  }
  return { status: "accepted", captureEpoch, observation };
}

export class SpeechCaptureFenceError extends Error {
  readonly reason: "duplicate" | "stale-epoch";
  readonly captureEpoch: string;
  readonly segmentId?: string;

  constructor(
    reason: "duplicate" | "stale-epoch",
    captureEpoch: string,
    message = reason === "stale-epoch"
      ? "Finalized speech from an obsolete capture epoch was rejected."
      : "Duplicate finalized speech segment was suppressed."
  ) {
    super(message);
    this.name = "SpeechCaptureFenceError";
    this.reason = reason;
    this.captureEpoch = captureEpoch;
  }
}

function normalizeObservation(
  output: STTOutput,
  captureEpoch: string,
  createId: () => string
): STTOutput {
  const observationId = opaqueIdentity(output.observationId, createId, "observationId");
  const sourceSegments = output.segments;
  const segments: STTSegment[] =
    sourceSegments !== undefined && sourceSegments.length > 0
      ? sourceSegments.map((segment) =>
          Object.freeze({
            ...segment,
            segmentId: opaqueIdentity(segment.segmentId, createId, "segmentId")
          })
        )
      : [Object.freeze({ segmentId: observationId, text: output.text })];
  return {
    ...output,
    observationId,
    captureEpoch,
    segments
  };
}

function normalizeSessionId(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "default";
}

function opaqueIdentity(value: string | undefined, createId: () => string, field: string): string {
  if (value === undefined) {
    return createId();
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must be a non-empty opaque identity.`);
  }
  return trimmed;
}

function markObsolete(store: SpeechCaptureStore, epoch: string): void {
  if (store.obsoleteEpochs.has(epoch)) {
    return;
  }
  store.obsoleteEpochs.add(epoch);
  store.obsoleteOrder.push(epoch);
  while (store.obsoleteOrder.length > SPEECH_CAPTURE_CLAIM_LIMIT) {
    const oldest = store.obsoleteOrder.shift();
    if (oldest) store.obsoleteEpochs.delete(oldest);
  }
}

function evictOldestClaims(store: SpeechCaptureStore): void {
  while (store.claims.size > SPEECH_CAPTURE_CLAIM_LIMIT) {
    const oldest = store.claims.keys().next().value;
    if (oldest === undefined) return;
    store.claims.delete(oldest);
  }
}

function defaultCreateId(): string {
  return crypto.randomUUID();
}
