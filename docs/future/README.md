# Post-Structural Companion Roadmap

> **Status: PLANNED / NOT IMPLEMENTED**
>
> **Current-state baseline inspected:** `origin/main` at
> `bd256047ee4eab92a8c7fae9f8ae3037285f95a2` (2026-08-28)
>
> **Scope:** long-term semantic architecture only; this directory is not
> current product behavior or an implementation specification.

Current source, tests, and current-state documentation remain authoritative for
implemented behavior. In particular, [P4 Linux-first](../p4-linux-first.md),
[Memory](../memory.md), [Mem0 Memory Foundation](../mem0-memory-foundation.md),
[Providers](../providers.md), [Prompt Pipeline](../prompt-pipeline.md), and the
current Runtime contracts take precedence over this roadmap wherever a future
proposal could otherwise be read as present fact.

Two current-state rebaseline PRs were open when this roadmap was prepared. They
correctly label P8 as not implemented, Memory as evidence rather than Persona
authority, and P6 as frozen current behavior. This additive roadmap does not
replace those pending current-state documents.

## Product north star

Yuvi is intended to become a persistent local AI companion, not an ordinary
agent framework or only a capable work assistant. The target combines stable
identity, an evidence-grounded relationship and persona, temporal awareness,
continuity across gaps, unresolved conversational attention, selective
initiative and meaningful silence, replaceable capabilities, embodied
voice/visual behavior, a character-specific language model, and a separate
strong cognition core for reliable work. Yuvi should have independent access
to admitted capabilities without making today's tool inventory part of her
identity.

The character surface should do less rational work than a general assistant.
It should primarily express Yuvi's character, decide what deserves attention,
know when to stop or remain silent, and make a coarse decision to request
stronger cognition. Complex reasoning, coding, research, verification,
multi-step planning, repository analysis, complex tool selection, and
high-reliability factual work belong to the Cognition Core.

## Current and planned boundary

**CURRENT:** Runtime lifecycle, event publication, provider abstraction,
conversation persistence, evidence-oriented Memory, prompt sections, P5
Live2D presentation, and the bounded P6 assistant-initiated text path are
implemented. Current `RelationshipContext`, `CurrentAffect`, persona IDs,
relationship memory categories, and Direct Context are useful foundations;
none is an authoritative P8, temporal, or Continuity implementation.

**PLANNED:** the documents in this directory define semantic owners and narrow
seams for post-Structural work. They do not define detailed TypeScript types,
class hierarchies, storage tables, concrete MCP servers, or source-file changes.

**CURRENT / IN PROGRESS:** Structural R closeout is phase 0. R3B production
Runtime extraction is complete and GitHub PR #81
(`refactor(core): extract runtime orchestrator`) is merged. Structural R as a
whole is not complete: R5 Core test decomposition and final structural closeout
remain. No P8 implementation should begin until those remaining Structural
units are explicitly accepted.

## Expected sequence

0. Finish Structural R closeout without semantic redesign.
1. Implement P8 identity, persona, and relationship interpretation.
2. Establish the Character ABI and Character/Cognition responsibility split.
3. Add the temporal substrate.
4. Add Continuity and attention projections.
5. Add the thin Character Harness and generation supervision.
6. Integrate a replaceable Cognition Core and MCP capability semantics.
7. Add embodied agency and causally grounded UI/Live2D behavior.
8. Build the behavior specification, evaluation, and data pipeline.
9. Run a base-model bakeoff.
10. Run QLoRA SFT.
11. Run DPO.
12. Run shadow and A/B evaluation.
13. Operate an iterative preference-data flywheel.

Data collection may begin earlier when provenance and labeling are sound.
Post-training must not compensate for missing Runtime architecture, unclear
authority, or an unstable model boundary.

## Frozen responsibility map

