# Atom 07 — Runtime Character Outcome and Cognition Sequencing

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

Make Runtime consume the full Character semantic decision and own the bounded
`NEED_COGNITION → Cognition → Character re-entry` sequencing.

## Dependencies

Atom 06.

## CURRENT at audit baseline

The server Character adapter currently receives a Runtime callback
(`executeCognition`) and internally performs the cognition round-trip before
returning only text/provider metadata. Runtime therefore owns provider execution
but cannot observe the complete semantic sequence at each async boundary.

## TARGET

```text
Runtime
→ Character pass
→ CharacterDecision
   ├─ RESPOND / SILENCE / TERMINATE
   └─ NEED_COGNITION
        ↓
      Runtime executes existing bounded Cognition
        ↓
      NormalizedCognitionResult
        ↓
      Character re-entry
        ↓
      final RESPOND / SILENCE / TERMINATE
→ Runtime commits final outcome
```

The existing single ReasoningProvider and current Cognition normalization seam
remain authoritative.

## Silent/terminated turns

A silent or terminated Character outcome must be auditable without publishing a
fake empty assistant message.

Use the smallest extension of existing conversation/Runtime event semantics
that can distinguish:

- successful response with text;
- intentional silence;
- intentional termination;
- cancelled/stale/failed generation.

Do **not** create a second ledger. The finalized-ingestion ledger remains for
its current Memory-delivery purpose and should not become a universal
interaction ledger.

## Required constraints

- Runtime may sequence work; it does not decide Character semantics.
- Cognition cannot return a final character voice directly.
- Post-Cognition Character re-entry cannot request unbounded recursive
  Cognition.
- Preserve existing one-round/bounded Cognition and capability containment.
- Every provider call must remain cancellable under the current turn.
- Do not expose provider/tool wire metadata to Character.

## Acceptance

- Runtime can branch on final `SILENCE` and `TERMINATE` without checking
  whether text is empty.
- `NEED_COGNITION` is visible to Runtime before Cognition execution.
- Cancellation between initial Character, Cognition, and re-entry cannot commit
  stale output.
- Intentional silence is not misclassified as provider failure or an empty
  assistant message.
- Existing Cognition result normalization and capability tests remain valid.

## Stop condition

Stop once Runtime owns the explicit bounded sequence and the old hidden
Character-side orchestration is retired.

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
