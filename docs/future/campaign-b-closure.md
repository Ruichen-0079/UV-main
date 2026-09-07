# Campaign B — Linux daily use and local speech

Continues the dirty Campaign B implementation layered on `ac729800d317fdf6763065a4bef7131381b324d0`. No models were replaced or downloaded.

## Delivered

- Product Local intelligence: real STT/VAD/diarization readiness, acoustic profile enrollment, recognition checks, listing/deletion, and explicit separation from semantic person identity.
- Mem0 connection settings and live capability evidence: Ollama embedder, pgvector, CRUD/search, and truthful degraded `infer=false` operation.
- Speech provider routing alongside existing Chat/Reasoning configuration, browser links to Chat/Voice Mode, Companion and Subtitle, and `#/webui` surface recognition.
- Dedicated `LOCAL_STT_BASE_URL` across Desktop, Runtime settings and ProviderRegistry. It never falls back to the generic Chat/Reasoning `LOCAL_MODEL_BASEURL`. Old local STT configuration must move to the dedicated key.
- Desktop no longer writes `DEFAULT_TTS_PROVIDER`, `TTS_PROVIDER_CHAIN`, or a fake `alice-v4` model. Concrete compatibility adapters remain behind ProviderRegistry; no voice was selected.
- SenseVoice language tag normalization and per-span transcript text. Acoustic matches remain cluster-local; labels and vectors do not become person identity.
- Adapter-to-Runtime-to-P8/Memory regression coverage. A mixed claim with an unresolved speaking cluster cannot borrow a known person's authority.
- Supervisor distinguishes running/degraded Mem0 from unhealthy service capability, even when the HTTP envelope says `ok=true`.
- A fixed, authenticated loopback restart action for `yuvi-daily.service`, with no HTTP-provided unit or command.

## Machine inventory at acceptance

| Service/model                                            | Result                                                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| SenseVoice `sense-voice-zh-en-ja-ko-yue-2024-07-17-int8` | Present, wired to local STT on 9876                                                                              |
| 3D-Speaker `3dspeaker-eres2net-base-sv-zh-cn-16k`        | Present, wired for acoustic profiles                                                                             |
| `pyannote-segmentation-3-0`                              | Present, wired for diarization                                                                                   |
| Silero VAD                                               | Present, wired for live activity                                                                                 |
| Ollama `yuvi-embedding:0.6b`                             | Present, wired to Mem0, native 1024 dimensions                                                                   |
| Ollama `qwen3-embedding:0.6b`                            | Present; base model, not separately selected for Mem0                                                            |
| Qwen3-Embedding GGUF service on 8128                     | Present, external; intentionally unused by established Mem0 path                                                 |
| PostgreSQL 16.15 + pgvector on 5432                      | Existing external durable cluster                                                                                |
| Mem0 on 6131                                             | CRUD/search available; reduced capability with no Memory LLM                                                     |
| Historical Yidian/Qwen service on 8088                   | Not reachable; Qwen3.8 and Bonsai GGUF files remain, launch guard rejects coexistence with other model processes |
| Local Chat/Reasoning                                     | Not enabled; existing cloud selection retained, no replacement model provisioned                                 |
| Local TTS / Memory LLM                                   | Unselected/deferred                                                                                              |

The historical local model launch policy was preserved. The embedding-only service on 8128 is not a Chat endpoint.

## Daily launcher and prerequisites

Install with `pnpm exec tsx scripts/install-daily-use-linux.mts`, then `systemctl --user start yuvi-daily.service`. Product is `http://127.0.0.1:5173/#/webui`. Stop with `systemctl --user stop yuvi-daily.service`.

This is a Linux checkout launcher, not a packaged desktop distribution. It requires the checkout dependencies and existing `.env.local` configuration. PostgreSQL and Ollama must already be available; the launcher neither starts nor stops them. A reboot during the prior session left the external PostgreSQL cluster stopped. Restoring that existing cluster restored Runtime migration/startup and Mem0 capability without altering data or provisioning a new database.

The WebUI is part of the daily service lifecycle. Runtime startup runs existing migrations when PostgreSQL persistence is configured. No private environment values, profiles, recordings, embeddings, screenshots, or model assets belong in Git.

## Acceptance

- Workspace checks, workspace tests, smoke, and Rust desktop library tests.
- Opt-in real STT gate: `YUVI_STT_MODEL_DIR=/existing/model/directory /existing/stt/venv/bin/python -m unittest discover -s services/local-stt/tests`. Ten tests passed, including real WAV transcription, enrollment/later speech matching, store reload, private file modes, silence NO_MATCH, mixed-speaker enrollment rejection and cluster-local words/profiles. The gate isolates and removes its own acoustic store.
- Automated installed-service acceptance: `pnpm exec tsx scripts/test-daily-use-linux.mts --run`. This intentionally restarts/stops/starts the installed daily services, writes one isolated temporary Memory record, verifies read/search and profile persistence, removes its record, and restores services even on failure.
- Firefox browser acceptance confirmed live local capability status, Models & Providers, speech routing and coexisting Chat/Companion/Subtitle tabs. The WebUI unit must run in `apps/web` so Tailwind resolves its theme; a real browser exposed and verified the fix. Lifecycle acceptance now fetches CSS as well as the HTML shell.
- A real WAV through Runtime `/v1/audio/transcriptions` returned HTTP 200, a local-provider observation and a diarized span. The attempted full `/v1/voice/message` flow returned provider-unavailable from the configured remote route; no full real assistant completion is claimed. Remote network availability remains an external acceptance limit, while existing assistant-flow tests pass.
- Product restart changed the launcher PID. Full shutdown closed Runtime, Mem0, STT and WebUI listeners while PostgreSQL/Ollama stayed reachable. Clean start restored all four services and persisted state. Process inspection found one Mem0 and one STT process, with Runtime's pnpm/tsx chain entirely inside the one daily-service cgroup.
- Existing Voice Mode, interruption, capture-fencing, Companion coexistence and subtitle/output-language tests remain in the passing workspace suite.

Physical microphone permissions, real conversational timing and subjective daily experience remain human acceptance. TTS audio quality is deliberately outside this campaign. The recommended next campaign is provider-level TTS selection and integration, without moving model-specific policy into Runtime or Character.
