import net from "node:net";
import type { HealthProbeResult } from "./types.js";

export async function probeHttpHealth(
  url: string,
  options: {
    timeoutMs?: number;
    validateBody?: ((body: unknown) => boolean) | undefined;
  } = {}
): Promise<HealthProbeResult> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { accept: "application/json, text/plain, */*" }
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      // keep text
    }
    const protocolOk = options.validateBody
      ? options.validateBody(body)
      : response.ok;
    return {
      ok: response.ok && protocolOk,
      statusCode: response.status,
      protocolOk,
      message: response.ok
        ? protocolOk
          ? "healthy"
          : "port responds but protocol mismatch"
        : `HTTP ${response.status}`,
      latencyMs: Math.round(performance.now() - started)
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      protocolOk: false,
      message: error instanceof Error ? error.message : "health probe failed",
      latencyMs: Math.round(performance.now() - started)
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeTcp(host: string, port: number, timeoutMs = 1_500): Promise<HealthProbeResult> {
  const started = performance.now();
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (result: HealthProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({
        ok: false,
        statusCode: null,
        protocolOk: false,
        message: "tcp timeout",
        latencyMs: Math.round(performance.now() - started)
      });
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      finish({
        ok: true,
        statusCode: null,
        protocolOk: true,
        message: "tcp open",
        latencyMs: Math.round(performance.now() - started)
      });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      finish({
        ok: false,
        statusCode: null,
        protocolOk: false,
        message: error.message,
        latencyMs: Math.round(performance.now() - started)
      });
    });
  });
}

export function runtimeHealthOk(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const record = body as Record<string, unknown>;
  return record["ok"] === true || record["service"] === "ai-companion-runtime";
}

export function mem0HealthOk(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const record = body as Record<string, unknown>;
  if (record["ok"] === true) return true;
  const data = record["data"];
  if (data && typeof data === "object") {
    const status = (data as Record<string, unknown>)["status"];
    return status === "healthy" || status === "degraded";
  }
  return false;
}

export function ttsWrapperHealthOk(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  // Alice wrapper may report model_loaded; accept any JSON 200 with object body.
  return true;
}

export function ttsUpstreamHealthOk(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const paths = (body as Record<string, unknown>)["paths"];
  return Boolean(paths && typeof paths === "object" && "/tts" in paths);
}

export function ollamaTagsOk(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  return Array.isArray((body as Record<string, unknown>)["models"]);
}
