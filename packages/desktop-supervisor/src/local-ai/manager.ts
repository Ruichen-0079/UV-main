import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PROCESS_METADATA_VERSION, testProcessOwnership, writeProcessMetadata } from "../ownership.js";
import {
  forceKillProcessTree,
  inspectProcess,
  isProcessAlive,
  requestGracefulStop,
  spawnManagedProcess
} from "../process-windows.js";
import type { ProcessMetadata, StartCommandSpec } from "../types.js";
import { DEFAULT_START_POLICY, systemdUnitFor } from "./allowlist.js";
import { defaultSttThreadCount, parseStartPolicy } from "./config.js";
import { originOf, probeBinary, probeJson } from "./http.js";
import { mergeResources, sampleProcessResources } from "./resources.js";
import {
  controlAllowlistedUnit,
  isSystemdUserAvailable,
  showAllowlistedUnit,
  type SystemdUnitSnapshot
} from "./systemd.js";
import type {
  LocalAiActionResult,
  LocalAiCatalogSnapshot,
  LocalAiLifecycle,
  LocalAiManagerConfig,
  LocalAiOwnershipKind,
  LocalAiServiceId,
  LocalAiServiceSnapshot,
  LocalAiTestResult,
  SpeakerIdentifyResult,
  SpeakerProfilePublic
} from "./types.js";

type Internal = {
  snapshot: LocalAiServiceSnapshot;
  child: ChildProcess | null;
  generation: number;
  busy: number;
  op: Promise<void> | null;
};

const EMPTY_RESOURCES = {
  rssBytes: null,
  cpuPercent: null,
  gpuVramBytes: null,
  threads: null
};

export class LocalAiServiceManager {
  private readonly services = new Map<LocalAiServiceId, Internal>();
  private shuttingDown = false;

  constructor(private readonly config: LocalAiManagerConfig) {
    fs.mkdirSync(config.stateDirectory, { recursive: true });
    for (const id of ["alice.upstream", "alice.wrapper", "embedding", "stt", "local-llm", "alice"] as const) {
      this.services.set(id, {
        snapshot: this.blank(id),
        child: null,
        generation: 0,
        busy: 0,
        op: null
      });
    }
  }

  snapshot(): LocalAiCatalogSnapshot {
    return {
      services: this.ordered().map((id) => this.services.get(id)!.snapshot),
      updatedAt: new Date().toISOString()
    };
  }

  getService(id: LocalAiServiceId): LocalAiServiceSnapshot {
    return this.require(id).snapshot;
  }

  async refreshAll(): Promise<LocalAiCatalogSnapshot> {
    for (const id of this.ordered()) {
      if (id === "alice") continue;
      await this.refresh(id);
    }
    await this.refresh("alice");
    return this.snapshot();
  }

  async reconcileAlways(): Promise<LocalAiCatalogSnapshot> {
    await this.refreshAll();
    for (const id of ["alice.upstream", "alice.wrapper", "embedding"] as const) {
      const svc = this.require(id);
      if (svc.snapshot.startPolicy !== "ALWAYS") continue;
      if (svc.snapshot.lifecycle === "READY" || svc.snapshot.lifecycle === "BUSY") continue;
      if (!svc.snapshot.canStart) continue;
      await this.start(id);
    }
    return this.refreshAll();
  }

  async start(id: LocalAiServiceId): Promise<LocalAiActionResult> {
    if (this.shuttingDown) {
      return this.actionFrom(id, false, "Supervisor is shutting down.");
    }
    if (id === "alice") {
      const upstream = await this.start("alice.upstream");
      if (!upstream.ok) return this.actionFrom("alice", false, upstream.error);
      const wrapper = await this.start("alice.wrapper");
      await this.refresh("alice");
      return this.actionFrom("alice", wrapper.ok, wrapper.error);
    }
    return this.queue(id, async () => {
      const svc = this.require(id);
      await this.refresh(id);
      if (svc.snapshot.lifecycle === "READY" || svc.snapshot.lifecycle === "BUSY") {
        return this.actionFrom(id, true);
      }
      if (!svc.snapshot.canStart) {
        return this.actionFrom(id, false, "Start is not allowed for this ownership.");
      }
      svc.snapshot.lifecycle = "STARTING";
      svc.snapshot.summary = "Starting…";
      if (id === "stt") {
        const started = await this.startManagedStt(svc);
        await this.refresh(id);
        return this.actionFrom(id, started.ok, started.error);
      }
      const unit = systemdUnitFor(id);
      if (!unit) {
        return this.actionFrom(id, false, "No managed start path for this service.");
      }
      const result = controlAllowlistedUnit(unit, "start");
      await this.refresh(id);
      return this.actionFrom(id, result.ok, result.ok ? undefined : result.message);
    });
  }

