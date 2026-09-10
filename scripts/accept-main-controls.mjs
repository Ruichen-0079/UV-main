/** A5 Main product acceptance: quiet conversation UI, SSE turn, and one Voice Mode microphone. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";

if (!process.argv.includes("--run")) throw new Error("Use --run for browser acceptance.");

const { chromium } = await import(process.env.YUVI_PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]
});
const context = await browser.newContext({ permissions: ["microphone"] });
const page = await context.newPage();
page.setDefaultTimeout(15_000);
const base = process.env.YUVI_UI_URL || "http://127.0.0.1:5174";
const rows = [];

await page.addInitScript(() => {
  localStorage.setItem("yuvi.ui.locale", "en");
});

async function step(control, fn) {
  try {
    await fn();
    rows.push({ control, status: "AUTOMATED_PASS" });
  } catch (error) {
    rows.push({
      control,
      status: "BROKEN",
      evidence: String(error?.message ?? error).slice(0, 320)
    });
  }
  await fs.writeFile("/tmp/yuvi-a5-main-acceptance.json", JSON.stringify(rows, null, 2));
  console.log(rows.at(-1));
}

try {
  await page.setViewportSize({ width: 1080, height: 760 });
  await page.goto(base + "/#/main");

  await step("Main empty state is conversation-first", async () => {
    assert.ok(await page.getByRole("button", { name: "Send message", exact: true }).isDisabled());
    assert.equal(await page.getByRole("textbox", { name: "Chat message", exact: true }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Start Voice Mode", exact: true }).count(), 1);
    assert.equal(await page.locator('input[type="file"]').count(), 0);

    const text = await page.locator("body").innerText();
    for (const hidden of [
      "Turn Options",
      "Session ID",
      "Read Memory",
      "Write Memory",
      "TTS output",
      "Service status",
      "Record voice",
      "Transcribe recording",
      "Type a runtime test message",
      "WebUI",
      "companion connected",
      "companion offline"
    ]) {
      assert.ok(!text.includes(hidden), `Main must not expose ${hidden}`);
    }

    await page.screenshot({ path: "/tmp/yuvi-a5-main-empty.png", fullPage: true });
  });

  await step("Main text turn uses the existing Runtime message path", async () => {
    let request;
    await page.route("**/api/v1/messages/stream", async (route) => {
      request = route.request().postDataJSON();
      const common = {
        messageId: "synthetic-message",
        sessionId: request.sessionId,
        traceId: "synthetic-trace"
      };
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          "event: text-delta\ndata: " +
          JSON.stringify({ ...common, type: "text-delta", text: "Synthetic reply." }) +
          "\n\nevent: completed\ndata: " +
          JSON.stringify({
            ...common,
            type: "completed",
            content: "Synthetic reply.",
            provider: "mock"
          }) +
          "\n\n"
      });
    });

    const composer = page.getByRole("textbox", { name: "Chat message", exact: true });
    await composer.fill("Synthetic prompt.");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText("Synthetic reply.", { exact: true }).waitFor();

    assert.equal(request.sessionId, "default");
    assert.equal(request.options.readMemory, true);
    assert.equal(request.options.writeMemory, true);
    assert.equal(request.text, "Synthetic prompt.");
    assert.equal(request.options.voiceOutput, false);
    assert.equal(await page.getByText("Synthetic prompt.", { exact: true }).count(), 1);
    assert.equal(await page.locator("text=USER").count(), 0);
    assert.equal(await page.locator("text=ASSISTANT").count(), 0);

    await page.screenshot({ path: "/tmp/yuvi-a5-main-turn.png", fullPage: true });
    await page.unroute("**/api/v1/messages/stream");
  });

  await step("Main keeps Enter submit and Shift+Enter multiline behavior", async () => {
    let request;
    await page.route("**/api/v1/messages/stream", async (route) => {
      request = route.request().postDataJSON();
      const common = {
        messageId: "keyboard-message",
        sessionId: request.sessionId,
        traceId: "keyboard-trace"
      };
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          "event: completed\ndata: " +
          JSON.stringify({
            ...common,
            type: "completed",
            content: "Keyboard reply.",
            provider: "mock"
          }) +
          "\n\n"
      });
    });
    const composer = page.getByRole("textbox", { name: "Chat message", exact: true });
    await composer.fill("line one");
    await composer.press("Shift+Enter");
    await composer.type("line two");
    assert.equal(await composer.inputValue(), "line one\nline two");
    await composer.press("Enter");
    await page.getByText("Keyboard reply.", { exact: true }).waitFor();
    assert.equal(request.text, "line one\nline two");
    await page.unroute("**/api/v1/messages/stream");
  });

  await step("Main exposes one microphone interaction backed by Voice Mode", async () => {
    assert.equal(await page.getByRole("button", { name: "Record voice", exact: true }).count(), 0);
    assert.equal(
      await page.getByRole("button", { name: "Transcribe recording", exact: true }).count(),
      0
    );

    await page.getByRole("button", { name: "Start Voice Mode", exact: true }).click();
    await page.getByRole("button", { name: "Stop Voice Mode", exact: true }).waitFor();
    await page.getByRole("button", { name: "Stop Voice Mode", exact: true }).click();
    await page.getByRole("button", { name: "Start Voice Mode", exact: true }).waitFor();
  });

  await step("Main remains usable at narrow width", async () => {
    await page.setViewportSize({ width: 390, height: 720 });
    const composer = page.locator(".yuvi-main-composer");
    const box = await composer.boundingBox();
    assert.ok(box);
    assert.ok(box.x >= 0);
    assert.ok(box.x + box.width <= 390);
    assert.ok(box.width >= 340);
    await page.screenshot({ path: "/tmp/yuvi-a5-main-narrow.png", fullPage: true });
  });
} finally {
  await browser.close();
}

if (rows.some((row) => row.status === "BROKEN")) process.exitCode = 1;
