# Phase 6 — Cognition Core and Capability Semantics

> **Status: PLANNED / NOT IMPLEMENTED**

## 1. Purpose

Integrate a replaceable strong Cognition Core for serious reasoning/work and a
dynamic MCP-based capability layer without teaching the Character Model
specific backends, providers, servers, or tool names.

## 2. Responsibility

The Cognition Core owns:

- complex reasoning, coding, research, and planning;
- repository/file analysis and high-reliability factual work;
- current-world verification when capabilities permit;
- complex social interpretation when the Character Model escalates;
- reasoning about whether and how external evidence/capabilities are needed;
- the semantic continuation disposition `CONTINUE_REASONING`,
  `REQUEST_CAPABILITY`, or `COMPLETE` within Runtime-enforced bounds;
- producing backend output for the phase-6 cognition boundary to normalize.

The phase-6 cognition boundary/adapter is the sole producer of normalized
Cognition Results under the phase-2 semantic meanings. It adapts
backend-specific output before the result reaches the Character Harness. The
Harness validates, budgets, includes, and consumes that result without a second
normalization step.

The MCP capability layer owns dynamic capability discovery/description and one
protocol-specific admitted invocation at a time. Runtime owns admission,
execution authority, maximum capability rounds, maximum elapsed time,
cancellation, effect/admission limits, duplicate/repeated-request guards where
applicable, non-progress termination, provider/tool lifecycle, effect tracking,
and event publication. Cognition proposes continuation; Runtime contains it;
MCP owns neither continuation nor loop control. The Character Harness mediates
semantic requests/results without executing them.

The Cognition Core is conceptually a strong 70B-class work/reasoning backend,
but its concrete model and provider remain replaceable.

## 3. Inputs

- an escalated problem statement and authorized context;
- relevant evidence from P8, Memory, temporal, Continuity, and perception;
- dynamic semantic capability descriptions;
- results/evidence from Runtime-admitted capability invocations;
- Runtime-enforced round/time/effect budgets, cancellation, privacy, and policy
  constraints;
- provider-neutral model options appropriate to the selected backend.

The Cognition Core does not need Yuvi's full private context when a narrower
task projection is sufficient.

## 4. Outputs

- semantic `CONTINUE_REASONING`, `REQUEST_CAPABILITY`, or `COMPLETE` proposals;
- a normalized Cognition Result produced solely at the phase-6 cognition
  boundary;
- safe status, answer, key facts, evidence, uncertainty, and caveats meanings;
- cancellation/failure/partial outcomes without fabricated completeness;
- diagnostics that identify capability/provider class safely without exposing
  secrets or raw hidden reasoning.

Exact wire fields remain open. Raw backend output, chain-of-thought, provider
DTOs, and concrete MCP traces do not become the Character result seam.

## 5. Authority boundaries

| Candidate owner          | Boundary audit                                                                                                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime                  | Owns capability admission/execution, provider calls, hard round/time/effect containment, repeated-request/non-progress termination, concurrency, cancellation, durability, and events; it does not choose semantic continuation. |
| Memory                   | Supplies and later records evidence; it neither plans capabilities nor treats a cognition answer as verified truth without provenance.                                                                                           |
| P8                       | Supplies identity/relationship context and may consume verified interpretation; it does not become a work/reasoning backend.                                                                                                     |
| Continuity               | Supplies unresolved work and consumes outcomes; it does not select or invoke tools.                                                                                                                                              |
| Character Model          | Emits only coarse `NEED_COGNITION` and expresses normalized results; direct Character-to-capability execution is reserved/non-executable in the initial architecture.                                                            |
| **Cognition Core**       | Owns serious reasoning plus semantic `CONTINUE_REASONING`, `REQUEST_CAPABILITY`, or `COMPLETE`; its boundary is the sole normalized-result producer.                                                                             |
| Character Harness        | Constructs/transports semantic requests and validates/consumes normalized results; it does not normalize, reason, execute, invoke MCP, or control the loop.                                                                      |
| **MCP capability layer** | Owns dynamic descriptions and one protocol invocation at a time because servers/tools change independently; it owns neither continuation nor hard containment.                                                                   |
| Presentation             | May show progress/results or execute admitted embodied output; it cannot select evidence or capabilities.                                                                                                                        |

Serious reasoning belongs in Cognition Core rather than Character because the
character-specific model should stay small, social, and replaceable. Concrete
capability binding belongs outside both models because environment inventory is
dynamic.

## 6. Hard invariants

- Cognition backend identity is replaceable and absent from Character identity.
- The Character Model does not need to know which model implements Cognition
  Core.
- Current provider/model names are configuration, not trained character facts.
- Concrete MCP server/tool names are dynamic and not encoded in weights.
- Capability descriptions are truthful, bounded, and current to the execution
  environment.
- The Character Model emits `NEED_COGNITION`; only Cognition may emit
  `REQUEST_CAPABILITY` in the initial architecture.
- Direct Character-to-MCP/capability execution is reserved and non-executable.
- Runtime admits every capability effect and retains cancellation/lifecycle and
  hard loop-containment authority.
