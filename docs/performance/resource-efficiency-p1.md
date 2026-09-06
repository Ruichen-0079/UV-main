# EFFICIENCY-P1: YUVI runtime resource efficiency

Date: 2026-08-31
Branch: `luna/resource-efficiency-p1`
Base: `origin/main` at `50d0567`

## Scope and measurement conditions

This pass optimizes the cost of leaving YUVI open all day. It does not change
provider quality, Memory provenance, Alice voice settings, Lumi behavior, or
Product UI behavior.

Measurements were taken on the Linux development machine while the existing
Grok/Sol desktop processes were left running. No shared process was stopped or
restarted. RSS is reported in MiB (1024-based); GPU memory is the value reported
by `nvidia-smi`. CPU is the process-group percentage of one CPU core, measured
from `/proc` over the sample interval. GPU utilization and power are device-wide
because the driver does not attribute compositor work as a normal compute
process.

Host: Intel Core Ultra 9 275HX, 24 CPUs, 46 GiB RAM, RTX 5080 Laptop with
16,303 MiB VRAM.

The machine-baseline scenario (YUVI fully stopped) was not collected because
the live desktop/server belongs to parallel work. This keeps the baseline
non-destructive; the YUVI-only measurements below exclude unrelated desktop
processes where possible.

## Baseline scenarios

| Scenario | Result | YUVI RSS | YUVI CPU | GPU result |
| --- | --- | ---: | ---: | ---: |
| A. Machine baseline | Not collected; shared desktop preserved | N/M | N/M | N/M |
| B. YUVI dev idle | Server + Supervisor + Tauri/WebKit/Lumi + Vite | 1,742 MiB at sample end | 42.16% avg over 30 s | No YUVI compute process; device 4,861 MiB, 9% avg, 21.09 W |
| C. Remote text chat | Not runnable; DeepSeek credentials/model are not configured | N/M | N/M | N/M |
| D. Local model chat | Not configured; no local chat model/server is present | N/M | N/M | N/M |
| E. Memory-heavy activity | Not runnable; Mem0 sidecar/PostgreSQL are unavailable and current server uses in-memory Memory | N/M | N/M | N/M |
| F. Alice speech | Direct wrapper and server-path TTS smoke calls succeeded | 6,022 MiB peak for YUVI + local embedding + Alice stack | Alice active; see component table | Alice 3,562 MiB peak, device peaked at 100% / 131 W |
| G. Voice input | Not configured; STT reports unavailable | N/M | N/M | N/M |
| H. Vision | Not configured; Vision reports unavailable | N/M | N/M | N/M |
| I. Full activity | Not reproducible with the current provider configuration | N/M | N/M | N/M |

The idle CPU sample was dominated by the existing Lumi renderer: 37.39% of one
core over 20 seconds, with the Tauri process at 4.70%. The server was near zero
in the same sample. This is evidence for Sol/P6 follow-up, not a change made in
this branch.

The 30-second `/proc` I/O counters for the sampled YUVI process group did not
move. The server health record did show the Memory ingestion coordinator waking
on its existing 15-second poll with zero pending work; that timer remains a
reliability-sensitive follow-up rather than a P1 change.

## Resource inventory

Values are observed idle RSS unless marked otherwise. “Current” means the
process was already running for the shared desktop measurement; “after” means
the new deterministic behavior in this branch and is validated by unit tests
and source-level call accounting, not by replacing the shared live Supervisor.

