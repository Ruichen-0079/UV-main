import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultProductPreferences, readProductPreferences, writeProductPreferences } from "./product-preferences.js";
import { redactDiagnosticsText } from "./product-redaction.js";
import { mapMemoryEpistemic, mapProviderHealth } from "./product-health.js";

const originalEnv = { ...process.env };
const dirs: string[] = [];

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("product preferences", () => {
  it("fails closed on malformed JSON and does not throw", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yuvi-product-ui-"));
    dirs.push(dir);
    process.env["YUVI_RUNTIME_ENV_DIR"] = dir;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, "product-ui.json"), "{not-json", "utf8");
    const result = await readProductPreferences();
    expect(result.malformed).toBe(true);
    expect(result.preferences).toEqual(defaultProductPreferences());
  });

  it("writes owner-only JSON and survives roundtrip", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yuvi-product-ui-"));
    process.env["YUVI_RUNTIME_ENV_DIR"] = dir;
    const saved = await writeProductPreferences({
      appearance: { theme: "dark", density: "comfortable", reducedMotion: false }
    });
    expect(saved.appearance.theme).toBe("dark");
    const raw = await readFile(path.join(dir, "product-ui.json"), "utf8");
    expect(raw).toContain("dark");
    const loaded = await readProductPreferences();
    expect(loaded.malformed).toBe(false);
    expect(loaded.preferences.appearance.theme).toBe("dark");
  });
});

describe("product redaction and health", () => {
  it("redacts API keys from diagnostic text", () => {
    const text = redactDiagnosticsText("Authorization: Bearer sk-secret\napi_key=abc");
    expect(text).not.toContain("sk-secret");
    expect(text).not.toContain("abc");
  });

  it("does not collapse Memory empty into unavailable", () => {
    expect(mapMemoryEpistemic("empty")).toMatchObject({ epistemic: "empty", summary: "Empty" });
    expect(mapMemoryEpistemic("unavailable")).toMatchObject({
      epistemic: "unavailable",
      state: "unavailable"
    });
  });

  it("maps missing provider fields as misconfigured, not ready", () => {
    const item = mapProviderHealth({
      id: "chat",
      label: "Chat",
      health: {
        status: "unavailable",
        configured: false,
        missingFields: ["DEEPSEEK_API_KEY"],
        message: "Missing API key"
      }
    });
    expect(item.state).toBe("misconfigured");
    expect(item.tone).not.toBe("ok");
  });
});
