import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { redactValue } from "../services/dashboard.js";

export async function registerProviderRoutes(
  app: FastifyInstance,
  context: AppContext
): Promise<void> {
  app.get("/providers/status", async (_request, reply) => {
    try {
      return reply.send(redactValue(context.providers.getStatus()));
    } catch (error) {
      return reply.status(500).send({
        error: "provider_status_failed",
        message: error instanceof Error ? error.message : "Provider status check failed."
      });
    }
  });
}
