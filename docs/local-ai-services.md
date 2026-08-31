# Local AI services (P1)

Service Manager extends DesktopSupervisor. It owns process/systemd lifecycle
only. Provider/Runtime still own AI semantics and Memory retrieval.

Ownership: `managed-process` | `systemd-user` | `external`.
External services can be observed/tested, never stopped.
Allowlisted systemd units only: `gpt-sovits-upstream.service`,
`alice-tts-wrapper.service`, `yuvi-local-embedding.service`.

Lifecycle: `STOPPED` / `STARTING` / `READY` / `BUSY` / `ERROR`.
Start policy: Alice/Embedding `ALWAYS`, STT `ON_DEMAND`, future LLM `MANUAL`.

STT models (not in Git): `services/local-stt/models.manifest.json`.

Speaker profiles are local files under the STT speaker directory (`YUVI_STT_SPEAKER_DIR`):
- `speakers.json` — public metadata only (`speakerId`, `label`, `enrolledAt`), mode `0600`
- `speakers.npz` — raw speaker embeddings, mode `0600`

Embeddings are persisted so identify survives STT restart. Product API and logs
must never return or print raw embeddings; responses are metadata plus
`KNOWN`/`UNKNOWN`. Scores below the cosine threshold stay `UNKNOWN`.
