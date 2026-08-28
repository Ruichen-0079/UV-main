# Phase 2 — Character ABI and Cognition Boundary

> **Status: PLANNED / NOT IMPLEMENTED**

## 1. Purpose

Define a stable semantic boundary around the Character Model so Yuvi's
behavior can survive replacement of the Memory backend, cognition model,
provider implementation, MCP servers, tool names, and Runtime internal state
shape. At the same time, narrow the Character Model to character, attention,
termination/silence, coarse cognition escalation, and result expression.

## 2. Responsibility

This phase owns the meaning of the Character ABI and the Character/Cognition
split.

The Character Model normally owns:

1. **Character:** how Yuvi communicates naturally.
2. **Attention:** whether the present reactive situation deserves a response.
3. **Termination:** when a reactive response should stop, finish, or remain
   silent. While current P6 remains active, proactive-text speak/no-speak is
   owned solely by its `NO_OP | REQUEST_TEXT` decision producer.
4. **Cognition escalation:** a coarse judgment that serious cognition is
   required.
5. **Expression:** how a normalized result is conveyed in Yuvi's voice.

The Cognition Core normally owns complex reasoning, software engineering,
math, research, current-world verification, repository/file analysis,
multi-step planning, complex social interpretation, complex tool selection,
and other high-reliability work.

## 3. Inputs

Candidate Character ABI input sections are:

- stable identity;
- relationship/persona evidence and P8 interpretation;
- bounded recent conversation;
- relevant Memory evidence;
- current temporal context;
- Continuity/open threads;
- attention anchors or candidates;
- current perception/situation;
- when a later contract explicitly admits them, bounded semantic descriptions
  of available capabilities; this section is absent from the initial
  Character-facing architecture;
- a normalized Cognition Result when escalation has completed.

Every section must support absence, unknown, partial, and bounded content where
those states are meaningful.

## 4. Outputs

The Character Model needs semantic outputs for:

- respond, stop, or remain silent;
- coarse `NEED_COGNITION` request for Cognition Core assistance;
- natural-language character expression;
- bounded behavioral/presentation intent;
- no directly executable capability request. Direct Character-to-capability
  execution is reserved/deferred in the initial architecture.

Exact labels, serialization, parsing strategy, and TypeScript types remain
open. The stable contract is meaning, not today's field layout.

Phase 2 owns the semantic meanings of the separate normalized Cognition Result
seam, but it does not execute normalization. Candidate meanings include:

- status;
- answer;
- key facts;
- evidence;
- uncertainty;
- caveats.

The Character Model must not consume one backend's raw output, raw
chain-of-thought, provider payload, or tool trace.

## 5. Authority boundaries

| Candidate owner      | Boundary audit                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime              | Projects authorized state and executes admitted Character/cognition/provider work; its internal state schema is not the Model ABI and it does not decide or reinterpret Character/Cognition semantics. |
| Memory               | Supplies bounded evidence with provenance; Memory records are not ABI fields by default and are never passed through as backend DTOs.                                                                  |
| P8                   | Owns identity/persona/relationship meaning; phase 2 only gives that meaning a stable model-facing projection.                                                                                          |
| Continuity           | Owns open-thread meaning; the ABI carries its projection without redefining it.                                                                                                                        |
| **Character Model**  | Owns social expression, reactive attention, reactive termination/silence, and coarse `NEED_COGNITION`; current proactive-text speak/no-speak remains solely P6-owned until atomic migration.           |
| **Cognition Core**   | Owns serious reasoning and, after escalation, may emit semantic `REQUEST_CAPABILITY`; reliability and backend replacement remain independent from Yuvi's social surface.                               |
| Character Harness    | Will assemble, validate, budget, include, and interpret the ABI in phase 5; it does not normalize raw Cognition output, define upstream truth, execute work, or perform reasoning.                     |
| MCP capability layer | Supplies dynamic capability descriptions and invocation adapters; concrete tool/server names are not stable ABI identity.                                                                              |
| Presentation         | Consumes bounded behavior intent; it cannot infer model authority from animation or speech output.                                                                                                     |

The ABI belongs at the model boundary because neither a Runtime DTO nor a
prompt template can provide a stable, backend-independent semantic contract.

## 6. Hard invariants

- `MODEL ABI` is distinct from `INTERNAL RUNTIME IMPLEMENTATION SCHEMA`.
- ABI meanings remain provider-, vendor-, storage-, model-, and tool-name
  neutral.
- The Character Model does less rational work than a general work model.
- The Character Model does not need to know which model implements Cognition
  Core.
- Phase 2 owns normalized Cognition Result meanings; the phase-6 cognition
  boundary is the sole normalization producer before Character consumption.
