# Atom 16 — Provider Fallback UX

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

Make provider availability, fallback, degradation, and configuration truthful
to the user without changing semantic provider authority or inventing a new
routing model.

## Dependencies

Core Character/Cognition/proactive paths should already be stable enough that UX
is describing real behavior rather than compensating for architecture churn.

## CURRENT at audit baseline

The ProviderRegistry already owns provider chains/fallback for existing
capabilities and exposes provider status. Current settings expose Chat and
Cognition provider/model configuration.

## TARGET

The UI should make clear, for relevant capabilities:

- configured primary;
- whether a fallback route exists;
- current unavailable/degraded status;
- which provider actually served a completed request when that metadata is
  already safely observable;
- restart/pending-config requirements.

The UX must distinguish “configured” from “verified healthy”.

## Required constraints

- No fast/deep Cognition router.
- No Character-visible provider names.
- No provider fallback decision in React/UI.
- No hidden automatic provider mutation of user settings.
- Do not convert an optional provider failure into semantic failure after
  Runtime has already committed a successful result unless current Runtime
  contract says so.
- Keep secrets masked and existing redaction guarantees.

## GLM / Memory extractor audit

If product policy requires GLM ReasoningProvider to be used only after
`NEED_COGNITION`, this atom should accurately surface the configured Memory
extractor behavior but must not solve the semantic conflict with a new router.
That configuration/architecture choice must already have been made in the
relevant provider/Memory atom.

## Acceptance

UI tests cover healthy, unavailable, fallback-used, configured-but-unverified,
pending restart, and secret-redaction cases. Provider integration tests prove
UI changes do not alter routing semantics.

## Stop condition

Stop when the product reports existing provider behavior truthfully. Do not add
new routing policy.

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
