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
