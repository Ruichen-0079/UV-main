# Linux Release Gate Closure

Authority SHA (packaged closure): `2bcee41ac731729a7ccd514016f979f81e9b3747`.

Campaigns A-I: CLOSED. This gate does not reopen Campaign I and does not start Windows/macOS/perf work.

## Contract

Supported Linux daily path is the **packaged** install (`yuvi-linux-daily-packaged`), not a live source checkout.

- Stable install root (PRIMARY): `/home/ruichen/.local/share/yuvi/linux-install`
- Units: `yuvi-daily` / `yuvi-daily-web` run bundled Node + supervisor packaged mode + static WebUI on :5173
- Private weights are not bundled; external sidecars remain machine adapters / prerequisites
- Native Linux installer class: not applicable (Tauri NSIS only)
- **Checkout tarball is NOT the closure artifact**

## Defects fixed during gate

1. Pre-fix campaign worktree runtime / Campaign-H leftovers to stable packaged units (earlier)
2. Source-checkout units using source-dev runners to packaged CJS/static (`2d8a8e4`, `5064c29`)
3. Premature closure docs that claimed checkout tar was final rewritten here
4. Packaged Node initially host-linked replaced with official nodejs.org v24.20.0 linux-x64 binary inside the install root / closure artifact
5. Public Linux packaging no longer copies the private dots.tts-soar service implementation (`2bcee41`)

## Closure artifact

- Name: `yuvi-linux-daily-packaged-2bcee41.tar.zst`
- SHA-256: `a1d645a7972545b95884c45d73644936f200e2eeb10655b3c81c635035653b27`
- Size: `42850242` bytes
- Kind: `yuvi-linux-daily-packaged` @ `2bcee41`
- Root paths: `linux-install/supervisor/yuvi-desktop-supervisor.cjs`, `linux-install/runtime/yuvi-runtime-server.mjs`, `linux-install/runtime/node`, `linux-install/web/static-server.mjs`, `linux-install/web/dist`, `linux-install/install-linux-daily.mjs`
- Audit: private home model paths=0, campaign/private path refs=0, credentials=0, private weights/venvs/Rei assets=0, dots private service implementation bundled = 0, symlinks=0

## Source-checkout isolation

`source_isolation_pass`: renamed `release-checkout` to `release-checkout.isolated-for-gate`, restarted packaged units; stop/start and repeated restart kept WebUI HTTP 200 and Runtime healthy; no YUVI-owned cwd under release-checkout / campaign / Projects source trees; no package-manager or source-dev runners / `.ts` production entry / `.git` cwd dependency. Restored checkout name after test.

## Matrix PRIMARY_KDE_LOCAL vs SECONDARY_XFCE_CLOUD

| Gate | PRIMARY | SECONDARY |
| --- | --- | --- |
| Packaged artifact/install | PASS active linux-install | PASS extract no git clone |
| Official bundled Node | PASS v24.20.0 | PASS exec |
| Lifecycle stop/start/restart | PASS | ENVIRONMENT_LIMITATION (no systemctl); supervisor listen smoke PASS |
| Zero campaign runtime | PASS | PASS |
| Source independence | PASS (isolation rename) | PASS (no .git in extract) |
| TTS warm + hibernate 180s + resume | PASS (external dots, not bundled) | ENVIRONMENT_LIMITATION (no NVIDIA) |
| Settings Memory Live2D | Settings API auth-gated without token; prior Memory/Live2D path still valid | limited |
| Reinstall / uninstall | Prior packaged-unit proof retained | unit files + desktop entry written; enable blocked by missing systemctl |
| KDE Spectacle / mic | HUMAN_ONLY | NOT_APPLICABLE |

### Classifications

- PASS: packaged artifact, source isolation, PRIMARY lifecycle, TTS warm/hibernate/resume, XFCE extract/node/web/supervisor-listen
- RELEASE_DEFECT: none open for closure (prior source-dev checkout units and premature checkout-tar closure fixed)
- ENVIRONMENT_LIMITATION: XFCE cloud missing systemctl --user, no NVIDIA; full sidecar stack on box
- EXTERNAL_PREREQUISITE_MISSING: Mem0 Memory LLM unset (degraded infer; prior)
- NOT_APPLICABLE: Linux native installer; XFCE KDE/mic
- HUMAN_ONLY: subjective voice / physical mic / Spectacle UX

## Local model / private adapter boundary

Still valid (see `docs/future/evidence/linux-release-gate/local-model-boundary-audit.json`):

- Chat/reasoning/embeddings/vision: remote-capable; no private weights bundled
- Mem0 Ollama embedding: EXTERNAL_PREREQUISITE
- Local STT weights: external under XDG share; not in artifact
- dots.tts-soar / Rei: PRIVATE_MACHINE_ADAPTER (external bakeoff venv); not bundled
- Generic `TTSProvider` / `LOCAL_TTS_BASE_URL` support remains in the packaged Runtime; the private service implementation is external
- Live2D Core/assets: EXTERNAL_PREREQUISITE

## Evidence

`docs/future/evidence/linux-release-gate/` (audit, artifact, milestones, xfce-secondary, local-model-boundary-audit, PRIMARY lifecycle/isolation under release-artifacts/evidence).

## Final statement

LINUX_RELEASE_GATE_CLOSED
