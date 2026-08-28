# Phase 5 — Thin Character Harness

> **Status: PLANNED / NOT IMPLEMENTED**

## 1. Purpose

Add a thin mediation layer around the local Character Model. The Harness
assembles the Character ABI, interprets bounded model behavior, constructs a
Runtime cognition request when the model emits `NEED_COGNITION`, supervises
unreliable local generation, and emits semantic requests for Runtime admission.

The Harness exists to protect stable seams, not to become another Runtime.

## 2. Responsibility

The Character Harness owns:

- selecting authorized semantic projections for Character ABI inclusion under
  the context budget, then serializing/assembling them;
- constructing the Character adapter request for Runtime/provider execution;
- interpreting respond/silence/termination/escalation/behavior outputs;
- producing a semantic Runtime cognition request when `NEED_COGNITION` is
  requested;
- validating, budgeting, including, and consuming the phase-6-produced
  normalized Cognition Result without independently normalizing or
  reinterpreting raw backend output;
- generation supervision and bounded semantic recovery disposition;
- translating model intent into presentation requests for Runtime admission;
  direct Character-to-capability execution is reserved and non-executable;
- safe diagnostics about projection and generation outcomes.

It owns no durable truth and no independent effect execution.

## 3. Inputs

- P8, temporal, Continuity, Memory, recent conversation, and perception
  projections authorized for the Character ABI; any future Character-facing
  capability projection remains absent unless a later contract explicitly
  admits it;
- current Character Model adapter/configuration;
- normalized Cognition Results produced solely by the phase-6 cognition
  boundary;
- Runtime-provided budgets, cancellation, and admission context;
- generation policy and evaluation thresholds.

The Harness must tolerate absent sections and partial upstream status without
filling gaps with invented context.

## 4. Outputs

- interpreted Character disposition: respond, stop, silence, or escalate;
- bounded natural-language candidate;
- bounded presentation/behavior intent;
- semantic `NEED_COGNITION` request; no directly executable
  Character-originated capability request;
- generation outcome such as accepted, malformed, repetitive, truncated,
  cancelled, or fallback;
- semantic recovery disposition such as `RETRY_CHARACTER_GENERATION`,
  `FALLBACK_TO_COGNITION`, or `FAIL_CHARACTER_OUTPUT` for Runtime/provider
  infrastructure to execute;
- safe projection/supervision diagnostics;
- requests submitted to Runtime, never direct side effects.

## 5. Authority boundaries

| Candidate owner       | Boundary audit                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime               | Owns lifecycle, concurrency, cancellation authority, persistence, admission, Character/cognition/provider/capability execution, actual retry/fallback, and event publication; the Harness only constructs requests, validates, and adapts. |
| Memory                | Owns retrieval eligibility/filtering/ranking, supplies authorized evidence, and records admitted outcomes through Runtime; the Harness cannot re-rank or read/write Memory independently.                                                  |
| P8                    | Supplies identity/persona/relationship meaning; the Harness selects authorized P8 projections for ABI inclusion under the context budget but cannot reinterpret or persist them.                                                           |
| Continuity            | Supplies open threads and attention anchors; the Harness does not create a second Continuity store or scheduler.                                                                                                                           |
| Character Model       | Makes learned reactive character/attention/termination and `NEED_COGNITION` judgments; current proactive-text `NO_OP \| REQUEST_TEXT` remains P6-owned until atomic migration.                                                             |
| Cognition Core        | Performs serious reasoning and may emit `REQUEST_CAPABILITY`; its phase-6 boundary solely normalizes results. The Harness only mediates requests and validates/consumes normalized results.                                                |
| **Character Harness** | Owns budgeted ABI inclusion/assembly, output interpretation, semantic escalation/recovery disposition, and generation supervision; it owns no execution, retry, or result-normalization authority.                                         |
| MCP capability layer  | Describes and performs one admitted invocation at a time under Runtime authority; the Harness neither invokes MCP nor routes concrete tool names.                                                                                          |
| Presentation          | Renders admitted behavior; the Harness may request an expression but cannot claim it occurred.                                                                                                                                             |

This belongs in a thin Harness because model adaptation and failure handling
must change without mutating Runtime semantics or upstream state authority.

## 6. Hard invariants

- The Harness owns no durable state.
- The Harness is not a lifecycle, concurrency, persistence, provider-routing,
  provider-execution, provider-retry/fallback, MCP-invocation, or
  capability-admission authority.
- Character ABI assembly is selective and bounded.
- ABI selection means budget/truncation/inclusion among already-authorized
  semantic projections; the Harness does not reimplement Memory retrieval or
  semantic ranking.
- Model output is untrusted until parsed, supervised, and admitted.
- Local character models may repeat, loop, truncate, ignore EOS, or emit
  malformed actions even after post-training.
