import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./tauri-window.js", () => ({
  isTauriRuntime: () => true
}));

import { UserSettingsPanel } from "./user-settings-panel.js";

describe("UserSettingsPanel provider credentials", () => {
  it("shows the selected OpenAI-compatible connection in Chat without a DeepSeek key label", () => {
    const markup = renderToStaticMarkup(<UserSettingsPanel />);
    expect(markup).toContain("OpenAI-compatible base URL");
    expect(markup).toContain("OpenAI-compatible API key");
    expect(markup).not.toContain("DeepSeek API key");
    expect(markup).toContain("Uses the same OpenAI-compatible connection configured in Chat.");
  });
});
