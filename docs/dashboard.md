# Dashboard

The Dashboard is a local development UI for observing and steering the runtime. It must not expose raw API keys, Authorization headers, dashboard tokens, `DATABASE_URL`, raw vectors, raw audio, or raw images.

## Settings state: draft, saved/effective, and active Runtime

The Settings page presents three different sources of truth:

- **Draft** is the value currently edited in the page. It is unsaved until an operation completes.
- **Saved / effective configuration** is the layered `.env` + `.env.local` result shown by the
  `/settings/runtime` `effectiveConfig` and `settings` fields. Dashboard writes editable values to
  `.env.local`.
- **Active Runtime** is the running process snapshot reported by `activeRuntimeConfig`. It can
  remain different from saved/effective configuration when a reload is not possible or a restart
  is required.

**Save Only** writes the draft and refreshes the saved/effective view. Its final state is
“saved, not applied”; it must not be read as proof that the running Runtime changed. Use Save &
Apply or Deep Restart when the active process must converge.

**Save & Apply** writes the draft, calls the existing Runtime reload endpoint, and refreshes the
settings response. The page says “applied” only after those steps and the refreshed-state
confirmation succeed. A refresh mismatch or failure, `notHotReloaded` keys, or pending-restart
evidence remains non-applied and includes an actionable restart/apply message. Editing while an
operation is in flight preserves the newer edit as a separate dirty draft.

## Save Only / Save & Apply vs Deep Restart

**Save Only** calls `POST /settings/runtime` and does not call the Runtime reload endpoint.

**Save & Apply** calls `POST /settings/runtime/reload` after saving.

- Reloads supported provider/runtime config in-process.
- Does not restart the server.
- Does not run migrations.
- Is useful after saving provider keys, model names, and chain values to `.env.local`.

**Deep Restart Runtime** calls `POST /system/restart/deep`.

- Development and localhost only.
- Requires `Authorization: Bearer <DASHBOARD_DEV_TOKEN>` when `DASHBOARD_DEV_TOKEN` is configured.
- Requires supervisor mode: `YUVI_DEV_SUPERVISOR=1 ./scripts/dev.sh`.
- Sends the HTTP response first, writes the restart marker, then exits with the restart code handled by `scripts/dev.sh`.
- Reloads `.env` and `.env.local` on the next start.
- May run `pnpm db:migrate` when `MEMORY_REPOSITORY=postgres`, `DATABASE_URL` is configured, and `YUVI_AUTO_MIGRATE` is not `0`.

The Settings page shows supervisor state, auto-migrate state, runtime env dir, memory repository, and whether the database URL is configured without showing the raw URL.

## Chat

The Chat page sends text with `fetch()` to `POST /v1/messages/stream` and consumes the SSE body incrementally. It keeps one assistant placeholder for all `text-delta` events, then finalizes it on the single `completed` event. The Stop action aborts the current request and preserves the partial reply as cancelled. Refreshing the page does not restore chat history yet because no session-history query endpoint exists. The Dashboard WebSocket remains an events/diagnostics channel and is not used to insert Chat replies.

## Provider Settings

Provider settings are grouped by capability:

- Chat Models
- Reasoning Models
- Embedding Models
- TTS Models
- STT Models
- Vision Models
- Mock/Test Mode
- Developer Tools

Provider chains are rendered as ordered lists. Editing remains env-field based in v1 through:

```env
CHAT_PROVIDER_CHAIN=deepseek,nvidia,local,mock
REASONING_PROVIDER_CHAIN=deepseek,nvidia,local,mock
EMBEDDING_PROVIDER_CHAIN=openai-compatible,nvidia,local,mock
TTS_PROVIDER_CHAIN=xai,local,mock
STT_PROVIDER_CHAIN=dashscope,local,mock
VISION_PROVIDER_CHAIN=xai,nvidia,local,mock
```

Verify buttons are explicit and may consume provider usage. Chain verification returns safe configured order and config-only attempted-provider metadata.

## Voice and Vision Pages

The Voice page is a developer UI for:

- STT provider-chain status
- JSON/base64 audio transcription
- voice message flow from transcription into normal `/message`
- optional speaker/user metadata fields
- TTS text-to-speech generation
- attempted provider traces and final provider metadata

The Vision page is a developer UI for:

- vision provider-chain status
- image file/base64/URL input
- prompt/question input
- optional speaker/user metadata fields
- analysis results with provider/fallback metadata

These pages do not implement waveform UX, speaker diarization, voiceprint recognition, or persistent media storage.
