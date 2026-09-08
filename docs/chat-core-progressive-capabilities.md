# Chat Core & Progressive Capability Activation

Chat is the only model route required for conversation. The server and configuration
UI boot without it; `/health.conversationalReadiness` reports `NOT_CONFIGURED`,
`READY`, or `UNAVAILABLE`. Local readiness does not prove remote reachability.
Optional model routes do not participate in global conversational readiness.

## Route authority

The existing ProviderRegistry remains the authority. A model name in its capability
configuration plus the necessary connection credentials and an enabled chain slot
activates that route. Having the same model on Chat does not assign it to Reasoning,
Proactive, or another route. One compatible model may be assigned to several routes.
No additional feature flags or Models UI changes are introduced. Explicit offline
mock mode retains its existing synthetic providers.

| Route     | Activated behavior                                  | Without route                                                  |
| --------- | --------------------------------------------------- | -------------------------------------------------------------- |
| Chat      | Ordinary Character conversation and proactive prose | Configuration server boots; conversation not configured        |
| Reasoning | Bounded Cognition through its existing seam         | Cognition unavailable/fail-closed; Chat continues              |
| Proactive | Speak-score evaluation                              | No scheduler timer, provider evaluation, errors, or retry loop |
| Embedding | Semantic/hybrid retrieval                           | Rule-based extraction and lexical retrieval                    |
| Vision    | Runtime-admitted visual grounding                   | Visual evidence unavailable                                    |
| STT       | Speech input                                        | Text input                                                     |
| TTS       | Speech output                                       | Text output                                                    |

Memory extraction defaults to `rule-based` at boot and reload. Adding Reasoning does
not change it. Explicit `MEMORY_EXTRACTOR=llm` remains an opt-in to the existing LLM
extractor with rule-based fallback. This is extraction strategy, not a capability
activation flag. Embedding calls are disabled when there is no configured route.

## Proactive policy

The ordinary Character generation may include the existing `proactive` ABI field:
`KEEP`, `CLEAR`, `DEFER` (SHORT/NORMAL/LONG), or `SUPPRESS` (UNTIL with duration or
absolute time, UNTIL_ENGAGEMENT, UNTIL_EXPLICIT_RESUME). Omission means KEEP for
compatibility. The ABI validates the proposal; Runtime retains control-authority
checks and atomically persists the existing policy snapshot. A silent reply alone
has no quiet-policy meaning. Explicit controller consent restrictions remain
respected independently of route availability.

The production evaluator returns exactly `{"score":0.75}`: finite, normalized
0..1. Runtime continues when `score >= PROACTIVE_SCORE_THRESHOLD` (default 0.7).
A lower score skips only that evaluation and never writes a quiet deadline or
changes the future interval. `PROACTIVE_EVALUATION_INTERVAL_MS` independently sets
the fixed interval (default 60000, minimum 1000); invalid values fall back to the
default. The interval applies to scheduled and directly requested evaluations.
Explicit suppression stays authoritative. Existing post-emission quiet time and
provider-error retry policy remain separate from low-score handling.

After a passing score, the regular Chat provider generates the assistant-initiated
prose. It requires no continuation model or format. Legacy injected-provider
adapters and their binary stream events remain internal compatibility seams.
Production generation does not use the legacy raw-continuation endpoint.

## Context and continuity

Backend route metadata is supplied using `DEEPSEEK_CHAT_CONTEXT_WINDOW`,
`OPENAI_COMPATIBLE_CHAT_CONTEXT_WINDOW`, `NVIDIA_CHAT_CONTEXT_WINDOW`, or
`LOCAL_CHAT_CONTEXT_WINDOW` (token counts). The smallest enabled configured Chat
fallback-route window governs; unknown metadata on any fallback route selects the
conservative 16384-token fallback. No remote metadata probe is needed at boot.

Normal work uses at most 75% of that window, capped at 24576 tokens. Output and
safety each reserve up to 2048 tokens. For 128K, this leaves a 20480-character
semantic/input allowance, with the much larger remainder unused. Conservative
one-character-per-token accounting replaces the old chars/4 product estimate;
rendered Character instructions and JSON overhead are checked as well. This is a
deterministic upper-budget heuristic, not a model tokenizer.

Character/P8 identity, persona, relationship semantics and the full current user
message are protected. Optional context is deterministically compressed using the
existing `compressHierarchicalContext` primitive before Character assembly. If
protected content alone cannot fit, the turn fails explicitly rather than silently
truncating it. Cognition re-entry cannot displace those protected semantics.

Recent L0 favors the newest turns. Full persisted messages independently reconstruct
and fold older conversation into bounded L1 episodes before L0 selection removes
it. L1 precedes compact L2 evidence; associative recall and temporal context remain
tiny. Compression results now feed the live Memory projection rather than only
producing metrics. Compression preserves epistemic markers and reports partial
context honestly. The existing ABI per-section bounds remain intact.

ConversationRepository, DirectContext, recent episode persistence/reconstruction,
P8, thin time context, rule-based extraction and lexical retrieval work without
Reasoning or Embedding. Durable restart coverage uses the existing PostgreSQL
production repository supported by Linux Persistence CI. Explicit in-memory
repository mode remains ephemeral.

## Verification

`chat-progressive-production.test.ts` exercises first-run boot, all optional route
add/remove transitions through ordinary production Character turns, scheduler
inactivity, extraction stability, score/interval/prose behavior, persisted Character
suppression, protected/model-aware context, and database-backed restart continuity.
The database case runs in Linux Persistence CI after migrations. Existing provider,
Character, Runtime, Memory, persistence and prompt-builder suites remain regression
gates, alongside `pnpm check`, `pnpm build`, `pnpm test`, and `pnpm smoke`.
