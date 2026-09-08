import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./tauri-window.js", () => ({
  isTauriRuntime: () => true
}));

import { UserSettingsPanel } from "./user-settings-panel.js";

describe("UserSettingsPanel provider credentials", () => {
  it("shows the selected OpenAI-compatible connection in Chat without a DeepSeek key label", () => {
    const markup = renderToStaticMarkup(<UserSettingsPanel />);
    expect(markup).toContain("Providers, models, and voice routes are configured in Product configuration.");
    expect(markup).not.toContain("OpenAI-compatible API key");
    expect(markup).not.toContain("DeepSeek API key");
    expect(markup).not.toContain("Local STT model");
    expect(markup).toContain("Desktop");
  });
});