- The Character Harness performs no second normalization and never interprets
  raw Cognition backend output.
- Raw chain-of-thought is not required, stored, or projected.
- Missing evidence remains missing; ABI assembly must not manufacture context.
- Direct Character-to-capability execution is reserved and non-executable in
  the initial architecture. The Character Model emits `NEED_COGNITION`, not
  `REQUEST_CAPABILITY`.
- Any later Character-facing capability descriptions are dynamic inputs, not
  weighted identity.
- Character outputs are proposals until Runtime admission.
- Detailed wire types are not frozen before evaluation proves the necessary
  meanings.

## 7. Explicit non-goals

- Choosing a base Character Model or the 70B-class Cognition backend.
- Building the Character Harness, MCP integration, or tool planner.
- Defining Runtime repositories, events, provider DTOs, or package layout.
- Making the Character Model a reliable coding/research/reasoning engine.
- Making Cognition Core speak in final Yuvi voice.
- Exposing raw hidden reasoning or a backend-specific JSON response.
- Designing a generic multi-agent protocol.

## 8. Dependencies

- Structural R closeout.
- Phase 1 P8 meanings.
- Current Memory evidence contracts and provider-neutral prompt principles.
- Current normalized provider contracts, especially the rule that reasoning
  success has an authoritative non-empty answer and raw provider reasoning is
  discarded.

Temporal, Continuity, Harness, and MCP phases may initially use absent ABI
sections until their semantics are implemented.

## 9. Relationship to existing implementation

**CURRENT:** `PromptBuilder` accepts structured sections such as
`SystemIdentity`, `CharacterStyle`, `RelationshipContext`, `CurrentTime`,
`CurrentAffect`, `DirectContext`, `RelevantMemory`, `CurrentSituation`, and
`Tools`. `ReasoningOutput.answer` is already the normalized business result,
while provider-internal reasoning is discarded. Tool/function calling is
explicitly unsupported. These are useful precedents, not the future Character
ABI.

**PLANNED:** a semantic Character ABI projects authorized meanings from those
and future sources. Current `PromptBuildInput`, `RuntimePromptPreview`,
provider outputs, database records, and internal lifecycle identities remain
internal schemas rather than ABI definitions.

## 10. Likely staged implementation shape

1. Write an ABI meaning catalog and required unknown/partial behavior.
2. Define reactive character output meanings, current-P6 exclusion, and the
   coarse `NEED_COGNITION` boundary.
3. Define the normalized Cognition Result meanings.
4. Build evaluation fixtures independent of providers and storage.
5. Test projection compatibility across at least two mock Memory/cognition
   backends before considering a wire format stable.

The first implementation should be a narrow projection and normalized-result
contract seam, not a generic agent-message framework. Executable normalization
remains phase-6-owned.

## 11. Acceptance concept

The phase is acceptable when the semantic contract and responsibility split are
complete; representative ABI examples plus valid/invalid output examples are
defined; the same adapter-neutral fixtures run against deterministic,
provisional, and adversarial adapters without Runtime-schema leakage; normalized
cognition results can be represented without backend leakage; reactive silence,
termination, and `NEED_COGNITION` are first-class; and no fixture requires
current provider, backend, server, or tool names. Reliable learned escalation is
evaluated later during base-model bakeoff, post-training, behavior evaluation,
and shadow/A-B rather than accepted in this contract phase.

## 12. Risks

- Treating current prompt fields as a permanent wire schema.
- Passing too much internal state and teaching the model implementation trivia.
- Under-specifying unknown/partial states and encouraging fabrication.
- Letting “coarse escalation” grow into tool routing or hidden planning.
- Making Cognition Result so generic that evidence and uncertainty are lost.
- Coupling ABI versioning to a specific base model's prompt syntax.

## 13. Open questions

- Which ABI sections are always present versus conditionally projected?
- How should ABI meaning versions be declared and evaluated?
- What is the minimum output vocabulary for silence, termination, escalation,
  expression, and malformed output?
- Should any bounded capability description ever be Character-facing? Direct
  Character capability execution remains deferred and non-executable unless a
  later explicitly admitted contract answers this question.
- When should Cognition Core return structured evidence versus a concise answer?
- Which normalized statuses distinguish success, partial, unavailable,
  cancelled, and unsafe-to-answer?

## 14. Handoff boundary to the next phase

Phase 2 hands phase 3 semantic slots for current temporal context without
dictating how time is derived. Phase 3 must fill those meanings with grounded
time semantics and uncertainty; it must not expose clock/storage internals,
simulate off-screen life, or change the Character/Cognition responsibility
split.