  async stop(id: LocalAiServiceId): Promise<LocalAiActionResult> {
    if (id === "alice") {
      const wrapper = await this.stop("alice.wrapper");
      const upstream = await this.stop("alice.upstream");
      await this.refresh("alice");
      const ok = wrapper.ok && upstream.ok;
      return this.actionFrom("alice", ok, ok ? undefined : wrapper.error ?? upstream.error);
    }
    return this.queue(id, async () => {
      await this.refresh(id);
      const svc = this.require(id);
      if (
        svc.snapshot.lifecycle === "STOPPED" &&
        (svc.snapshot.ownership === "managed-process" || svc.snapshot.ownership === "systemd-user")
      ) {
        return this.actionFrom(id, true);
      }
      if (!svc.snapshot.canStop) {
        return this.actionFrom(id, false, "Refusing to stop a service that is not owned by YUVI.");
      }
      if (id === "stt") {
        await this.stopManagedStt(svc);
        await this.refresh(id);
        return this.actionFrom(id, true);
      }
      const unit = systemdUnitFor(id);
      if (!unit) {
        return this.actionFrom(id, false, "No stop path for this service.");
      }
      const result = controlAllowlistedUnit(unit, "stop");
      await this.refresh(id);
      return this.actionFrom(id, result.ok, result.ok ? undefined : result.message);
    });
  }

  async restart(id: LocalAiServiceId): Promise<LocalAiActionResult> {
    if (id === "alice") {
      const stopped = await this.stop("alice");
      if (!stopped.ok && stopped.service.lifecycle !== "STOPPED") {
        return stopped;
      }
      return this.start("alice");
    }
    return this.queue(id, async () => {
      await this.refresh(id);
      const svc = this.require(id);
      if (!svc.snapshot.canRestart) {
        return this.actionFrom(id, false, "Restart is not allowed for this ownership.");
      }
      if (id === "stt") {
        await this.stopManagedStt(svc);
        const started = await this.startManagedStt(svc);
        await this.refresh(id);
        return this.actionFrom(id, started.ok, started.error);
      }
      const unit = systemdUnitFor(id);
      if (!unit) {
        return this.actionFrom(id, false, "No restart path for this service.");
      }
      const result = controlAllowlistedUnit(unit, "restart");
      await this.refresh(id);
      return this.actionFrom(id, result.ok, result.ok ? undefined : result.message);
    });
  }

  async test(id: LocalAiServiceId): Promise<LocalAiTestResult> {
    await this.refresh(id);
    const svc = this.require(id);
    if (!svc.snapshot.canTest && svc.snapshot.lifecycle !== "READY") {
      return {
        ok: false,
        serviceId: id,
        latencyMs: 0,
        summary: "Service is not reachable for a test probe.",
        detail: { lifecycle: svc.snapshot.lifecycle, ownership: svc.snapshot.ownership }
      };
    }
    svc.busy += 1;
    try {
      if (id === "alice" || id === "alice.wrapper") {
        return await this.testAlice("ja");
      }
      if (id === "alice.upstream") {
        return await this.testAlice("zh");
      }
      if (id === "embedding") {
        return await this.testEmbedding();
      }
      if (id === "stt") {
        return await this.testSttHealth();
      }
      return await this.testLocalLlm();
    } finally {
      svc.busy = Math.max(0, svc.busy - 1);
      await this.refresh(id);
    }
  }

  async testAliceLanguages(): Promise<{ ja: LocalAiTestResult; zh: LocalAiTestResult }> {
    const ja = await this.testAlice("ja");
    const zh = await this.testAlice("zh");
    return { ja, zh };
  }

  async listSpeakers(): Promise<SpeakerProfilePublic[]> {
    const probe = await probeJson(`${this.config.sttUrl}/speakers`, { timeoutMs: 4_000 });
    if (!probe.ok || !probe.body || typeof probe.body !== "object") return [];
    const speakers = (probe.body as { speakers?: SpeakerProfilePublic[] }).speakers;
    return Array.isArray(speakers) ? speakers.map(publicSpeaker) : [];
  }

