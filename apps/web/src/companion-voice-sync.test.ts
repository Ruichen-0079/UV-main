import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanionBus } from "./companion-bus.js";
import {
  COMPANION_READY_INTERVAL_MS,
  COMPANION_READY_HEARTBEAT_MS,
  COMPANION_READY_MAX_ATTEMPTS,
  createCompanionReadyAnnouncer
} from "./companion-voice-sync.js";

describe("createCompanionReadyAnnouncer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("announces ready immediately and stops fast retries once the main window syncs", () => {
    vi.useFakeTimers();
    const announced: string[] = [];
    const announcer = createCompanionReadyAnnouncer({
      post: (message) => announced.push(message.kind)
    });
    announcer.start();
    expect(announced).toEqual(["companion-ready"]);
    vi.advanceTimersByTime(COMPANION_READY_INTERVAL_MS * 2);
    expect(announced).toHaveLength(3);
    announcer.markSynced();
    vi.advanceTimersByTime(COMPANION_READY_INTERVAL_MS * 3);
    expect(announced).toHaveLength(3);
    announcer.stop();
  });

  it("keeps a slow ready heartbeat after sync so a reopened main can reconnect", () => {
    vi.useFakeTimers();
    const announced: string[] = [];
    const announcer = createCompanionReadyAnnouncer({
      post: (message) => announced.push(message.kind)
    });
    announcer.start();
    announcer.markSynced();
    const countAfterSync = announced.length;
    vi.advanceTimersByTime(COMPANION_READY_HEARTBEAT_MS);
    expect(announced).toHaveLength(countAfterSync + 1);
    vi.advanceTimersByTime(COMPANION_READY_HEARTBEAT_MS);
    expect(announced).toHaveLength(countAfterSync + 2);
    announcer.stop();
  });

  it("gives up after a bounded number of attempts", () => {
    vi.useFakeTimers();
    const announced: string[] = [];
    const announcer = createCompanionReadyAnnouncer({
      post: (message) => announced.push(message.kind)
    });
    announcer.start();
    vi.advanceTimersByTime(COMPANION_READY_INTERVAL_MS * (COMPANION_READY_MAX_ATTEMPTS + 2));
    expect(announced).toHaveLength(COMPANION_READY_MAX_ATTEMPTS);
    announcer.stop();
  });

  it("converges with the main window: ready is acknowledged with voice-enabled", async () => {
    const main = new CompanionBus("main");
    const companion = new CompanionBus("companion");
    let readyObserved = 0;
    main.subscribe((message) => {
      if (message.kind === "companion-ready") {
        readyObserved += 1;
        main.post({ kind: "voice-enabled", enabled: true });
      }
    });
    let synced = false;
    const announcer = createCompanionReadyAnnouncer(companion);
    companion.subscribe((message) => {
      if (message.kind === "voice-enabled" && message.enabled) {
        synced = true;
        announcer.markSynced();
      }
    });
    try {
      announcer.start();
      await vi.waitFor(() => expect(synced).toBe(true));
      expect(readyObserved).toBeGreaterThan(0);
    } finally {
      announcer.stop();
      main.close();
      companion.close();
    }
  });
});
