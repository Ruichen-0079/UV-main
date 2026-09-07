# Linux / CachyOS daily use

This is the supported **checkout installation**: Node, pnpm, the existing
DesktopSupervisor and systemd user units. It is not a standalone native package.
The Product server uses the existing Vite integration, including Supervisor
observations when Runtime is unavailable. No second service manager is installed.

## Install and configure

Use Node 22+ and pnpm 9.15.4. Keep the checkout at a stable, writable location.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm --filter @companion/web build
```

Create a private configuration directory outside the checkout (for example
`$HOME/.config/yuvi-daily`, mode 0700), set `YUVI_RUNTIME_ENV_DIR` to its absolute
path, and configure `.env` / `.env.local` there with mode 0600. `.env.example`
documents the base settings. When migrating an existing checkout, retain **both**
its `.env` and `.env.local`; the latter overrides the former and shell values.
Without the override, the checkout's files remain the default. Never commit them.

Provision external PostgreSQL with pgvector and the configured Ollama embedding
model before starting. Set `DATABASE_URL`, the existing Memory backend settings,
and Mem0's Ollama settings. Existing Runtime startup applies migrations. YUVI
never provisions, starts, stops or removes PostgreSQL/Ollama.

| Resource | Explicit configuration / bounded fallback |
| --- | --- |
| Mem0 | `YUVI_MEM0_PYTHON`: provisioned Python 3.11 with `services/memory-mem0` dependencies. Otherwise create `services/memory-mem0/.venv` and install its `.[dev]` dependencies. Interpreter import preflight remains enabled. `YUVI_MEM0_START_COMMAND` remains an advanced full override. |
| Local STT | `YUVI_AUTOSTART_LOCAL_STT=true`, `YUVI_LOCAL_STT_START_COMMAND="/absolute/venv/bin/python services/local-stt/server.py --model-dir /absolute/models"`, `LOCAL_STT_BASE_URL`. Provision models using the [STT instructions](../services/local-stt/README.md). Set `YUVI_STT_SPEAKER_DIR` explicitly for a new deployment; retain its old path for an existing store. |
| dots TTS | Follow the [dots setup contract](../services/dots-tts/README.md): interpreter, model snapshot, provisioned vocoder assets, reference WAV and exact transcript. Use a relative `services/dots-tts/server.py` script with an absolute external interpreter. No upstream process is needed. |
| Live2D | `LIVE2D_ASSET_ROOT`, `LIVE2D_CORE_PATH`, and the configured model URL. Cubism Framework is built by postinstall; licensed Cubism Core and character assets are externally supplied. |
| Desktop | Build the current Tauri checkout with its documented native build dependencies; use its existing launcher/tray. `yuvi-daily.desktop` opens browser Product. These are distinct existing entry points, not a bundled Linux distribution. |
| Vision | Configure an existing Vision provider if wanted. Product/provider status reports absent configuration truthfully. Only explicit one-shot image analysis is supported. |

Paths in start commands follow the existing command parser; quote paths containing
spaces. Relative scripts resolve against the installed checkout. Installed models,
Python environments and private references must survive checkout replacement.
Launch never downloads models. A missing interpreter/model is a setup failure,
not permission to substitute a mock or download a replacement.

```sh
# Export the actual configuration directory before installation.
export YUVI_RUNTIME_ENV_DIR="$HOME/.config/yuvi-daily"
pnpm daily:linux install
pnpm daily:linux start
# Product: http://127.0.0.1:5173/#/webui
pnpm daily:linux diagnose
pnpm daily:linux stop
pnpm daily:linux restart
```

Install enables `yuvi-daily.service` for the systemd user login target, with
`yuvi-daily-web.service` tied to its lifecycle. It does not enable lingering.
Repeated starts retain the existing service; restart replaces the owned tree.
The Tauri launcher deliberately refuses to adopt another launcher's Supervisor.
Use browser Companion with the daily units; stop the daily units before using
the separate Tauri development launch workflow (including its WebUI server).
Do not expect Tauri tray Quit to control a systemd-owned daily installation.
The units retain stable executable locations and the configuration directory.
Settings changes retain existing precedence; reinstall to change the directory.

For update/reinstall: stop YUVI, update or replace the checkout, install dependencies,
run checks/build, then run `install` and `start` from the new checkout with the same
configuration directory. Retain the previous checkout until acceptance succeeds.
Reinstall rewrites the same two units and desktop entry; it does not run a second
Supervisor. Never run old and new checkout launchers concurrently.

`pnpm daily:linux uninstall` disables and stops the daily unit, stops Product,
removes only those two units and the browser desktop entry, and reloads systemd.
It preserves configuration, checkout, all durable data, models, references and
external services. There is deliberately no purge command. Close a separately
launched desktop through its tray Quit before removing its checkout.

## Acceptance and diagnostics

```sh
export YUVI_RUNTIME_ENV_DIR="$HOME/.config/yuvi-daily"
export YUVI_ACCEPT_STT_WAV=/absolute/existing/speech.wav
pnpm accept:linux
```

This opt-in gate uses real installed Runtime, Mem0/PostgreSQL/Ollama, STT and TTS.
It requires configured working Chat and local speech resources; missing resources
fail the gate. It starts the installed daily unit, checks readiness and safe Product
status, sends one real text turn with Memory disabled, transcribes the supplied
speech, synthesizes one short WAV in memory, checks the Companion shell, installed model/Core and Vision
configuration truth, writes one isolated temporary Mem0 marker, restarts through
Product, checks Memory read/search and unchanged profiles, stops all daily cgroup
processes/listeners, verifies external infrastructure, starts again and checks
persistence. It removes its Memory marker and leaves daily services running.
Runtime conversation evidence for the test session follows normal durable policy.
Speech text, audio, profiles and Memory bodies are never printed by the gate.
The Companion shell check alone does not prove character rendering.

`pnpm daily:linux diagnose` prints only fixed systemd lifecycle properties and an
allowlisted Supervisor status projection. It excludes environment, commands, logs,
URLs, credentials, raw errors, Memory, embeddings, audio and screenshots. Product's
existing provider/local-intelligence views give capability diagnostics. A status
export is operational evidence, not proof that every optional provider can perform
inference. Vision configuration is checked without sending a screenshot or image.

Additional gates:

```sh
node --test scripts/daily-use-linux.test.mjs
pnpm check
pnpm test
pnpm --filter @companion/web build
(cd apps/desktop/src-tauri && cargo test --lib && cargo build)
pnpm desktop:close-tray:linux
```

The last command requires a real KDE session and runs the existing isolated
close/hide/tray/quit gate without repeated GUI clicking. Physical microphone,
echo/barge-in experience, subjective Rei voice and Companion motion remain the
consolidated human acceptance from Campaigns D–F.

## Filesystem and ownership

Do not relocate working durable stores to make their names prettier.

| Class | Existing contract |
| --- | --- |
| Configuration | Explicit `YUVI_RUNTIME_ENV_DIR`, or checkout `.env` and `.env.local`; preserved on uninstall. |
| Durable data | External PostgreSQL; existing Mem0 history; configured STT speaker store (legacy default is under model directory); runtime settings and conversation evidence. Never cache. |
| Operational state/logs | Existing XDG data-home `YUVI/DesktopSupervisor` retained because Tauri and Supervisor share its pointer/ownership contract. Per-instance state is not moved. Owned stdout/stderr retain 2 MiB plus one 2 MiB rotation per stream; startup deletes only known logs older than 30 days in inactive instance directories, retaining ownership metadata. |
| Cache | Existing XDG cache-home `YUVI` in packaged contracts; ordinary launch does not populate a new model cache. A provisioned HF cache containing required weights/vocoder files is an installed resource, not disposable. |
| Models/references | Explicit externally installed model directories, Live2D/Cubism assets and private Rei reference assets. Preserved on uninstall. |
| Temporary audio | Daily acceptance keeps synthesis and STT payloads in memory. Existing standalone subjective/model gates may retain explicitly reported temporary artifacts for human inspection. |

Historical Windows/private-PostgreSQL packaging scripts are not Linux authority.
Campaign B's launch architecture is retained. Native distro packaging and the
historical resource-efficiency issue #166 remain deferred unless measurement shows
a current concrete problem.
