# Phase 7 — Embodied Agency

> **Status: IMPLEMENTED — PHASE 7 CLOSED**

## 1. Purpose

Make Yuvi's visible, audible, and environment-facing behavior causally grounded
in attention, Continuity, current perception, situation, and admitted intent.
Embodiment should communicate agency without pretending that random idle motion
is a semantic decision.

## 2. Responsibility

Embodied agency covers the semantic-to-presentation path for:

- speech and meaningful silence;
- gaze and attention orientation;
- expression;
- pose and motion;
- environment-facing actions;
- interruption, cancellation, completion, and recovery presentation;
- causal explanation/audit linking behavior to an admitted semantic reason.

Presentation chooses device/UI-specific rendering within an admitted behavior
envelope. It does not decide the underlying attention, relationship, cognition,
or capability authority.

## 3. Inputs

- Character disposition and bounded behavior intent;
- Continuity anchors and current attention decision;
- temporal and situational context;
- current perception and presentation capabilities;
- normalized cognition/capability outcomes;
- Runtime admission, lifecycle, cancellation, and effect identity;
- accessibility, user preference, consent, and safety constraints;
- current P5 presence/speech/Live2D state.

## 4. Outputs

- admitted speech or explicit no-speech/silence presentation;
- gaze target/attention orientation;
- bounded expression and pose/motion intent;
- admitted environment action request/result projection;
- device/presentation outcome reports such as render started/completed, device
  rejected/failed/interrupted, or observed presentation outcome;
- safe causal metadata tying an effect to attention/situation and execution
  identity;
- presentation fallback when semantic embodiment is unavailable.

## 5. Authority boundaries

| Candidate owner      | Boundary audit                                                                                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime              | Admits, executes, cancels, identities, performs authoritative lifecycle transitions, and publishes canonical embodied-effect events; it does not define UI-specific rendering.                                                         |
| Memory               | May record admitted observations/outcomes under policy; it does not animate or infer agency from presentation.                                                                                                                         |
| P8                   | Supplies stable identity/relationship constraints; it does not choose a gaze target or execute speech.                                                                                                                                 |
| Continuity           | Supplies attention anchors and unresolved relevance; it does not animate or admit an effect.                                                                                                                                           |
| Character Model      | Proposes social response, silence, and bounded behavior intent; it cannot claim a physical/visual effect occurred.                                                                                                                     |
| Cognition Core       | Supplies serious work results and may propose an environment need; it does not define final character embodiment.                                                                                                                      |
| Character Harness    | Interprets and forwards semantic intent; it neither renders nor owns effect lifecycle.                                                                                                                                                 |
| MCP capability layer | May implement environment-facing capabilities under Runtime admission; it does not own Live2D/voice presentation meaning.                                                                                                              |
| **Presentation**     | Owns device rendering and reports observed device outcomes because speech, gaze, expression, pose, and motion are surface/device-specific realizations of admitted intent. It does not publish authoritative Runtime lifecycle events. |

Embodied behavior belongs in Presentation only after Character/Harness intent
and Runtime admission. Causal semantics remain upstream; rendering remains
downstream.

## 6. Hard invariants

- Every semantic embodied action is traceable to attention, Continuity,
  situation, perception, or an admitted user/cognition request.
- Random idle animation is presentation fallback only, not agency semantics.
- Silence is meaningful when chosen upstream and is not automatically filled
  with speech or motion.
- Presentation cannot create Persona, relationship, Memory, attention, or
  provider truth.
- Runtime admits all effectful speech/environment actions and owns identity,
  cancellation, concurrency, authoritative lifecycle transitions, and canonical
  event publication.
- Presentation reports device/render outcomes only. Runtime may accept and
  translate a report into an authoritative effect-state event.
- User work and interruption retain priority over proactive behavior.
- Stale callbacks are fenced to the originating effect.
- Capability unavailability degrades truthfully without fake completion.
- Accessibility and explicit user controls outrank character preference.
- P6 remains the proven text-only proactive subset until broader authority is
  explicitly added through the atomic migration rule. Current
  `NO_OP | REQUEST_TEXT` remains solely P6-owned until that switch.

