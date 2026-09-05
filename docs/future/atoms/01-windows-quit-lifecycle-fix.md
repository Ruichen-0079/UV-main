# Atom 01 — Windows Quit Lifecycle Fix

> **Status: DEFERRED — WINDOWS NOT CURRENT TARGET**
>
> This is a FUTURE PLAN and is NOT implementation authority.
>
> **Rebaseline (Linux-first CI rebaseline):** Windows is deferred. It is not the
> current release target, CI authority, or packaging target. Current main
> development does NOT block on fixing packaged Windows tray Quit. Existing
> Windows implementation remains in the repository best-effort. Becoming
> mandatory again requires a fresh future rebaseline. See Platform policy in
> [README.md](README.md).
>
> The diagnostic findings below are preserved as historical evidence from the
> audit baseline. They are not a current merge condition.
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

## Deferred PR classification

- **#229 / #230: diagnostic evidence archive, DO NOT MERGE.** They exist as
  historical diagnostic checkpoints for the Windows tray Quit investigation.
  They are not main authority and no current atom consumes them.
- The Windows Quit defect itself remains an open historical finding. Do not
  resume it under the current Linux-first lane; a resumed effort would need a
  fresh Windows rebaseline first.

## Goal

Fix the currently isolated packaged-Windows tray Quit lifecycle defect without
redesigning desktop surfaces or Runtime architecture.

## CURRENT at audit baseline

- Main includes #226, which bounded multi-service shutdown and changed the
  deferred tray-exit path.
- `TrayAction::Quit` still goes through `request_app_exit`, Tauri
  `ExitRequested`, `ShutdownGate`, `begin_app_shutdown`, then
  `shutdown_supervisor`.
- Open diagnostic PRs #229/#230 are explicitly diagnostic-only and are **not**
  main authority.
- The active investigation context reports checkpoints reaching
  `begin_app_shutdown`; the remaining binary question is whether
  `shutdown_supervisor()` returns. Revalidate this evidence from the current
  diagnostic branch/logs before using it.

## TARGET

Real semantic tray Quit on packaged Windows must:

1. enter the existing app lifecycle path exactly once;
2. stop only Supervisor-owned services;
3. never block forever while waiting on an owned process;
4. return from shutdown and allow the desktop process to exit;
5. preserve ordinary Main/Companion close-as-hide behavior.

## Required constraints

- Diagnose and fix the first proven failing boundary only.
- Preserve `ShutdownGate` idempotence.
- Preserve bounded child shutdown/reap behavior.
- Do not route Quit through SurfaceManager.
- Do not use this atom to add WebUI, Subtitle, or new tray abstractions.
- Temporary diagnostics must not land as permanent architecture unless a
  separate observability requirement proves they are needed.

## Acceptance

- Packaged Windows test activates the **real** tray Quit path.
- Process exits within the existing bounded test expectation.
- Owned Runtime/Mem0/Supervisor processes do not remain orphaned.
- Repeated/duplicate exit notifications do not duplicate shutdown.
- Main/Companion ordinary close semantics remain unchanged.
- No Runtime, Memory, Character, Cognition, P8, or provider semantic changes.

## Required testing

Focused Rust lifecycle/supervisor tests plus the packaged Windows smoke that
reproduced the defect. Hosted Windows evidence must be from the exact candidate
head.

## Stop condition

Stop as soon as the proven Quit defect is fixed and the real packaged smoke is
green. Do not proceed into tray refactoring in this atom.

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
