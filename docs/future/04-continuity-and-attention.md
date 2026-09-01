# Phase 4 — Continuity and Attention

> **Status: OPERATIONALLY PARTIALLY COVERED BY L0/L1 MEMORY CONTEXT; EXPLICIT CONTINUITY AUTHORITY DEFERRED PENDING PROVEN NEED**

## 1. Purpose

Represent what remains unfinished or relevant across interaction gaps so Yuvi
can resume naturally, preserve commitments and expectations, notice unresolved
uncertainty, and also remain silent when nothing meaningful is open.

Continuity is not durable factual Memory and is not Persona. If a dedicated
Continuity semantic authority is later required, it is the bounded state of
“what still matters now?”

The current product path deliberately does not create that authority yet.
Detailed Direct Context plus reconstructable L1 episodes, explicit timestamps,
`taskState`/`unresolved` hints, and bounded associative recall already provide a
large part of the user-visible continuity experience. Real use and evaluation
must first show which remaining cases need durable explicit Continuity state.

## 2. Responsibility

A future explicit Continuity layer may own:

- open conversational or task threads that cannot be recovered reliably from
  recent episodic context;
- explicit commitments and expected follow-ups requiring durable semantic
  state beyond Memory evidence;
- expectations created by prior interaction;
- unresolved questions and uncertainty requiring explicit lifecycle;
- recent interaction residue that remains relevant after the immediate turn;
- attention anchors and reasons a situation may deserve reconsideration;
- closure, supersession, expiry, and decay of its own items using grounded time.

None of those responsibilities are implicitly granted to the current L1
heuristics. L1 `unresolved` and `taskState` fields are contextual hints, not an
implemented Continuity authority.

Continuity proposes relevance. For reactive conversation, the Character Model
decides whether it deserves a response. While current P6 remains active, its
`ProactiveDecisionProvider` remains the sole `NO_OP | REQUEST_TEXT` authority;
Memory context, future Continuity, and Character context must not become a
second proactive-text gate. Runtime decides whether any resulting effect may
execute.

## 3. Inputs

If implemented, an explicit Continuity layer may consume:

- bounded recent conversation and current interaction outcome;
- relevant Memory evidence after Memory-owned scope/status/time-validity
  filtering, retrieval eligibility, and ranking, with provenance/status intact;
- P8 identity and relationship context;
- grounded current/elapsed temporal context;
- explicit commitments, questions, corrections, cancellations, and closure
  signals;
- Runtime outcome events, including whether work completed, failed, was
  cancelled, or never started.

Assistant prose alone does not prove a commitment. A proposed commitment needs
an explicit semantic basis and outcome evidence.

## 4. Outputs

Only if proven necessary, explicit Continuity may emit:

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
| Runtime              | Persists admitted Continuity artifacts and records outcomes if such artifacts are introduced; execution state alone cannot decide semantic closure or ongoing conversational relevance.  |
| Memory               | Owns evidence records, record lifecycle, retrieval eligibility/filtering/ranking, and current L0/L1/L2 context; it does not become durable Continuity authority merely because L1 carries unresolved/task hints. |
| P8                   | Supplies stable identity/relationship interpretation; it must not absorb transient open threads or recent residue.                                                                        |
| **Continuity**       | Reserved owner for explicit unfinished-relevance state only when proven necessary; no separate Continuity authority is currently active.                                                  |
| Character Model      | Interprets current context and decides reactive response disposition; current proactive-text `NO_OP \| REQUEST_TEXT` remains solely P6-owned until atomic migration.                       |
| Cognition Core       | May resolve a difficult thread or uncertainty; it does not decide which conversational residue persists by default.                                                                       |
| Character Harness    | May assemble an explicit projection if one later exists; it cannot create, close, or persist Continuity on its own.                                                                       |
| MCP capability layer | May help satisfy an open thread; tool completion is evidence sent back through Runtime, not Continuity authority.                                                                         |
| Presentation         | Renders attention or silence; gaze/animation cannot create an attention anchor.                                                                                                           |

## 6. Hard invariants

- Current L0/L1 context is not silently promoted into a second durable truth
  store or implicit Continuity authority.
- Any future Continuity is not long-term factual Memory and is stored
  separately in meaning even if Runtime reuses persistence infrastructure.
