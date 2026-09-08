# Campaign I — performance closure (dots TTS hibernation + measured audits)

Starting main SHA: `41ad83449353706675f2a72aaf494728e9735e47`.

Final main SHA (after this closure lands): see merge commit of the Campaign I
closure PR; pre-closure HEAD at documentation time was
`531cb6d7748868daae374b0baf3cf0cb0d077c43` (#277 + #278 already merged).

## Baseline (I-1)

Process-attributed kickoff (Asia/Shanghai), host GPU-contaminated by desktop
compositor / game / streaming — prefer TTS-attributed numbers:

| Metric | Value |
| --- | --- |
| dots.tts VRAM (ready) | ≈ 6138 MiB (kickoff) / ≈ 5298–6100 MiB later samples |
| dots.tts RSS | ≈ 1.97–4.5 GiB depending on sample |
| `/health` (pre-hibernation) | `ready`, `model_loaded`, no hibernation fields |
| Startup (listen→bootstrap healthy) | ≈ 18–31 s on repeated `yuvi-daily` restarts |
| Warm short ZH `/tts` (post-promotion, resident) | ≈ 3.8 s |
| Hibernate resume (I-2 accept) | ≈ 16.9 s |

Evidence: `docs/future/evidence/campaign-i/kickoff-baseline.json`.

## Optimizations

### I-2 dots TTS idle GPU hibernation — **RETAIN**

- **Problem:** Idle daily TTS held ≈ 5–6 GiB VRAM continuously.
- **Before:** Always-resident CUDA weights; health had no hibernation fields.
- **Impl:** Strategy A full CUDA unload after idle; lazy reload on next `/tts`;
  production default `DOTS_TTS_IDLE_HIBERNATE_SECONDS=180`; health exposes
  `gpu_resident` / `ready_on_demand` / `idle_hibernate_seconds`.
- **After:** Ready ≈ 5298 MiB → hibernated ≈ 276 MiB (unload ≈ 5022 MiB);
  resume `/tts` HTTP 200 in ≈ 16.9 s.
- **Regression:** SIGTERM while hibernated clean; bakeoff assets/venv unchanged.
- **PRs:** #277 (implementation + baseline), #278 (live accept evidence).

### Live daily-path promotion — **RETAIN**

- **Problem:** Supervisor still started pre-hibernation `server.py` from
  `yuvi-campaign-g` via relative `YUVI_TTS_WRAPPER_START_COMMAND`.
- **Before:** cwd `yuvi-campaign-g` @ `b5135ba`; health lacked hibernation fields.
- **Impl:** Point durable `~/.config/yuvi-daily/.env.local` at bakeoff `.venv` +
  absolute `yuvi-campaign-i/services/dots-tts/server.py` (main tree); set idle
  180 s; apply via DesktopSupervisor `/v1/config` + `tts_wrapper` restart.
  No second supervisor; bakeoff venv preserved.
- **After:** Live cmdline uses campaign-i `server.py`; health shows hibernation
  fields; `idle_hibernate_seconds=180`.
- **Regression:** Same model/reference/HF cache; unit tests 13 OK.
- **Evidence:** `docs/future/evidence/campaign-i/live-tts-promotion.json`.

### I-3 CPU / threading — portable OMP **RETAIN**; affinity **REJECT**

- **Problem:** Concurrent BLAS/OMP pools on a hybrid 24-thread laptop.
- **Before:** STT already capped; TTS lacked portable setdefaults; embedding
  host unit `--threads 24`.
- **Impl:** Portable `OMP`/`MKL`/`OPENBLAS`/`TOKENIZERS` setdefaults in
  `services/dots-tts/server.py`. No affinity. No YUVI CPU scheduler. Host
  embedding threads left as operator note only.
- **After:** In-tree defaults only; live embedding systemd not modified.
- **Regression:** None intended; affinity explicitly rejected as fragile.
- **PR:** #278.

### I-4 Startup — **NO_CHANGE_NEEDED**

Measured listen→healthy ≈ 18–31 s. Cold path dominated by TTS CUDA load.
Did not fake faster startup by shifting freeze to first use without measuring
both (hibernate resume already measured ≈ 17 s in I-2). No small
parallelize/defer retained.

### I-5 Process residency — **NO_CHANGE_NEEDED**

Daily owned stack is single DesktopSupervisor (campaign-g) with Runtime,
Mem0, STT, TTS, Product web. Postgres/Ollama left running. Dual embedding
(host `yuvi-local-embedding` + Ollama embedding child) noted historically.
**Leftover campaign-h** API `:6122` and Vite `:5174` still present (~266 MiB
RSS combined) — **recommend human cleanup** when unused; not stopped here
(not clearly orphaned YUVI-supervisor-owned duplicates).

### I-6 RAM — **NO_CHANGE_NEEDED**

TTS weights dominate when resident; hibernation addresses idle GPU weights.
No aggressive GC. Memory/Mem0 not treated as disposable.

### I-7 Disk / IO — **NO_CHANGE_NEEDED**

Campaign G bounded-log (2 MiB + rotation; 30-day inactive known-log TTL)
retained — not replaced with CacheManager. DesktopSupervisor state ≈ 29M;
no live unbounded log/audio/screenshot writer requiring a code fix. Bakeoff
HF cache ≈ 4.9G is expected weights.

### I-8 E2E latency — **NO_CHANGE_NEEDED**

Dominant contributors: cloud LLM RTT for text; local TTS synth ≈ 3–4 s warm
or ≈ 17 s after hibernate; health probes are milliseconds. No 10 ms
micro-optimization in a multi-second path.

### I-9 Prompt cache — **NO_CHANGE_NEEDED**

Campaign I did not touch `apps/server/src/character-runtime.ts`.
`TEMPORAL_CONTEXT`-last layout and tests remain. Campaign H evidence
(`docs/future/evidence/campaign-h/prompt-cache.json`, baseline 15.89% vs
time-last 66.73%) retained. **#163 not reopened.**

### I-10 Performance dashboard — **NO_CHANGE_NEEDED**

No dashboard. Hibernation readiness already exposed via `/health`.

## dots TTS metrics (summary)

| State | VRAM (process) | Notes |
| --- | ---: | --- |
| Ready / resident | ≈ 5.3–6.1 GiB | Daily path after promotion |
| Hibernated | ≈ 276 MiB | I-2 live accept |
| Warm short ZH synth | ≈ 3.8 s | Post-promotion probe |
| Hibernate resume | ≈ 16.9 s | I-2 accept |

## CPU

Portable OMP/MKL/OPENBLAS/TOKENIZERS setdefaults on dots TTS (**RETAIN**).
Affinity **REJECT**. No CPU scheduler. Host embedding `--threads 24` =
operator note only.

## Startup / RAM / process / disk

See I-4..I-7 above — all **NO_CHANGE_NEEDED** after measurement.

## Prompt cache confirmation

TEMPORAL_CONTEXT-last retained; H evidence intact; no Campaign I regression.

## Tests

- `python3 -m unittest discover -s services/dots-tts/tests` → 13 passed
  (hibernation + output).
- Prior #277/#278 exact-head CI green at merge.
- Closure PR: docs/evidence only + private-artifact audit on changed files.

## PRs

| PR | Topic | Merge |
| --- | --- | --- |
| #277 | Baseline + hibernation implementation | `d6bf4a5` |
| #278 | Live hibernation accept + CPU threading audit | `531cb6d` |
| (this) | Live TTS promotion evidence + I-4..I-10 audits + closure | TBD |

## Rejected experiments

- CPU affinity / taskset for inference sidecars.
- YUVI CPU scheduler.
- Faking startup wins by unmeasured freeze-shift.
- Stopping Postgres/Ollama or Memory as “optimization”.
- Replacing Campaign G log TTL with CacheManager.
- Performance dashboard.
- Reopening #163 / changing prompt-cache layout.
- Broad RAM GC.

## Remaining limitations

- `yuvi-daily.service` / DesktopSupervisor repo-root remains
  `yuvi-campaign-g` (older checkout). Only TTS `server.py` was pointed at
  main-capable hibernation code. Full daily stack checkout bump is out of
  scope for this closure.
- Hibernate resume still ≈ 17 s wall clock (acceptable trade for ≈ 5 GiB idle
  VRAM).
- Mem0 reports degraded without Memory LLM configured.
- Host embedding unit still `--threads 24` (operator follow-up).
- Leftover campaign-h `:6122`/`:5174` until human cleanup.
- System-wide idle RAM/VRAM baselines remain host-contaminated (games/desktop).

## Human intervention required

- Confirm and stop leftover campaign-h dev API/web (`:6122`/`:5174`) if no
  longer needed.
- Optional: lower host `yuvi-local-embedding.service` `--threads` /
  `--threads-batch` from 24 toward ≈ 6–8 on this hybrid laptop.
- Optional later: move `yuvi-daily.service` WorkingDirectory / ExecStart from
  `yuvi-campaign-g` to a main-tracking checkout (separate from Campaign I).

Do **not** begin Campaign J from this closure.

CAMPAIGN_I_CLOSED
