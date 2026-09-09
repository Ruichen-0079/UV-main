import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { extractLive2DZip, LIVE2D_ZIP_LIMIT } from "./live2d-zip.js";

export const LIVE2D_IMPORT_LIMIT = 96 * 1024 * 1024;
export const modelImportSchema = z.object({
  name: z.string().trim().min(1).max(80),
  model: z.string().max(512),
  files: z
    .array(z.object({ path: z.string().max(512), base64: z.string() }))
    .min(1)
    .max(512)
});

export const modelZipImportSchema = z.object({
  name: z.string().trim().min(1).max(80),
  archiveBase64: z.string().min(4).max(Math.ceil((LIVE2D_ZIP_LIMIT * 4) / 3) + 8)
});
const entrySchema = z.object({ id: z.string().uuid(), name: z.string(), model: z.string() });
type Entry = z.infer<typeof entrySchema>;
export type InstalledModel = Entry & { source: "user" | "configured"; url: string };

export function safeModelPath(value: string): boolean {
  return (
    Boolean(value) &&
    value.length <= 512 &&
    !/[\\\x00-\x1f:#?%<>|"*]/u.test(value) &&
    !value.startsWith("/") &&
    value
      .split("/")
      .every(
        (p) =>
          p !== ".." &&
          p !== "." &&
          p !== "" &&
          !/[. ]$/u.test(p) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(p)
      )
  );
}


function decodeCanonicalBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) throw new Error("Invalid file encoding.");
  const data = Buffer.from(value, "base64");
  if (data.toString("base64") !== value) throw new Error("Invalid file encoding.");
  return data;
}

function normalizeModelSegment(segment: string): string {
  let normalized = "";
  for (const char of segment) {
    const code = char.codePointAt(0)!;
    if (/[\\\x00-\x1f:#?%<>|"*]/u.test(char)) {
      normalized += `~${code.toString(16).toUpperCase()}~`;
    } else {
      normalized += char;
    }
  }
  while (/[. ]$/u.test(normalized)) {
    const char = normalized.at(-1)!;
    normalized = `${normalized.slice(0, -1)}~${char.codePointAt(0)!.toString(16).toUpperCase()}~`;
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(normalized)) {
    normalized = `_${normalized}`;
  }
  if (!normalized) normalized = "_";
  return normalized;
}

function normalizeArchivePath(value: string): string {
  return value.split("/").map(normalizeModelSegment).join("/");
}

function archiveReferencePath(modelPath: string, reference: string): string {
  if (!reference || reference.includes("\0") || reference.includes("\\") || reference.startsWith("/"))
    throw new Error("Unsafe model reference.");
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(modelPath), reference));
  if (resolved === ".." || resolved.startsWith("../")) throw new Error("Unsafe model reference.");
  return resolved;
}

function rewriteArchiveManifestReferences(
  rawModelPath: string,
  normalizedModelPath: string,
  model: any,
  pathMap: ReadonlyMap<string, string>
): void {
  const refs = model?.FileReferences;
  if (!refs || typeof refs !== "object") return;

  const rewrite = (reference: unknown): unknown => {
    if (typeof reference !== "string") return reference;
    const source = archiveReferencePath(rawModelPath, reference);
    const target = pathMap.get(source);
    if (!target) throw new Error(`Missing referenced asset: ${reference}`);
    const relative = path.posix.relative(path.posix.dirname(normalizedModelPath), target);
    if (!safeModelPath(relative)) throw new Error("Unsafe normalized model reference.");
    return relative;
  };

  if ("Moc" in refs) refs.Moc = rewrite(refs.Moc);
  if (Array.isArray(refs.Textures)) refs.Textures = refs.Textures.map(rewrite);
  for (const key of ["Physics", "Pose", "UserData", "DisplayInfo"]) {
    if (key in refs && refs[key] !== undefined) refs[key] = rewrite(refs[key]);
  }
  if (Array.isArray(refs.Expressions)) {
    for (const expression of refs.Expressions) {
      if (expression && typeof expression === "object" && "File" in expression)
        expression.File = rewrite(expression.File);
    }
  }
  if (refs.Motions && typeof refs.Motions === "object") {
    for (const motions of Object.values(refs.Motions)) {
      if (!Array.isArray(motions)) continue;
      for (const motion of motions) {
        if (!motion || typeof motion !== "object") continue;
        if ("File" in motion) (motion as any).File = rewrite((motion as any).File);
        if ("Sound" in motion && (motion as any).Sound !== undefined)
          (motion as any).Sound = rewrite((motion as any).Sound);
      }
    }
  }
}

