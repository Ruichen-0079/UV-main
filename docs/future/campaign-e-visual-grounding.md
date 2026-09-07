# Campaign E — on-demand visual grounding

Audited base: `e75ad52c01d3fbfa6c8f6996a6d499e9b1cd746a` (Campaigns A–D closed).

## Current-main audit and choice

- Character already executes inside Runtime's original user turn, with a bounded Cognition handoff and Character re-entry. A semantic callback is sufficient; no second turn, Runtime, or agent is needed.
- `VisionProvider.analyzeImage` and registry routing already exist. xAI implements image analysis. Local and NVIDIA Vision factories are configured placeholders; configuration alone is not executable capability.
- Desktop/Tauri launches the existing supervisor/runtime with the desktop session environment inherited. KDE Wayland's installed Spectacle supports background, non-notifying, fullscreen capture to an explicit file. No Tauri screenshot command or desktop control interface is necessary.
- Existing user-stream abort signals cover transport cancellation. Grounding additionally fences user-turn ownership and Runtime sealing, including dependencies that ignore abort.
- PR #223 was inspected as historical evidence. Its standalone image-turn execution and broader Vision-to-Character architecture were not merged, rebased, or copied. Its useful principle—bounded provider-neutral evidence with stale-result fencing—is implemented on the current turn seam.
- Product had provider configuration/readiness surfaces but no one-shot capability truth, and its routing editor omitted Vision. These now use the existing settings/routing paths.

## Frozen path

Character can express `{ "visualNeed": "evidence needed" }` instead of a final disposition when current-screen evidence is necessary. The production adapter validates a nonempty need of at most 1,000 characters and invokes Runtime's semantic `requestVisualEvidence({ need })` callback. The stable contract contains no screenshot mechanism, file path, image bytes, provider name, or API fields.

Runtime permits one request for the original explicit user turn. It invokes the host capture port once, then the existing Vision route once with fallback disabled. The first selected route must be configured and implemented; mock and configured placeholder routes cannot claim working screen grounding. Ordinary chat does not call capture or Vision. Proactive turns cannot capture.

The KDE adapter executes `/usr/bin/spectacle --background --nonotify --fullscreen --output <private-temp-file>` once. The private directory is removed in `finally`, including capture failure and cancellation, before returning image bytes. Capture has a 10-second process deadline and a 20 MiB image limit. The complete capture/provider operation has a 45-second deadline. These are one-shot operation deadlines, not periodic capture timers.

Vision receives an evidence-only instruction covering relevant OCR/text, UI state, errors, charts/diagrams, formulas, objects, and uncertainty. Runtime returns `AVAILABLE` or `UNAVAILABLE` plus at most 4,000 characters of observations. Numeric confidence, when supplied, is preserved as uncertainty. Empty output and failures report unknown screen contents. Raw provider responses and image bytes never enter the Character contract.

The same Character generation resumes with the original user message and bounded, explicitly untrusted evidence. Character remains the answering agent. If stronger reasoning is needed, the evidence accompanies the existing Cognition handoff. Repeated visual requests fail explicitly; no recursive capture loop exists. A newer explicit turn, cancellation, or Runtime sealing fences stale evidence and final expression.

## Persistence and Product truth

Screenshots are never published, logged, or stored as conversation/Memory artifacts. Evidence lives only in the active generation. Grounded turns skip automatic extraction and durable ingestion. Their ordinary conversation replies retain a `memoryEphemeral` policy marker so subsequent recent-episode/dream assembly cannot re-ingest them. In-memory direct context carries the same policy. Conversation display and the same-turn final reply remain available.

Product exposes Vision configuration, provider readiness, and one-shot grounding availability. Readiness is local configuration, not proof of remote reachability. Vision routing uses the existing editor. There is no screenshot history, visual timeline, persistent screen state, continuous capture, activity classifier, or computer-control facility.

## Validation

Automated coverage includes unnecessary-request avoidance; production Character semantic need through Runtime and Vision to the same-turn reply; one capture/provider attempt; evidence bounds; screenshot/provider/empty-output failure; cancellation and supersession with abort-ignoring dependencies; operation timeout; repeated-request rejection; temporary-file cleanup; and Memory exclusion on both immediate and later turns, with and without a conversation repository.

Local validation: focused tests, `pnpm check`, workspace tests, `pnpm --filter @companion/web build`, `pnpm smoke`, `cargo check --locked`, and `cargo test --locked --lib`. Existing optional integration skips and WebUI chunk-size/Rust dead-code warnings remain visible in command results.

On this KDE Wayland host, one real Spectacle capture succeeded: PNG signature verified, 1,372,870 bytes, and no new temporary directory remained. The image was not retained. The current environment has no configured/ready Vision model/provider, so the live VLM portion was skipped honestly rather than substituting a mock or changing credentials. Automated integration covers the complete Runtime path.

Hosted exact-head CI, unresolved-thread/review checks, and a fresh base-drift check are required before merging the campaign PR.
