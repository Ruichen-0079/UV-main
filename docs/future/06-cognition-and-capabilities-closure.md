# Phase 6 — Cognition and Capabilities Closure Checkpoint

> **Closure baseline:** `28ef8cf38f104926e61809178ac8ec62138382a1`
>
> **Date:** 2026-08-31
>
> **Classification:** initial one-capability-round semantic/runtime slice closed; concrete Character adapter and broader capability expansion intentionally deferred.

This checkpoint records the repository-authoritative Phase 6 stopping boundary after the bounded read-text Cognition path was closed. Source, tests, and hosted CI at the closure baseline are authoritative. The older Phase 6 roadmap remains design context and must not be read as current implementation status where it conflicts with this checkpoint or current source.

## Closed implementation scope

The initial Phase 6 architecture is implemented through a provider-neutral normalized Cognition Result and one Runtime-admitted read-only capability round maximum:

- The Character Harness 5G `NEED_COGNITION` request crosses into a strict provider-neutral Cognition task rather than a provider or tool DTO.
- Core exposes a narrow Runtime-owned one-shot Cognition executor. The semantic boundary owns input projection/result normalization; Runtime/Core retains provider selection, cancellation, and one-call execution authority.
- The phase-6 Cognition boundary is the sole normalized-result producer. Raw provider reasoning, provider names, model names, tool traces, and MCP payloads do not enter the stable Character-facing result.
- Capability descriptions use opaque semantic references and bounded descriptions. Concrete MCP server/tool/schema/argument details remain outside the Cognition and Character semantic contracts.
- Runtime 6J owns policy veto and the initial one-round capability budget. It receives no capability ref, tool name, schema, argument, provider metadata, or effect taxonomy.
- Server 6K/6L bind the static allowlist to current MCP discovery. Current discovery may remove unavailable capabilities but cannot promote discovered-only tools or replace the server-owned semantic description.
- The first concrete capability is dedicated read-only `read_text_file`. Cognition request text cannot choose the filesystem path; only the Runtime-authorized concrete path is passed to MCP.
- One admitted invocation is executed at most once. There is no retry, generic tool executor, agent graph, or autonomous capability loop.
- Tool-level success/error/unavailability is projected through the provider/MCP-neutral 6N/6O observation seam. Capability success remains evidence, not automatic Memory or P8 truth.
- Post-capability reasoning accepts the original normalized task plus the normalized observation, performs exactly one assisted ReasoningProvider pass, and closes through the existing Character Harness 5H request/result correlation seam.
- The current capability-aware initial path exposes only the current allowlisted inventory, accepts only `COMPLETE` or one inventory-bound `REQUEST_CAPABILITY`, and rejects invented refs or unsupported continuation wire.
- The closed read-text round-trip is `initial current-inventory Cognition -> COMPLETE -> 5H` or `REQUEST_CAPABILITY -> one Runtime-admitted read -> normalized observation -> one assisted Cognition completion -> 5H`.
- The integrated read-text round-trip accepts only a read-text-only executable registry, snapshots caller-owned task/admission/path/signal values before asynchronous discovery, and stops at 5H. It neither mutates a round counter nor opens a second capability opportunity.
- Existing 5I -> 5K -> 5L post-cognition Character re-entry remains available as a pure semantic continuation from a completed 5H round-trip to a provider-neutral `CHARACTER_GENERATION` request.

## Authority preserved

The implementation deliberately does not create a second Runtime or transfer authority across semantic boundaries:

- **Runtime/Core** owns provider execution, cancellation, capability admission, and the hard one-round containment fact.
- **Cognition** owns serious reasoning and the semantic choice between completion and one capability request on the initial bounded path.
- **The phase-6 boundary** alone normalizes Cognition backend output.
- **MCP** discovers/describes protocol availability and performs one already-admitted invocation; it owns no continuation or admission policy.
- **Character Harness** validates, assembles, correlates, budgets, and transports semantic requests/results; it owns no provider execution, retry/fallback execution, capability admission, or MCP lifecycle.
- **Memory/P8** remain evidence/truth authorities for their own domains. Neither a Cognition answer nor a capability result is persisted or promoted to truth by Phase 6.

## Verified containment and failure behavior

Repository tests and exact-head hosted CI cover the bounded path rather than only the happy case:

- invalid semantic tasks/requests fail before provider or MCP I/O;
- pre-aborted work is cancelled without provider/capability execution where the owning seam defines that behavior;
- Runtime policy or exhausted-round rejection performs zero capability MCP I/O;
- semantic request text cannot override the Runtime-authorized concrete path;
- current discovery disappearance becomes bounded unavailability rather than an invented capability;
- MCP transport/cancellation failures propagate without retry or fabricated evidence;
- tool-level errors do not leak raw MCP error payloads into assisted Cognition;
- provider-facing post-capability input contains generic observation evidence, not capability refs, tool names, paths, or MCP wire details;
- caller mutation across asynchronous discovery/execution is fenced by canonicalization/snapshotting at the relevant composition boundary;
- the completed path stops at Character Harness 5H without Memory/P8 writes, Character invocation, or a second capability protocol opportunity.

## Intentionally deferred work

The following are not implementation gaps to fill speculatively after this checkpoint:

- multi-round `CONTINUE_REASONING` / capability loops;
- generic capability orchestration, `ToolOrchestrator`, agent graphs, or a second Runtime;
- mutating, reversible, ambiguous, or environment-facing capabilities;
- automatic persistence of capability evidence or Cognition output into Memory/P8;
- concrete Character prompt/control-token serialization;
- concrete Character provider/model binding and model-specific output decoding;
- wiring the current `/message` or streaming user-message product path through the Character semantic pipeline before a real Character adapter exists;
- Character-generation retry/fallback execution or intelligent recovery provider binding;
- Phase 7 embodied/environment effects.

Phase 5 already records the concrete Character adapter/model binding as intentionally deferred until behavior of the actual post-trained Character checkpoint is available. The current production message path therefore remains the existing Runtime `ChatProvider` path; Phase 6 does not silently replace it with a temporary model or make the Harness a provider executor.

## Closure rationale

The staged initial Phase 6 target is now represented by repository-authoritative contracts and compositions:

1. replaceable ReasoningProvider-backed Cognition with sole-boundary normalization;
2. bounded provider-neutral semantic capability descriptions;
3. one low-risk read-only MCP capability behind Runtime admission;
4. one tool-assisted reasoning path with one capability round maximum;
5. cancellation, failure, authority, metadata-separation, and no-retry containment tests before any mutating capability.

Expanding the surface now would require a new proven semantic need or a separately admitted bounded-loop/effect contract. Connecting Character generation to production also requires the intentionally deferred concrete Character adapter. Neither should be guessed merely to keep Phase 6 growing.

## Handoff

The Phase 6 semantic/runtime slice hands later work:

- a stable normalized Cognition Result consumable through 5H/5I/5K;
- a provider/model-neutral `CHARACTER_GENERATION` semantic request at 5L when a caller supplies an authorized Character ABI context and budget;
- a proven one-round read-only capability pattern whose authority remains split between Runtime admission, Cognition semantic need, and MCP one-call execution.

Any next phase must preserve the current production Runtime lifecycle and P6 proactive guarantees. A future Character production migration must be explicit and atomic once a real Character adapter exists; it must not create a parallel user-visible decision/execution path or move Runtime authority into Harness, Cognition, or MCP.
