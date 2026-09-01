import type { CorrelatedEmbodiedBehavior } from "@companion/protocol";

export const COMPANION_EMBODIED_BEHAVIOR_DIAGNOSTIC_LIMIT = 200;

export type CompanionEmbodiedBehaviorDiagnosticEntry = Readonly<{
  atMs: number;
  classification: "semantic";
  projection: CorrelatedEmbodiedBehavior;
}>;

/**
 * Append one already-canonical 7B shadow observation to a bounded diagnostics
 * ledger. The entry is diagnostic data only: it does not allocate Runtime
 * identity, publish lifecycle truth, or perform presentation/device work.
 */
export function appendCompanionEmbodiedBehaviorDiagnostic(
  ledger: CompanionEmbodiedBehaviorDiagnosticEntry[],
  projection: CorrelatedEmbodiedBehavior,
  atMs: number
): void {
  ledger.push(
    Object.freeze({
      atMs,
      classification: "semantic" as const,
      projection
    })
  );

  if (ledger.length > COMPANION_EMBODIED_BEHAVIOR_DIAGNOSTIC_LIMIT) {
    ledger.splice(0, ledger.length - COMPANION_EMBODIED_BEHAVIOR_DIAGNOSTIC_LIMIT);
  }
}

/**
 * Production observer for the Phase-7 shadow. It is deliberately DEV-only and
 * bounded, matching the companion speech-ledger convention. Idle fallback is
 * not promoted into this ledger; every entry is an observed canonical semantic
 * behavior.
 */
export function recordCompanionEmbodiedBehaviorDiagnostic(
  projection: CorrelatedEmbodiedBehavior
): void {
  if (!import.meta.env.DEV || typeof window === "undefined") return;

  const debugWindow = window as typeof window & {
    __yuviEmbodiedBehaviorLedger?: CompanionEmbodiedBehaviorDiagnosticEntry[];
  };
  const ledger = (debugWindow.__yuviEmbodiedBehaviorLedger ??= []);
  appendCompanionEmbodiedBehaviorDiagnostic(ledger, projection, performance.now());
}