  async enrollSpeaker(input: {
    speakerId: string;
    label: string;
    audioBase64: string;
    mimeType?: string | undefined;
  }): Promise<SpeakerProfilePublic> {
    const probe = await probeJson(`${this.config.sttUrl}/speakers`, {
      method: "POST",
      timeoutMs: 30_000,
      body: {
        speakerId: input.speakerId,
        label: input.label,
        audioBase64: input.audioBase64,
        mimeType: input.mimeType ?? "audio/wav"
      }
    });
    if (!probe.ok) {
      throw new Error(probe.message);
    }
    return publicSpeaker(probe.body);
  }

  async deleteSpeaker(speakerId: string): Promise<void> {
    const probe = await probeJson(`${this.config.sttUrl}/speakers/${encodeURIComponent(speakerId)}`, {
      method: "DELETE",
      timeoutMs: 8_000
    });
    if (!probe.ok && probe.statusCode !== 404) {
      throw new Error(probe.message);
    }
  }

  async identifySpeaker(input: {
    audioBase64: string;
    mimeType?: string | undefined;
  }): Promise<SpeakerIdentifyResult> {
    const probe = await probeJson(`${this.config.sttUrl}/identify`, {
      method: "POST",
      timeoutMs: 30_000,
      body: {
        audioBase64: input.audioBase64,
        mimeType: input.mimeType ?? "audio/wav"
      }
    });
    if (!probe.ok || !probe.body || typeof probe.body !== "object") {
      throw new Error(probe.message);
    }
    const body = probe.body as Record<string, unknown>;
    const identity = body["identity"] === "KNOWN" ? "KNOWN" : "UNKNOWN";
    return {
      identity,
      speakerId: identity === "KNOWN" && typeof body["speakerId"] === "string" ? body["speakerId"] : null,
      label: identity === "KNOWN" && typeof body["label"] === "string" ? body["label"] : null,
      score: typeof body["score"] === "number" ? body["score"] : null,
      threshold: typeof body["threshold"] === "number" ? body["threshold"] : 0.55
    };
  }

  async transcribe(input: {
    audioBase64: string;
    mimeType?: string | undefined;
    language?: string | undefined;
    diarize?: boolean | undefined;
    identify?: boolean | undefined;
  }): Promise<Record<string, unknown>> {
    const probe = await probeJson(`${this.config.sttUrl}/transcribe`, {
      method: "POST",
      timeoutMs: 120_000,
      body: input
    });
    if (!probe.ok || !probe.body || typeof probe.body !== "object") {
      throw new Error(probe.message);
    }
    const body = { ...(probe.body as Record<string, unknown>) };
    delete body["embedding"];
    delete body["rawEmbedding"];
    return body;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const stt = this.require("stt");
    if (stt.snapshot.ownership === "managed-process") {
      await this.stopManagedStt(stt);
    }
  }

  private async refresh(id: LocalAiServiceId): Promise<void> {
    if (id === "alice") {
      this.refreshAliceLogical();
      return;
    }
    if (id === "stt") {
      await this.refreshStt();
      return;
    }
    if (id === "local-llm") {
      await this.refreshLocalLlm();
      return;
    }
    if (id === "embedding") {
      await this.refreshHttpService(id, this.embeddingHealthUrl(), this.embeddingHeaders());
      return;
    }
    if (id === "alice.wrapper") {
      await this.refreshHttpService(id, `${this.config.ttsWrapperUrl}/health`);
      return;
    }
    await this.refreshHttpService(id, `${this.config.ttsUpstreamUrl}/openapi.json`);
  }

  private async refreshHttpService(
    id: Exclude<LocalAiServiceId, "alice">,
    healthUrl: string,
    headers?: Record<string, string>
  ): Promise<void> {
    const svc = this.require(id);
    const unitName = systemdUnitFor(id);
    const systemd = unitName && isSystemdUserAvailable() ? showAllowlistedUnit(unitName) : null;
    const health = await probeJson(healthUrl, { timeoutMs: 3_000, headers, acceptStatuses: [200] });
    const ownership = this.classifyOwnership(id, systemd, health.ok);
    const pid = systemd?.mainPid ?? svc.child?.pid ?? null;
    const resources = sampleProcessResources(pid);
    if (systemd?.memoryCurrent && resources.rssBytes == null) {
      resources.rssBytes = systemd.memoryCurrent;
    }
    const lifecycle = this.lifecycleFrom(svc, health.ok, systemd);
    const policy = parseStartPolicy(
      this.config.env[`YUVI_LOCAL_AI_POLICY_${id.replace(".", "_").toUpperCase()}`],
      DEFAULT_START_POLICY[id]
    );
    const controllable = ownership === "systemd-user" || ownership === "managed-process";
    svc.snapshot = {
      ...svc.snapshot,
      lifecycle,
      ownership,
      startPolicy: policy,
      endpoint: originOf(healthUrl)?.origin ?? null,
      pid,
      systemdUnit: unitName,
      canStart: controllable && (lifecycle === "STOPPED" || lifecycle === "ERROR"),
      canStop: controllable && lifecycle !== "STOPPED",
      canRestart: controllable,
      canTest: health.ok || ownership !== "none",
      summary: this.summaryFor(lifecycle, ownership, health.message),
      detail: systemd ? `systemd ${systemd.activeState}/${systemd.subState}` : health.message,
      lastError: lifecycle === "ERROR" ? health.message : null,
      resources,
      metadata: await this.metadataFor(id, health.body),
      checkedAt: new Date().toISOString()
    };
  }

