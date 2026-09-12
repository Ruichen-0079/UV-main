# Character response streaming

Based on artifact-first commit `8054f9d95d76`. The abandoned static speech planner
is not an ancestor of this change.

The previous production Character adapter generated a structured disposition and
complete response text in one call. Runtime emitted that text as one delta only
after finalization. The production adapter now makes a structured semantic gate
call with these shapes:

- `{"disposition":"RESPOND","presentation":{"intent":"soft-smile"}}`
  (`presentation` is optional; `text` is forbidden).
- `{"disposition":"SILENCE"}`
- `{"disposition":"TERMINATE"}`
- `{"disposition":"NEED_COGNITION","focus":"..."}` (`focus` is optional).

Existing optional proactive proposals and the bounded visual-evidence request
remain unchanged. Non-RESPOND gates still use Character Harness validation and
cognition handoff. RESPOND uses a small local gate validator; no placeholder
text or fabricated full-reply ABI proposal is used.

Character prepares the natural-language `ChatInput` from the same admitted
semantic context, language, current turn, and any visual evidence. The shared
Character behavioral instruction includes the continued/authorized-task
fulfillment invariant on both calls. Post-cognition body requests retain the
normalized result and honesty constraints. Neither Persona nor Runtime decides
what the response should mean.

Runtime's existing bounded Character → Cognition → Character sequence runs
unchanged. For a RESPOND body request, Runtime calls the selected provider's
`streamReply()` API and forwards each delta to `RuntimeReplyStreamEvent` and the
existing SSE writer as it arrives. The helper rejects providers explicitly
marked compatible/unsupported and does not call the completed-text fallback.
It checks cancellation, nonempty deltas, the 8,000-character limit, and exact
completion consistency. Invalid/truncated streams fail without committing an
assistant response. The prior whole-response repetition retry cannot retract
already-visible text; the stream remains bounded by its output/character limits.

The existing turn AbortSignal propagates to the provider. Both cancellation and
early iterator closure abort and close the provider iterator. Character's prior
finalization policy is retained: a cancelled/failed turn does not commit an
assistant message or successful completion; its already-delivered deltas may
have been visible. SSE disconnect/supersession uses the existing cancellation
path. No new lifecycle owner is introduced.

The non-SSE `/message` contract still returns a complete response, but consumes
the same streamed body internally. Legacy injected Character ports may continue
to return complete ABI proposals; the production server adapter never does so
for RESPOND. Semantic gates and Cognition itself remain non-streaming.

The existing SpeechSegmenter, SpeechPlaybackQueue, TTS retry policy, and subtitle
playback gating are untouched. SSE deltas can now reach that incremental speech
path before Character body completion.

Runtime logs `Character response stream completed` with `traceId`,
`semanticGateLatencyMs`, `firstTokenAfterGateMs`, `totalResponseLatencyMs`, and
`providerDeltaCount`. Timings cover gate-entry through provider-body completion,
excluding earlier prompt preparation and later persistence/TTS. On cognition
turns the gate interval includes the bounded cognition/re-entry sequence.

Validation:

- `pnpm check`
- `pnpm --filter @companion/server test`
- `pnpm --filter @companion/core test`
- `pnpm --filter @companion/providers test`

Server tests control provider delivery and withhold completion until the
consumer observes each Chinese delta. A real HTTP socket test repeats the
assertion at SSE. Additional tests pin single-delta preservation, silent and
terminated turns, cognition re-entry, cancellation/iterator cleanup, malformed
streams/gates, context/evidence retention, and task continuation on “You choose”,
“ok”, and “start”. Portable/live measurements belong to the local acceptance
report for the rebuilt committed HEAD.
