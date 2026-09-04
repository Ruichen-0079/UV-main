# Atom 09 — Speaker-Aware STT Independent Input

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

Separate speech observation from semantic user interaction and carry
provider-neutral speaker clustering through the STT boundary without landing
durable person identity yet.

## Dependencies

Atom 08 for Runtime activity revision. Atom 05 for stable data roots where
sidecar state is involved.

## CURRENT at audit baseline

- `/v1/voice/message` transcribes and then creates
  `user.voice.transcript`, immediately calling `Runtime.handleUserMessage`.
- Current STT provider output has text/language/confidence and generic segments.
- The local sherpa-onnx sidecar already implements offline diarization,
  pyannote segmentation, speaker embeddings, enrollment, and identification.
- Its diarization information currently leaks through provider metadata rather
  than a typed provider-neutral speaker segment contract.
- Caller-supplied `speakerId` metadata is not proof of actual recognition.

## TARGET

Introduce first-class concepts equivalent to:

```text
SpeechActivity
- capture/session identity
- active/inactive or bounded activity observation

SpeechFinalObservation
- observation_id
- capture_epoch
- segment_id
- speaker_cluster_id
- transcript
- start/end time
- ASR confidence
- diarization evidence
- optional voice-profile match evidence reference
```

Exact type names may differ.

## Semantic rules

### VAD / partial

- may advance Runtime `activity_revision`;
- may suppress new proactive initiation;
- may revoke proactive speech later;
- must not enter Character;
- must not enter durable Memory;
- must not become `UserMessage`.

### Final

A final transcript is still an **observation**. It becomes a reactive
interaction only after interaction/addressing semantics admit it.

Do not overload the existing `user.voice.transcript` event to mean both
ambient observation and trusted user interaction. If compatibility requires
keeping it temporarily for explicit push-to-talk, make that limitation
explicit and introduce a distinct observation semantic for ambient/future
always-listening input.

## Speaker clustering

`speaker_cluster_id` is capture/session-local diarization identity. It is not a
person ID and must not be durable across sessions merely because the provider
uses labels like `0` or `spk_02`.

## Stale/duplicate fencing

- Every capture generation has a `capture_epoch`.
- Every final segment has a source-supplied or adapter-generated stable
  `segment_id`.
- Duplicate final callbacks with the same epoch/segment are idempotent.
- Equal transcript text is **not** a dedupe key.
- A late final from an obsolete capture epoch cannot enter a current
  interaction.

## Required constraints

- Reuse the existing local diarization engine rather than building another.
- Normalize provider output; do not put pyannote/sherpa wire DTOs in Runtime or
  Character contracts.
- No durable Memory writes from unresolved/ambient transcripts in this atom.
- No cluster→person resolution in this atom.
- No Voice Mode UI state machine in this atom.

## Acceptance

Tests cover:

- partial/VAD never reaching Character;
- final observation not automatically becoming UserMessage;
- two unknown speakers remaining distinct;
- duplicate finals;
- same text spoken twice as two valid segments;
- stale capture final rejection;
- typed local diarization output with no raw embedding leak.

## Stop condition

Stop when Runtime can receive speaker-aware speech observations safely while
all person identity remains unresolved/ephemeral.

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
