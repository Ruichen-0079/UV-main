import { describe, expect, it } from "vitest";
import {
  beginControlledDraftSubmit,
  reduceChatMessages,
  shouldSubmitChatKey,
  getSubmittedChatText,
  type ChatMessage
} from "./chat-state.js";

function turn(requestId = "request-1"): { user: ChatMessage; assistant: ChatMessage } {
  return {
    user: {
      id: `user-${requestId}`,
      requestId,
      role: "user",
      content: "用户第一行\n\n用户第三行",
      status: "completed"
    },
    assistant: {
      id: `assistant-${requestId}`,
      requestId,
      role: "assistant",
      content: "",
      status: "streaming"
    }
  };
}

describe("chat message state", () => {
  it("appends one assistant-only streaming entry and keeps all stream transitions on it", () => {
    const assistant = {
      id: "assistant-proactive-1",
      role: "assistant" as const,
      content: "",
      status: "streaming" as const
    };
    let messages = reduceChatMessages([], { type: "append-assistant", assistant });

    expect(messages).toEqual([assistant]);
    expect(messages.every((message) => message.role === "assistant")).toBe(true);

    messages = reduceChatMessages(messages, {
      type: "append-delta",
      assistantId: assistant.id,
      text: "第一段",
      traceId: "trace-proactive-1"
    });
    messages = reduceChatMessages(messages, {
      type: "complete",
      assistantId: assistant.id,
      content: "第一段完成",
      traceId: "trace-proactive-1",
      provider: "mock"
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: assistant.id,
      role: "assistant",
      content: "第一段完成",
      status: "completed"
    });
  });

  it("allows fail and cancel to terminate assistant-only streaming entries", () => {
    const failed = {
      id: "assistant-proactive-fail",
      role: "assistant" as const,
      content: "",
      status: "streaming" as const
    };
    const cancelled = {
      id: "assistant-proactive-cancel",
      role: "assistant" as const,
      content: "",
      status: "streaming" as const
    };
    let messages = reduceChatMessages([], { type: "append-assistant", assistant: failed });
    messages = reduceChatMessages(messages, { type: "append-assistant", assistant: cancelled });
    messages = reduceChatMessages(messages, {
      type: "fail",
      assistantId: failed.id,
      error: "stream failed"
    });
    messages = reduceChatMessages(messages, {
      type: "cancel",
      assistantId: cancelled.id,
      error: "stream cancelled"
    });

    expect(messages).toHaveLength(2);
    expect(messages).toEqual([
      expect.objectContaining({ id: failed.id, role: "assistant", status: "failed" }),
      expect.objectContaining({ id: cancelled.id, role: "assistant", status: "cancelled" })
    ]);
  });

  it("keeps multiline user content and appends multiline deltas to one assistant", () => {
    const current = turn();
    let messages = reduceChatMessages([], {
      type: "append-turn",
      ...current
    });
    messages = reduceChatMessages(messages, {
      type: "append-delta",
      assistantId: current.assistant.id,
      text: "第一行\n\n第二行🙂",
      traceId: "trace-1"
    });
    messages = reduceChatMessages(messages, {
      type: "append-delta",
      assistantId: current.assistant.id,
      text: "\n第三行",
      traceId: "trace-1"
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe("用户第一行\n\n用户第三行");
    expect(messages[1]?.content).toBe("第一行\n\n第二行🙂\n第三行");
  });

  it("keeps completed terminal when cancellation or abort failure arrives later", () => {
    const current = turn();
    let messages = reduceChatMessages([], { type: "append-turn", ...current });
    messages = reduceChatMessages(messages, {
      type: "append-delta",
      assistantId: current.assistant.id,
      text: "已完成正文",
      traceId: "trace-1"
    });
    messages = reduceChatMessages(messages, {
      type: "complete",
      assistantId: current.assistant.id,
      content: "已完成正文",
      traceId: "trace-1",
      provider: "mock"
    });
    const completed = messages;
    messages = reduceChatMessages(messages, {
      type: "cancel",
      assistantId: current.assistant.id,
      error: "生成已取消，以上内容可能不完整。"
    });
    messages = reduceChatMessages(messages, {
      type: "fail",
      assistantId: current.assistant.id,
      error: "AbortError"
    });

    expect(messages).toEqual(completed);
    expect(messages[1]).toMatchObject({ status: "completed", content: "已完成正文" });
  });

  it("keeps partial text and hides provider metadata for a cancelled turn", () => {
    const current = turn();
    let messages = reduceChatMessages([], { type: "append-turn", ...current });
    messages = reduceChatMessages(messages, {
      type: "append-delta",
      assistantId: current.assistant.id,
      text: "部分\n内容",
      traceId: "trace-1"
    });
    messages = reduceChatMessages(messages, {
      type: "cancel",
      assistantId: current.assistant.id,
      error: "生成已取消，以上内容可能不完整。"
    });
    const cancelled = messages[1];

    expect(cancelled).toMatchObject({
      status: "cancelled",
      content: "部分\n内容",
      error: "生成已取消，以上内容可能不完整。"
    });
    expect(cancelled?.provider).toBeUndefined();
    expect(
      reduceChatMessages(messages, {
        type: "complete",
        assistantId: current.assistant.id,
        content: "不应覆盖",
        traceId: "trace-1",
        provider: "mock"
      })
    ).toEqual(messages);
  });

  it("rejects late text deltas after cancellation", () => {
    const current = turn();
    let messages = reduceChatMessages([], { type: "append-turn", ...current });
    messages = reduceChatMessages(messages, {
      type: "cancel",
      assistantId: current.assistant.id,
      error: "生成已取消"
    });
    expect(
      reduceChatMessages(messages, {
        type: "append-delta",
        assistantId: current.assistant.id,
        text: "迟到的内容",
        traceId: "late-trace"
      })
    ).toEqual(messages);
  });

  it("does not let an old request update the current assistant", () => {
    const oldTurn = turn("old");
    const newTurn = turn("new");
    let messages = reduceChatMessages([], { type: "append-turn", ...oldTurn });
    messages = reduceChatMessages(messages, { type: "append-turn", ...newTurn });
    const before = messages;

    messages = reduceChatMessages(messages, {
      type: "append-delta",
      assistantId: oldTurn.assistant.id,
      text: "旧请求",
      traceId: "old-trace"
    });

    expect(messages).not.toBe(before);
    expect(messages.find((message) => message.id === newTurn.assistant.id)?.content).toBe("");
    expect(messages.find((message) => message.id === oldTurn.assistant.id)?.content).toBe("旧请求");
  });
});

describe("chat keyboard submission", () => {
  it("submits Enter, but preserves Shift+Enter and IME composition", () => {
    expect(shouldSubmitChatKey({ key: "Enter", shiftKey: false })).toBe(true);
    expect(shouldSubmitChatKey({ key: "Enter", shiftKey: true })).toBe(false);
    expect(shouldSubmitChatKey({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(shouldSubmitChatKey({ key: "Enter", shiftKey: false, keyCode: 229 })).toBe(false);
  });

  it("preserves the exact submitted payload while rejecting blank input", () => {
    const submitted = "第一行\n\n第二行  ";
    expect(getSubmittedChatText(submitted)).toBe(submitted);
    expect(getSubmittedChatText(" \n\t ")).toBeNull();
  });

  it("clears the controlled draft immediately while keeping the original payload", () => {
    const draft = "こんにちは。\n次の行";
    const first = beginControlledDraftSubmit(draft);
    expect(first).toEqual({ submittedText: draft, nextDraft: "" });
    expect(beginControlledDraftSubmit(first?.nextDraft ?? "")).toBeNull();
    expect(beginControlledDraftSubmit("   ")).toBeNull();
  });

  it("keeps Shift+Enter and IME composition from submitting while Enter submits", () => {
    expect(shouldSubmitChatKey({ key: "Enter", shiftKey: false, isComposing: false })).toBe(true);
    expect(shouldSubmitChatKey({ key: "Enter", shiftKey: true, isComposing: false })).toBe(false);
    expect(shouldSubmitChatKey({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(shouldSubmitChatKey({ key: "a", shiftKey: false })).toBe(false);
  });
});
