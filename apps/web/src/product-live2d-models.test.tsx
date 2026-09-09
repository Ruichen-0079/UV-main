import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./api/client.js", () => ({
  apiClient: {
    getLive2DModels: vi.fn(async () => ({
      models: [],
      activeId: null,
      activeUrl: null,
      intendedDefault: "Hiyori Momose"
    })),
    importLive2DModel: vi.fn(),
    importLive2DZip: vi.fn(),
    selectLive2DModel: vi.fn(),
    removeLive2DModel: vi.fn()
  }
}));

import { ProductLive2DModels } from "./product-live2d-models.js";

describe("ProductLive2DModels", () => {
  it("offers direct ZIP import while retaining extracted-directory fallback", () => {
    const markup = renderToStaticMarkup(<ProductLive2DModels />);
    expect(markup).toContain('aria-label="Live2D ZIP"');
    expect(markup).toContain('accept=".zip,application/zip"');
    expect(markup).toContain('aria-label="Model directory"');
    expect(markup).toContain("Or import an extracted directory:");
    expect(markup).not.toContain("VTube Studio path");
  });
});
