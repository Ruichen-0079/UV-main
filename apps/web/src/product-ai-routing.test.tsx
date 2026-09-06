import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  apiClient,
  type ProviderChainInspectionResponse,
  type ProviderRouteHealth,
  type ProvidersStatusResponse,
  type RuntimeSettingsResponse
} from "./api/client.js";
import {
  PRODUCT_ROUTING_DEFINITIONS,
  ProductAIRouting,
  ProductRoutingCard,
  inspectProductRouting,
  productRoutingMatchLabel,
  productRoutingRouteSummary,
  productRoutingTruth,
  updateProductRouting
} from "./product-ai-routing.js";
import { ProductWebUI } from "./product-webui.js";
import { PRODUCT_PROVIDER_DEFINITIONS } from "./product-models-providers.js";

function settingsFixture(
  chain = "deepseek,nvidia",
  pendingRestart = false
): RuntimeSettingsResponse {
  return {
    settings: {
      CHAT_PROVIDER_CHAIN: {
        base: chain,
        localOverride: "",
        effective: chain,
        source: ".env"
      },
      REASONING_PROVIDER_CHAIN: {
        base: "deepseek,local",
        localOverride: "",
        effective: "deepseek,local",
        source: ".env"
      },
      EMBEDDING_PROVIDER_CHAIN: {
        base: "openai-compatible,nvidia,local,mock",
        localOverride: "",
        effective: "openai-compatible,nvidia,local,mock",
        source: ".env"
      }
    },
    restartRequired: pendingRestart,
    runtime: { pendingRestart }
  } as unknown as RuntimeSettingsResponse;
}

function route(
  capability: "chat" | "reasoning" | "embedding",
  provider: string,
  priority: number,
  overrides: Partial<ProviderRouteHealth> = {}
): ProviderRouteHealth {
  return {
    provider,
    name: provider,
    capability,
    status: "degraded",
    readiness: "ready",
    observed: "unknown",
    checkedAt: "2026-09-06T00:00:00.000Z",
    enabled: true,
    priority,
    fallbackEligible: true,
    ...overrides
  };
}

