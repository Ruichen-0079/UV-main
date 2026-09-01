import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";
import { getRuntimeEnvPath } from "../env.js";

export const PRODUCT_PREFERENCES_VERSION = "product-ui-preferences.v1" as const;

export const ProductPreferencesSchema = z
  .object({
    version: z.literal(PRODUCT_PREFERENCES_VERSION),
    appearance: z
      .object({
        theme: z.enum(["light", "dark", "system"]).default("light"),
        density: z.enum(["comfortable", "compact"]).default("comfortable"),
        reducedMotion: z.boolean().default(false)
      })
      .default({}),
    general: z
      .object({
        rememberLastPage: z.boolean().default(true),
        lastPage: z.enum(["chat", "settings", "diagnostics"]).default("chat"),
        language: z.enum(["en", "zh"]).default("en")
      })
      .default({}),
    firstRun: z
      .object({
        completed: z.boolean().default(false),
        skipped: z.boolean().default(false)
      })
      .default({}),
    diagnostics: z
      .object({
        follow: z.boolean().default(true)
      })
      .default({})
  })
  .strict();

export type ProductPreferences = z.infer<typeof ProductPreferencesSchema>;

export function defaultProductPreferences(): ProductPreferences {
  return ProductPreferencesSchema.parse({ version: PRODUCT_PREFERENCES_VERSION });
}

export function productPreferencesPath(): string {
  return getRuntimeEnvPath(".env.local").replace(/\.env\.local$/, "product-ui.json");
}

export async function readProductPreferences(): Promise<{
  preferences: ProductPreferences;
  path: string;
  malformed: boolean;
}> {
  const path = productPreferencesPath();
  try {
    const raw = await readFile(path, "utf8");
    const parsed = ProductPreferencesSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return { preferences: defaultProductPreferences(), path, malformed: true };
    }
    return { preferences: parsed.data, path, malformed: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { preferences: defaultProductPreferences(), path, malformed: false };
    }
    return { preferences: defaultProductPreferences(), path, malformed: true };
  }
}

export async function writeProductPreferences(
  patch: Partial<ProductPreferences>
): Promise<ProductPreferences> {
  const current = await readProductPreferences();
  const next = ProductPreferencesSchema.parse({
    version: PRODUCT_PREFERENCES_VERSION,
    appearance: { ...current.preferences.appearance, ...(patch.appearance ?? {}) },
    general: { ...current.preferences.general, ...(patch.general ?? {}) },
    firstRun: { ...current.preferences.firstRun, ...(patch.firstRun ?? {}) },
    diagnostics: { ...current.preferences.diagnostics, ...(patch.diagnostics ?? {}) }
  });
  await atomicWriteJson(productPreferencesPath(), next);
  return next;
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
