import { describe, expect, it } from "vitest";
import {
  ALLOWLISTED_SYSTEMD_UNIT_NAMES,
  assertAllowlistedUnit,
  defaultSttThreadCount,
  isLocalAiServiceId,
  systemdUnitFor
} from "./index.js";

describe("local AI allowlist", () => {
  it("accepts known service ids and rejects unknown ones", () => {
    expect(isLocalAiServiceId("alice")).toBe(true);
    expect(isLocalAiServiceId("alice.wrapper")).toBe(true);
    expect(isLocalAiServiceId("runtime")).toBe(false);
    expect(isLocalAiServiceId("yidian-local-agent.service")).toBe(false);
  });

  it("maps only allowlisted systemd units", () => {
    expect(systemdUnitFor("alice.upstream")).toBe("gpt-sovits-upstream.service");
    expect(systemdUnitFor("alice.wrapper")).toBe("alice-tts-wrapper.service");
    expect(systemdUnitFor("embedding")).toBe("yuvi-local-embedding.service");
    expect(systemdUnitFor("stt")).toBeNull();
    expect(systemdUnitFor("local-llm")).toBeNull();
    expect(ALLOWLISTED_SYSTEMD_UNIT_NAMES.has("yidian-local-agent.service")).toBe(false);
    expect(ALLOWLISTED_SYSTEMD_UNIT_NAMES.has("sunshine.service")).toBe(false);
  });

  it("refuses arbitrary systemd unit names", () => {
    expect(() => assertAllowlistedUnit("yidian-local-agent.service")).toThrow(/not allowlisted/);
    expect(() => assertAllowlistedUnit("alice-tts-wrapper.service; rm -rf /")).toThrow(
      /not allowlisted/
    );
  });

  it("does not consume every CPU thread for STT", () => {
    expect(defaultSttThreadCount(24)).toBe(4);
    expect(defaultSttThreadCount(8)).toBe(2);
    expect(defaultSttThreadCount(2)).toBe(1);
    expect(defaultSttThreadCount(64)).toBe(4);
  });
});
