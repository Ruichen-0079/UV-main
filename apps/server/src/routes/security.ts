import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServerConfig } from "../config.js";

export function requireDashboardDevToken(
  config: ServerConfig,
  request: FastifyRequest,
  reply: FastifyReply
): boolean {
  if (config.runtimeMode !== "development" || !config.dashboardDevToken) {
    return true;
  }

  const provided = request.headers["x-yuvi-dev-token"];
  const token = Array.isArray(provided) ? provided[0] : provided;
  if (token === config.dashboardDevToken) {
    return true;
  }

  reply.status(401).send({
    error: "unauthorized",
    message: "A valid X-YUVI-Dev-Token header is required for this development endpoint."
  });
  return false;
}
