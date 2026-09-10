import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import {
  Live2DModels,
  modelPackageFromZip,
  safeModelPath,
  validateModelPackage
} from "./live2d-models.js";
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
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipFixture(entries: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, eocd]);
}

function vtsZipFixture(): Buffer {
  const expression = "expressions/#U4e09%smile.exp3.json";
  const manifest = {
    Version: 3,
    FileReferences: {
      Moc: "Lumi.moc3",
      Textures: ["textures/texture_00.png"],
      Expressions: [{ Name: "smile", File: expression }]
    }
  };
  return zipFixture({
    "Lumi/Lumi.model3.json": JSON.stringify(manifest),
    "Lumi/Lumi.moc3": "MOC3synthetic",
    "Lumi/textures/texture_00.png": Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    [`Lumi/${expression}`]: "{}",
    "Lumi/vtube.json": JSON.stringify({ hotkeys: true }),
    "__MACOSX/ignored": "metadata"
  });
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
  it("normalizes VTube Studio URL-special filenames and rewrites model references", () => {
    expect(safeModelPath("Lumi/expressions/#U4e09%smile.exp3.json")).toBe(false);
    const input = modelPackageFromZip({
      name: "Lumi VTS",
      archiveBase64: vtsZipFixture().toString("base64")
    });
    expect(input.model).toBe("Lumi/Lumi.model3.json");
    const expression = input.files.find((file) => file.path.includes("exp3.json"));
    expect(expression?.path).toBe("Lumi/expressions/~23~U4e09~25~smile.exp3.json");
    const manifest = JSON.parse(
      Buffer.from(input.files.find((file) => file.path === input.model)!.base64, "base64").toString()
    );
    expect(manifest.FileReferences.Expressions[0].File).toBe(
      "expressions/~23~U4e09~25~smile.exp3.json"
    );
    expect(() => validateModelPackage(input)).not.toThrow();
  });

  it("rejects ambiguous or traversal ZIP packages before durable installation", () => {
    const multiple = zipFixture({
      "a/a.model3.json": "{}",
      "b/b.model3.json": "{}"
    });
    expect(() =>
      modelPackageFromZip({ name: "ambiguous", archiveBase64: multiple.toString("base64") })
    ).toThrow("exactly one");

    const traversal = zipFixture({ "../escape.model3.json": "{}" });
    expect(() =>
      modelPackageFromZip({ name: "escape", archiveBase64: traversal.toString("base64") })
    ).toThrow("Unsafe ZIP entry path");
  });

  it("rejects ZIPs with no model manifest and malformed archive bytes", async () => {
    const noManifest = zipFixture({ "README.txt": "no model here" });
    expect(() =>
      modelPackageFromZip({ name: "missing", archiveBase64: noManifest.toString("base64") })
    ).toThrow("no .model3.json");

    const dir = await root();
    const app = Fastify();
    await registerLive2DRoutes(app, { live2dModelsRoot: dir } as never);
    const malformed = await app.inject({
      method: "POST",
      url: "/live2d/models/import-zip",
      payload: { name: "broken", archiveBase64: Buffer.from("not a zip").toString("base64") }
    });
    expect(malformed.statusCode).toBe(400);
    expect((await app.inject("/live2d/models")).json().models).toEqual([]);
    await app.close();
  });

  it("allows repeated ZIP import as independent copies and activates the newest copy", async () => {
    const dir = await root();
    const app = Fastify();
    await registerLive2DRoutes(app, { live2dModelsRoot: dir } as never);
    const archiveBase64 = vtsZipFixture().toString("base64");

    const first = await app.inject({
      method: "POST",
      url: "/live2d/models/import-zip",
      payload: { name: "Lumi first", archiveBase64 }
    });
    expect(first.statusCode).toBe(200);
    const firstState = first.json();
    const firstId = firstState.activeId;
    expect(firstId).toBeTruthy();

    const second = await app.inject({
      method: "POST",
      url: "/live2d/models/import-zip",
      payload: { name: "Lumi second", archiveBase64 }
    });
    expect(second.statusCode).toBe(200);
    const secondState = second.json();
    expect(secondState.activeId).toBeTruthy();
    expect(secondState.activeId).not.toBe(firstId);
    expect(secondState.models.filter((model: any) => model.source === "user")).toHaveLength(2);
    expect(secondState.models.find((model: any) => model.id === secondState.activeId)?.name).toBe(
      "Lumi second"
    );
    await app.close();
  });

  it("imports a VTS ZIP, selects it immediately, and serves normalized assets", async () => {
    const dir = await root();
    const app = Fastify();
    await registerLive2DRoutes(app, { live2dModelsRoot: dir } as never);
    const response = await app.inject({
      method: "POST",
      url: "/live2d/models/import-zip",
      payload: { name: "Lumi VTS", archiveBase64: vtsZipFixture().toString("base64") }
    });
    expect(response.statusCode).toBe(200);
    const state = response.json();
    expect(state.activeId).toBeTruthy();
    const installed = state.models.find((model: any) => model.id === state.activeId);
    expect(installed?.name).toBe("Lumi VTS");
    expect(installed?.model).toBe("Lumi/Lumi.model3.json");
    expect((await app.inject(installed.url.slice(4))).statusCode).toBe(200);
    expect(
      (
        await app.inject(
          `/live2d/models/${installed.id}/Lumi/expressions/~23~U4e09~25~smile.exp3.json`
        )
      ).statusCode
    ).toBe(200);
    await app.close();
  });

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
