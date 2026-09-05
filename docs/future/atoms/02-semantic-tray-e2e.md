# Atom 02 — Semantic Tray E2E

> **Status: DEFERRED — WINDOWS NOT CURRENT TARGET**
>
> This is a FUTURE PLAN and is NOT implementation authority.
>
> **Rebaseline (Linux-first CI rebaseline):** Windows is deferred. Hosted
> Windows tray E2E is not current merge authority. Existing hosted
> experimentation showed the GUI stimulus/environment is not trustworthy enough
> for current merge gating; per the no-progress harness discipline, that
> harness is classified separately from product behavior. Do not resume the
> #228/#229/#230 work under the current Linux-first lane. Becoming mandatory
> again requires a fresh future rebaseline. See Platform policy in
> [README.md](README.md).
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

- **#228: superseded/deferred Windows E2E.** The semantic menu discovery
  approach remains a reference idea, but the hosted Windows E2E lane it targets
  is not current authority. Do not resume this work now.
- **#229 / #230: diagnostic evidence archive, DO NOT MERGE** (shared with
  [Atom 01](01-windows-quit-lifecycle-fix.md)).

## Goal

Make the desktop tray E2E test discover and activate the live semantic tray
command rather than depending on a hard-coded native command number.

## Dependencies

Atom 01 must be merged or its current replacement must already make real Quit
reliable.

## CURRENT at audit baseline

- Open #228 proposes semantic menu discovery for tray Quit and explicitly avoids
  production-code changes.
- Historical/native `WM_COMMAND 1004` style activation is not a stable product
  identity and must not become an application contract.

## TARGET

The hosted Windows E2E must locate the actual tray/menu entry by semantic
identity or accessible menu meaning, invoke it, and verify the expected
application lifecycle effect.

The test may use Windows accessibility/native test machinery. Production
application semantics must remain platform-neutral.

## Required constraints

- Test infrastructure only unless fresh audit proves a tiny production seam is
  strictly required for observability.
- No hard-coded numeric menu command identity.
- No alternate Quit implementation.
- No SurfaceManager implementation in this atom.
- Test must fail if the semantic tray command cannot be found; it must not
  silently fall back to a deprecated numeric route.

## Acceptance

- Real packaged application is launched.
- The live Quit menu item is discovered and activated.
- The app exits through the production Quit path.
- Test is deterministic enough for hosted Windows CI.
- Existing unit/package tests remain green.

## Stop condition

Stop when semantic tray activation is a trustworthy E2E gate for later desktop
surface changes.

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
