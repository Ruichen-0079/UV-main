import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  LocalAiServiceManager,
  isLocalAiServiceId,
  loadLocalAiManagerConfig,
  type LocalAiServiceId
} from "@companion/desktop-supervisor";
import type { ServerConfig } from "../config.js";
import { requireLocalDashboardAccess } from "./security.js";

const SpeakerEnrollSchema = z
  .object({
    speakerId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/),
    label: z.string().min(1).max(80),
    audioBase64: z.string().min(8),
    mimeType: z.string().min(1).max(64).optional()
  })
  .strict();

const AudioSchema = z
  .object({
    audioBase64: z.string().min(8),
    mimeType: z.string().min(1).max(64).optional(),
    language: z.string().min(1).max(16).optional(),
    diarize: z.boolean().optional(),
    identify: z.boolean().optional()
  })
  .strict();

let managerSingleton: LocalAiServiceManager | null = null;

export function getLocalAiServiceManager(): LocalAiServiceManager {
  if (managerSingleton) return managerSingleton;
  const repositoryRoot = findRepositoryRoot();
  const stateDirectory =
    process.env["YUVI_LOCAL_AI_STATE_DIR"]?.trim() ||
    path.join(os.homedir(), ".local", "share", "yuvi", "local-ai-supervisor");
  fs.mkdirSync(stateDirectory, { recursive: true });
  const identity = persistIdentity(stateDirectory);
  managerSingleton = new LocalAiServiceManager(
    loadLocalAiManagerConfig({
      repositoryRoot,
      stateDirectory,
      instanceId: identity.instanceId,
      ownershipToken: identity.ownershipToken,
      env: envRecord(),
      ttsWrapperUrl: process.env["GPT_SOVITS_TTS_BASE_URL"] ?? "http://127.0.0.1:9881",
      ttsUpstreamUrl: process.env["GPT_SOVITS_TTS_UPSTREAM_URL"] ?? "http://127.0.0.1:9880"
    })
  );
  return managerSingleton;
}

export async function registerProductLocalServiceRoutes(
  app: FastifyInstance,
  config: ServerConfig
): Promise<void> {
  app.get("/product/local-services", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return reply;
    const manager = getLocalAiServiceManager();
    return reply.send(await manager.refreshAll());
  });

  app.post("/product/local-services/:id/start", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return reply;
    const id = parseId(request.params);
    if (!id) return reply.status(404).send({ error: "unknown_service" });
    const result = await getLocalAiServiceManager().start(id);
    return reply.status(result.ok ? 200 : 409).send(result);
  });

  app.post("/product/local-services/:id/stop", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return reply;
    const id = parseId(request.params);
    if (!id) return reply.status(404).send({ error: "unknown_service" });
    const result = await getLocalAiServiceManager().stop(id);
    return reply.status(result.ok ? 200 : 409).send(result);
  });

  app.post("/product/local-services/:id/restart", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return reply;
    const id = parseId(request.params);
    if (!id) return reply.status(404).send({ error: "unknown_service" });
    const result = await getLocalAiServiceManager().restart(id);
    return reply.status(result.ok ? 200 : 409).send(result);
  });

  app.post("/product/local-services/:id/test", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return reply;
    const id = parseId(request.params);
    if (!id) return reply.status(404).send({ error: "unknown_service" });
    const result = await getLocalAiServiceManager().test(id);
    return reply.status(result.ok ? 200 : 503).send(result);
  });

  app.get("/product/local-services/stt/speakers", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return reply;
    const speakers = await getLocalAiServiceManager().listSpeakers();
    return reply.send({ speakers });
  });

  app.post("/product/local-services/stt/speakers", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return reply;
    const parsed = SpeakerEnrollSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    try {
      const speaker = await getLocalAiServiceManager().enrollSpeaker(parsed.data);
      return reply.send({ ok: true, speaker });
    } catch (error) {
      return reply.status(503).send({
        error: "enroll_failed",
        message: error instanceof Error ? error.message : "enroll failed"
      });
    }
  });

  app.delete("/product/local-services/stt/speakers/:speakerId", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return reply;
    const params = request.params as { speakerId?: string };
    const speakerId = params.speakerId?.trim();
    if (!speakerId) return reply.status(400).send({ error: "invalid_request" });
    await getLocalAiServiceManager().deleteSpeaker(speakerId);
    return reply.send({ ok: true, speakerId });
  });

  app.post("/product/local-services/stt/identify", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return reply;
    const parsed = AudioSchema.pick({ audioBase64: true, mimeType: true }).safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    try {
      const result = await getLocalAiServiceManager().identifySpeaker(parsed.data);
      return reply.send(result);
    } catch (error) {
      return reply.status(503).send({
        error: "identify_failed",
        message: error instanceof Error ? error.message : "identify failed"
      });
    }
  });

  app.post("/product/local-services/stt/transcribe", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return reply;
    const parsed = AudioSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    try {
      const result = await getLocalAiServiceManager().transcribe(parsed.data);
      return reply.send(result);
    } catch (error) {
      return reply.status(503).send({
        error: "transcribe_failed",
        message: error instanceof Error ? error.message : "transcribe failed"
      });
    }
  });
}

function parseId(params: unknown): LocalAiServiceId | null {
  const id = (params as { id?: string }).id;
  if (!id || !isLocalAiServiceId(id)) return null;
  return id;
}

function envRecord(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function persistIdentity(stateDirectory: string): { instanceId: string; ownershipToken: string } {
  const file = path.join(stateDirectory, "identity.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      instanceId?: unknown;
      ownershipToken?: unknown;
    };
    if (typeof raw.instanceId === "string" && typeof raw.ownershipToken === "string") {
      return { instanceId: raw.instanceId, ownershipToken: raw.ownershipToken };
    }
  } catch {
    // create
  }
  const created = { instanceId: randomUUID(), ownershipToken: randomUUID() };
  fs.writeFileSync(file, `${JSON.stringify(created, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return created;
}

function findRepositoryRoot(): string {
  let current = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}
