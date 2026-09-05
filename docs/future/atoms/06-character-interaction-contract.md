# Atom 06 — Character Interaction Contract vNext

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

Extend the stable Character result so response disposition, addressing
interpretation, and proactive policy suggestion are explicit and orthogonal.

This atom fixes the current semantic loss where Character meaning is eventually
collapsed to a text string.

## CURRENT at audit baseline

- Character ABI has first-class `RESPOND | SILENCE | TERMINATE |
  NEED_COGNITION`.
- The server Character adapter currently converts `SILENCE` and
  `TERMINATE` to `content: ""` before Runtime sees the result.
- Character does not yet have a stable proactive-effect result.
- Current text UI inputs are explicitly directed to YUVI; future multi-speaker
  speech may not be.

## TARGET

Conceptual minimum:

```text
CharacterDecision
├─ addressing
│  ├─ DIRECTED_TO_YUVI
│  ├─ NOT_DIRECTED
│  └─ AMBIGUOUS
├─ reply
│  ├─ RESPOND(text, presentation?)
│  ├─ SILENCE
│  ├─ TERMINATE
│  └─ NEED_COGNITION(focus?)
└─ proactive
   ├─ KEEP
   ├─ CLEAR
   ├─ DEFER(SHORT | NORMAL | LONG)
   └─ SUPPRESS(
        UNTIL(time)
        | UNTIL_ENGAGEMENT
        | UNTIL_EXPLICIT_RESUME
      )
```

Exact wire syntax may differ, but these meanings and their orthogonality must
survive.

## Input boundary

Character may receive an already-authorized speaker/person projection and
source context. It must **not** resolve durable person identity.

Explicit text surfaces may supply a trusted constraint that the current input
is directed to YUVI; Character must not invent ambiguity where the transport
already proves direct addressing.

## Authority

Character owns the social/interaction **proposal**:

- who appears to be addressing YUVI;
- whether to respond, remain silent, terminate, or request Cognition;
- whether the interaction semantically requests keeping, clearing, deferring,
  or suppressing future proactive initiation.

Runtime decides whether a proposed proactive control is authorized for the
speaker/principal and applies state. Character cannot mutate policy directly.

## Required constraints

- Do not put `speaker_identity`, voiceprint, provider, device, timer handle, or
  Runtime revision into the stable Character result.
- Do not add arbitrary addressee person graphs. The stable runtime need only
  distinguish directed-to-YUVI / not-directed / ambiguous for now.
- Preserve current four reply dispositions rather than inventing a parallel
  response enum.
- `RESPOND + SUPPRESS_UNTIL(...)` must be representable.
- `SILENCE + KEEP` must be representable.
- Proactive suppression semantics cannot alter current reactive admission.

## No persistent semantic outcome

Do not create a persisted InteractionOutcome ledger, table, or event system for
`SILENCE`/`TERMINATE`. This atom defines only the Character semantic result.
Future Runtime may explicitly consume `RESPOND | SILENCE | TERMINATE |
NEED_COGNITION` during execution, but conversation history does not record
`OUTCOME=SILENT`-style state and no empty assistant message is written.
History describes facts that happened, not the Runtime state machine; any
narrative projection (for example "the character did not reply") remains
out of scope here.

## Acceptance

Contract tests prove all orthogonal combinations that matter, especially:

- “安静五分钟” → a normal bounded reply may coexist with timed suppression;
- a new explicit request during that period still reaches Character;
- unrelated third-party conversation can produce `NOT_DIRECTED + SILENCE +
  KEEP`;
- `NEED_COGNITION` remains coarse and contains no provider/tool selection.

## Stop condition

Stop when the stable Character/Harness-facing semantic result is defined and
lossless. Do not migrate Runtime sequencing or proactive timers in this atom.

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
