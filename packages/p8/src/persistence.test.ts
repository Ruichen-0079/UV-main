import { describe, expect, it } from "vitest";
import {
  P8_1E_VERSION,
  createP8CorrectionRecord,
  correctionFromP8CorrectionRecord,
  parseP8CorrectionRecord,
  serializeP8CorrectionRecord,
  type P8CorrectionTarget,
  type P8ExplicitCorrection
} from "./index.js";

const ADDRESS = {
  characterInstanceId: "character-a",
  personaProfileId: "profile-a",
  subjectScopeId: "subject-a"
} as const;
const SCOPE = { reference: "scope-a" } as const;

function correction(
  overrides: {
    correctionReference?: string;
    target?: P8CorrectionTarget;
    action?: "REVISE" | "RETRACT";
    replacementMeaning?: string;
    supersededEvidenceReferences?: readonly string[];
    supersedesCorrectionReference?: string;
    provenanceReference?: string;
    suppliedAt?: string;
  } = {}
): P8ExplicitCorrection {
  const action = overrides.action ?? "REVISE";
  return {
    correctionReference: overrides.correctionReference ?? "correction-a",
    address: ADDRESS,
    scopeReference: SCOPE,
    target:
      overrides.target ??
      ({ kind: "INTERPRETATION", interpretationReference: "interpretation-a" } as const),
    action,
    ...(action === "REVISE"
      ? { replacementMeaning: overrides.replacementMeaning ?? "Meaning two." }
      : {}),
    provenance: {
      source: "EXPLICIT_USER_CORRECTION",
      reference: overrides.provenanceReference ?? "source-a",
      ...(overrides.suppliedAt === undefined ? {} : { suppliedAt: overrides.suppliedAt })
    },
    ...(overrides.supersededEvidenceReferences === undefined
      ? {}
      : { supersededEvidenceReferences: overrides.supersededEvidenceReferences }),
    ...(overrides.supersedesCorrectionReference === undefined
      ? {}
      : { supersedesCorrectionReference: overrides.supersedesCorrectionReference })
  };
}

describe("P8-1E durable correction records", () => {
  it("round-trips the authoritative correction input without derived projection fields", () => {
    const record = createP8CorrectionRecord(
      correction({
        suppliedAt: "2026-08-30T00:00:00.000Z",
        supersededEvidenceReferences: ["memory-b", "memory-a"],
        supersedesCorrectionReference: "correction-previous"
      })
    );

    expect(record.recordVersion).toBe(P8_1E_VERSION);
    expect(record.supersededEvidenceReferences).toEqual(["memory-a", "memory-b"]);
    expect(record).not.toHaveProperty("status");
    expect(record).not.toHaveProperty("meaning");
    expect(record).not.toHaveProperty("storedAt");

    const parsed = parseP8CorrectionRecord(JSON.parse(serializeP8CorrectionRecord(record)));
    expect(parsed).toEqual(record);
    expect(correctionFromP8CorrectionRecord(parsed)).toEqual(
      expect.objectContaining({
        correctionReference: "correction-a",
        replacementMeaning: "Meaning two.",
        supersedesCorrectionReference: "correction-previous"
      })
    );
  });

  it("canonicalizes semantically equivalent reference order identically", () => {
    const first = createP8CorrectionRecord(
      correction({ supersededEvidenceReferences: ["memory-b", "memory-a", "memory-a"] })
    );
    const second = createP8CorrectionRecord(
      correction({ supersededEvidenceReferences: ["memory-a", "memory-b"] })
    );

    expect(serializeP8CorrectionRecord(first)).toBe(serializeP8CorrectionRecord(second));
  });

  it("preserves RETRACT without a replacement meaning", () => {
    const record = createP8CorrectionRecord(
      correction({ action: "RETRACT", supersededEvidenceReferences: ["memory-a"] })
    );

    expect(record.action).toBe("RETRACT");
    expect(record).not.toHaveProperty("replacementMeaning");
    expect(correctionFromP8CorrectionRecord(parseP8CorrectionRecord(record))).not.toHaveProperty(
      "replacementMeaning"
    );
  });

  it("round-trips an authored-invariant target without persisting revision policy metadata", () => {
    const record = createP8CorrectionRecord(
      correction({
        target: {
          kind: "AUTHORED_INVARIANT",
          invariantTarget: "persona",
          invariantKey: "persona.user-boundary"
        }
      })
    );

    expect(record.target).toEqual({
      kind: "AUTHORED_INVARIANT",
      invariantTarget: "persona",
      invariantKey: "persona.user-boundary"
    });
    expect(record).not.toHaveProperty("policy");
    expect(correctionFromP8CorrectionRecord(parseP8CorrectionRecord(record))).toMatchObject({
      target: record.target
    });
  });

  it("rejects unknown versions and malformed stored authority", () => {
    const record = createP8CorrectionRecord(correction());
    const unknownVersion = {
      ...record,
      recordVersion: "p8-1e.v2"
    };
    expect(() => parseP8CorrectionRecord(unknownVersion)).toThrow(
      "Unknown P8 correction record version"
    );

    expect(() =>
      parseP8CorrectionRecord({
        ...record,
        provenance: { ...record.provenance, source: "SYSTEM_INFERRED" }
      })
    ).toThrow("explicit user authority");

    expect(() =>
      parseP8CorrectionRecord({
        ...record,
        action: "RETRACT",
        replacementMeaning: "malformed"
      })
    ).toThrow("cannot supply a replacement meaning");

    expect(() => parseP8CorrectionRecord({ ...record, unexpected: true })).toThrow("unknown field");
  });
});
