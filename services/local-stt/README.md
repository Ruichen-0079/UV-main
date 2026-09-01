# Local CPU STT (sherpa-onnx)

Lifecycle is owned by the existing DesktopSupervisor service model.
Runtime transcription stays in `packages/providers` (`LocalSTTProvider`).

Quick OSS pick: sherpa-onnx covers ASR + speaker embedding + diarization on CPU.
whisper.cpp is strong for transcription but needs extra speaker models; vosk is older.

Development provisioning (runtime and weights stay on disk, not Git):

```bash
pnpm local-stt:provision
```

Default bind: `127.0.0.1:9876`. Threads cap at `min(4, nproc/4)`.
`CUDA_VISIBLE_DEVICES` is forced empty.
The desktop microphone path converts browser recordings to mono 16 kHz WAV before
upload, so the packaged sidecar does not depend on a system `ffmpeg` install.

To let DesktopSupervisor own the sidecar process in development, configure the
provisioned command; without it the service remains observe-only:

```bash
LOCAL_STT_BASE_URL=http://127.0.0.1:9876
YUVI_LOCAL_STT_START_COMMAND=/path/to/local-stt/.venv/bin/python services/local-stt/server.py --model-dir /path/to/local-stt/models --yuvi-local-stt
YUVI_AUTOSTART_LOCAL_STT=false
```

Packaged Windows mode carries a self-contained CPU sidecar and the verified
model tree. DesktopSupervisor derives its command from the packaged manifest;
it never calls Python, uv, or a developer checkout.

To select the sidecar for Runtime STT, also set
`LOCAL_MODEL_BASEURL=http://127.0.0.1:9876` and
`LOCAL_STT_MODEL=sense-voice-zh-en-ja-ko-yue-2024-07-17-int8`.

Speaker profiles (`YUVI_STT_SPEAKER_DIR`, default `<model-dir>/speakers`):

- `speakers.json` — metadata only, file mode `0600`
- `speakers.npz` — raw embeddings, file mode `0600`

The sidecar reloads both files on start. HTTP JSON never includes embedding
vectors; delete removes the metadata row and the vector. Identify is
fail-closed: cosine score below threshold returns `UNKNOWN`.
