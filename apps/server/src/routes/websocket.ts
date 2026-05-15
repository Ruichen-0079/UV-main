import {
  RuntimeEventSchema,
  UserMessageEventSchema,
  createEvent,
  type RuntimeEvent
} from "@companion/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { redactValue } from "../services/dashboard.js";

const WebSocketQuerySchema = z.object({
  dashboard: z.coerce.boolean().optional().default(false)
});

export async function registerWebSocketRoutes(
  app: FastifyInstance,
  context: AppContext
): Promise<void> {
  app.get("/ws", { websocket: true }, (socket, request) => {
    const query = WebSocketQuerySchema.safeParse(request.query);
    const dashboardMode = query.success ? query.data.dashboard : false;
    const activeTraceIds = new Set<string>();
    const subscription = context.eventBus.subscribe("*", (event) => {
      if (dashboardMode) {
        sendJson(socket, redactRuntimeEvent(event));
        return;
      }

      if (activeTraceIds.has(event.traceId) && shouldForwardEvent(event)) {
        sendJson(socket, redactRuntimeEvent(event));
      }
    });

    if (dashboardMode) {
      sendJson(socket, {
        kind: "dashboard.connected",
        traceId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        payload: {
          message:
            "Dashboard WebSocket connected. Recent event replay is available through GET /events/recent."
        }
      });
    }

    socket.on("message", async (rawMessage: Buffer) => {
      let envelope: RuntimeEvent | undefined;
      try {
        const parsedEnvelope = RuntimeEventSchema.parse(
          JSON.parse(rawMessage.toString())
        ) as RuntimeEvent;
        envelope = parsedEnvelope;
        activeTraceIds.add(parsedEnvelope.traceId);

        if (parsedEnvelope.type !== "user.message") {
          sendJson(
            socket,
            redactRuntimeEvent(
              createEvent(
                "runtime.error",
                {
                  message: `Unsupported WebSocket event type '${parsedEnvelope.type}'.`
                },
                {
                  traceId: parsedEnvelope.traceId,
                  parentId: parsedEnvelope.id
                }
              )
            )
          );
          return;
        }

        const parsed = UserMessageEventSchema.parse(parsedEnvelope);
        activeTraceIds.add(parsed.traceId);
        app.log.info(
          { traceId: parsed.traceId, sessionId: parsed.payload.sessionId },
          "websocket user.message received"
        );
        await context.runtime.handleUserMessage(parsed);
      } catch (error) {
        sendJson(
          socket,
          redactRuntimeEvent(
            createEvent(
              "runtime.error",
              {
                message: error instanceof Error ? error.message : "Invalid WebSocket event"
              },
              {
                traceId: envelope?.traceId,
                parentId: envelope?.id
              }
            )
          )
        );
      }
    });

    socket.on("close", () => {
      subscription.unsubscribe();
      activeTraceIds.clear();
    });
  });

  app.get("/v1/events", { websocket: true }, (socket) => {
    socket.close(1000, "Use /ws");
  });
}

function shouldForwardEvent(event: RuntimeEvent): boolean {
  return (
    event.type === "agent.reply" ||
    event.type === "avatar.speak" ||
    event.type === "tts.started" ||
    event.type === "vision.completed" ||
    event.type === "perception.vision" ||
    event.type === "provider.error" ||
    event.type === "runtime.error"
  );
}

function redactRuntimeEvent(event: RuntimeEvent): RuntimeEvent {
  return {
    ...event,
    payload: redactValue(event.payload)
  };
}

function sendJson(
  socket: { readyState: number; OPEN: number; send(data: string): void },
  payload: unknown
): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}