- Continuity is not Persona or relationship authority.
- Every explicit open item must have a specific basis and be able to become
  closed, superseded, expired, decayed, or unknown.
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
- A replacement for Direct Context, L1 episodic context, or Memory retrieval.
- An autonomous inner monologue or simulated activity between interactions.
- Building an explicit Continuity engine merely because the roadmap once listed
  Phase 4 after Temporal.

## 8. Dependencies

- P8 supplies stable identity/relationship context.
- Character ABI supplies stable semantic slots when an explicit projection is
  actually needed.
- Memory vNext already supplies Direct Context, recent episodic context,
  associative recall, and thin temporal labels for the operational shortcut.
- Runtime outcome/event truth and current P6 behavior remain authoritative.

A dedicated Continuity layer is therefore not a prerequisite for current
product landing. It becomes authorized only by a repeatable failure that cannot
be solved by clearer recent context, timestamps, Memory retrieval, or model
behavior.

## 9. Relationship to existing implementation

**CURRENT / OPERATIONAL SHORTCUT:** Direct Context supplies bounded near-term
same-session conversation. Memory vNext reconstructs L1 episodes across
conversation persistence, groups them by session/time gap, keeps explicit local
time, and includes bounded `taskState`, `unresolved`, and assistant
non-authoritative context. Associative recall can reintroduce relevant L1/L2
material with age bands. Runtime/PromptBuilder places Direct Context, recent
L1, relevant associated Memory, and current/elapsed time into the live user-turn
prompt.

This provides natural resumption for many ordinary cases without a second state
machine. It is intentionally heuristic/contextual: L1 `unresolved` detection is
not a durable commitment ledger, assistant prose is not commitment authority,
and no current component owns explicit Continuity closure/supersession state.

**DEFERRED:** explicit open-thread identity, durable commitment/expectation
lifecycle, semantic closure/supersession, and attention-anchor state. Build the
smallest one of these only after real YUVI use or targeted evaluation produces a
stable failure that the current Memory-first path cannot solve.

## 10. Gap-driven implementation rule

Do not execute the former phase-sized plan by default. Use this order:

1. Evaluate real conversational resumption using Direct Context + L1 + thin
   time + associative L2 recall.
2. Classify failures: retrieval/context failure, model interpretation failure,
   or genuine missing durable Continuity semantics.
3. Fix retrieval/prompt/model behavior first when that is the actual cause.
4. If durable semantic state is genuinely required, add exactly one smallest
   artifact such as an explicit open item or commitment state with provenance.
5. Add lifecycle/attention concepts only when later evaluations prove them.

No `ContinuityEngine`, workflow graph, scheduler, or generic attention manager
is authorized by this document.

## 11. Acceptance concept

The current shortcut is acceptable for product landing when Yuvi can naturally
resume ordinary recent topics across minutes, hours, days, and relevant older
Memory intrusions; correctly notices elapsed time; preserves uncertainty; does
not invent commitments or off-screen events; and does not repeatedly surface
irrelevant old material.

A dedicated Continuity artifact is justified only when a real unfinished item
must survive beyond what bounded recent episodic context and retrieval can
reliably represent, and when the required closure semantics cannot safely be
inferred at read time.

## 12. Risks

- Duplicating Memory under a new name.
- Mistaking L1 heuristic `unresolved` text for authoritative open-thread state.
- Treating assistant suggestions as commitments.
- Keeping explicit open threads forever and creating nagging behavior.
- Closing ambiguous work because a provider returned text.
- Letting Continuity become a proactive scheduler or task planner.
- Overfitting attention to current P6 UI timing constants.
- Building state machinery before real product evidence demonstrates a need.

## 13. Open questions

- Which real product failures remain after L0/L1/time/intrusion are exercised
  for a sustained period?
- What is the minimum semantic identity for an open thread if one is eventually
  required across restarts?
- Which commitments require explicit user confirmation rather than remaining
  conversational context?
- Which closure signals are safe to infer, and which must be explicit?
- How much recent residue should survive beyond current L1 retention?
- What user-facing controls are necessary only if explicit Continuity state is
  introduced?

## 14. Handoff boundary

There is no mandatory Phase-4 build before current product landing or behavior
asset work. The operational seam is currently:

`Direct Context + reconstructable L1 + bounded associated L2 + thin time → Character/chat prompt`

If real usage later proves that a specific unfinished item requires durable
semantic lifecycle, that smallest artifact may be introduced under the reserved
Continuity authority. It must not become Memory truth, Persona, a second P6
gate, execution authority, or a generic task manager.
