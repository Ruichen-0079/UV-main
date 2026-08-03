import { loadCubismCore } from "./cubism-core.js";

/**
 * The official Framework is imported only after the externally hosted Core
 * script has installed its global.  Keeping this boundary explicit prevents a
 * module-evaluation race between Vite and the Cubism Core.
 */
export type CubismFrameworkRuntime = {
  CubismFramework: {
    startUp(): boolean;
    initialize(): void;
    isStarted(): boolean;
    isInitialized(): boolean;
    getIdManager(): { getId(id: string): unknown };
  };
  CubismUserModel: new () => any;
  CubismModelSettingJson: new (buffer: ArrayBuffer, size: number) => any;
  CubismMatrix44: new () => {
    loadIdentity(): void;
    scale(x: number, y: number): void;
    translate(x: number, y: number): void;
  };
};

let frameworkPromise: Promise<CubismFrameworkRuntime> | null = null;

export function createCubismFrameworkLoader(
  loadCore: () => Promise<unknown>,
  importRuntime: () => Promise<CubismFrameworkRuntime>
): { load(): Promise<CubismFrameworkRuntime> } {
  let promise: Promise<CubismFrameworkRuntime> | null = null;
  return {
    load() {
      if (promise) return promise;
      const attempt = (async () => {
        await loadCore();
        const runtime = await importRuntime();
        if (!runtime.CubismFramework.isStarted()) runtime.CubismFramework.startUp();
        if (!runtime.CubismFramework.isInitialized()) runtime.CubismFramework.initialize();
        return runtime;
      })();
      promise = attempt.catch((error: unknown) => {
        promise = null;
        throw error;
      });
      return promise;
    }
  };
}

const defaultLoader = createCubismFrameworkLoader(loadCubismCore, async () => {
  const [framework, userModel, setting, matrix] = await Promise.all([
    import("../vendor/cubism-framework/dist/live2dcubismframework.js"),
    import("../vendor/cubism-framework/dist/model/cubismusermodel.js"),
    import("../vendor/cubism-framework/dist/cubismmodelsettingjson.js"),
    import("../vendor/cubism-framework/dist/math/cubismmatrix44.js")
  ]);
  return {
    CubismFramework: framework.CubismFramework,
    CubismUserModel: userModel.CubismUserModel,
    CubismModelSettingJson: setting.CubismModelSettingJson,
    CubismMatrix44: matrix.CubismMatrix44
  };
});

export function loadCubismFramework(): Promise<CubismFrameworkRuntime> {
  if (frameworkPromise) return frameworkPromise;
  frameworkPromise = defaultLoader.load();
  return frameworkPromise;
}

/** Test-only reset; production never disposes the shared Framework. */
export function resetCubismFrameworkForTest(): void {
  frameworkPromise = null;
}
