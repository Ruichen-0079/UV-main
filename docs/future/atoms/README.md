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

## Platform policy

```text
CURRENT PRIMARY PLATFORM:
Linux / CachyOS / KDE Wayland

WINDOWS:
DEFERRED
not current release target
not current CI authority
not current packaging target
existing implementation retained best-effort
requires a fresh future rebaseline before becoming mandatory again
```

This is an intentional platform-priority decision, not "temporarily ignoring a
flaky test". Current mandatory CI is Linux-first: the `Check` workflow validates
on Ubuntu only, and the independent `Linux Persistence` workflow remains
mandatory. Windows validation and the Windows desktop packaging chain (NSIS,
hosted Windows tray smoke) are not current merge gates and must not be
reintroduced by later atoms without a fresh rebaseline. Windows production code
may remain in the repository best-effort.

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

## No-progress gate

Every implementation or diagnostic atom is subject to an information-gain gate.

If **two consecutive actions produce no new architectural or diagnostic
evidence, STOP**. A third attempt is forbidden until the agent explicitly
reframes the problem and records all four of the following:

1. the facts already proven;
2. the unresolved hypothesis;
3. why the proposed next action can falsify or materially distinguish that
   hypothesis;
4. why another rerun or another code edit would not merely repeat the same
   experiment.

An action counts as progress only when it narrows a real uncertainty, proves or
falsifies a hypothesis, establishes a new boundary, or validates a materially
changed experiment. Repeating an unchanged experiment and obtaining the same
failure mode is not progress.

Hard limits:

- **Rerun discipline:** for the same exact head, same harness, and same failure
  mode, allow at most one retry for transient infrastructure noise. If the retry
  reproduces the same failure class, stop rerunning and classify the blocking
  boundary.
- **Edit discipline:** do not make a second consecutive production-code change
  merely because the first change did not fix the symptom. Before another
  production edit, identify the failing boundary and state the falsifiable
  hypothesis that the edit tests.
- **Scope discipline:** never widen an atom, add a manager/orchestrator, or
  redesign an adjacent subsystem merely to escape a failing test.
- **Harness discipline:** when evidence shows the test stimulus or environment
  is unreliable, classify the harness separately from product behavior. Do not
  keep modifying product code to satisfy an untrustworthy harness.

Forbidden failure loops include:

```text
same exact head
→ same hosted job
→ same failure
→ rerun for luck
→ rerun for luck
```

and:

```text
symptom
→ speculative production edit
→ same symptom
→ another speculative production edit
→ broader refactor
```

The required recovery path is:

```text
no new evidence twice
→ STOP
→ summarize proven facts
→ isolate the unresolved boundary
→ design the shortest discriminating experiment
→ continue only if that experiment has new information value
```

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

Atom IDs below are stable for historical/reference continuity. They are NOT
renumbered to look sequential; dependency authority is what matters, not list
aesthetics.

### Deferred platform atoms (Windows)

Windows is not the current target (see Platform policy). These plans are
retained as historical/reference material:

- [01 — Windows Quit lifecycle fix](01-windows-quit-lifecycle-fix.md)
  — **DEFERRED — WINDOWS NOT CURRENT TARGET**
- [02 — Semantic Tray E2E](02-semantic-tray-e2e.md)
  — **DEFERRED — WINDOWS NOT CURRENT TARGET**

### Active semantic lane

- [06 — Character Interaction Contract vNext](06-character-interaction-contract.md) — DONE
- [07 — Runtime Character outcome + Cognition sequencing](07-runtime-character-outcome-cognition.md) — DONE
- [08 — Runtime Proactive Policy + Web authority migration](08-runtime-proactive-policy.md) — DONE
- [09 — Speaker-aware STT independent input](09-speaker-aware-stt-input.md) — 09A DONE / 09B-1 current
- [10 — Proactive provider binding + single Runtime scheduler](10-proactive-provider-scheduler.md)
- [11 — P8 main-profile projection](11-p8-main-profile.md) — DONE
- [12 — Memory multi-speaker attribution/provenance](12-memory-multispeaker-provenance.md)
- [13 — Voice identity](13-voice-identity.md)
- [14 — Voice Mode + barge-in](14-voice-mode-barge-in.md)
- [15 — Vision → Character](15-vision-character.md)
- [16 — Provider fallback UX](16-provider-fallback-ux.md)
- [17 — Output language semantic preference](17-output-language.md)
- [18 — Subtitle Surface](18-subtitle-surface.md)
- [19 — Companion advanced presentation](19-companion-advanced-presentation.md)
- [20 — Live2D calibration](20-live2d-calibration.md)

### Active Linux/platform lane

Dependency direction (not numeric order):

```text
05 App/Data/Cache roots
→ Linux desktop build/test foundation
→ Linux Supervisor/lifecycle validation
→ 03 Desktop Surface foundation
→ 04 WebUI Surface
→ later Linux packaging/deployment (decomposed from Atom 21)
```

- [05 — App/Data/Cache roots](05-app-data-cache-roots.md) — DONE
  (config/data/cache root contract frozen in the desktop Supervisor;
  resource root remains separate; see the closure section of that document)
- Linux desktop build/test foundation — DONE
  (closure record, no separate atom doc: `pnpm desktop:smoke:linux` is the
  repeatable Linux validation entry point — fresh web build, `cargo build`
  of `apps/desktop/src-tauri`, then an isolated launch (temp XDG/YUVI roots,
  no service autostart) that waits on the Supervisor-ACKed
  `tauri-bootstrap-ready.json` marker, verifies the loopback control plane
  (`/health` + token-authed `/v1/status`), and sweeps its own process tree by
  environment match. Fixed on the way: Tauri `bundle.resources` moved to
  `tauri.windows.conf.json` so Linux compiles; the Supervisor state root now
  follows XDG data-home semantics on Linux (Rust/Node agreement);
  `restrictToCurrentUser` no longer strips the traverse bit from
  instance directories.)
- Linux Supervisor ownership & shutdown — DONE
  (closure record, no separate atom doc: the Tauri owner now holds the whole
  descendant tree. Rust spawns the Supervisor child as its own Unix process
  group (`process_group(0)`), so shutdown escalates only against the group it
  spawned — never by name/port; `POST /v1/shutdown` is terminal: the Node
  supervisor drains owned services (existing Runtime seal/drain semantics
  preserved) and then self-exits, unwinding the pnpm/tsx wrappers; SIGINT/
  SIGTERM are routed through a self-pipe into the graceful exit path instead
  of the default disposition that orphaned the tree. The smoke now FAILs if
  the product shutdown leaves any owned process behind — PASS no longer
  depends on the emergency cleanup, which is failure-autopsy only. Evidence
  recorded for a later KDE atom: ordinary window close is still a hide; the
  tray Quit path already routes through the same graceful exit gate.)
- [03 — Desktop Surface foundation](03-desktop-surface-foundation.md)
  — rebaselined: no longer depends on Windows Atoms 01–02
- [04 — WebUI Surface](04-webui-surface.md)
- [21 — Linux/CachyOS deployment](21-linux-cachyos-deployment.md)
  — long-term target; to be implemented through smaller Linux operational
  atoms rather than one giant deployment change

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
