# Campaign F — Companion Presentation completion

Starting main: `4498eb2387616f9ce1824d1c2e3e948fdeb29a1a`.
Campaigns A–E remain closed. This campaign supersedes the remaining Atom19/20
presentation/calibration plans; it does not begin Campaign G.

## Authority and audit

Character's accepted RESPOND proposal may carry a semantic presentation intent.
The existing Harness projection, Runtime admission/identity, server transport,
Main shared WebSocket subscription, Companion bus and Lumi controller remain the
production path. The historical soft-smile function/export names remain for
compatibility; their allowlist now covers the supported expression vocabulary.
No raw device parameters were added to Character/Cognition contracts.

The audit found the server replacing Character semantics with a constant smile.
Runtime now passes the accepted intent through its existing presentation port;
Character omission remains omission. The legacy non-Character reply path retains
its existing soft-smile fallback. Character generation instructions describe the
optional vocabulary, including the post-Cognition response.

The existing transport previously consumed only STARTED, leaving expressions
without terminal lifecycle reporting. Expression/gaze observations now flow in
order through the existing Runtime record advancement and event publication.
STARTED is progress; completion/interruption/failure terminates the bounded
transport wait. Duplicate observations are idempotent in the Runtime reducer.
Transport close resolves pending requests; publication failure clears its wait.
No second lifecycle store, epoch allocator or PresentationAgent was introduced.

Fresh audit: Atom19 slice PR #263 (`ecfb887`) is merged; its stale remote branch
was inspected, not resurrected. No Atom20 PR was found. Open historical #146
remains outside this implementation; #163/#166 concern excluded work.

## Rendering and calibration

Semantic expressions: `neutral`, `soft-smile`, `attentive`, `thinking`, `amused`,
`excited`, `acknowledge-interrupt`. Existing Presence supplies idle, listening,
thinking, speaking and interrupted activity. Existing gaze vocabulary remains
user, away-left/right, down-thoughtful and recenter.

`LumiPresentationController` retains the one lifecycle-owned animation clock.
`LumiPresentationMotion` samples a small expression envelope and composes it with
existing blink/gaze/head/body input. It is rendering math, not agency or a game
animation graph. Composition is base gaze/pose + asymmetric idle drift + semantic
sway/bounce/tilt/lift + speaking sway, followed by hard bounds. Eyes continue to
blink while speaking. AudioMouthEnvelope exclusively owns mouth opening;
expression exclusively supplies mouth form. Mouth calibration yields if speech
starts and no longer resets expression state.

`lumi-presentation-calibration.ts` centrally defines low/medium/high coefficients
(0.35/0.7/1.25), expression profiles, X/Y amplitudes and bounds, smile, attack,
hold/fade, settling, interruption and gaze release durations. Intensity derives
from semantic expression inside Presentation; there are no Character animation
coordinates. HIGH is intentionally lively. Existing centralized gaze/pose
profiles and blink timing remain in `companion-presence.ts`.

X/Y are absolute normalized-device-coordinate offsets applied to a freshly
composed Cubism MVP, not accumulated CSS positions or invented model parameters.
A 0.82 framing scale reserves viewport room. Hard bounds are X ±0.16 and Y ±0.14;
head/body contributions are bounded at 26/18 degrees before model-native bounds.
The original fit is never mutated, so repeated peaks cannot accumulate drift.
Optional missing Live2D parameters retain the existing graceful degradation.
Physics sees composed owned parameters and final owned values are reapplied
before Core update, preserving the existing ownership rule.

## Replacement, interruption and visibility

Requests are fenced using the existing turn correlation, source creation time and
effect ID. A bounded per-turn observation cache makes duplicate delivery
idempotent without replaying movement; foreign/retired turns, older source
instances and cancelled projections cannot start effects. New expressions replace
and report interruption for the previous expression. Gaze and expression coexist;
external policy gaze replaces the admitted gaze channel rather than fighting it.
Gaze releases back into the existing scheduler before reporting completion.

There are no per-effect animation completion timers. The current clock samples
one envelope; replaced effects cannot reappear from late completion callbacks.
Speech cancellation stops its mouth envelope promptly and clears expressive
motion. Presence remains the source of speaking state, including Campaign D's
existing audio/request fencing. Render observations are serialized on the existing
HTTP ingress, preventing terminal delivery from overtaking STARTED.

Visibility changes neutralize mouth opening, eyes, gaze and transient pose/X/Y,
interrupt active transient effects, and reset blink/gaze scheduling. Effects while
hidden are rejected. A long suspended frame also resets offsets. Show resumes
from valid presentation state and current speech playback; stale audio terminal
callbacks retain the existing playback correlation fence. Unmount/reload stops
the clock, reports active interruption and disposes listeners/resources.

Native acceptance also found a preexisting GTK/Tao panic when Subtitle enabled
click-through before its hidden native window existed. Applying click-through
after show fixes that presentation crash without changing surface authority.

## Validation and one human pass

Focused deterministic coverage includes vocabulary, mouth ownership, expression
plus speech, speaking start/end, X/Y and pose/gaze bounds, HIGH visibility floors,
100 repeated peaks without drift, effect replacement, stale/foreign/duplicate
requests, interruption, fade completion, hidden/show and disposed callbacks,
Character intent propagation, and ordered Runtime start/terminal observations.

Local gates: `pnpm check`, `pnpm test`, WebUI production build, `pnpm smoke`,
`cargo check --locked`, `cargo test --locked --lib` (87 tests). Existing optional
integration skips, WebUI chunk-size warning and Rust dead-code warnings remain.
`pnpm desktop:close-tray:linux` passes on real KDE Wayland: Companion show/hide
three times, one reused window, compositor close-as-hide, other surfaces, tray
Quit exit 0, and zero owned descendants. This native lifecycle test uses isolated
roots and does not assert subjective animation quality or proprietary model assets.

For one consolidated human visual pass, start the existing configured development
Runtime and this checkout's WebUI (or `pnpm --filter @companion/desktop dev`).
Open Companion (`http://127.0.0.1:5173/#/companion` for browser development), wait
for Lumi to load, then run in its developer console:

```js
const stopRehearsal = window.__yuviPresentationRehearsal();
```

The DEV-only rehearsal runs idle, soft smile, speaking body-motion preview,
large amused X sway, excited Y bounce, thinking, gaze, interruption, hide/show
and settled idle. Console labels announce each stage. Hide/show at the prompt.
It creates no Runtime admission and sends no synthetic reports to the server;
its stop function and unmount cleanup restore current production Presence.
Then do one real voice reply and barge-in to judge audible lip-sync coexistence.
The rehearsal's speaking stage is explicitly a motion preview, not fake speech.

Give one combined feedback batch, e.g. “X 摆动再大一点，雀跃高度减 20%，说话时身体太忙，thinking 太机械。”
Perceived character, amplitude and audio/visual timing remain human-only acceptance.
No pixel tests, proprietary model assets, private config, recordings or screenshots
are committed. Browser control was unavailable in the agent session; no live
subjective visual approval is claimed.
