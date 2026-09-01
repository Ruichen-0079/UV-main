import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

/** Ingress for device observations; it cannot publish or mutate Runtime state. */
export async function registerEmbodiedPresentationRoutes(
  app: FastifyInstance,
  context: AppContext
): Promise<void> {
  app.post("/v1/embodied-presentation/outcome", async (request, reply) => {
    let resolved: boolean;
    try {
      resolved = context.embodiedPresentationBridge.resolve(request.body);
    } catch {
      return reply.code(400).send({ error: "invalid_presentation_outcome" });
    }
    if (!resolved) {
      return reply.code(409).send({ error: "stale_or_unknown_effect" });
    }
    return reply.code(204).send();
  });
}
