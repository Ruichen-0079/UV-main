# I-2 live hibernation acceptance

Strategy A (full CUDA unload + lazy reload) **RETAIN**.

- Ready/active process-attributed VRAM ≈ **5.3–6.1 GiB**; after idle hibernate ≈ **276 MiB**.
- Auto-resume `/tts` succeeded; wall latency ≈ **16.9 s** (reload + short synthesis).
- SIGTERM while hibernated exited cleanly.
- Acceptance used `DOTS_TTS_IDLE_HIBERNATE_SECONDS=45` on `:9881`; production default remains **180**.
- Bakeoff TTS restored afterward via DesktopSupervisor `tts_wrapper` start.

See `hibernation-live-accept.json` for sanitized numbers.
