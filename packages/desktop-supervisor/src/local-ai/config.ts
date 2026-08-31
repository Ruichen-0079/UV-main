import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ALLOWLISTED_SYSTEMD_UNIT_NAMES } from "./allowlist.js";
import type { LocalAiManagerConfig, LocalAiStartPolicy } from "./types.js";

export function defaultSttThreadCount(cpuCount = os.cpus().length): number {
  const cap = Math.max(1, Math.floor(cpuCount / 4));
  return Math.min(4, cap);
}

export function loadLocalAiManagerConfig(input: {
  repositoryRoot: string;
  stateDirectory: string;
  instanceId: string;
  ownershipToken: string;
  env: Record<string, string>;
  ttsWrapperUrl: string;
  ttsUpstreamUrl: string;
}): LocalAiManagerConfig {
  const env = input.env;
  const sttScript = path.join(input.repositoryRoot, "services", "local-stt", "server.py");
  const defaultPython = path.join(os.homedir(), ".local", "share", "yuvi", "local-stt", ".venv", "bin", "python");
  const pythonCandidate = env["YUVI_STT_PYTHON"]?.trim() || defaultPython;
  const sttPython =
    pythonCandidate && fs.existsSync(pythonCandidate) ? pythonCandidate : null;
  const llmUnitRaw = env["YUVI_LOCAL_LLM_SYSTEMD_UNIT"]?.trim() || "";
  const localLlmSystemdUnit =
    llmUnitRaw && ALLOWLISTED_SYSTEMD_UNIT_NAMES.has(llmUnitRaw) ? llmUnitRaw : null;

  return {
    repositoryRoot: input.repositoryRoot,
    stateDirectory: input.stateDirectory,
    instanceId: input.instanceId,
    ownershipToken: input.ownershipToken,
    env,
    ttsWrapperUrl: trimSlash(env["GPT_SOVITS_TTS_BASE_URL"] || input.ttsWrapperUrl),
    ttsUpstreamUrl: trimSlash(env["GPT_SOVITS_TTS_UPSTREAM_URL"] || input.ttsUpstreamUrl),
    embeddingUrl: trimSlash(
      env["LOCAL_EMBEDDING_BASEURL"] || env["LOCAL_MODEL_BASEURL"] || "http://127.0.0.1:8128/v1"
    ),
    embeddingApiKey: emptyToNull(env["EMBEDDING_API_KEY"]),
    embeddingModel: emptyToNull(env["LOCAL_EMBEDDING_MODEL"] || env["EMBEDDING_MODEL"]),
    embeddingDimensions: Number.parseInt(env["LOCAL_EMBEDDING_DIMENSIONS"] || env["EMBEDDING_DIMENSIONS"] || "512", 10) || 512,
    sttUrl: trimSlash(env["YUVI_STT_BASE_URL"] || env["LOCAL_STT_BASEURL"] || "http://127.0.0.1:9876"),
    sttPython,
    sttScript: fs.existsSync(sttScript) ? sttScript : null,
    sttModelDir:
      env["YUVI_STT_MODEL_DIR"]?.trim() ||
      path.join(os.homedir(), ".local", "share", "yuvi", "models", "stt"),
    localLlmUrl: emptyToNull(env["LOCAL_LLM_BASEURL"]),
    localLlmSystemdUnit
  };
}

export function parseStartPolicy(
  raw: string | undefined,
  fallback: LocalAiStartPolicy
): LocalAiStartPolicy {
  const value = raw?.trim().toUpperCase();
  if (value === "ALWAYS" || value === "ON_DEMAND" || value === "MANUAL") return value;
  return fallback;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function emptyToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
