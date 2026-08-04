import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AssistantMarkdown,
  ChatMessageContent,
  assistantMarkdownPolicy,
  safeMarkdownUrl
} from "./markdown-message.js";

describe("assistant Markdown rendering", () => {
  it("renders the supported Markdown and keeps ordinary line breaks", () => {
    const markup = renderToStaticMarkup(
      <AssistantMarkdown
        content={[
          "# 标题",
          "",
          "第一行",
          "第二行",
          "",
          "**粗体** *斜体* `inline` ~~删除~~",
          "",
          "- 一项",
          "- 二项",
          "",
          "> 引用",
          "",
          "```ts",
          "const value = 1;",
          "```",
          "",
          "| A | B |",
          "|---|---|",
          "| 1 | 2 |"
        ].join("\n")}
      />
    );

    expect(markup).toContain("<h3");
    expect(markup).toContain("<strong>粗体</strong>");
    expect(markup).toContain("<em>斜体</em>");
    expect(markup).toContain("<code");
    expect(markup).toContain("<del>删除</del>");
    expect(markup).toContain("<ul");
    expect(markup).toContain("<blockquote");
    expect(markup).toContain("const value = 1;");
    expect(markup).toContain("<table");
    expect(markup).toContain("第一行<br/>");
    expect(markup).toContain("第二行");
  });

  it("keeps user messages as escaped plain text instead of Markdown", () => {
    const markup = renderToStaticMarkup(
      <ChatMessageContent role="user" content="**不要渲染**\n第二行" />
    );

    expect(markup).toContain("**不要渲染**");
    expect(markup).not.toContain("<strong>");
    expect(markup).toContain("第二行");
    expect(markup).toContain("whitespace-pre-wrap");
  });

  it("does not render raw HTML, scripts, event attributes, or unsafe URLs", () => {
    const markup = renderToStaticMarkup(
      <AssistantMarkdown
        content={
          '<script>alert("x")</script> <img src="x" onerror="alert(1)" />\n\n[危险](javascript:alert(1))\n\n[安全](https://example.com)'
        }
      />
    );

    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("onerror");
    expect(markup).not.toContain("javascript:");
    expect(markup).toContain('href="https://example.com"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain('target="_blank"');
  });

  it("handles incomplete streaming Markdown without mutating source text", () => {
    const source = "部分 **未闭合\n- 列表项\n```ts\nconst value = 1;";
    expect(() => renderToStaticMarkup(<AssistantMarkdown content={source} />)).not.toThrow();
    expect(source).toBe("部分 **未闭合\n- 列表项\n```ts\nconst value = 1;");
  });

  it("allows only safe protocols and keeps the rendering policy explicit", () => {
    expect(safeMarkdownUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(safeMarkdownUrl("mailto:test@example.com")).toBe("mailto:test@example.com");
    expect(safeMarkdownUrl("/relative/path")).toBe("/relative/path");
    expect(safeMarkdownUrl("javascript:alert(1)")).toBe("");
    expect(safeMarkdownUrl("data:text/html,alert(1)")).toBe("");
    expect(safeMarkdownUrl("//evil.example/path")).toBe("");
    expect(assistantMarkdownPolicy.skipHtml).toBe(true);
    expect(assistantMarkdownPolicy.allowedElements).not.toContain("script");
  });
});
