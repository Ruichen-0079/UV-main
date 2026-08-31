import {
  CHARACTER_ABI_2A_VERSION,
  createCharacterAbiContext,
  type CharacterAbiContext,
  type CharacterAbiEpistemicState
} from "./index.js";

export const MEMORY_VNEXT_CHARACTER_ABI_PROJECTION_VERSION =
  "character-abi-memory-vnext.v1" as const;

export type MemoryVNextAbiSectionInput = {
  state: CharacterAbiEpistemicState;
  summary?: string | undefined;
  provenanceReferences?: readonly string[] | undefined;
};

export type MemoryVNextAbiProjectionInput = {
  recentConversation: MemoryVNextAbiSectionInput;
  memoryEvidence: MemoryVNextAbiSectionInput;
  temporalContext: MemoryVNextAbiSectionInput;
};

/**
 * One-way Memory vNext -> Character ABI projection.
 *
 * Occupies only Memory/conversation/time ABI slots. It never writes IDENTITY,
 * PERSONA, RELATIONSHIP_CONTEXT, CONTINUITY, or COGNITION_RESULT.
 */
export function projectMemoryVNextToCharacterAbi(
  input: MemoryVNextAbiProjectionInput
): CharacterAbiContext {
  return createCharacterAbiContext({
    abiVersion: CHARACTER_ABI_2A_VERSION,
    sections: [
      section("RECENT_CONVERSATION", input.recentConversation),
      section("MEMORY_EVIDENCE", input.memoryEvidence),
      section("TEMPORAL_CONTEXT", input.temporalContext)
    ]
  });
}

function section(
  kind: "RECENT_CONVERSATION" | "MEMORY_EVIDENCE" | "TEMPORAL_CONTEXT",
  input: MemoryVNextAbiSectionInput
) {
  return {
    kind,
    state: input.state,
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    ...(input.provenanceReferences ? { provenanceReferences: [...input.provenanceReferences] } : {})
  };
}
