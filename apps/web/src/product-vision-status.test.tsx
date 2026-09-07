import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ProductVisionStatus } from "./product-vision-status.js";
const state = vi.hoisted(() => ({ config: undefined as any }));
vi.mock("./hooks/useAsyncData.js", () => ({
  useAsyncData: () => ({
    data: { activeRuntimeConfig: state.config },
    error: null,
    refresh: vi.fn()
  })
}));
it.each([true, false, undefined])(
  "shows only known configuration and capability truth (%s)",
  (available) => {
    state.config =
      available === undefined
        ? undefined
        : {
            visualGroundingAvailable: available,
            providers: {
              vision: { configured: available, readiness: available ? "ready" : "not_ready" }
            }
          };
    const html = renderToStaticMarkup(<ProductVisionStatus />);
    expect(html).toContain(
      available === undefined ? "Unknown" : available ? "Configured" : "Unconfigured"
    );
    expect(html).toContain(
      available === undefined ? "Unknown" : available ? "Available" : "Unavailable"
    );
    expect(html).not.toMatch(/history|timeline|monitoring|live verified/i);
  }
);
