import { productVoiceProfiles } from "../services/packaged-voice.js";
import { retainVoiceSample, voiceReviews, updateVoiceReview } from "../services/voice-review.js";
import { isAbsolute } from "node:path";
import { correctionFromP8CorrectionRecord, parseP8CorrectionRecord } from "@companion/p8";
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
  app.post("/p8/corrections", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    try {
      const correction = correctionFromP8CorrectionRecord(parseP8CorrectionRecord(request.body));
      const result = await context.runtime.appendP8Correction(correction);
      return reply
        .code(result.status === "STORED" || result.status === "ALREADY_STORED" ? 200 : 409)
        .send(result);
    } catch {
      return reply.code(400).send({ error: "invalid_p8_correction" });
    }
  });
  app.post("/voice-profiles/:id/person", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    const parsed = z
      .object({ personId: z.string().trim().min(1).max(160) })
      .strict()
      .safeParse(request.body);
    const params = z.object({ id: z.string().min(1).max(160) }).safeParse(request.params);
    if (!parsed.success || !params.success)
      return reply.code(400).send({ error: "invalid_person_binding" });
    const profiles = productVoiceProfiles(context);
    if (!profiles) return reply.code(409).send({ error: "voice_profiles_unavailable" });
    try {
      if (!(await profiles.list()).some((profile) => profile.voiceProfileId === params.data.id))
        return reply.code(404).send({ error: "voice_profile_not_found" });
      const result = await context.runtime.bindVoiceProfileToPerson(
        params.data.id,
        parsed.data.personId
      );
      return reply.code("status" in result && result.status === "STORED" ? 200 : 409).send(result);
    } catch {
      return reply.code(503).send({ error: "person_binding_unavailable" });
    }
  });
  app.post("/capabilities/read-text/authorize", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    const parsed = z
      .object({ sessionId: z.string().min(1), path: z.string().trim().min(1).max(4096) })
      .strict()
      .safeParse(request.body);
    if (!parsed.success || !isAbsolute(parsed.data.path))
      return reply.code(400).send({ error: "invalid_read_text_authorization" });
    context.runtime.authorizeReadText(parsed.data.sessionId, parsed.data.path);
    return { status: "AUTHORIZED" };
  });
  app.get("/local-services/status", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    return localServicesStatus(context);
  });
  app.get("/voice-profiles", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    const profiles = productVoiceProfiles(context);
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
    const profiles = productVoiceProfiles(context);
    if (!profiles) return reply.code(409).send({ error: "voice_profiles_unavailable" });
    try {
      const profile = await profiles.enroll({ ...parsed.data, voiceProfileId: randomUUID() });
      try { retainVoiceSample(parsed.data.audioBase64, profile.voiceProfileId); } catch { /* Old clients may supply unsupported sample formats. */ }
      return profile;
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
    const profiles = productVoiceProfiles(context);
    if (!profiles) return reply.code(409).send({ error: "voice_profiles_unavailable" });
    try {
      return await profiles.identify(parsed.data);
    } catch {
      return reply.code(422).send({ error: "identification_failed" });
    }
  });
  app.delete<{ Params: { id: string } }>("/voice-profiles/:id", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    const profiles = productVoiceProfiles(context);
    if (!profiles) return reply.code(409).send({ error: "voice_profiles_unavailable" });
    try {
      const removed = await context.runtime.removeVoiceProfileBinding(request.params.id);
      if (removed.status !== "STORED") return reply.code(409).send({ error: "Remove the trusted binding before deleting this voice profile." });
      await profiles.delete(request.params.id);
      for (const sample of voiceReviews().filter(r => r.voiceProfileId === request.params.id)) updateVoiceReview(sample.id, null);
      return { ok: true };
    } catch {
      return reply.code(503).send({ error: "profile_delete_failed" });
    }
  });
}
