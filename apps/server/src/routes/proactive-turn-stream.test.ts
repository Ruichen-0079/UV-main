import Fastify from "fastify";
import { AssistantTurnConflictError, type RuntimeReplyStreamEvent } from "@companion/core";
import type { AppContext } from "../context.js";
import { describe, expect, it } from "vitest";
import { registerProactiveTurnStreamRoutes } from "./proactive-turn-stream.js";

function runtimeFor(
  streamAssistantInitiatedTurn: AppContext["runtime"]["streamAssistantInitiatedTurn"]
): AppContext {
  return { runtime: { streamAssistantInitiatedTurn } } as unknown as AppContext;
}

async function createTestApp(context: AppContext) {
  const app = Fastify({ logger: false });
  await registerProactiveTurnStreamRoutes(app, context);
  return app;
}

describe("proactive turn SSE route", () => {
  it("accepts only the strict assistant-origin DTO and streams existing SSE events", async () => {
    let receivedInput: unknown;
    const app = await createTestApp(
      runtimeFor(async function* (input): AsyncIterable<RuntimeReplyStreamEvent> {
        receivedInput = input;
        yield {
          type: "proactive-decision",
          decision: "REQUEST_TEXT",
          sessionId: "session-1",
          traceId: "trace-1"
        };
        yield {
          type: "text-delta",
          text: "hello",
          messageId: "assistant-1",
          sessionId: "session-1",
          traceId: "trace-1"
        };
        yield {
          type: "completed",
          messageId: "assistant-1",
          sessionId: "session-1",
          traceId: "trace-1",
          content: "hello",
          provider: "mock"
        };
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/proactive-turns/stream",
      payload: {
        sessionId: "session-1",
        idempotencyKey: "decision-1",
        modality: "text",
        options: { readMemory: false, promptPreview: true }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: proactive-decision");
    expect(response.body).toContain("event: text-delta");
    expect(response.body).toContain("event: completed");
    expect(receivedInput).toEqual({
      sessionId: "session-1",
      idempotencyKey: "decision-1",
      readMemory: false
    });
    await app.close();
  });

  it("ends a successful NO_OP stream without a completed assistant event", async () => {
    const app = await createTestApp(
      runtimeFor(async function* (): AsyncIterable<RuntimeReplyStreamEvent> {
        yield {
          type: "proactive-decision",
          decision: "NO_OP",
          sessionId: "session-no-op",
          traceId: "trace-no-op"
        };
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/proactive-turns/stream",
      payload: {
        sessionId: "session-no-op",
        idempotencyKey: "decision-no-op",
        modality: "text",
        options: { readMemory: false }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: proactive-decision");
    expect(response.body).not.toContain("event: completed");
    expect(response.body).not.toContain("event: error");
    await app.close();
  });

  it("maps an invalid Runtime proactive sequence through the SSE error path", async () => {
    const app = await createTestApp(
      runtimeFor(async function* (): AsyncIterable<RuntimeReplyStreamEvent> {
        yield {
          type: "text-delta",
          text: "unexpected",
          messageId: "assistant-invalid",
          sessionId: "session-invalid",
          traceId: "trace-invalid"
        };
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/proactive-turns/stream",
      payload: {
        sessionId: "session-invalid",
        idempotencyKey: "decision-invalid-sequence",
        modality: "text",
        options: { readMemory: false }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: error");
    expect(response.body).toContain('"code":"INTERNAL"');
    await app.close();
  });

  it.each([{ text: "hidden" }, { writeMemory: true }, { modality: "speech" }, { unknown: true }])(
    "rejects malformed or out-of-contract fields: %o",
    async (extra) => {
      let calls = 0;
      const app = await createTestApp(
        runtimeFor(async function* (): AsyncIterable<RuntimeReplyStreamEvent> {
          calls += 1;
          yield {
            type: "completed",
            messageId: "assistant-1",
            sessionId: "session-1",
            traceId: "trace-1",
            content: "should not run",
            provider: "mock"
          };
        })
      );

      const response = await app.inject({
        method: "POST",
        url: "/v1/proactive-turns/stream",
        payload: {
          sessionId: "session-1",
          idempotencyKey: "decision-invalid",
          modality: "text",
          options: { readMemory: false },
          ...extra
        }
      });

      expect(response.statusCode).toBe(400);
      expect(calls).toBe(0);
      await app.close();
    }
  );

  it("maps a duplicate Runtime claim to a pre-stream conflict", async () => {
    const app = await createTestApp(
      runtimeFor(async function* (): AsyncIterable<RuntimeReplyStreamEvent> {
        throw new AssistantTurnConflictError("decision-duplicate");
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/proactive-turns/stream",
      payload: {
        sessionId: "session-1",
        idempotencyKey: "decision-duplicate",
        modality: "text",
        options: { readMemory: false }
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "idempotency_conflict" });
    expect(response.headers["content-type"]).not.toContain("text/event-stream");
    await app.close();
  });

  it("rejects writeMemory even when nested under the strict options object", async () => {
    let calls = 0;
    const app = await createTestApp(
      runtimeFor(async function* (): AsyncIterable<RuntimeReplyStreamEvent> {
        calls += 1;
        yield {
          type: "completed",
          messageId: "assistant-1",
          sessionId: "session-1",
          traceId: "trace-1",
          content: "should not run",
          provider: "mock"
        };
      })
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/proactive-turns/stream",
      payload: {
        sessionId: "session-1",
        idempotencyKey: "decision-write",
        modality: "text",
        options: { readMemory: false, writeMemory: true }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(calls).toBe(0);
    await app.close();
  });
});
