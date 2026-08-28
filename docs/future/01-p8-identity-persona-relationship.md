# Phase 1 — P8 Identity, Persona, and Relationship

> **Status: PLANNED / NOT IMPLEMENTED**

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

**PLANNED:** P8 becomes the semantic producer of stable identity and
evidence-grounded persona/relationship interpretation. Existing prompt fields
may be projection targets, but their presence does not prove P8 already exists.
No existing Memory category is reclassified as P8 truth.

## 10. Likely staged implementation shape

1. Freeze a concise identity/persona invariant set and evidence rules.
2. Define the minimum P8 projection meanings, including unknown/conflict.
3. Produce the projection from explicit rules plus Memory-authorized evidence
   and recent conversation.
4. Add revision/correction and audit behavior using Runtime-owned persistence.
5. Validate multi-session stability, scope isolation, and backend replacement.

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