| Component | Idle RAM | Idle VRAM | Active/peak RAM | Active/peak VRAM | Needed when | Classification |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Runtime server (Node + tsx) | 174 MiB | 0 reported | 174 MiB observed during live stack | 0 reported | Every text/UI session | ALWAYS_REQUIRED |
| Desktop/Tauri + WebKit/Lumi | 1,010 MiB | Graphics use not isolated as compute | 1,010 MiB observed | Not attributed as compute | Desktop open | ALWAYS_REQUIRED |
| Tauri dev launcher + Vite/esbuild | 349 MiB | 0 reported | Same | Same | Development only | DEVELOPMENT-ONLY |
| Desktop Supervisor (Node + tsx) | 198 MiB | 0 | Same | 0 | Service lifecycle/status | ALWAYS_REQUIRED while desktop is open |
| Local embedding llama-server | 678 MiB | 0 | 681 MiB in a 32-item batch | 0 (`--device none`, `--gpu-layers 0`) | Semantic Memory writes/searches | LOCAL-ONLY, ON-DEMAND FEATURE |
| Mem0 Python sidecar | 0 currently | 0 currently | Not measured; currently unavailable | Not measured | Mem0 memory operation | LOCAL-ONLY, ON-DEMAND |
| PostgreSQL + pgvector | 0 currently | 0 | Not measured; not running | 0 | Postgres Memory backend | LOCAL-ONLY, ON-DEMAND |
| Alice wrapper | 73 MiB | 0 reported | 73 MiB | 0 reported | TTS request | LOCAL-ONLY, ON-DEMAND |
| Alice GPT-SoVITS upstream | 3,522 MiB | 3,324 MiB | 3,532 MiB during synthesis | 3,562 MiB during synthesis | TTS request; currently externally resident | LOCAL-ONLY, OPTIONAL |
| Local chat LLM | 0 | 0 | N/M | N/M | Local chat, if configured | OPTIONAL, NOT CONFIGURED |
| STT | 0 | 0 | N/M | N/M | Voice input, if configured | OPTIONAL, NOT CONFIGURED |
| Vision | 0 | 0 | N/M | N/M | Vision request, if configured | OPTIONAL, NOT CONFIGURED |

Observed process counts/threads at idle:

- Server: 2 processes, 23 threads, 174 MiB RSS including the tsx parent.
- Supervisor: 2 processes, 23 threads, 198 MiB RSS including the tsx parent.
- Desktop/Tauri/WebKit: 4 processes, 148 threads, 1,010 MiB RSS.
- Development Vite/esbuild: 3 processes, 50 threads, 349 MiB RSS.
- Local embedding: 1 process, 51 threads, 678 MiB RSS.
- Alice: wrapper + upstream, 112 threads, 3,595 MiB RSS.

The GPU process list showed one Alice compute process at 3,324 MiB idle. The
remaining device memory was compositor/desktop software and unrelated
applications; it is not counted as YUVI resource use.

## Findings

1. The largest remaining YUVI-related idle allocation is the externally
   managed Alice upstream: about 3.5 GiB RSS and 3.3 GiB VRAM. It remains
   resident even when no speech is being generated.
2. The largest measured idle CPU allocation is the Lumi WebKit renderer. This
   branch does not modify it because it is Sol/P6-owned behavior.
3. The Supervisor previously ran a full six-service sweep every 3 seconds in
   development (5 seconds in packaged mode), including probes of unused
   external Ollama, PostgreSQL, and Alice services. In the observed
   detect-only configuration, only Runtime needs continuous status refresh.
4. The Memory ingestion coordinator polls every 15 seconds with an empty
   backlog. It is serialized and bounded, but its recovery-latency tradeoff
   needs a dedicated reliability review before changing the interval.
5. Runtime PostgreSQL facades already shared one pool for the main,
   conversation, and finalized-ingestion paths, but Recent Episode and Dream
   stores could each create another pool. PostgreSQL's default maximum of 10
   connections per pool was unnecessarily server-oriented for a single-user
   desktop.
6. No duplicate YUVI model copy was observed. The local embedding server is
   deliberately CPU-only and the configured `ctx-size` is 2,048 with Q8_0
   weights. Local chat is not configured, so no local LLM weight/KV footprint
   can be responsibly tuned in this pass.
