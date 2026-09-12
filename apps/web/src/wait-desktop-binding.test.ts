import { expect, it } from "vitest";
import { waitDesktopBinding } from "./wait-desktop-binding.js";
import type { DesktopRuntimeBindingDto } from "./service-supervisor-client.js";

const pending: DesktopRuntimeBindingDto = {mode: "attach", ready: false, instanceId: "portable", runtimeUrl: null, error: "not owned yet"};
it("waits beyond the original five-second refresh and uses only the verified binding", async () => {
  let now = 0;
  let paints = 0;
  const ready = {...pending, ready: true, runtimeUrl: "http://127.0.0.1:16121", error: null};
  const result = await waitDesktopBinding(async () => now < 8000 ? pending : ready, () => { paints++; }, {
    now: () => now, sleep: async () => { now += 500; }
  });
  expect(result).toEqual(ready);
  expect(paints).toBe(16);
});
it("bounds unavailable bootstrap without inventing a localhost fallback", async () => {
  let now = 0;
  await expect(waitDesktopBinding(async () => pending, () => {}, {
    now: () => now, sleep: async () => {now += 500;}, timeoutMs: 1000
  })).rejects.toThrow("not owned yet");
});
it("keeps owner mode's existing startup behavior", async () => {
  const owned = {...pending, mode: "owned" as const};
  expect(await waitDesktopBinding(async () => owned, () => {throw new Error("unexpected wait");})).toEqual(owned);
});
