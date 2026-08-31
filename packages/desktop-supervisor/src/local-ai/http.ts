export type JsonProbe = {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  body: unknown;
  message: string;
};

export async function probeJson(
  url: string,
  options: {
    method?: string | undefined;
    headers?: Record<string, string> | undefined;
    body?: unknown;
    timeoutMs?: number | undefined;
    acceptStatuses?: number[] | undefined;
  } = {}
): Promise<JsonProbe> {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 4_000);
  try {
    const init: RequestInit = {
      method: options.method ?? "GET",
      headers: {
        accept: "application/json, text/plain, */*",
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers
      },
      signal: controller.signal
    };
    if (options.body != null) {
      init.body = JSON.stringify(options.body);
    }
    const response = await fetch(url, init);
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      // keep text
    }
    const accepted = options.acceptStatuses ?? [200];
    const ok = accepted.includes(response.status);
    return {
      ok,
      statusCode: response.status,
      latencyMs: Math.round(performance.now() - started),
      body,
      message: ok ? "ok" : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: Math.round(performance.now() - started),
      body: null,
      message: error instanceof Error ? error.message : "probe failed"
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeBinary(
  url: string,
  options: {
    method?: string | undefined;
    headers?: Record<string, string> | undefined;
    body?: unknown;
    timeoutMs?: number | undefined;
  } = {}
): Promise<{ ok: boolean; statusCode: number | null; latencyMs: number; bytes: number; message: string }> {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
  try {
    const init: RequestInit = {
      method: options.method ?? "POST",
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers
      },
      signal: controller.signal
    };
    if (options.body != null) {
      init.body = JSON.stringify(options.body);
    }
    const response = await fetch(url, init);
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      ok: response.ok && buffer.byteLength > 0,
      statusCode: response.status,
      latencyMs: Math.round(performance.now() - started),
      bytes: buffer.byteLength,
      message: response.ok ? (buffer.byteLength > 0 ? "ok" : "empty body") : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: Math.round(performance.now() - started),
      bytes: 0,
      message: error instanceof Error ? error.message : "probe failed"
    };
  } finally {
    clearTimeout(timer);
  }
}

export function originOf(url: string): { host: string; port: number; origin: string } | null {
  try {
    const parsed = new URL(url.includes("://") ? url : `http://${url}`);
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    return { host: parsed.hostname, port, origin: `${parsed.protocol}//${parsed.host}` };
  } catch {
    return null;
  }
}
