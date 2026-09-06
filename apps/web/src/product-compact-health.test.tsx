import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { apiClient, type HealthResponse, type ProviderHealth } from "./api/client.js";
import { ProductCompactHealth, productCompactHealthItems } from "./product-compact-health.js";
import { ProductWebUI } from "./product-webui.js";

function provider(input: Partial<ProviderHealth> = {}): ProviderHealth {
  return {
    provider: "xai",
    status: "healthy",
    readiness: "ready",
    observed: "unknown",
    checkedAt: "2026-09-06T00:00:00.000Z",
    ...input
  };
}

function health(input: Partial<HealthResponse> = {}): HealthResponse {
  return {
    ok: true,
    service: "ai-companion-runtime",
    runtimeMode: "development",
    server: { status: "healthy" },
    database: { status: "healthy" },
    providers: {
      chat: provider({ provider: "deepseek" }),
      chatCapability: {
        readiness: "ready",
        observed: "unknown",
        operational: true,
        routeCount: 1,
        readyRouteCount: 1,
        readyProviders: [
          { provider: "deepseek", priority: 1, observed: "unknown", status: "degraded" }
        ]
      },
      optional: {
        reasoning: provider({ provider: "deepseek" }),
        tts: provider({ provider: "xai" }),
        stt: provider({ provider: "dashscope" }),
        vision: provider({ provider: "xai" }),
        embedding: provider({ provider: "openai-compatible" })
      }
    },
    ...input
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Product compact multi-capability health", () => {
  it("renders YUVI, Memory, Voice, and Lumi as compact product groups", () => {
    const markup = renderToStaticMarkup(
      <ProductCompactHealth health={health()} loading={false} error={null} />
    );

    expect(markup).toContain("YUVI");
    expect(markup).toContain("Memory");
    expect(markup).toContain("Voice");
    expect(markup).toContain("Lumi");
    expect(markup).toContain("Daily health");
  });

  it("keeps runtime availability separate from the overall health gate", () => {
    const items = productCompactHealthItems({
      health: health({ ok: false, database: { status: "unavailable" } }),
      loading: false,
      error: null
    });

    expect(items.find((item) => item.id === "yuvi")).toMatchObject({
      summary: "Available",
      tone: "ok"
    });
    expect(items.find((item) => item.id === "yuvi")?.detail).toContain(
      "overall health gate not passed"
    );
    expect(items.find((item) => item.id === "memory")).toMatchObject({
      summary: "Unavailable",
      tone: "bad"
    });
  });

  it("does not turn a healthy provider aggregate into healthy Voice", () => {
    const items = productCompactHealthItems({ health: health(), loading: false, error: null });
    const voice = items.find((item) => item.id === "voice");

    expect(voice).toMatchObject({ summary: "Configured · unverified", tone: "warn" });
    expect(voice?.detail).toContain("unknown (no cached live observation)");
    expect(voice?.summary).not.toBe("Healthy");
  });

  it("labels cached observations and leaves missing evidence unknown", () => {
    const observed = health({
      providers: {
        ...health().providers,
        optional: {
          ...health().providers.optional,
          tts: provider({ observed: "available" }),
          stt: provider({ observed: "unknown" })
        }
      }
    });
    const items = productCompactHealthItems({ health: observed, loading: false, error: null });
    const voice = items.find((item) => item.id === "voice");
    const lumi = items.find((item) => item.id === "lumi");

    expect(voice?.detail).toContain("available (cached live observation)");
    expect(voice?.detail).toContain("unknown (no cached live observation)");
    expect(lumi).toMatchObject({ summary: "Unknown", tone: "idle" });
  });

  it("does not render provider errors or secrets and performs no verification on render", () => {
    const verifyProvider = vi.spyOn(apiClient, "verifyProvider");
    const verifyProviderChain = vi.spyOn(apiClient, "verifyProviderChain");
    const markup = renderToStaticMarkup(
      <ProductCompactHealth
        health={health({
          providers: {
            ...health().providers,
            optional: {
              ...health().providers.optional,
              tts: provider({ lastError: "Authorization=sk-voice-secret" })
            }
          }
        })}
        loading={false}
        error="Authorization=sk-health-secret"
      />
    );

    expect(markup).not.toContain("sk-voice-secret");
    expect(markup).not.toContain("sk-health-secret");
    expect(verifyProvider).not.toHaveBeenCalled();
    expect(verifyProviderChain).not.toHaveBeenCalled();
  });

  it("keeps the Product IA split and Developer Dashboard entry reachable", () => {
    const markup = renderToStaticMarkup(<ProductWebUI />);
    expect(markup).toContain("Models &amp; Providers");
    expect(markup).toContain("AI Routing");
    expect(markup).toContain("Developer");
  });
});
