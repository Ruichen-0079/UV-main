import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SubtitlePage } from "./subtitle-page.js";
import {
  isSubtitleProjectionMessage,
  publishSubtitleProjection,
  subscribeSubtitleProjection
} from "./subtitle-bus.js";
import { reduceChatMessages } from "./chat-state.js";
import {
  paginateSubtitleText,
  projectCommittedAssistantText
} from "./subtitle-projection.js";

describe("SubtitlePage", () => {
  it("renders the subtitle surface shell without chat or Memory chrome", () => {
    const markup = renderToStaticMarkup(<SubtitlePage />);
    expect(markup).toContain('data-testid="subtitle-surface"');
    expect(markup).not.toContain("textarea");
    expect(markup).not.toContain("Memory");
  });

  it("publishes committed text on the presentation bus only", async () => {
    const seen: unknown[] = [];
    const unsubscribe = subscribeSubtitleProjection((message) => {
      seen.push(message);
    });
    publishSubtitleProjection({
      kind: "committed-assistant-text",
      messageId: "a1",
      text: "Committed overlay line."
    });
    await vi.waitFor(() => {
      expect(seen).toEqual([
        {
          kind: "committed-assistant-text",
          messageId: "a1",
          text: "Committed overlay line."
        }
      ]);
    });
    unsubscribe();
    expect(isSubtitleProjectionMessage(seen[0])).toBe(true);
  });

  it("does not mutate committed chat messages when presentation clears", () => {
    const messages = reduceChatMessages([], {
      type: "append-assistant",
      assistant: {
        id: "a1",
        role: "assistant",
        content: "hello",
        status: "streaming"
      }
    });
    const completed = reduceChatMessages(messages, {
      type: "complete",
      assistantId: "a1",
      content: "hello committed",
      traceId: "t1",
      provider: "test"
    });
    publishSubtitleProjection({ kind: "clear" });
    expect(completed[0]?.content).toBe("hello committed");
    expect(completed[0]?.status).toBe("completed");
  });

  it("keeps long-text pagination presentation-only", () => {
    const source =
      "第一句内容。第二句内容继续。第三句内容更长一些用于分页验证。Fourth English sentence remains intact.";
    const projected = projectCommittedAssistantText(source);
    expect(projected).toBe(source);
    const pages = paginateSubtitleText(projected!, 40);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join("")).toBe(source);
  });

  it("renders admitted assistant text unchanged regardless of its language", () => {
    const source = "中文 final text。これは日本語の文です。";

    expect(projectCommittedAssistantText(source)).toBe(source);
  });
});
