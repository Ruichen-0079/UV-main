import {
  sameSpeechSegment,
  speechSegmentKey,
  type SpeechSegmentIdentity
} from "./speech-identity.js";

export type SpeechPlaybackCorrelationPhase = "attached" | "started" | "terminal" | "detached";

export type SpeechPlaybackCorrelationState = {
  attached: SpeechSegmentIdentity | null;
  active: SpeechSegmentIdentity | null;
  retired: ReadonlySet<string>;
};

export function createSpeechPlaybackCorrelation(): SpeechPlaybackCorrelationState {
  return { attached: null, active: null, retired: new Set() };
}

export function correlateSpeechPlayback(
  current: SpeechPlaybackCorrelationState,
  phase: SpeechPlaybackCorrelationPhase,
  segment: SpeechSegmentIdentity
): { accepted: boolean; state: SpeechPlaybackCorrelationState } {
  const key = speechSegmentKey(segment);

  // A browser player emits a terminal playback event before its matching
  // audioElementDetached event. Keep that final resource cleanup admissible
  // for the segment that is still attached, while rejecting duplicate or
  // stale detaches for retired segments.
  if (phase === "detached" && sameSpeechSegment(current.attached, segment)) {
    return {
      accepted: true,
      state: {
        attached: null,
        active: sameSpeechSegment(current.active, segment) ? null : current.active,
        retired: new Set([...current.retired, key])
      }
    };
  }
  if (current.retired.has(key)) return { accepted: false, state: current };

  const retire = (...segments: Array<SpeechSegmentIdentity | null>) => {
    const retired = new Set(current.retired);
    for (const candidate of segments) {
      if (candidate) retired.add(speechSegmentKey(candidate));
    }
    return retired;
  };

  if (phase === "attached") {
    if (current.attached && !sameSpeechSegment(current.attached, segment)) {
      if (current.attached.requestId !== segment.requestId) {
        return { accepted: false, state: current };
      }
      if (segment.sequence <= current.attached.sequence) {
        return { accepted: false, state: current };
      }
    }
    if (current.active && !sameSpeechSegment(current.active, segment)) {
      return { accepted: false, state: current };
    }
    return {
      accepted: true,
      state: {
        attached: segment,
        active: current.active,
        retired: retire(
          current.attached && !sameSpeechSegment(current.attached, segment)
            ? current.attached
            : null
        )
      }
    };
  }

  if (phase === "started") {
    if (current.active && !sameSpeechSegment(current.active, segment)) {
      if (
        current.active.requestId !== segment.requestId ||
        segment.sequence < current.active.sequence
      ) {
        return { accepted: false, state: current };
      }
    }
    if (current.attached && !sameSpeechSegment(current.attached, segment)) {
      if (
        current.attached.requestId !== segment.requestId ||
        segment.sequence < current.attached.sequence
      ) {
        return { accepted: false, state: current };
      }
    }
    return {
      accepted: true,
      state: {
        attached: segment,
        active: segment,
        retired: retire(
          sameSpeechSegment(current.active, segment) ? null : current.active,
          sameSpeechSegment(current.attached, segment) ? null : current.attached
        )
      }
    };
  }

  if (phase === "terminal") {
    if (
      sameSpeechSegment(current.active, segment) ||
      sameSpeechSegment(current.attached, segment)
    ) {
      return {
        accepted: true,
        state: {
          attached: current.attached,
          active: null,
          retired: retire(segment)
        }
      };
    }
    // A terminal callback for a non-current segment is stale, but remembering
    // it prevents a later delayed playbackStarted from resurrecting it.
    return {
      accepted: false,
      state: {
        ...current,
        retired: retire(segment)
      }
    };
  }

  return { accepted: false, state: current };
}

export function retireActiveSpeechPlayback(
  current: SpeechPlaybackCorrelationState
): SpeechPlaybackCorrelationState {
  const retired = new Set(current.retired);
  if (current.active) retired.add(speechSegmentKey(current.active));
  if (current.attached) retired.add(speechSegmentKey(current.attached));
  return { attached: null, active: null, retired };
}
