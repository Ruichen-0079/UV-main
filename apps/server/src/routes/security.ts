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
  const legacyToken = Array.isArray(provided) ? provided[0] : provided;
  const authorization = request.headers.authorization;
  const authorizationValue = Array.isArray(authorization) ? authorization[0] : authorization;
  const bearerToken = authorizationValue?.match(/^Bearer\s+(.+)$/iu)?.[1]?.trim();
  const token = bearerToken ?? legacyToken;
  if (token === config.dashboardDevToken) {
    return true;
  }

  reply.status(401).send({
    error: "unauthorized",
    message: "A valid Authorization: Bearer token is required for this development endpoint."
  });
  return false;
}
