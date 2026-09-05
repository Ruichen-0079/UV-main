# Atom 05 — App / Data / Cache Roots

> **Status: FUTURE PLAN — NOT IMPLEMENTATION AUTHORITY**
>
> **Rebaseline (Linux-first CI rebaseline):** this atom is ACTIVE on the
> Linux-first lane and may proceed before final Linux packaging. No Windows
> prerequisite blocks it; deferred Windows Atoms 01–02 are irrelevant here.
> See Platform policy in [README.md](README.md).
>
> **Audit baseline:** `2a3d4814a4763fb2772d275540bf21a3e645e324`
>
> The current `origin/main` source, tests, merged closure documents, and live
> dependency state are authoritative. Before implementation, fresh-fetch main,
> relevant files, relevant open PRs, and exact dependency state. Reclassify every
> important statement below as **CURRENT / PLANNED / GAP**. If main contradicts
> this plan, main wins and the plan must be updated rather than forcing old design
> into new code.
>
> This atom must remain the smallest behavior-preserving semantic change that
> satisfies its acceptance criteria. Do not create a second Runtime, second
> ledger, generic orchestrator/agent graph, provider router, giant event bus, or
> broad Manager/Engine abstraction merely to match this document.

## Goal

Freeze platform-appropriate application roots before durable voice identity and
later deployment work make path migration expensive.

## Dependencies

Desktop lifecycle/surface atoms should be stable enough that path changes are
not mixed with tray behavior. Per the rebaseline, this atom may proceed before
final Linux packaging and is not blocked by any Windows prerequisite.

## CURRENT at audit baseline

Desktop/Supervisor state uses existing YUVI state-directory helpers. The local
STT sidecar defaults speaker profile files under its model directory when
`YUVI_STT_SPEAKER_DIR` is absent. That location must not become durable
person-identity architecture by accident.

## TARGET

Define one small path contract separating at least:

- **config**: user-editable configuration and secret references/settings;
- **data**: durable user-owned application data that must survive cache clears,
  including future durable acoustic profile assets when authorized;
- **cache**: rebuildable/downloadable/derived data whose deletion must not erase
  user semantic state.

Use mature platform directory primitives already available in Tauri/Rust/Node
before custom path logic.

## Required constraints

- Do not classify model files as cache merely because they are large; classify
  by rebuildability and ownership.
- Do not move databases, speaker profiles, or settings without an explicit
  compatibility/migration decision based on current installs.
- Runtime semantics must not depend on OS path strings.
- No new persistence database.
- Voice acoustic data must not remain implicitly coupled to model install
  directories after Voice Identity lands.

## Acceptance

- Every existing desktop-owned persistent artifact has one documented root
  classification.
- Windows and Linux resolve roots deterministically.
- Supervisor/server/sidecars receive paths through existing configuration/env
  composition rather than hard-coded cross-layer imports.
- Existing installs either migrate safely or retain a documented compatibility
  path.
- Cache deletion cannot erase explicit user suppression policy or future
  enrolled voice profiles.

## Stop condition

Stop after root semantics and the minimum required path migration are complete.
Do not perform Linux packaging in this atom.

## Mandatory implementation start protocol

1. Fresh-fetch current `main`, the exact files this atom touches, relevant open
   PRs/branches, and tests.
2. Record the exact base SHA before changing anything.
3. Confirm predecessor atoms on which this plan depends are actually merged or
   re-evaluate the dependency.
4. Keep provider/device/wire details outside stable Character/Cognition/P8
   semantics unless this atom explicitly owns that boundary.
5. Implement one immutable atom, run focused tests plus required broader gates,
   inspect exact diff, then stop at this atom's stop condition.

---

## Closure (implemented)

**Status: DONE.** Implementation base: `d100b13a6c7835dcc227631bc1336ab96da3b975`.
Windows remained deferred; no Linux packaging, desktop entry, updater, or
Voice Identity/TTS work was performed in this atom.

### Root contract

`packages/desktop-supervisor/src/app-roots.ts` owns one small, pure,
deterministic resolver:

```text
AppRoots
├ configRoot   user-editable configuration / non-secret settings
├ dataRoot     durable user-owned state; must survive cache clears
└ cacheRoot    rebuildable artifacts; deletion must never erase durable state
```

Resolution order per root: explicit absolute env override
(`YUVI_CONFIG_ROOT` / `YUVI_DATA_ROOT` / `YUVI_CACHE_ROOT`) → platform default.

- Unix (primary: CachyOS / KDE Wayland) follows XDG Base Directory semantics:
  config = `$XDG_CONFIG_HOME|~/.config` + `/com.yuvi.companion`,
  data = `$XDG_DATA_HOME|~/.local/share` + `/YUVI`,
  cache = `$XDG_CACHE_HOME|~/.cache` + `/YUVI`.
- Windows keeps the existing deterministic composition:
  config = `%APPDATA%/com.yuvi.companion`, data = `%LOCALAPPDATA%/YUVI`,
  cache = `%LOCALAPPDATA%/YUVI/cache`.
- The YUVI-managed data/cache namespace is the stable name `YUVI`; the config
  root follows the Tauri app identifier `com.yuvi.companion` because user
  settings already live in the Tauri-owned config directory. Machine user
  names are not part of the semantic contract.
- Installation resources are NOT part of this contract:
  `SupervisorLayout.resourceRoot` remains the immutable install/resource
  authority (bundled runtimes, models, Live2D/Cubism assets).

Propagation:

