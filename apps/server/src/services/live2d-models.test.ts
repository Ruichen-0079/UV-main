import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { Live2DModels, validateModelPackage } from "./live2d-models.js";
import { registerLive2DRoutes } from "../routes/live2d.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function root() {
  const value = await mkdtemp(path.join(os.tmpdir(), "yuvi-model-test-"));
  roots.push(value);
  return value;
}
function fixture() {
  const manifest = {
    Version: 3,
    FileReferences: {
      Moc: "a.moc3",
      Textures: ["texture.png"],
      Motions: { Idle: [{ File: "idle.motion3.json" }] },
      Expressions: [{ Name: "smile", File: "smile.exp3.json" }],
      Physics: "physics.json",
      Pose: "pose.json"
    }
  };
  return {
    name: "Synthetic",
    model: "sample/a.model3.json",
    files: Object.entries({
      "sample/a.model3.json": JSON.stringify(manifest),
      "sample/a.moc3": "MOC3synthetic",
      "sample/texture.png": Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      "sample/idle.motion3.json": "{}",
      "sample/smile.exp3.json": "{}",
      "sample/physics.json": "{}",
      "sample/pose.json": "{}"
    }).map(([path, data]) => ({ path, base64: Buffer.from(data).toString("base64") }))
  };
}
describe("durable Live2D models", () => {
  it("imports independent copies, selects, survives service recreation, and safely removes inactive models", async () => {
    const dir = await root();
    const service = new Live2DModels(dir);
    expect((await service.list()).activeUrl).toBeNull();
    const a = await service.import(fixture());
    const b = await service.import({ ...fixture(), name: "Second" });
    expect((await service.list()).activeId).toBeNull();
    await service.select(a.id);
    expect((await new Live2DModels(dir).list()).activeId).toBe(a.id);
    expect(await service.asset(a.id, "sample/a.moc3")).toContain(dir);
    await expect(service.remove(a.id)).rejects.toThrow("Select another");
    await service.select(b.id);
    await service.remove(a.id);
    expect((await new Live2DModels(dir).list()).models.map((m) => m.id)).toEqual([b.id]);
    await expect(service.remove("configured")).rejects.toThrow("Only user");
    await expect(service.select("missing")).rejects.toThrow("not installed");
    await service.select(null);
    await service.remove(b.id);
    expect((await new Live2DModels(dir).list()).activeId).toBeNull();
    expect((await service.list()).models).toEqual([]);
  });
  it.each([
    "sample/a.moc3",
    "sample/texture.png",
    "sample/idle.motion3.json",
    "sample/smile.exp3.json",
    "sample/physics.json",
    "sample/pose.json"
  ])("rejects a missing referenced asset: %s", (missing) => {
    const input = fixture();
    input.files = input.files.filter((f) => f.path !== missing);
    expect(() => validateModelPackage(input)).toThrow("Missing referenced");
  });
  it.each([
    "../escape",
    "sample/../escape",
    "/absolute",
    "C:/escape",
    "sample\\escape",
    "sample/%2e%2e/escape"
  ])("rejects traversal and platform-dependent paths: %s", (name) => {
    const input = fixture();
    input.files.push({ path: name, base64: "YQ==" });
    expect(() => validateModelPackage(input)).toThrow("Invalid");
  });
  it("rejects duplicate and invalid binary/JSON files without installing a partial model", async () => {
    const service = new Live2DModels(await root());
    const input = fixture();
    input.files.push(input.files[0]!);
    await expect(service.import(input)).rejects.toThrow("duplicate");
    const broken = fixture();
    broken.files.find((f) => f.path.endsWith(".moc3"))!.base64 =
      Buffer.from("not a model").toString("base64");
    await expect(service.import(broken)).rejects.toThrow("header");
    expect((await service.list()).models).toEqual([]);
  });
  it("does not serve symlinks escaping the installed asset root", async () => {
    const dir = await root();
    const service = new Live2DModels(dir);
    const entry = await service.import(fixture());
    const outside = path.join(await root(), "secret");
    await writeFile(outside, "private");
    await symlink(outside, path.join(dir, entry.id, "assets", "escape"));
    expect(await service.asset(entry.id, "escape")).toBeNull();
  });
  it("exposes truthful route effects, validation errors and restart persistence", async () => {
    const dir = await root();
    const make = async () => {
      const app = Fastify();
      await registerLive2DRoutes(app, { live2dModelsRoot: dir } as never);
      return app;
    };
    let app = await make();
    const invalid = await app.inject({
      method: "POST",
      url: "/live2d/models/import",
      payload: { name: "bad", files: [] }
    });
    expect(invalid.statusCode).toBe(400);
    const imported = await app.inject({
      method: "POST",
      url: "/live2d/models/import",
      payload: fixture()
    });
    expect(imported.statusCode).toBe(200);
    const id = imported.json().id;
    expect(
      (await app.inject({ method: "POST", url: "/live2d/models/select", payload: { id } })).json()
        .activeId
    ).toBe(id);
    await app.close();
    app = await make();
    expect((await app.inject("/live2d/models")).json().activeId).toBe(id);
    expect((await app.inject(`/live2d/models/${id}/sample/a.model3.json`)).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/live2d/models/${id}` })).statusCode).toBe(
      409
    );
    await app.close();
  });
});
