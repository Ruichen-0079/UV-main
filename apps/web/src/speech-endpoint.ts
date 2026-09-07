/** Capture-side policy only: thresholds never enter Runtime turn semantics. */
export type EndpointOptions = {
  completeMs: number;
  ordinaryMs: number;
  incompleteMs: number;
  stableMs: number;
  hardMs: number;
};
export const DEFAULT_ENDPOINT: EndpointOptions = {
  completeMs: 650,
  ordinaryMs: 1200,
  incompleteMs: 2200,
  stableMs: 350,
  hardMs: 3000
};

export function endpointDecision(
  text: string,
  silenceMs: number,
  stableMs: number,
  options = DEFAULT_ENDPOINT
): "KEEP_LISTENING" | "COMMIT_UTTERANCE" {
  if (silenceMs >= options.hardMs) return "COMMIT_UTTERANCE";
  if (!text.trim() || stableMs < options.stableMs) return "KEEP_LISTENING";
  const hanging =
    /(?:因为|如果|虽然|然后|我的意思是|けど|から|ので|(?:\b)(?:because|if|although|and|so|I mean))\s*[,.，、…]*$/i.test(
      text
    ) || /(?:…|\.\.\.|[,，、:：])\s*$/.test(text);
  const complete = /[。！？!?\.]\s*$/.test(text);
  const threshold = hanging
    ? options.incompleteMs
    : complete
      ? options.completeMs
      : options.ordinaryMs;
  return silenceMs >= threshold ? "COMMIT_UTTERANCE" : "KEEP_LISTENING";
}
