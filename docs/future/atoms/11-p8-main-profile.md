# Atom 11 — P8 Main-Profile Projection

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

Land a bounded current-profile projection that prevents corrected/superseded
evidence from re-entering as strong current P8 meaning through a different
interpretation path.

## Dependencies

Existing P8 1A–1F semantics on current main. This atom is independent of Voice
Identity.

## CURRENT at audit baseline

Open #224 is a candidate implementation and reports a concrete gap:
P8 correction records can name superseded evidence, while another uncorrected
interpretation sharing that evidence may still surface as `KNOWN`. Revalidate
against current main before implementation.

## TARGET

A pure bounded profile reconstruction layer over existing P8 primitives.

It must preserve:

- exact identity/scope addressing;
- Memory-owned evidence authorization;
- correction precedence and lineage;
- authored-invariant precedence;
- provenance;
- epistemic states;
- no affinity/intimacy/mood scalars.

## Required semantics

At minimum:

- evidence superseded by the winning correction cannot independently support
  another `KNOWN` current interpretation in the same profile;
- downgrade rather than destructively delete when history/provenance remains
  useful;
- recent-conversation-only evidence cannot silently become durable strong
  profile truth;
- explicit correction-authoritative meanings remain authoritative even when
  their representation has no ordinary evidence link;
- `UNAVAILABLE` and `ERROR` remain fail-closed and distinct;
- conflicting equal-authority corrections remain conflicting unless explicit
  lineage resolves them.

## Required constraints

- No second Memory query.
- No retrieval/ranking engine.
- No LLM call.
- No generic ProfileManager.
- No voiceprint, diarization, or speaker binding.
- No hidden scalar relationship state.

## Acceptance

Focused pure tests must include superseded-evidence re-entry, recent-only
evidence, conflicting corrections, scope isolation, authored invariants,
unavailable/error access, and unchanged base P8 behavior.

## Stop condition

Stop once current profile reconstruction is safe and bounded. Do not implement
multi-speaker attribution or Voice Identity here.

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