  private refreshAliceLogical(): void {
    const upstream = this.require("alice.upstream").snapshot;
    const wrapper = this.require("alice.wrapper").snapshot;
    const svc = this.require("alice");
    const children = [upstream, wrapper];
    const lifecycle = combineLifecycle(children.map((child) => child.lifecycle));
    const ownership = combineOwnership(children.map((child) => child.ownership));
    const controllable = ownership === "systemd-user" || ownership === "managed-process";
    svc.snapshot = {
      ...svc.snapshot,
      lifecycle,
      ownership,
      startPolicy: DEFAULT_START_POLICY.alice,
      endpoint: wrapper.endpoint,
      pid: wrapper.pid,
      systemdUnit: null,
      canStart: children.some((child) => child.canStart) || (controllable && lifecycle === "STOPPED"),
      canStop: children.some((child) => child.canStop),
      canRestart: children.some((child) => child.canRestart),
      canTest: wrapper.canTest || upstream.canTest,
      summary: `Alice TTS (${lifecycle.toLowerCase()}); children: upstream=${upstream.lifecycle}, wrapper=${wrapper.lifecycle}.`,
      detail: "Logical service over gpt-sovits-upstream + alice-tts-wrapper.",
      lastError: children.map((child) => child.lastError).find(Boolean) ?? null,
      resources: mergeResources(children.map((child) => child.resources)),
      metadata: {
        children: [
          { id: upstream.id, lifecycle: upstream.lifecycle, pid: upstream.pid },
          { id: wrapper.id, lifecycle: wrapper.lifecycle, pid: wrapper.pid }
        ],
        speaker: "alice"
      },
      checkedAt: new Date().toISOString()
    };
  }

  private async refreshStt(): Promise<void> {
    const svc = this.require("stt");
    const health = await probeJson(`${this.config.sttUrl}/health`, { timeoutMs: 2_000 });
    const childPid = svc.child?.pid && isProcessAlive(svc.child.pid) ? svc.child.pid : null;
    const owned = this.sttOwned(childPid);
    let ownership: LocalAiOwnershipKind = "none";
    if (owned) ownership = "managed-process";
    else if (health.ok) ownership = "external";
    const lifecycle = svc.busy > 0 && health.ok
      ? "BUSY"
      : health.ok
        ? "READY"
        : childPid
          ? "STARTING"
          : "STOPPED";
    const canManage = Boolean(this.sttStartCommand());
    svc.snapshot = {
      ...svc.snapshot,
      lifecycle: ownership === "external" && !health.ok ? "ERROR" : lifecycle,
      ownership,
      startPolicy: parseStartPolicy(this.config.env["YUVI_LOCAL_AI_POLICY_STT"], "ON_DEMAND"),
      endpoint: this.config.sttUrl,
      pid: childPid,
      systemdUnit: null,
      canStart: canManage && ownership !== "external" && lifecycle !== "READY" && lifecycle !== "BUSY",
      canStop: ownership === "managed-process",
      canRestart: ownership === "managed-process",
      canTest: health.ok,
      summary: this.summaryFor(lifecycle, ownership, health.message),
      detail: health.ok ? "sherpa-onnx CPU STT" : health.message,
      lastError: health.ok ? null : health.message,
      resources: sampleProcessResources(childPid),
      metadata: health.body && typeof health.body === "object" ? redactSttMeta(health.body) : {},
      checkedAt: new Date().toISOString()
    };
  }

