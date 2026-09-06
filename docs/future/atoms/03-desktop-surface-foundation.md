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

## Closure (implemented)

**Status: DONE.** Implementation base: `b21504dd81e304c1381b52fad2bd9c75da68baba`.

Scope held to the semantic refactor: Main + Companion only; no new surface, no
WebUI (Atom 04) and no Subtitle (Atom 18) work, no surface persistence, no
packaging, no Supervisor/KDE lifecycle redesign.

### Surface authority (BEFORE → AFTER)

BEFORE: `apps/desktop/src-tauri/src/lib.rs` held one flat `TrayAction` enum
mixing surface and lifecycle intents, an inline `on_menu_event` dispatch that
called free window functions (`show_main` / `hide_main` /
`show_companion` / `hide_companion`), free window construction/ensure
functions, four frontend companion commands manipulating the window directly,
and a direct `set_always_on_top` call inside `config::update_user_settings`.
Quit already forked before window manipulation; that fork is now structural.

AFTER:

```text
MenuId → tray::tray_command → TrayCommand
├ Main(SurfaceCommand)      ─┐
├ Companion(SurfaceCommand) ─┴→ tray::dispatch_tray_menu → DesktopSurfaceManager
└ Quit → request_app_exit (AppLifecycle) — never enters the surface seam
```

- `apps/desktop/src-tauri/src/desktop_surface.rs` — `SurfaceId { Main,
  Companion }`, `SurfaceCommand { Show, Hide, Toggle }`, and the zero-state
  `DesktopSurfaceManager` owning ensure/create, show, hide, toggle, focus, the
  existing window construction inputs, and Companion always-on-top
  presentation (construction-time resolution plus the runtime
  `apply_companion_always_on_top` that `config::update_user_settings` now
  calls). It owns nothing else: no Runtime, no Supervisor, no shutdown, no
  conversation state.
- `apps/desktop/src-tauri/src/tray.rs` — menu construction (menu ids and
  labels unchanged), `TrayCommand { Main(…), Companion(…), Quit }` mapping,
  and `dispatch_tray_menu` whose `Quit` arm is the fork point.
- `lib.rs` keeps only wiring: the four thin frontend companion commands, the
  unchanged AppLifecycle path (`request_app_exit` → deferred main-thread
  `exit(0)` → `ExitRequested`/`Exit` → `begin_app_shutdown` → `ShutdownGate` +
  Supervisor drain), and the close-as-hide window event handler.
- `lifecycle.rs` is untouched.

### Preserved behavior

- Main and Companion remain built at startup with the same construction
  inputs; every later tray/frontend path reuses the live window through
  `existing_or_create` instead of rebuilding, so ensure semantics follow
  fresh main exactly.
- Ordinary close stays hide (`lifecycle::window_close_action` untouched); the
  surface seam gains no authority from the close event.
- Companion always-on-top still applies at construction and immediately on
  settings change, with the same `true` fallback when settings are
  unavailable.
- Frontend invoke commands `show_companion` / `hide_companion` /
  `toggle_companion` / `reopen_companion` keep their names and semantics.

### Proof

- Structural Quit-bypass unit test:
  `tray::tests::quit_forks_to_lifecycle_and_never_enters_the_surface_seam`
  (the lifecycle hook fires; no surface dispatch is constructed), plus
  MenuId→TrayCommand mapping, surface routing, and unknown-id safety tests in
  `tray::tests`, and lazy ensure/reuse plus the Main+Companion-only
  label/caption contract tests in `desktop_surface::tests`.
- `cargo test` (apps/desktop/src-tauri): 76 passed.
- `pnpm check`: pass.
- `pnpm desktop:smoke:linux`: PASS (build + isolated bootstrap + control
  plane + owner shutdown, zero owned survivors).
- `pnpm desktop:close-tray:linux` on real KDE Plasma Wayland: PASS — SNI menu
  `[Open YUVI, Hide YUVI, Show Companion, Hide Companion, Quit]`, compositor
  close handled as hide with the exit gate untouched, tray Open/Hide
  controlling the windowless app, tray Quit → graceful `exit(0)`, repeated
  Quit absorbed by the gate, zero owned descendants.
