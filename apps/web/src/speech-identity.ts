/** Stable product identity for one synthesized speech segment. */
export type SpeechSegmentIdentity = {
  requestId: string;
  sequence: number;
};

export function speechSegmentKey(segment: SpeechSegmentIdentity): string {
  return `${segment.requestId}:${segment.sequence}`;
}

export function sameSpeechSegment(
  left: SpeechSegmentIdentity | null | undefined,
  right: SpeechSegmentIdentity | null | undefined
): boolean {
  return (
    left !== null &&
    left !== undefined &&
    right !== null &&
    right !== undefined &&
    left.requestId === right.requestId &&
    left.sequence === right.sequence
  );
}
