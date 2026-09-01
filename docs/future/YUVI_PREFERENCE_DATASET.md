# YUVI_PREFERENCE_DATASET v1

> **Status: PHASE 8C DATASET SCHEMA AND GOVERNANCE CONTRACT**
>
> **Behavior authority:** [`YUVI_BEHAVIOR_SPEC v1`](YUVI_BEHAVIOR_SPEC.md)
>
> **Evaluation authority:** [`YUVI_BEHAVIOR_EVAL v1`](YUVI_BEHAVIOR_EVAL.md)
>
> **Scope:** durable item identity, provenance, admissibility, privacy,
> review, and revision rules. This document defines a schema; it does not
> create a corpus, ingestion pipeline, or training infrastructure.

## 1. Purpose and boundary

`YUVI_PREFERENCE_DATASET` records the minimum information needed to decide
whether a demonstration or preference pair could later inform a Character
Model objective. It keeps behavior semantics separate from the temporary
provider/model path and from operational implementation details.

Phase 8C may define records, labels, and governance now. It does not authorize
Phase 9 base-model selection, Phase 10 SFT, Phase 11 DPO, a preference-data
flywheel, automatic labeling, or automatic training.

The dataset is not an authority for Runtime execution, Memory truth, P8
identity/persona/relationship interpretation, Cognition, Harness
supervision, or Presentation. A dataset item may describe a failure at one of
those owners, but it must not turn that failure into a Character training
objective.

## 2. Non-negotiable rules

- Raw private conversation is **not training data by default**.
- An operational trace may support evaluation or failure classification only
  under an explicit consent, privacy, retention, and review policy.
- A model-generated label, ranking, rationale, or rewrite is a candidate
  artifact, never automatic ground truth.
- Only a reviewed `MODEL_BEHAVIOR` failure may later motivate a Character
  training item. Review does not itself authorize training.
- `MEMORY_RETRIEVAL`, `PROMPT_OR_PROJECTION`, `P8_INTERPRETATION`,
  `RUNTIME_OR_LIFECYCLE`, `HARNESS_OR_NORMALIZATION`, `PROVIDER_TRANSPORT`,
  and `PRESENTATION` failures belong to their owning layer and are not
  Character training targets merely because they affected visible output.
- `ENVIRONMENT_BOUND` material may test adaptation to supplied context, but
  concrete provider, model, tool, server, device, Runtime, storage, endpoint,
  or wire names must not become Character invariants.
- Records are append-only and reviewable. No item is silently relabeled,
  overwritten, or deleted from the revision history.

## 3. Dataset and item identity

The following identifiers are stable and are not interchangeable:

