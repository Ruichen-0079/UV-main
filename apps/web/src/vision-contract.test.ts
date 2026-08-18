import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "./api/client.js";
import {
  extractVisionRawBase64,
  normalizeVisionImageMimeType,
  toVisionFileInput
} from "./vision-input.js";

afterEach(() => {
  apiClient.setDashboardDevToken("");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Vision web input contract", () => {
  it("keeps only the supported file MIME values and normalizes JPEG aliases", () => {
    expect(normalizeVisionImageMimeType("image/png")).toBe("image/png");
    expect(normalizeVisionImageMimeType("IMAGE/JPEG")).toBe("image/jpeg");
    expect(normalizeVisionImageMimeType("image/jpg; charset=binary")).toBe("image/jpeg");
    expect(normalizeVisionImageMimeType("image/webp")).toBeUndefined();
    expect(normalizeVisionImageMimeType("image/gif")).toBeUndefined();
  });

  it("strips only the data URL prefix while preserving the raw base64 payload", () => {
    expect(extractVisionRawBase64("data:image/jpeg;base64,AQID")).toBe("AQID");
    expect(extractVisionRawBase64("AQID")).toBe("AQID");
  });

  it("keeps the selected file MIME with its raw base64 payload", () => {
    expect(toVisionFileInput("data:image/png;base64,AQID", "image/png")).toEqual({
      imageBase64: "AQID",
      mimeType: "image/png"
    });
    expect(toVisionFileInput("data:image/jpeg;base64,BAUG", "image/jpeg")).toEqual({
      imageBase64: "BAUG",
      mimeType: "image/jpeg"
    });
    expect(() => toVisionFileInput("data:image/webp;base64,AQID", "image/webp")).toThrow(
      "Only PNG and JPEG image files are supported."
    );
  });

  it("passes the exact AbortSignal to fetch without serializing it", async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ analysis: "scene" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await apiClient.analyzeVision({
      imageBase64: "AQID",
      mimeType: "image/jpeg",
      prompt: "describe",
      signal
    });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.signal).toBe(signal);
    expect(JSON.parse(String(init?.body))).toEqual({
      imageBase64: "AQID",
      mimeType: "image/jpeg",
      prompt: "describe"
    });
  });

  it("attaches the dashboard token only to the protected settings GET", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    apiClient.setDashboardDevToken("dashboard-secret");

    await apiClient.getRuntimeSettings();
    await apiClient.getHealth();
    await apiClient.getProviderStatus();
    await apiClient.listRecentMemoryCandidates();

    const calls = fetchMock.mock.calls as unknown as Array<
      [RequestInfo | URL, RequestInit | undefined]
    >;
    expect(new Headers(calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer dashboard-secret"
    );
    expect(new Headers(calls[1]?.[1]?.headers).get("authorization")).toBeNull();
    expect(new Headers(calls[2]?.[1]?.headers).get("authorization")).toBeNull();
    expect(new Headers(calls[3]?.[1]?.headers).get("authorization")).toBe(
      "Bearer dashboard-secret"
    );
  });

  it("does not attach a dashboard token when none is configured", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await apiClient.getRuntimeSettings();

    const calls = fetchMock.mock.calls as unknown as Array<
      [RequestInfo | URL, RequestInit | undefined]
    >;
    expect(new Headers(calls[0]?.[1]?.headers).get("authorization")).toBeNull();
  });
});
