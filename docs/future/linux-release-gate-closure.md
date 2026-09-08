# Linux Release Gate Closure

Authority main SHA (start/identical): `7f997044d2178b93adf06929aeeaad64053bff71`.

Campaigns A-I: CLOSED. Does not reopen I; does not start J/Windows/macOS/perf.

## Contract

Daily checkout install is the supported Linux path.

## Contract

Daily checkout install is the supported Linux path (docs/linux-daily-use.md).
Stable root: /home/ruichen/.local/share/yuvi/release-checkout at 7f99704.
Native linux installer class: not applicable (tauri nsis only).

## Defect fixed

Pre-fix persistent runtime used campaign worktrees for units and TTS; Campaign-H ports leftover.
Fix: stable release-checkout units; relative TTS server.py with bakeoff venv; H leftovers terminated.
Active units and env contain zero campaign path refs.

## Artifact

- Name: yuvi-linux-daily-checkout-7f997044d217.tar.zst
- SHA-256: ce59be28703bd9ff1030e0e1297394e13e51fc5c44f60d8fd1a8e21ceb9c9d9a
- Size: 4638709 bytes
- Campaign/sensitive hits in archive: 0

## Matrix PRIMARY_KDE_LOCAL vs SECONDARY_XFCE_CLOUD

| Gate | PRIMARY | SECONDARY |
| --- | --- | --- |
| Artifact/install | PASS daily linux stable root | PASS tarball extract no git clone |
| Lifecycle | PASS | env limitation no systemctl |
| Zero campaign runtime | PASS | PASS |
| accept linux | PASS exit 0 in 52.3s | not applicable |
| TTS warm and hibernate 180s | PASS | env limitation no NVIDIA |
| Settings Memory Live2D | PASS | limited |
| Reinstall over existing | PASS | installer unit test PASS |
| Uninstall reinstall | PASS config pg ollama kept | env limitation |
| Source independence | PASS | PASS no .git in extract |
| KDE Spectacle mic | human only | not applicable |

### Classifications

- PASS: PRIMARY accept, lifecycle, artifact, zero campaign, uninstall/reinstall
- RELEASE_DEFECT: pre-fix campaign worktree runtime (fixed)
- ENVIRONMENT_LIMITATION: XFCE box systemd and NVIDIA gaps
- EXTERNAL_PREREQUISITE_MISSING: Mem0 Memory LLM unset (degraded infer; crud/search OK)
- NOT_APPLICABLE: Linux native installer; full accept on box; XFCE KDE/mic
- HUMAN_ONLY: subjective voice / physical mic / Spectacle UX

## Evidence

docs/future/evidence/linux-release-gate/ (audit, artifact, primary results, xfce-secondary, milestones.jsonl)

## Local model / private adapter boundary

| Capability | API/external alternative | Local payload bundled? | Required for release? | Missing behavior |
| --- | --- | --- | --- | --- |
| Chat / Reasoning | openai-compatible remotes | No | No | Use remote chain |
| Runtime EmbeddingProvider | openai-compatible, nvidia | No | No | Use remote chain |
| Mem0 Ollama embedding | None claimed as drop-in | No | No (EXTERNAL_PREREQUISITE) | Mem0 degrades / search fail-closed |
| Local STT ASR + speaker/diarization/VAD | DashScope STT (ASR) | No (manifest IDs only) | No | Local unhealthy; remote STT if configured |
| dots.tts-soar / Rei TTS | xAI TTS | No | No (PRIVATE_MACHINE_ADAPTER) | Local TTS absent; remote TTS if configured |
| Local Vision | xAI, nvidia | No | No | Truthful unavailable |
| Live2D Core + character assets | n/a | Framework yes; Core/assets no | No (EXTERNAL_PREREQUISITE) | Setup failure without Core/assets |
| Generic provider interfaces | built-in remotes | Code only | Yes | N/A |

Artifact scan: private machine model/assets bundled=0; private venvs=0; private speaker/voice data=0; licensed Cubism Core=0. Historical campaign evidence docs may mention absolute paths already on main (not weights).

See `docs/future/evidence/linux-release-gate/local-model-boundary-audit.json`.

## Final statement

LINUX_RELEASE_GATE_CLOSED