7. No unbounded diagnostic buffer or disk-I/O growth was proven by this sample;
   durable Memory ledgers and event state were not changed.

## Implemented optimizations

### 1. Defer Mem0 initialization until first memory use

Before, the sidecar initialized Mem0 at startup when PostgreSQL was configured,
and an uninitialized health request still probed Ollama and PostgreSQL. After,
startup only validates fixed configuration; `/health` reports a deterministic
`degraded`/`deferred` state, and the first add/search/update/delete operation
uses the existing `ensure_ready()` initialization path.

| Measure | Before | After | Delta | UX cost / semantic risk |
| --- | --- | --- | --- | --- |
| Idle Mem0/Ollama/PG load | Startup load when configured | No load before a memory operation | Removes startup residency and health-triggered probes | First real Mem0 operation pays the existing cold-load time; no Memory data/provenance semantics changed |
| Health side effects | Embedder + vector-store probes when not ready | No optional-resource probes while deferred | No repeated model/database wakeups from health | `degraded`/`deferred` is explicit; unavailable is not reported as empty |
| Live RAM/VRAM delta | Not measurable: sidecar/PG unavailable in current run | Not measurable in current shared run | Configuration-level saving is high confidence | Requires first-use validation with a configured sidecar |

The existing Mem0 initialization, error, retry, CRUD, search, provenance, and
shutdown paths remain in place. Only when initialization occurs was changed.

### 2. Make Supervisor background refresh slow, serialized, and ownership-aware

Before, the loop ran every 3 seconds in development or 5 seconds in packaged
mode and called `refreshAll()`, which probed every service. After, the default
loop uses a non-overlapping 30-second timeout and refreshes Runtime plus
services that have a managed start command or are already owned. External
optional services are still available to explicit `bootstrap()` and
`refreshAll()` calls.

| Measure | Before | After | Delta | UX cost / semantic risk |
| --- | --- | --- | --- | --- |
| Development refresh cadence | 20 sweeps/minute | 2 sweeps/minute maximum | 90% fewer timer wakeups | Background detection can lag by up to 30 s; explicit refresh remains immediate |
| Packaged refresh cadence | 12 sweeps/minute | 2 sweeps/minute maximum | 83% fewer timer wakeups | Same bounded detection tradeoff |
| Detect-only optional probes | Up to 6 service checks/sweep | Runtime only in current detect-only config | Up to 97% fewer service probes | External service state is not continuously re-polled; user actions still refresh it |
| Overlapping refreshes | Possible when a full sweep exceeds its interval | Impossible: next timeout is scheduled after completion | Removes probe pile-up | None beyond the cadence change |

### 3. Bound and share the single-user PostgreSQL pool

All long-lived TypeScript PostgreSQL facades now use a common YUVI pool factory
with `max: 4` and the existing 10-second idle timeout. The server passes the
main pool to Recent Episode and Dream stores, so the normal Postgres runtime
uses one shared pool rather than three independently bounded pools.

| Measure | Before | After | Delta | UX cost / semantic risk |
| --- | --- | --- | --- | --- |
| Long-lived pool count | Up to 3 runtime pools | 1 shared runtime pool | 2 fewer pool objects | None observed; injected test pools remain supported |
| Maximum connections | Up to 30 possible (`3 × 10`) | 4 possible | 26 fewer possible idle connections | Interactive chat + Memory + voice still fit within four connections; queries queue rather than multiplying connections |
| Live RAM/connection delta | Not measurable; current runtime uses in-memory Memory | Not measurable in current run | Configuration-level reduction | Requires Postgres-enabled smoke test; migrations/backfill one-shot pools are intentionally unchanged |

## Quality and compatibility

- Memory quality and provenance: unchanged. The existing Memory vNext layers,
  finalized-ingestion ledger, Dream idempotency/reconciliation, unavailable
  semantics, and provider cancellation boundaries were not modified.
