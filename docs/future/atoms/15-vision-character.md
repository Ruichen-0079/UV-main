# Atom 15 — On-Demand Visual Grounding

> **Status: REBASELINED FUTURE PLAN — NOT IMPLEMENTATION AUTHORITY**
>
> **Rebaseline:** 2026-09-06
>
> The current `origin/main` source, tests, merged closure documents, and live
> dependency state are authoritative. Before implementation, fresh-fetch main,
> relevant files, relevant open PRs, and exact dependency state. Reclassify every
> important statement below as **CURRENT / PLANNED / GAP**. If main contradicts
> this plan, main wins.

## Goal

YUVI does not continuously perceive or maintain an interpretation of the
desktop. When Character/Cognition cannot continue an interaction without
current-screen evidence, it may request one bounded, question-conditioned visual
grounding operation through Runtime.

The intended flow is:

```text
Character / Cognition
  → VisualGroundingRequest
  → Runtime semantic capability seam
  → one-shot current-screen capture
  → visual grounding provider
  → question-conditioned evidence
  → resume the existing interaction
```

This is a semantic evidence capability, not a second multimodal agent and not a
background perception subsystem.

## Explicitly rejected

Do not implement any of the following as part of Atom 15:

- continuous VLM observation;
- periodic screenshot interpretation;
- CPU screen-change monitoring;
- persistent `VisualState`;
- scene-mode detection such as "paper mode", "game mode", or "coding mode";
- a classifier that chooses the visual prompt;
- automatic output-complexity classification;
- a vision-specific reasoning router;
- ambient screen observations that independently create user turns or proactive
  speech;
- durable Memory writes from screen evidence by default.

If a future user-facing requirement genuinely needs continuous perception, it
requires a fresh atom and new evidence; Atom 15 is not permission to prebuild it.

## Minimal semantic contract

The stable contract should remain provider/device neutral and no larger than the
current consumer requires. A first implementation may use:

```ts
type VisualWorkload =
  | "overview"
  | "read"
  | "ui"
  | "code"
  | "chart"
  | "game"
  | "locate";

interface VisualGroundingRequest {
  workload: VisualWorkload;
  query: string;
}

interface VisualGroundingResult {
  evidence: string;
  capturedAt: number;
  captureId?: string;
}
```

The upper layer must not learn DeepInfra, model names, HTTP/SDK payloads, JPEG
details, Wayland APIs, image-token accounting, or provider response JSON.

Do not add structured result fields merely because they might be useful later.
Natural-language evidence is acceptable until a proven consumer needs more
structure.

## Workload selection

There is no separate workload classifier.

The requesting language model already knows what information is missing and
selects the workload while creating the request. The workload is a small prompt
specialization, not an inferred desktop mode.

Examples:

```text
workload: read
query: Find the formula the user is referring to and transcribe it accurately
       with the nearby context required to explain it.
```

```text
workload: code
query: Extract the visible code, terminal output, and diagnostics relevant to
       the reported error.
```

## Question-conditioned grounding

The common provider instruction should follow this principle:

```text
You are the visual grounding layer for another language model.

Inspect the current screenshot specifically for the information needed
to answer the supplied query.

Extract all relevant visible evidence accurately and with sufficient detail.
Preserve exact text, numbers, formulas, labels, spatial relationships,
UI state, and other details when relevant.

Do not attempt to answer the user's underlying question.
Do not infer facts that are not visually supported.

Query:
{query}
```

A workload may append narrow domain guidance, for example chart axes/legend or
code/terminal diagnostics. It must not ask the provider to summarize everything
that might become useful later.

## Ownership split

### Semantic layer

Character/Cognition may identify missing visual evidence and issue the typed
request. Runtime authorizes and executes the capability. Visual evidence then
returns to the existing interaction.

### Desktop layer

Desktop infrastructure owns only a one-shot current-screen capture primitive.
It may provide capture timestamp/ID and necessary encoding. It does not decide:

- when visual evidence is needed;
- which workload applies;
- what the screen "means";
- whether YUVI should respond.

### Provider layer

The visual provider receives the current capture plus the bounded
question-conditioned prompt and returns evidence. Provider metadata stays
outside stable Character/Cognition/P8 contracts.

## Freshness

Start conservatively:

- reuse the same capture within one active grounding operation or turn when safe;
- across turns, capture again by default.

A later short-TTL cache may be added only if a concrete latency/cost measurement
justifies it. A cache is freshness optimization, not persistent visual state.

## Interaction and Memory invariants

- No visual request means no screenshot/VLM work.
- Visual evidence is context, not an independently admitted user interaction.
- Visual grounding cannot directly authorize Presentation output.
- Existing Runtime reactive/proactive authority remains unchanged.
- Screen evidence does not become durable Memory by default.
- Explicit user-provided images may continue through the existing media path;
  they do not justify ambient or continuous desktop perception.

## Acceptance

A minimal implementation must prove:

1. no capture or provider call occurs without an explicit semantic grounding
   request;
2. the request chooses one bounded workload and carries the actual question;
3. one-shot capture is fenced to the current request/turn;
4. evidence preserves relevant visible text/numbers/formulas/UI state without
   claiming unsupported facts;
5. provider/device/wire metadata does not enter stable semantic contracts;
6. unknown/unavailable visual capability fails truthfully;
7. no `VisualState`, continuous monitor, scene classifier, or automatic prompt
   classifier is introduced;
8. no durable Memory write occurs by default.

## Implementation decomposition

Do not implement this as one giant atom.

1. **Semantic seam:** request/result contract and Runtime capability boundary,
   without screenshot or provider integration.
2. **Desktop capture primitive:** one-shot KDE/Wayland screenshot only.
3. **Integration:** current capture + provider + workload prompt + evidence
   return, with focused end-to-end tests.

Stop after each smallest independently testable step.

## Mandatory implementation start protocol

1. Fresh-fetch current `main`, this plan, relevant open PRs/branches, and exact
   tests.
2. Record exact base SHA.
3. Classify existing vision/media/capture behavior as
   `REUSE / ADAPT / GAP / REJECT`.
4. Prefer existing Runtime/Desktop/provider seams over new abstractions.
5. Implement one immutable atom, run focused tests plus required broader gates,
   audit the exact diff, and stop at that atom's acceptance boundary.
