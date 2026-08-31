# Local CPU STT (sherpa-onnx)

Lifecycle is owned by DesktopSupervisor / Local AI Service Manager.
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
