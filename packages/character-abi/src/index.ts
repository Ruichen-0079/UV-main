export const CHARACTER_ABI_2A_VERSION = "character-abi-2a.v1" as const;
export const NORMALIZED_COGNITION_RESULT_VERSION = "character-cognition-result.v1" as const;

export const CHARACTER_ABI_EPISTEMIC_STATES = [
  "KNOWN",
  "UNKNOWN",
  "CONFLICTING",
  "PARTIAL",
  "EMPTY",
  "UNAVAILABLE",
  "ERROR"
] as const;
export type CharacterAbiEpistemicState = (typeof CHARACTER_ABI_EPISTEMIC_STATES)[number];

export const CHARACTER_ABI_SECTION_KINDS = [
  "IDENTITY",
  "PERSONA",
  "RELATIONSHIP_CONTEXT",
  "RECENT_CONVERSATION",
  "MEMORY_EVIDENCE",
  "TEMPORAL_CONTEXT",
  "CONTINUITY",
  "ATTENTION_ANCHORS",
  "CURRENT_SITUATION",
  "COGNITION_RESULT"
] as const;
export type CharacterAbiSectionKind = (typeof CHARACTER_ABI_SECTION_KINDS)[number];

/**
 * Semantic section envelope only. This is not a prompt block, provider DTO, or
 * Runtime schema. Upstream owners remain responsible for producing the meaning.
 */
export type CharacterAbiSemanticSection = Readonly<{
  kind: CharacterAbiSectionKind;
  state: CharacterAbiEpistemicState;
  /** Compact authorized meaning. Missing/unknown states must not invent one. */
  summary?: string;
  /** Opaque audit references only; never raw provider/database objects. */
  provenanceReferences?: readonly string[];
}>;

export type CharacterAbiContext = Readonly<{
  abiVersion: typeof CHARACTER_ABI_2A_VERSION;
  sections: readonly CharacterAbiSemanticSection[];
}>;

export const CHARACTER_DISPOSITIONS = [
  "RESPOND",
  "SILENCE",
  "TERMINATE",
  "NEED_COGNITION"
] as const;
export type CharacterDisposition = (typeof CHARACTER_DISPOSITIONS)[number];

export type CharacterPresentationIntent = Readonly<{
  /** Semantic presentation request only; Runtime still owns admission/execution. */
  intent: string;
}>;

export type CharacterProposal = Readonly<
  | {
      disposition: "RESPOND";
      text: string;
      presentation?: CharacterPresentationIntent;
    }
  | {
      disposition: "SILENCE";
    }
  | {
      disposition: "TERMINATE";
    }
  | {
      disposition: "NEED_COGNITION";
      /** Optional coarse subject of escalation; never a tool/capability request. */
      focus?: string;
    }
>;

export const CHARACTER_ADDRESSING_STATES = [
  "DIRECTED_TO_YUVI",
  "NOT_DIRECTED",
  "AMBIGUOUS"
] as const;
export type CharacterAddressingState = (typeof CHARACTER_ADDRESSING_STATES)[number];

export const CHARACTER_PROACTIVE_PROPOSAL_ACTIONS = ["KEEP", "CLEAR", "DEFER", "SUPPRESS"] as const;
export type CharacterProactiveProposalAction =
  (typeof CHARACTER_PROACTIVE_PROPOSAL_ACTIONS)[number];

export const CHARACTER_PROACTIVE_DEFERRAL_HORIZONS = ["SHORT", "NORMAL", "LONG"] as const;
export type CharacterProactiveDeferralHorizon =
  (typeof CHARACTER_PROACTIVE_DEFERRAL_HORIZONS)[number];

export const CHARACTER_PROACTIVE_SUPPRESSION_SCOPES = [
  "UNTIL",
  "UNTIL_ENGAGEMENT",
  "UNTIL_EXPLICIT_RESUME"
] as const;
export type CharacterProactiveSuppressionScopeKind =
  (typeof CHARACTER_PROACTIVE_SUPPRESSION_SCOPES)[number];

export type CharacterProactiveSuppressionScope = Readonly<
  | {
      kind: "UNTIL";
      /** Absolute ISO-8601 instant, when the input anchors suppression to a clock time. */
      time?: string;
      /** Bounded ISO-8601 duration, when the input states a relative window. */
      duration?: string;
    }
  | { kind: "UNTIL_ENGAGEMENT" }
  | { kind: "UNTIL_EXPLICIT_RESUME" }
>;

export type CharacterProactiveProposal = Readonly<
  | { action: "KEEP" }
  | { action: "CLEAR" }
  | { action: "DEFER"; horizon: CharacterProactiveDeferralHorizon }
  | { action: "SUPPRESS"; scope: CharacterProactiveSuppressionScope }
>;

