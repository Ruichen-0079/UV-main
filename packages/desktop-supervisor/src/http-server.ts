import http from "node:http";
import type { DesktopSupervisor } from "./supervisor.js";
import type { RuntimeConfigUpdate, ServiceId } from "./types.js";
import { assertLoopbackHost } from "./config.js";

const SERVICE_IDS = new Set<ServiceId>([
  "runtime",
  "mem0",
  "tts_wrapper",
  "tts_upstream",
  "ollama",
  "postgres"
]);

export const CONTROL_TOKEN_HEADER = "x-yuvi-control-token";

export type SupervisorHttpServerOptions = {
  host?: string;
  port?: number;
  /** Required high-entropy token for mutating routes. */
  controlToken: string;
};

/**
 * Loopback-only control plane for the desktop supervisor.
 * Write ops require X-Yuvi-Control-Token. No secrets in response bodies.
 */
export function startSupervisorHttpServer(
  supervisor: DesktopSupervisor,
  options: SupervisorHttpServerOptions
): Promise<{ server: http.Server; port: number; host: string }> {
  const host = options.host ?? "127.0.0.1";
  assertLoopbackHost(host);
  if (!options.controlToken || options.controlToken.length < 32) {
    throw new Error("controlToken must be a high-entropy secret (min 32 chars).");
  }

  const server = http.createServer((req, res) => {
    void handle(req, res, supervisor, options.controlToken);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to bind supervisor control port"));
        return;
      }
      resolve({ server, port: address.port, host });
    });
  });
}

export function extractControlToken(req: http.IncomingMessage): string | null {
  const header = req.headers[CONTROL_TOKEN_HEADER] ?? req.headers["authorization"];
  if (typeof header !== "string" || !header.trim()) return null;
  if (header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  return header.trim();
}

export function tokensMatch(expected: string, provided: string | null): boolean {
  if (!provided) return false;
  if (expected.length !== provided.length) return false;
  // Constant-time-ish compare for equal-length strings.
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  supervisor: DesktopSupervisor,
  controlToken: string
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    const isWrite =
      method !== "GET" && method !== "HEAD" && method !== "OPTIONS";

    // Public liveness only (no token, no secrets).
    if (method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, service: "yuvi-desktop-supervisor" });
    }

    if (isWrite || url.pathname.startsWith("/v1/")) {
      const provided = extractControlToken(req);
      // Status also requires token so only Tauri (with endpoint file) can read detailed state.
      if (!tokensMatch(controlToken, provided)) {
        return sendJson(res, 401, { error: "unauthorized" });
      }
    }

    if (method === "GET" && url.pathname === "/v1/status") {
      const snap = supervisor.snapshot();
      // Belt-and-suspenders: never serialize secrets into status.
      const text = JSON.stringify(snap);
      if (text.includes("DEEPSEEK_API_KEY") || text.includes("DATABASE_URL=")) {
        return sendJson(res, 200, {
          instanceId: snap.instanceId,
          shuttingDown: snap.shuttingDown,
          services: snap.services,
          updatedAt: snap.updatedAt
        });
      }
      return sendJson(res, 200, snap);
    }
    if (method === "POST" && url.pathname === "/v1/refresh") {
      const snap = await supervisor.refreshAll();
      return sendJson(res, 200, snap);
    }
    if (method === "POST" && url.pathname === "/v1/bootstrap") {
      const snap = await supervisor.bootstrap();
      return sendJson(res, 200, snap);
    }
    if (method === "POST" && url.pathname === "/v1/config") {
      const raw = await readJsonBody(req);
      const update = parseRuntimeConfigUpdate(raw);
      const result = await supervisor.applyRuntimeConfig(update);
      // Ack is redacted (key names only, no values).
      return sendJson(res, 200, result);
    }
    if (method === "POST" && url.pathname === "/v1/shutdown") {
      await supervisor.shutdown();
      return sendJson(res, 200, { ok: true });
    }

    const serviceMatch = url.pathname.match(/^\/v1\/services\/([a-z_]+)\/(restart|stop|start)$/);
    if (method === "POST" && serviceMatch) {
      const id = serviceMatch[1] as ServiceId;
      const action = serviceMatch[2];
      if (!SERVICE_IDS.has(id)) {
        return sendJson(res, 404, { error: "unknown_service" });
      }
      if (action === "restart") {
        return sendJson(res, 200, await supervisor.restartService(id));
      }
      if (action === "stop") {
        return sendJson(res, 200, await supervisor.stopService(id));
      }
      if (action === "start") {
        await supervisor.ensureService(id);
        return sendJson(res, 200, supervisor.snapshot());
      }
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Never echo tokens or env values.
    const safe =
      message.includes("controlToken") ||
      message.includes("token") ||
      message.includes("DEEPSEEK") ||
      message.includes("DATABASE_URL") ||
      message.includes("sk-")
        ? "supervisor_error"
        : message.includes("shutting down")
          ? message
          : message;
    const status = message.includes("shutting down") ? 409 : 500;
    sendJson(res, status, {
      error: status === 409 ? "shutting_down" : "supervisor_error",
      message: safe
    });
  }
}

function parseRuntimeConfigUpdate(raw: unknown): RuntimeConfigUpdate {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config body must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const env: Record<string, string> = {};
  if (obj["env"] != null) {
    if (typeof obj["env"] !== "object" || Array.isArray(obj["env"])) {
      throw new Error("env must be an object");
    }
    for (const [key, value] of Object.entries(obj["env"] as Record<string, unknown>)) {
      if (typeof key !== "string" || !key.trim()) continue;
      if (value == null) continue;
      env[key] = String(value);
    }
  }
  const unsetEnv: string[] = [];
  if (obj["unsetEnv"] != null) {
    if (!Array.isArray(obj["unsetEnv"])) {
      throw new Error("unsetEnv must be an array");
    }
    for (const item of obj["unsetEnv"]) {
      if (typeof item === "string" && item.trim()) unsetEnv.push(item.trim());
    }
  }
  return { env, unsetEnv };
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    // Guard against accidental huge payloads (config is small).
    const total = chunks.reduce((n, c) => n + c.length, 0);
    if (total > 256_000) {
      throw new Error("config body too large");
    }
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("config body is not valid JSON");
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(payload);
}
