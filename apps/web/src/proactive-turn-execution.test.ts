import { describe, expect, it, vi } from "vitest";
import { reduceChatMessages, type ChatMessage } from "./chat-state.js";
import {
  createProactiveTurnExecution,
  isCurrentProactiveEffect,
  preemptProactiveRequest,
  type ActiveRequestOwnership,
  type ProactiveTurnEffect
} from "./proactive-turn-execution.js";

const accepted = { decision: "accepted", reason: "consent-enabled" } as const;
const denied = { decision: "denied", reason: "consent-disabled" } as const;

const context = {
  sessionId: "session-current",
  readMemory: true,
  promptPreview: false
};

function createExecution(
  overrides: {
    createRequestId?: () => string;
    createAssistantId?: () => string;
    createIdempotencyKey?: () => string;
    createAbortController?: () => AbortController;
  } = {}
) {
  return createProactiveTurnExecution({
    createRequestId: overrides.createRequestId ?? vi.fn(() => "request-1"),
    createAssistantId: overrides.createAssistantId ?? vi.fn(() => "assistant-1"),
    createIdempotencyKey: overrides.createIdempotencyKey ?? vi.fn(() => "runtime-key-1"),
    ...(overrides.createAbortController === undefined
      ? {}
      : { createAbortController: overrides.createAbortController })
  });
}

function appendAssistant(messages: ChatMessage[], effect: ProactiveTurnEffect): ChatMessage[] {
  return reduceChatMessages(messages, {
    type: "append-assistant",
    assistant: {
      id: effect.assistantId,
      requestId: effect.requestId,
      role: "assistant",
      content: "",
      status: "streaming"
    }
  });
}

function activeUser(): ActiveRequestOwnership {
  return {
    id: "user-request-1",
    assistantId: "user-assistant-1",
    controller: new AbortController(),
    completedObserved: false,
    origin: "user"
  };
}

