# Phase 1 — P8 Identity, Persona, and Relationship

> **Status: P8-1A IMPLEMENTED; LATER P8 STAGES PLANNED**

## 1. Purpose

Establish a stable answer to “Who is Yuvi?” and a bounded,
evidence-grounded answer to “What is the relationship and background context
here?” This phase creates semantic authority for identity/persona/relationship
interpretation without turning Memory records, prompt sections, or model
self-report into truth.

## 2. Responsibility

P8 owns:

- stable Yuvi identity rules and explicit identity revisions;
- Yuvi-specific persona invariants that ordinary conversation cannot silently
  rewrite;
- interpretation of already-authorized Memory evidence about interaction
  history, communication preferences, relationship context, and background;
- explicit uncertainty, provenance, scope, and conflict in that interpretation;
- a compact P8 projection for the future Character ABI.

P8 does not reduce a relationship to an affinity, trust, intimacy, or mood
score. It may express qualitative, evidence-grounded context only when the
evidence supports it.

## P8-1A implementation boundary

P8-1A establishes only the smallest independent semantic authority for stable
identity and authored persona invariants. It is implemented in the tiny,
dependency-free `@companion/p8` package as plain immutable TypeScript data and
one pure projection constructor. The package has no Runtime, Memory,
PromptBuilder, provider, model, or platform dependency.

The implemented input is an explicitly supplied identity address plus a small
authored invariant set. The address keeps `characterInstanceId`,
`personaProfileId`, and an optional future `subjectScopeId` separate, so a
default instance/profile does not become a singleton assumption. The output is
a compact semantic projection with identity/persona status, authored
invariants, bounded authored provenance references, and a projection version.
It is not serialized into prompt sections.

P8-1A defines the complete epistemic vocabulary `KNOWN`, `UNKNOWN`,
`CONFLICTING`, `PARTIAL`, `EMPTY`, `UNAVAILABLE`, and `ERROR`. Authored-only
projection currently uses `KNOWN` when explicit invariants exist and `EMPTY`
when that target has no authored invariant. The remaining states are retained
for later evidence-backed phases and must not be collapsed: missing evidence,
an unavailable source, and an error are different meanings.

The authored surface is intentionally tiny: stable character name or
description, an explicit identity boundary, and a semantically appropriate
user-controlled invariant. It does not encode learned behavior, wording,
warmth, brevity, jokes, teasing, sentence structure, or other Character Model
style. No relationship conclusion or relationship scalar is implemented.

Only P8-1A semantics are implemented here. Memory-backed evidence
interpretation, recent-conversation projection, correction/revision
persistence, Character ABI integration, and all later P8 stages remain
planned.

## 3. Inputs

- stable, explicitly authored Yuvi identity/persona rules;
- scoped `MemoryEvent` evidence and retrieval status after Memory-owned scope,
  status, time-validity, eligibility, and ranking rules;
- bounded recent conversation supplied separately from long-term Memory;
- explicit user settings, corrections, consent, and identity controls;
- current Runtime truth relevant to the interaction;
- later, temporal context for recency and validity.

Missing, unavailable, contradictory, or unverified evidence remains visible as
such. P8 must not convert “no relevant result” or backend failure into a claim
that no relationship history exists.

## 4. Outputs

- stable identity/persona projection;
- evidence-grounded relationship/background interpretation;
- provenance or source references sufficient for audit without exposing raw
  sensitive content unnecessarily;
- uncertainty, conflict, and “unknown” indications;
- bounded context suitable for Character ABI projection.

The exact storage and wire format are deliberately deferred.

## 5. Authority boundaries

| Candidate owner      | Boundary audit                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime              | Runtime stores, versions, and transports P8 artifacts but cannot decide identity or relationship meaning merely because it owns persistence.                                             |
| Memory               | Memory owns evidence records plus retrieval eligibility, filtering, and ranking; it is not a Persona database and does not promote a relationship-tagged record into relationship truth. |
| **P8**               | Owns stable identity and evidence-grounded persona/relationship interpretation because these meanings require consistency across models and interactions.                                |
| Continuity           | Continuity owns unfinished relevance and recent residue, not stable identity or relationship authority.                                                                                  |
| Character Model      | Expresses P8 context naturally but cannot rewrite P8 by self-report or ordinary generated prose.                                                                                         |
| Cognition Core       | May assist with difficult interpretation, contradiction analysis, or verification, but does not become Yuvi's identity authority.                                                        |
| Character Harness    | Selects authorized P8 projections for ABI inclusion under the context budget; it does not re-rank Memory, invent, persist, or independently reinterpret P8.                              |
| MCP capability layer | May retrieve external evidence under admission; dynamic tools and servers cannot define Yuvi's identity.                                                                                 |
| Presentation         | Renders character behavior; appearance, animation, or voice state does not establish Persona or relationship truth.                                                                      |

This responsibility belongs in P8 because it must remain stable when Runtime
internals, Memory backends, models, providers, MCP servers, and presentation
surfaces change.

## 6. Hard invariants

- P8 is evidence-grounded and provenance-aware.
- Stable identity cannot drift from ordinary conversation or assistant output.
- Model self-report is not Runtime or P8 authority.
- Explicit user correction and control outrank model preference.
- Intimacy, dependency, trust, exclusivity, or relationship status cannot be
  invented without evidence.
- Assistant-only relationship or affect prose cannot create a self-reinforcing
  state loop.
- `empty`, `unavailable`, `error`, and `partial` Memory outcomes remain
  semantically distinct.
- P8 is not a generic mood engine and does not own transient conversational
  attention.
- P8 consumes Memory-authorized evidence and owns only its
  identity/persona/relationship interpretation. It does not reimplement scope,
  status, time-validity, retrieval-eligibility, or rank authority.
