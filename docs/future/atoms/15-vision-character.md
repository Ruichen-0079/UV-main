# Atom 15 — Vision to Character

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

Route normalized vision evidence through the same Character/Cognition/Runtime
semantic authority without creating an independent multimodal agent or a hidden
proactive bypass.

## Dependencies

Atoms 06–07. If ambient vision can trigger initiative, Atom 10 must also be
merged.

## CURRENT at audit baseline

Current main exposes vision provider/media capability and perception events.
Open #223 is a candidate Vision→Character implementation and is not authority.

## Two input classes

### Explicit user image

A user explicitly sending an image is a reactive interaction:

```text
explicit image
→ Runtime
→ normalized vision evidence
→ Character
→ optional NEED_COGNITION
→ Runtime commit
```

### Ambient camera/screen observation

Ambient vision is observation/context only:

```text
ambient vision
→ bounded observation/context
```

It cannot directly manufacture a reactive user turn or independently admit
assistant speech.

If ambient vision eventually motivates YUVI to speak, it becomes context for the
single Runtime proactive pipeline:

```text
ambient evidence
→ proactive policy/context
→ deterministic gates
→ NO_OP | REQUEST_TEXT
→ revalidation
```

## Normalized evidence

Character must receive provider-neutral bounded meaning such as description,
objects/scene summary, confidence/epistemic state, and provenance reference.
Provider HTTP/SDK/raw JSON/model names remain outside the stable Character
contract.

## Memory

Ambient/uncertain vision does not become durable Memory by default. Any later
durable observation write must go through existing Memory authority and
provenance rules.

## Required constraints

- No generic multimodal orchestrator.
- No Vision→Presentation direct semantic shortcut.
- Vision provider cannot decide response-worthiness.
- Character may request Cognition; it does not invoke a vision-specific
  reasoning router.
- Current proactive authority remains single.

## Acceptance

Tests cover explicit image response, silence, NEED_COGNITION, low-confidence
vision, unavailable vision, stale/cancelled image work, ambient observation not
creating a fake user turn, no Memory write by default, and no provider metadata
leak into Character semantics.

## Stop condition

Stop when explicit vision participates in normal interaction and ambient vision
is safely observational.

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
