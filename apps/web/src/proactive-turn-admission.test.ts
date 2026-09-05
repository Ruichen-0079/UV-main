import { describe, expect, it } from "vitest";
import { ApiError } from "./api/client.js";
import { admissionFromRuntimeError, RUNTIME_ADMITTED } from "./proactive-turn-admission.js";

describe("proactive text turn admission", () => {
  it("treats Runtime as the only semantic admission authority", () => {
    expect(RUNTIME_ADMITTED).toEqual({ decision: "accepted", reason: "runtime-admitted" });
  });

  it("maps Runtime 409 admission denials", () => {
    expect(
      admissionFromRuntimeError(
        new ApiError("denied", 409, { error: "proactive_not_admitted", reason: "suppressed" })
      )
    ).toEqual({ decision: "denied", reason: "suppressed" });
    expect(
      admissionFromRuntimeError(
        new ApiError("denied", 409, { error: "proactive_not_admitted", reason: "consent-disabled" })
      )
    ).toEqual({ decision: "denied", reason: "consent-disabled" });
  });

  it("does not treat ordinary transport failures as policy admission", () => {
    expect(admissionFromRuntimeError(new ApiError("down", 500))).toBeNull();
    expect(admissionFromRuntimeError(new Error("nope"))).toBeNull();
  });
});