| Field              | Rule                                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dataset_id`       | Always `YUVI_PREFERENCE_DATASET`; identifies this governance domain.                                                                                       |
| `schema_version`   | `yuvi-preference-dataset.v1`; changes only when the record contract changes.                                                                               |
| `dataset_version`  | Immutable snapshot identifier, using an immutable semantic version such as `1.0.0`. A snapshot lists the active item versions.                             |
| `item_id`          | Stable logical identity. Never recycle an identifier for different meaning.                                                                                |
| `item_version`     | Positive integer for an immutable revision of an item. Start at `1`; increment for any semantic, label, consent, privacy, review, or admissibility change. |
| `content_digest`   | Digest of the canonicalized semantic payload and classification-relevant fields; used to detect unrecorded mutation.                                       |
| `source_reference` | Opaque provenance reference. It is not permission to expose the source or to copy raw private content into the dataset.                                    |

An item version is immutable. A new dataset snapshot may point to a newer
item version, but it may not edit the older version in place.

## 4. Canonical item schema

The following is a normative shape. Every field is present; `null` is used
only where the item's status makes a value inapplicable, and an empty list is
used where no reference exists. Omitting a required field makes the item
invalid and therefore not admissible.

```json
{
  "dataset_id": "YUVI_PREFERENCE_DATASET",
  "schema_version": "yuvi-preference-dataset.v1",
  "dataset_version": "<immutable-dataset-version>",
  "item_id": "<stable-item-id>",
  "item_version": 1,
  "content_digest": "sha256:<canonical-payload-digest>",
  "classification": "CHARACTER_INVARIANT",
  "classification_rationale": "<why the meaning survives environment replacement>",
  "source": {
    "source_type": "SYNTHETIC_FIXTURE",
    "source_reference": "<opaque-source-reference>",
    "captured_at": "<RFC-3339-timestamp>",
    "derived_from": []
  },
  "provenance": {
    "origin": "AUTHORED_SEMANTIC_FIXTURE",
    "lineage_references": ["<source-or-parent-reference>"],
    "collection_policy_reference": "<policy-version>",
    "operator_reference": "<pseudonymous-or-system-reference>"
  },
  "consent": {
    "status": "NOT_REQUIRED",
    "purpose": ["EVALUATION"],
    "scope": "synthetic",
    "evidence_reference": null,
    "granted_at": null,
    "expires_at": null,
    "revoked_at": null
  },
  "privacy": {
    "privacy_class": "SYNTHETIC",
    "redaction_status": "NOT_NEEDED",
    "redaction_profile": "none",
    "retention_class": "DURABLE_GOVERNANCE_RECORD",
    "retain_until": null
  },
  "review": {
    "status": "REVIEWED",
    "reviewers": [
      {
        "reviewer_reference": "<pseudonymous-reviewer-reference>",
        "role": "BEHAVIOR_REVIEWER",
        "decision": "ACCEPTED",
        "reviewed_at": "<RFC-3339-timestamp>",
        "evidence_reference": "<review-record-reference>"
      }
    ],
    "decision_reference": "<review-decision-reference>"
  },
  "admissibility": {
    "status": "EVALUATION_ONLY",
    "policy_version": "<governance-policy-version>",
    "decision_reference": "<admissibility-decision-reference>",
    "reasons": []
  },
  "semantics": {
    "kind": "DEMONSTRATION",
    "payload_reference": "<redacted-or-approved-payload-reference>",
    "preference_rationale": null
  },
  "references": {
    "spec_refs": ["YUVI_BEHAVIOR_SPEC#<section-or-class>"],
    "eval_case_refs": ["YBE-<case-id>"],
    "failure_refs": [],
    "failure_attribution": null
  },
  "revision": {
    "revision_reason": "INITIAL",
    "supersedes": null
  }
}
```

### Required enums and meanings

`classification` is exactly one of:

- `CHARACTER_INVARIANT`: the behavior meaning should remain desirable when
  providers, models, tools, storage, Runtime internals, and devices change;
- `ENVIRONMENT_BOUND`: the item depends on a current environment or tests
  adaptation to supplied environment context. It is never directly eligible
  for a Character weight objective.

`source.source_type` is one of:

- `SYNTHETIC_FIXTURE`;
- `AUTHOR_AUTHORED`;
- `REVIEWED_EVAL_CASE`;
- `REVIEWED_OPERATIONAL_FAILURE`;
- `CONSENTED_USER_DEMONSTRATION`;
- `CONSENTED_USER_PREFERENCE_PAIR`;
- `MODEL_GENERATED_CANDIDATE`;
- `OPERATIONAL_TRACE`;
- `PRESENTATION_OR_DEVICE_OBSERVATION`;
- `PROVIDER_OR_RUNTIME_TRACE`;
- `RAW_PRIVATE_CONVERSATION`.

`consent.status` is one of:

- `NOT_REQUIRED`: only for synthetic or otherwise policy-approved non-personal
  authoring sources;
- `GRANTED`: explicit permission covers the recorded purpose and retention;
- `PENDING`: permission has not been verified;
- `DENIED`: permission was refused or cannot be established;
- `REVOKED`: previously granted permission was withdrawn;
- `EXPIRED`: permission's allowed period ended;
- `UNKNOWN`: evidence is insufficient.

`consent.purpose` contains one or both of `EVALUATION` and
`CHARACTER_TRAINING`. An item marked `ELIGIBLE_FOR_CHARACTER_TRAINING` must
have `CHARACTER_TRAINING` covered by `NOT_REQUIRED` policy or by explicit
`GRANTED` consent; evaluation consent alone is insufficient.

`privacy.redaction_status` is one of:

- `NOT_NEEDED`, `REQUIRED`, `IN_PROGRESS`, `COMPLETE`, `FAILED`, or `UNKNOWN`.

`privacy.privacy_class` is one of `SYNTHETIC`, `PUBLIC`, `USER_CONSENTED`,
`PRIVATE_UNCONSENTED`, `SENSITIVE`, or `UNKNOWN`. A private or sensitive
payload requires a complete redaction review and an applicable retention
decision before any use beyond controlled review.

`review.status` is one of `UNREVIEWED`, `IN_REVIEW`, `REVIEWED`, or
`REJECTED`; each reviewer `decision` is `ACCEPTED`, `REJECTED`, or
`NEEDS_ADJUDICATION`. A reviewer reference must identify a review record
without embedding a reviewer's personal information in the item.

`admissibility.status` is one of:

- `PENDING_REVIEW`: no use beyond controlled review;
- `EVALUATION_ONLY`: allowed for approved evaluation/failure analysis, not
  training;
- `ELIGIBLE_FOR_CHARACTER_TRAINING`: all gates below pass; this is a future
  eligibility state, not an instruction to train;
- `EXCLUDED`: intentionally unavailable for training or evaluation by policy;
- `REJECTED`: malformed, unsupported, unsafe, unreviewable, or otherwise
  invalid.

`admissibility.reasons` is empty only for an eligible item or an evaluation
item whose policy decision is fully recorded. When non-empty, reasons are
chosen from:

- `RAW_PRIVATE_CONVERSATION_DEFAULT`
- `CONSENT_MISSING`
- `CONSENT_DENIED`
- `CONSENT_REVOKED`
- `CONSENT_EXPIRED`
- `PRIVACY_UNREDACTED`
- `PRIVACY_REDACTION_FAILED`
- `UNREVIEWED`
- `MODEL_LABEL_ONLY`
- `ENVIRONMENT_BOUND_FOR_CHARACTER_TRAINING`
- `FAILURE_NOT_MODEL_BEHAVIOR`
- `MEMORY_RETRIEVAL_DEFECT`
- `PROMPT_OR_PROJECTION_DEFECT`
- `P8_INTERPRETATION_DEFECT`
- `RUNTIME_OR_LIFECYCLE_DEFECT`
- `HARNESS_OR_NORMALIZATION_DEFECT`
- `PROVIDER_TRANSPORT_DEFECT`
- `PRESENTATION_DEFECT`
- `OUT_OF_SCOPE`
- `INSUFFICIENT_CONTEXT`
- `DUPLICATE_OR_NON_DISTINCT`
- `CONFLICTING_PROVENANCE`
- `RETENTION_EXPIRED`
- `UNSAFE_OR_UNSUITABLE`
- `REQUIRES_ADJUDICATION`

## 5. Demonstrations and preference pairs

`semantics.kind` is exactly one of `DEMONSTRATION` or `PREFERENCE_PAIR`.

A `DEMONSTRATION` points to one reviewed target behavior for a bounded
semantic fixture. Its payload must identify the supplied context, the target
response or disposition, and the rationale for why the target satisfies the
referenced behavior contract. Exact wording is not a durable objective unless
the referenced behavior explicitly makes wording material.

A `PREFERENCE_PAIR` points to two alternatives evaluated against the same
authorized context:

```json
{
  "kind": "PREFERENCE_PAIR",
  "payload_reference": {
    "context": "<same-fixture-reference>",
    "chosen": "<approved-redacted-candidate-reference>",
    "rejected": "<approved-redacted-candidate-reference>"
  },
  "preference_rationale": "<reviewed semantic reason chosen is preferred>"
}
```

The pair must be comparable, must not differ because of an unapproved
environment detail, and must state whether the preference is about a
`CHARACTER_INVARIANT` or `ENVIRONMENT_BOUND` outcome. A preference for
verbosity, engagement, or provider-specific formatting is not a Character
invariant merely because a reviewer prefers it.

`MODEL_GENERATED_CANDIDATE` may supply either alternative or a draft rationale,
but an independent review must establish the final semantic judgment. A model
cannot approve its own output or turn its own repeated label into evidence.

## 6. Provenance, evaluation, and failure attribution

`references.spec_refs` identifies the durable behavior meaning. Each reference
must resolve to a versioned section or prohibited behavior class in
`YUVI_BEHAVIOR_SPEC`.

`references.eval_case_refs` identifies the evaluation case and version that
produced or motivated the item. `references.failure_refs` identifies the
redacted result or incident evidence. Both lists may be empty for an authored
synthetic demonstration, but they must not be invented to make an item appear
validated.

When `failure_refs` is non-empty, `failure_attribution` is required:

```json
{
  "primary_class": "MODEL_BEHAVIOR",
  "review_status": "REVIEWED",
  "review_reference": "<independent-review-reference>",
  "owner": "CHARACTER_MODEL",
  "notes_reference": "<redacted-attribution-notes>"
}
```

The allowed `primary_class` values are the Phase 8B attribution classes:
`MODEL_BEHAVIOR`, `PROMPT_OR_PROJECTION`, `MEMORY_RETRIEVAL`,
`P8_INTERPRETATION`, `RUNTIME_OR_LIFECYCLE`, `HARNESS_OR_NORMALIZATION`,
`PROVIDER_TRANSPORT`, `PRESENTATION`, and `UNKNOWN`.

Only `MODEL_BEHAVIOR` with `review_status=REVIEWED`, valid authorized context,
and a `CHARACTER_INVARIANT` classification may motivate a future Character
training item. Any other attribution is evaluation evidence for the owning
layer and must be marked `EVALUATION_ONLY` or excluded from training.

## 7. Admissibility gates

An item may use `ELIGIBLE_FOR_CHARACTER_TRAINING` only when all of the
following are true:

1. `classification` is `CHARACTER_INVARIANT` and its rationale survives
   provider/model/tool/device replacement;
2. the source and full lineage are recorded;
3. consent is `NOT_REQUIRED` under policy or `GRANTED` for the exact purpose,
   scope, and retention period;
4. privacy review is complete and `redaction_status=NOT_NEEDED` or `COMPLETE`;
5. the semantic payload is bounded, comparable, and linked to the behavior
   spec/eval when applicable;
6. a qualified reviewer has accepted the behavior meaning and any preference
   ordering; model-generated judgments alone do not satisfy this gate;
7. any failure attribution is reviewed `MODEL_BEHAVIOR`, not a defect owned by
   Memory, P8, Prompt, Runtime, Harness, provider transport, or Presentation;
8. no exclusion or rejection reason is present; and
9. the item version and dataset snapshot are immutable and reproducible.

Operational traces and real-use failures default to `EVALUATION_ONLY`. They
may become training-eligible only after an explicit policy decision creates a
reviewed, consented, redacted semantic item; the original trace does not become
training data by implication.

`ENVIRONMENT_BOUND` items may be retained for adaptation evaluation and
failure diagnosis. They must remain `EVALUATION_ONLY`, `EXCLUDED`, or
`REJECTED` for Character training, even when their output looks useful.

## 8. Privacy, consent, and retention handling

- Do not place raw private conversation, credentials, authorization headers,
  provider payloads, tool traces, or device identifiers in a durable item.
- Prefer synthetic fixtures and references to controlled, redacted payloads.
- A consent record must state purpose, scope, evidence reference, and any
  expiry. Consent for product operation or evaluation is not automatically
  consent for Character training.
- On revocation, expiry, or failed privacy review, create a superseding
  ineligible version immediately. Purge the protected payload when the
  applicable retention policy requires it while retaining only the minimum
  auditable decision metadata.
- Retention expiry creates an explicit exclusion/tombstone; it does not make
  the item silently disappear from the revision history.
- Access to any approved payload is governed by the applicable privacy policy;
  the dataset manifest stores references and decisions, not an unrestricted
  archive of conversations.

## 9. Revision and supersession rules

Each item version is append-only.

- A meaning change, label change, classification change, consent change,
  redaction change, review reversal, or admissibility change creates a new
  `item_version` with `revision.supersedes` pointing to the prior version.
- A purely representational correction still creates a new immutable version
  when it changes the digest or affects reproducibility. The revision reason
  must say what changed.
- When an item is withdrawn, create an `EXCLUDED` or `REJECTED` tombstone
  version with an explicit reason; do not delete the prior audit record.
- If one item is split into distinct meanings, create new `item_id` values and
  record the parent in each successor's `source.derived_from`. If items are
  merged, create a new item and record every parent in its lineage.
- A reverse `superseded_by` index may be derived from successor records, but
  an older immutable item must never be edited to add it. A history must never
  contain two active latest versions for one item identity.
- A dataset snapshot is immutable. Removing an item from a later snapshot
  requires a recorded exclusion or supersession decision.
- A schema-version change must document migration and compatibility. It must
  not silently reinterpret an existing item.

The latest eligible version is the only version a future training process may
consider, and only after the downstream phase gates are separately approved.

## 10. Minimal synthetic examples

These examples are abbreviated schema excerpts that illustrate the semantics;
they are not a training corpus and cannot be admitted without the full
canonical item fields and review records.

### Reviewed invariant demonstration

```yaml
item_id: YPD-RESP-001
item_version: 1
classification: CHARACTER_INVARIANT
source:
  source_type: SYNTHETIC_FIXTURE
  source_reference: fixture://yuvi/ordinary-bounded-response/v1