  private async refreshLocalLlm(): Promise<void> {
    const svc = this.require("local-llm");
    const url = this.config.localLlmUrl;
    if (!url) {
      svc.snapshot = {
        ...this.blank("local-llm"),
        summary: "No LOCAL_LLM_BASEURL configured. Adapter only — no model is downloaded.",
        metadata: { adapter: "openai-compatible-or-llama-cpp", roleRouting: false },
        checkedAt: new Date().toISOString()
      };
      return;
    }
    const health = await probeJson(`${url.replace(/\/v1$/, "")}/health`, {
      timeoutMs: 3_000,
      acceptStatuses: [200]
    });
    const models = await probeJson(`${url.replace(/\/+$/, "")}/models`, {
      timeoutMs: 3_000,
      headers: this.embeddingHeaders()
    });
    const systemd = this.config.localLlmSystemdUnit
      ? showAllowlistedUnit(this.config.localLlmSystemdUnit)
      : null;
    const ownership: LocalAiOwnershipKind = systemd?.exists
      ? "systemd-user"
      : health.ok || models.ok
        ? "external"
        : "none";
    const lifecycle: LocalAiLifecycle = health.ok || models.ok ? "READY" : "STOPPED";
    const loaded = extractModels(models.body);
    svc.snapshot = {
      ...svc.snapshot,
      lifecycle,
      ownership,
      startPolicy: parseStartPolicy(this.config.env["YUVI_LOCAL_AI_POLICY_LOCAL_LLM"], "MANUAL"),
      endpoint: url,
      pid: systemd?.mainPid ?? null,
      systemdUnit: this.config.localLlmSystemdUnit,
      canStart: ownership === "systemd-user" && lifecycle === "STOPPED",
      canStop: ownership === "systemd-user" && lifecycle !== "STOPPED",
      canRestart: ownership === "systemd-user",
      canTest: Boolean(url),
      summary:
        ownership === "external"
          ? "External OpenAI-compatible/llama.cpp server (observe/test only)."
          : lifecycle === "READY"
            ? "Local LLM endpoint is reachable."
            : "Local LLM adapter is idle. No new LLM is downloaded.",
      detail: "Does not assign Character or Cognition roles.",
      lastError: null,
      resources: sampleProcessResources(systemd?.mainPid ?? null),
      metadata: {
        adapter: "openai-compatible-or-llama-cpp",
        health: health.ok,
        models: loaded,
        roleRouting: false,
        characterRole: null,
        cognitionRole: null,
        fallback: null
      },
      checkedAt: new Date().toISOString()
    };
  }

  private classifyOwnership(
    id: LocalAiServiceId,
    systemd: SystemdUnitSnapshot | null,
    healthy: boolean
  ): LocalAiOwnershipKind {
    if (systemd?.exists && systemd.activeState === "active") return "systemd-user";
    if (systemd?.exists && systemd.loaded) {
      return healthy ? "systemd-user" : "systemd-user";
    }
    if (healthy) return "external";
    return "none";
  }

  private lifecycleFrom(
    svc: Internal,
    healthy: boolean,
    systemd: SystemdUnitSnapshot | null
  ): LocalAiLifecycle {
    if (svc.busy > 0 && healthy) return "BUSY";
    if (healthy) return "READY";
    if (systemd?.activeState === "activating") return "STARTING";
    if (systemd?.activeState === "failed") return "ERROR";
    if (systemd?.activeState === "active" && !healthy) return "STARTING";
    if (systemd?.exists && systemd.activeState !== "inactive" && systemd.activeState !== "dead") {
      return "STARTING";
    }
    return "STOPPED";
  }

  private async metadataFor(id: LocalAiServiceId, body: unknown): Promise<Record<string, unknown>> {
    if (id === "embedding") {
      return {
        model: this.config.embeddingModel,
        dimensions: this.config.embeddingDimensions,
        nativeDimensions: 1024,
        device: "cpu",
        providerPath: "packages/providers local OpenAI-compatible embedding",
        memoryAuthority: "existing provider / Memory"
      };
    }
    if (id === "alice.wrapper" && body && typeof body === "object") {
      const record = body as Record<string, unknown>;
      return {
        speaker: record["speaker"] ?? "alice",
        modelLoaded: record["model_loaded"] === true,
        device: record["device"] ?? null
      };
    }
    return {};
  }

