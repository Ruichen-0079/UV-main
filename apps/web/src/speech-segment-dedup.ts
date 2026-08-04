/**
 * Idempotence guard for speech segments delivered over the cross-window bus.
 * BroadcastChannel has no replay, but a reconnecting window or a duplicated
 * flush must never synthesize the same (requestId, sequence) twice.
 */
export function createSpeechSegmentDeduper(): {
  isNew(requestId: string, sequence: number): boolean;
} {
  const seen = new Set<string>();
  return {
    isNew(requestId, sequence) {
      const key = `${requestId}:${sequence}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }
  };
}
