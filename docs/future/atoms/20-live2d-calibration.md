# Atom 20 — Live2D Calibration

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

Calibrate the concrete Lumi/Live2D presentation mapping after semantic
Presentation behavior is stable.

## Dependencies

Atom 19.

## TARGET

Tune device/model-specific parameters such as:

- pose/expression mapping;
- gaze ranges;
- motion selection;
- mouth/lip parameters;
- motion blend/timing;
- interruption reset/fade;
- neutral/default pose;
- performance limits appropriate to the supported desktop.

Calibration data may be configuration/assets local to Presentation. It is not
Character identity or relationship state.

## Required constraints

- Do not change Character semantics to compensate for a renderer problem.
- Do not encode provider/model/runtime IDs in semantic contracts.
- Do not let animation state create attention/proactive truth.
- Do not add a new Live2D-specific Runtime.
- Preserve graceful fallback when proprietary/optional model assets are absent.

## Acceptance

Use deterministic Presentation tests where possible plus real visual/device
validation. Verify speech/lip sync, gaze limits, interruption recovery,
show/hide, WebGL recovery, and acceptable idle resource behavior.

## Stop condition

Stop when Lumi's concrete presentation is calibrated. Do not mix Linux packaging
or semantic feature work into this atom.

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
