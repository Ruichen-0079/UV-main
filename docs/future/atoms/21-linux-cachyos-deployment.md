# Atom 21 — Linux / CachyOS Deployment

> **Status: FUTURE PLAN — NOT IMPLEMENTATION AUTHORITY**
>
> **Rebaseline (Linux-first CI rebaseline):** Linux / CachyOS / KDE Wayland is
> the current primary platform, so this atom's target is confirmed. However, it
> must be implemented through smaller Linux operational atoms (e.g. desktop
> build/test foundation, Supervisor/lifecycle validation, packaging,
> deployment) rather than one giant deployment change. The atoms README tracks
> that decomposition; this document remains the long-term target definition.
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

Land a production-usable Linux/CachyOS deployment of the same YUVI architecture,
not a Linux-specific Runtime or alternate persistence/control plane.

## Dependencies

All path-sensitive desktop/voice/presentation atoms that are intended for the
first Linux product build, especially Atom 05.

## CURRENT at audit baseline

YUVI architecture is Linux-first and current repository work has already proven
significant Linux development/build behavior. Historical/open Linux PRs are
evidence only and must be revalidated against current main.

## TARGET

A CachyOS/Arch-friendly deployment must preserve:

- one Runtime;
- existing Supervisor ownership;
- current provider/Memory/P8/Character/Cognition semantics;
- platform-correct App/Data/Cache roots;
- Main/Companion/WebUI/Subtitle surfaces that are actually part of the product
  at this point;
- local sidecars through the existing ownership model;
- Wayland-first behavior with documented fallback where required.

## Deployment concerns

Audit and solve only the concrete requirements for:

- packaging/install/update/uninstall;
- executable/resource discovery;
- writable state/config/data/cache paths;
- Supervisor child ownership and shutdown;
- local STT/TTS/model service startup where configured;
- permissions for durable local identity/acoustic data;
- desktop entry/tray behavior;
- Wayland/XWayland compatibility;
- hardware acceleration availability/fallback;
- logs/diagnostic bundle with secret and biometric redaction.

Use mature Linux primitives/system integration before custom daemons.

## Required constraints

- No Linux-only semantic behavior fork.
- No second persistence architecture.
- No duplicate provider registry.
- No system-wide root privilege when user-level ownership suffices.
- Do not make NTFS/Windows dual-boot paths part of YUVI semantic contracts.
- Cache cleanup must not erase durable Memory, settings, P8 corrections,
  suppression policy, or enrolled voice profiles.

## Acceptance

On a clean target environment, verify install → first run → Runtime ready →
chat → Memory/P8 path → configured voice/vision where available → all intended
surfaces → tray Quit → restart → durable state recovery → uninstall/cleanup
semantics.

Hosted CI is necessary but not sufficient; at least one real CachyOS/KDE
Wayland validation is required for platform behavior.

## Stop condition

Stop when the same semantic YUVI stack is deployable and maintainable on the
target Linux environment. Do not reopen closed architecture merely to simplify
packaging.

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