/**
 * vNext stable Character result. Three orthogonal semantics:
 *
 * - `addressing`: whether the current input appears directed to YUVI;
 * - `reply`: the preserved RESPOND/SILENCE/TERMINATE/NEED_COGNITION disposition;
 * - `proactive`: a semantic proposal about future proactive initiation.
 *
 * This is a proposal only. Runtime authorization and proactive state
 * application stay outside the Character contract. No field here is an
 * authorization result, provider/tool identity, or Runtime lifecycle value.
 */
export type CharacterDecision = Readonly<{
  addressing: CharacterAddressingState;
  reply: CharacterProposal;
  proactive: CharacterProactiveProposal;
}>;

export const NORMALIZED_COGNITION_STATUSES = [
  "SUCCESS",
  "PARTIAL",
  "UNAVAILABLE",
  "CANCELLED",
  "UNSAFE_TO_ANSWER",
  "ERROR"
] as const;
export type NormalizedCognitionStatus = (typeof NORMALIZED_COGNITION_STATUSES)[number];

export type NormalizedCognitionEvidence = Readonly<{
  reference: string;
  statement: string;
}>;

/**
 * Model-facing normalized cognition meaning. Phase 6 is the sole producer;
 * Character ABI/Harness may validate and consume it but never normalize raw
 * backend output into this shape.
 */
export type NormalizedCognitionResult = Readonly<{
  version: typeof NORMALIZED_COGNITION_RESULT_VERSION;
  status: NormalizedCognitionStatus;
  answer?: string;
  keyFacts?: readonly string[];
  evidence?: readonly NormalizedCognitionEvidence[];
  uncertainty?: readonly string[];
  caveats?: readonly string[];
}>;

type UnknownObject = Record<string, unknown> & {
  abiVersion?: unknown;
  sections?: unknown;
  disposition?: unknown;
  text?: unknown;
  presentation?: unknown;
  focus?: unknown;
  addressing?: unknown;
  reply?: unknown;
  proactive?: unknown;
  action?: unknown;
  horizon?: unknown;
  scope?: unknown;
  time?: unknown;
  duration?: unknown;
  version?: unknown;
  status?: unknown;
  answer?: unknown;
  keyFacts?: unknown;
  evidence?: unknown;
  uncertainty?: unknown;
  caveats?: unknown;
  kind?: unknown;
  state?: unknown;
  summary?: unknown;
  provenanceReferences?: unknown;
  intent?: unknown;
  reference?: unknown;
  statement?: unknown;
};

export function createCharacterAbiContext(input: unknown): CharacterAbiContext {
  const value = expectObject(input, "Character ABI context");
  assertAllowedKeys(value, ["abiVersion", "sections"], "Character ABI context");
  if (value.abiVersion !== CHARACTER_ABI_2A_VERSION) {
    throw new Error(`Character ABI version must be ${CHARACTER_ABI_2A_VERSION}.`);
  }
  if (!Array.isArray(value.sections)) {
    throw new Error("Character ABI sections must be an array.");
  }

  const seenKinds = new Set<CharacterAbiSectionKind>();
  const sections = value.sections.map((section, index) => {
    const normalized = normalizeSection(section, index);
    if (seenKinds.has(normalized.kind)) {
      throw new Error(`Character ABI section kind must be unique: ${normalized.kind}.`);
    }
    seenKinds.add(normalized.kind);
    return normalized;
  });

  return Object.freeze({
    abiVersion: CHARACTER_ABI_2A_VERSION,
    sections: Object.freeze(sections)
  });
}

export function createCharacterProposal(input: unknown): CharacterProposal {
  const value = expectObject(input, "Character proposal");
  const disposition = value.disposition;
  if (!isOneOf(disposition, CHARACTER_DISPOSITIONS)) {
    throw new Error("Character proposal disposition is invalid.");
  }

  switch (disposition) {
    case "RESPOND": {
      assertAllowedKeys(value, ["disposition", "text", "presentation"], "RESPOND proposal");
      const text = boundedText(value.text, "Character response text", 8000);
      const presentation =
        value.presentation === undefined ? undefined : normalizePresentation(value.presentation);
      return Object.freeze({
        disposition,
        text,
        ...(presentation === undefined ? {} : { presentation })
      });
    }
    case "SILENCE":
    case "TERMINATE":
      assertAllowedKeys(value, ["disposition"], `${disposition} proposal`);
      return Object.freeze({ disposition });
    case "NEED_COGNITION": {
      assertAllowedKeys(value, ["disposition", "focus"], "NEED_COGNITION proposal");
      const focus =
        value.focus === undefined ? undefined : boundedText(value.focus, "cognition focus", 500);
      return Object.freeze({
        disposition,
        ...(focus === undefined ? {} : { focus })
      });
    }
  }
}

