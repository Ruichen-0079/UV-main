# Atom 17 — Output Language Semantic Preference

> **Status: DONE — IMPLEMENTED ON CURRENT MAIN**
>
> **Audit baseline:** `8c71cfe`
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

This atom does not implement conversational setting commands. The existing
settings/config authority remains the only way to change the preference.

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

## Current-main classification

- **REUSE:** the existing `.env` / `.env.local` runtime-settings authority and
  hot-reload path; the Character ABI 2D and Harness 5J/5K/5L context seams; the
  Runtime-owned bounded Character → Cognition → Character sequence; the existing
  TTS `metadata` input; committed assistant text as the Subtitle source; and the
  absence of output-language authority in P8/Memory.
- **ADAPT:** the reactive Character instruction, proactive decision/continuation
  prompts, Runtime's Character transport, settings reload construction, and the
  existing TTS handoff. Each now carries the same explicit semantic preference
  without changing provider selection.
- **IMPLEMENTED GAP:** an explicit setting/config value, a bounded Character context field,
  final-expression instructions for reactive/proactive/post-Cognition output,
  and a per-turn TTS language hint for providers that need one.
- **REJECT:** the WebUI application locale, STT transcript language, TTS
  provider/model/voice configuration, provider routing, Subtitle changes,
  Memory/P8 persistence or inference, and natural-language setting commands as
  authorities for this atom.

## Closure (implemented)

- `OUTPUT_LANGUAGE` is an existing-authority development runtime setting with
  supported values `AUTO`, `EN`, `ZH`, and `JA`; it is hot-reloadable and defaults
  to `AUTO`.
- `AUTO` follows the current interaction context for the current turn only. It
  never persists an inferred language, mutates settings, or writes Memory/P8.
- Explicit `EN`, `ZH`, or `JA` is transported by Runtime to Character and is
  authoritative for reactive, proactive, and post-Cognition final Character
  expression. Cognition's internal language remains unconstrained.
- Character ABI 2D carries only the semantic output-language value. No TTS
  provider/model/voice field enters Character ABI or Character Harness.
- TTS receives committed final text plus the existing per-call language
  metadata (`en`, `zh`, or `ja`). In `AUTO`, that hint is resolved from the
  admitted final text for that call only. TTS does not select semantic response
  language.
- Subtitle remains a committed-text-only projection and is unchanged.
- No provider routing or Memory/P8 authority was added. Conversational setting
  control remains intentionally deferred.