## 7. Explicit non-goals

- Random autonomous animation presented as semantic agency.
- Off-screen life simulation or hidden activity.
- Presentation-owned attention, relationship, cognition, or capability routing.
- Automatic proactive TTS, tools, or environment actions by implication from
  existing P6 consent.
- A general game-agent framework.
- A full motion ontology or universal animation graph before concrete needs are
  evaluated.

## 8. Dependencies

- Phases 1–6 semantic context, Character decisions, Harness mediation,
  cognition/capability seams, and Runtime admission.
- Current P5 Live2D/presence/speech behavior and P6 priority/fencing semantics.
- Truthful capability projection for speech, visual behavior, and environment
  actions.

Post-training may later improve behavioral priors but cannot supply missing
causal or effect-authority architecture.

## 9. Relationship to existing implementation

**CURRENT:** P5 implements Live2D companion presentation, presence/capability
projection, speech playback queues, semantic lifecycle gaze policy, and
interruption/fencing behavior. P6 adds bounded silent-attention eligibility and
a text-only assistant-initiated path. P6 grants no proactive TTS, voice, tool,
or general environment-action authority.

**IMPLEMENTED:** the first bounded Character-driven slice consumes a
turn-correlated Character/Harness proposal, receives Runtime-owned identity and
admission, and crosses the existing dashboard WebSocket/CompanionBus into the
Lumi Presentation surface. Presentation returns only a validated device
observation; Runtime reduces and publishes the authoritative lifecycle event.
The bridge rejects malformed or stale reports, times out without fake success,
and keeps idle animation outside semantic effect identity. P5/P6 remain
unchanged; P6 is still `NO_OP | REQUEST_TEXT`.

Broader attention, Continuity, temporal, perception, speech-authority, and
environment-action expansion remain deferred until separately admitted by the
same authority rules.

## 10. Likely staged implementation shape

1. Define a minimal causal behavior envelope for silence, gaze, and expression.
2. Project existing P5/P6 lifecycle identities into that envelope without
   changing behavior or transferring lifecycle/publication authority to
   Presentation.
3. Add one Character-driven gaze/expression path under Runtime identity and
   fencing.
4. Add speech authority only with separate consent/admission and interruption
   semantics.
5. Add one low-risk environment action after MCP/Runtime effect semantics are
   proven.
6. Expand motion vocabulary only from observed product needs and evaluations.

## 11. Acceptance concept

The phase is acceptable when observers and diagnostics can distinguish
semantic behavior from idle fallback; every effect is causally and
execution-identity linked; user interruption reliably preempts proactive
behavior; silence remains intact; unavailable capabilities do not produce fake
success; Presentation device reports cannot become authoritative lifecycle
events without Runtime acceptance; and a presentation implementation can be
replaced without changing attention, P8, Cognition, or Runtime semantics.

## 12. Risks

- Anthropomorphic overclaim from random or latency-driven animation.
- Presentation state or device reports feeding back as relationship, attention,
  or authoritative Runtime lifecycle truth.
- Reusing text consent as permission for speech or environment effects.
- Race conditions between generation, speech, gaze, and interruption.
- Overly expressive motion that contradicts uncertainty or current situation.
- Building a universal animation/action framework before causal semantics are
  proven.

## 13. Open questions

- What minimal behavior envelope works across Live2D, future VRM, voice-only,
  and text-only surfaces?
- Which silence states need visible differentiation, if any?
- What consent model applies separately to speech and environment actions?
- How should simultaneous gaze, speech, expression, and motion share one effect
  lifecycle?
- Which presentation outcomes may become Memory evidence?
- How can causal diagnostics remain useful without exposing private context?
- Which idle behaviors should be explicitly labeled non-semantic fallback?

## 14. Handoff boundary to the next phase

Phase 7 hands phase 8 Runtime-authoritative effect traces plus bounded
Presentation device outcome reports, causal intent/outcome labels, and failure
cases suitable for specification and evaluation. Phase 8 may use them as data
only with provenance and environment-bound labeling. It must not treat a raw
device report as Runtime lifecycle truth or train current tool names, provider
names, Runtime fields, or presentation accidents into Yuvi's identity.