/**
 * Validate one semantic proactive-policy proposal. This is meaning only: it
 * never carries an authorization result, principal, or Runtime state, and it
 * does not mutate anything. Runtime owns authorization and application.
 */
export function createCharacterProactiveProposal(input: unknown): CharacterProactiveProposal {
  const value = expectObject(input, "Character proactive proposal");
  const action = value.action;
  if (!isOneOf(action, CHARACTER_PROACTIVE_PROPOSAL_ACTIONS)) {
    throw new Error("Character proactive proposal action is invalid.");
  }

  switch (action) {
    case "KEEP":
    case "CLEAR":
      assertAllowedKeys(value, ["action"], `${action} proactive proposal`);
      return Object.freeze({ action });
    case "DEFER": {
      assertAllowedKeys(value, ["action", "horizon"], "DEFER proactive proposal");
      const horizon = value.horizon;
      if (!isOneOf(horizon, CHARACTER_PROACTIVE_DEFERRAL_HORIZONS)) {
        throw new Error("Character proactive deferral horizon is invalid.");
      }
      return Object.freeze({ action, horizon });
    }
    case "SUPPRESS": {
      assertAllowedKeys(value, ["action", "scope"], "SUPPRESS proactive proposal");
      return Object.freeze({
        action,
        scope: createCharacterProactiveSuppressionScope(value.scope)
      });
    }
  }
}

/**
 * Validate the vNext stable Character result. `reply` reuses the existing
 * Character proposal contract, so the four dispositions stay first-class and
 * no parallel response vocabulary is introduced. All three semantics are
 * required: a decision always states addressing and proactive meaning instead
 * of collapsing an absent field into a default.
 */
export function createCharacterDecision(input: unknown): CharacterDecision {
  const value = expectObject(input, "Character decision");
  assertAllowedKeys(value, ["addressing", "reply", "proactive"], "Character decision");
  const addressing = value.addressing;
  if (!isOneOf(addressing, CHARACTER_ADDRESSING_STATES)) {
    throw new Error("Character decision addressing is invalid.");
  }
  return Object.freeze({
    addressing,
    reply: createCharacterProposal(value.reply),
    proactive: createCharacterProactiveProposal(value.proactive)
  });
}

export function createNormalizedCognitionResult(input: unknown): NormalizedCognitionResult {
  const value = expectObject(input, "Normalized Cognition Result");
  assertAllowedKeys(
    value,
    ["version", "status", "answer", "keyFacts", "evidence", "uncertainty", "caveats"],
    "Normalized Cognition Result"
  );
  if (value.version !== NORMALIZED_COGNITION_RESULT_VERSION) {
    throw new Error(
      `Normalized Cognition Result version must be ${NORMALIZED_COGNITION_RESULT_VERSION}.`
    );
  }
  if (!isOneOf(value.status, NORMALIZED_COGNITION_STATUSES)) {
    throw new Error("Normalized Cognition Result status is invalid.");
  }

  const answer =
    value.answer === undefined ? undefined : boundedText(value.answer, "cognition answer", 16000);
  if (value.status === "SUCCESS" && answer === undefined) {
    throw new Error("Successful Normalized Cognition Result requires a non-empty answer.");
  }

  const keyFacts = normalizeStringList(value.keyFacts, "keyFacts", 32, 1000);
  const evidence = normalizeEvidence(value.evidence);
  const uncertainty = normalizeStringList(value.uncertainty, "uncertainty", 16, 1000);
  const caveats = normalizeStringList(value.caveats, "caveats", 16, 1000);

  return Object.freeze({
    version: NORMALIZED_COGNITION_RESULT_VERSION,
    status: value.status,
    ...(answer === undefined ? {} : { answer }),
    ...(keyFacts === undefined ? {} : { keyFacts }),
    ...(evidence === undefined ? {} : { evidence }),
    ...(uncertainty === undefined ? {} : { uncertainty }),
    ...(caveats === undefined ? {} : { caveats })
  });
}

