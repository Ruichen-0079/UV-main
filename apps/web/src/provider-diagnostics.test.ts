import { describe, expect, it } from "vitest";
import {
  cachedObservationDetail,
  providerAttemptLabel,
  providerObservationLabel,
  providerReadinessLabel,
  verificationModeExplanation,
  verificationModeLabel,
  verificationOutcomeLabel
} from "./provider-diagnostics.js";

describe("provider diagnostics presentation", () => {
  it("keeps local readiness separate from remote observation", () => {
    expect(providerReadinessLabel("ready")).toBe("ready (local configuration)");
    expect(providerReadinessLabel(undefined)).toBe("unknown (local configuration not loaded)");
    expect(providerObservationLabel("unknown")).toBe("unknown (no cached live observation)");
    expect(
      cachedObservationDetail({
        observed: "unavailable",
        lastVerifiedAt: "2026-08-19T12:00:00.000Z",
        lastErrorCode: "PROVIDER_UNAVAILABLE",
        lastError: "Provider verification failed safely."
      })
    ).toContain("cached live observation");
  });

  it("never presents config-only inspection or skipped routes as live success", () => {
    const configOnly = { ok: true, configOnly: true, verificationMode: "config_only" } as const;
    expect(verificationModeLabel(configOnly)).toContain("no provider I/O");
    expect(verificationOutcomeLabel(configOnly)).toBe("Local readiness inspection passed");
    expect(verificationModeExplanation(configOnly)).toContain("does not prove remote reachability");
    expect(
      verificationOutcomeLabel({ ok: false, configOnly: true, verificationMode: "config_only" })
    ).toBe("Local readiness inspection failed");
    expect(providerAttemptLabel({ provider: "xai", status: "skipped" })).toContain(
      "route was not called"
    );
  });

  it("labels explicit live verification as provider I/O that may be billable", () => {
    const live = { ok: true, verificationMode: "live" } as const;
    expect(verificationModeLabel(live)).toContain("potentially billable");
    expect(verificationOutcomeLabel(live)).toBe("Live verification passed");
    expect(verificationModeExplanation(live)).toContain("called a provider");
  });
});
