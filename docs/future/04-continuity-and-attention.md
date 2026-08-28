# Phase 4 — Continuity and Attention

> **Status: PLANNED / NOT IMPLEMENTED**

## 1. Purpose

Represent what remains unfinished or relevant across interaction gaps so Yuvi
can resume naturally, preserve commitments and expectations, notice unresolved
uncertainty, and also remain silent when nothing meaningful is open.

Continuity is not durable factual Memory and is not Persona. It is the bounded
state of “what still matters now?”

## 2. Responsibility

Continuity owns:

- open conversational or task threads;
- explicit commitments and expected follow-ups;
- expectations created by prior interaction;
- unresolved questions and uncertainty;
- recent interaction residue that remains relevant after the immediate turn;
- attention anchors and reasons a situation may deserve reconsideration;
- closure, supersession, expiry, and decay of those items using the temporal
  substrate.

Continuity proposes relevance. For reactive conversation, the Character Model
decides whether it deserves a response. While current P6 remains active, its
`ProactiveDecisionProvider` remains the sole `NO_OP | REQUEST_TEXT` authority;
Continuity and Character context must not become a second proactive-text gate.
Runtime decides whether any resulting effect may execute.

## 3. Inputs

- bounded recent conversation and current interaction outcome;
- relevant Memory evidence after Memory-owned scope/status/time-validity
  filtering, retrieval eligibility, and ranking, with provenance/status intact;
- P8 identity and relationship context;
- temporal context, elapsed gaps, temporal distance, and horizons;
- explicit commitments, questions, corrections, cancellations, and closure
  signals;
- Runtime outcome events, including whether work completed, failed, was
  cancelled, or never started.

Assistant prose alone does not prove a commitment. A proposed commitment needs
an explicit semantic basis and outcome evidence.

## 4. Outputs

- bounded open-thread projection;
- commitment/expectation state with provenance and current status;
- unresolved uncertainty projection;
- recent-residue summary;
- attention anchors with specific reasons, recency, and expiry/decay state;
- closure or supersession outcomes suitable for Runtime persistence;
- compact Continuity/attention sections for the Character ABI.

Outputs are context candidates, not commands to speak, call a tool, or animate.

## 5. Authority boundaries

| Candidate owner      | Boundary audit                                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime              | Persists Continuity artifacts and records outcomes, but execution state alone cannot decide semantic closure or ongoing conversational relevance.                                         |
| Memory               | Owns evidence records, record lifecycle, retrieval eligibility/filtering/ranking, and supplies prior-event evidence; it does not decide whether an item remains open or attention-worthy. |
| P8                   | Supplies stable identity/relationship interpretation; it must not absorb transient open threads or recent residue.                                                                        |
| **Continuity**       | Owns unfinished relevance, commitments, expectations, uncertainty, residue, and attention anchors because these persist across gaps without becoming facts or identity.                   |
| Character Model      | Decides reactive response disposition and may choose reactive silence; current proactive-text `NO_OP \| REQUEST_TEXT` remains solely P6-owned until atomic migration.                     |
| Cognition Core       | May resolve a difficult thread or uncertainty; it does not decide which conversational residue persists by default.                                                                       |
| Character Harness    | Assembles the projection and interprets decisions; it cannot create, close, or persist Continuity on its own.                                                                             |
| MCP capability layer | May help satisfy an open thread; tool completion is evidence sent back through Runtime, not Continuity authority.                                                                         |
| Presentation         | Renders attention or silence; gaze/animation cannot create an attention anchor.                                                                                                           |

Continuity belongs here because it is a semantic bridge across time: more
stateful than raw recent context, less durable/factual than Memory, and less
stable than P8.

## 6. Hard invariants

- Continuity is not long-term factual Memory and is stored separately in
  meaning even if Runtime reuses persistence infrastructure.
- Continuity is not Persona or relationship authority.
- Every open item has a specific basis and can become closed, superseded,
  expired, decayed, or unknown.
