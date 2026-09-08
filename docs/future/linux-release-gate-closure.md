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

## Final statement

LINUX_RELEASE_GATE_CLOSED

