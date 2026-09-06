# Atom 18 — Subtitle Surface

> **Status: DONE — IMPLEMENTED ON CURRENT MAIN**
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

Add Subtitle as a Presentation/Desktop surface that renders admitted assistant
output without gaining conversation, language, or TTS authority.

## Dependencies

**Historical plan:** Atoms 03 and 17; Atom 14 if subtitle behavior is
synchronized with interruptible voice playback.

**Rebaseline (implementation):**

- Atom 03 — **hard dependency, already DONE** (DesktopSurfaceManager seam).
- Atom 17 — **NOT a hard dependency**. It is now DONE separately. Subtitle
  displays already-committed assistant text as-is through
  `projectCommittedAssistantText` (plain-text projection only). It does not
  choose, translate, or normalize output language.
- Atom 14 — **deferred**. No safely productized barge-in
  STARTED/COMPLETED/INTERRUPTED subtitle sync is consumed. Timing uses
  deterministic length/punctuation heuristics only. INTERRUPTED is not faked.

## TARGET

`Subtitle` is another DesktopSurface managed by the existing surface
infrastructure.

It may consume:

- committed assistant text;
- optional sentence/chunk timing from Presentation;
- speech effect lifecycle for display timing;
- explicit user visibility/settings.

It must not create or mutate:

- assistant semantic messages;
- output language;
- Character disposition;
- proactive permission;
- TTS admission;
- Runtime effect state.

## Interruption semantics

If speech is interrupted, Subtitle may stop timed progression or change its
presentation according to UX, but it cannot erase the already committed
assistant message from conversation history.

If future UX wants subtitles for partial/uncommitted generation, that must be a
separate explicitly labelled transient rendering path and must not masquerade as
committed text.

## Required constraints

- Reuse DesktopSurfaceManager.
- No SubtitleManager with independent semantic lifecycle.
- No speech-to-subtitle Memory writes.
- No language detection/translation authority.

## Acceptance

Tests cover show/hide/close behavior, committed text rendering, and proof that
subtitle closure does not affect Runtime or Supervisor lifecycle. Atom 14 TTS
STARTED/COMPLETED/INTERRUPTED synchronization is deferred explicitly.

## Stop condition

Stop when Subtitle is a faithful output surface.

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

## Closure (implemented)

**Status: DONE.** Implementation base: 13fa3d4e1784a919c776ff9d05270e81258df3b9.

Topology: Main | Companion | WebUI | Subtitle via DesktopSurfaceManager; Quit unchanged.
Chain: committed assistant output -> projectCommittedAssistantText -> yuvi-subtitle-projection-v1 -> SubtitlePage.
Committed path only; empty/code/table project to nothing; pagination reconstructs projected text; Memory writes NONE.
Atom 14 STARTED/COMPLETED/INTERRUPTED sync deferred; Atom 17 reclassified not required.
Lazy ensure; close-as-hide; Subtitle show without set_focus; overlay window policy (transparent, decorationless, always-on-top, fixed, skip_taskbar, click-through).
Tray: Show Subtitle / Hide Subtitle. Visual: lower-center 1-3 line band. Atoms 19/20 untouched.
