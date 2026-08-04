import { describe, expect, it } from "vitest";
import { createCubismCoreLoader } from "./cubism-core.js";

type FakeScript = {
  async: boolean;
  src: string;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  parentNode: { removeChild(node: FakeScript): void } | null;
};

function fakeDocument(onAppend: (script: FakeScript, count: number) => void): {
  document: Document;
  scripts: FakeScript[];
} {
  const scripts: FakeScript[] = [];
  const parent = {
    appendChild(script: FakeScript) {
      script.parentNode = parent;
      scripts.push(script);
      onAppend(script, scripts.length);
    },
    removeChild(script: FakeScript) {
      script.parentNode = null;
    }
  };
  return {
    scripts,
    document: {
      createElement: () =>
        ({ async: false, src: "", onload: null, onerror: null, parentNode: null }) as FakeScript,
      head: parent,
      documentElement: parent
    } as unknown as Document
  };
}

describe("Cubism Core loader", () => {
  it("loads one script and shares the in-flight promise", async () => {
    const target = {} as typeof globalThis;
    const fake = fakeDocument((script) => {
      queueMicrotask(() => {
        (target as typeof globalThis & { Live2DCubismCore?: object }).Live2DCubismCore = {
          Version: "official-test"
        };
        script.onload?.();
      });
    });
    const loader = createCubismCoreLoader({ document: fake.document, global: target });
    const first = loader.load();
    const second = loader.load();
    expect(first).toBe(second);
    await expect(first).resolves.toMatchObject({ Version: "official-test" });
    expect(fake.scripts).toHaveLength(1);
  });

  it("rejects when the script loads without a Core global and can retry", async () => {
    const target = {} as typeof globalThis;
    const fake = fakeDocument((script, count) => {
      queueMicrotask(() => {
        if (count === 2) {
          (target as typeof globalThis & { Live2DCubismCore?: object }).Live2DCubismCore = {};
        }
        script.onload?.();
      });
    });
    const loader = createCubismCoreLoader({ document: fake.document, global: target });
    await expect(loader.load()).rejects.toThrow("without a Core global");
    await expect(loader.load()).resolves.toBeDefined();
    expect(fake.scripts).toHaveLength(2);
  });

  it("reports script errors instead of executing returned text", async () => {
    const target = {} as typeof globalThis;
    const fake = fakeDocument((script) => queueMicrotask(() => script.onerror?.()));
    const loader = createCubismCoreLoader({ document: fake.document, global: target });
    await expect(loader.load()).rejects.toThrow("could not be loaded");
    expect(
      (target as typeof globalThis & { Live2DCubismCore?: object }).Live2DCubismCore
    ).toBeUndefined();
  });
});