- Embedding quality: no model, precision, dimensions, or vector-space change.
  A live smoke request returned 3 native 1,024-dimensional vectors from the
  configured Qwen3 Embedding Q8_0 server; YUVI's existing MRL 512 projection
  remains unchanged.
- Alice quality: no checkpoint, reference audio, speaker, language, or sample
  setting changed. The existing Alice wrapper produced valid 48 kHz mono WAV
  output, and the speaker remained `alice`.
- Local chat quality: no regression test was possible because local chat is not
  configured on this machine; no local chat setting changed.
- Normal UX: explicit service refresh and first-use request paths remain
  available. The two intentional costs are up to 30 seconds of passive service
  status staleness and a first Mem0 operation cold-load.

## Hardware target classes

These are measured targets/inferences from the current development footprint,
not certification numbers. Packaged builds should be lower than the measured
development footprint because Vite/esbuild are development-only.

| Class | Measured basis | Practical target with headroom |
| --- | --- | --- |
| REMOTE-FIRST | 1,383 MiB for Runtime + Supervisor + Tauri/WebKit/Lumi, excluding Vite/esbuild and optional local models | 4 GiB RAM class, no dedicated GPU required; local model storage not required |
| LOCAL-LITE | Current live stack reaches about 6,022 MiB RSS with local embedding and Alice active; embedding alone is 678 MiB RSS and CPU-only | 8 GiB RAM class; 4–6 GiB VRAM class if Alice is kept resident; remote main LLM |
| LOCAL-FULL | Not measurable: no local chat model/server is configured | Not certified by P1; measure weights + KV cache + Alice together in P2 before publishing a requirement |

Storage was not reduced in this pass. The measured model assets include the
local Qwen3 Embedding Q8_0 model and the external Alice installation; exact
storage requirements vary by deployment and were not inferred from RSS.

## Validation

Passed on the exact working tree before commit:

- TypeScript `tsc` checks for `packages/memory`, `apps/server`, and
  `packages/desktop-supervisor`.
- 39 focused Vitest tests: 38 Supervisor tests and the PostgreSQL pool test.
- 8 Mem0 Python tests covering deferred lifespan, no-side-effect health, and
  health cache behavior, run in isolated Python 3.11 dependencies.
- Python syntax compilation for the changed sidecar modules/tests.
- Live embedding smoke: 3 mixed Chinese/English inputs, 1,024 native vector
  dimensions, no error.
- Live Alice smoke: wrapper and server-path TTS requests returned valid WAV
  audio; active peak reached 3,562 MiB Alice VRAM.

The normal workspace package-check wrapper attempted a dependency install and
stopped on the pre-existing unrelated `pnpm-workspace.yaml` edit
(`ERR_PNPM_IGNORED_BUILDS` for esbuild). That file remains unstaged and
unchanged by this work. Direct checks above completed successfully.

Exact-head CI and persistence validation are intentionally left for the PR
runner; the existing shared desktop was not restarted into this branch.

## Remaining work / EFFICIENCY-P2

The largest remaining consumer is external Alice GPT-SoVITS: about 3.5 GiB RSS
and 3.3 GiB VRAM while idle. P2 should coordinate with the owner of that
external stack to add a small deterministic lifecycle policy:

`COLD → LOAD → ACTIVE → idle grace → UNLOAD`

The policy should first measure unload/reload latency and actual CUDA memory
reclamation, then preserve Alice's current checkpoints and voice identity. A
second P2 track should measure a configured local chat model's weights, KV
cache, context, and peak VRAM before tuning any local LLM defaults. Lumi's
measured idle CPU should be reviewed by Sol/P6.

## Status

`RESOURCE_EFFICIENCY_P1_PARTIAL`

The three high-confidence YUVI-owned reductions are implemented and tested.
The classification remains partial because shared-process safety prevented a
clean machine-baseline rerun, Alice is externally managed, and local-full
requirements cannot be measured without a configured local chat model.