  private async testAlice(language: "ja" | "zh"): Promise<LocalAiTestResult> {
    if (language === "ja") {
      const result = await probeBinary(`${this.config.ttsWrapperUrl}/tts`, {
        timeoutMs: 90_000,
        body: {
          text: "テストです。聞こえますか。",
          language: "ja",
          speaker: "alice",
          style: "neutral",
          reference_rank: 0
        }
      });
      return {
        ok: result.ok,
        serviceId: "alice",
        latencyMs: result.latencyMs,
        summary: result.ok ? "Japanese Alice TTS returned audio." : result.message,
        detail: { language: "ja", bytes: result.bytes, transport: "wrapper", statusCode: result.statusCode }
      };
    }
    const refAudio = this.config.env["GPT_SOVITS_TTS_REFERENCE_AUDIO"];
    const refText = this.config.env["GPT_SOVITS_TTS_REFERENCE_TEXT"];
    const result = await probeBinary(`${this.config.ttsUpstreamUrl}/tts`, {
      timeoutMs: 90_000,
      body: {
        text: "这是一段中文测试。",
        text_lang: "zh",
        ref_audio_path: refAudio,
        prompt_text: refText,
        prompt_lang: this.config.env["GPT_SOVITS_TTS_REFERENCE_LANGUAGE"] || "ja",
        text_split_method: "cut0",
        batch_size: 1,
        media_type: "wav",
        streaming_mode: false
      }
    });
    return {
      ok: result.ok,
      serviceId: "alice.upstream",
      latencyMs: result.latencyMs,
      summary: result.ok
        ? "Chinese TTS returned audio via upstream with unchanged reference."
        : result.message,
      detail: {
        language: "zh",
        bytes: result.bytes,
        transport: "upstream",
        checkpointUnmodified: true,
        statusCode: result.statusCode
      }
    };
  }

  private async testEmbedding(): Promise<LocalAiTestResult> {
    const url = this.config.embeddingUrl.endsWith("/v1")
      ? `${this.config.embeddingUrl}/embeddings`
      : `${this.config.embeddingUrl}/v1/embeddings`;
    const probe = await probeJson(url, {
      method: "POST",
      timeoutMs: 20_000,
      headers: this.embeddingHeaders(),
      body: {
        input: "YUVI local embedding probe",
        model: this.config.embeddingModel ?? "Qwen3-Embedding-0.6B-Q8_0.gguf"
      }
    });
    const vector = extractEmbedding(probe.body);
    const ok = probe.ok && vector.length > 0;
    return {
      ok,
      serviceId: "embedding",
      latencyMs: probe.latencyMs,
      summary: ok
        ? `Embedding test returned ${vector.length}-d vector (not logged).`
        : probe.message,
      detail: {
        model: this.config.embeddingModel,
        nativeDimensions: vector.length || null,
        configuredDimensions: this.config.embeddingDimensions,
        memoryAuthority: "existing provider / Memory",
        rawVectorReturned: false
      }
    };
  }

  private async testSttHealth(): Promise<LocalAiTestResult> {
    const probe = await probeJson(`${this.config.sttUrl}/health`, { timeoutMs: 4_000 });
    return {
      ok: probe.ok,
      serviceId: "stt",
      latencyMs: probe.latencyMs,
      summary: probe.ok ? "STT sidecar is healthy." : probe.message,
      detail: probe.body && typeof probe.body === "object" ? redactSttMeta(probe.body) : {}
    };
  }

  private async testLocalLlm(): Promise<LocalAiTestResult> {
    const url = this.config.localLlmUrl;
    if (!url) {
      return {
        ok: false,
        serviceId: "local-llm",
        latencyMs: 0,
        summary: "LOCAL_LLM_BASEURL is not set. Adapter does not download an LLM.",
        detail: { roleRouting: false }
      };
    }
    const models = await probeJson(`${url.replace(/\/+$/, "")}/models`, { timeoutMs: 4_000 });
    return {
      ok: models.ok,
      serviceId: "local-llm",
      latencyMs: models.latencyMs,
      summary: models.ok ? "Local LLM /models discovery succeeded." : models.message,
      detail: { models: extractModels(models.body), roleRouting: false }
    };
  }