- P8 output is bounded and safe for projection; raw Memory/backend DTOs do not
  cross into the model ABI.
- No implementation may weaken existing P4 durability or P6 proactive
  semantics.

## 7. Explicit non-goals

- A persistent `RelationshipState`, `DynamicSelf`, or universal affinity/trust
  score.
- Generic emotional simulation or off-screen relationship evolution.
- Continuity, open-thread tracking, initiative, or idle behavior.
- A class hierarchy, large rules engine, or new generic manager abstraction.
- Training the Character Model.
- Selecting cognition backends, providers, MCP tools, or presentation actions.

## 8. Dependencies

- Structural R closeout is accepted.
- Current Memory evidence/provenance semantics remain intact.
- Current identity scope isolation and explicit user settings remain
  trustworthy.
- The phase can define its semantic output before the Character ABI wire form is
  selected.

Temporal and Continuity phases are downstream. P8 may initially treat recency
conservatively rather than inventing temporal behavior before phase 3.

## 9. Relationship to existing implementation

**CURRENT:** Memory has persona/subject identifiers, relationship categories,
provenance, current-affect detection, and conservative relationship-memory
handling. `PromptBuilder` has syntactic `SystemIdentity`, `CharacterStyle`, and
`RelationshipContext` sections. Memory documentation explicitly says evidence
is not authoritative Relationship, Affect, Persona, Interest, or Commitment
state.

**IMPLEMENTED P8-1A:** P8 now owns only the pure, authored identity/persona
projection described above. Existing prompt fields remain Character/surface
behavior and are not consumed by this package. No existing Memory category is
reclassified as P8 truth.

**PLANNED:** Later P8 stages will interpret already-authorized Memory evidence
and bounded recent conversation without taking Memory retrieval or ranking
authority. Weak evidence must produce only weak interpretation; contradictory,
empty, unavailable, or erroneous evidence must remain explicit.

## Future-stage constraints

- Memory owns evidence, including scope, eligibility, validity, retrieval, and
  ranking. P8 owns grounded identity/persona/relationship meaning only.
- Relationship meaning remains qualitative and evidence-grounded. Weak
  evidence cannot justify a strong interpretation, and no affinity, trust,
  intimacy, relationship-level, mood, or dependency scalar is permitted.
- Recent conversation is a separate bounded input, not long-term Memory and
  not a durable identity fact. P8 is not Continuity and does not own unfinished
  relevance, commitments, residue, or attention.
- P8 is not channel social mode and cannot own QQ/group behavior or platform
  adapters. Future person/group/platform scope must remain possible without
  exposing account identifiers to the model-facing projection.
- Multiple character instances and persona profiles must remain possible;
  current defaults do not establish a global singleton.
- A semantic P8 projection is not `PromptBuilder` output and must not be
  defined by `PromptBuildInput`, `PromptSectionName`, or prompt section text.
  A later Character ABI adapter may consume a compact projection.
- Character post-training may learn expression and preferences, but it cannot
  redefine P8 identity, provenance, uncertainty, or correction semantics.
- Corrections and revisions are first-class future P8 capabilities. Derived
  artifacts must remain reconstructable from explicit source inputs and bounded
  provenance rather than becoming opaque new authority.
- Provenance should be sufficient for audit while minimizing private content;
  raw Memory records, database identifiers, provider/backend details, and
  platform account IDs must not cross into Character-facing semantics.

## 10. Likely staged implementation shape

1. **Implemented in P8-1A:** Freeze the concise authored identity/persona
   invariant representation and minimum projection vocabulary.
2. P8-1B: Define minimum evidence interpretation/projection meanings,
   including unknown/conflict.
3. P8-1C: Produce the projection from explicit rules plus Memory-authorized evidence
   and recent conversation.
4. P8-1D/E: Add correction/revision, audit, persistence, and reconstruction
   behavior using Runtime-owned persistence.
5. P8-1F: Validate multi-session stability, scope isolation, privacy, outage,
   and backend replacement.

Each stage should add the smallest semantic unit and tests needed. Do not build
a generic relationship framework in anticipation of hypothetical consumers.

## 11. Acceptance concept

P8 is acceptable when the same grounded identity and relationship context can
be reconstructed across Runtime/model replacement; contradictory or
unavailable evidence remains explicit; ordinary assistant prose cannot mutate
identity; user corrections take effect predictably; and no ungrounded
relationship state appears in Character context.

Acceptance should include adversarial cases for false familiarity, invented
intimacy, stale evidence, scope leakage, assistant-derived feedback loops,
backend outage, and explicit user correction.

## 12. Risks

- Conflating a Memory category with semantic authority.
- Freezing too much personality as rules and making Yuvi mechanical.
- Allowing a model-generated summary to lose provenance or amplify certainty.
- Encoding relationship growth as a scalar that invites optimization and
  manipulation.
- Letting P8 absorb short-term affect, attention, or Continuity.
- Persisting sensitive interpretation without adequate user visibility and
  correction.

## 13. Open questions

- Which identity/persona elements require explicit user-visible editing?
- Which relationship interpretations may persist as derived artifacts, and
  which should be reconstructed on demand?
- How should conflicting evidence be presented without exposing unnecessary
  private detail?
- What minimum provenance is required in the Character ABI versus diagnostics?
- When should Cognition Core assist complex social interpretation?
- What revision and migration policy preserves meaning when the P8 projection
  evolves?

## 14. Handoff boundary to the next phase

Phase 1 hands phase 2 a semantic P8 projection with defined meaning,
provenance/uncertainty behavior, and explicit non-authorities. Phase 2 may place
that projection in the Character ABI. It may not redesign P8 semantics, expose
P8 storage records directly to the model, or freeze detailed TypeScript types
prematurely.
