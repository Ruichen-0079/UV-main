# Live TTS hibernation promotion

**RETAIN.** Daily `tts_wrapper` now runs hibernation-capable `server.py` from current main checkout.

- Durable: `~/.config/yuvi-daily/.env.local` points `YUVI_TTS_WRAPPER_START_COMMAND` at bakeoff `.venv` + absolute `/home/ruichen/Projects/yuvi-campaign-i/services/dots-tts/server.py`.
- `DOTS_TTS_IDLE_HIBERNATE_SECONDS=180` (production default).
- Applied live via DesktopSupervisor `/v1/config` + `tts_wrapper` restart (no second supervisor; bakeoff venv kept).
- `/health` exposes `gpu_resident`, `ready_on_demand`, `idle_hibernate_seconds`.
- Warm short ZH synth probe ≈ 3.8 s while resident (separate from ~17 s hibernate resume).

Supervisor/systemd still owns `yuvi-campaign-g` as repo-root; only the TTS script path was promoted.
