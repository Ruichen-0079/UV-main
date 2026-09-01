# Local CPU STT (sherpa-onnx)

Lifecycle is owned by the existing DesktopSupervisor service model.
Runtime transcription stays in `packages/providers` (`LocalSTTProvider`).

Quick OSS pick: sherpa-onnx covers ASR + speaker embedding + diarization on CPU.
whisper.cpp is strong for transcription but needs extra speaker models; vosk is older.

Install (weights stay on disk, not Git):

```bash
uv venv --python 3.12 ~/.local/share/yuvi/local-stt/.venv
uv pip install --python ~/.local/share/yuvi/local-stt/.venv/bin/python sherpa-onnx numpy
node scripts/download-local-stt-models.mjs
```

Default bind: `127.0.0.1:9876`. Threads cap at `min(4, nproc/4)`.
`CUDA_VISIBLE_DEVICES` is forced empty.

To let DesktopSupervisor own the sidecar process in development, configure an
explicit command; without it the service remains observe-only:

```bash
LOCAL_STT_BASE_URL=http://127.0.0.1:9876
YUVI_LOCAL_STT_START_COMMAND=/path/to/python services/local-stt/server.py --model-dir /path/to/models/stt --yuvi-local-stt
YUVI_AUTOSTART_LOCAL_STT=false
```

Packaged mode does not infer or start a Python sidecar.

To select the sidecar for Runtime STT, also set
`LOCAL_MODEL_BASEURL=http://127.0.0.1:9876` and
`LOCAL_STT_MODEL=sense-voice-zh-en-ja-ko-yue-2024-07-17-int8`.

Speaker profiles (`YUVI_STT_SPEAKER_DIR`, default `<model-dir>/speakers`):
- `speakers.json` — metadata only, file mode `0600`
- `speakers.npz` — raw embeddings, file mode `0600`

The sidecar reloads both files on start. HTTP JSON never includes embedding
vectors; delete removes the metadata row and the vector. Identify is
fail-closed: cosine score below threshold returns `UNKNOWN`.
