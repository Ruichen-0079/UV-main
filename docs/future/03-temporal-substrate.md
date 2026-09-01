# Phase 3 — Temporal Substrate

> **Status: THIN OPERATIONAL SUBSET IMPLEMENTED; FULL SHARED SUBSTRATE DEFERRED PENDING PROVEN NEED**

## 1. Purpose

Give Yuvi grounded temporal awareness: where the interaction sits in time, how
much time has elapsed, which consumer-specific relevance may decay, and which
past or future horizon is appropriate. Time should inform behavior without
inventing an off-screen life between observed interactions or taking ownership
of Memory record validity.

The current product path intentionally starts with the smallest useful subset:
accurate current/local time, elapsed time since the prior interaction, explicit
age bands, timestamp uncertainty, and time-labelled recent/associated Memory.
A broader shared Temporal subsystem is not a prerequisite for product use and
must be added only when evaluation or real usage proves a missing semantic need.

## 2. Responsibility

The temporal substrate owns the semantics of:

- current time position and timezone context;
- elapsed time between trustworthy observations;
- recency and bounded temporal horizons;
- non-mutating calculations for consumer-owned relevance or urgency decay;
- temporal distance from consumer-supplied validity or horizon boundaries;
- uncertainty when event time, clock continuity, or timezone is unknown;
- recognition of interaction gaps without fabricating events inside them.

Temporal output is derived, non-mutating input to an owning consumer. Memory
alone owns `expiresAt`, record validity/status, retention, retrieval exclusion,
and mutations of Memory lifecycle. P8 and any future explicit Continuity layer
own the semantic effect of temporal calculations on their own projections.

## 3. Inputs

- Runtime-supplied clock observations and timezone context;
- durable evidence timestamps, preserving the distinction between observed,
  recorded, occurred, valid-from, valid-until, and expiry meanings;
- explicit user temporal claims and normalized absolute times when available;
- session/restart boundaries and last trustworthy interaction position;
- consumer-owned horizon and decay policies supplied for calculation.

Clock or source uncertainty must remain explicit. A missing source timestamp
must not be replaced by “now.”

## 4. Outputs

- compact current temporal context for the Character ABI;
- elapsed-gap interpretation with confidence/uncertainty;
- age, temporal distance, decay-value, or within/outside-horizon derivations for
  consumers when a proven consumer requires them;
- non-mutating temporal ordering or horizon queries for P8 and any future
  explicit Continuity layer;
- next consumer-supplied temporal boundary crossing only when a consumer
  genuinely needs it.

The output describes temporal meaning. It does not schedule effects or claim
that Yuvi experienced unobserved events.

## 5. Authority boundaries

| Candidate owner      | Boundary audit                                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime              | Supplies clocks, persists timestamps, schedules admitted work, and enforces lifecycle; it should not embed phase-specific decay meaning in generic execution state.                          |
| Memory               | Owns evidence timestamps, `expiresAt`, validity/status, retention, retrieval exclusion, and Memory lifecycle mutation; it does not decide relationship, attention, or open-thread relevance. |
| P8                   | Consumes recency when interpreting persona/relationship evidence; it does not define the common elapsed-time substrate.                                                                      |
| Continuity           | If an explicit Continuity layer is later required, it may apply temporal output to its own items; it does not own shared elapsed calculations.                                               |
| Character Model      | Interprets compact temporal context for natural behavior; it must not calculate authoritative elapsed time from guessed narrative.                                                           |
| Cognition Core       | May reason about dates and plans, but is not the authoritative clock, Memory-record expiry, or consumer-state transition source.                                                             |
| Character Harness    | Projects temporal context and handles missing sections; it does not invent time or run a clock-owned state machine.                                                                          |
| MCP capability layer | May expose calendar/time capabilities under admission; external tool output becomes evidence, not automatic temporal authority.                                                              |
| Presentation         | May animate a day/night or waiting state, but visuals cannot establish elapsed reality.                                                                                                      |

A larger shared substrate is justified only when multiple proven consumers need
semantics beyond the currently implemented thin projection. The roadmap must
not create a Temporal manager merely to mirror this document.

## 6. Hard invariants

- No fake off-screen life, hidden activity, feelings, or experiences are
  simulated across gaps.
- Elapsed time is derived from trustworthy observations; uncertainty is not
  rounded into false precision.
- Missing source timestamps remain unknown.
- Recorded time and event/occurrence time remain distinct.
- Derived decay affects consumer relevance/urgency, not Memory evidence truth,
  status, retention, or identity.
- Temporal never mutates, archives, expires, or changes retrieval eligibility
  of a Memory record.
- Horizons are bounded and purpose-specific.
- Timezone changes and clock discontinuities fail conservatively.
- Runtime remains the scheduling and effect authority.
- Temporal output is provider/model/storage neutral.

