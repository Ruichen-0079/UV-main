import { describe, expect, it, vi } from "vitest";
import { createCubismFrameworkLoader, type CubismFrameworkRuntime } from "./cubism-framework.js";

function runtime(started = false, initialized = false): CubismFrameworkRuntime {
  return {
    CubismFramework: {
      startUp: vi.fn(() => true),
      initialize: vi.fn(),
      isStarted: vi.fn(() => started),
      isInitialized: vi.fn(() => initialized),
      getIdManager: vi.fn(() => ({ getId: vi.fn() }))
    },
    CubismUserModel: class {},
    CubismModelSettingJson: class {},
    CubismMatrix44: class {
      loadIdentity() {}
      scale() {}
      translate() {}
    }
  } as unknown as CubismFrameworkRuntime;
}

describe("official Cubism Framework loader", () => {
  it("shares one Core-first initialization and initializes only once", async () => {
    const value = runtime();
    const loadCore = vi.fn(async () => undefined);
    const importRuntime = vi.fn(async () => value);
    const loader = createCubismFrameworkLoader(loadCore, importRuntime);

    const first = loader.load();
    const second = loader.load();
    expect(first).toBe(second);
    await expect(first).resolves.toBe(value);
    expect(loadCore).toHaveBeenCalledTimes(1);
    expect(importRuntime).toHaveBeenCalledTimes(1);
    expect(value.CubismFramework.startUp).toHaveBeenCalledTimes(1);
    expect(value.CubismFramework.initialize).toHaveBeenCalledTimes(1);
  });

  it("retries an import failure and does not reinitialize an active Framework", async () => {
    const value = runtime(true, true);
    const loadCore = vi.fn(async () => undefined);
    const importRuntime = vi
      .fn<() => Promise<CubismFrameworkRuntime>>()
      .mockRejectedValueOnce(new Error("framework unavailable"))
      .mockResolvedValueOnce(value);
    const loader = createCubismFrameworkLoader(loadCore, importRuntime);

    await expect(loader.load()).rejects.toThrow("framework unavailable");
    await expect(loader.load()).resolves.toBe(value);
    expect(importRuntime).toHaveBeenCalledTimes(2);
    expect(value.CubismFramework.startUp).not.toHaveBeenCalled();
    expect(value.CubismFramework.initialize).not.toHaveBeenCalled();
  });
});
