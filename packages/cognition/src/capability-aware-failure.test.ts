import { describe, expect, it } from "vitest";
import {
  COGNITION_6W_VERSION,
  createCognitionCapabilityAwareFailureDisposition
} from "./capability-aware-task.js";

describe("Cognition 6W failure disposition", () => {
  for (const status of ["UNAVAILABLE", "CANCELLED", "ERROR"] as const) {
    it(`wraps Runtime ${status} as a canonical COMPLETE disposition`, () => {
      const result = createCognitionCapabilityAwareFailureDisposition({ status });

      expect(result).toMatchObject({
        version: COGNITION_6W_VERSION,
        kind: "COMPLETE",
        result: { status }
      });
      expect(Object.isFrozen(result)).toBe(true);
      if (result.kind === "COMPLETE") {
        expect(Object.isFrozen(result.result)).toBe(true);
      }
    });
  }

  it("delegates strict failure-shape validation to the existing 6A authority", () => {
    for (const invalid of [
      { status: "SUCCESS" },
      { status: "ERROR", provider: "should-not-pass" },
      { status: "ERROR", toolName: "should-not-pass" }
    ]) {
      expect(() => createCognitionCapabilityAwareFailureDisposition(invalid)).toThrow();
    }
  });
});