- Initial phase-6 implementation permits at most one capability round.
- Multi-round Cognition/capability loops remain deferred until an explicit
  bounded-loop contract exists. If admitted later, Cognition proposes
  continuation, Runtime enforces hard budgets/fails closed, and MCP performs one
  admitted call at a time. No unbounded self-driven capability loop is allowed.
- Capability success produces evidence/results, not automatic Memory or P8
  truth.
- The phase-6 cognition boundary is the sole normalization producer before
  Character consumption; Harness and Runtime do not reinterpret the result.
- Raw chain-of-thought is neither required nor exposed.
- Uncertainty, partial results, cancellation, and failure remain distinct.
- No tool/function calling is claimed as current until a later implementation
  explicitly adds and validates it.

## 7. Explicit non-goals

- Selecting or training the final Character or Cognition model.
- Hard-coding DeepSeek, a specific 70B model, provider names, MCP servers, or
  tool names into identity or weights.
- Giving the Character Model direct tool planning/execution.
- Giving MCP servers Runtime admission authority.
- Building a generic `ToolOrchestrator`, agent graph, or autonomous loop.
- A multi-round cognition/capability loop in the initial implementation.
- Persisting raw cognition traces or treating model answers as Memory evidence
  without an admitted source path.

## 8. Dependencies

- Phase 2 Character/Cognition split and normalized result meanings.
- Phase 5 Harness mediation and supervision.
- Current Runtime/provider cancellation, error, fallback, and effect-state
  semantics.
- A chosen MCP integration approach that preserves Runtime admission.

Embodied environment actions are phase 7. Post-training must treat all
capability inventory as environment-bound.

## 9. Relationship to existing implementation

**CURRENT:** Providers expose separate Chat and Reasoning capabilities behind a
registry. `ReasoningOutput.answer` is the authoritative normalized result and
raw provider reasoning is discarded. Tool/function calling is explicitly
unsupported; reserved `tool` roles and `tool_call` finish reasons are not an
implemented protocol. Provider names and chains are dynamic configuration.

**PLANNED:** Cognition Core becomes a replaceable high-capability backend whose
phase-6 boundary solely produces the richer normalized semantic result. MCP is
the preferred external capability protocol. Runtime gains only the smallest
proven admission/execution and hard-containment seam; the initial path permits
one capability round maximum. No current provider contract or P6 behavior is
retroactively described as MCP or tool-capable.

## 10. Likely staged implementation shape

1. Integrate one replaceable Cognition backend whose phase-6 adapter solely
   produces the normalized result, without tools.
2. Define bounded semantic capability descriptions independent of tool names.
3. Add one read-only, low-risk MCP capability behind Runtime admission.
4. Return capability evidence to Cognition and complete one tool-assisted
   reasoning path with one capability round maximum.
5. Add effect-state/cancellation/failure tests before any mutating capability.
6. Expand capabilities one proven semantic need at a time.

Do not generalize from one MCP server into a framework or multi-round loop
before a separate explicit bounded-loop contract is admitted. Cognition may
propose continuation, but Runtime remains the sole hard-containment authority
and MCP performs only one admitted invocation at a time.

## 11. Acceptance concept

The phase is acceptable when the same escalated task can run against two
Cognition backend adapters with an equivalent normalized result; changing MCP
server/tool names requires no Character weight or identity change; every
capability invocation is Runtime-admitted, cancellable, and initially limited
to one round; Runtime terminates budget excess or non-progress; evidence and
uncertainty survive sole-boundary normalization; and Character expression
contains no raw backend/tool formatting.

## 12. Risks

- Recreating Runtime orchestration inside the Harness or an MCP adapter.
- Allowing Cognition or MCP to convert semantic continuation into unbounded
  self-execution.
- Allowing the Character Model to become a tool router through overly concrete
  capability prompts.
- Treating a cognition answer or tool result as verified truth without source
  status.
- Leaking raw reasoning, filesystem paths, secrets, or tool payloads through
  the Character ABI.
- Retrying mutating capabilities after an ambiguous effect.
- Coupling normalized results too tightly to the first backend.
- Expanding capability surface faster than admission/evaluation coverage.

## 13. Open questions

- What minimum normalized result meanings support research, coding, planning,
  and social interpretation without becoming a universal schema?
- How are capability descriptions generated and kept current safely?
- Which MCP operations are read-only, mutating, reversible, or ambiguous?
- What capability evidence may enter Memory, and through which explicit policy?
- How does Runtime expose progress without leaking raw reasoning?
- When should Cognition ask a clarifying question instead of requesting a
  capability?
- What evidence would justify a future multi-round bounded-loop contract beyond
  the initial one-round maximum?
- Which backend bakeoff criteria measure real cognition quality independently
  from character style?

## 14. Handoff boundary to the next phase

Phase 6 hands phase 7 semantic behavior/capability requests, admitted Runtime
effects, and normalized outcomes. Phase 7 may render speech, gaze, expression,
pose/motion, and environment-facing actions causally. It must not infer agency
from random animation, bypass Runtime admission, or move capability planning
or hard loop containment into Presentation. The Harness remains request-only,
Cognition remains semantic continuation authority, Runtime remains execution
and hard-containment authority, and MCP remains a one-admitted-invocation
adapter.
