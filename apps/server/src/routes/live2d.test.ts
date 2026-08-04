import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerLive2DCoreRoute, registerLive2DRoutes } from "./live2d.js";

describe("Live2D asset route", () => {
  it("serves only configured files and never exposes the filesystem root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yuvi-live2d-"));
    await writeFile(path.join(root, "Lumi.model3.json"), '{"Version":3}');
    const app = Fastify({ logger: false });
    await registerLive2DRoutes(app, { live2dAssetRoot: root } as never);

    const model = await app.inject({ method: "GET", url: "/live2d/Lumi.model3.json" });
    expect(model.statusCode).toBe(200);
    expect(model.headers["content-type"]).toContain("application/json");
    expect(model.body).toContain('"Version":3');

    const traversal = await app.inject({ method: "GET", url: "/live2d/%2e%2e%2fsecret.txt" });
    expect(traversal.statusCode).toBe(400);

    const directory = await app.inject({ method: "GET", url: "/live2d/" });
    expect(directory.statusCode).toBe(400);

    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  it("reports unavailable when no asset root is configured", async () => {
    const app = Fastify({ logger: false });
    await registerLive2DRoutes(app, {} as never);
    const response = await app.inject({ method: "GET", url: "/live2d/Lumi.model3.json" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "live2d_unavailable" });
    await app.close();
  });

  it("serves only the explicitly configured official Core file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yuvi-core-"));
    const corePath = path.join(root, "live2dcubismcore.min.js");
    await writeFile(corePath, "window.Live2DCubismCore = {};", "utf8");
    const app = Fastify({ logger: false });
    await registerLive2DCoreRoute(app, { live2dCorePath: corePath } as never);

    const core = await app.inject({ method: "GET", url: "/live2d-core/live2dcubismcore.min.js" });
    expect(core.statusCode).toBe(200);
    expect(core.headers["content-type"]).toContain("application/javascript");
    expect(core.body).toContain("Live2DCubismCore");

    const other = await app.inject({ method: "GET", url: "/live2d-core/anything.js" });
    expect(other.statusCode).toBe(404);

    await app.close();
    await rm(root, { recursive: true, force: true });
  });
});