consent:
  status: NOT_REQUIRED
privacy:
  privacy_class: SYNTHETIC
  redaction_status: NOT_NEEDED
review:
  status: REVIEWED
admissibility:
  status: ELIGIBLE_FOR_CHARACTER_TRAINING
semantics:
  kind: DEMONSTRATION
references:
  spec_refs: [YUVI_BEHAVIOR_SPEC#5, YUVI_BEHAVIOR_SPEC#9]
  eval_case_refs: [YBE-RESP-001]
  failure_refs: []
```

### Operational failure kept evaluation-only

```yaml
item_id: YPD-OPS-001
item_version: 1
classification: ENVIRONMENT_BOUND
source:
  source_type: REVIEWED_OPERATIONAL_FAILURE
  source_reference: eval-result://redacted/2026-<run>
consent:
  status: GRANTED
  purpose: [EVALUATION]
privacy:
  privacy_class: USER_CONSENTED
  redaction_status: COMPLETE
review:
  status: REVIEWED
admissibility:
  status: EVALUATION_ONLY
  reasons: [PROVIDER_TRANSPORT_DEFECT]
references:
  spec_refs: [YUVI_BEHAVIOR_SPEC#11]
  eval_case_refs: [YBE-BOUND-001]
  failure_refs: [failure://redacted/001]
  failure_attribution:
    primary_class: PROVIDER_TRANSPORT
    review_status: REVIEWED
```

The second example can help fix or verify provider adaptation, but it cannot
teach the Character that a provider name or transport behavior is part of who
Yuvi is.

## 11. Phase 8C completion boundary

Phase 8C is complete when this schema and its governance rules make every
future item traceable to a stable behavior/eval meaning, distinguish
demonstrations from preference pairs, preserve consent/privacy/review state,
separate model failures from owner-layer defects, and make revision or
withdrawal auditable.

No corpus, ingestion service, labeling model, training runner, model bakeoff,
or deployment gate is required for Phase 8C. After this boundary, the next
activity is operational YUVI landing and controlled evaluation. Phases 9–13
remain deferred until the sustained real-use gate is met.
