import { P8_PROJECTION_VERSION } from "./versions.js";

export { P8_PROJECTION_VERSION } from "./versions.js";

export const DEFAULT_CHARACTER_INSTANCE_ID = "yuvi-default-character-instance" as const;
export const DEFAULT_PERSONA_PROFILE_ID = "yuvi-default-persona-profile" as const;

export const P8_EPISTEMIC_STATES = [
  "KNOWN",
  "UNKNOWN",
  "CONFLICTING",
  "PARTIAL",
  "EMPTY",
  "UNAVAILABLE",
  "ERROR"
] as const;

export type P8EpistemicState = (typeof P8_EPISTEMIC_STATES)[number];

export type P8IdentityAddress = Readonly<{
  characterInstanceId: string;
  personaProfileId: string;
  subjectScopeId?: string;
}>;

export type P8ProvenanceReference = Readonly<{
  source: "authored";
  reference: string;
  revision?: string;
}>;

export type P8AuthoredInvariant = Readonly<{
  key: string;
  target: "identity" | "persona";
  statement: string;
  provenance: P8ProvenanceReference;
}>;

export type P8ProjectedInvariant = P8AuthoredInvariant;

export type P8ProjectionInput = Readonly<{
  address: P8IdentityAddress;
  authoredInvariants: readonly P8AuthoredInvariant[];
}>;

export type P8IdentityProjection = Readonly<{
  status: P8EpistemicState;
  invariants: readonly P8ProjectedInvariant[];
}>;

export type P8PersonaProjection = Readonly<{
  status: P8EpistemicState;
  invariants: readonly P8ProjectedInvariant[];
}>;

export type P8Projection = Readonly<{
  projectionVersion: typeof P8_PROJECTION_VERSION;
  address: P8IdentityAddress;
  identity: P8IdentityProjection;
  persona: P8PersonaProjection;
  provenance: readonly P8ProvenanceReference[];
}>;

const DEFAULT_AUTHORED_INVARIANT = Object.freeze({
  key: "character.name",
  target: "identity",
  statement: "Yuvi",
  provenance: Object.freeze({
    source: "authored",
    reference: "p8-1a/default/character-name",
    revision: "p8-1a"
  })
} as const satisfies P8AuthoredInvariant);

export const DEFAULT_AUTHORED_INVARIANTS: readonly P8AuthoredInvariant[] = Object.freeze([
  Object.freeze(DEFAULT_AUTHORED_INVARIANT)
]);

export * from "./evidence.js";
export * from "./adapter.js";
export * from "./correction.js";
export * from "./persistence.js";
export * from "./reconstruction.js";
export * from "./profile.js";

export function createDefaultP8IdentityAddress(subjectScopeId?: string): P8IdentityAddress {
  return freezeAddress({
    characterInstanceId: DEFAULT_CHARACTER_INSTANCE_ID,
    personaProfileId: DEFAULT_PERSONA_PROFILE_ID,
    ...(subjectScopeId === undefined ? {} : { subjectScopeId })
  });
}

export function createP8Projection(input: P8ProjectionInput): P8Projection {
  const address = freezeAddress(input.address);
  const authoredInvariants = input.authoredInvariants
    .map((invariant) => freezeInvariant(invariant))
    .sort(compareInvariants);
  const identityInvariants = authoredInvariants.filter(
    (invariant) => invariant.target === "identity"
  );
  const personaInvariants = authoredInvariants.filter(
    (invariant) => invariant.target === "persona"
  );

  const provenance = Array.from(
    new Map(
      authoredInvariants.map((invariant) => [
        provenanceKey(invariant.provenance),
        invariant.provenance
      ])
    ).values()
  ).sort(compareProvenance);

  return Object.freeze({
    projectionVersion: P8_PROJECTION_VERSION,
    address,
    identity: Object.freeze({
      status: statusFor(identityInvariants),
      invariants: Object.freeze(identityInvariants)
    }),
    persona: Object.freeze({
      status: statusFor(personaInvariants),
      invariants: Object.freeze(personaInvariants)
    }),
    provenance: Object.freeze(provenance)
  });
}

function statusFor(invariants: readonly P8AuthoredInvariant[]): P8EpistemicState {
  return invariants.length > 0 ? "KNOWN" : "UNKNOWN";
}

function freezeAddress(address: P8IdentityAddress): P8IdentityAddress {
  validateBoundedText(address.characterInstanceId, "characterInstanceId");
  validateBoundedText(address.personaProfileId, "personaProfileId");
  if (address.subjectScopeId !== undefined) {
    validateBoundedText(address.subjectScopeId, "subjectScopeId");
  }

  return Object.freeze({
    characterInstanceId: address.characterInstanceId,
    personaProfileId: address.personaProfileId,
    ...(address.subjectScopeId === undefined ? {} : { subjectScopeId: address.subjectScopeId })
  });
}

function freezeInvariant(invariant: P8AuthoredInvariant): P8ProjectedInvariant {
  validateBoundedText(invariant.key, "invariant.key");
  validateBoundedText(invariant.statement, "invariant.statement", 500);
  if (invariant.target !== "identity" && invariant.target !== "persona") {
    throw new Error("P8 invariant target must be identity or persona.");
  }

  const provenance = invariant.provenance;
  if (provenance.source !== "authored") {
    throw new Error("P8-1A only accepts authored provenance.");
  }
  validateBoundedText(provenance.reference, "provenance.reference", 160);
  if (provenance.revision !== undefined) {
    validateBoundedText(provenance.revision, "provenance.revision", 80);
  }

  return Object.freeze({
    key: invariant.key,
    target: invariant.target,
    statement: invariant.statement,
    provenance: Object.freeze({
      source: "authored",
      reference: provenance.reference,
      ...(provenance.revision === undefined ? {} : { revision: provenance.revision })
    })
  });
}

function compareInvariants(left: P8ProjectedInvariant, right: P8ProjectedInvariant): number {
  return invariantKey(left).localeCompare(invariantKey(right));
}

function compareProvenance(left: P8ProvenanceReference, right: P8ProvenanceReference): number {
  return provenanceKey(left).localeCompare(provenanceKey(right));
}

function invariantKey(invariant: P8ProjectedInvariant): string {
  return [
    invariant.target,
    invariant.key,
    invariant.statement,
    provenanceKey(invariant.provenance)
  ].join("\u0000");
}

function provenanceKey(provenance: P8ProvenanceReference): string {
  return [provenance.source, provenance.reference, provenance.revision ?? ""].join("\u0000");
}

function validateBoundedText(value: string, field: string, maximum = 120): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`P8 ${field} must be a non-empty string of at most ${maximum} characters.`);
  }
}
