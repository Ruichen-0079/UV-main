# Atom 04 — WebUI Surface

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

Add WebUI as one additional desktop Presentation surface using the foundation
from Atom 03.

## Dependencies

Atom 03.

## CURRENT at audit baseline

- #221 attempted bundled WebUI tray behavior and is closed/unmerged.
- Its branch is historical evidence only; do not resurrect its architecture
  wholesale.
- Current main has Main and Companion windows.

## TARGET

Add a `WebUI` surface to the existing DesktopSurface abstraction and expose
the smallest truthful tray/user action needed to show it.

The URL/route must be chosen from a route that actually exists on current main
at implementation time. If no product WebUI route exists, stop as blocked
rather than inventing a second web application.

## Required constraints

- WebUI is Presentation infrastructure only.
- It may observe/control Runtime only through supported APIs.
- No duplicated chat/proactive/Memory authority in the new window.
- Do not alter Quit.
- Do not add Subtitle in this atom.
- Do not copy old #221 code merely because names match.

## Acceptance

- WebUI can be ensured/shown/hidden through the same surface path as Main and
  Companion.
- Closing it follows the explicitly chosen surface lifecycle and does not shut
  down Runtime unless current product requirements say otherwise.
- Existing surfaces remain unchanged.
- Packaged desktop smoke covers the new surface enough to prove routing.

## Stop condition

Stop when WebUI is a truthful additional surface. Do not add product features
inside it in this atom.

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

**Status: DONE.** Implementation base: `24c8816b775c729936dcf36f5e91cd9697b63cad`.

Current main has a real product WebUI in `apps/web/src/App.tsx`, reachable via
the existing `index.html#/dashboard` route. Atom 04 adds it as the third
desktop Presentation surface through the existing seam:

```text
MenuId → TrayCommand → tray::dispatch → DesktopSurfaceManager
├ Main
├ Companion
└ WebUI → index.html#/dashboard

Quit → AppLifecycle (unchanged; bypasses SurfaceManager)
```

- WebUI construction is lazy and reuses the existing Tauri window by label;
  Show focuses it, Hide is a no-op when absent, Toggle uses the shared
  visibility semantics, and ordinary close is hide-only like Main/Companion.
- Tray adds only `Open WebUI` and `Hide WebUI`. Existing Main/Companion menu
  labels and behavior remain unchanged.
- WebUI remains Presentation-only and uses the existing Runtime-backed page;
  no duplicate Runtime/chat/proactive/Memory authority was added.
- Production visual changes: none. Subtitle (Atom 18) was not started.
- Validation: focused Rust/TypeScript tests, `pnpm check`, `pnpm desktop:smoke:linux`,
  and `pnpm desktop:close-tray:linux` on the primary KDE Plasma Wayland
  platform.
