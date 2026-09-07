import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import type { AppContext } from "../context.js";
import type { ServerConfig } from "../config.js";
import { registerLocalServiceRoutes } from "./local-services.js";
import { registerSystemRoutes } from "./system.js";
import { restartDailyUseServices } from "../services/daily-use.js";
vi.mock("../services/daily-use.js", () => ({ restartDailyUseServices: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it("protects acoustic profile operations and accepts a bounded recording larger than Fastify's default", async () => {
  const profiles = {
    enroll: vi.fn(async (input) => ({ voiceProfileId: input.voiceProfileId, label: input.label })),
    list: vi.fn(async () => [])
  };
  const app = Fastify();
  await registerLocalServiceRoutes(
    app,
    { providers: { getSTTProvider: () => ({ voiceProfiles: profiles }) } } as unknown as AppContext,
    { runtimeMode: "development", dashboardDevToken: "test-token" } as ServerConfig
  );
  try {
    const payload = {
      audioBase64: "A".repeat(1_100_000),
      mimeType: "audio/wav",
      label: "Acoustic label"
    };
    expect((await app.inject({ method: "POST", url: "/voice-profiles", payload })).statusCode).toBe(
      401
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/voice-profiles",
          remoteAddress: "192.0.2.1",
          headers: { authorization: "Bearer test-token" },
          payload
        })
      ).statusCode
    ).toBe(403);
    expect(profiles.enroll).not.toHaveBeenCalled();
    const response = await app.inject({
      method: "POST",
      url: "/voice-profiles",
      headers: { authorization: "Bearer test-token" },
      payload: { ...payload, personId: "forged-person", voiceProfileId: "forged-profile" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      label: "Acoustic label",
      voiceProfileId: expect.any(String)
    });
    expect(response.json().voiceProfileId).not.toBe("forged-profile");
    expect(profiles.enroll.mock.calls[0]?.[0]).not.toHaveProperty("personId");
  } finally {
    await app.close();
  }
});

it("only schedules the fixed daily restart for an authenticated local request under the launcher", async () => {
  const app = Fastify();
  await registerSystemRoutes(app, {
    runtimeMode: "development",
    dashboardDevToken: "test-token"
  } as ServerConfig);
  const request = {
    method: "POST" as const,
    url: "/system/local-services/restart",
    headers: { authorization: "Bearer test-token" }
  };
  try {
    vi.stubEnv("YUVI_DAILY_USE_SYSTEMD", "0");
    expect((await app.inject(request)).statusCode).toBe(409);
    vi.stubEnv("YUVI_DAILY_USE_SYSTEMD", "1");
    expect((await app.inject({ ...request, headers: {} })).statusCode).toBe(401);
    expect((await app.inject({ ...request, remoteAddress: "192.0.2.1" })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          ...request,
          headers: { ...request.headers, origin: "https://unrelated.example" }
        })
      ).statusCode
    ).toBe(403);
    expect(restartDailyUseServices).not.toHaveBeenCalled();
    if (process.platform === "linux") {
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      expect(
        (await app.inject({ ...request, payload: { unit: "postgres.service" } })).statusCode
      ).toBe(200);
      expect(restartDailyUseServices).not.toHaveBeenCalled();
      vi.advanceTimersByTime(300);
      expect(restartDailyUseServices).toHaveBeenCalledWith();
    }
  } finally {
    await app.close();
  }
});
