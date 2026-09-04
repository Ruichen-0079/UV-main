# Atom 08 — Runtime Proactive Policy and Web Authority Migration

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

Move semantic proactive eligibility/state ownership from Web/MainPage into the
single Runtime authority without yet binding the final proactive provider
scheduler.

## Dependencies

Atoms 06–07.

## CURRENT at audit baseline

P6 execution is Runtime-admitted, but semantic initiation is distributed across
Web/Companion pieces such as behavior policy, proactive eligibility, consent,
candidate dispatch, and MainPage request ownership.

Keeping that control plane while adding a Runtime scheduler would create two
proactive authorities.

## TARGET STATE

Only:

```text
ProactiveState
├─ suppression
│  ├─ NONE
│  ├─ UNTIL(time)
│  ├─ UNTIL_ENGAGEMENT
│  └─ UNTIL_EXPLICIT_RESUME
├─ eligible_after
└─ activity_revision
```

Operational timer handles and in-flight AbortControllers are implementation
state, not stable semantic fields.

## Semantics

- Any meaningful new input/activity that can stale proactive reasoning advances
  `activity_revision`.
- Quiet windows, cooldown after assistant output, Character defer, and future
  `NO_OP` backoff update `eligible_after` instead of adding separate
  timestamps.
- Proactive suppression is checked only on proactive initiation.
- Reactive user interaction always proceeds independently.

### Clearing suppression

- `UNTIL(time)`: expires by clock.
- `UNTIL_ENGAGEMENT`: clears only on an authorized explicit interaction that
  counts as engagement; VAD/ambient speech/TV do not count.
- `UNTIL_EXPLICIT_RESUME`: remains until an authorized explicit resume/control
  meaning is applied.
- An ordinary reactive request during `UNTIL_EXPLICIT_RESUME` is answered but
  does not implicitly resume proactive permission.

## Authorization

Character proposes proactive control meaning. Runtime applies it only if the
input principal is authorized to control YUVI's proactive policy.

Initial safe authority:

- primary user / explicitly trusted controller: allowed;
- other known people: no durable policy mutation unless explicitly configured;
- unresolved/ambient speakers: never.

Do not infer control authority from P8 intimacy/familiarity.

## Persistence

Suppression meanings that are intended to survive a process restart must survive
Runtime reload/restart through existing Runtime persistence coordination or the
smallest existing durable state primitive. They must not be stored as factual
Memory.

At minimum, an active `UNTIL_EXPLICIT_RESUME` or `UNTIL_ENGAGEMENT` must not
silently disappear merely because Runtime reloads.

## Web migration rule

This atom is an **authority switch**, not an additive layer:

1. introduce Runtime policy boundary;
2. route current Web inputs to it as observations/controls;
3. remove or demote Web semantic eligibility/state;
4. prove only Runtime can schedule/admit the future attempt.

Do not leave old and new independent gates alive.

## Acceptance

- Text interaction during suppression still works.
- Authorized “quiet 5 minutes” can respond immediately and suppress only future
  proactive initiation.
- Unauthorized third-party speech cannot change durable suppression.
- Existing P6 execution guarantees remain frozen.
- A reload test proves persistent suppression semantics where required.
- Main/Web no longer owns the semantic proactive timer/policy.

## Stop condition

Stop after Runtime owns policy/state and old Web authority is retired. Do not
bind Llama or start automatic provider calls yet.

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
