import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
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
      const details = await stat(assetPath);
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
