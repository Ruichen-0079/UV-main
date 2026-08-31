import { describe, expect, it } from "vitest";
import {
  createServerMcpClient,
  type ServerMcpTransport
} from "./mcp-client.js";

type InjectedClient = NonNullable<Parameters<typeof createServerMcpClient>[0]>;

function injectedClient(value: unknown): InjectedClient {
  return value as InjectedClient;
}

describe("server MCP client adapter", () => {
  it("projects tool discovery without MCP response metadata and forwards cancellation", async () => {
    const controller = new AbortController();
    let receivedOptions: unknown;

    const client = injectedClient({
      connect: async () => undefined,
      listTools: async (_params: unknown, options: unknown) => {
        receivedOptions = options;
        return {
          _meta: { server: "hidden" },
          tools: [
            {
              name: "read_repo",
              description: "Read repository evidence.",
              inputSchema: { type: "object", properties: { path: { type: "string" } } },
              _meta: { server: "hidden" }
            }
          ]
        };
      },
      callTool: async () => ({ content: [] }),
      close: async () => undefined
    });

    const adapter = createServerMcpClient(client);
    const tools = await adapter.listTools({ signal: controller.signal });

    expect(receivedOptions).toEqual({ signal: controller.signal });
    expect(tools).toEqual([
      {
        name: "read_repo",
        description: "Read repository evidence.",
        inputSchema: { type: "object", properties: { path: { type: "string" } } }
      }
    ]);
    expect(Object.isFrozen(tools)).toBe(true);
    expect(Object.isFrozen(tools[0])).toBe(true);
    expect(tools[0]).not.toHaveProperty("_meta");
  });

  it("delegates one tool call, strips protocol metadata, and preserves structured content", async () => {
    const controller = new AbortController();
    const argumentsObject = { path: "README.md" };
    let receivedParams: unknown;
    let receivedOptions: unknown;

    const client = injectedClient({
      connect: async () => undefined,
      listTools: async () => ({ tools: [] }),
      callTool: async (params: unknown, options: unknown) => {
        receivedParams = params;
        receivedOptions = options;
        return {
          _meta: { server: "hidden" },
          isError: false,
          content: [
            {
              type: "text",
              text: "repository evidence",
              _meta: { trace: "hidden" }
            }
          ],
          structuredContent: { count: 1 }
        };
      },
      close: async () => undefined
    });

    const adapter = createServerMcpClient(client);
    const result = await adapter.callTool(
      { name: "read_repo", arguments: argumentsObject },
      { signal: controller.signal }
    );

    expect(receivedParams).toEqual({ name: "read_repo", arguments: { path: "README.md" } });
    expect((receivedParams as { arguments: unknown }).arguments).not.toBe(argumentsObject);
    expect(receivedOptions).toEqual({ signal: controller.signal });
    expect(result).toEqual({
      isError: false,
      content: [{ type: "text", text: "repository evidence" }],
      structuredContent: { count: 1 }
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.content)).toBe(true);
    expect(Object.isFrozen(result.content[0])).toBe(true);
  });

  it("delegates connect and close without retaining transport ownership outside the SDK", async () => {
    let connectedTransport: unknown;
    let closeCount = 0;
    const transport = {} as ServerMcpTransport;

    const client = injectedClient({
      connect: async (input: unknown) => {
        connectedTransport = input;
      },
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => {
        closeCount += 1;
      }
    });

    const adapter = createServerMcpClient(client);
    await adapter.connect(transport);
    await adapter.close();

    expect(connectedTransport).toBe(transport);
    expect(closeCount).toBe(1);
  });

  it("does not retry a failed MCP call", async () => {
    let callCount = 0;
    const client = injectedClient({
      connect: async () => undefined,
      listTools: async () => ({ tools: [] }),
      callTool: async () => {
        callCount += 1;
        throw new Error("mcp call failed");
      },
      close: async () => undefined
    });

    const adapter = createServerMcpClient(client);

    await expect(adapter.callTool({ name: "read_repo" })).rejects.toThrow("mcp call failed");
    expect(callCount).toBe(1);
  });
});