function providerStatusFixture(): ProvidersStatusResponse {
  const chatPrimary = route("chat", "deepseek", 1, { model: "deepseek-chat" });
  const chatFallback = route("chat", "nvidia", 2, {
    readiness: "not_ready",
    fallbackEligible: false,
    model: "nvidia-chat"
  });
  const reasoning = route("reasoning", "deepseek", 1, { model: "deepseek-reasoner" });
  const embedding = route("embedding", "openai-compatible", 1, {
    model: "text-embedding-3-small"
  });
  return {
    providers: {
      chat: chatPrimary,
      reasoning,
      tts: route("chat", "xai", 1),
      stt: route("chat", "dashscope", 1),
      vision: route("chat", "xai", 1),
      embedding
    },
    routes: {
      chat: [chatPrimary, chatFallback],
      reasoning: [reasoning],
      embedding: [embedding],
      tts: [],
      stt: [],
      vision: []
    }
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Product AI Routing", () => {
  it("renders current chain order, priority, readiness, observation, and fallback state", () => {
    const markup = renderToStaticMarkup(
      <ProductRoutingCard
        definition={PRODUCT_ROUTING_DEFINITIONS[0]!}
        settings={settingsFixture()}
        providerStatus={providerStatusFixture()}
        draft="deepseek,nvidia"
        saving={false}
        inspecting={false}
        inspection={undefined}
        onChange={() => undefined}
        onSave={() => undefined}
        onInspect={() => undefined}
      />
    );

    expect(markup).toContain("deepseek → nvidia");
    expect(markup).toContain("#1");
    expect(markup).toContain("#2");
    expect(markup).toContain("ready (local configuration)");
    expect(markup).toContain("unknown (no cached live observation)");
    expect(markup).toContain("Fallback eligible");
    expect(markup).toContain("Not fallback eligible");
    expect(markup).toContain("deepseek-chat");
  });

  it("keeps saved/effective and active route truth separate", () => {
    const matching = productRoutingTruth(settingsFixture(), providerStatusFixture(), "chat");
    expect(matching.activeChain).toBe("deepseek,nvidia");
    expect(matching.activeMatchesSaved).toBe(true);
    expect(matching.activeProvider).toBe("deepseek");
    expect(matching.activeModel).toBe("deepseek-chat");

    const pending = productRoutingTruth(
      settingsFixture("nvidia,deepseek", true),
      providerStatusFixture(),
      "chat"
    );
    expect(pending.activeMatchesSaved).toBe(false);
    expect(pending.pendingRestart).toBe(true);
    expect(productRoutingMatchLabel(pending)).toBe("Saved chain differs from active route");

    const unknown = productRoutingTruth(settingsFixture(), null, "chat");
    expect(unknown.activeChain).toBeNull();
    expect(unknown.activeMatchesSaved).toBeNull();
    expect(productRoutingMatchLabel(unknown)).toBe("Active route order is unknown");
  });

  it("does not expose route secrets in the presentation summary", () => {
    const summary = productRoutingRouteSummary(
      route("chat", "deepseek", 1, {
        baseUrl: "https://user:secret@example.invalid/v1",
        lastError: "Authorization=sk-secret-value"
      })
    );
    expect(JSON.stringify(summary)).not.toContain("secret");
    expect(JSON.stringify(summary)).not.toContain("Authorization");
  });

  it("calls chain inspection only through the explicit inspection action seam", async () => {
    const response: ProviderChainInspectionResponse = {
      ok: true,
      capability: "chat",
      configOnly: true,
      verificationMode: "config_only",
      readyRouteCount: 1,
      routes: providerStatusFixture().routes!.chat,
      attemptedProviders: providerStatusFixture().routes!.chat.map((item) => ({
        provider: item.provider,
        status: "skipped" as const,
        priority: item.priority
      })),
      message: "No provider route was called."
    };
    const spy = vi.spyOn(apiClient, "verifyProviderChain").mockResolvedValue(response);
    expect(spy).not.toHaveBeenCalled();
    await expect(inspectProductRouting("chat")).resolves.toBe(response);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("chat");
  });

  it("updates routing through current Runtime settings and reload authority", async () => {
    const saved = {
      ok: true,
      restartRequired: false,
      changedKeys: ["CHAT_PROVIDER_CHAIN"],
      settings: settingsFixture()
    };
    const applied = {
      ok: true,
      applied: true,
      restartRequired: false,
      active: { providers: providerStatusFixture().providers, memoryRepository: "in-memory" },
      notHotReloaded: [],
      message: "Hot-reloadable settings applied.",
      settings: settingsFixture()
    };
    const updateSpy = vi
      .spyOn(apiClient, "updateRuntimeSettings")
      .mockResolvedValue(
        saved as unknown as Awaited<ReturnType<typeof apiClient.updateRuntimeSettings>>
      );
    const reloadSpy = vi
      .spyOn(apiClient, "reloadRuntimeSettings")
      .mockResolvedValue(
        applied as unknown as Awaited<ReturnType<typeof apiClient.reloadRuntimeSettings>>
      );

    const result = await updateProductRouting("chat", "deepseek,nvidia");
    expect(updateSpy).toHaveBeenCalledWith({ values: { CHAT_PROVIDER_CHAIN: "deepseek,nvidia" } });
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(result.applyError).toBeNull();
    expect(result.applied).toBe(applied);
  });

  it("keeps the Product IA split and Developer Dashboard entry available", () => {
    const markup = renderToStaticMarkup(<ProductWebUI />);
    expect(markup).toContain("Models &amp; Providers");
    expect(markup).toContain("AI Routing");
    expect(markup).toContain("Developer");
    expect(PRODUCT_PROVIDER_DEFINITIONS.map((provider) => provider.id)).toEqual([
      "deepseek",
      "openai-compatible",
      "nvidia",
      "local",
      "xai",
      "dashscope",
      "embedding"
    ]);
  });

  it("renders the product routing loading state without provider calls", () => {
    const markup = renderToStaticMarkup(<ProductAIRouting />);
    expect(markup).toContain("AI Routing");
    expect(markup).toContain("Loading current routing settings");
    expect(markup).toContain("/providers/verify-chain/:capability");
  });
});