| Layer                | Semantic responsibility                                                                                                                                            | Must not absorb                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Runtime              | Execution authority, lifecycle, concurrency, durability, persistence, provider/cognition execution, capability admission, hard loop containment, event publication | Persona interpretation, attention judgment, cognition semantics, presentation meaning                         |
| Memory               | Durable, provenance-preserving evidence plus record retrieval/ranking, validity, status, retention, and expiry                                                     | Relationship truth, Continuity state, consumer-specific relevance                                             |
| P8                   | Stable identity plus evidence-grounded persona and relationship interpretation                                                                                     | Transient attention, generic mood, execution authority                                                        |
| Temporal substrate   | Non-mutating time position, elapsed time, age, temporal distance, consumer horizons, and derived relevance/attention decay                                         | Memory record expiry/status, fake off-screen life, relationship interpretation, scheduling authority          |
| Continuity           | What remains unfinished or relevant: open threads, commitments, expectations, uncertainty, residue, and attention anchors                                          | Durable factual Memory, Persona authority, execution                                                          |
| Character Model      | Character expression, reactive attention and termination/silence, coarse `NEED_COGNITION`, result expression                                                       | Current P6 proactive admission, capability selection, reliable complex reasoning, backend/model identity      |
| Cognition Core       | Complex reasoning, coding, research, planning, complex social interpretation, verification, and tool-assisted reasoning                                            | Yuvi's identity, final character voice, direct effect authority                                               |
| Character Harness    | Character ABI inclusion/assembly, output interpretation, cognition-escalation requests, generation supervision, semantic recovery disposition                      | Durable state, cognition-result normalization, execution/retry, independent orchestration, provider lifecycle |
| MCP capability layer | Dynamic external capability discovery/description and one admitted protocol invocation at a time                                                                   | Continuation/loop control, character identity, hard-coded weighted tool names, admission authority            |
| Presentation         | Speech, silence rendering, gaze, expression, pose, motion, and visible environment-facing effects                                                                  | Attention/relationship truth, capability admission, random motion presented as agency                         |

## Cross-boundary responsibility audit

Each row answers why the responsibility belongs to its owner instead of every
other candidate layer. A future implementation may cross process or package
boundaries, but it must preserve these semantic owners.

| Responsibility                                                                 | Owner and reason                                                                                                                           | Why not Runtime / Memory / P8 / Continuity                                                                                                         | Why not Character Model / Cognition Core / Harness / MCP / Presentation                                                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execute, cancel, serialize, persist, admit, contain, and publish effects       | **Runtime**, because one effect authority is required for lifecycle, loop containment, and durability correctness                          | Memory records evidence; P8 interprets identity; Continuity tracks relevance. None may execute effects                                             | Models propose; Harness requests; MCP performs one admitted invocation; Presentation renders/reports. None may become a second Runtime             |
| Preserve, retrieve, filter, rank, and lifecycle durable evidence               | **Memory**, because evidence fidelity and record eligibility must survive model replacement                                                | Runtime supplies persistence mechanics but not evidence meaning; P8 interprets already-authorized evidence; Continuity derives relevance           | Models and Harness consume authorized projections; MCP may produce evidence; Presentation may report observations. None is the evidence authority  |
| Define who Yuvi is and interpret the relationship from evidence                | **P8**, because identity stability and relationship meaning require one evidence-grounded semantic authority                               | Runtime stores/executes; Memory supplies evidence; Continuity owns transient unresolved state                                                      | Character expresses the projection; Cognition may assist hard interpretation; Harness assembles it; MCP and Presentation cannot define identity    |
| Derive time position, elapsed gaps, age, distance, and consumer horizons       | **Temporal substrate**, because the same non-mutating calculations must serve P8, Continuity, and attention                                | Runtime supplies clock observations; Memory owns record validity/status/expiry and supplies timestamps; P8 and Continuity consume temporal meaning | Models interpret the projection; Harness passes it; MCP and Presentation do not define elapsed reality                                             |
| Track unfinished relevance across interaction gaps                             | **Continuity**, because open threads and commitments are neither facts alone nor stable identity                                           | Runtime persists the projection; Memory is evidence; P8 may influence interpretation but does not own transient conversational residue             | Character judges response-worthiness; Cognition resolves hard work; Harness mediates; MCP/Presentation cannot decide what remains open             |
| Decide reactive character response, silence/termination, and coarse escalation | **Character Model**, because these are learned social judgments at Yuvi's surface; current proactive text remains P6-owned until migration | Runtime enforces effects; Memory/P8/Continuity provide grounded context rather than generate behavior                                              | Cognition performs hard reasoning; Harness supervises/interprets; MCP supplies capabilities to Cognition; Presentation renders the admitted choice |
| Perform serious reasoning and propose semantic continuation/capability need    | **Cognition Core**, because reasoning can be replaced independently of character identity                                                  | Runtime contains and executes the bounded cognition/capability session; Memory/P8/Continuity provide evidence and context                          | Character only emits `NEED_COGNITION` and expresses results; Harness mediates requests; MCP cannot decide continuation                             |
| Assemble the model projection, validate crossings, and supervise generation    | **Character Harness**, because adaptation and safety need a thin replaceable seam around the local model                                   | Runtime remains lifecycle/effect/retry authority; Memory/P8/Continuity remain state authorities                                                    | Phase-6 cognition boundary normalizes results; Character/Cognition remain models; MCP remains capability protocol; Presentation remains rendering  |
| Describe and perform one admitted invocation of dynamic capabilities           | **MCP capability layer**, because tool/server identities and protocol mechanics change independently from models                           | Runtime admits and contains execution; Memory records resulting evidence; P8/Continuity do not route tools                                         | Cognition proposes `REQUEST_CAPABILITY`; Character emits only `NEED_COGNITION`; Harness requests; Presentation cannot be the capability registry   |
| Render embodied behavior                                                       | **Presentation**, because device/UI-specific execution should consume semantic intent                                                      | Runtime admits/publishes; Memory/P8/Continuity do not animate                                                                                      | Character proposes expression; Cognition does not animate; Harness mediates; MCP may provide an environment action but does not render embodiment  |

