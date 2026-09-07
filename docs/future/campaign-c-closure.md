# Campaign C — Linux local services / Memory closure

Rebaselined on fresh `origin/main` at `dcf2236c02d7659521447337547659fd9a95af22`
(2026-09-07), after PR #270. [Campaign B](campaign-b-closure.md) is closed;
its real-machine acceptance remains evidence for unchanged storage and lifecycle code.

## Already satisfied on starting main

- External PostgreSQL/pgvector plus external Ollama `yuvi-embedding:0.6b`, 1024
  dimensions, fixed Mem0 collection. The legacy Runtime GGUF embedding path
  remains separate; no vector migration or re-embedding is required.
- Mem0 CRUD/search and restart persistence, with absent Memory LLM represented
  as **degraded but operational**, `infer=false`. `Mem0Service.health` probes
  embedding and vector storage separately and does not initialize on health reads.
- Supervisor preserves reduced capability instead of treating degraded Mem0 as
  unavailable. Product receives separate repository, Ollama, embedder, vector
  store, search and inference evidence through `localServicesStatus`.
- The daily checkout launcher owns Runtime, Mem0, local STT and WebUI through
  existing Supervisor/systemd seams. PostgreSQL and Ollama remain external.
  Campaign B already proved clean shutdown, restart, persistence and single
  owned sidecar instances; none of those paths changed here.
- Masked settings and the Product capability allowlist avoid private connection
  strings, model payloads and acoustic embeddings in status.

## Semantic path audit

`apps/server/src/context.ts` constructs `MemoryService` and its selected provider.
Runtime retrieval in `runtime-orchestrator.ts` consumes the neutral
`MemoryProvider` outcome, then `memory-context.ts` builds bounded evidence.
`Mem0MemoryProvider` validates user/persona scope, maps stable event identities,
conversation/source-turn association, timestamps and claim provenance. Retrieval
failure remains an explicit unavailable/error outcome; cross-scope results fail
closed. The existing Core retrieval tests cover the actual Service → Core seam,
including fallback failure and foreign-scope results.

Finalized writes use the existing durable admission ledger and ingestion
coordinator. Runtime reports success only for a complete durable parent; partial
or failed delivery remains visible. The provider writes admitted semantic events
with `infer=false`. The backend's keyed endpoint binds a payload digest and stable
identity; the sidecar commits the pgvector effect and applied journal state in one
PostgreSQL transaction. Ambiguous delivery is reconciled, not blindly retried as
another write. Existing provider, executor, ledger, coordinator and Runtime
persistence tests cover these boundaries. No concrete semantic defect was found;
no Memory, Character or P8 contract was changed.

## Actual remaining gap and follow-up

The Product's detailed local-services request went through Runtime. When an
external PostgreSQL outage prevented Runtime migration/startup, the normal Linux
browser could only report unavailable Runtime and unavailable local status. The
Supervisor already observed the individual dependencies, but its authenticated
status was not available to the daily browser surface.

The daily Vite launcher now offers one read-only `/yuvi-daily/status` bridge to
that existing Supervisor authority. It discovers the current instance through
the shared state-directory resolver, authenticates on the server, rejects
non-loopback endpoints and redirects, checks instance identity, and projects
only the four service IDs, existing lifecycle states, management flags and the
oldest actual probe timestamp. No token, URL, process detail, upstream error or
private configuration reaches the browser. Responses are not cached, failed
refreshes clear displayed observations, and non-GET methods return 405.

The existing Product Local intelligence section displays these observations even
when Runtime is unavailable. It labels PostgreSQL as TCP reachability only;
Mem0 remains the authority for pgvector readiness. It distinguishes external
prerequisite restoration from restarting YUVI after prerequisites recover.
The existing CRUD field is now also rendered alongside search and inference.
The bridge is enabled only by the daily-launcher environment, with no new port,
control action, dependency manager or lifecycle implementation.

No duplicate code removal was necessary. The only reuse change is sharing the
Supervisor state-directory resolver with the Vite server through a workspace dev
dependency. Existing daily units already supply the enable flag; no reinstall is
needed, but the WebUI process must load the updated Vite configuration.

## Validation

- `pnpm check`, `pnpm test`, `pnpm smoke`: passed.
- Focused WebUI tests: eight passed, including outage projection, external vs
  managed labels, degraded Mem0, read-only enforcement, token/error filtering,
  endpoint validation, and preserving actual observation time.
- Memory package: 310 passed, 18 opt-in cases skipped locally. Focused Core
  retrieval/Memory integration/persistence/architecture: 49 passed.
- Supervisor package: 196 passed, four opt-in cases skipped locally.
- Python Mem0 health/idempotency/history/API unit tests: 13 passed, one opt-in
  case skipped. No real STT suite or destructive service acceptance was repeated.
- An isolated WebUI on port 5174 read the existing live Supervisor: PostgreSQL
  healthy/external, Ollama healthy/external, Mem0 degraded/managed, Runtime
  healthy/managed. POST returned 405. No daily service or external prerequisite
  was stopped or restarted for this smoke. The test WebUI was stopped afterward.
- Hosted exact-head Check and Linux Persistence workflows are the merge gates;
  the PR and merge record retain the final head, CI and review evidence.

## Rebaselined terminal scope

Campaign C requires this small diagnostic follow-up, not another infrastructure
campaign. Durable Memory and lifecycle acceptance are inherited from #270, and
the Runtime-independent diagnostic gap is closed by this follow-up.

An external database or Ollama installation may still require restoration after
reboot. YUVI reports that prerequisite; it does not own its recovery. TCP success
alone does not prove database authentication or pgvector readiness. The daily
launcher remains a Linux checkout launcher, not general desktop packaging.
Physical microphone experience, remote-provider availability, TTS selection,
Vision, Companion expansion, resource tuning and Memory compression remain
outside this closure. Open PR #163 is compression work, not a Campaign C blocker;
#166, #223 and #146 are likewise outside scope. No Campaign D work begins here.
