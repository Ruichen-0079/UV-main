# Campaign G — Linux daily-use integration

Starting freshly fetched main: `8082395252944b9c5e7202236123eed2beecf068`.
The active machine installation initially pointed at the Campaign B checkout.
Campaign G acceptance instead installed a fresh worktree from that main, with
frozen workspace dependencies and retained external resources/configuration.

## Audit and changes

- Reused Campaign B's two systemd user units, existing Supervisor, Runtime runner,
  Product bridge and Desktop/Tauri lifecycle. No extra service authority or native
  distro package. Vite checkout Product remains explicitly documented.
- Added install/start/stop/restart/diagnose/uninstall commands and documented
  update/reinstall. Uninstall removes only launcher files after stopping its units.
  Actual uninstall/reinstall succeeded with retained configuration and resources.
- Supervisor and the Linux runner now honor Runtime's existing configuration
  directory override. Both private `.env` and `.env.local` were retained outside
  the checkout. Existing durable stores were not moved.
- Added explicit Mem0 interpreter selection with the existing import preflight;
  default remains the bounded repository venv. Existing explicit STT/dots commands,
  model roots, private reference and Live2D/Cubism paths were reused. Current
  checkout scripts run with externally installed Python/model resources.
- Corrected installer XDG fallback for relative values and stopped persisting
  temporary agent / pnpm-injected PATH entries. Unit child umask is 0077.
- Expanded the Runtime-independent Product projection to STT and TTS. CLI diagnosis
  uses fixed systemd properties and the same safe projection; no arbitrary logs,
  errors, secrets or user content are exported.
- Measured append-only log growth justified two 2 MiB files per stdout/stderr
  stream, with known inactive logs expiring after 30 days at startup. Live process
  metadata blocks cleanup. No data directories are recursively removed, and no
  generic cache framework was introduced. Child streams finish on `close` so exit
  does not prematurely end draining output.
- Existing PostgreSQL/Ollama remain external. Older open branches #146/#163/#166
  were inventoried and not adopted. Historical private-PostgreSQL/Windows packaging
  is not Linux ownership authority; no unrelated branch was merged or revived.

## Local evidence

The authoritative gate is `pnpm accept:linux`, with the two private environment
inputs documented in [Linux daily use](../linux-daily-use.md). The installed gate
passed real text completion, Local STT, dots TTS, Mem0 CRUD/search persistence,
Product restart, profile equality, clean full shutdown and restart. Repeated start
retained the Supervisor PID. All 10 owned cgroup processes disappeared on stop;
Runtime, Mem0, STT, TTS and Product listeners closed. External PostgreSQL and Ollama
remained reachable. Memory and profiles survived. The gate deletes its isolated
Memory marker and retains normal Runtime conversation evidence.

Product, Companion shell, installed Lumi model JSON and Cubism Core were reachable.
Vision reported `configured=false`, `available=false`; no screenshot was sent and
no fake capability was reported. Mem0 correctly reports reduced inference capability
while CRUD/search remain available.

The existing real KDE/Wayland gate passed close-as-hide, WebUI/Subtitle tray control,
windowless tray usability, repeated Quit absorption, graceful exit(0), and zero
owned descendants. This gate uses an isolated desktop instance; it does not claim
subjective motion/voice quality or a packaged binary distribution.

Local validation includes installer fake-systemctl isolation/uninstall tests,
configuration precedence/replacement tests, bounded-output/TTL/disk-error tests,
workspace checks/tests/smoke, production WebUI build, and all 87 Rust library tests.
The real service acceptance was repeated after process-log changes. Diagnostic and
changed-file private-artifact audits exclude environment files, assets, generated
audio, screenshots, profiles and raw Memory from Git.

## Measured resource / disk findings

A 10-second idle sample after acceptance measured:

| Component | CPU (one core = 100%) | Cgroup memory | Processes |
| --- | --- | --- | --- |
| Runtime/Supervisor/owned speech and Mem0 | 0.84% | 4932.9 MiB | 8 |
| Product Vite server | 0.04% | 371.5 MiB | 2 |

Dots was the YUVI GPU resident at approximately 5298 MiB. Other pre-existing GPU
processes were outside YUVI ownership. These numbers are a local short sample, not
a long-duration benchmark; enabled dots model residency is expected.

Supervisor history was approximately 23.7 MB / 155 files; current-instance logs
increased about 29 KB during observation. That measured unbounded log behavior is
now bounded as described above. No generated audio is written by the daily gate.
No measured disposable model/cache problem justified deleting provisioned weights,
reference assets, speaker stores or external database data. #166 remains deferred.

Human-only acceptance remains consolidated across Campaigns D–F: microphone
permissions, echo/self-trigger and barge-in experience, thinking pauses, Rei voice
quality, and Companion speaking/motion appearance. Campaign H is not included.
