import { persistProfileEvidence } from "../services/profile-evidence.js";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CAPABILITY_ROUTES, parseProductConfiguration, modelEndpoint, createProviderRegistryFromEnv } from "@companion/providers";
import type { AppContext } from "../context.js";
import type { ServerConfig } from "../config.js";
import { requireLocalDashboardAccess } from "./security.js";
import { importLegacyConfiguration, embeddingSignature, productEnvironment, productPath, readProductSettings, writePrivateJson, type ProductSettings } from "../services/product-store.js";

export async function registerProductRoutes(app: FastifyInstance, context: AppContext, config: ServerConfig) {
  let queue = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => { const next = queue.then(fn); queue = next.then(() => {}, () => {}); return next; };
  let applyFailure = false;
  const desired = () => readProductSettings() ?? importLegacyConfiguration(context.activeRuntimeEnv);
  function snapshot() {
    const saved = desired();
    const activeJson = context.activeRuntimeEnv["YUVI_PRODUCT_CONFIGURATION"];
    const active = activeJson ? parseProductConfiguration(JSON.parse(activeJson)) : importLegacyConfiguration(context.activeRuntimeEnv).configuration;
    const pending = JSON.stringify(saved.configuration) !== activeJson && (saved.revision > 0);
    const status = context.providers.getStatus();
    const routes = Object.fromEntries(CAPABILITY_ROUTES.map(cap => {
      const ids = active?.routes[cap] ?? [];
      const entries = cap === "proactive" ? ids.map(id => ({ provider: id, configured: true, observed: context.providers.getProactiveRouteObservations()[id] ?? "unknown" })) : status.routes?.[cap] ?? [];
      const available = entries.findIndex(e => e.configured && e.observed !== "unavailable" && e.observed !== "degraded");
      const state = pending ? (applyFailure ? "APPLY_FAILED" : "RESTART_REQUIRED") : !ids.length ? "NOT_CONFIGURED" : available < 0 ? "UNAVAILABLE" : available > 0 ? "FALLBACK_ACTIVE" : "ACTIVE";
      return [cap, { state, modelIds: ids, observed: entries.map(e => ({ modelId: e.provider, observed: e.observed })) }];
    }));
    return { ...saved, configuration: { ...saved.configuration, providers: saved.configuration.providers.map(({ apiKey, ...p }) => ({ ...p, hasApiKey: Boolean(apiKey) })) }, routes, conversationalReady: Boolean(status.routes?.chat?.some(e => e.configured && e.observed !== "unavailable")), adopted: Boolean(active), proactiveState: context.runtime.getProactiveState(), voiceAvailable: Boolean(context.providers.getSTTProvider().voiceProfiles), applyState: applyFailure ? "APPLY_FAILED" : pending ? "RESTART_REQUIRED" : "ACTIVE" };
  }
  async function persistApply(saved: ProductSettings) {
    const previous = context.activeRuntimeEnv["YUVI_PRODUCT_CONFIGURATION"];
    const current = previous ? parseProductConfiguration(JSON.parse(previous)) : importLegacyConfiguration(context.activeRuntimeEnv).configuration;
    saved.revision++;
    writePrivateJson(productPath(), saved);
    // Embedding providers are captured by Memory stores; changing their space needs the existing restart path.
    if (embeddingSignature(current) !== embeddingSignature(saved.configuration)) return snapshot();
    try {
      const env = productEnvironment(context.activeRuntimeEnv, saved);
      await context.reloadRuntimeConfig(env);
      for (const key of ["YUVI_PRODUCT_CONFIGURATION", "MEMORY_SUBJECT_USER_ID", "MEMORY_PERSONA_ID", "PROACTIVE_SCORE_THRESHOLD", "PROACTIVE_EVALUATION_INTERVAL_MS"]) {
        if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
      }
      applyFailure = false;
    } catch { applyFailure = true; }
    return snapshot();
  }
  app.get("/product/configuration", async (req, reply) => { if (!requireLocalDashboardAccess(config, req, reply)) return; return snapshot(); });
  app.put("/product/configuration", async (req, reply) => {
    if (!requireLocalDashboardAccess(config, req, reply)) return;
    return locked(async () => {
      const saved = desired();
      const body = req.body as { configuration?: unknown; revision?: number; proactive?: unknown };
      if (body.revision !== saved.revision) return reply.code(409).send({ error: "Settings changed. Reload before saving." });
      try {
        const input = structuredClone(body.configuration) as ProductSettings["configuration"];
        // Omitted secret retains it; explicit empty string clears it.
        for (const p of input.providers) if (p.apiKey === undefined) { const key = saved.configuration.providers.find(old => old.id === p.id)?.apiKey; if (key !== undefined) p.apiKey = key; }
        saved.configuration = parseProductConfiguration(input);
        if (body.proactive) saved.proactive = z.object({ threshold: z.number().min(0).max(1), intervalMs: z.number().int().min(1000).max(86_400_000) }).strict().parse(body.proactive);
        createProviderRegistryFromEnv(productEnvironment(context.activeRuntimeEnv, saved));
      } catch { return reply.code(400).send({ error: "Invalid configuration or incompatible route assignment." }); }
      return persistApply(saved);
    });
  });
  app.post("/product/providers/:id/test", async (req, reply) => {
    if (!requireLocalDashboardAccess(config, req, reply)) return;
    const p = desired().configuration.providers.find(p => p.id === (req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "Provider not found." });
    try {
      const specialized = p.adapter !== "openai-compatible";
      const response = await fetch(specialized ? `${p.baseUrl.replace(/\/$/, "")}/health` : `${modelEndpoint(p.baseUrl)}/models`, { headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}, redirect: "error", signal: AbortSignal.timeout(8000) });
      if (!response.ok) return { ok: false, discoveryAvailable: false, message: `HTTP ${response.status}. You can add a model ID manually.` };
      const text = await response.text();
      if (text.length > 1_000_000) throw new Error();
      const data = JSON.parse(text) as { data?: Array<{ id?: unknown; context_window?: unknown }> };
      return { ok: true, discoveryAvailable: Array.isArray(data.data), models: (data.data ?? []).slice(0, 500).filter(m => typeof m.id === "string").map(m => ({ modelId: m.id, contextWindow: Number.isSafeInteger(m.context_window) && Number(m.context_window) >= 1024 ? m.context_window : null })), message: "Endpoint responded. Model calls are verified separately." };
    } catch { return { ok: false, discoveryAvailable: false, message: "Connection unavailable. Check the endpoint or add a model ID manually." }; }
  });
  app.post("/product/people", async (req, reply) => {
    if (!requireLocalDashboardAccess(config, req, reply)) return;
    const body = z.object({ displayName: z.string().trim().min(1).max(100), personaId: z.string().trim().min(1).max(100), notes: z.string().max(4000).default(""), primary: z.boolean().default(false), id: z.string().optional() }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Enter a name and current Yuvi persona." });
    return locked(async () => {
      const saved = desired();
      const old = saved.people.find(p => p.id === body.data.id);
      if (body.data.id && !old) return reply.code(404).send({ error: "Person not found." });
      const person = { id: old?.id ?? randomUUID(), displayName: body.data.displayName, personaId: body.data.personaId, notes: body.data.notes };
      saved.people = [...saved.people.filter(p => p.id !== person.id), person];
      if (body.data.primary) saved.primaryPersonId = person.id;
      const result = await persistApply(saved);
      const memoryState = await persistProfileEvidence(context, person);
      return { ...result, message: memoryState === "STORED" ? "Person saved and identity evidence stored in Memory." : `Person saved. Identity evidence: ${memoryState}. Configure Memory and save the profile again to retry.` };
    });
  });
  app.post("/product/proactive/resume", async (req, reply) => { if (!requireLocalDashboardAccess(config, req, reply)) return; context.runtime.resumeProactiveNow(); return snapshot(); });
}
