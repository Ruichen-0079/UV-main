import { describe, expect, it } from "vitest";
import {
  buildMemoryScope,
  hashMemoryScope,
  MemoryScopeError,
  parseMemoryScope
} from "./scope.js";

describe("memory scope", () => {
  it("builds a stable scope for the same user and character", () => {
    const a = buildMemoryScope("user-a", "alice");
    const b = buildMemoryScope("user-a", "alice");
    expect(a).toBe(b);
    expect(a).toBe("yuvi:v1:user:user-a:character:alice");
    expect(parseMemoryScope(a)).toEqual({ userId: "user-a", characterId: "alice" });
  });

  it("isolates users and characters", () => {
    const aAlice = buildMemoryScope("user-a", "alice");
    const aLumi = buildMemoryScope("user-a", "lumi");
    const bAlice = buildMemoryScope("user-b", "alice");
    expect(aAlice).not.toBe(aLumi);
    expect(aAlice).not.toBe(bAlice);
    expect(aLumi).not.toBe(bAlice);
  });

  it("rejects empty ids", () => {
    expect(() => buildMemoryScope("", "alice")).toThrow(MemoryScopeError);
    expect(() => buildMemoryScope("user-a", "  ")).toThrow(MemoryScopeError);
  });

  it("encodes unicode and special characters stably", () => {
    const scope = buildMemoryScope("用户/A:1", "角色 名");
    const again = buildMemoryScope("用户/A:1", "角色 名");
    expect(scope).toBe(again);
    expect(parseMemoryScope(scope)).toEqual({
      userId: "用户/A:1",
      characterId: "角色 名"
    });
    expect(scope).toContain(encodeURIComponent("用户/A:1"));
  });

  it("hashes scopes without exposing content length secrets", () => {
    const hash = hashMemoryScope(buildMemoryScope("user-a", "alice"));
    expect(hash).toMatch(/^s[0-9a-f]{8}$/);
    expect(hash).toBe(hashMemoryScope(buildMemoryScope("user-a", "alice")));
  });
});
