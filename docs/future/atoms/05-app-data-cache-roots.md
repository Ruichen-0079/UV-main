# Atom 05 — App / Data / Cache Roots

> **Status: FUTURE PLAN — NOT IMPLEMENTATION AUTHORITY**
>
> **Rebaseline (Linux-first CI rebaseline):** this atom is ACTIVE on the
> Linux-first lane and may proceed before final Linux packaging. No Windows
> prerequisite blocks it; deferred Windows Atoms 01–02 are irrelevant here.
> See Platform policy in [README.md](README.md).
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

Freeze platform-appropriate application roots before durable voice identity and
later deployment work make path migration expensive.

## Dependencies

Desktop lifecycle/surface atoms should be stable enough that path changes are
not mixed with tray behavior. Per the rebaseline, this atom may proceed before
final Linux packaging and is not blocked by any Windows prerequisite.

## CURRENT at audit baseline

Desktop/Supervisor state uses existing YUVI state-directory helpers. The local
STT sidecar defaults speaker profile files under its model directory when
`YUVI_STT_SPEAKER_DIR` is absent. That location must not become durable
person-identity architecture by accident.

## TARGET

Define one small path contract separating at least:

- **config**: user-editable configuration and secret references/settings;
- **data**: durable user-owned application data that must survive cache clears,
  including future durable acoustic profile assets when authorized;
- **cache**: rebuildable/downloadable/derived data whose deletion must not erase
  user semantic state.

Use mature platform directory primitives already available in Tauri/Rust/Node
before custom path logic.

## Required constraints

- Do not classify model files as cache merely because they are large; classify
  by rebuildability and ownership.
- Do not move databases, speaker profiles, or settings without an explicit
  compatibility/migration decision based on current installs.
- Runtime semantics must not depend on OS path strings.
- No new persistence database.
- Voice acoustic data must not remain implicitly coupled to model install
  directories after Voice Identity lands.

## Acceptance

- Every existing desktop-owned persistent artifact has one documented root
  classification.
- Windows and Linux resolve roots deterministically.
- Supervisor/server/sidecars receive paths through existing configuration/env
  composition rather than hard-coded cross-layer imports.
- Existing installs either migrate safely or retain a documented compatibility
  path.
- Cache deletion cannot erase explicit user suppression policy or future
  enrolled voice profiles.

## Stop condition

Stop after root semantics and the minimum required path migration are complete.
Do not perform Linux packaging in this atom.

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
