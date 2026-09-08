# Campaign H — operational closure and UI productization

Inherited base and HEAD: `b5135ba3d3e6a99de643bff40b8276b8822a28d9`.
The resumed `campaign-h-closure` worktree contained uncommitted work from two
quota-limited sessions. The initial fresh fetch found no origin/main drift.
Source and surviving measurements were audited without resetting the worktree.

## Retained changes and final decisions

- Keep TEMPORAL_CONTEXT last only in the provider-bound Character semantic
  context serialization. The Harness, ABI, admitted contents and budgets do
  not change. Cache usage normalization preserves both OpenAI-compatible and
  DeepSeek telemetry, including a reported zero and an absent value.
- Keep the existing OpenAI-compatible P6 decision path and
  `meta-llama/Llama-3.3-70B-Instruct-Turbo`. P6 has exactly one authority:
  `NO_OP | REQUEST_TEXT`. No classifier, second gate, router or smaller-model
  substitution was added. The model field is now visible in provider settings.
- Retain the development Memory console fix: browse/search the repository
  edited by CRUD, including explicitly requested forgotten records. Runtime
  Mem0 semantic retrieval remains separate and unchanged. An aborted search
  cannot overwrite newer results; successful edits trigger a fresh search.
  The expanded UI gate also found that Create omitted editable emotion fields.
  It now sends valence/arousal and disables duplicate creation while pending.
- Idle Dream is **DEFERRED**. Automatic Memory Maintenance is **OFF by default**
  (`enabled=false`, `runOnStartup=false`, interval zero). Explicit maintenance
  and existing event-driven Dream behavior remain available.
- Real STT and dots.tts / Rei TTS acceptance from the resumed session is
  retained. TTS recovery used the existing Supervisor. No new scheduler,
  DreamAgent, inference stack or model-resource manager was introduced.

### Cache proof

The real Character adapter generated the provider inputs for 24 synthetic
requests: two cycles of six scenarios for each layout. No private conversations
or prompts are included in the evidence.

| Layout | Cached input tokens | Total input tokens | Cache-hit ratio |
| --- | ---: | ---: | ---: |
| Baseline | 2,560 | 16,112 | 15.89% |
| Time last | 10,752 | 16,112 | 66.73% |

[Measurements](evidence/campaign-h/prompt-cache.json) include observed latency,
usage and provider-reported cost. These are a bounded prefix-reuse experiment,
not a general quality benchmark or guaranteed future saving. No expensive
cache run was repeated after resumption because the evidence survived.

### Proactive comparison

Forty public synthetic cases were repeated twice for each model using the
current P6 instruction and prompt seam. Errors count as failures; error rows
are not silently dropped.

| Model | Correct / 80 | False REQUEST_TEXT | Missed REQUEST_TEXT, including errors | Errors | Mean latency |
| --- | ---: | ---: | ---: | ---: | ---: |
| Llama 3.3 70B Turbo | 66 | 12 | 0 | 2 | 1,208 ms |
| Llama 3.1 8B Turbo | 52 | 0 | 15 | 16 | 878 ms |
| Gemma 3 4B | 73 | 5 | 2 | 0 | 436 ms |

[Case-level evidence](evidence/campaign-h/proactive-comparison.json) is the final
comparison, not merely aggregate ranking. Gemma repeatedly treated quoted
instructions as a request and missed an open comparison follow-up. 8B missed
multiple valid follow-ups and had transport failures. Neither passes the
replacement gate. Retaining 70B does **not** claim its 12 false positives are
acceptable or that it passed every diagnostic case; it avoids a behaviorally
unqualified cost-driven replacement. Further model changes require reviewed
case-level evidence, not another authority layer. Proactive remains opt-in.

## Live2D product path

Settings now lists installed models and provides directory import, manifest
selection, model naming, selection, disable, refresh and removal. Select an
extracted package directory; when it contains multiple `.model3.json` files,
choose the desired manifest. ZIP extraction remains an explicit OS operation.

The server validates the v3 manifest, MOC3 signature, PNG texture signatures,
all referenced motions, expressions, physics, pose, display info, user data
and motion sounds. Missing, duplicate, malformed and escaping paths fail before
installation. Limits are 512 files / 64 MiB decoded. Windows reserved filenames,
case collisions, traversal and URLs are rejected. Real Cubism loading remains
responsible for full runtime compatibility; installation does not claim render
success.

Uploads are copied atomically into `live2d-models` under `YUVI_RUNTIME_DATA_DIR`
for packaged Runtime, otherwise the existing YUVI host DATA root (normally
`~/.local/share/yuvi`). No picker path is persisted. Selection is an atomic
server-owned file. Companion watches the same selection and disposes the old
controller before using the existing Cubism renderer. There is no second model
or renderer authority. A model-load failure is visible and does not masquerade
as ready. Asset serving checks canonical containment, including symlinks.

Configured preinstalled models are read-only in this panel. Select another
model, or disable the model, before removing its installed copy. Originals are
untouched. Explicit disable persists across restart and does not silently
reactivate a default. Unconfigured first run shows the official Hiyori install
path; configured `Hiyori/Hiyori.model3.json` is preferred as the default, with
the existing configured Lumi path retained for current installations.