## 7. Explicit non-goals

- Simulating Yuvi thinking, waiting, missing the user, or living independently
  while no observation exists.
- A general calendar/task scheduler.
- Replacing Memory validity/status/retention/retrieval exclusion, Runtime
  timers, or P4 durability.
- Relationship progression based only on elapsed time.
- A mood decay engine.
- Exact database schema, cron system, or TypeScript clock hierarchy.
- Building the full originally planned substrate before product evidence shows
  that the current thin projection is insufficient.

## 8. Dependencies

- Phase 2 defines the temporal ABI meaning slot.
- Current Memory temporal/provenance fields and P4 persistence semantics remain
  intact.
- Runtime provides current clock observations without ceding lifecycle
  authority.

The current Memory-first path can operate without a separate Continuity phase.
Any later consumer may request only the additional temporal semantics it can
prove it needs.

## 9. Relationship to existing implementation

**CURRENT / IMPLEMENTED THIN SUBSET:** Memory vNext provides
`memory-vnext-temporal.v1`, including current ISO/local time and timezone,
`lastInteractionAt`, elapsed time since the prior interaction, bounded age
bands, gap acknowledgement, episode-local positions, temporal confidence, and
`occurredAt` versus `recordedAt` distinction. The current user turn is excluded
when calculating the prior interaction, so a real gap is not collapsed to
approximately zero. Missing timestamps remain unknown and the prompt explicitly
forbids invented gap events or an off-screen life.

Current Runtime/PromptBuilder wiring places local time, elapsed gap, age band,
Direct Context, time-labelled L1 recent episodic memory, and bounded associated
L1/L2 recall into the live user-turn prompt. Prompt and Memory hardening tests
cover the combined path, including an overnight interaction gap and associated
older memory. Memory continues to own record expiry, validity, status,
retention, retrieval exclusion, and their mutations.

**DEFERRED:** a broader cross-consumer substrate for generic temporal distance,
consumer horizons, clock-discontinuity semantics, or reusable decay functions.
These are not current prerequisites. Add them only in the smallest pure atom
when a concrete P8, Continuity, attention, or other consumer fails an evaluation
without them.

## 10. Gap-driven implementation rule

Do not execute the former phase-sized build plan by default. Use this order:

1. Evaluate the current thin projection in product-relevant scenarios.
2. Prefer accurate timestamps, explicit elapsed labels, L1 episodic context,
   and time-labelled associative recall over new state machinery.
3. When a repeatable failure remains, identify the smallest missing temporal
   meaning.
4. Add one pure deterministic derivation for that proven consumer.
5. Re-evaluate before adding another abstraction.

No background process, scheduler, universal decay engine, or generic Temporal
manager is authorized by this roadmap.

## 11. Acceptance concept

The current thin path is acceptable for operational use when trustworthy
recorded observations yield deterministic current/elapsed projections; gaps are
acknowledged without invented events; current-turn timestamps do not overwrite
the prior interaction; recent and associated memories remain visibly positioned
in time; and missing timestamps stay unknown.

A broader substrate becomes necessary only when real evaluation demonstrates a
stable failure that cannot be solved by clearer timestamp projection or Memory
context. Any extension must still leave Memory validity, status, retention, and
retrieval eligibility untouched.

## 12. Risks

- Treating wall-clock time as monotonic or precise across suspend/restart.
- Conflating `recordedAt` with `occurredAt`.
- Turning relevance decay into Memory expiry, factual forgetting, or
  relationship decay.
- Adding background timers before semantic consumers exist.
- Letting the model narrate an off-screen life from an elapsed duration.
- Creating one universal horizon that is wrong for every domain.
- Rebuilding already sufficient Memory/Prompt behavior as a second Temporal
  authority.

## 13. Open questions

- Which real product scenarios still fail with the current thin projection?
- Which time observations are trustworthy across suspend, restart, and manual
  clock changes if those cases become product failures?
- Which additional elapsed bands, if any, improve Character behavior rather
  than merely adding precision?
- When does a future explicit open-thread artifact require a bounded horizon
  that L1 retention and model interpretation cannot provide?
- How should timezone ambiguity and travel be projected when real use exposes
  that case?

## 14. Handoff boundary

There is no mandatory handoff from a completed full Phase 3 into Phase 4. The
current operational seam is:

`Runtime clock + conversation timestamps + Memory timestamps → thin temporal projection → Prompt/Character context`

If future evaluation proves an explicit Continuity artifact is required, it may
consume this projection and request only the additional deterministic temporal
meaning it needs. It must not reinterpret uncertainty as certainty, mutate
Memory evidence/lifecycle, or simulate unobserved continuity events.
