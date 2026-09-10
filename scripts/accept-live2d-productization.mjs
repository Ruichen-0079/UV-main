/** Real local effect gate. Official model fixtures stay outside the repository. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
if (!process.argv.includes("--run")) throw new Error("Use --run against the isolated H Runtime.");
const { chromium } = await import(process.env.YUVI_PLAYWRIGHT_MODULE || "playwright");
const base = process.env.YUVI_UI_URL || "http://127.0.0.1:5174";
const api = process.env.YUVI_UI_API || "http://127.0.0.1:6122";
assert.equal(new URL(api).hostname, "127.0.0.1");
assert.notEqual(new URL(api).port, "6121");
const modelZip = process.env.YUVI_HIYORI_ZIP || "/tmp/campaign-h-official-hiyori.zip";
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
});
const page = await browser.newPage();
page.setDefaultTimeout(20000);
const rows = [];
const imported = [];
const original = await (await fetch(api + "/live2d/models")).json();
async function step(control, fn) {
  try {
    await fn();
    rows.push({ control, status: "REAL_LOCAL_PASS" });
  } catch (e) {
    rows.push({ control, status: "BROKEN", evidence: e.message.slice(0, 300) });
  }
  await fs.writeFile(
    process.env.YUVI_LIVE2D_OUTPUT || "/tmp/campaign-h-live2d-acceptance.json",
    JSON.stringify(rows, null, 2)
  );
  console.log(rows.at(-1));
}
async function settings() {
  await page.goto(base + "/#/webui");
  await page.reload();
  await page.getByRole("button", { name: "设置", exact: true }).click();
}
try {
  await settings();
  const panel = page.getByRole("region", { name: "Live2D 模型" });
  await step("Chinese default and disabled empty import", async () => {
    assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
    assert.ok(await panel.getByRole("button", { name: "导入 ZIP", exact: true }).isDisabled());
    assert.equal(await panel.getByLabel("模型目录", { exact: true }).count(), 0);
    assert.equal(await panel.getByText("模型清单", { exact: true }).count(), 0);
  });
  await step("Official Hiyori ZIP import, pending feedback, activation and installed copy", async () => {
    await panel.getByLabel("Live2D ZIP", { exact: true }).setInputFiles(modelZip);
    await panel.getByLabel("模型名称（可选）", { exact: true }).fill("Hiyori Momose · H acceptance");
    let release;
    let arrived;
    const waiting = new Promise((resolve) => (arrived = resolve));
    await page.route("**/api/live2d/models/import-zip", async (route) => {
      arrived();
      await new Promise((resolve) => (release = resolve));
      await route.continue();
    });
    const response = page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/live2d/models/import-zip") &&
        candidate.request().method() === "POST"
    );
    await panel.getByRole("button", { name: "导入 ZIP", exact: true }).click();
    try {
      await waiting;
      assert.ok(await panel.getByRole("button", { name: "导入 ZIP", exact: true }).isDisabled());
      assert.equal(
        await panel.getByRole("progressbar", { name: "模型操作进度" }).getAttribute("value"),
        null
      );
    } finally {
      release?.();
    }
    const result = await response;
    assert.equal(result.status(), 200);
    const importedState = await result.json();
    assert.ok(importedState.activeId);
    imported.push(importedState.activeId);
    await page.unroute("**/api/live2d/models/import-zip");
    await panel.getByRole("status").filter({ hasText: "模型 ZIP 已安装并选中" }).waitFor();
    const installed = (await (await fetch(api + "/live2d/models")).json()).models.find(
      (model) => model.id === imported[0]
    );
    assert.ok(installed);
    assert.equal(installed.source, "user");
    assert.equal((await (await fetch(api + "/live2d/models")).json()).activeId, imported[0]);
    assert.equal((await fetch(api + installed.url.slice(4))).status, 200);
  });
  await step("ZIP activation persists on reload and existing Cubism renderer loads", async () => {
    assert.ok(imported[0]);
    assert.equal((await (await fetch(api + "/live2d/models")).json()).activeId, imported[0]);
    await page.reload();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    assert.ok(
      await panel
        .locator("li")
        .filter({ hasText: "Hiyori Momose · H acceptance" })
        .getByRole("button", { name: "移除模型", exact: true })
        .isDisabled()
    );
    const companion = await browser.newPage();
    try {
      await companion.goto(base + "/#/companion");
      await companion.locator('[data-model-lifecycle="ready"]').waitFor({ timeout: 45000 });
      await companion.screenshot({ path: "/tmp/campaign-h-hiyori-render.png" });
    } finally {
      await companion.close();
    }
  });
  if (process.env.YUVI_RESTART_SOURCE) await step("Selected model survives a real H Runtime process restart", async () => {
    const { execFileSync } = await import("node:child_process");
    const pids = () => execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" }).split("\n").filter(line => line.includes("yuvi-campaign-h/node_modules") && line.includes("--conditions development src/index.ts")).map(line => line.trim().split(/\s+/)[0]);
    const before = pids(); assert.equal(before.length, 1);
    const now = new Date(); await fs.utimes(process.env.YUVI_RESTART_SOURCE, now, now);
    const deadline = Date.now() + 15000; let restarted = false;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (pids().length === 1 && pids()[0] !== before[0]) {
        try { const state = await (await fetch(api + "/live2d/models")).json(); assert.equal(state.activeId, imported[0]); restarted = true; break; } catch { /* Wait for the new listener. */ }
      }
    }
    assert.ok(restarted, "H Runtime did not restart with the same persisted model");
  });
  await step("Disable persists and allows removal of the only user model", async () => {
    await panel.getByRole("button", { name: "停用模型", exact: true }).click();
    await panel.getByRole("status").filter({ hasText: "陪伴模型已停用" }).waitFor();
    await page.reload(); await page.getByRole("button", { name: "设置", exact: true }).click();
    assert.equal((await (await fetch(api + "/live2d/models")).json()).activeId, null);
    assert.ok(!await panel.locator("li").filter({ hasText: "Hiyori Momose · H acceptance" }).getByRole("button", { name: "移除模型", exact: true }).isDisabled());
  });
  await step("Malformed ZIP rejects without fake success and remains retryable", async () => {
    const fixture = "/tmp/campaign-h-invalid-model.zip";
    await fs.writeFile(fixture, "not a zip archive");
    const before = (await (await fetch(api + "/live2d/models")).json()).models.length;
    await panel.getByLabel("Live2D ZIP", { exact: true }).setInputFiles(fixture);
    const response = page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/live2d/models/import-zip") &&
        candidate.request().method() === "POST"
    );
    await panel.getByRole("button", { name: "导入 ZIP", exact: true }).click();
    assert.equal((await response).status(), 400);
    await panel.getByRole("alert").waitFor();
    assert.equal((await (await fetch(api + "/live2d/models")).json()).models.length, before);
    assert.ok(await panel.getByRole("button", { name: "重试导入", exact: true }).isEnabled());
  });
  await step("Language selection persists through full page reload", async () => {
    await page.getByRole("combobox", { name: "界面语言", exact: true }).selectOption("en");
    await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
    await page.reload();
    assert.equal(await page.locator("html").getAttribute("lang"), "en");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("combobox", { name: "UI language", exact: true }).selectOption("zh-CN");
    await page.getByRole("button", { name: "设置", exact: true }).waitFor();
  });
  await step("Inactive user removal preserves configured model and source files", async () => {
    assert.ok(original.activeId, "Removal acceptance requires an existing fallback model");
    await fetch(api + "/live2d/models/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: original.activeId })
    });
    await settings();
    page.once("dialog", (d) => d.accept());
    await panel
      .locator("li")
      .filter({ hasText: "Hiyori Momose · H acceptance" })
      .getByRole("button", { name: "移除模型", exact: true })
      .click();
    await panel.getByRole("status").filter({ hasText: "已移除安装副本" }).waitFor();
    assert.ok(
      !(await (await fetch(api + "/live2d/models")).json()).models.some((m) => m.id === imported[0])
    );
    assert.ok((await fs.stat(modelZip)).isFile());
    imported.length = 0;
  });
} finally {
  if (original.activeId)
    await fetch(api + "/live2d/models/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: original.activeId })
    });
  for (const id of imported) await fetch(api + "/live2d/models/" + id, { method: "DELETE" });
  await browser.close();
}
if (rows.some((row) => row.status !== "REAL_LOCAL_PASS")) process.exitCode = 1;
