import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

const allowedMarkdownElements = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul"
] as const;

export function safeMarkdownUrl(value: string): string {
  const url = value.trim();
  if (!url || url.startsWith("//")) {
    return "";
  }

  const protocol = /^[a-z][a-z\d+.-]*:/iu.exec(url)?.[0]?.toLowerCase();
  if (!protocol) {
    return url;
  }

  return protocol === "http:" ||
    protocol === "https:" ||
    protocol === "mailto:" ||
    protocol === "tel:"
    ? url
    : "";
}

const markdownComponents: Components = {
  h1: ({ children }) => (
    <h3 className="mb-2 mt-3 text-base font-semibold first:mt-0">{children}</h3>
  ),
  h2: ({ children }) => (
    <h3 className="mb-2 mt-3 text-base font-semibold first:mt-0">{children}</h3>
  ),
  h3: ({ children }) => <h4 className="mb-2 mt-3 text-sm font-semibold first:mt-0">{children}</h4>,
  h4: ({ children }) => <h4 className="mb-2 mt-3 text-sm font-semibold first:mt-0">{children}</h4>,
  h5: ({ children }) => <h5 className="mb-2 mt-3 text-sm font-semibold first:mt-0">{children}</h5>,
  h6: ({ children }) => <h6 className="mb-2 mt-3 text-sm font-semibold first:mt-0">{children}</h6>,
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-2 ml-5 list-disc space-y-1 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 ml-5 list-decimal space-y-1 last:mb-0">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-cyan-200 pl-3 text-ink-600">
      {children}
    </blockquote>
  ),
  code: ({ children, className }) => (
    <code className={`${className ?? ""} rounded bg-ink-100 px-1 py-0.5 font-mono text-[0.9em]`}>
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="my-2 max-w-full overflow-x-auto rounded-md bg-ink-900 p-3 font-mono text-xs leading-5 text-ink-50 [overflow-wrap:normal]">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-2 max-w-full overflow-x-auto">
      <table className="min-w-full border-collapse text-left text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-ink-200 bg-ink-100 px-2 py-1 font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="border border-ink-200 px-2 py-1 align-top">{children}</td>,
  a: ({ children, href }) => {
    const safeHref = typeof href === "string" ? safeMarkdownUrl(href) : "";
    if (!safeHref) {
      return <span>{children}</span>;
    }

    const external = /^https?:\/\//iu.test(safeHref);
    return (
      <a
        href={safeHref}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        className="break-all text-cyan-700 underline underline-offset-2"
      >
        {children}
      </a>
    );
  }
};

export function AssistantMarkdown(props: { content: string }): JSX.Element {
  return (
    <div className="assistant-markdown max-w-full text-sm leading-6 [overflow-wrap:anywhere]">
      <ReactMarkdown
        allowedElements={allowedMarkdownElements}
        components={markdownComponents}
        remarkPlugins={[remarkGfm, remarkBreaks]}
        skipHtml
        urlTransform={safeMarkdownUrl}
      >
        {props.content}
      </ReactMarkdown>
    </div>
  );
}

export function ChatMessageContent(props: {
  role: "user" | "assistant";
  content: string;
}): JSX.Element {
  return props.role === "assistant" ? (
    <AssistantMarkdown content={props.content} />
  ) : (
    <div className="text-sm leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]">
      {props.content}
    </div>
  );
}

export const assistantMarkdownPolicy: {
  readonly allowedElements: readonly string[];
  readonly skipHtml: true;
} = {
  allowedElements: allowedMarkdownElements,
  skipHtml: true
};