## Authoritative decision ownership

Each concern below has one authority. Other layers may propose, consume,
project, validate, or transport, but those verbs do not transfer authority.

| Concern                                            | Sole authority                                                                                                       | May propose or consume                                                                                  | Explicitly not authority                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Memory record retrieval/ranking                    | Memory                                                                                                               | Runtime requests; P8/Continuity consume authorized evidence                                             | P8, Harness, Character Model                                     |
| Memory record expiry/status                        | Memory                                                                                                               | Temporal supplies non-mutating calculations; Runtime persists a Memory-owned admitted mutation          | Temporal, P8, Continuity, Harness                                |
| P8 evidence interpretation                         | P8                                                                                                                   | Memory supplies evidence; Cognition may return bounded analysis; Harness projects                       | Memory, Cognition, Harness                                       |
| Temporal elapsed/horizon calculation               | Temporal substrate                                                                                                   | Runtime supplies clocks; Memory supplies timestamps; P8/Continuity consume                              | Memory record lifecycle, Character narration                     |
| Continuity unresolved relevance                    | Continuity                                                                                                           | Memory/events/time supply evidence; Character consumes anchors                                          | Memory, P8, Harness, Presentation                                |
| Current proactive text `NO_OP \| REQUEST_TEXT`     | Existing P6 `ProactiveDecisionProvider` until atomic migration                                                       | Continuity/attention/Character may supply context only through an explicitly admitted compatible change | Character Model as a second gate, Harness, Presentation          |
| Reactive character response disposition            | Character Model                                                                                                      | Harness validates; Runtime admits effects                                                               | Current P6 proactive decision, Harness, Presentation             |
| Future generalized proactive response disposition  | Sole replacement semantic authority designated by the explicit atomic P6 migration; none is active before the switch | Character/Continuity may supply context under the migrated contract; Runtime admits effects             | Old P6 producer after retirement, any parallel second gate       |
| Cognition escalation                               | Character Model emits `NEED_COGNITION`                                                                               | Harness validates/projects; Runtime executes the request                                                | Harness as reasoning policy, MCP                                 |
| Cognition semantic continuation                    | Cognition Core emits `CONTINUE_REASONING \| REQUEST_CAPABILITY \| COMPLETE`                                          | Runtime enforces bounds; Harness transports normalized outcomes                                         | Runtime as semantic reasoner, MCP adapter                        |
| Cognition-result normalization                     | Phase-6 cognition boundary/adapter                                                                                   | Phase 2 defines meanings; Harness validates/budgets/consumes; Runtime transports                        | Character Harness, Runtime, Character Model                      |
| Provider/cognition execution                       | Runtime through existing provider infrastructure                                                                     | Harness constructs requests; models propose                                                             | Harness, models, MCP server                                      |
| Capability selection by semantic need              | Cognition Core emits `REQUEST_CAPABILITY` after escalation                                                           | Runtime binds against current truthful descriptions                                                     | Character Model in the initial architecture, Harness, MCP server |
| Capability admission                               | Runtime                                                                                                              | Cognition proposes; Harness validates request form; MCP describes availability                          | Cognition, Harness, MCP adapter/server                           |
| MCP invocation                                     | MCP adapter/server performs one Runtime-admitted invocation                                                          | Runtime supplies lifecycle/cancellation; Cognition consumes evidence                                    | MCP continuation/loop control, Character Model                   |
| Capability-loop hard containment                   | Runtime                                                                                                              | Cognition proposes continuation; MCP reports one-call outcome                                           | Cognition, Harness, MCP adapter/server                           |
| Character generation retry disposition             | Character Harness                                                                                                    | Character adapter output and supervision signals are inputs; Runtime consumes disposition               | Harness execution, provider routing/fallback                     |
| Actual provider retry/fallback                     | Runtime/provider infrastructure                                                                                      | Harness may request `RETRY_CHARACTER_GENERATION`, `FALLBACK_TO_COGNITION`, or `FAIL_CHARACTER_OUTPUT`   | Character Harness, Character Model                               |
| Presentation device rendering                      | Presentation                                                                                                         | Character/Harness propose intent; Runtime supplies admitted envelope                                    | Presentation admission or semantic attention                     |
| Authoritative Runtime effect lifecycle/publication | Runtime                                                                                                              | Presentation reports device outcomes; MCP/provider adapters report call outcomes                        | Presentation, Harness, models, MCP server                        |

