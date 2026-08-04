import { describe, expect, it } from "vitest";
import {
  AsyncRequestGeneration,
  beginAsyncDataRefresh,
  completeAsyncDataFailure,
  completeAsyncDataSuccess,
  isAbortError,
  type AsyncDataSnapshot
} from "./async-data-state.js";

describe("async request generation", () => {
  it("keeps independent probes isolated", () => {
    const health = new AsyncRequestGeneration();
    const providers = new AsyncRequestGeneration();
    health.mount();
    providers.mount();
    const healthRequest = health.next();
    const providerRequest = providers.next();

    health.next();

    expect(health.isCurrent(healthRequest)).toBe(false);
    expect(providers.isCurrent(providerRequest)).toBe(true);
  });

  it("accepts the latest request and ignores a late older response", () => {
    const generation = new AsyncRequestGeneration();
    generation.mount();
    const older = generation.next();
    const latest = generation.next();

    expect(generation.isCurrent(older)).toBe(false);
    expect(generation.isCurrent(latest)).toBe(true);
  });

  it("survives the StrictMode-equivalent setup, cleanup and setup cycle", () => {
    const generation = new AsyncRequestGeneration();
    generation.mount();
    const firstMountRequest = generation.next();
    generation.cleanup();
    generation.mount();
    const secondMountRequest = generation.next();

    expect(generation.isCurrent(firstMountRequest)).toBe(false);
    expect(generation.isCurrent(secondMountRequest)).toBe(true);
  });

  it("rejects completion after component cleanup", () => {
    const generation = new AsyncRequestGeneration();
    generation.mount();
    const request = generation.next();
    generation.cleanup();

    expect(generation.isMounted()).toBe(false);
    expect(generation.isCurrent(request)).toBe(false);
  });
});

describe("async data state", () => {
  const loaded: AsyncDataSnapshot<{ status: string }> = {
    data: { status: "healthy" },
    error: null,
    loading: false
  };

  it("preserves the last valid data during refresh and after refresh failure", () => {
    const refreshing = beginAsyncDataRefresh(loaded, true);
    const failed = completeAsyncDataFailure(refreshing, "Server unavailable");

    expect(refreshing).toEqual({ data: loaded.data, error: null, loading: true });
    expect(failed).toEqual({
      data: loaded.data,
      error: "Server unavailable",
      loading: false
    });
  });

  it("can explicitly clear data for consumers that opt out of preservation", () => {
    expect(beginAsyncDataRefresh(loaded, false).data).toBeNull();
  });

  it("keeps false, zero and empty arrays as reported values", () => {
    expect(completeAsyncDataSuccess(false).data).toBe(false);
    expect(completeAsyncDataSuccess(0).data).toBe(0);
    expect(completeAsyncDataSuccess([]).data).toEqual([]);
  });

  it("recognizes cancellation separately from ordinary failures", () => {
    const cancelled = new Error("cancelled");
    cancelled.name = "AbortError";
    expect(isAbortError(cancelled)).toBe(true);
    expect(isAbortError(new Error("network failed"))).toBe(false);
  });
});
