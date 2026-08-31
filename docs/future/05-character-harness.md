# Phase 5 — Thin Character Harness

> **Status: PARTIALLY IMPLEMENTED — SEMANTIC KERNEL COMPLETE THROUGH 5L; CONCRETE CHARACTER ADAPTER DEFERRED**
>
> **Current implementation checkpoint:** Character ABI 2A/2D and Character Harness
> 5A–5L are implemented in `packages/character-abi` and
> `packages/character-harness`. The concrete model-specific Character adapter,
> prompt/control-token serialization, provider binding, semantic-loop detector,
> and Runtime execution integration are not implemented by this checkpoint.

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

**CURRENT:** Character ABI `character-abi-2a.v1` remains available for existing
consumers, while `character-abi-2d.v1` adds a structured `COGNITION_RESULT`
section that preserves the phase-6 normalized result without flattening it into
a generic summary/state pair. Character Harness 5A–5L implement bounded ABI
assembly, minimum output interpretation, termination/length checks, exact
n-gram repetition supervision, deterministic recovery, an optional ambiguous
recovery-supervisor contract, `NEED_COGNITION` request construction, normalized
cognition round-trip validation, structured Cognition Result projection,
2D/post-cognition budgeted assembly, and a provider-neutral semantic Character
adapter request. Runtime and provider execution authority remain outside the
Harness.

The post-cognition path treats the normalized Cognition Result as mandatory
continuation payload: its section slot and semantic-character cost are reserved
before ordinary prefix-only context selection, and the result is appended after
selected regular sections. This guarantees that a Character-requested cognition
result is not silently budgeted away without assigning it higher truth weight.

**NOT IMPLEMENTED AT THIS CHECKPOINT:** a concrete Character Model adapter,
prompt/control-token serialization, Character provider/model binding, Runtime
execution integration for the new request seam, semantic-loop detection, or a
concrete intelligent-supervisor provider binding. The optional supervisor seam
is a contract only; deterministic recovery remains the normal path.

A concrete Character adapter is intentionally deferred until the Character
checkpoint/post-training behavior is known. Implementing a speculative adapter
against an unrelated current model would make model-specific wire behavior look
like stable Character ABI semantics.

## 10. Implemented staged shape

1. **Implemented:** bounded one-way ABI assembly and provider-neutral semantic
   adapter request seams. A concrete model-specific adapter remains deferred.
2. **Implemented:** minimum respond/silence/terminate/`NEED_COGNITION` output
   meanings and fail-closed interpretation.
3. **Implemented:** bounded response length and normalized termination checks.
4. **Partially implemented:** exact character n-gram repetition and malformed
   action handling. Semantic-loop detection remains deferred pending evaluation
   evidence and a design that does not couple Harness semantics to an embedding
   provider.
5. **Implemented:** deterministic semantic recovery plus an optional bounded
   ambiguous-recovery supervisor contract. Runtime/provider infrastructure
   remains the sole executor of retries and fallbacks.
6. **Implemented as semantic seams:** `NEED_COGNITION` request output,
   normalized cognition round-trip validation, structured 2D result projection,
   and post-cognition reserved assembly. Full phase-6 cognition/provider/MCP
   execution is not part of this checkpoint.

Each mechanism remains independently bounded; there is no general orchestration
DSL.

## 11. Acceptance concept

The implemented semantic kernel can assemble bounded provider-neutral Character
contexts; preserve a requested normalized Cognition Result through a lossless
2D round-trip; detect and contain malformed, truncated, bad-termination, and
exact-repeat outputs; emit bounded recovery semantics without executing them;
and produce a stable Character-generation request containing no provider/model
or Runtime execution knobs.

Full Phase 5 acceptance still requires evaluation against a concrete Character
adapter/checkpoint and Runtime admission/execution integration. Semantic-loop
supervision, if needed by observed model behavior, remains an evaluation-driven
follow-up rather than a prerequisite invented in advance.

## 12. Risks

- Accumulating convenience state until the Harness becomes a second Runtime.
- Treating parser details as the stable Character ABI.
- Retrying after visible output and duplicating effects.
- Overriding meaningful silence because monitoring expects text.
- Heuristics that falsely flag natural repetition or miss semantic loops.
- Letting `NEED_COGNITION` translation become capability selection or concrete
  tool planning.
- Coupling the Harness to one local model's prompt/control-token syntax.

## 13. Remaining questions / deferred decisions

- What minimal Character output grammar and prompt/control-token format fit the
  selected post-trained Character checkpoint? This must be answered from the
  actual model behavior rather than simulated with an unrelated model.
- How should semantic-loop detection be evaluated, and is it necessary after
  post-training, without embedding-provider coupling?
- What output becomes “committed” for text, speech, gaze, and actions when the
  new Harness path is integrated with Runtime?
- Which supervision diagnostics may be retained safely?
- How many model-specific adapter behaviors are acceptable before ABI meaning
  is being distorted?

The normal recovery path is no longer an open architecture question: simple
malformed/truncated/over-budget/tool-call/exact-repeat failures use bounded
deterministic recovery; genuinely ambiguous recovery may enter the optional
supervisor seam. Actual retry/fallback execution remains Runtime/provider-owned.

## 14. Handoff boundary to the next phase

The current Harness semantic kernel can request serious cognition, validate and
consume a normalized result, preserve that result as structured Character ABI
2D meaning, assemble a bounded post-cognition context, and emit a
provider-neutral `CHARACTER_GENERATION` adapter request. Phase 6 may bind
replaceable cognition and MCP capabilities behind Runtime admission and is the
sole producer of normalized Cognition Results. It must not give the Harness
normalization, direct cognition/provider/MCP execution, retry/fallback,
capability selection, durable state, or provider lifecycle authority.

The next Character-side implementation step is deliberately blocked on the
actual post-trained Character Model: only then should a concrete adapter map the
stable 5L semantic request to that model's prompt/control format and decode its
wire output back into the existing 5B supervision path.
