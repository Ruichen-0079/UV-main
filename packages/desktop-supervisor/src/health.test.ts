import { afterEach, expect, it, vi } from "vitest";
import { mem0HealthOk, probeHttpHealth } from "./health.js";

afterEach(() => vi.unstubAllGlobals());
it.each(["healthy", "degraded", "unhealthy"])(
  "reads Mem0 capability status before envelope success: %s",
  async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { status } })))
    );
    const result = await probeHttpHealth("http://localhost/health", { validateBody: mem0HealthOk });
    expect(result.ok).toBe(status !== "unhealthy");
    expect(result.degraded).toBe(status === "degraded");
  }
);
