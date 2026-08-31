import { describe, expect, it } from "vitest";
import { CHARACTER_ABI_2A_VERSION } from "./index.js";
import { projectMemoryVNextToCharacterAbi } from "./memory-vnext-projection.js";

describe("Memory vNext Character ABI projection", () => {
  it("projects L0/L1/L2 and temporal slots without inventing unavailable meaning", () => {
    const context = projectMemoryVNextToCharacterAbi({
      recentConversation: {
        state: "KNOWN",
        summary: "User asked about yesterday's training.",
        provenanceReferences: ["direct-context"]
      },
      memoryEvidence: {
        state: "KNOWN",
        summary: "L1 episode about 训练 on port 6121.",
        provenanceReferences: ["episode:session:abc"]
      },
      temporalContext: {
        state: "KNOWN",
        summary: "Elapsed since last interaction: 16 hours [yesterday]"
      }
    });

    expect(context.abiVersion).toBe(CHARACTER_ABI_2A_VERSION);
    expect(context.sections.map((section) => section.kind)).toEqual([
      "RECENT_CONVERSATION",
      "MEMORY_EVIDENCE",
      "TEMPORAL_CONTEXT"
    ]);
    expect(JSON.stringify(context)).not.toMatch(/mem0|postgres|MemoryProvider/i);
  });

  it("keeps unavailable Memory distinct from empty Memory", () => {
    const unavailable = projectMemoryVNextToCharacterAbi({
      recentConversation: { state: "EMPTY" },
      memoryEvidence: { state: "UNAVAILABLE" },
      temporalContext: { state: "UNKNOWN" }
    });
    const empty = projectMemoryVNextToCharacterAbi({
      recentConversation: { state: "EMPTY" },
      memoryEvidence: { state: "EMPTY" },
      temporalContext: { state: "UNKNOWN" }
    });

    expect(unavailable.sections.find((section) => section.kind === "MEMORY_EVIDENCE")?.state).toBe(
      "UNAVAILABLE"
    );
    expect(empty.sections.find((section) => section.kind === "MEMORY_EVIDENCE")?.state).toBe(
      "EMPTY"
    );
    expect(
      unavailable.sections.find((section) => section.kind === "MEMORY_EVIDENCE")
    ).not.toHaveProperty("summary");
  });
});