### Hiyori provenance and licensing disposition

Freshly inspected on 2026-09-08:

- [Official Live2D sample collection](https://www.live2d.com/en/learn/sample/).
- [Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html),
  version 1.6, revised 2025-02-03: definitions 1.9–1.10, original-character
  grant 2.1.3, user-class restrictions 2.1.3.1–2, and redistribution restriction
  4.1.1.
- [Sample Data Terms](https://www.live2d.com/eula/live2d-sample-model-terms_en.html),
  version 1.7, revised 2026-01-29: Hiyori is a Live2D original character; her
  design may not be changed, and copyright notices are required.

**No Hiyori binaries are redistributed in this public source repository.**
The agreement distinguishes application distribution from redistribution of
sample duplicates. A general permission to place duplicate runtime sample
assets in this public source tree, for unrestricted downstream redistribution
and all customer classes, is not established. That is the precise blocker;
this is not a claim that every application use of Hiyori is forbidden. The
product supplies the official-source download/import seam instead. Users must
review the applicable terms for their own use; no third-party mirror is linked.
Cubism Core remains governed by its existing separately provisioned SDK path.

Real rendering acceptance used 18 unmodified runtime files from the official
[Live2D/CubismWebSamples Hiyori directory](https://github.com/Live2D/CubismWebSamples/tree/b1de66b0b1f1cb881d95fb6158622aeb6a2827bd/Samples/Resources/Hiyori),
pinned to `b1de66b0b1f1cb881d95fb6158622aeb6a2827bd`. Files were downloaded via
the official GitHub API after the archive endpoint failed. They remain outside
the repo. The import/load test restores the prior active model and removes only
its own installed acceptance copy. No screenshot reconstruction was used.

Required application notice when using the official sample:

> This content uses sample data owned and copyrighted by Live2D Inc. The sample
> data are utilized in accordance with terms and conditions set by Live2D Inc.
> This content itself is created at the author’s sole discretion.

## Locale and interaction

A thin centralized `locale.ts` / `locale-zh-cn.ts` dictionary translates UI copy,
including navigation, Main, providers, routing, Memory, voice, TTS, Vision,
Companion, Subtitle and diagnostic/loading/error/success/empty states. Provider,
model and protocol identifiers, user messages and memory contents remain data.
Chinese is the first-run default. Browser language is persisted locally;
desktop language uses the existing Rust user settings, with the local UI mirror
synchronized at bootstrap. Switching reloads the surface so module-level labels
cannot remain in the previous language. English remains selectable.

Buttons have restrained hover/press/focus and disabled feedback, respecting
reduced motion. Save/apply, restart, service work, model operations and Memory
maintenance expose pending status. File reading shows measured bytes; backend
installation and model initialization use indeterminate progress. Percentages
are never invented. Successful installation, saved selection and renderer
readiness are separate results.

## Prior PR disposition from the current-main baseline

| PR | Disposition | Current evidence |
| --- | --- | --- |
| #146 Linux Companion | Superseded; close unmerged | Campaigns F/G own current Cubism lifecycle, transparent split surfaces, Linux Supervisor ownership and daily-use validation. H validates real Hiyori loading on that path. The old packaging/launch implementation is not imported. |
| #163 context compression | Do not activate; close unmerged | Current PromptBuilder enforces its 12,000-character budget and Character Harness bounds admission. H proves a narrow cache-layout improvement, not a need for the old hierarchical-compression activation. No generic prompt rewrite is justified. |
| #166 resource efficiency | Rejected for revival; close unmerged | Current Campaign G ownership/resource evidence and working STT/TTS do not establish a regression needing the old lazy-resource/pool implementation. Existing resource ownership remains authoritative. |

## Validation and review gates

Objective UI inventory after superseded harness reruns: **218** unique
interactions, **57 AUTOMATED_PASS**, **161 REAL_LOCAL_PASS**, **0 BROKEN**.
Rendered locators alone were not counted as passes. Historical harness failures
(locale selector treated as a Runtime key, Settings save of `nats` which the
backend correctly rejects, Main stream fields read at the top level instead of
`options`, missing fake-DOM `<select>`, Playwright maintenance dialog) were
classified as **HARNESS_ERROR** and rerun; they are not product passes.

| Category | Count |
| --- | ---: |
| AUTOMATED_PASS | 57 |
| REAL_LOCAL_PASS | 161 |
| BROKEN | 0 |
| OBSOLETE | 0 |
| HUMAN_ONLY | 4 |

Human-only remains: subjective Rei voice quality, microphone/echo feel,
subjective barge-in feel, and Companion motion/aesthetics.

Local gates on this worktree: `pnpm check`, `pnpm test`, production WebUI
build, `pnpm smoke`, and 87 Rust library tests. Private-artifact audit found no
secrets, private conversations, or Hiyori binaries in the source tree.

The PR records exact-head hosted CI, review/thread audit and the final
base-drift check.

No Campaign I or automatic architecture expansion follows this closure.
