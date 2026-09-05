import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  YUVI_APP_IDENTIFIER,
  defaultYuviLocalDataRoot,
  resolveAppRoots
} from "./app-roots.js";

const POSIX_HOME = "/home/yuvi-tester";
const posixEnv: Record<string, string> = { HOME: POSIX_HOME };
const win32Env: Record<string, string> = {
  HOME: POSIX_HOME,
  LOCALAPPDATA: "C:\\Users\\yuvi\\AppData\\Local",
  APPDATA: "C:\\Users\\yuvi\\AppData\\Roaming"
};

describe("AppRoots contract", () => {
  it("resolves three distinct deterministic roots on unix (XDG semantics)", () => {
    const roots = resolveAppRoots({ env: posixEnv, platform: "linux" });
    expect(roots.configRoot).toBe(path.join(POSIX_HOME, ".config", YUVI_APP_IDENTIFIER));
    expect(roots.dataRoot).toBe(path.join(POSIX_HOME, ".local", "share", "YUVI"));
    expect(roots.cacheRoot).toBe(path.join(POSIX_HOME, ".cache", "YUVI"));
    expect(roots.configRoot).not.toBe(roots.dataRoot);
    expect(roots.dataRoot).not.toBe(roots.cacheRoot);
    expect(roots.configRoot).not.toBe(roots.cacheRoot);
    // Deterministic: same inputs, same roots.
    expect(resolveAppRoots({ env: posixEnv, platform: "linux" })).toEqual(roots);
  });

  it("honors XDG base directory overrides on unix", () => {
    const env: Record<string, string> = {
      ...posixEnv,
      XDG_CONFIG_HOME: "/xdg/config",
      XDG_DATA_HOME: "/xdg/data",
      XDG_CACHE_HOME: "/xdg/cache"
    };
    const roots = resolveAppRoots({ env, platform: "linux" });
    expect(roots.configRoot).toBe(path.join("/xdg/config", YUVI_APP_IDENTIFIER));
    expect(roots.dataRoot).toBe(path.join("/xdg/data", "YUVI"));
    expect(roots.cacheRoot).toBe(path.join("/xdg/cache", "YUVI"));
  });

  it("keeps the historical Windows composition deterministic", () => {
    const roots = resolveAppRoots({ env: win32Env, platform: "win32" });
    expect(roots.configRoot).toBe("C:\\Users\\yuvi\\AppData\\Roaming\\com.yuvi.companion");
    expect(roots.dataRoot).toBe("C:\\Users\\yuvi\\AppData\\Local\\YUVI");
    expect(roots.cacheRoot).toBe("C:\\Users\\yuvi\\AppData\\Local\\YUVI\\cache");
    expect(roots.configRoot).not.toBe(roots.dataRoot);
    expect(roots.dataRoot).not.toBe(roots.cacheRoot);
    // LOCALAPPDATA-less fallback mirrors the legacy chain.
    const legacy = resolveAppRoots({ env: { HOME: POSIX_HOME }, platform: "win32" });
    expect(legacy.dataRoot).toBe(path.join(POSIX_HOME, ".yuvi"));
  });

  it("accepts explicit absolute root overrides", () => {
    const env: Record<string, string> = {
      ...posixEnv,
      YUVI_CONFIG_ROOT: "/custom/config",
      YUVI_DATA_ROOT: "/custom/data",
      YUVI_CACHE_ROOT: "/custom/cache"
    };
    const roots = resolveAppRoots({ env, platform: "linux" });
    expect(roots.configRoot).toBe("/custom/config");
    expect(roots.dataRoot).toBe("/custom/data");
    expect(roots.cacheRoot).toBe("/custom/cache");
  });

  it("rejects relative root overrides", () => {
    for (const key of ["YUVI_CONFIG_ROOT", "YUVI_DATA_ROOT", "YUVI_CACHE_ROOT"]) {
      expect(() =>
        resolveAppRoots({ env: { ...posixEnv, [key]: "relative/path" }, platform: "linux" })
      ).toThrow(new RegExp(`${key} must be an absolute path`));
    }
  });

  it("changing or clearing the cache root never moves durable roots", () => {
    const base = resolveAppRoots({ env: posixEnv, platform: "linux" });
    const movedCache = resolveAppRoots(
      { env: { ...posixEnv, YUVI_CACHE_ROOT: "/mnt/bigdisk/yuvi-cache" }, platform: "linux" }
    );
    expect(movedCache.cacheRoot).toBe("/mnt/bigdisk/yuvi-cache");
    expect(movedCache.dataRoot).toBe(base.dataRoot);
    expect(movedCache.configRoot).toBe(base.configRoot);
  });

  it("keeps machine user names out of the semantic namespace", () => {
    const a = resolveAppRoots({ env: { HOME: "/home/alice" }, platform: "linux" });
    const b = resolveAppRoots({ env: { HOME: "/home/bob" }, platform: "linux" });
    // Same relative composition under different homes; the namespace is fixed.
    expect(path.relative(a.dataRoot, a.cacheRoot)).toBe(path.relative(b.dataRoot, b.cacheRoot));
    expect(a.configRoot.endsWith(path.join(".config", YUVI_APP_IDENTIFIER))).toBe(true);
    expect(a.dataRoot.endsWith(path.join(".local", "share", "YUVI"))).toBe(true);
    expect(a.cacheRoot.endsWith(path.join(".cache", "YUVI"))).toBe(true);
  });

  describe("defaultYuviLocalDataRoot", () => {
    it("delegates to the AppRoots data root", () => {
      expect(defaultYuviLocalDataRoot(posixEnv)).toBe(
        resolveAppRoots({ env: posixEnv, platform: process.platform }).dataRoot
      );
    });

    it("keeps the YUVI_DATA_ROOT override and its absolute-path error", () => {
      expect(defaultYuviLocalDataRoot({ YUVI_DATA_ROOT: "/data/root" })).toBe("/data/root");
      expect(() => defaultYuviLocalDataRoot({ YUVI_DATA_ROOT: "relative" })).toThrow(
        /YUVI_DATA_ROOT must be an absolute path/
      );
    });

    it("preserves the LOCALAPPDATA/YUVI Windows default", () => {
      expect(defaultYuviLocalDataRoot(win32Env)).toBe("C:\\Users\\yuvi\\AppData\\Local\\YUVI");
    });
  });
});
