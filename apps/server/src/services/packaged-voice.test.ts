import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { applyPackagedSpeechRoute, hasPackagedVoice } from "./packaged-voice.js";
import type { AppContext } from "../context.js";

const posted: Array<{ url: string; body: unknown }> = [];
const token = "t".repeat(64);

function stubSupervisorEndpoint() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-packaged-voice-"));
  const endpointFile = path.join(dir, "control-endpoint.json");
  fs.writeFileSync(endpointFile, JSON.stringify({ host: "127.0.0.1", port: 45678, controlToken: token }));
  vi.stubEnv("YUVI_PACKAGED", "1");
  vi.stubEnv("YUVI_SUPERVISOR_ENDPOINT_FILE", endpointFile);
  vi.stubEnv("YUVI_STT_SPEAKER_DIR", path.join(dir, "speakers"));
  vi.stubEnv("LOCAL_STT_BASE_URL", "http://127.0.0.1:19876");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      posted.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    })
  );
  return dir;
}

function contextWith(routes: { stt: string[] }, catalog: { models: Array<{ id: string; providerId: string; enabled: boolean }>; providers: Array<{ id: string; adapter: string; baseUrl: string }> }): AppContext {
  return {
    activeRuntimeEnv: { YUVI_PRODUCT_CONFIGURATION: JSON.stringify({ routes, models: catalog.models, providers: catalog.providers }) }
  } as unknown as AppContext;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  posted.length = 0;
});

it("is inert outside packaged mode", async () => {
  expect(hasPackagedVoice()).toBe(false);
  await applyPackagedSpeechRoute(contextWith({ stt: ["m1"] }, { models: [], providers: [] }));
  expect(posted).toHaveLength(0);
});

it("autostarts managed STT only when the Product route selects the managed endpoint", async () => {
  stubSupervisorEndpoint();
  await applyPackagedSpeechRoute(
    contextWith(
      { stt: ["m1"] },
      { models: [{ id: "m1", providerId: "p1", enabled: true }], providers: [{ id: "p1", adapter: "local-stt", baseUrl: "http://127.0.0.1:19876" }] }
    )
  );
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ url: "http://127.0.0.1:45678/v1/config", body: { env: { YUVI_AUTOSTART_LOCAL_STT: "1" } } });
});

it("routing STT to external 9876 disables managed autostart without touching 9876", async () => {
  stubSupervisorEndpoint();
  await applyPackagedSpeechRoute(
    contextWith(
      { stt: ["m1"] },
      { models: [{ id: "m1", providerId: "p1", enabled: true }], providers: [{ id: "p1", adapter: "local-stt", baseUrl: "http://127.0.0.1:9876" }] }
    )
  );
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ body: { env: { YUVI_AUTOSTART_LOCAL_STT: "0" } } });
  // Ownership stays with the managed service: only an autostart flag is sent,
  // never a start/stop against the routed endpoint.
  expect(JSON.stringify(posted)).not.toContain("9876");
  expect(JSON.stringify(posted)).not.toContain("/v1/services/");
});

it("no STT route leaves managed autostart disabled", async () => {
  stubSupervisorEndpoint();
  await applyPackagedSpeechRoute(contextWith({ stt: [] }, { models: [], providers: [] }));
  expect(posted[0]).toMatchObject({ body: { env: { YUVI_AUTOSTART_LOCAL_STT: "0" } } });
});
