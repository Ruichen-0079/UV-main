# YUVI v0.1.2 post-GLM source audit

Baseline: `903601f61302ba377dcf5846268d38d6ea17769b`, clean worktree on
`feat/character-true-streaming`. `9b112f6` is not an ancestor and was not included.

Reviewed `334ccd4..359df96` and `359df96..903601f`, including their tests.
Related seams read: Main, dashboard Chat, Companion, speech queue, pipeline
feedback, playback correlation, subtitle projection/transport and Character's
native body-stream boundary in the server and Runtime orchestrator.

## Reproduced and repaired

- **Frozen feedback reader:** Main's typed/hands-free paths and dashboard Chat
  captured the initial feedback object while callbacks replaced the session's
  object through the reducer. The segmenter never saw playback completion and
  starvation never recovered. Readers now consult the current session and
  require its request ID to match. A mounted Main test sends real bus feedback:
  old-turn completion has no effect; current-turn completion releases a held
  comma fragment on the next delta. This test failed before the change.
- **Excess starvation release within one push:** after an earlier segment had
  played, a delta containing a full sentence plus a comma fragment emitted both
  under the same stale starvation observation. A cut in the current drain now
  suppresses further starvation cuts. Strong/emergency boundaries still apply.
- **Incomplete standalone-punctuation conservation:** `。`, split `……`, and
  split `！？` arriving after a release were consumed as unspeakable cuts before
  the following body arrived. Leading punctuation now stays with the next
  speakable body. Three focused conservation cases failed before the change;
  comma and dash cases also remain covered.
- **Split-surrogate sanitation (pre-existing):** `甲\ud83d` + `\ude42乙。`
  reached speech as isolated surrogate halves separated by whitespace instead
  of stripping the emoji. One trailing high surrogate is held until the next
  delta, before sanitation. Cancellation/reset clears it. A focused test
  reproduced the bad output before repair.

These are local changes to the existing readers and segmenter. Character,
queue ownership, event schemas, subtitle identity and layout are unchanged.

## Other seams

Main/Companion request and segment identity guards reject old feedback and
stale speak/subtitle events; cancellation drops pending text and cancels the
queue. Terminal queue feedback clears playing/synthesizing flags. A fresh
turn owns a fresh feedback state. Existing tests cover cancellation, stale
playback terminals, subtitle identity, synthesis failure and TTS-off fallback.
TTS-off committed subtitles do not require pipeline feedback or audible audio.

The second Main segmenter is the **hands-free user path**, not the proactive
path. Runtime-scheduled proactive text is projected separately by
`subscribeProactiveLive`; its existing path does not share this segmenter or
its feedback. No proactive speech feature was added.

Character's native provider deltas remain arbitrary and are forwarded verbatim
for display. Its semantic gate, provider stream contract and cancellation
boundary were not modified. The existing 15 Character streaming tests pass.

## Existing normalization limits retained

This audit does **not** certify exact speech-string equality for every possible
provider partition. The legacy speech normalizer trims delta edges and inserts
join spaces (for example `Hel` + `lo` becomes `Hel lo`). The conservation tests
for decimal, number separator, URL, abbreviation and mixed-language boundaries
compare non-whitespace speech characters, as the existing segmenter tests do.
Look-ahead is limited to text already received: `3.` + `14` can still release
at the period before the decimal continuation is known. These policies predate
the reviewed GLM range; changing the streaming normalizer is outside this
restrained post-GLM repair.

Likewise, `甲！` + `？` followed immediately by completion has already released
`甲！`; the punctuation-only tail is not sent as a standalone TTS request.
Punctuation followed by another speakable body is now conserved. Guaranteeing
conservation for the terminal-only tail would require delaying first release
or introducing a separate punctuation request; neither policy was introduced.
The user was asked about this tradeoff; immediate release was retained in the
absence of a request to change it. This is a known baseline limitation, not a
claim of universal lossless normalization.

Validation evidence: 130 focused Web speech/subtitle tests, 767 complete Web
tests, 15 Character streaming tests, workspace TypeScript/host-environment
check and diff whitespace check. Release packaging is reserved for Luna.
