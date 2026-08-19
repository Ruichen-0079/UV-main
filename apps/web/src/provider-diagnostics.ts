import type {
  ProviderAttempt,
  ProviderHealth,
  ProviderVerificationMode,
  ProviderVerificationResponse
} from "./api/client.js";

/**
 * UI copy for the two provider-diagnostics axes. `available` is a legacy
 * readiness projection, so dashboard copy must use these canonical fields
 * instead of presenting it as proof of remote reachability.
 */
export function providerReadinessLabel(readiness: ProviderHealth["readiness"]): string {
  switch (readiness) {
    case "ready":
      return "ready (local configuration)";
    case "not_ready":
      return "not ready (local configuration)";
    default:
      return "unknown (local configuration not loaded)";
  }
}

export function providerObservationLabel(observed: ProviderHealth["observed"]): string {
  switch (observed) {
    case "available":
      return "available (cached live observation)";
    case "degraded":
      return "degraded (cached live observation)";
    case "unavailable":
      return "unavailable (cached live observation)";
    default:
      return "unknown (no cached live observation)";
  }
}

export function cachedObservationDetail(
  health: Pick<ProviderHealth, "observed" | "lastVerifiedAt" | "lastErrorCode" | "lastError">
): string {
  const details = [providerObservationLabel(health.observed)];
  if (health.lastVerifiedAt) details.push(`last live check: ${health.lastVerifiedAt}`);
  if (health.lastErrorCode) details.push(`error code: ${health.lastErrorCode}`);
  if (health.lastError) details.push(`error: ${health.lastError}`);
  return details.join(" · ");
}

export function verificationModeFor(
  result: Pick<ProviderVerificationResponse, "configOnly" | "verificationMode">
): ProviderVerificationMode {
  return result.verificationMode ?? (result.configOnly ? "config_only" : "live");
}

export function verificationModeLabel(
  result: Pick<ProviderVerificationResponse, "configOnly" | "verificationMode">
): string {
  return verificationModeFor(result) === "config_only"
    ? "Config-only readiness inspection — no provider I/O"
    : "Live provider-I/O verification — potentially billable";
}

export function verificationOutcomeLabel(
  result: Pick<ProviderVerificationResponse, "ok" | "configOnly" | "verificationMode">
): string {
  if (verificationModeFor(result) === "config_only") {
    return result.ok ? "Local readiness inspection passed" : "Local readiness inspection failed";
  }
  return result.ok ? "Live verification passed" : "Live verification failed";
}

export function verificationModeExplanation(
  result: Pick<ProviderVerificationResponse, "configOnly" | "verificationMode">
): string {
  return verificationModeFor(result) === "config_only"
    ? "No provider call was made. A ready result does not prove remote reachability."
    : "This explicit action called a provider. It may be billable and records a cached observation.";
}

export function providerAttemptLabel(attempt: ProviderAttempt): string {
  if (attempt.status === "skipped") {
    return "skipped — route was not called (config-only inspection)";
  }
  return attempt.status;
}