describe("proactive turn execution", () => {
  it("denies before commit and performs no claim, key generation, identity, or controller work", () => {
    const createRequestId = vi.fn(() => "request-denied");
    const createAssistantId = vi.fn(() => "assistant-denied");
    const createIdempotencyKey = vi.fn(() => "runtime-denied");
    const createAbortController = vi.fn(() => new AbortController());
    const execution = createExecution({
      createRequestId,
      createAssistantId,
      createIdempotencyKey,
      createAbortController
    });

    const result = execution.tryCommit({
      decisionId: "decision-denied",
      admission: denied,
      active: null,
      context
    });

    expect(result).toEqual({ kind: "not-admitted", admission: denied });
    expect(createRequestId).not.toHaveBeenCalled();
    expect(createAssistantId).not.toHaveBeenCalled();
    expect(createIdempotencyKey).not.toHaveBeenCalled();
    expect(createAbortController).not.toHaveBeenCalled();
    expect(execution.isDecisionClaimed("decision-denied")).toBe(false);
  });

  it("commits accepted idle work once, claims before key generation, and keeps Runtime identity separate", () => {
    let execution!: ReturnType<typeof createProactiveTurnExecution>;
    const createIdempotencyKey = vi.fn(() => {
      expect(execution.isDecisionClaimed("decision-1")).toBe(true);
      return "runtime-key-1";
    });
    execution = createExecution({
      createRequestId: vi.fn(() => "request-1"),
      createAssistantId: vi.fn(() => "assistant-1"),
      createIdempotencyKey
    });

    const result = execution.tryCommit({
      decisionId: "decision-1",
      admission: accepted,
      active: null,
      context
    });

    expect(result.kind).toBe("committed");
    if (result.kind !== "committed") return;
    expect(createIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(result.effect.idempotencyKey).not.toBe(result.effect.decisionId);
    expect(result.effect.request).toEqual({
      sessionId: "session-current",
      idempotencyKey: "runtime-key-1",
      modality: "text",
      options: { readMemory: true, promptPreview: false }
    });
    expect(result.effect.request).not.toHaveProperty("decisionId");
    expect(result.effect.request).not.toHaveProperty("writeMemory");
    expect(result.effect.request).not.toHaveProperty("voiceOutput");
    expect(result.effect.ownership).toMatchObject({
      id: "request-1",
      assistantId: "assistant-1",
      origin: "proactive"
    });
  });

  it("captures the context supplied at each commit rather than an earlier snapshot", () => {
    const execution = createProactiveTurnExecution({
      createRequestId: (() => {
        let sequence = 0;
        return () => `request-${++sequence}`;
      })(),
      createAssistantId: (() => {
        let sequence = 0;
        return () => `assistant-${++sequence}`;
      })(),
      createIdempotencyKey: (() => {
        let sequence = 0;
        return () => `runtime-${++sequence}`;
      })()
    });
    const first = execution.tryCommit({
      decisionId: "decision-first",
      admission: accepted,
      active: null,
      context: { sessionId: "session-first", readMemory: false, promptPreview: true }
    });
    const second = execution.tryCommit({
      decisionId: "decision-second",
      admission: accepted,
      active: null,
      context: { sessionId: "session-second", readMemory: true, promptPreview: false }
    });

    expect(first.kind).toBe("committed");
    expect(second.kind).toBe("committed");
    if (first.kind !== "committed" || second.kind !== "committed") return;
    expect(first.effect.request).toMatchObject({
      sessionId: "session-first",
      options: { readMemory: false, promptPreview: true }
    });
    expect(second.effect.request).toMatchObject({
      sessionId: "session-second",
      options: { readMemory: true, promptPreview: false }
    });
  });

  it("never forwards a generated key equal to the bus decision identity", () => {
    const execution = createExecution({ createIdempotencyKey: vi.fn(() => "decision-collision") });
    const result = execution.tryCommit({
      decisionId: "decision-collision",
      admission: accepted,
      active: null,
      context
    });

    expect(result.kind).toBe("committed");
    if (result.kind !== "committed") return;
    expect(result.effect.idempotencyKey).not.toBe(result.effect.decisionId);
    expect(result.effect.idempotencyKey).toMatch(/^runtime-/);
  });

  it("suppresses a user-active request without claiming it, then permits its replay", () => {
    const createIdempotencyKey = vi.fn(() => "runtime-after-user");
    const execution = createExecution({ createIdempotencyKey });
    const decisionId = "decision-wait-for-user";

    expect(
      execution.tryCommit({
        decisionId,
        admission: accepted,
        active: activeUser(),
        context
      })
    ).toEqual({ kind: "suppressed", reason: "user-active" });
    expect(execution.isDecisionClaimed(decisionId)).toBe(false);
    expect(createIdempotencyKey).not.toHaveBeenCalled();

    const replay = execution.tryCommit({
      decisionId,
      admission: accepted,
      active: null,
      context
    });
    expect(replay.kind).toBe("committed");
    expect(createIdempotencyKey).toHaveBeenCalledTimes(1);
  });

  it("suppresses duplicates and busy proactive work without a second key or effect", () => {
    const createIdempotencyKey = vi.fn(() => "runtime-first");
    const execution = createExecution({ createIdempotencyKey });
    const first = execution.tryCommit({
      decisionId: "decision-first",
      admission: accepted,
      active: null,
      context
    });
    expect(first.kind).toBe("committed");
    if (first.kind !== "committed") return;

    expect(
      execution.tryCommit({
        decisionId: "decision-first",
        admission: accepted,
        active: null,
        context
      })
    ).toEqual({ kind: "suppressed", reason: "decision-claimed" });
    expect(
      execution.tryCommit({
        decisionId: "decision-second",
        admission: accepted,
        active: first.effect.ownership,
        context
      })
    ).toEqual({ kind: "suppressed", reason: "execution-busy" });
    expect(createIdempotencyKey).toHaveBeenCalledTimes(1);
  });

  it("preempts only proactive ownership for a user turn and retains the committed claim", () => {
    const execution = createExecution({ createIdempotencyKey: vi.fn(() => "runtime-replayed") });
    const first = execution.tryCommit({
      decisionId: "decision-preempted",
      admission: accepted,
      active: null,
      context
    });
    expect(first.kind).toBe("committed");
    if (first.kind !== "committed") return;

    const proactive = first.effect.ownership;
    expect(preemptProactiveRequest(proactive)).toBe(true);
    expect(proactive.controller.signal.aborted).toBe(true);
    expect(preemptProactiveRequest(activeUser())).toBe(false);

    // A committed decision remains one-shot even after user preemption.
    expect(
      execution.tryCommit({
        decisionId: "decision-preempted",
        admission: accepted,
        active: null,
        context
      })
    ).toEqual({ kind: "suppressed", reason: "decision-claimed" });
  });

  it("retains a one-shot claim after a terminal chat transition", () => {
    const execution = createExecution();
    const first = execution.tryCommit({
      decisionId: "decision-terminal",
      admission: accepted,
      active: null,
      context
    });
    expect(first.kind).toBe("committed");
    if (first.kind !== "committed") return;

    let messages = appendAssistant([], first.effect);
    messages = reduceChatMessages(messages, {
      type: "append-delta",
      assistantId: first.effect.assistantId,
      text: "partial",
      traceId: "trace-terminal"
    });
    messages = reduceChatMessages(messages, {
      type: "cancel",
      assistantId: first.effect.assistantId,
      error: "cancelled"
    });
    expect(messages[0]).toMatchObject({ role: "assistant", status: "cancelled" });

    expect(
      execution.tryCommit({
        decisionId: "decision-terminal",
        admission: accepted,
        active: null,
        context
      })
    ).toEqual({ kind: "suppressed", reason: "decision-claimed" });
  });

  it("applies success, error, and cancellation transitions only to the assistant row", () => {
    const execution = createProactiveTurnExecution({
      createRequestId: (() => {
        let n = 0;
        return () => `request-${++n}`;
      })(),
      createAssistantId: (() => {
        let n = 0;
        return () => `assistant-${++n}`;
      })(),
      createIdempotencyKey: (() => {
        let n = 0;
        return () => `runtime-${++n}`;
      })()
    });
    const success = execution.tryCommit({
      decisionId: "decision-success",
      admission: accepted,
      active: null,
      context
    });
    const failure = execution.tryCommit({
      decisionId: "decision-failure",
      admission: accepted,
      active: null,
      context
    });
    const cancellation = execution.tryCommit({
      decisionId: "decision-cancel",
      admission: accepted,
      active: null,
      context
    });
    expect(success.kind).toBe("committed");
    expect(failure.kind).toBe("committed");
    expect(cancellation.kind).toBe("committed");
    if (
      success.kind !== "committed" ||
      failure.kind !== "committed" ||
      cancellation.kind !== "committed"
    ) {
      return;
    }

    let messages: ChatMessage[] = [];
    messages = appendAssistant(messages, success.effect);
    messages = appendAssistant(messages, failure.effect);
    messages = appendAssistant(messages, cancellation.effect);
    messages = reduceChatMessages(messages, {
      type: "append-delta",
      assistantId: success.effect.assistantId,
      text: "done",
      traceId: "trace-success"
    });
    messages = reduceChatMessages(messages, {
      type: "complete",
      assistantId: success.effect.assistantId,
      content: "done",
      traceId: "trace-success",
      provider: "mock"
    });
    messages = reduceChatMessages(messages, {
      type: "fail",
      assistantId: failure.effect.assistantId,
      error: "failed"
    });
    messages = reduceChatMessages(messages, {
      type: "cancel",
      assistantId: cancellation.effect.assistantId,
      error: "cancelled"
    });

    expect(messages).toEqual([
      expect.objectContaining({
        id: success.effect.assistantId,
        role: "assistant",
        status: "completed"
      }),
      expect.objectContaining({
        id: failure.effect.assistantId,
        role: "assistant",
        status: "failed"
      }),
      expect.objectContaining({
        id: cancellation.effect.assistantId,
        role: "assistant",
        status: "cancelled"
      })
    ]);
  });

  it("fences stale async callbacks to the originating effect", () => {
    const execution = createProactiveTurnExecution({
      createRequestId: (() => {
        let n = 0;
        return () => `request-${++n}`;
      })(),
      createAssistantId: (() => {
        let n = 0;
        return () => `assistant-${++n}`;
      })(),
      createIdempotencyKey: (() => {
        let n = 0;
        return () => `runtime-${++n}`;
      })()
    });
    const first = execution.tryCommit({
      decisionId: "decision-old",
      admission: accepted,
      active: null,
      context
    });
    const second = execution.tryCommit({
      decisionId: "decision-new",
      admission: accepted,
      active: null,
      context
    });
    expect(first.kind).toBe("committed");
    expect(second.kind).toBe("committed");
    if (first.kind !== "committed" || second.kind !== "committed") return;

    expect(isCurrentProactiveEffect(first.effect.ownership, first.effect)).toBe(true);
    expect(isCurrentProactiveEffect(second.effect.ownership, first.effect)).toBe(false);
    expect(isCurrentProactiveEffect(null, second.effect)).toBe(false);
  });

  it("generates no speech, voice, write-memory, text, or synthetic-user authority", () => {
    const execution = createExecution();
    const result = execution.tryCommit({
      decisionId: "decision-text-only",
      admission: accepted,
      active: null,
      context
    });
    expect(result.kind).toBe("committed");
    if (result.kind !== "committed") return;

    expect(result.effect.request).toEqual({
      sessionId: context.sessionId,
      idempotencyKey: result.effect.idempotencyKey,
      modality: "text",
      options: { readMemory: true, promptPreview: false }
    });
    const messages = appendAssistant([], result.effect);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "assistant", status: "streaming", content: "" });
    expect(messages.some((message) => message.role === "user")).toBe(false);
    expect(JSON.stringify(result.effect.request)).not.toMatch(
      /writeMemory|voice|speech|tts|content/
    );
  });
});
