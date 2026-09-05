# Atom 03 — Desktop Surface Foundation

> **Status: FUTURE PLAN — NOT IMPLEMENTATION AUTHORITY**
>
> **Rebaseline (Linux-first CI rebaseline):** this atom no longer depends on
> Windows Atoms 01–02; those are deferred under the Platform policy in
> [README.md](README.md). Its dependency direction is now stable current
> desktop lifecycle behavior on the active Linux target (CachyOS/KDE Wayland),
> with Linux desktop operational validation when that foundation exists.
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

Create the smallest Presentation/Desktop infrastructure seam that owns
show/hide/ensure/focus behavior for desktop surfaces while keeping application
Quit on a separate lifecycle path.

## Dependencies

Rebaselined (Linux-first CI rebaseline): Windows Atoms 01–02 are deferred and
are NOT prerequisites. This atom depends on:

- stable current desktop lifecycle behavior on the active Linux target
  (CachyOS/KDE Wayland);
- Linux desktop operational validation when that foundation exists.

## CURRENT at audit baseline

`apps/desktop/src-tauri/src/lib.rs` directly defines and manipulates Main and
Companion windows. Open #227 is a candidate implementation and a reference
only; it is stale/non-authoritative until revalidated against a fresh Linux
rebaseline.

## TARGET

Semantic direction:

```text
MenuId
→ TrayCommand
→ tray::dispatch
→ DesktopSurfaceManager
```

for surface commands, while:

```text
Quit
→ AppLifecycle
```

branches away before SurfaceManager.

Initial surfaces are only the surfaces already proven on current main:

- Main
- Companion

## Required ownership

DesktopSurfaceManager may own:

- ensure/create existing surface;
- show/hide/toggle;
- focus;
- surface-specific window construction inputs that are Presentation
  infrastructure.

It must not own:

- Runtime/Supervisor lifecycle;
- application Quit;
- semantic conversation state;
- Memory/P8 truth;
- Character/Cognition decisions;
- proactive admission.

## Required constraints

- Preserve lazy ensure behavior.
- Preserve Companion always-on-top setting behavior.
- Preserve ordinary close-as-hide semantics.
- Do not add WebUI or Subtitle yet.
- Do not invent a generic cross-platform window framework. A small Rust module
  around current Tauri windows is enough.

## Acceptance

- Existing Main/Companion tray behavior remains equivalent.
- Quit still bypasses SurfaceManager.
- Unit tests cover semantic command mapping and surface dispatch.
- Desktop behavior is validated by the Linux-target gates available at
  implementation time; the deferred Windows tray E2E (Atom 02) is not a gate.

## Stop condition

Stop once Main and Companion behavior is behind the narrow surface seam and no
new surface has been introduced.

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