- Supervision considers output budgets, n-gram repetition, semantic loops,
  EOS/termination quality, malformed actions, and safe recovery.
- The Harness may emit a bounded semantic recovery disposition before commit;
  Runtime/provider infrastructure performs any actual invocation, retry, or
  fallback and cannot replay a committed or user-visible effect.
- Silence is a valid safe outcome, not automatically a failure.
- The phase-6 cognition boundary is the sole normalization producer. Raw
  Cognition output and raw provider DTOs never enter the Harness, and the
  Harness performs no second normalization.
- Direct Character-to-capability execution is reserved and non-executable; the
  Character Model emits `NEED_COGNITION`, not `REQUEST_CAPABILITY`.
- P6 one-shot, fresh-identity, user-priority, and no-extra-authority semantics
  remain intact.

## 7. Explicit non-goals

- A second Runtime, workflow engine, event bus, state store, or tool
  orchestrator.
- Durable Memory, P8, temporal, or Continuity ownership.
- Complex reasoning or reliable tool planning.
- Provider call execution, retry, selection, and fallback policy already owned
  by Runtime/provider layers.
- A formal guarantee that post-training prevents repetition loops.
- A generic multi-agent graph or speculative plugin framework.

## 8. Dependencies

- Phases 1–4 semantic projections.
- Phase 2 Character ABI and normalized Cognition Result meanings.
- Current Runtime lifecycle/cancellation/admission and provider-normalization
  contracts.
- A minimal Character Model adapter suitable for evaluation; model selection
  and training remain later phases.

Full cognition/MCP integration is phase 6. Phase 5 may use a stub normalized
result seam to validate mediation.

## 9. Relationship to existing implementation

**CURRENT:** Runtime and `PromptBuilder` assemble structured prompts; provider
adapters normalize outputs; P6 validates `NO_OP | REQUEST_TEXT`, bounds the
continuation, rejects empty/truncated/control-leaking text, fences cancellation,
and fails closed before persistence. Provider fallback already respects
committed effects.

**PLANNED:** the Character Harness generalizes model-facing projection,
Character output interpretation, cognition mediation, and local-generation
supervision. It preserves current Runtime/provider/P6 ownership rather than
moving those mechanisms wholesale into a new service.

## 10. Likely staged implementation shape

1. Implement one-way ABI projection and one Character Model adapter.
2. Parse only the minimum respond/silence/terminate/escalate meanings.
3. Add bounded output and termination checks.
4. Add n-gram and semantic-loop detection plus malformed-action handling.
5. Add semantic recovery dispositions before committed effects; Runtime/provider
   infrastructure remains the sole executor of retries and fallbacks.
6. Add normalized cognition round-trip validation/consumption and
   `NEED_COGNITION` request output.

Each mechanism should be independently evaluated. Do not create a general
orchestration DSL.

## 11. Acceptance concept

The Harness is acceptable when it can assemble the same semantic Character
context across replaceable model adapters; detect and contain repetition,
truncation, bad EOS, and malformed actions; emit a safe semantic
silence/retry/fallback disposition without executing or duplicating effects;
validate and round-trip a phase-6-produced normalized Cognition Result without
renormalizing it; and submit all external behavior through Runtime admission
with no durable local truth.

## 12. Risks

- Accumulating convenience state until the Harness becomes a second Runtime.
- Treating parser details as the stable Character ABI.
- Retrying after visible output and duplicating effects.
- Overriding meaningful silence because monitoring expects text.
- Heuristics that falsely flag natural repetition or miss semantic loops.
- Letting `NEED_COGNITION` translation become capability selection or concrete
  tool planning.
- Coupling the Harness to one local model's prompt/control-token syntax.

## 13. Open questions

- What minimal Character output grammar is robust across candidate models?
- Which semantic recovery disposition should prefer silence,
  `RETRY_CHARACTER_GENERATION`, `FALLBACK_TO_COGNITION`, or
  `FAIL_CHARACTER_OUTPUT`?
- How is semantic-loop detection evaluated without embedding provider coupling?
- What output becomes “committed” for text, speech, gaze, and actions?
- Which supervision diagnostics may be retained safely?
- How many model-specific adapter behaviors are acceptable before ABI meaning
  is being distorted?

## 14. Handoff boundary to the next phase

Phase 5 hands phase 6 a thin mediation seam that can request serious cognition,
validate/consume normalized results, and emit `NEED_COGNITION`. Phase 6 may bind
replaceable cognition and MCP capabilities behind Runtime admission and is the
sole producer of normalized Cognition Results. It must not give the Harness
normalization, direct cognition/provider/MCP execution, retry/fallback,
capability selection, durable state, or provider lifecycle authority.