- The packaged Tauri launcher resolves the state root per platform
  (`packaging.rs::desktop_state_dir`): Windows unchanged
  (`%LOCALAPPDATA%/YUVI/DesktopSupervisor`); unix now uses XDG data-home
  (`$XDG_DATA_HOME|$HOME/.local/share` + `/YUVI/DesktopSupervisor`) instead of
  the previous temporary-directory fallback. It passes the Node Supervisor its
  data root via the existing `--state-root` composition and additionally sets
  `YUVI_DATA_ROOT` (parent data home, non-secret) so PG/Live2D/Mem0 defaults
  resolve inside the same durable data home.
- `SupervisorLayout.packaged` now carries `configRoot` and `cacheRoot`
  alongside `resourceRoot`/`dataRoot`; the loader derives them via
  `resolveAppRoots` from the composed env (input overrides win).
- Runtime semantics (Character/Cognition/P8/Memory schemas) never see OS path
  strings; paths flow desktop/platform → Supervisor/config/env composition →
  server/sidecars as concrete values.

### Existing artifact inventory and classification

| Artifact | Current path authority | Classification | Migration |
| --- | --- | --- | --- |
| Supervisor instance state (`instances/<id>`, ownership metadata, control endpoint, exit log) | `<dataRoot>/instances/<id>` (packaged); dev: `defaultStateDirectory()` (repo-local, intentional) | DATA | none |
| Service diagnostics logs (`runtime.log`, `mem0.log`, `postgres.log`, `local-stt.log`, `tts-*.log`, `ollama.log`) | `<stateDirectory>/<service>.log` (per-instance) | rebuildable diagnostics; intentionally kept beside instance state inside DATA (never inside cache root) | none |
| Runtime writable data + packaged Runtime env dir (`.env` / `.env.local`) | `<dataRoot>/runtime-data` via `YUVI_RUNTIME_DATA_DIR`/`YUVI_RUNTIME_ENV_DIR` | durable runtime state = DATA; the env file inside it is user-editable config (CONFIG semantics) kept in place — documented, no move | none |
| Local STT durable speaker profiles (`speakers.json`, `speakers.npz`, future enrolled acoustic profiles) | `<dataRoot>/local-stt/speakers` via `YUVI_STT_SPEAKER_DIR` (Supervisor always sets it) | DATA (never model assets) | none |
| Local STT model assets | `<resourceRoot>/local-stt/models` (bundled; immutable) | RESOURCE | none |
| Mem0 durable data + logs | `dirname(dataRoot)/Mem0/{data,logs}` via `YUVI_MEM0_DATA_DIR`/`YUVI_MEM0_LOG_DIR` (`MEM0_DIR`) | DATA | none |
| Private PostgreSQL cluster (`data/`, runtime metadata, `local.secret`, `pgpass`) | `defaultYuviLocalDataRoot()/Postgres` (packaged safety bound requires it inside the YUVI data home; explicit `YUVI_POSTGRES_DATA_ROOT` override) | DATA (secret material stays inside the cluster runtime dir; no plaintext migration) | none |
| PostgreSQL secret authority | Windows Credential Manager (keyring) — unchanged | secret authority (out of scope, untouched) | none |
| Tauri user settings (`settings.json`) | Tauri `app_config_dir` = `<configRoot>/settings.json` | CONFIG | none |
| User Live2D model assets / Cubism Core fallback | `defaultYuviLocalDataRoot()/{Live2DModels,CubismCore}` (bundled copies live under resourceRoot) | user-created durable assets = DATA | none |
| Model downloads / derived artifacts | none at runtime today (provisioning is a dev-time script into resources) | future consumers must use `cacheRoot` for rebuildable downloads | n/a |
| Webview/desktop shell storage | Tauri/WebView platform defaults | desktop-shell owned (out of scope) | none |

### Migration / compatibility decisions

- No durable artifact moved. No released Linux packaged install exists
  (packaging has not started; packaged manifests/binaries are win32-gated), so
  the new unix defaults create no reset risk. Windows composition is
  byte-identical (`%LOCALAPPDATA%/YUVI` chain preserved by
  `defaultYuviLocalDataRoot`, including its `YUVI_DATA_ROOT` override and
  error semantics).
- The unix default of `defaultYuviLocalDataRoot` changed from the legacy
  `~/.yuvi` to XDG data-home. Verified: no `~/.yuvi` state exists on the
  current Linux development machine, dev-mode PostgreSQL defaults to external
  (private clusters are opt-in), and hosted Linux CI uses an external service
  database — option C of the migration rule (no install can contain durable
  data at the legacy path).
- The sidecar standalone fallback `<model-dir>/speakers`
  (`services/local-stt/server.py`) is retained for standalone use; YUVI-owned
  launches always override it with `YUVI_STT_SPEAKER_DIR` under the durable
  data root. Model assets and speaker data remain distinct authorities.

### Tests

- `packages/desktop-supervisor/src/app-roots.test.ts`: root distinctness and
  determinism (unix + win32), XDG override honoring, explicit/relative env
  overrides, cache-root isolation, stable namespace.
- `packages/desktop-supervisor/src/packaged-layout.test.ts`: packaged layout
  carries four distinct roots; loader env/override handling; cache-root moves
  change no durable derivation (state dir, runtime data, speaker dir, PG
  cluster, Mem0 data); immutable resource root vs writable data separation
  (runtime cwd/env, migrations, bundled models); speaker dir stays under the
  data root and out of the model resource tree.
- `apps/desktop/src-tauri/src/packaging.rs` tests: unix state root follows
  `XDG_DATA_HOME`/`HOME`; absolute-base requirements; Windows branch
  (`%LOCALAPPDATA%`) retained behind its platform gate.
