import { afterEach, expect, it, vi } from "vitest";
import { dailyStatusPlugin } from "./daily-status-plugin.js";
import { projectDailyServiceStatus } from "./daily-service-status.js";
import fs from "node:fs/promises";
vi.mock("node:fs/promises", () => ({ default: { readFile: vi.fn() } }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function snapshot() {
  return {
    instanceId: "current",
    services: ["postgres", "ollama", "mem0", "runtime", "local_stt", "tts_wrapper"].map((id) => ({
      id,
      checkedAt: "2026-09-07T00:00:00.000Z",
      status:
        id === "postgres" || id === "runtime"
          ? "unavailable"
          : id === "mem0"
            ? "degraded"
            : "healthy",
      managed: id === "mem0" || id === "runtime",
      url: "postgres://user:private@localhost/db",
      detail: "private",
      lastError: "private",
      pid: 123
    }))
  };
}
function middleware() {
  let handler: any;
  const plugin = dailyStatusPlugin();
  (plugin.configureServer as Function)({
    middlewares: {
      use: (fn: unknown) => {
        handler = fn;
      }
    }
  });
  return handler;
}
function response() {
  return { statusCode: 200, setHeader: vi.fn(), end: vi.fn() };
}
function files(host = "127.0.0.1") {
  vi.mocked(fs.readFile).mockResolvedValueOnce(
    JSON.stringify({ instanceId: "current", endpointFile: "/endpoint" })
  );
  vi.mocked(fs.readFile).mockResolvedValueOnce(
    JSON.stringify({ instanceId: "current", host, port: 12345, controlToken: "private" })
  );
}
it("is absent outside the daily launcher and never accepts actions", async () => {
  vi.stubEnv("YUVI_DAILY_USE_SYSTEMD", "0");
  expect(middleware()).toBeUndefined();
  vi.stubEnv("YUVI_DAILY_USE_SYSTEMD", "1");
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const res = response();
  await middleware()({ url: "/yuvi-daily/status", method: "POST" }, res, vi.fn());
  expect(res.statusCode).toBe(405);
  expect(fetcher).not.toHaveBeenCalled();
});
it("reports prerequisite failure while Runtime is down without exposing credentials", async () => {
  vi.stubEnv("YUVI_DAILY_USE_SYSTEMD", "1");
  files();
  const fetcher = vi.fn(async () => new Response(JSON.stringify(snapshot())));
  vi.stubGlobal("fetch", fetcher);
  const res = response();
  await middleware()({ url: "/yuvi-daily/status", method: "GET" }, res, vi.fn());
  expect(fetcher).toHaveBeenCalledWith(
    "http://127.0.0.1:12345/v1/status",
    expect.objectContaining({ redirect: "error" })
  );
  const body = res.end.mock.calls[0]![0];
  expect(body).not.toContain("private");
  expect(JSON.parse(body).checkedAt).toBe("2026-09-07T00:00:00.000Z");
  expect(body).not.toContain("url");
  expect(JSON.parse(body).services).toEqual([
    { id: "postgres", status: "unavailable", managed: false },
    { id: "ollama", status: "healthy", managed: false },
    { id: "mem0", status: "degraded", managed: true },
    { id: "runtime", status: "unavailable", managed: true },
    { id: "local_stt", status: "healthy", managed: false },
    { id: "tts_wrapper", status: "healthy", managed: false }
  ]);
  expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
});
it("rejects non-loopback discovery before sending the token", async () => {
  vi.stubEnv("YUVI_DAILY_USE_SYSTEMD", "1");
  files("remote.invalid");
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const res = response();
  await middleware()({ url: "/yuvi-daily/status", method: "GET" }, res, vi.fn());
  expect(res.statusCode).toBe(503);
  expect(fetcher).not.toHaveBeenCalled();
});
it("does not reuse stale status or serialize upstream failures", async () => {
  vi.stubEnv("YUVI_DAILY_USE_SYSTEMD", "1");
  files();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("private");
    })
  );
  const res = response();
  await middleware()({ url: "/yuvi-daily/status", method: "GET" }, res, vi.fn());
  expect(res.statusCode).toBe(503);
  expect(res.end).toHaveBeenCalledWith('{"error":"Supervisor status unavailable"}');
});
it("fails closed on incomplete or unexpected lifecycle states", () => {
  expect(() => projectDailyServiceStatus({ services: [] })).toThrow();
  const data = snapshot();
  data.services[0]!.status = "private";
  expect(() => projectDailyServiceStatus(data)).toThrow();
});
