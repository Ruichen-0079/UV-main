# Local dots TTS service

Concrete backend for the existing `local` TTSProvider. One offline `DotsTtsRuntime`,
configured continuation voice, complete WAV output. It uses the accepted
`dots-studio/dots.tts-soar` invocation: bfloat16, optimize=false, 10 steps,
guidance 1.2, speaker scale 1.5, seed 42, explicit JA/EN/ZH language when supplied.
No training or ordinary-startup downloads.

Provision the official dots Python package and dependencies in an external environment
(the verified revision is `32407a55228630475c48ecdb2c4e2c0f9c09e030`). Supply the existing
local model snapshot, vocoder cache, reference WAV and exact reference transcript.
The accepted model revision is `2f9b3e18d70d670d4c701da2dc55ded5755815ce`.
Do not copy model weights, reference recordings, transcripts, generated audio or an
entire Python environment into this repository.

Private deployment environment (replace placeholders; never commit the file):

```dotenv
DEFAULT_TTS_PROVIDER=local
TTS_PROVIDER_CHAIN=local
LOCAL_TTS_MODEL=dots-studio/dots.tts-soar
LOCAL_TTS_BASE_URL=http://127.0.0.1:9881
YUVI_AUTOSTART_TTS=true
YUVI_TTS_WRAPPER_START_COMMAND="/external/environment/bin/python services/dots-tts/server.py"
DOTS_TTS_MODEL_DIR=/external/local/model/snapshot
DOTS_TTS_REFERENCE_AUDIO=/external/reference.wav
DOTS_TTS_REFERENCE_TEXT="exact reference transcript"
DOTS_TTS_VOICE=rei
HF_HOME=/external/provisioned/hf-cache
```

The existing DesktopSupervisor owns the single `tts_wrapper` service slot (public
label **Local TTS**), PID metadata, serialized restart, process group and shutdown.
Leave `YUVI_TTS_UPSTREAM_START_COMMAND` unset: this backend has no separate upstream.
`LOCAL_TTS_BASE_URL` is independent of the chat and STT service URLs. Desktop still
controls enablement/lifecycle only; it never selects a model. Packaged distributions
need a separately provisioned interpreter/assets; this campaign does not add a
Linux packaging system. Product exposes readiness and semantic model selection,
not reference paths or commands.

The HTTP listener binds loopback **before** model loading, so a duplicate invocation
fails before allocating a second model. `/health` returns 503/warming while loading,
200/ready after successful load, and 503/error after failure. Public errors are
sanitized. No request is admitted before readiness; one synthesis is active and
additional requests receive 429/busy without queuing GPU work.

`POST /tts` accepts `requestId`, `text` (1–2000 chars), optional `language` (JA/EN/ZH)
and optional configured `voice`. `POST /cancel` records a bounded cancellation fence.
Upstream's complete-result API has no safe compute abort hook: an active generation
finishes once and its result is discarded. The provider aborts its transport and
issues cancellation; it retries only busy responses within its 120-second deadline.
Playback epochs independently suppress late audio. Supervisor shutdown terminates
the owned process even during loading/synthesis, releasing CUDA memory.

Idle GPU hibernation (Campaign I, Strategy A — full CUDA unload + lazy reload):
after `DOTS_TTS_IDLE_HIBERNATE_SECONDS` of quiet time (default **180**), the service
drops `DotsTtsRuntime`, runs `gc` + `torch.cuda.empty_cache()`, and reports
`state=hibernated` with `ready_on_demand=true` / `gpu_resident=false` on HTTP 200.
The next `POST /tts` reloads under the existing synthesis lock (one-at-a-time), then
synthesizes. Set the env var to `0` to disable. Active use stays GPU-warm; hibernated
≠ broken. Precision remains bfloat16; no second runtime authority.

A reproduced leading-silence issue is corrected only here: a conservative 10ms RMS
gate removes at most three seconds of leading silence, retaining 80ms before speech.
Internal and trailing pauses, short leads, and all-quiet output remain untouched.

Tests: run `python -m unittest discover -s services/dots-tts/tests` in an environment
with numpy. Local model/lifecycle acceptance uses `pnpm exec tsx
scripts/accept-dots-tts.mts` with the external `DOTS_TTS_*`, `DOTS_TTS_PYTHON`, and
`HF_HOME` values. Audio artifacts go to an OS temporary directory.
