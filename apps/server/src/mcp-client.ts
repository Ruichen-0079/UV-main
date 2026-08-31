import { Client } from "@modelcontextprotocol/client";

export type ServerMcpTransport = Parameters<Client["connect"]>[0];

export type ServerMcpTool = Readonly<{
  name: string;
  description?: string | undefined;
  inputSchema: unknown;
}>;

export type ServerMcpToolCall = Readonly<{
  name: string;
  arguments?: Readonly<Record<string, unknown>> | undefined;
}>;

export type ServerMcpToolResult = Readonly<{
  isError: boolean;
  content: readonly unknown[];
  structuredContent?: unknown;
}>;

export type ServerMcpClient = Readonly<{
  connect(transport: ServerMcpTransport): Promise<void>;
  listTools(options?: { signal?: AbortSignal | undefined }): Promise<readonly ServerMcpTool[]>;
  callTool(
    input: ServerMcpToolCall,
    options?: { signal?: AbortSignal | undefined }
  ): Promise<ServerMcpToolResult>;
  close(): Promise<void>;
}>;

type McpSdkClientPort = Pick<Client, "connect" | "listTools" | "callTool" | "close">;

/**
 * Thin infrastructure adapter around the official MCP TypeScript client.
 *
 * The default client disables the SDK's automatic input_required fulfilment so
 * a single Runtime-admitted capability invocation cannot become a hidden
 * multi-round loop. Runtime owns admission, cancellation, and hard containment;
 * this adapter only speaks MCP and strips protocol metadata before returning.
 */
export function createServerMcpClient(client: McpSdkClientPort = createOfficialClient()): ServerMcpClient {
  return Object.freeze({
    async connect(transport: ServerMcpTransport): Promise<void> {
      await client.connect(transport);
    },

    async listTools(options: { signal?: AbortSignal | undefined } = {}): Promise<readonly ServerMcpTool[]> {
      const result = await client.listTools(
        undefined,
        options.signal === undefined ? undefined : { signal: options.signal }
      );
      const tools = result.tools.map((tool) =>
        Object.freeze({
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          inputSchema: tool.inputSchema
        })
      );
      return Object.freeze(tools);
    },

    async callTool(
      input: ServerMcpToolCall,
      options: { signal?: AbortSignal | undefined } = {}
    ): Promise<ServerMcpToolResult> {
      const result = await client.callTool(
        {
          name: input.name,
          ...(input.arguments === undefined ? {} : { arguments: { ...input.arguments } })
        },
        options.signal === undefined ? undefined : { signal: options.signal }
      );
      const content = Object.freeze(Array.from(result.content, stripProtocolMeta));

      return Object.freeze({
        isError: result.isError === true,
        content,
        ...(result.structuredContent === undefined
          ? {}
          : { structuredContent: result.structuredContent })
      });
    },

    async close(): Promise<void> {
      await client.close();
    }
  });
}

function createOfficialClient(): Client {
  return new Client(
    {
      name: "yuvi-runtime",
      version: "0.1.0"
    },
    {
      inputRequired: {
        autoFulfill: false
      }
    }
  );
}

function stripProtocolMeta(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return input;
  }

  const copy = { ...(input as Record<string, unknown>) };
  delete copy["_meta"];
  return Object.freeze(copy);
}
