# YUVI Operational Landing Audit

**Status:** Phase 8 operational landing audit (Stage 2)

**Audit baseline:** `05b0ddfa0c528cdfd2577264c74304ab1f40a052` (`main`, 2026-09-01)

**Scope:**

```text
DesktopSupervisor/startup
  → Runtime
  → current DeepSeek V4 Flash-class Chat configuration
  → Memory L0/L1/L2 + temporal projection
  → P8/prompt projection
  → local STT
  → current TTS
  → Lumi/Presentation
  → persistence/restart
  → user-visible desktop flow
```

This document records the smallest evidence-backed landing findings. It does
not introduce a new subsystem, change Runtime authority, reopen frozen P8–P7
boundaries, or authorize Phases 9–13.

## Audit method

- Traced the actual Tauri, Supervisor, Runtime, provider, Memory, prompt,
  persistence, and desktop-surface paths in the audit baseline.
- Ran the focused existing tests for Memory vNext Runtime integration, Runtime
  streaming, media routes, packaged Supervisor layout, and the desktop main
  page: **5 files, 110 tests passed**.
- Did not perform live provider calls, collect user conversations, start
  training infrastructure, or modify external service state.

## Findings

### BLOCKER B1 — Linux desktop bootstrap cannot start the default Runtime command

The development Supervisor resolves the default Runtime command to
`pwsh scripts/dev-server-runner.ps1` on every non-Windows platform
(`packages/desktop-supervisor/src/config.ts:559-589`). The Tauri desktop startup
path does not provide a Linux shell fallback and opens the main window before
Supervisor bootstrap (`apps/desktop/src-tauri/src/lib.rs:118-143`). On this
Linux audit host, `pwsh` is not installed. A normal desktop launch therefore
can paint the chat window while the Runtime remains unavailable unless the
developer supplies an explicit start command or separately starts Runtime.

This violates the ordinary desktop startup requirement. The next fix must keep
Supervisor as the owner and make the existing Runtime start path work on Linux;
it must not add another orchestrator.

### BLOCKER B2 — Packaged Runtime does not use the packaged durable store

The packaged Runtime command sets its dedicated data and environment
directories, but does not set `MEMORY_REPOSITORY=postgres`,
`CONVERSATION_REPOSITORY=postgres`, or a generated loopback `DATABASE_URL`
(`packages/desktop-supervisor/src/config.ts:395-429`). The Tauri settings export
also has no repository selector; it exports Memory backend/URLs and only passes
`DATABASE_URL` when a user-managed memory secret is configured
(`apps/desktop/src-tauri/src/config/env_export.rs:39-59,115-121`).

The server defaults to the in-memory repository when those variables are
absent (`packages/config/src/index.ts:137-142,445-451`; `packages/memory/src/env.ts:8-20`),
and the conversation repository follows that selection unless explicitly
overridden (`packages/memory/src/conversation-repository.ts:555-590`). The
Supervisor can initialize and own private PostgreSQL, but the normal packaged
Runtime is not wired to it. Conversation and recent-context state therefore
cannot survive a Runtime process restart on the default packaged path.

The next fix must connect the existing private PostgreSQL authority to Runtime,
including the required schema readiness/migration evidence, without moving
persistence authority into the Supervisor or a new store.

### BLOCKER B3 — Local CPU STT is not an ordinary desktop capability

The repository contains a local CPU STT HTTP provider and sidecar, and the
Supervisor has a `local_stt` service definition. However:

- packaged Supervisor configuration deliberately sets `localSttStart` to null
  and the local STT documentation says packaged mode does not infer or start a
  Python sidecar (`packages/desktop-supervisor/src/config.ts:234-238`;
  `services/local-stt/README.md:20-33`);
- desktop packaging stages Runtime, Supervisor, and Mem0 only; no local STT
  executable, Python environment, or model weights are staged
  (`scripts/desktop-package/prepare.mjs:46-107`);
- Tauri settings export has no local STT URL, model, provider selection, or
  sidecar start command (`apps/desktop/src-tauri/src/config/env_export.rs:12-96`);
- the desktop `MainPage` exposes text input and TTS output controls, but has no
  microphone capture, `MediaRecorder`, `getUserMedia`, or call to
  `transcribeAudio`/`sendVoiceMessage` (`apps/web/src/main-page.tsx:731-930`);
- STT routes and `LocalSTTProvider` are available only behind an API boundary
  (`apps/server/src/routes/media.ts:261-353`;
  `packages/providers/src/local/LocalSTTProvider.ts:12-120`).

The dashboard's developer voice page accepts manually supplied Base64 audio;
that is not the ordinary packaged desktop flow. Stage 3 must land the smallest
set of explicit desktop capture/configuration/service atoms needed to make the
existing local STT path usable. It must preserve the existing Runtime and
Supervisor ownership boundaries and must not add a second audio authority.

### PRODUCT_GAP P1 — Packaged desktop does not select the current V4 Flash-class Chat path

