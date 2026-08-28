# Phase 8 — Character Post-Training

> **Status: PLANNED / NOT IMPLEMENTED**

## 1. Purpose

Create durable behavioral assets and, only after the architecture is sound,
post-train a replaceable Character Model to express stable Yuvi behavioral
priors. The goal is not to bake today's environment, providers, tools, or
Runtime internals into identity.

## 2. Responsibility

Post-training owns learned priors for:

- Yuvi's social and conversational behavior;
- natural character expression;
- epistemic honesty and uncertainty behavior;
- attention and response-worthiness;
- termination and meaningful silence;
- coarse escalation to Cognition Core;
- adaptation to environment-provided semantic context;
- Yuvi-specific behavioral preferences that remain valid across environments.

The durable product assets are:

- `YUVI_BEHAVIOR_SPEC`;
- `YUVI_BEHAVIOR_EVAL`;
- `YUVI_PREFERENCE_DATASET`.

Base model weights, adapters, and serving backends are replaceable outputs, not
the durable source of behavior truth.

## 3. Inputs

- frozen Character/Cognition responsibility rules;
- Character ABI meaning catalog and versioned evaluation fixtures;
- grounded examples from P8, temporal, Continuity, Harness, cognition, and
  embodied behavior;
- supervised demonstrations and preference pairs with provenance;
- failure cases for repetition, bad termination, over-speaking, false
  familiarity, under/over-escalation, and backend/tool leakage;
- environment variation across Memory, cognition, providers,
  Cognition-facing capabilities/results, and presentation;
- explicit `CHARACTER_INVARIANT` versus `ENVIRONMENT_BOUND` labels.

Only `CHARACTER_INVARIANT` content may directly define character weights.
Environment-bound examples may teach adaptation to descriptions, but their
concrete names/values must not become character facts.

## 4. Outputs

- maintained behavior specification, evaluation suite, and preference dataset;
- base-model bakeoff evidence;
- a selected replaceable base model, if evaluation supports one;
- QLoRA SFT adapter/checkpoint and training report;
- DPO adapter/checkpoint and preference report;
- shadow/A-B results and regression decisions;
- an iterative, provenance-aware preference-data flywheel;
- explicit model/ABI compatibility and known limitations.

No training is performed by this planning phase.

## 5. Authority boundaries

| Candidate owner                     | Boundary audit                                                                                                                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime                             | Supplies architecture, execution truth, traces, and evaluation environments; weights must not learn current Runtime fields or replace Runtime admission.                                                  |
| Memory                              | Supplies consented evidence/examples under policy; training data must not turn Memory content into universal Persona truth.                                                                               |
| P8                                  | Defines stable identity/persona/relationship semantics; post-training learns expression/preferences but cannot silently redefine P8.                                                                      |
| Continuity                          | Defines open-thread and attention-anchor meaning; weights learn how to respond to the projection, not how to invent durable Continuity.                                                                   |
| **Character Model / post-training** | Owns learned social, epistemic, attention, termination, escalation, and expression priors because these should generalize across environments.                                                            |
| Cognition Core                      | Provides serious reasoning during product use/evaluation; its model identity and raw outputs must not be baked into Character weights.                                                                    |
| Character Harness                   | Supplies stable ABI/supervision and collects bounded failure outcomes; post-training cannot replace Harness generation safeguards.                                                                        |
| MCP capability layer                | Supplies dynamic environment-bound capability descriptions to Cognition; direct Character capability execution remains reserved, and concrete names/servers/tools are excluded from character invariants. |
| Presentation                        | Supplies causal behavior outcomes and preferences; incidental animation/device details must not define character identity.                                                                                |

Stable behavior belongs in weights only when it remains desirable after every
backend and environment component is replaced.

## 6. Hard invariants

- Every training item is classified as `CHARACTER_INVARIANT` or
  `ENVIRONMENT_BOUND` before it can shape weight objectives.
- Stable weights may encode social prior, natural conversation, epistemic
  behavior, termination/silence, coarse escalation, environment adaptability,
  and Yuvi-specific preference.
- Character weights learn coarse `NEED_COGNITION`, not
  `REQUEST_CAPABILITY`; direct Character-to-capability execution remains
  reserved/non-executable in the initial architecture.
- Weights must not encode DeepSeek, a specific 70B model, concrete MCP
  tool/server names, provider names, Runtime field names, database
  implementation, or raw Cognition Result format.
- SFT precedes preference training; initial preference method is DPO.
- A base-model bakeoff precedes QLoRA SFT.
- Shadow/A-B evaluation precedes broad reliance.
- Post-training does not compensate for missing Runtime architecture or unclear
  semantic ownership.
- Post-training is not a formal guarantee against repetition or semantic loops;
  Harness supervision remains mandatory.
- Raw private conversation is not training data by default.
- Model weights remain replaceable; spec/eval/data remain durable.

## 7. Explicit non-goals

- Beginning data training, QLoRA, DPO, or model selection in this roadmap PR.
- Training Cognition Core to sound like Yuvi.
- Baking current environment configuration into character identity.
- Using fine-tuning to hide architectural ambiguity, unsafe capability
  admission, or weak generation supervision.
- A one-time static dataset with no provenance, consent, or regression policy.
- Optimizing only for response preference while ignoring silence and
  escalation.

## 8. Dependencies

- Phases 1–7 semantics and causal traces must be implemented and evaluated
  before this phase begins.
- Character ABI and Harness supervision are stable enough to generate
  comparable fixtures.
- Data governance, consent, redaction, retention, and provenance rules are
  approved.
- Cognition and environment identities are demonstrably replaceable.

Data collection and rubric drafting may begin earlier, but architecture-bound
labels cannot be treated as training-ready until their semantics stabilize.