  private async startManagedStt(svc: Internal): Promise<{ ok: boolean; error?: string }> {
    const command = this.sttStartCommand();
    if (!command) {
      return { ok: false, error: "STT python runtime or script is not installed." };
    }
    const metadataPath = this.sttMetadataPath();
    const logFile = path.join(this.config.stateDirectory, "local-stt.log");
    const child = spawnManagedProcess(command, { out: logFile, err: logFile }, {
      env: {
        ...process.env,
        ...command.env
      }
    });
    svc.child = child;
    svc.generation += 1;
    const pid = child.pid ?? 0;
    if (!pid) {
      return { ok: false, error: "STT process failed to spawn." };
    }
    const metadata: ProcessMetadata = {
      schemaVersion: PROCESS_METADATA_VERSION,
      role: "local-stt",
      pid,
      repositoryRoot: this.config.repositoryRoot,
      stateDirectory: this.config.stateDirectory,
      commandMarker: command.commandMarker,
      processStartedAtUtc: new Date().toISOString(),
      createdAtUtc: new Date().toISOString(),
      ownershipToken: this.config.ownershipToken,
      instanceId: this.config.instanceId
    };
    writeProcessMetadata(metadataPath, metadata);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const health = await probeJson(`${this.config.sttUrl}/health`, { timeoutMs: 1_000 });
      if (health.ok) return { ok: true };
      await sleep(400);
    }
    return { ok: false, error: "STT started but health probe did not become ready." };
  }

  private async stopManagedStt(svc: Internal): Promise<void> {
    const pid = svc.child?.pid ?? svc.snapshot.pid;
    if (!pid) return;
    const ownership = testProcessOwnership({
      metadataPath: this.sttMetadataPath(),
      expectedRole: "local-stt",
      repositoryRoot: this.config.repositoryRoot,
      stateDirectory: this.config.stateDirectory,
      ownershipToken: this.config.ownershipToken,
      instanceId: this.config.instanceId,
      processInspection: inspectProcess(pid),
      currentChild: svc.child ? { pid: svc.child.pid ?? null } : null
    });
    if (!ownership.owned && !ownership.cleanupAllowed) {
      svc.snapshot.lastError = "Refusing to stop STT: ownership not proven.";
      return;
    }
    requestGracefulStop(pid);
    await sleep(800);
    if (isProcessAlive(pid)) {
      forceKillProcessTree(pid);
    }
    svc.child = null;
    try {
      fs.unlinkSync(this.sttMetadataPath());
    } catch {
      // ignore
    }
  }

  private sttOwned(pid: number | null): boolean {
    if (!pid) return false;
    const ownership = testProcessOwnership({
      metadataPath: this.sttMetadataPath(),
      expectedRole: "local-stt",
      repositoryRoot: this.config.repositoryRoot,
      stateDirectory: this.config.stateDirectory,
      ownershipToken: this.config.ownershipToken,
      instanceId: this.config.instanceId,
      processInspection: inspectProcess(pid)
    });
    return ownership.owned;
  }

  private sttStartCommand(): StartCommandSpec | null {
    if (!this.config.sttPython || !this.config.sttScript) return null;
    const parsed = originOf(this.config.sttUrl);
    const threads = String(defaultSttThreadCount());
    return {
      file: this.config.sttPython,
      args: [
        this.config.sttScript,
        "--host",
        parsed?.host ?? "127.0.0.1",
        "--port",
        String(parsed?.port ?? 9876),
        "--model-dir",
        this.config.sttModelDir,
        "--threads",
        threads,
        "--yuvi-local-stt"
      ],
      cwd: this.config.repositoryRoot,
      env: {
        CUDA_VISIBLE_DEVICES: "",
        OMP_NUM_THREADS: threads,
        MKL_NUM_THREADS: threads,
        ORT_LOGGING_LEVEL: "3",
        YUVI_STT_SPEAKER_DIR: path.join(this.config.stateDirectory, "speakers")
      },
      commandMarker: "--yuvi-local-stt"
    };
  }

  private sttMetadataPath(): string {
    return path.join(this.config.stateDirectory, "local-stt.pid.json");
  }

  private embeddingHealthUrl(): string {
    const base = this.config.embeddingUrl.replace(/\/v1$/, "");
    return `${base}/health`;
  }

  private embeddingHeaders(): Record<string, string> {
    if (!this.config.embeddingApiKey) return {};
    return { authorization: `Bearer ${this.config.embeddingApiKey}` };
  }

  private blank(id: LocalAiServiceId): LocalAiServiceSnapshot {
    const labels: Record<LocalAiServiceId, string> = {
      alice: "Alice TTS",
      "alice.upstream": "GPT-SoVITS upstream",
      "alice.wrapper": "Alice TTS wrapper",
      embedding: "Local embedding",
      stt: "Local CPU STT",
      "local-llm": "Future local LLM"
    };
    const parent: Record<LocalAiServiceId, LocalAiServiceId | null> = {
      alice: null,
      "alice.upstream": "alice",
      "alice.wrapper": "alice",
      embedding: null,
      stt: null,
      "local-llm": null
    };
    const children: Record<LocalAiServiceId, LocalAiServiceId[]> = {
      alice: ["alice.upstream", "alice.wrapper"],
      "alice.upstream": [],
      "alice.wrapper": [],
      embedding: [],
      stt: [],
      "local-llm": []
    };
    return {
      id,
      label: labels[id],
      kind: id === "alice" ? "logical" : "leaf",
      parentId: parent[id],
      children: children[id],
      lifecycle: "STOPPED",
      ownership: "none",
      startPolicy: DEFAULT_START_POLICY[id],
      endpoint: null,
      pid: null,
      systemdUnit: systemdUnitFor(id),
      canStart: false,
      canStop: false,
      canRestart: false,
      canTest: false,
      summary: "Not checked yet",
      detail: null,
      lastError: null,
      resources: { ...EMPTY_RESOURCES },
      metadata: {},
      checkedAt: new Date().toISOString()
    };
  }

  private summaryFor(
    lifecycle: LocalAiLifecycle,
    ownership: LocalAiOwnershipKind,
    message: string
  ): string {
    if (lifecycle === "READY") return `Ready (${ownership}).`;
    if (lifecycle === "BUSY") return `Busy (${ownership}).`;
    if (lifecycle === "STARTING") return "Starting…";
    if (lifecycle === "ERROR") return message;
    return ownership === "none" ? "Stopped." : `Stopped (${ownership}).`;
  }

  private ordered(): LocalAiServiceId[] {
    return ["alice", "alice.upstream", "alice.wrapper", "embedding", "stt", "local-llm"];
  }

  private require(id: LocalAiServiceId): Internal {
    const svc = this.services.get(id);
    if (!svc) throw new Error(`unknown local AI service ${id}`);
    return svc;
  }

  private actionFrom(id: LocalAiServiceId, ok: boolean, error?: string): LocalAiActionResult {
    return { ok, service: this.require(id).snapshot, error };
  }

  private async queue<T>(id: LocalAiServiceId, fn: () => Promise<T>): Promise<T> {
    const svc = this.require(id);
    const previous = svc.op;
    let release: () => void = () => undefined;
    svc.op = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (previous) await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (svc.op && svc.op === svc.op) {
        // keep last op slot
      }
    }
  }
}