- Assistant-only prose cannot silently create a user commitment.
- Failure, cancellation, ambiguity, and completion remain distinct.
- Attention anchors are reasons for consideration, not permission to act.
- The Character Model may choose silence even when an anchor exists.
- No anchor or Character judgment may become an additional current proactive
  text gate or bypass consent, sole P6 arbitration, Runtime admission, or user
  priority.
- Bounded horizons prevent indefinite resurfacing.
- Unavailable Memory is not interpreted as absence or closure.

## 7. Explicit non-goals

- A task manager, calendar, or generic workflow graph.
- Durable storage of every conversation fragment.
- Persona drift, relationship scoring, or mood state.
- Direct capability execution, tool selection, or proactive scheduling.
- A replacement for Direct Context or Memory retrieval.
- An autonomous inner monologue or simulated activity between interactions.

## 8. Dependencies

- Phase 1 P8 supplies stable identity/relationship context.
- Phase 2 supplies ABI slots and Character attention/termination semantics.
- Phase 3 supplies elapsed, temporal-distance, derived-decay, and horizon
  calculations; Continuity owns state transitions for its own items.
- Runtime outcome/event truth and current P6 behavior remain authoritative.

The Harness and broader agency phases consume Continuity later; this phase does
not require them to define the state semantics.

## 9. Relationship to existing implementation

**CURRENT:** Direct Context stores bounded recent same-session conversation and
can restore it from conversation persistence. It is explicitly not long-term
Memory. P6 considers recent context and speaks only for a specific meaningfully
open conversational reason; `NO_OP` is preferred when the thread is closed,
generic, guessed, or uncertain. Browser eligibility has bounded idle/cooldown
rules and one attempt per idle episode.

**PLANNED:** Continuity turns open-thread, commitment, expectation, uncertainty,
and residue meanings into an explicit bounded semantic projection across gaps.
It preserves P6 as the current proven text-only execution subset rather than
replacing P6 with a new initiative loop.

## 10. Likely staged implementation shape

1. Define the smallest open-thread/closure semantics and provenance rules.
2. Add explicit commitment, expectation, and unresolved-uncertainty meanings
   only where evidence requires them.
3. Apply non-mutating Temporal derivations and Continuity-owned
   expiry/closure/decay transitions with bounded horizons.
4. Project attention anchors without adding execution.
5. Validate reconstruction and closure across session gaps and Runtime restart.

Avoid a generic graph engine. A bounded collection plus narrow transition rules
is preferable until tests prove more structure is necessary.

## 11. Acceptance concept

The phase is acceptable when a genuinely unfinished thread can survive an
interaction gap and later close deterministically; completed or expired items
do not repeatedly resurface; user corrections/cancellations take priority;
ambiguous outcomes remain unresolved rather than falsely complete; and an
attention anchor never produces an effect without the applicable sole semantic
decision authority and Runtime admission. While current P6 remains active, that
proactive-text decision authority is P6 rather than an additional Character
gate.

## 12. Risks

- Duplicating Memory under a new name.
- Treating assistant suggestions as commitments.
- Keeping open threads forever and creating nagging behavior.
- Closing ambiguous work because a provider returned text.
- Letting Continuity become a proactive scheduler or task planner.
- Overfitting attention to current P6 UI timing constants.
- Conflating recent conversation availability with meaningful continuity.

## 13. Open questions

- What is the minimum semantic identity for an open thread across restarts?
- Which commitments require explicit user confirmation?
- How are shared, user, and Yuvi commitments distinguished?
- Which closure signals are safe to infer, and which must be explicit?
- How much recent residue should survive a long gap?
- What user-facing controls should expose, dismiss, or correct Continuity?
- How should competing anchors be ranked without making Continuity the
  attention decision-maker?

## 14. Handoff boundary to the next phase

Phase 4 hands phase 5 bounded, provenance-aware Continuity and attention-anchor
projections. The Harness may assemble these into Character context and process
the Character Model's reactive response/silence decision. It may not use that
decision as a second current proactive-text gate, or own, persist, silently
mutate, or independently schedule Continuity items.