## Stable semantic seams

The roadmap depends on four narrow seams, not a generic agent graph:

1. **Evidence to interpretation:** Memory evidence enters P8 or Continuity with
   provenance, status, temporal uncertainty, and scope intact.
2. **Character ABI:** the Character Model receives a stable semantic projection,
   not Runtime internal objects or provider DTOs.
3. **Normalized Cognition Result:** the Character Model receives a stable
   result meaning, not one cognition backend's raw response format.
4. **Semantic capability request:** the Character Model initially emits only
   `NEED_COGNITION`; after escalation, Cognition may emit
   `REQUEST_CAPABILITY`. Runtime admission and dynamic capability binding remain
   outside model weights. Direct Character-to-capability execution is reserved
   and non-executable in the initial architecture.

Likely Character ABI sections are identity, relationship/persona evidence,
recent conversation, relevant Memory, temporal context, Continuity/open
threads, attention, current perception, and a normalized Cognition Result.
Dynamic capability descriptions belong to Cognition task context in the
initial architecture; any future Character-facing capability section is
reserved and absent until an explicit later contract admits it. These are
semantic sections, not frozen wire fields.

`MODEL ABI` and `INTERNAL RUNTIME IMPLEMENTATION SCHEMA` are different:

- the Model ABI is compact, versioned by meaning, provider-neutral, safe to
  expose to a replaceable model, and tolerant of missing/unknown information;
- the internal schema may contain lifecycle identities, repositories,
  diagnostics, provider metadata, locks, leases, and storage-specific fields;
- projection into the Model ABI is one-way and selective; internal fields do
  not become character semantics merely because they exist.

## Cognition result seam

Phase 2 owns the semantic meanings of the normalized Cognition Result. The
phase-6 cognition boundary/adapter is its sole producer: it adapts
backend-specific cognition output into the stable Character-facing result
before the result leaves that boundary. The Character Harness validates,
budgets, includes, and consumes the normalized result; it does not perform a
second normalization or reinterpret raw backend output. Runtime executes and
transports the cognition request/result under lifecycle authority without
defining or reinterpreting its semantics.

