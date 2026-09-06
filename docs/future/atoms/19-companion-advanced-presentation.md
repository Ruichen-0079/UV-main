# Atom 19 — Companion Advanced Presentation

> **Status: SLICE 1 IMPLEMENTED — broader presentation remains planned**
>
> **Audit baseline:** `575bfa2`
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

Improve Companion embodiment—gaze, expression, pose, motion, speech-linked
behavior—using existing Phase 7 admitted Presentation semantics, without
creating new agency or attention truth.

## Dependencies

Atoms 14 and 18 where voice/subtitle coordination matters.

## CURRENT at audit baseline

Phase 7 already has Runtime-owned embodied effect identity, admission,
Presentation requests, outcome acceptance, monotonic lifecycle state, and
`INTERRUPTED`.

## TARGET

Advanced Companion rendering consumes already-admitted semantic Presentation
intent and device-neutral effect identity.

Examples of permitted Presentation work:

- gaze target execution;
- expression/pose mapping;
- motion playback;
- speech-linked lip/motion timing;
- graceful interruption/fade;
- hidden-window pause/resume behavior.

## Required constraints

Presentation must not infer:

- whether YUVI should speak;
- whether the user deserves attention;
- relationship/intimacy state;
- proactive eligibility;
- Cognition need.

Random idle animation remains non-semantic presentation. It must not be
published as “YUVI decided to act”.

Do not create a second embodied lifecycle; reuse Phase 7 effect state and
outcome reporting.

## Acceptance

Tests prove admitted intent renders, stale/foreign effect identity is ignored,
interruptions report correctly, hidden/closed Companion does not corrupt
Runtime effect truth, and no Presentation action writes Memory/P8.

## Stop condition

Stop after advanced device behavior is reliable. Calibration/tuning of a
specific Live2D model belongs to Atom 20.

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


## Slice 1 closure (Campaign A, 2026-09-06)

PR #263 is rebaselined on the merged Product WebUI and Output Language work.
Main forwards validated Runtime Presentation requests through the same shared
WebSocket subscription used by Developer. Companion executes admitted
`soft-smile` through the existing Live2D adapter and reports `STARTED` with the
same effect ID. The provisional `ParamMouthForm` value is **1**, not the older
0.4 described in the initial PR. Unknown expressions are rejected. A loading,
failed, or disposed model reports `REJECTED`, never a fictitious `STARTED`.
Closed subscriptions ignore late events, including React StrictMode cleanup.

Audio lip-sync owns mouth opening only; constructor, playback frames, stop, and
disposal do not reset expression mouth form. Idle blink/breath does not own it.
The existing Runtime admission and outcome lifecycle remain authoritative.

Validation includes mounted Main WebSocket-to-Companion forwarding, malformed
request filtering, controller readiness/failure/disposal, exact effect identity,
unknown-expression rejection, and lip-sync non-interference, plus full workspace
checks/tests, production web build, smoke, and hosted CI.

Only perceived smile strength/quality needs a final human visual pass. Atom 20
calibration remains deferred. Broader expression/pose/motion, interruption/fade,
hidden-window behavior, and richer completion reporting remain future slices;
this closure does not claim the full Atom 19 acceptance above.
