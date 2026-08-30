import { describe, expect, it } from "vitest";
import {
  CHARACTER_HARNESS_5D_VERSION,
  interpretCharacterHarnessOutput,
  superviseCharacterHarnessGeneration,
  superviseCharacterHarnessRepetition
} from "./index.js";

function publishable(proposal: unknown) {
  return superviseCharacterHarnessGeneration({
    interpretation: interpretCharacterHarnessOutput(proposal),
    finishReason: "stop",
    maxResponseCharacters: 8000
  });
}

describe("Character Harness 5D exact repetition supervision", () => {
  it("detects repeated Chinese character n-grams without language-specific tokenization", () => {
    const repeated = "你好世界你好世界你好世界";
    const result = superviseCharacterHarnessRepetition({
      generation: publishable({ disposition: "RESPOND", text: repeated }),
      ngramCharacters: 4,
      maxOccurrences: 2
    });

    expect(result).toEqual({
      version: CHARACTER_HARNESS_5D_VERSION,
      status: "REPETITION_DETECTED",
      reason: "EXACT_CHARACTER_NGRAM_REPETITION",
      ngramCharacters: 4,
      observedOccurrences: 3
    });
    expect(JSON.stringify(result)).not.toContain(repeated);
  });

  it("detects repetition across normalized casing and whitespace", () => {
    const result = superviseCharacterHarnessRepetition({
      generation: publishable({
        disposition: "RESPOND",
        text: "Loop Here   LOOP HERE loop here"
      }),
      ngramCharacters: 9,
      maxOccurrences: 2
    });

    expect(result.status).toBe("REPETITION_DETECTED");
  });

  it("does not reject ordinary non-repeating text", () => {
    const proposal = {
      disposition: "RESPOND",
      text: "A concise answer with several different pieces of information."
    } as const;
    const result = superviseCharacterHarnessRepetition({
      generation: publishable(proposal),
      ngramCharacters: 8,
      maxOccurrences: 2
    });

    expect(result).toEqual({
      version: CHARACTER_HARNESS_5D_VERSION,
      status: "ACCEPTED",
      proposal
    });
  });

  it("accepts text shorter than the configured n-gram window", () => {
    const proposal = { disposition: "RESPOND", text: "短句" } as const;
    const result = superviseCharacterHarnessRepetition({
      generation: publishable(proposal),
      ngramCharacters: 8,
      maxOccurrences: 1
    });

    expect(result).toMatchObject({ status: "ACCEPTED", proposal });
  });

  it.each(["SILENCE", "TERMINATE"] as const)(
    "bypasses text repetition checks for %s",
    (disposition) => {
      const result = superviseCharacterHarnessRepetition({
        generation: publishable({ disposition }),
        ngramCharacters: 4,
        maxOccurrences: 1
      });

      expect(result.status).toBe("ACCEPTED");
      if (result.status === "ACCEPTED") {
        expect(result.proposal.disposition).toBe(disposition);
      }
    }
  );

  it("bypasses text repetition checks for NEED_COGNITION", () => {
    const proposal = {
      disposition: "NEED_COGNITION",
      focus: "Need verification verification verification."
    } as const;
    const result = superviseCharacterHarnessRepetition({
      generation: publishable(proposal),
      ngramCharacters: 4,
      maxOccurrences: 1
    });

    expect(result).toEqual({
      version: CHARACTER_HARNESS_5D_VERSION,
      status: "ACCEPTED",
      proposal
    });
  });

  it("requires an already accepted 5C generation and cannot resurrect rejected output", () => {
    const rejected = superviseCharacterHarnessGeneration({
      interpretation: interpretCharacterHarnessOutput({
        disposition: "RESPOND",
        text: "Partial partial partial."
      }),
      finishReason: "length",
      maxResponseCharacters: 100
    });

    expect(() =>
      superviseCharacterHarnessRepetition({
        generation: rejected,
        ngramCharacters: 4,
        maxOccurrences: 2
      })
    ).toThrow();
  });

  it("revalidates accepted generation proposals instead of trusting forged envelopes", () => {
    expect(() =>
      superviseCharacterHarnessRepetition({
        generation: {
          version: "character-harness-5c.v1",
          status: "ACCEPTED",
          proposal: {
            disposition: "RESPOND",
            text: "Hello.",
            provider: "must-not-cross"
          }
        },
        ngramCharacters: 4,
        maxOccurrences: 2
      })
    ).toThrow(/unknown field: provider/);
  });

  it("rejects semantic-similarity/provider fields and invalid repetition policy", () => {
    expect(() =>
      superviseCharacterHarnessRepetition({
        generation: publishable({ disposition: "RESPOND", text: "Hello." }),
        ngramCharacters: 4,
        maxOccurrences: 2,
        semanticSimilarityThreshold: 0.9
      })
    ).toThrow(/unknown field: semanticSimilarityThreshold/);

    for (const input of [
      { ngramCharacters: 1, maxOccurrences: 2 },
      { ngramCharacters: 4.5, maxOccurrences: 2 },
      { ngramCharacters: 4, maxOccurrences: 0 },
      { ngramCharacters: 4, maxOccurrences: Number.POSITIVE_INFINITY }
    ]) {
      expect(() =>
        superviseCharacterHarnessRepetition({
          generation: publishable({ disposition: "RESPOND", text: "Hello." }),
          ...input
        })
      ).toThrow(/safe integer greater than or equal/);
    }
  });

  it("returns frozen accepted and rejection envelopes", () => {
    const accepted = superviseCharacterHarnessRepetition({
      generation: publishable({ disposition: "RESPOND", text: "Unique answer." }),
      ngramCharacters: 6,
      maxOccurrences: 2
    });
    const rejected = superviseCharacterHarnessRepetition({
      generation: publishable({ disposition: "RESPOND", text: "abcdabcdabcd" }),
      ngramCharacters: 4,
      maxOccurrences: 2
    });

    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(rejected)).toBe(true);
  });
});
