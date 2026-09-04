# Atom 17 — Output Language Semantic Preference

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

Define output-language preference as an authorized interaction setting consumed
by generation layers, rather than letting Subtitle/TTS/Presentation infer or
own semantic language selection.

## Dependencies

Atom 06 so Character context has a stable place for the preference.

## TARGET

A small user-controlled preference with meanings equivalent to:

- `AUTO` / follow interaction context;
- explicit supported language choice.

The preference is supplied to Character/proactive prose generation as semantic
context. Cognition may reason in any internal representation allowed by its
provider, but the final Character expression follows the authorized output
language preference.

TTS consumes the language of the admitted final output; it does not choose a
different semantic response language.

## Ownership

- Settings/config: explicit user preference.
- Character: final expression in the authorized language.
- Runtime: transports/admission only.
- Presentation/TTS: renders the resulting language.
- Subtitle: displays admitted text.
- P8/Memory: no hidden language authority is required merely for this setting.

A conversational statement such as “以后都用中文” may later be classified as an
authorized setting/control through normal interaction semantics, but must not be
silently inferred from one transient utterance.

## Required constraints

- Do not combine with Subtitle implementation.
- Do not put TTS voice/model/provider fields into Character ABI.
- Input language detection is evidence/context, not durable output preference.
- No language-specific provider router.

## Acceptance

Tests cover AUTO, explicit preference, proactive output, reactive output,
post-Cognition Character re-entry, TTS handoff, and a change of preference
without Memory/P8 contamination.

## Stop condition

Stop when semantic generation language is stable and separately owned.

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
