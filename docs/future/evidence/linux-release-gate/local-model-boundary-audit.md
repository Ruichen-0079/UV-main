# Local model / private adapter boundary audit

Public artifact `yuvi-linux-daily-checkout-7f997044d217.tar.zst` contains **zero** ONNX/GGUF/safetensors/WAV/GGML weights, **zero** private `.venv`, **zero** symlinks into user model dirs, and **no** licensed Cubism Core / Rei reference audio / dots bakeoff assets.

dots.tts-soar + Rei reference = PRIVATE_MACHINE_ADAPTER (wrapper code only in tree).
Local STT SenseVoice/speaker/diarization weights = OPTIONAL_EXTERNAL_LOCAL_SERVICE (manifest IDs only; provision out-of-band).
Mem0 Ollama embedding = EXTERNAL_PREREQUISITE (not EmbeddingProvider OpenAI-compatible).
Remote Chat/Reasoning/Embedding/STT/TTS/Vision seams remain implemented.

Verdict: PASS — no rebuild required for private payload leak.
