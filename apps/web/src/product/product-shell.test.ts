import { describe, expect, it } from "vitest";
import { cn } from "../lib/cn.js";
import { parseProductHash, productHashFor } from "./product-hash.js";
import { compactHealthSummary } from "./HealthPills.js";
import { capabilityNormalView, memoryNormalView } from "./product-surface-view.js";
import type { ProductMemoryOverview, ProductMemorySurface } from "./product-client.js";

describe("product UI helpers", () => {
  it("merges class names without dropping later utilities", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });
});

describe("product hash routing", () => {
  it("defaults the companion surface to main, not the developer dashboard", () => {
    expect(parseProductHash("").surface).toBe("main");
    expect(parseProductHash("#/main").surface).toBe("main");
    expect(parseProductHash("#/dashboard").surface).toBe("dashboard");
  });

  it("opens settings, diagnostics, palette, and first-run from hash", () => {
    expect(parseProductHash("#/main/settings").settingsOpen).toBe(true);
    expect(parseProductHash("#/main/settings").settingsSection).toBe("general");
    expect(parseProductHash("#/main/settings/memory").settingsSection).toBe("memory");
    expect(parseProductHash("#/main/settings/capabilities").settingsSection).toBe("mcp");
    expect(parseProductHash("#/main/diagnostics").diagnosticsOpen).toBe(true);
    expect(parseProductHash("#/main/palette").commandOpen).toBe(true);
    expect(parseProductHash("#/main/first-run").firstRunForced).toBe(true);
  });

  it("round-trips overlay hashes", () => {
    expect(productHashFor(parseProductHash("#/main/settings/providers"))).toBe(
      "#/main/settings/providers"
    );
    expect(productHashFor(parseProductHash("#/main/settings"))).toBe("#/main/settings");
    expect(productHashFor(parseProductHash("#/dashboard"))).toBe("#/dashboard");
  });
});

describe("health summary", () => {
  it("stays quiet when everything is ready", () => {
    const summary = compactHealthSummary([
      { id: "yuvi", label: "YUVI", state: "ready", tone: "ok", summary: "Ready" },
      { id: "memory", label: "Memory", state: "ready", tone: "ok", summary: "Ready" }
    ]);
    expect(summary.label).toBe("Ready");
    expect(summary.failed).toHaveLength(0);
  });

  it("surfaces a real unavailable or error state instead of a green Ready chip", () => {
    const summary = compactHealthSummary([
      { id: "yuvi", label: "YUVI", state: "ready", tone: "ok", summary: "Ready" },
      { id: "memory", label: "Memory", state: "unavailable", tone: "warn", summary: "Unavailable" }
    ]);
    expect(summary.label).toContain("Memory: Unavailable");
    expect(summary.tone).toBe("warn");
  });
});

describe("memory and capability normal views", () => {
  const overview: ProductMemoryOverview = {
    backend: "postgres",
    extractor: "llm",
    databaseConfigured: true,
    ingestion: { status: "idle", pendingCount: 0, terminalFailedCount: 0 },
    compression: { classification: "IMPLEMENTED_PRIMITIVE_NOT_RUNTIME_ACTIVE", operational: false },
    idleDream: { classification: "DEFERRED / NOT_RUNTIME_ACTIVE", operational: false }
  };

  it("projects Memory into status, layer cards, counts, and Dream without burying errors", () => {
    const surface: ProductMemorySurface = {
      l0: { name: "DirectContext", description: "Near-verbatim recent completed turns." },
      l1: {
        name: "Recent episodic ledger",
        episodes: [{ id: "e1", status: "closed", whatHappened: "Talked about routing" }]
      },
      l2: {
        name: "Durable MemoryEvent evidence",
        state: "unavailable",
        tone: "warn",
        summary: "Unavailable",
        epistemic: "unavailable",
        query: "routing",
        events: []
      },
      dream: { idleClassification: "DEFERRED / NOT_RUNTIME_ACTIVE", dueJobs: [] }
    };
    const view = memoryNormalView({
      overview,
      surface,
      memoryHealth: {
        id: "memory",
        label: "Memory",
        state: "unavailable",
        tone: "warn",
        summary: "Unavailable"
      }
    });
    expect(view.overall.summary).toBe("Unavailable");
    expect(view.overall.detail).toContain("Retrieval unavailable");
    expect(view.episodeCount).toBe(1);
    expect(view.layers).toHaveLength(3);
    expect(view.dream.operational).toBe(false);
    expect(view.durableStatus).toBe("Unavailable");
  });

  it("keeps the MCP page observational and lists capability, status, and description", () => {
    const view = capabilityNormalView({
      authority: "Runtime admission + static MCP allowlist",
      userConfigurableServers: false,
      deferredReason: "No user-editable MCP server catalog.",
      version: "6k",
      capabilities: [
        { capabilityRef: "capability://opaque/repository-read", toolName: "read_text_file" }
      ],
      descriptions: [
        {
          capabilityRef: "capability://opaque/repository-read",
          description: "Read one authorized repository text file without modifying it."
        }
      ]
    });
    expect(view.editable).toBe(false);
    expect(view.notice).toContain("No user-editable");
    expect(view.rows[0]).toMatchObject({
      name: "read_text_file",
      status: "Allowlisted"
    });
    expect(view.rows[0]?.description).toContain("authorized repository");
  });
});
