# Phase 3 — Temporal Substrate

> **Status: PLANNED / NOT IMPLEMENTED**

## 1. Purpose

Give Yuvi grounded temporal awareness: where the interaction sits in time, how
much time has elapsed, which consumer-specific relevance may decay, and which
past or future horizon is appropriate. Time should inform behavior without
inventing an off-screen life between observed interactions or taking ownership
of Memory record validity.

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
and mutations of Memory lifecycle. P8 and Continuity own the semantic effect of
temporal calculations on their own projections.

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
  consumers;
- non-mutating temporal ordering or horizon queries for P8 and Continuity;
- next consumer-supplied temporal boundary crossing when a consumer genuinely
  needs it.

The output describes temporal meaning. It does not schedule effects or claim
that Yuvi experienced unobserved events.

## 5. Authority boundaries

| Candidate owner      | Boundary audit                                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime              | Supplies clocks, persists timestamps, schedules admitted work, and enforces lifecycle; it should not embed phase-specific decay meaning in generic execution state.                          |
| Memory               | Owns evidence timestamps, `expiresAt`, validity/status, retention, retrieval exclusion, and Memory lifecycle mutation; it does not decide relationship, attention, or open-thread relevance. |
| P8                   | Consumes recency when interpreting persona/relationship evidence; it does not define the common elapsed-time substrate.                                                                      |
| Continuity           | Applies temporal output to and owns expiry/closure/decay status for open threads and expectations; it does not own shared elapsed/horizon calculations.                                      |
| Character Model      | Interprets compact temporal context for natural behavior; it must not calculate authoritative elapsed time from guessed narrative.                                                           |
| Cognition Core       | May reason about dates and plans, but is not the authoritative clock, Memory-record expiry, or consumer-state transition source.                                                             |
| Character Harness    | Projects temporal context and handles missing sections; it does not invent time or run a clock-owned state machine.                                                                          |
| MCP capability layer | May expose calendar/time capabilities under admission; external tool output becomes evidence, not automatic temporal authority.                                                              |
| Presentation         | May animate a day/night or waiting state, but visuals cannot establish elapsed reality.                                                                                                      |

This belongs in a shared temporal substrate because P8, Continuity, attention,
and embodiment need identical grounded time calculations while keeping Memory
record lifecycle, Runtime execution, and model narration separate.

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

## 8. Dependencies

- Phase 2 defines the temporal ABI meaning slot.
- Current Memory temporal/provenance fields and P4 persistence semantics remain
  intact.
- Runtime can provide current clock observations without ceding lifecycle
  authority.

Continuity consumes this phase next. Calendar capabilities and embodied time
presentation are later, optional consumers.

## 9. Relationship to existing implementation

**CURRENT:** Memory already distinguishes temporal fields such as observed,
event, validity, expiry, access, and supersession times. It excludes stale or
expired evidence according to current retrieval/maintenance rules.
`PromptBuilder` can include `CurrentTime` with an ISO timestamp, timezone, and
local date. Current P6 eligibility uses monotonic browser timing for bounded
idle behavior.

**PLANNED:** the temporal substrate gives shared, non-mutating meaning to
elapsed gaps, age, temporal distance, derived decay, and horizons for
P8/Continuity/Character use. Memory continues to own record expiry, validity,
status, retention, retrieval exclusion, and their mutations. Temporal does not
replace P6 constants, browser timers, or Runtime scheduling.

## 10. Likely staged implementation shape

1. Catalog trustworthy time sources and semantic distinctions.
2. Define compact current-position and elapsed-gap projections, including
   unknown/ambiguous cases.
3. Add purpose-specific temporal-distance and horizon evaluation without
   scheduling or Memory mutation.
4. Add decay semantics only where a consumer has proven need.
5. Validate restart, timezone-change, clock-jump, and missing-timestamp cases.

Start with pure, deterministic semantic calculations over supplied
observations. Add no background process unless an actual consumer proves it is
required.

## 11. Acceptance concept

The phase is acceptable when the same recorded observations yield deterministic
temporal projections across Runtime restarts; gaps are acknowledged without
invented events; derived age/decay/horizon calculations never mutate Memory
validity, status, retention, or retrieval eligibility; missing timestamps stay
unknown; and P8/Continuity can make bounded recency decisions without reading
Runtime clock internals.

## 12. Risks

- Treating wall-clock time as monotonic or precise across suspend/restart.
- Conflating `recordedAt` with `occurredAt`.
- Turning relevance decay into Memory expiry, factual forgetting, or
  relationship decay.
- Adding background timers before semantic consumers exist.
- Letting the model narrate an off-screen life from an elapsed duration.
- Creating one universal horizon that is wrong for every domain.

## 13. Open questions

- Which time observations are trustworthy across suspend, restart, and manual
  clock changes?
- Which elapsed bands are useful to the Character Model without leaking false
  precision?
- Which P8 and Continuity artifacts may their owning phases mark inactive
  versus merely decay after consuming temporal derivations?
- How should timezone ambiguity and travel be projected?
- When should an explicit user date override inferred event time?
- What temporal diagnostics are safe and useful without exposing private
  schedules?

## 14. Handoff boundary to the next phase

Phase 3 hands phase 4 grounded current time, elapsed-gap, temporal-distance,
derived-decay, horizon, and uncertainty meanings. Phase 4 may apply them to and
own state transitions for open threads and attention anchors. It must not
reinterpret temporal uncertainty as certainty, mutate Memory evidence/lifecycle,
or simulate unobserved continuity events.
