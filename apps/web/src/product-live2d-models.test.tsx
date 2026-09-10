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
    importLive2DZip: vi.fn(),
    selectLive2DModel: vi.fn(),
    removeLive2DModel: vi.fn()
  }
}));

import {
  LIVE2D_ZIP_MAX_BYTES,
  ProductLive2DModels,
  defaultLive2DModelName,
  inspectLive2DArchiveSelection
} from "./product-live2d-models.js";

describe("ProductLive2DModels", () => {
  it("exposes ZIP as the only product import path", () => {
    const markup = renderToStaticMarkup(<ProductLive2DModels />);
    expect(markup).toContain('aria-label="Live2D ZIP"');
    expect(markup).toContain("Drop a Live2D ZIP here");
    expect(markup).toContain("Choose ZIP");
    expect(markup).toContain("Model name (optional)");
    expect(markup).toContain('accept=".zip,application/zip,application/x-zip-compressed"');
    expect(markup).not.toContain("Model directory");
    expect(markup).not.toContain("Model manifest");
    expect(markup).not.toContain("webkitdirectory");
    expect(markup).not.toContain("Or import an extracted directory:");
  });

  it("rejects cheap invalid selections before server validation", () => {
    const file = (name: string, size: number) => ({ name, size });
    expect(inspectLive2DArchiveSelection([])).toBe("empty-selection");
    expect(
      inspectLive2DArchiveSelection([file("one.zip", 1), file("two.zip", 1)])
    ).toBe("multiple-files");
    expect(inspectLive2DArchiveSelection([file("folder", 1)], true)).toBe("directory");
    expect(inspectLive2DArchiveSelection([file("model.rar", 1)])).toBe("not-zip");
    expect(inspectLive2DArchiveSelection([file("model.zip", 0)])).toBe("empty-file");
    expect(
      inspectLive2DArchiveSelection([file("model.zip", LIVE2D_ZIP_MAX_BYTES + 1)])
    ).toBe("too-large");
    expect(inspectLive2DArchiveSelection([file("MODEL.ZIP", 1024)])).toBeNull();
  });

  it("derives a bounded default model name from the ZIP filename", () => {
    expect(defaultLive2DModelName("Lumi.zip")).toBe("Lumi");
    expect(defaultLive2DModelName("  Companion.ZIP  ")).toBe("Companion");
    expect(defaultLive2DModelName(".zip")).toBe("Live2D model");
    expect(defaultLive2DModelName(`${"a".repeat(100)}.zip`)).toHaveLength(80);
  });
});
