# Atom 12 — Memory Multi-Speaker Attribution and Provenance

> **Status: FUTURE PLAN — NOT IMPLEMENTATION AUTHORITY**
>
> **Audit baseline:** `2a3d4814a4763fb2772d275540bf21a3e645e324`
>
> The current `origin/main` source, tests, merged closure documents, and live
> dependency state are authoritative. Before implementation, fresh-fetch main,
> relevant files, relevant open PRs, and exact dependency state. Reclassify every
> important statement below as **CURRENT / PLANNED / GAP**. If main contradicts
> this plan, main wins and the plan must be updated rather than forcing old design
> into new code.
>
> This atom must remain the smallest behavior-preserving semantic change that
> satisfies its acceptance criteria. Do not create a second Runtime, second
> ledger, generic orchestrator/agent graph, provider router, giant event bus, or
> broad Manager/Engine abstraction merely to match this document.

## Goal

Make durable Memory capable of representing “who asserted what about whom,
from which observation” without confusing speaker, subject, participant, or
assistant inference.

## Dependencies

Atoms 09 and 11. Voice person resolution itself remains Atom 13.

## CURRENT at audit baseline

Memory already has substantial provenance, status, correction, contradiction,
supersession, identity metadata, and canonical `MemoryEvent` semantics.
However:

- canonical `participants` does not encode assertor vs subject;
- current ingestion largely assumes the user is the authoritative source class;
- legacy fields such as `createdByUserId`, `speakerId`, and
  `subjectUserId` exist but are not yet a complete multi-party claim model.

## TARGET CLAIM SEMANTICS

For a statement such as:

```text
小明：Ruichen 最近每天两点才睡。
```

the durable evidence must preserve conceptually:

```text
assertor = person_xiaoming
subject  = person_ruichen
claim    = "最近每天两点才睡"
provenance_class = EXTERNAL_CLAIM
verification = UNVERIFIED
source_observation = speech-segment/reference
```

It must not become “小明 sleeps at 2” or an unqualified “Ruichen sleeps at 2”.

## Minimum provenance classes

The canonical semantic layer must be able to distinguish at least:

- `SELF_REPORT`
- `EXTERNAL_CLAIM`
- `DIRECT_OBSERVATION`
- `ASSISTANT_INFERENCE`
- `UNKNOWN_AMBIENT`

Exact enum names may differ if existing types support equivalent semantics.

## Write policy

- Trusted self-report may become ordinary user-grounded evidence.
- Third-party claims remain third-party/hearsay evidence unless independently
  verified.
- Assistant inference is non-authoritative evidence and must not self-reinforce.
- Unresolved/ambient transcript is **not durable by default**.
- Merely appearing in `participants` never proves subject or assertor role.

## Wrong-attribution correction

Raw source observation is immutable evidence.

If later evidence proves the initial speaker attribution wrong:

1. preserve the raw observation;
2. supersede/retract the wrong attribution-derived Memory evidence;
3. create corrected attribution/evidence with provenance;
4. let P8 reconstruct from currently eligible evidence.

Do not edit history in place and do not rely on last-write-wins.

## Required constraints

- Extend existing Memory/MemoryEvent semantics; do not create a second evidence
  store.
- P8 remains identity/persona interpretation authority.
- Do not introduce a generic knowledge graph merely to represent assertor and
  subject.
- Numeric confidence alone cannot upgrade hearsay to verified truth.

## Acceptance

Tests cover:

- self-report;
- third-party claim about primary user;
- third-party claim about another third party;
- assistant inference;
- unresolved ambient speech rejected from durable write by default;
- wrong-speaker correction and supersession;
- historical provenance still auditable after correction.

## Stop condition

Stop once the durable evidence model can safely express multi-speaker claims.
Do not bind acoustic identities to people yet.

## Mandatory implementation start protocol

1. Fresh-fetch current `main`, the exact files this atom touches, relevant open
   PRs/branches, and tests.
2. Record the exact base SHA before changing anything.
3. Confirm predecessor atoms on which this plan depends are actually merged or
   re-evaluate the dependency.
4. Keep provider/device/wire details outside stable Character/Cognition/P8
   semantics unless this atom explicitly owns that boundary.
5. Implement one immutable atom, run focused tests plus required broader gates,
   inspect exact diff, then stop at this atom's stop condition.
