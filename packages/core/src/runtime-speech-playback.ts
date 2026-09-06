import { EMBODIED_PRESENTATION_OUTCOME_7K_VERSION } from "@companion/protocol";
import type { EmbodiedPresentationOutcomeKind } from "@companion/protocol";
import {
  RUNTIME_EMBODIED_EFFECT_STATE_TRANSITION_7M_VERSION,
  decideRuntimeEmbodiedEffectStateTransition,
  type RuntimeEmbodiedEffectState
} from "./runtime-embodied-effect-state-transition.js";

/**
 * Runtime-owned speech-playback effect fence (Atom 14).
 *
 * Companion SpeechPlaybackQueue remains the only synthesis/playback mechanics.
 * This module reuses the Phase 7 monotonic reducer so barge-in INTERRUPTED
 * cannot be overwritten by a late COMPLETED. It is not a second effect ledger
 * and not a Voice Runtime.
 */

export const RUNTIME_SPEECH_PLAYBACK_VERSION = "runtime-speech-playback.v1" as const;

export type SpeechPlaybackEffect = Readonly<{
  version: typeof RUNTIME_SPEECH_PLAYBACK_VERSION;
  effectId: string;
  requestId: string;
  sessionId: string;
  state: RuntimeEmbodiedEffectState;
}>;

export type SpeechPlaybackStore = {
  current: SpeechPlaybackEffect | null;
};

export function createSpeechPlaybackStore(): SpeechPlaybackStore {
  return { current: null };
}

export function admitSpeechPlaybackEffect(
  store: SpeechPlaybackStore,
  input: { sessionId: string; requestId: string; createId?: () => string }
): SpeechPlaybackEffect {
  const sessionId = requireToken(input.sessionId, "sessionId");
  const requestId = requireToken(input.requestId, "requestId");
  if (store.current && isAudible(store.current.state) && store.current.requestId !== requestId) {
    applyOutcome(store, store.current.effectId, "INTERRUPTED");
  }
  const effectId = opaqueEffectId(input.createId);
  const effect: SpeechPlaybackEffect = Object.freeze({
    version: RUNTIME_SPEECH_PLAYBACK_VERSION,
    effectId,
    requestId,
    sessionId,
    state: "ADMITTED"
  });
  store.current = effect;
  return effect;
}

export function reportSpeechPlaybackOutcome(
  store: SpeechPlaybackStore,
  input: { effectId: string; outcome: EmbodiedPresentationOutcomeKind }
): SpeechPlaybackEffect | null {
  applyOutcome(store, requireToken(input.effectId, "effectId"), input.outcome);
  return store.current;
}

export function revokeAudibleSpeechPlayback(
  store: SpeechPlaybackStore
): SpeechPlaybackEffect | null {
  const current = store.current;
  if (!current || !isAudible(current.state)) return null;
  applyOutcome(store, current.effectId, "INTERRUPTED");
  return store.current;
}

export function isAudible(state: RuntimeEmbodiedEffectState): boolean {
  return state === "ADMITTED" || state === "STARTED";
}

function applyOutcome(
  store: SpeechPlaybackStore,
  effectId: string,
  outcome: EmbodiedPresentationOutcomeKind
): void {
  const current = store.current;
  if (!current) return;
  const decision = decideRuntimeEmbodiedEffectStateTransition({
    version: RUNTIME_EMBODIED_EFFECT_STATE_TRANSITION_7M_VERSION,
    report: {
      version: EMBODIED_PRESENTATION_OUTCOME_7K_VERSION,
      effectId,
      outcome
    },
    currentEffectId: current.effectId,
    admittedEffectId: current.effectId,
    currentState: current.state
  });
  if (decision.status === "TRANSITION_APPLIED") {
    store.current = Object.freeze({
      ...current,
      state: decision.nextState
    });
  }
}

function opaqueEffectId(createId?: () => string): string {
  const id = (createId ?? defaultId)().trim();
  if (!id) throw new Error("Speech playback effectId must be a non-empty opaque identity.");
  return id.startsWith("speech.") ? id : `speech.${id}`;
}

function defaultId(): string {
  return crypto.randomUUID();
}

function requireToken(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} must be a non-empty opaque identity.`);
  return trimmed;
}