## 9. Relationship to existing implementation

**CURRENT:** Yuvi uses provider-configured models and prompt instructions;
provider/model names are dynamic configuration. P6 already provides useful
examples of meaningful `NO_OP`, bounded text, malformed-output rejection,
one-shot behavior, and user priority. Current provider normalization and
Memory provenance offer data-quality precedents.

**PLANNED:** formal behavior assets, model bakeoff, QLoRA SFT, DPO, shadow/A-B
evaluation, and a preference-data flywheel. Existing prompt strings and
provider-specific examples are not automatically the behavior spec or training
dataset.

## 10. Likely staged implementation shape

1. **Phase 8:** author `YUVI_BEHAVIOR_SPEC`, `YUVI_BEHAVIOR_EVAL`, and a
   provenance/labeling pipeline for `YUVI_PREFERENCE_DATASET`.
2. **Phase 9:** run base-model bakeoff on character, silence, escalation,
   robustness, latency, and local deployment constraints.
3. **Phase 10:** QLoRA SFT on reviewed `CHARACTER_INVARIANT` demonstrations.
4. **Phase 11:** DPO on reviewed preference pairs, including preferred silence
   and escalation outcomes.
5. **Phase 12:** shadow and controlled A/B evaluation against the durable eval.
6. **Phase 13:** iterate a consented preference-data flywheel with regression
   gates and dataset versioning.

Each stage can stop without changing Runtime semantics if evaluation fails.

### Phase 8–13 stage authority contracts

| Stage                         | Owns                                                                                                                                                | Consumes                                                                     | Emits                                                                  | Does not own                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 8 — Behavior assets           | Semantic target definition in `YUVI_BEHAVIOR_SPEC`, measurement definitions in `YUVI_BEHAVIOR_EVAL`, and reviewed/provenance-aware dataset curation | Frozen phase 1–7 semantics, causal traces, approved consent/governance rules | Versioned spec, eval, and reviewed dataset artifacts                   | Runtime/P8/Continuity redesign, weight transformation, deployment admission                |
| 9 — Base-model bakeoff        | Candidate comparison and selection evidence against the durable eval                                                                                | Phase-8 spec/eval, candidate base models, local deployment constraints       | Bakeoff report and evidence-supported candidate selection              | Changing semantic targets, SFT/DPO, deployment admission                                   |
| 10 — SFT                      | Weight transformation from reviewed `CHARACTER_INVARIANT` demonstrations                                                                            | Selected base model, reviewed demonstrations, ABI/eval versions              | QLoRA SFT checkpoint/adapter and training report                       | Relabeling data, redefining behavior semantics, Runtime authority                          |
| 11 — DPO                      | Preference optimization from reviewed pairs                                                                                                         | Passing SFT artifact, reviewed preference pairs, durable eval                | DPO checkpoint/adapter and preference report                           | Consent/data-governance policy, semantic target redefinition, deployment admission         |
| 12 — Shadow/A-B               | Controlled measurement and deployment-readiness evidence                                                                                            | Candidate artifact, durable eval, admitted shadow/A-B environment            | Shadow/A-B results, regression evidence, readiness recommendation      | Runtime admission, automatic promotion/deployment, semantic authority                      |
| 13 — Preference-data flywheel | Consented, reviewed dataset revision and regression-input versioning                                                                                | Admitted consented traces, reviewed labels/preferences, evaluation failures  | Versioned dataset revisions and evidence for a later training decision | Automatic retraining/deployment, silent weight updates, P8/Runtime/Continuity redefinition |

No stage may silently redefine P8, Runtime, Continuity, Cognition, MCP, or
Presentation semantics. Evaluation evidence and readiness recommendations do
not themselves grant deployment or effect authority.

## 11. Acceptance concept

The program is acceptable when a candidate Character Model improves the
durable eval over prompt-only baselines; preserves P8 grounding and epistemic
honesty; chooses silence/termination appropriately; escalates serious work
without learning backend identity; remains stable across changed capability
descriptions/providers; stays within generation-supervision thresholds; and
passes shadow/A-B safety and regression gates.

Evaluation must cover at least false familiarity, invented relationship state,
over-speaking, endless continuation, repetition/semantic loops, bad EOS,
under/over-escalation, capability-name leakage, raw cognition-format leakage,
and environment replacement.

## 12. Risks

- Dataset contamination by current provider/tool/Runtime names.
- Preference optimization that rewards verbosity or constant engagement over
  meaningful silence.
- Memorizing private user evidence as character invariant.
- Training on model-generated labels without independent review/provenance.
- Overfitting one ABI serialization or one base model.
- Using DPO to conceal weak SFT data or unresolved architecture.
- Removing Harness safeguards after benchmark gains.
- Treating model weights as the only durable character asset.

## 13. Open questions

- What license, consent, and retention rules govern preference data?
- Which behaviors are universal Yuvi invariants versus user-configurable
  preferences?
- Which base-model candidates satisfy local latency, language, controllability,
  and termination requirements?
- What bakeoff weights balance character quality, silence, escalation, and
  robustness?
- How are environment-bound examples transformed without leaking concrete
  names into weights?
- What shadow/A-B stopping rules protect the user relationship?
- How are dataset/model/ABI versions tied together without coupling them
  permanently?

## 14. Handoff boundary to the next phase

This document spans roadmap phases 8–13. Each stage hands the next a reviewed,
versioned artifact and evaluation evidence, not an assumption of success. A
base model advances to SFT only after bakeoff; SFT advances to DPO only after
behavior and robustness gates; DPO advances to shadow/A-B only after regression
review; deployment evidence enters the flywheel only under consent and
provenance rules. No stage may change Runtime, P8, Continuity, Cognition, MCP,
or Presentation authority to improve a training score.
