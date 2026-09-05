import { ApiError } from "./api/client.js";

export type ProactiveTurnAdmissionDecision = "accepted" | "denied";

export type ProactiveTurnAdmissionReason =
  | "runtime-admitted"
  | "consent-disabled"
  | "consent-unavailable"
  | "suppressed"
  | "not-eligible"
  | "stale-revision"
  | "execution-busy";

export type ProactiveTurnAdmission =
  | { decision: "accepted"; reason: "runtime-admitted" }
  | {
      decision: "denied";
      reason: Exclude<ProactiveTurnAdmissionReason, "runtime-admitted">;
    };

export const RUNTIME_ADMITTED: ProactiveTurnAdmission = {
  decision: "accepted",
  reason: "runtime-admitted"
};

export function admissionFromRuntimeError(error: unknown): ProactiveTurnAdmission | null {
  if (!(error instanceof ApiError) || error.status !== 409) {
    return null;
  }
  if (error.error !== "proactive_not_admitted") {
    return null;
  }
  if (
    error.reason === "consent-disabled" ||
    error.reason === "suppressed" ||
    error.reason === "not-eligible" ||
    error.reason === "stale-revision"
  ) {
    return { decision: "denied", reason: error.reason };
  }
  return { decision: "denied", reason: "not-eligible" };
}
