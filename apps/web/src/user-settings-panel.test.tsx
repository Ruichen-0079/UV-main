import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./tauri-window.js", () => ({
  isTauriRuntime: () => true
}));

import { UserSettingsPanel } from "./user-settings-panel.js";

describe("UserSettingsPanel product boundary", () => {
  it("keeps normal settings product-facing and hides deployment topology", () => {
    const markup = renderToStaticMarkup(<UserSettingsPanel />);

    expect(markup).toContain("Providers, models, and voice routes are configured in Product configuration.");
    expect(markup).toContain("Memory");
    expect(markup).toContain("Enabled");
    expect(markup).toContain("YUVI manages Memory storage and service topology automatically.");
    expect(markup).toContain("YUVI manages the Runtime lifecycle automatically.");
    expect(markup).toContain("UI language");

    for (const hidden of [
      "Connection mode",
      "Start the local service automatically",
      "Service URL",
      "Memory backend",
      "Mem0 URL",
      "Ollama URL",
      "DATABASE_URL",
      "Memory inference",
      "Memory LLM Provider",
      "Memory LLM Model",
      "Memory LLM Base URL",
      "Memory LLM API key",
      "Paste connection string",
      "Paste Memory LLM API key"
    ]) {
      expect(markup).not.toContain(hidden);
    }

    expect(markup).not.toContain("OpenAI-compatible API key");
    expect(markup).not.toContain("DeepSeek API key");
    expect(markup).not.toContain("Local STT model");
    expect(markup).not.toContain("Subject User ID");
    expect(markup).not.toContain("Persona ID");
    expect(markup).not.toContain("Companion always on top");
  });
});