/**
 * Turn one ordinary VTube Studio/Cubism ZIP into the existing validated package
 * shape. URL-special filenames are normalized before durable installation and
 * all model3 references are rewritten to the normalized paths.
 */
export function modelPackageFromZip(
  input: z.infer<typeof modelZipImportSchema>
): z.infer<typeof modelImportSchema> {
  const archive = decodeCanonicalBase64(input.archiveBase64);
  const rawFiles = extractLive2DZip(archive);
  const manifests = [...rawFiles.keys()].filter((file) => file.toLowerCase().endsWith(".model3.json"));
  if (manifests.length === 0) throw new Error("ZIP archive contains no .model3.json file.");
  if (manifests.length !== 1) throw new Error("ZIP archive must contain exactly one .model3.json file.");

  const rawModelPath = manifests[0]!;
  const pathMap = new Map<string, string>();
  const casePaths = new Set<string>();
  for (const source of rawFiles.keys()) {
    const target = normalizeArchivePath(source);
    if (!safeModelPath(target)) throw new Error("ZIP entry cannot be normalized safely.");
    const key = target.toLocaleLowerCase("en-US");
    if (casePaths.has(key)) throw new Error("ZIP paths collide after normalization.");
    casePaths.add(key);
    pathMap.set(source, target);
  }

  const normalizedModelPath = pathMap.get(rawModelPath)!;
  const normalizedFiles = new Map<string, Buffer>();
  for (const [source, data] of rawFiles) {
    normalizedFiles.set(pathMap.get(source)!, data);
  }

  const manifest = JSON.parse(rawFiles.get(rawModelPath)!.toString("utf8"));
  rewriteArchiveManifestReferences(rawModelPath, normalizedModelPath, manifest, pathMap);
  normalizedFiles.set(normalizedModelPath, Buffer.from(JSON.stringify(manifest), "utf8"));

  return {
    name: input.name,
    model: normalizedModelPath,
    files: [...normalizedFiles].map(([filePath, data]) => ({
      path: filePath,
      base64: data.toString("base64")
    }))
  };
}

/** Validate the package before any durable installation. No arbitrary filesystem paths or URLs. */
export function validateModelPackage(
  input: z.infer<typeof modelImportSchema>
): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let total = 0;
  const casePaths = new Set<string>();
  for (const file of input.files) {
    if (!safeModelPath(file.path) || casePaths.has(file.path.toLowerCase()))
      throw new Error("Invalid or duplicate package path.");
    const data = decodeCanonicalBase64(file.base64);
    total += data.length;
    if (total > 64 * 1024 * 1024) throw new Error("Model package exceeds 64 MiB.");
    files.set(file.path, data);
    casePaths.add(file.path.toLowerCase());
  }
  if (!safeModelPath(input.model) || !input.model.endsWith(".model3.json"))
    throw new Error("Choose a .model3.json file.");
  const manifest = files.get(input.model);
  if (!manifest) throw new Error("Model manifest is missing.");
  const reference = z.string().min(1);
  const model = z
    .object({
      Version: z.literal(3),
      FileReferences: z.object({
        Moc: reference,
        Textures: z.array(reference).min(1),
        Physics: reference.optional(),
        Pose: reference.optional(),
        UserData: reference.optional(),
        DisplayInfo: reference.optional(),
        Expressions: z.array(z.object({ File: reference })).optional(),
        Motions: z
          .record(z.array(z.object({ File: reference, Sound: reference.optional() })))
          .optional()
      })
    })
    .parse(JSON.parse(manifest.toString("utf8")));
  const refs = model.FileReferences;
  const required = [
    refs.Moc,
    ...refs.Textures,
    refs.Physics,
    refs.Pose,
    refs.UserData,
    refs.DisplayInfo,
    ...(refs.Expressions ?? []).map((e) => e.File),
    ...Object.values(refs.Motions ?? {}).flatMap((ms) => ms.flatMap((m) => [m.File, m.Sound]))
  ];
  for (const ref of required) {
    if (ref === undefined) continue;
    if (!safeModelPath(ref)) throw new Error("Unsafe model reference.");
    const data = files.get(path.posix.join(path.posix.dirname(input.model), ref));
    if (!data?.length) throw new Error(`Missing referenced asset: ${ref}`);
    if (ref.endsWith(".json")) JSON.parse(data.toString("utf8"));
  }
  const moc = files.get(path.posix.join(path.posix.dirname(input.model), refs.Moc))!;
  if (!refs.Moc.endsWith(".moc3") || moc.subarray(0, 4).toString() !== "MOC3")
    throw new Error("Invalid .moc3 header.");
  for (const texture of refs.Textures) {
    const data = files.get(path.posix.join(path.posix.dirname(input.model), texture))!;
    if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new Error("Invalid PNG texture.");
  }
  return files;
}