The repository environment example selects a replaceable OpenAI-compatible
DeepSeek V4 Flash-class model (`.env.example:106-128`), but the packaged Runtime
start environment does not include that provider selection
(`packages/desktop-supervisor/src/config.ts:395-429`). The desktop settings
default to provider `deepseek` and model `deepseek-chat`, and the only Chat
provider exposed by the Tauri settings UI is `deepseek`
(`apps/desktop/src-tauri/src/config/schema.rs:117-132`;
`apps/web/src/user-settings-panel.tsx:185-205`).

The existing provider abstraction is replaceable, but the actual packaged
desktop path is not yet wired to the current V4 Flash-class baseline. This is a
configuration/selection gap, not a request to make DeepSeek part of Character
identity.

### PRODUCT_GAP P2 — Packaged TTS configuration claims a local Alice stack that is not packaged or managed

The packaged settings export forces `DEFAULT_TTS_PROVIDER=local`,
`TTS_PROVIDER_CHAIN=local`, and `LOCAL_TTS_MODEL=alice-v4`
(`apps/desktop/src-tauri/src/config/env_export.rs:70-75`). The packaged
Supervisor nevertheless sets both GPT-SoVITS start commands to null
(`packages/desktop-supervisor/src/config.ts:247-254`), and the package prepare
step stages no GPT-SoVITS wrapper/upstream or model assets
(`scripts/desktop-package/prepare.mjs:46-107`). The default user setting is
TTS enabled but external (`apps/desktop/src-tauri/src/config/schema.rs:143-148`).

The companion playback and `/v1/tts` path are wired, but a fresh packaged
install needs a separately running compatible TTS service to produce audio.
This is a product gap for zero-ritual embodied voice use; it is not a reason to
change Presentation or Runtime authority.

## Confirmed working seams

These paths are present and passed the focused tests at the audit baseline:

- **Text Runtime path:** Tauri main surface → `/v1/messages/stream` →
  `RuntimeOrchestrator.streamUserMessage` → configured Chat provider, with
  persistence-before-publish and bounded cancellation handling
  (`apps/server/src/routes/message-stream.ts:26-157`;
  `packages/core/src/runtime-orchestrator.ts:712-790`).
- **Memory-first prompt path:** Direct Context, reconstructed L1 recent
  episodes, bounded associated L1/L2 recall, and thin temporal projection are
  assembled before the provider-neutral prompt (`packages/core/src/runtime-orchestrator.ts:1518-1576,3131-3184`).
- **Runtime restart reconstruction seam:** the Runtime attempts to restore
  Direct Context from the conversation repository and fails closed to empty
  context with a persistence event if restoration is unavailable
  (`packages/core/src/runtime-orchestrator.ts:2833-2866`). The remaining gap is
  the packaged repository selection in B2.
- **TTS/Presentation seam:** MainPage forwards bounded speech segments over
  `CompanionBus`; CompanionPage owns browser audio, queue, analyser, and Lumi
  presentation (`apps/web/src/main-page.tsx:635-679`;
  `apps/web/src/companion-page.tsx:54-58`).
- **Lifecycle and truthful status:** Tauri creates the split windows, starts
  the existing Supervisor, exposes service status/retry, and requests owned
  service shutdown on main-window close. Companion close does not terminate
  Runtime/Mem0/TTS (`apps/desktop/src-tauri/src/lib.rs:89-143,309-370`;
  `apps/web/src/service-status-panel.tsx:83-126`).
- **P6 boundary:** the ordinary message stream rejects proactive-decision
  events, preserving the current `NO_OP | REQUEST_TEXT` proactive boundary;
  no broader proactive authority is proposed by this audit.

## Stage 3 order

Fix one smallest atom per PR, re-auditing the exact current `main` after each
merge:

1. **B1:** make the existing Linux desktop Runtime start path self-contained.
2. **B2:** wire the existing packaged private PostgreSQL connection and schema
   readiness into Runtime conversation/Memory persistence, then verify
   restart/reconstruction.
3. **B3a:** add ordinary desktop audio capture and a visible local-STT action
   through the existing media boundary.
4. **B3b:** add the smallest explicit local-STT configuration/selection seam
   and Supervisor ownership needed by that UI.
5. **B3c:** package/provision the local STT runtime and model assets only after
   the preceding path is proven, keeping weights out of Git.
6. **P1/P2:** close Chat baseline selection and packaged TTS provisioning as
   separate product atoms, with real-use evidence determining any further work.

## Explicit deferrals

- Full Temporal or Continuity subsystems remain deferred until the current
  Memory-first path fails a repeatable semantic evaluation.
- P8, Character ABI, Harness, Cognition, MCP, Presentation, and P6 ownership
  boundaries remain closed.
- No bakeoff, QLoRA/SFT, DPO, shadow/A-B, preference training, automatic
  ingestion, or preference-data flywheel work begins here.
- **`PHASES_9_13_DEFERRED`** remains an explicit operational gate.
