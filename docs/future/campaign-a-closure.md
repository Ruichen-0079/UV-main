# Campaign A closure audit

Audit: 2026-09-07 (Asia/Shanghai). Implementation baseline: `ec6df9d`.
GitHub current main, source, tests, and merged changes remain authority.

## Landed implementation

| PR   | Main commit | Result                                                                                                                                                 |
| ---- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #265 | `28df8c4`   | Explicit AUTO/EN/ZH/JA through existing Runtime settings and Character, including post-Cognition expression; committed text/language hint reaches TTS. |
| #257 | `575bfa2`   | Independent Product WebUI, Main access, current Settings, Models & Providers, AI Routing, truthful compact health and fallback evidence, Developer.    |
| #263 | `ec6df9d`   | Main forwards admitted soft-smile to the existing Presentation device adapter; same effect identity; lip-sync preserves expression mouth form.         |

Each branch was reconstructed from its valid aggregate changes onto fresh main,
then squash-merged after exact-head hosted Check and Linux Persistence succeeded.
Base drift, PR reviews/comments/threads, and remote head were checked before each
merge; the three PRs had no reviews, comments, or unresolved threads. #266/#267
were already merged at the starting main `8c71cfe` and were retained.

The implementation adds no second Runtime, settings authority, provider control
plane, Memory authority, Supervisor, or embodied lifecycle. Stale #162 backend
and secret-writing code were not imported. The shared dashboard event hook and
existing lightweight test DOM were reused rather than copied into parallel paths.

## Integration defects repaired

- Restored the Settings entry lost in the #257 integration shell, including
  existing desktop settings and the Runtime output-language selector.
- Fixed Models & Providers and AI Routing save completion after React StrictMode
  effect replay; controls recover and show the result instead of staying busy.
- Disabled edits during save so a refresh does not silently overwrite in-flight
  changes. Main/Companion TTS convergence through settings.changed is covered.
- Reject Presentation requests while the model is loading, failed, or disposed
  instead of reporting STARTED without a device action.
- Ignore late events from closed dashboard subscriptions, including StrictMode
  cleanup. Audio constructor/frames/stop preserve expression ParamMouthForm.

Local validation included full workspace tests, type/host checks, runtime smoke,
production Vite builds, and focused mounted React/controller/audio regressions.
The WebUI Rust command passed `cargo check --locked`; hosted CI does not compile
Tauri Rust. Database-backed integration checks ran in hosted Linux Persistence;
local suites retained their normal infrastructure-dependent skips.

## PR disposition ledger

All listed heads were fresh-fetched and their intent, changed-file scope,
merge-base drift, reviews, comments, and threads inspected. Closed PR branches
and discussion remain historical evidence; closure does not claim their entire
patches landed.

| PR   | Audited head | Disposition and current authority                                                                                                                                              |
| ---- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #162 | `c76dddd`    | Closed, superseded by #257. Historical visual reference; stale backend rejected.                                                                                               |
| #225 | `50ba966`    | Closed, superseded by #251 / Atom 14. Web-owned turn state machine obsolete.                                                                                                   |
| #227 | `c5d9e01`    | Closed, superseded by #246, #247, #248, and #257 surface work.                                                                                                                 |
| #255 | `2afc9b7`    | Closed, unproven timeout-only hypothesis. #264/#266/#267 changed ownership/recovery. Reopen only with a reproduced current-head failure; no further timeout widening inferred. |
| #228 | `ce536d8`    | Closed/deferred Windows tray E2E. Atom 02 retains the future requirement; Linux is the active validation platform.                                                             |
| #229 | `e3c2c98`    | Closed diagnostic archive; no instrumentation merged.                                                                                                                          |
| #230 | `8e7d4ae`    | Closed diagnostic archive; no instrumentation merged.                                                                                                                          |
| #205 | `5e45336`    | Closed historical diagrams. Regenerate from current code if a documentation consumer needs them.                                                                               |
| #87  | `fa7f7e7`    | Closed stale entry-doc proposal; current source, merged closures, and this audit supersede its snapshot.                                                                       |
| #68  | `4cce60f`    | Closed stale architecture snapshot, including obsolete P8 status.                                                                                                              |
| #67  | `776f574`    | Closed stale architecture snapshot, including obsolete embedding/phase status.                                                                                                 |
| #53  | `9d919b9`    | Closed historical AgentBus plugin canary artifact, not product implementation.                                                                                                 |
| #52  | `84dd37c`    | Closed historical AgentBus judge canary artifact, not product implementation.                                                                                                  |
| #50  | `241eb38`    | Closed historical Windows shutdown experiment; current lifecycle and Linux policy supersede the experiment lane.                                                               |
| #223 | `9835b5f`    | Open, REBASELINE REQUIRED. Future Atom 15 evidence candidate; use the current on-demand, question-conditioned seam, not a separate image-turn architecture by default.         |
| #166 | `496169f`    | Open, DEFERRED. Resource efficiency requires fresh measured baselines and current Supervisor/Memory ownership audit.                                                           |
| #163 | `d57c53d`    | Open, DEFERRED. Context compression requires current prompt-budget/evidence audit; not silently enabled by Campaign A.                                                         |
| #146 | `56ca730`    | Open, DEFERRED / REBASELINE REQUIRED. Old Linux Companion evidence; much lifecycle/build work has successors. Reuse only remaining proven gaps.                                |

No remaining open candidate is merge-ready merely because its old CI was green.

## Remaining acceptance and best next campaign

One final subjective pass may judge the visible smile's strength/naturalness and
Product WebUI readability. The provisional ParamMouthForm value is **1**; this
is not calibrated Atom 20 quality. Objective transport, lifecycle, settings,
render-adapter calls, and lip-sync ownership have automated coverage.

Best next campaign: **Linux daily-use and clean-room operational closure**.
Verify current service inventory/ownership and restart persistence; validate
current GPT-SoVITS/Alice, STT, voice interruption, Companion, and Subtitle as one
daily-use flow; then audit packaging/resource gaps with reproducible evidence.
In particular, managed Alice wrapper language/voice quality is not proved by
passing metadata to TTS. IndexTTS/Rei is abandoned direction, not an active task.

Broader Atom 19 effects, Atom 20 calibration, on-demand visual grounding,
compression, and performance tuning remain bounded future work. Clean-room
packaging and embedded production storage remain unclosed product targets;
this campaign does not claim a dependency-free desktop release.
