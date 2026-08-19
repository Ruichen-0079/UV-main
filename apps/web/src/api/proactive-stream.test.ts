import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiClient,
  MessageStreamProtocolError,
  type MessageStreamEvent,
  type ProactiveTurnStreamRequest
} from "./client.js";

const encoder = new TextEncoder();

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function responseFromChunks(chunks: Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" }
  });
}

const request: ProactiveTurnStreamRequest = {
  sessionId: "session-1",
  idempotencyKey: "caller-key-1",
  modality: "text",
  options: { readMemory: true, promptPreview: true }
};

const textDelta = {
  type: "text-delta" as const,
  text: "你好",
  messageId: "message-1",
  sessionId: "session-1",
  traceId: "trace-1"
};

const completed = {
  type: "completed" as const,
  content: "你好",
  messageId: "message-1",
  sessionId: "session-1",
  traceId: "trace-1",
  provider: "mock"
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("apiClient.streamProactiveTurn", () => {
  it("posts only the frozen text request body and emits the existing stream events", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        responseFromChunks([
          encoder.encode(frame("text-delta", textDelta)),
          encoder.encode(frame("completed", completed))
        ])
      );
    vi.stubGlobal("fetch", fetchMock);
    const events: MessageStreamEvent[] = [];

    await expect(
      apiClient.streamProactiveTurn(request, { onEvent: (event) => events.push(event) })
    ).resolves.toEqual(completed);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/v1/proactive-turns/stream");
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(requestInit.body))).toEqual({
      sessionId: "session-1",
      idempotencyKey: "caller-key-1",
      modality: "text",
      options: { readMemory: true, promptPreview: true }
    });
    expect(events.map((event) => event.type)).toEqual(["text-delta", "completed"]);
  });

  it("validates completed content against accumulated deltas", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          responseFromChunks([
            encoder.encode(
              frame("text-delta", textDelta) + frame("completed", { ...completed, content: "不同" })
            )
          ])
        )
    );

    await expect(apiClient.streamProactiveTurn(request)).rejects.toBeInstanceOf(
      MessageStreamProtocolError
    );
  });

  it("surfaces a pre-SSE idempotency conflict without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "idempotency_conflict",
          message: "The assistant turn idempotency key has already been used."
        }),
        { status: 409, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiClient.streamProactiveTurn(request)).rejects.toMatchObject({
      name: "ApiError",
      status: 409
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes the caller AbortSignal to the one request", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      apiClient.streamProactiveTurn(request, { signal: controller.signal })
    ).rejects.toMatchObject({
      name: "AbortError"
    });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
  });
});
