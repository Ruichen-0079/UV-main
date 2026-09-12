import { afterEach, describe, expect, it, vi } from "vitest";
import { DotsTTSProvider } from "./DotsTTSProvider.js";
const provider = () =>
  new DotsTTSProvider({ baseUrl: "http://127.0.0.1:9881", model: "dots-studio/dots.tts-soar" });
const wav = () => {
  const bytes = new Uint8Array(48);
  bytes.set(new TextEncoder().encode("RIFF"));
  bytes.set(new TextEncoder().encode("WAVE"), 8);
  return new Response(bytes);
};
afterEach(() => vi.restoreAllMocks());
describe("dots local adapter", () => {
  it.each(["ja", "en", "zh"])(
    "passes explicit %s without reference/model assets in requests",
    async (language) => {
      const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(wav());
      await provider().synthesizeSpeech({
        text: "同じ文字",
        metadata: { language },
        format: "wav"
      });
      const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
      expect(body).toEqual({
        requestId: expect.any(String),
        text: "同じ文字",
        language: language.toUpperCase()
      });
    }
  );
  it("does no work for an already cancelled call", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(
      provider().synthesizeSpeech({ text: "hello" }, { signal: AbortSignal.abort() })
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("discards late audio and cancels the concrete service request", async () => {
    const controller = new AbortController();
    let release!: (response: Response) => void;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/cancel")) return new Response("{}");
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const result = provider().synthesizeSpeech({ text: "hello" }, { signal: controller.signal });
    controller.abort();
    release(wav());
    await expect(result).rejects.toMatchObject({ code: "CANCELLED" });
    expect(fetch.mock.calls.map(([url]) => url)).toContain("http://127.0.0.1:9881/cancel");
  });
  it("reports warming as unavailable and rejects arbitrary JSON readiness", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ service: "yuvi-dots-tts", state: "warming" }), {
          status: 503
        })
      );
    expect(await provider().healthCheck()).toMatchObject({
      available: false,
      message: "Local TTS warming."
    });
    fetch.mockResolvedValue(new Response("{}"));
    expect(await provider().healthCheck()).toMatchObject({ available: false });
  });
  it("reports hibernated local TTS as available ready-on-demand", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          service: "yuvi-dots-tts",
          state: "hibernated",
          model_loaded: false,
          ready_on_demand: true
        }),
        { status: 200 }
      )
    );
    expect(await provider().healthCheck()).toMatchObject({
      available: true,
      status: "healthy",
      message: "Local TTS ready on demand."
    });
  });

  it("rejects non-audio success bodies", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await expect(provider().synthesizeSpeech({ text: "hello" })).rejects.toThrow();
  });

  it("retries a transient 503 warming response, then returns audio", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "warming" }), { status: 503 }))
      .mockResolvedValue(wav());
    const output = await provider().synthesizeSpeech({ text: "hello" });
    expect(new TextDecoder().decode(output.audio.slice(0, 4))).toBe("RIFF");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0]?.[0])).toBe("http://127.0.0.1:9881/tts");
  });

  it("keeps the existing 429 busy retry behavior", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "busy" }), { status: 429 }))
      .mockResolvedValue(wav());
    const output = await provider().synthesizeSpeech({ text: "hello" });
    expect(new TextDecoder().decode(output.audio.slice(0, 4))).toBe("RIFF");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails truthfully once repeated 503s exhaust the transport bound", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ error: "warming" }), { status: 503 }));
    const bounded = new DotsTTSProvider({
      baseUrl: "http://127.0.0.1:9881",
      model: "dots-studio/dots.tts-soar",
      timeoutMs: 450
    });
    const startedAt = Date.now();
    await expect(bounded.synthesizeSpeech({ text: "hello" })).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
  });

  it("exits promptly when aborted during a 503 retry wait", async () => {
    const controller = new AbortController();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/cancel")) return new Response("{}");
      return new Response(JSON.stringify({ error: "warming" }), { status: 503 });
    });
    const pending = provider().synthesizeSpeech({ text: "hello" }, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    const startedAt = Date.now();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(fetch.mock.calls.map(([url]) => String(url))).toContain(
      "http://127.0.0.1:9881/cancel"
    );
  });

  it.each([400, 500])("fails immediately on HTTP %i without retrying", async (status) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status }));
    await expect(provider().synthesizeSpeech({ text: "hello" })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
