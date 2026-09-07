# Campaign D — integrated Voice stack

Starting main: `26d69067f7e87c3d2e96725ea9d748d24010216f`.
Implementation resumed in the existing dirty Campaign D worktree. The inherited
production dots service/provider, leading-silence correction, adaptive capture
endpoint policy, preview fencing, VAD queue draining and identity work were
preserved. The approved model and voice bakeoff were not repeated or changed.

The production path is microphone → Local STT/VAD and capture-side endpointing →
committed speech turn → Runtime → generic TTSProvider/ProviderRegistry → concrete
dots adapter/service → browser playback → Subtitle and Companion. Runtime has no
silence timer or preview-ASR authority. PostgreSQL and Ollama remain external.

Endpointing uses transcript stability and completion cues, with 650 ms for a
complete sentence, 1200 ms ordinary silence, 2200 ms for an incomplete thought,
and a 3000 ms hard silence bound. Transcript stability requires 350 ms. A resumed
voice invalidates old previews. The capture is bounded to 60 seconds, with 400 ms
pre-roll. PCM and VAD responses are paired; transport backlog is bounded to two
seconds and excessive lag stops capture instead of replaying delayed activity.
Activity-only Silero spans are drained. Browser AEC/noise suppression remain in use.

Barge-in reacts to confirmed acoustic onset independently of endpointing and
sentence transcription. It aborts pending final transcription and generation,
stops playback, and retires the old speech session. Request, queue and segment
correlation fence late synthesis/playback callbacks. An open speech stream no
longer reports terminal idle during a gap between segments.

Only confirmed playback publishes Subtitle text. Main no longer publishes a
completed chat answer as spoken output. Synthesis failure stays blank; playback
end/error, interruption, disable, replacement and teardown clear the overlay and
stop its visual pagination. Subtitle retains its existing visuals and intentional
blank idle state. Text-only chat remains in Main. Runtime output-language
metadata flows through streamed segments to TTS and Subtitle's `lang` attribute;
AUTO/EN/ZH/JA remain supported. Concrete dots does not re-detect supplied language.

Hands-free turns consume a bounded, expiring, server-owned STT observation once.
Session, text and capture-epoch checks reject stale or mismatched commits. Both
message routes retain segment/cluster/profile evidence. Mixed captures never
inherit one whole-capture acoustic match. Acoustic profiles do not manufacture
person identity, display names or trust.

The existing Supervisor owns the dots service slot and its process group. Product
reports configured/unconfigured and live readiness, including the concrete
provider's sanitized warming diagnostic. Supervisor recognizes warmup and model
load failure without mistaking them for healthy output or a foreign port.
Configuration uses external model/reference/interpreter assets, with no private
machine path as a required product default. Setup is documented in
[the dots service README](../../services/dots-tts/README.md).

Dots has no reliable hard mid-generation cancellation hook. Cancellation aborts
transport/publication/playback and records a service request fence; GPU generation
may finish internally and its result is discarded. Only busy, unadmitted requests
are retried. The model-specific leading-only trim stays below the provider seam,
retaining approximately 80 ms of lead-in and preserving internal/trailing pauses.

Validation completed locally:

- Focused endpoint, backlog, queue, cancellation, Subtitle, identity, language,
  media-route, provider and Supervisor checks.
- Workspace TypeScript check and workspace tests; production WebUI build.
- Rust desktop library: 87 passing.
- Dots Python tests: 4 passing. Local STT Python tests: 8 passing, 2 optional skips.
- Final actual-model dots gate: JA/EN/ZH synthesis, cancellation/replacement,
  repeated-start PID stability, restart, shutdown during synthesis and warmup,
  and owned PID removal.
- Final actual Local STT gate: normal speech and a 400 ms thinking pause each
  produced exactly three committed turns over three repetitions.
- Changed/new-file private-artifact audit and `git diff --check`.

One consolidated human check remains: integrated Rei quality, endpoint timing and
thinking-pause feel, barge-in responsiveness, echo/self-trigger behavior,
continuous conversation feel, and Companion speaking appearance. No later
campaign is included.
