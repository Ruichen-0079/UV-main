import { describe, expect, it } from "vitest";
import { cn } from "../lib/cn.js";

describe("product UI helpers", () => {
  it("merges class names without dropping later utilities", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });
});
