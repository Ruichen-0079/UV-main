# YUVI Future-State Implementation Atoms

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

## Purpose

This directory turns the 2026-09 future-state architecture self-audit into
small, independently readable implementation plans. It exists so a small agent
can open one atom and understand the intended semantic outcome without
reconstructing the whole architecture from old chats.

These are **plans**, not claims that the described future state exists.

## Frozen ownership

| Concern | Owner |
| --- | --- |
| execution, lifecycle, admission/fencing, provider execution, persistence coordination, event publication | Runtime |
| durable evidence, provenance, retrieval, validity/status, retention/expiry | Memory |
| stable identity/persona/relationship interpretation | P8 |
| expression, attention, addressing interpretation, silence/response/termination, coarse cognition escalation | Character |
| serious reasoning/coding/research/planning/verification | Cognition through the existing single ReasoningProvider seam |
| rendering, TTS playback, gaze, expression, pose, motion, desktop surfaces | Presentation/Desktop infrastructure |
| app quit/shutdown | AppLifecycle/Supervisor path, not SurfaceManager |

## Frozen semantic invariants

1. There is one Runtime execution authority.
2. Observation is not automatically interaction.
3. STT final is not automatically `UserMessage`.
4. Proactive suppression never blocks a legitimate reactive interaction.
5. Reactive response does not implicitly resume proactive permission.
6. Character proposes semantic outcomes; Runtime authorizes and executes them.
7. Speaker cluster, voice profile, person identity, and display name remain
   distinct.
8. Durable multi-speaker claims preserve assertor, subject, claim, and
   provenance.
9. Unknown identities remain unknown unless evidence authority resolves them.
10. Proactive output must pass a fresh Runtime revision fence before commit.
11. User speech may interrupt a presentation effect without rewriting already
    committed conversation history.
12. Provider metadata, UI labels, STT labels, Presentation state, and convenient
    metadata cannot silently become semantic truth.

## Minimal future proactive state

The preferred semantic state is only:

```text
ProactiveState
├─ suppression
│  ├─ NONE
│  ├─ UNTIL(time)
│  ├─ UNTIL_ENGAGEMENT
│  └─ UNTIL_EXPLICIT_RESUME
├─ eligible_after
└─ activity_revision
```

Do not create timestamp soup such as separate
`last_stt_at/last_user_message_at/last_character_at/last_activity_at` unless a
proven consumer cannot derive its need from the three fields above or existing
event history.

## Planned order

1. [Windows Quit lifecycle fix](01-windows-quit-lifecycle-fix.md)
2. [Semantic Tray E2E](02-semantic-tray-e2e.md)
3. [Desktop Surface foundation](03-desktop-surface-foundation.md)
4. [WebUI Surface](04-webui-surface.md)
5. [App/Data/Cache roots](05-app-data-cache-roots.md)
6. [Character Interaction Contract vNext](06-character-interaction-contract.md)
7. [Runtime Character outcome + Cognition sequencing](07-runtime-character-outcome-cognition.md)
8. [Runtime Proactive Policy + Web authority migration](08-runtime-proactive-policy.md)
9. [Speaker-aware STT independent input](09-speaker-aware-stt-input.md)
10. [Proactive provider binding + single Runtime scheduler](10-proactive-provider-scheduler.md)
11. [P8 main-profile projection](11-p8-main-profile.md)
12. [Memory multi-speaker attribution/provenance](12-memory-multispeaker-provenance.md)
13. [Voice identity](13-voice-identity.md)
14. [Voice Mode + barge-in](14-voice-mode-barge-in.md)
15. [Vision → Character](15-vision-character.md)
16. [Provider fallback UX](16-provider-fallback-ux.md)
17. [Output language semantic preference](17-output-language.md)
18. [Subtitle Surface](18-subtitle-surface.md)
19. [Companion advanced presentation](19-companion-advanced-presentation.md)
20. [Live2D calibration](20-live2d-calibration.md)
21. [Linux/CachyOS deployment](21-linux-cachyos-deployment.md)

The former standalone **Main cleanup** atom is intentionally deleted. Every
authority migration must remove its obsolete Main/Web path in the same atom
that replaces it.

## Provider direction

Planned product bindings remain:

- Chat / Character prose: DeepSeek-class Chat provider through the existing
  Chat provider boundary.
- Cognition: GLM-5.3-Flash through the existing single ReasoningProvider
  semantic seam.
- Proactive decision: Llama 3.3 70B class decision provider, exactly
  `NO_OP | REQUEST_TEXT`.
- Proactive prose after `REQUEST_TEXT`: DeepSeek-class Chat continuation.

No fast/deep cognition router is authorized.

If the invariant “GLM is invoked only after Character emits
`NEED_COGNITION`” is enforced, implementation must also audit the current
`MEMORY_EXTRACTOR=llm` path, because the audited baseline can consume the
configured ReasoningProvider for Memory extraction. Do not solve that by adding
a second reasoning router.

## How small agents should use these plans

Read:

1. this index;
2. the single target atom;
3. only the predecessor plans explicitly named by that atom;
4. current repository source/tests for facts.

Do not preload every future atom and then expand scope. Later atoms are
constraints, not permission to implement them early.
