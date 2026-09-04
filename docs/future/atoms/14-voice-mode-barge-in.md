# Atom 14 — Voice Mode and Barge-In

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

Provide production voice interaction—capture, STT, normal Runtime interaction,
assistant speech, and interruption—without creating a Voice Runtime or second
turn authority.

## Dependencies

Atoms 07–10 and 13.

## CURRENT at audit baseline

Open #225 is a candidate hands-free Voice Mode implementation with a Web-side
state machine and race fencing. It is not main authority and predates the full
future Character/STT/proactive ownership sequence. Reuse proven pieces only
after re-audit.

## TARGET FLOW

```text
mic
→ VAD / capture
→ speaker-aware STT observation
→ interaction/addressing decision
→ normal Runtime reactive turn
→ Character / optional Cognition
→ committed assistant result
→ Runtime-admitted TTS/Presentation effect
→ playback
```

The UI/adapter may maintain device states such as recording/transcribing, but
those states do not own semantic turns.

## Priority

```text
explicit user input > proactive output
```

No generic PriorityScheduler is authorized.

A new explicit turn may also cancel an older **uncommitted** reactive turn under
the existing turn/cancellation semantics, but already committed assistant text
is history and is not erased merely because its TTS is interrupted.

## Barge-in

If user speech begins while assistant speech is active:

1. Runtime receives speech activity;
2. proactive/unwanted active speech effect is revoked under existing ownership;
3. Presentation stops or fades output;
4. Presentation reports `INTERRUPTED`;
5. microphone/listening continues;
6. a later final speech observation enters the normal interaction path.

Reuse the Phase 7 embodied effect states
`ADMITTED → STARTED → COMPLETED|FAILED|INTERRUPTED`.

## Critical race requirements

Cover:

- VAD during proactive generation;
- VAD during proactive TTS;
- VAD during reactive TTS;
- final STT while old TTS cancellation is still settling;
- duplicate final transcript;
- stale final from old capture epoch;
- TTS `COMPLETED` arriving after Runtime already accepted
  `INTERRUPTED`;
- user starts new input after assistant text commit but before speech finishes;
- capture/STT callback after component/session disposal;
- speech activity stuck active.

Existing monotonic Runtime effect transition semantics must reject contradictory
late Presentation outcomes.

## Self-echo / AEC requirement

Voice Mode must explicitly address assistant audio re-entering the microphone.
Use mature browser/OS acoustic echo cancellation and/or a playback-reference
strategy where available.

YUVI must not interrupt itself or transcribe its own TTS as user speech merely
because VAD detects playback leakage.

## TTS ownership

Runtime owns effect admission/revocation. Presentation owns synthesis/playback
mechanics and reports outcomes. Presentation cannot decide conversation
priority or semantic completion.

## Required constraints

- No Voice Runtime/Voice Agent.
- No second ledger.
- No duplicate TTS path between Main and Companion.
- No voice-specific Memory bypass.
- No identity resolution in UI.
- No proactive suppression logic in the voice controller.

## Acceptance

End-to-end tests prove one normal hands-free turn, barge-in of proactive and
reactive speech, no self-echo loop under supported AEC test conditions, stale
STT fencing, monotonic interrupted TTS lifecycle, and preservation of committed
conversation text.

## Stop condition

Stop when voice is a reliable input/output adapter over existing Runtime
semantics. Do not add advanced Companion motion here.

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
