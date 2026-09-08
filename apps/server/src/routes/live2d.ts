import { requireLocalDashboardAccess } from "./security.js";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { resolveYuviHostPaths } from "@companion/host-environment";
import { Live2DModels, LIVE2D_IMPORT_LIMIT, modelImportSchema } from "../services/live2d-models.js";
import { z } from "zod";
import type { ServerConfig } from "../config.js";

const contentTypes: Record<string, string> = {
  ".json": "application/json",
  ".png": "image/png",
  ".moc3": "application/octet-stream",
  ".physics3.json": "application/json",
  ".cdi3.json": "application/json",
  ".motion3.json": "application/json",
  ".exp3.json": "application/json"
};

const cubismCoreFileName = "live2dcubismcore.min.js";

export async function registerLive2DCoreRoute(
  app: FastifyInstance,
  config: ServerConfig
): Promise<void> {
  app.get("/live2d-core/live2dcubismcore.min.js", async (_request, reply) => {
    const corePath = config.live2dCorePath;
    if (!corePath || path.basename(corePath) !== cubismCoreFileName) {
      return reply
        .status(404)
        .send({ error: "live2d_core_unavailable", message: "Live2D Core is not configured." });
    }

    try {
      const details = await stat(corePath);
      if (!details.isFile()) throw new Error("not a file");
    } catch {
      return reply
        .status(404)
        .send({ error: "live2d_core_unavailable", message: "Live2D Core is unavailable." });
    }

    reply.type("application/javascript; charset=utf-8");
    return reply.send(createReadStream(corePath));
  });
}

export async function registerLive2DRoutes(
  app: FastifyInstance,
  config: ServerConfig
): Promise<void> {
  const models = new Live2DModels(
    config.live2dModelsRoot ??
      path.join(
        process.env["YUVI_RUNTIME_DATA_DIR"] || resolveYuviHostPaths().yuviDataDir,
        "live2d-models"
      ),
    config.live2dAssetRoot
  );
  app.get("/live2d/models", async () => models.list());
  app.post("/live2d/models/import", { bodyLimit: LIVE2D_IMPORT_LIMIT }, async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    const input = modelImportSchema.safeParse(request.body);
    if (!input.success)
      return reply
        .code(400)
        .send({ error: "invalid_model_package", message: "Invalid model package." });
    try {
      return await models.import(input.data);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return reply
        .code(code ? 500 : 400)
        .send({
          error: "model_import_failed",
          message: code
            ? "Unable to install model in durable storage."
            : "Invalid model package: check the manifest and all referenced assets."
        });
    }
  });
  app.post("/live2d/models/select", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    const input = z.object({ id: z.string().max(80).nullable() }).safeParse(request.body);
    if (!input.success)
      return reply
        .code(400)
        .send({ error: "invalid_model", message: "Choose an installed model." });
    try {
      await models.select(input.data.id);
      return await models.list();
    } catch {
      return reply
        .code(409)
        .send({
          error: "model_selection_failed",
          message: "Unable to select or persist this model."
        });
    }
  });
  app.delete<{ Params: { id: string } }>("/live2d/models/:id", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    try {
      await models.remove(request.params.id);
      return await models.list();
    } catch {
      return reply
        .code(409)
        .send({
          error: "model_removal_failed",
          message: "Select another model first. Only inactive user-imported models can be removed."
        });
    }
  });
  app.get<{ Params: { id: string; "*": string } }>(
    "/live2d/models/:id/*",
    async (request, reply) => {
      try {
        const file = await models.asset(request.params.id, request.params["*"]);
        if (!file) return reply.code(404).send({ error: "asset_not_found" });
        reply.type(contentTypes[path.extname(file)] ?? "application/octet-stream");
        return reply.send(createReadStream(file));
      } catch {
        return reply.code(404).send({ error: "asset_not_found" });
      }
    }
  );
  app.get<{ Params: { "*": string } }>("/live2d/*", async (request, reply) => {
    const root = config.live2dAssetRoot;
    if (!root) {
      return reply
        .status(404)
        .send({ error: "live2d_unavailable", message: "Live2D is not configured." });
    }

    let relative: string;
    try {
      relative = decodeURIComponent(request.params["*"] ?? "");
    } catch {
      return reply
        .status(400)
        .send({ error: "invalid_asset_path", message: "Invalid Live2D asset path." });
    }
    if (!isSafeRelativePath(relative)) {
      return reply
        .status(400)
        .send({ error: "invalid_asset_path", message: "Invalid Live2D asset path." });
    }

    const rootPath = path.resolve(root);
    const assetPath = path.resolve(rootPath, relative);
    if (!isWithinRoot(rootPath, assetPath)) {
      return reply
        .status(403)
        .send({ error: "asset_forbidden", message: "Live2D asset is not available." });
    }

    try {
      const canonicalRoot = await realpath(rootPath);
      const canonicalAsset = await realpath(assetPath);
      if (!isWithinRoot(canonicalRoot, canonicalAsset))
        return reply.code(403).send({ error: "asset_forbidden" });
      const details = await stat(canonicalAsset);
      if (!details.isFile()) {
        return reply
          .status(404)
          .send({ error: "asset_not_found", message: "Live2D asset was not found." });
      }
    } catch {
      return reply
        .status(404)
        .send({ error: "asset_not_found", message: "Live2D asset was not found." });
    }

    const extension = path.extname(assetPath).toLowerCase();
    const compoundExtension = Object.keys(contentTypes).find((value) => assetPath.endsWith(value));
    reply.type(contentTypes[compoundExtension ?? extension] ?? "application/octet-stream");
    return reply.send(createReadStream(assetPath));
  });
}

function isSafeRelativePath(value: string): boolean {
  return (
    Boolean(value) &&
    !value.includes("\0") &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]+/u).includes("..")
  );
}

function isWithinRoot(root: string, candidate: string): boolean {
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return candidate === root || candidate.startsWith(prefix);
}
