# Atom 10 — Proactive Provider Binding and Single Runtime Scheduler

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

Turn Runtime-owned proactive policy into the one automatic proactive scheduler,
using deterministic hard gates, the existing P6-compatible decision provider,
and commit-time revalidation.

## Dependencies

Atoms 08–09.

## Provider topology

Planned semantic flow:

```text
Runtime eligibility
→ ProactiveDecisionProvider (Llama 3.3 70B class)
   → NO_OP
   → REQUEST_TEXT
        ↓
     DeepSeek-class assistant continuation
        ↓
     Runtime revalidation
        ↓
     commit or DROP
```

The decision vocabulary remains exactly `NO_OP | REQUEST_TEXT`.

## Hard gates before decision-provider call

No proactive provider call if any is true:

- an explicit turn is active;
- speech activity is currently active;
- an admitted assistant speech effect is active;
- a proactive request is already running;
- proactive suppression is active;
- `now < eligible_after`.

Prefer deriving “assistant speaking” and “request in flight” from existing
Runtime/effect ownership rather than storing duplicate booleans.

## Fencing

At admission:

```text
candidate_revision = activity_revision
```

Before every user-visible commit, verify at least:

- revision unchanged;
- no user speech/activity superseded the candidate;
- no new explicit turn superseded it;
- suppression is still clear;
- output/effect admission is still valid.

Mismatch means **STALE → DROP**. Do not ask a model whether stale work is still
okay.

## NO_OP and cooldown

`NO_OP` produces no assistant message and no fake conversation turn. It must
advance `eligible_after` using a deterministic backoff so the scheduler does
not hot-loop tokens.

After a successful proactive emit, reactive assistant speech, or other
configured quieting event, update `eligible_after`; do not accumulate
last-event timestamps just for cooldown.

## Provenance

A proactive assistant message must be representable as assistant-originated
with:

- cause/origin = proactive/assistant-initiated;
- proactive decision identity;
- source context/activity revision.

Do not synthesize `user = idle timeout`.

## Required constraints

- One Runtime scheduler only.
- Web/Companion may render state but cannot start an independent semantic
  attempt.
- No proactive Memory-write authority.
- No proactive tool/capability authority.
- No generic scheduler/priority framework.
- Provider fallback mechanics stay in existing provider infrastructure.

## Acceptance

Race tests cover:

- VAD during Llama;
- VAD during DeepSeek continuation;
- explicit text during generation;
- suppression changed during generation;
- repeated `NO_OP`;
- overlapping scheduler wakeups;
- no duplicate proactive emission;
- provenance without synthetic user events.

## Stop condition

Stop when bounded proactive text automatically runs under one Runtime scheduler
with exact P6 semantics and revision fencing. Voice barge-in rendering belongs
to Atom 14.

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
