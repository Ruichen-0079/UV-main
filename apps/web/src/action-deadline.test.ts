import { afterEach, expect, it, vi } from "vitest";
import { withActionDeadline } from "./action-deadline.js";
import { request } from "./api/client.js";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("releases a stalled action without claiming the server cancelled it", async () => {
  vi.useFakeTimers();
  const abort = vi.fn();
  const pending = withActionDeadline(new Promise(() => {}), 25, abort);
  const result = expect(pending).rejects.toThrow("may still be completing");
  await vi.advanceTimersByTimeAsync(25);
  await result;
  expect(abort).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it("clears deadlines after success and preserves failures", async () => {
  vi.useFakeTimers();
  await expect(withActionDeadline(Promise.resolve(7))).resolves.toBe(7);
  await expect(withActionDeadline(Promise.reject(new Error("offline")))).rejects.toThrow("offline");
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds stalled response bodies and aborts transport", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async () => ({ ok: true, json: () => new Promise(() => {}) }));
  vi.stubGlobal("fetch", fetchMock);
  const pending = request("/product/configuration");
  const result = expect(pending).rejects.toThrow("may still be completing");
  await vi.advanceTimersByTimeAsync(60_000);
  await result;
  expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(
    true
  );
});
it("forwards caller cancellation while a request is pending", async () => {
  const controller = new AbortController();
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          signal = init.signal;
          signal!.addEventListener("abort", () => reject(new Error("caller aborted")));
        })
    )
  );
  const pending = request("/product/configuration", { signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toThrow("caller aborted");
  expect(signal?.aborted).toBe(true);
});