export class Live2DModels {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    readonly root: string,
    private readonly configuredRoot?: string
  ) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.then(work);
    this.pending = result.catch(() => undefined);
    return result;
  }
  async list(): Promise<{
    models: InstalledModel[];
    activeId: string | null;
    activeUrl: string | null;
    intendedDefault: string;
  }> {
    const models: InstalledModel[] = [];
    try {
      for (const dir of await readdir(this.root)) {
        if (!z.string().uuid().safeParse(dir).success) continue;
        const entry = entrySchema.parse(
          JSON.parse(await readFile(path.join(this.root, dir, "entry.json"), "utf8"))
        );
        if (entry.id !== dir || !safeModelPath(entry.model))
          throw new Error("Invalid installed model metadata.");
        models.push({ ...entry, source: "user", url: `/api/live2d/models/${dir}/${entry.model}` });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (this.configuredRoot) {
      for (const [id, name, model] of [
        ["hiyori", "Hiyori Momose", "Hiyori/Hiyori.model3.json"],
        ["configured", "Configured model", "Lumi/Lumi.model3.json"]
      ]) {
        try {
          if ((await stat(path.join(this.configuredRoot, model!))).isFile())
            models.push({
              id: id!,
              name: name!,
              model: model!,
              source: "configured",
              url: `/api/live2d/${model}`
            });
        } catch {
          /* Optional preinstalled models. */
        }
      }
    }
    let activeId: string | null = null;
    let selected = false;
    try {
      activeId = JSON.parse(await readFile(path.join(this.root, "active.json"), "utf8")).id;
      selected = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const active =
      selected && activeId === null
        ? undefined
        : (models.find((m) => m.id === activeId) ??
          models.find((m) => m.id === "hiyori") ??
          models.find((m) => m.id === "configured"));
    return {
      models,
      activeId: active?.id ?? null,
      activeUrl: active?.url ?? null,
      intendedDefault: "Hiyori Momose"
    };
  }
  private async persist(id: string | null): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const temp = path.join(this.root, `.active-${randomUUID()}`);
    try {
      await writeFile(temp, JSON.stringify({ id }), { flag: "wx" });
      await rename(temp, path.join(this.root, "active.json"));
    } finally {
      await rm(temp, { force: true });
    }
  }
  import(input: z.infer<typeof modelImportSchema>): Promise<InstalledModel> {
    return this.serial(async () => {
      const files = validateModelPackage(input);
      const id = randomUUID();
      const staging = path.join(this.root, `.import-${id}`);
      const entry = { id, name: input.name, model: input.model };
      try {
        await mkdir(path.join(staging, "assets"), { recursive: true });
        for (const [relative, data] of files) {
          const target = path.join(staging, "assets", relative);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, data, { flag: "wx" });
        }
        await writeFile(path.join(staging, "entry.json"), JSON.stringify(entry));
        await rename(staging, path.join(this.root, id));
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      return { ...entry, source: "user", url: `/api/live2d/models/${id}/${input.model}` };
    });
  }
  select(id: string | null): Promise<void> {
    return this.serial(async () => {
      if (id !== null && !(await this.list()).models.some((m) => m.id === id))
        throw new Error("Model is not installed.");
      await this.persist(id);
    });
  }
  remove(id: string): Promise<void> {
    return this.serial(async () => {
      const state = await this.list();
      if (!state.models.some((m) => m.id === id && m.source === "user"))
        throw new Error("Only user-imported models can be removed.");
      if (state.activeId === id)
        throw new Error("Select another model before removing the active model.");
      await rm(path.join(this.root, id), { recursive: true });
    });
  }
  async asset(id: string, relative: string): Promise<string | null> {
    if (!z.string().uuid().safeParse(id).success || !safeModelPath(relative)) return null;
    const root = await realpath(path.join(this.root, id, "assets"));
    const file = await realpath(path.join(root, relative));
    return file.startsWith(root + path.sep) && (await stat(file)).isFile() ? file : null;
  }
}
