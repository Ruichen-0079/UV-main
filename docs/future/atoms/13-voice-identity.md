# Atom 13 — Voice Identity

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

Resolve speaker observations to known people using evidence-grounded P8
semantics without turning diarization labels or biometric similarity into
person truth.

## Dependencies

Atoms 05, 09, 11, and 12.

## CURRENT at audit baseline

The local STT sidecar already has a durable `SpeakerStore` containing labels,
enrollment times, and speaker vectors plus threshold-based matching. It does not
return raw embeddings over HTTP, which is a useful privacy invariant.

For future architecture, that store must be interpreted as an **acoustic
template / voice-profile store**, not a person database.

## Identity layers that must remain distinct

```text
speaker_cluster_id   // ephemeral diarization cluster
voice_profile_id     // durable acoustic template reference
person_id            // P8/person semantic identity
display_name         // presentation label
```

None is a synonym for another.

## TARGET RESOLUTION

P8-facing resolution should expose bounded meaning equivalent to:

- `RESOLVED_TRUSTED`
- `RESOLVED_SUPPORTED`
- `UNRESOLVED`
- `CONFLICTING`

with provenance/evidence references.

Raw numeric similarity scores may remain diagnostics/evidence but are not the
semantic authority state.

## Evidence precedence

Initial ordering:

1. trusted explicit user assignment/enrollment;
2. durable strong consistent identity evidence;
3. repeated consistent observations;
4. contextual inference;
5. model guess.

Levels 4–5 are ephemeral by default and cannot create durable identity
bindings.

A statement such as “我是马斯克” is evidence that the speaker **claims** that
identity, not automatic identity truth.

## Unknown speakers

Multiple unresolved clusters in the same capture remain distinct.

UI may project:

- Unknown A
- Unknown B

but these are display aliases only. Never persist one global “Unknown” person
that merges unrelated speakers.

## Correction

Explicit trusted correction of a wrong person binding must supersede the
derived attribution/evidence path while preserving the original acoustic/source
observation for audit.

## Required constraints

- P8 owns person-resolution meaning.
- Memory owns durable evidence/provenance.
- STT sidecar owns only acoustic computation/template mechanics.
- Character consumes resolved/unknown context but does not decide person truth.
- Raw embeddings remain local, access-restricted, and absent from logs/provider
  metadata/Character prompts.
- No relationship scalar may influence identity matching authority.

## Acceptance

Tests cover trusted enrollment, supported match, below-threshold unknown,
conflicting evidence, two unknown speakers, false self-identification claim,
wrong binding correction, restart of durable voice-profile state, and no raw
embedding leakage.

## Stop condition

Stop when a speech observation can safely project a person identity or explicit
unknown state. Do not implement hands-free Voice Mode here.

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