function combineLifecycle(items: LocalAiLifecycle[]): LocalAiLifecycle {
  if (items.includes("ERROR")) return "ERROR";
  if (items.includes("STARTING")) return "STARTING";
  if (items.includes("BUSY")) return "BUSY";
  if (items.every((item) => item === "READY")) return "READY";
  if (items.every((item) => item === "STOPPED")) return "STOPPED";
  if (items.some((item) => item === "READY")) return "STARTING";
  return "STOPPED";
}

function combineOwnership(items: LocalAiOwnershipKind[]): LocalAiOwnershipKind {
  if (items.every((item) => item === "systemd-user")) return "systemd-user";
  if (items.every((item) => item === "managed-process")) return "managed-process";
  if (items.includes("external")) return "external";
  if (items.some((item) => item === "systemd-user")) return "systemd-user";
  if (items.some((item) => item === "managed-process")) return "managed-process";
  return "none";
}

function extractEmbedding(body: unknown): number[] {
  if (!body || typeof body !== "object") return [];
  const data = (body as { data?: Array<{ embedding?: number[] }> }).data;
  const embedding = data?.[0]?.embedding;
  return Array.isArray(embedding) ? embedding : [];
}

function extractModels(body: unknown): Array<{ id: string; ownedBy?: string }> {
  if (!body || typeof body !== "object") return [];
  const record = body as { data?: Array<{ id?: unknown; owned_by?: unknown }>; models?: Array<{ name?: unknown }> };
  if (Array.isArray(record.data)) {
    return record.data
      .map((item) => {
        const id = typeof item.id === "string" ? item.id : "";
        const ownedBy = typeof item.owned_by === "string" ? item.owned_by : undefined;
        return ownedBy ? { id, ownedBy } : { id };
      })
      .filter((item) => item.id);
  }
  if (Array.isArray(record.models)) {
    return record.models
      .map((item) => ({ id: typeof item.name === "string" ? item.name : "" }))
      .filter((item) => item.id);
  }
  return [];
}

function publicSpeaker(value: unknown): SpeakerProfilePublic {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    speakerId: typeof record["speakerId"] === "string" ? record["speakerId"] : "",
    label: typeof record["label"] === "string" ? record["label"] : "",
    enrolledAt: typeof record["enrolledAt"] === "string" ? record["enrolledAt"] : new Date().toISOString()
  };
}

function redactSttMeta(body: unknown): Record<string, unknown> {
  const record = body && typeof body === "object" ? { ...(body as Record<string, unknown>) } : {};
  delete record["embedding"];
  delete record["rawEmbedding"];
  delete record["embeddings"];
  return record;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
