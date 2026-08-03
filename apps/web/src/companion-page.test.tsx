import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CompanionPage } from "./companion-page.js";

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("CompanionPage Tauri chrome", () => {
  it("renders without crashing and without Tauri chrome in a plain browser", () => {
    expect(() => renderToStaticMarkup(<CompanionPage />)).not.toThrow();
    const markup = renderToStaticMarkup(<CompanionPage />);
    expect(markup).toContain("Lumi avatar");
    expect(markup).not.toContain("data-tauri-drag-region");
    expect(markup).not.toContain("调整窗口大小");
  });

  it("renders the drag bar and resize handle only inside Tauri", () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    const markup = renderToStaticMarkup(<CompanionPage />);
    expect(markup).toContain("data-tauri-drag-region");
    expect(markup).toContain('aria-label="调整窗口大小"');
  });
});
