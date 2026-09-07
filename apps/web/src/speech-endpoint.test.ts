import { describe, expect, it } from "vitest";
import { endpointDecision } from "./speech-endpoint.js";

describe("capture endpoint policy", () => {
  it("holds thinking pauses and commits complete stable speech sooner", () => {
    expect(endpointDecision("我觉得这个方案……", 900, 600)).toBe("KEEP_LISTENING");
    expect(endpointDecision("这个方案可以简化。", 700, 400)).toBe("COMMIT_UTTERANCE");
    expect(endpointDecision("Done.", 700, 400)).toBe("COMMIT_UTTERANCE");
    expect(endpointDecision("終わりました。", 700, 400)).toBe("COMMIT_UTTERANCE");
  });
  it.each(["因为", "如果……", "虽然", "然后", "我的意思是", "because", "I mean", "けど"])(
    "extends hanging structure %s",
    (text) => {
      expect(endpointDecision(text, 1500, 900)).toBe("KEEP_LISTENING");
      expect(endpointDecision(text, 2300, 900)).toBe("COMMIT_UTTERANCE");
    }
  );
  it("waits for a changing ASR suffix but bounds missing and unstable transcripts", () => {
    expect(endpointDecision("Done.", 1500, 100)).toBe("KEEP_LISTENING");
    expect(endpointDecision("Done.", 3000, 100)).toBe("COMMIT_UTTERANCE");
    expect(endpointDecision("", 3000, 0)).toBe("COMMIT_UTTERANCE");
  });
});
