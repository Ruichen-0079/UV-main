import { admitDurableMemoryClaim, buildMemoryScope, serializeClaimMetadata } from "@companion/memory";
import type { AppContext } from "../context.js";
import type { Person } from "./product-store.js";
/** Explicit controller input enters the same claim/P8 evidence contracts as other identity evidence. */
export async function persistProfileEvidence(context: AppContext, person: Person): Promise<"STORED" | "UNAVAILABLE" | "APPLY_FAILED"> {
  const provider = context.memory.getMemoryProvider?.();
  if (!provider) return "UNAVAILABLE";
  const admission = admitDurableMemoryClaim({ content: `${person.displayName}. ${person.notes}`.trim(), provenanceClass: "EXTERNAL_CLAIM", assertor: { entityId: "local-explicit-controller", resolution: "resolved" }, subject: { entityId: person.id, surfaceMention: person.displayName, resolution: "resolved" } });
  if (admission.decision !== "admit") return "APPLY_FAILED";
  try {
    const result = await provider.writeEvent({ kind: "user_claim", scope: buildMemoryScope(person.id, person.personaId), content: admission.content, assertion: admission.assertion, claim: admission.claim, metadata: serializeClaimMetadata(admission.claim) });
    return result.status !== "rejected" && (result.eventId || result.event?.id) ? "STORED" : "APPLY_FAILED";
  } catch { return "APPLY_FAILED"; }
}