function normalizeSection(input: unknown, index: number): CharacterAbiSemanticSection {
  const value = expectObject(input, `Character ABI section ${index}`);
  assertAllowedKeys(
    value,
    ["kind", "state", "summary", "provenanceReferences"],
    `Character ABI section ${index}`
  );
  if (!isOneOf(value.kind, CHARACTER_ABI_SECTION_KINDS)) {
    throw new Error(`Character ABI section ${index} kind is invalid.`);
  }
  if (!isOneOf(value.state, CHARACTER_ABI_EPISTEMIC_STATES)) {
    throw new Error(`Character ABI section ${index} state is invalid.`);
  }

  const summary =
    value.summary === undefined
      ? undefined
      : boundedText(value.summary, `Character ABI section ${index} summary`, 4000);
  if (value.state === "KNOWN" && summary === undefined) {
    throw new Error(`Character ABI KNOWN section ${value.kind} requires a summary.`);
  }
  if (
    summary !== undefined &&
    (value.state === "UNKNOWN" ||
      value.state === "EMPTY" ||
      value.state === "UNAVAILABLE" ||
      value.state === "ERROR")
  ) {
    throw new Error(`Character ABI ${value.state} section ${value.kind} cannot invent a summary.`);
  }

  const provenanceReferences = normalizeStringList(
    value.provenanceReferences,
    `section ${value.kind} provenanceReferences`,
    32,
    200
  );

  return Object.freeze({
    kind: value.kind,
    state: value.state,
    ...(summary === undefined ? {} : { summary }),
    ...(provenanceReferences === undefined ? {} : { provenanceReferences })
  });
}

function normalizePresentation(input: unknown): CharacterPresentationIntent {
  const value = expectObject(input, "Character presentation intent");
  assertAllowedKeys(value, ["intent"], "Character presentation intent");
  return Object.freeze({
    intent: boundedText(value.intent, "presentation intent", 200)
  });
}

function createCharacterProactiveSuppressionScope(
  input: unknown
): CharacterProactiveSuppressionScope {
  const value = expectObject(input, "Character proactive suppression scope");
  const kind = value.kind;
  if (!isOneOf(kind, CHARACTER_PROACTIVE_SUPPRESSION_SCOPES)) {
    throw new Error("Character proactive suppression scope kind is invalid.");
  }

  switch (kind) {
    case "UNTIL": {
      assertAllowedKeys(value, ["kind", "time", "duration"], "UNTIL suppression scope");
      const hasTime = value.time !== undefined;
      const hasDuration = value.duration !== undefined;
      if (hasTime === hasDuration) {
        throw new Error("UNTIL suppression scope requires exactly one of time or duration.");
      }
      if (hasTime) {
        return Object.freeze({
          kind,
          time: iso8601Instant(value.time, "suppression time")
        });
      }
      return Object.freeze({
        kind,
        duration: iso8601Duration(value.duration, "suppression duration")
      });
    }
    case "UNTIL_ENGAGEMENT":
    case "UNTIL_EXPLICIT_RESUME":
      assertAllowedKeys(value, ["kind"], `${kind} suppression scope`);
      return Object.freeze({ kind });
  }
}

function normalizeEvidence(input: unknown): readonly NormalizedCognitionEvidence[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!Array.isArray(input) || input.length > 32) {
    throw new Error("Normalized Cognition Result evidence must be an array of at most 32 items.");
  }
  return Object.freeze(
    input.map((item, index) => {
      const value = expectObject(item, `cognition evidence ${index}`);
      assertAllowedKeys(value, ["reference", "statement"], `cognition evidence ${index}`);
      return Object.freeze({
        reference: boundedText(value.reference, `cognition evidence ${index} reference`, 200),
        statement: boundedText(value.statement, `cognition evidence ${index} statement`, 2000)
      });
    })
  );
}

function normalizeStringList(
  input: unknown,
  field: string,
  maximumItems: number,
  maximumCharacters: number
): readonly string[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!Array.isArray(input) || input.length > maximumItems) {
    throw new Error(`${field} must be an array of at most ${maximumItems} items.`);
  }
  return Object.freeze(
    input.map((item, index) => boundedText(item, `${field}[${index}]`, maximumCharacters))
  );
}

function boundedText(input: unknown, field: string, maximum: number): string {
  if (typeof input !== "string" || input.length === 0 || input.length > maximum) {
    throw new Error(`${field} must be a non-empty string of at most ${maximum} characters.`);
  }
  return input;
}

function expectObject(input: unknown, field: string): UnknownObject {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${field} must be an object.`);
  }
  return input as UnknownObject;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  field: string
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${field} contains unknown field: ${unknown.sort().join(", ")}.`);
  }
}

function isOneOf<T extends string>(input: unknown, values: readonly T[]): input is T {
  return typeof input === "string" && (values as readonly string[]).includes(input);
}

const ISO_8601_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ISO_8601_DURATION_PATTERN =
  /^P(?!$)(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?!$)(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/;

function iso8601Instant(input: unknown, field: string): string {
  const text = boundedText(input, field, 64);
  if (!ISO_8601_INSTANT_PATTERN.test(text)) {
    throw new Error(`${field} must be an ISO-8601 instant with UTC or numeric offset.`);
  }
  return text;
}

function iso8601Duration(input: unknown, field: string): string {
  const text = boundedText(input, field, 64);
  if (!ISO_8601_DURATION_PATTERN.test(text)) {
    throw new Error(`${field} must be an ISO-8601 duration.`);
  }
  return text;
}