The directional seam is:

`Cognition backend → phase-6 cognition boundary → NORMALIZED_COGNITION_RESULT → Character Harness → Character Model`

Candidate meanings include status, answer, key facts, evidence, uncertainty,
and caveats. Exact names and wire format remain open. Raw chain-of-thought,
vendor-specific payloads, provider model names, tool traces, and one backend's
formatting are not part of the stable seam.

## P6 compatibility freeze

P6 is an implemented and tested subset of future agency. Later phases may
generalize agency beyond text, but must preserve the current path unless an
explicitly scoped replacement proves equivalent behavior:

- user work has priority over proactive work, including proactive preemption;
- the decision is exactly `NO_OP` or `REQUEST_TEXT`;
- `NO_OP` produces no assistant text or persistence;
- `REQUEST_TEXT` permits one bounded, validated assistant-only continuation;
- an admitted attempt is one-shot and stale callbacks are fenced to their
  originating effect;
- presentation candidate identity and fresh Runtime execution/idempotency
  identity remain separate;
- no synthetic user message is created;
- no uncontrolled proactive Memory write occurs;
- proactive execution has no TTS, voice, or tool authority unless a later
  phase adds a separately admitted contract.

Future initiative should consume Continuity, attention, and temporal context;
it must not casually rewrite the proven P6 mechanism or reinterpret random
idle animation as semantic agency.

### Atomic P6 authority migration

While current P6 is active, its `ProactiveDecisionProvider` is the sole
authority deciding whether a proactive text attempt becomes `NO_OP` or
`REQUEST_TEXT`. Future Continuity, attention, or Character judgments may supply
context or candidate semantic input only through an explicitly admitted
compatible change; they must not independently admit or reject the same
user-visible proactive text effect. Character-owned silence/termination before
that migration applies to reactive conversation, not to a second proactive
speak/no-speak gate.

A future generalized-agency migration must be explicit and atomic:

1. define the replacement semantic authority;
2. prove behavioral equivalence for every frozen P6 guarantee;
3. switch authority;
4. retire the old P6 decision producer.

At no point may both decision producers independently gate one proactive
effect. User priority, `NO_OP | REQUEST_TEXT` semantics until the switch,
one-shot execution, stale-callback fencing, fresh Runtime effect identity,
idempotency/claim behavior, no synthetic user message, no proactive Memory
write authority, and no implied proactive TTS/tool authority remain frozen.

## Implementation discipline

Future implementation agents must implement the smallest unit that realizes a
proven semantic requirement. Do not create `PersonaManager`,
`ContinuityEngine`, `AgencyManager`, `CharacterService`, `ToolOrchestrator`,
`RelationshipEngine`, or a generic agent graph merely to mirror this roadmap.
Introduce a named abstraction only when current evidence proves multiple
callers or invariants need that seam.

## Document map

1. [P8 Identity, Persona, and Relationship](01-p8-identity-persona-relationship.md)
2. [Character ABI and Cognition Boundary](02-character-abi-and-cognition-boundary.md)
3. [Temporal Substrate](03-temporal-substrate.md)
4. [Continuity and Attention](04-continuity-and-attention.md)
5. [Character Harness](05-character-harness.md)
6. [Cognition and Capabilities](06-cognition-and-capabilities.md)
7. [Embodied Agency](07-embodied-agency.md)
8. [Character Post-Training](08-character-post-training.md)

## Known current-document tension

Older current docs still describe Live2D and autonomous behavior as wholly
future work and list a future “emotion engine.” Current source/tests and the
pending current-state rebaseline show Live2D and bounded P6 behavior are
already implemented. This roadmap therefore treats those older phrases as
stale summaries, not as a mandate for a generic mood engine. No current
Runtime semantic contradiction was found.

The top-level README/Windows guidance and parts of `memory.md` also retain
Windows-first or packaged-private-PostgreSQL language that is narrower or older
than the explicit Linux-first P4 baseline. That documentation tension is being
handled by the separate current-state rebaseline work; it does not change this
roadmap's semantic ownership.
