import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerConfig } from "../config.js";
import type { AppContext } from "../context.js";
import { localServicesStatus } from "../services/local-services.js";
import { requireLocalDashboardAccess } from "./security.js";

const audio = z.object({
  audioBase64: z.string().min(1).max(24_000_000),
  mimeType: z.literal("audio/wav")
});

export async function registerLocalServiceRoutes(
  app: FastifyInstance,
  context: AppContext,
  config: ServerConfig
) {
  app.get("/local-services/status", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    return localServicesStatus(context);
  });
  app.get("/voice-profiles", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    const profiles = context.providers.getSTTProvider().voiceProfiles;
    if (!profiles) return reply.code(409).send({ error: "voice_profiles_unavailable" });
    try {
      return { profiles: await profiles.list() };
    } catch {
      return reply.code(503).send({ error: "voice_profiles_unavailable" });
    }
  });
  app.post("/voice-profiles", { bodyLimit: 24_001_024 }, async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    const parsed = audio
      .extend({ label: z.string().trim().min(1).max(100) })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_recording" });
    const profiles = context.providers.getSTTProvider().voiceProfiles;
    if (!profiles) return reply.code(409).send({ error: "voice_profiles_unavailable" });
    try {
      return await profiles.enroll({ ...parsed.data, voiceProfileId: randomUUID() });
    } catch {
      return reply
        .code(422)
        .send({ error: "enrollment_failed", message: "Use a clear recording of one speaker." });
    }
  });
  app.post("/voice-profiles/identify", { bodyLimit: 24_001_024 }, async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    const parsed = audio.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_recording" });
    const profiles = context.providers.getSTTProvider().voiceProfiles;
    if (!profiles) return reply.code(409).send({ error: "voice_profiles_unavailable" });
    try {
      return await profiles.identify(parsed.data);
    } catch {
      return reply.code(422).send({ error: "identification_failed" });
    }
  });
  app.delete<{ Params: { id: string } }>("/voice-profiles/:id", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    const profiles = context.providers.getSTTProvider().voiceProfiles;
    if (!profiles) return reply.code(409).send({ error: "voice_profiles_unavailable" });
    try {
      await profiles.delete(request.params.id);
      return { ok: true };
    } catch {
      return reply.code(503).send({ error: "profile_delete_failed" });
    }
  });
}
