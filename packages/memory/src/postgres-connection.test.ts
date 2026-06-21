import { getDefaultResultOrder } from "node:dns";
import { describe, expect, it } from "vitest";
import { normalizePostgresConnectionString } from "./postgres-connection.js";

describe("normalizePostgresConnectionString", () => {
  it("rewrites localhost postgres URLs only on Windows", () => {
    expect(
      normalizePostgresConnectionString(
        "postgres://yuvi:pass@localhost:5432/yuvi?sslmode=disable",
        "win32"
      )
    ).toBe("postgres://yuvi:pass@127.0.0.1:5432/yuvi?sslmode=disable");

    expect(
      normalizePostgresConnectionString(
        "postgresql://yuvi:pass@localhost:5432/yuvi?sslmode=disable",
        "win32"
      )
    ).toBe("postgresql://yuvi:pass@127.0.0.1:5432/yuvi?sslmode=disable");
  });

  it("leaves non-Windows and non-localhost URLs unchanged", () => {
    const localhostUrl = "postgres://yuvi:pass@localhost:5432/yuvi";
    expect(normalizePostgresConnectionString(localhostUrl, "linux")).toBe(localhostUrl);

    const ipv4Url = "postgres://yuvi:pass@127.0.0.1:5432/yuvi";
    expect(normalizePostgresConnectionString(ipv4Url, "win32")).toBe(ipv4Url);

    const remoteUrl = "postgres://yuvi:pass@db.internal:5432/yuvi";
    expect(normalizePostgresConnectionString(remoteUrl, "win32")).toBe(remoteUrl);

    const ipv6Url = "postgres://yuvi:pass@[::1]:5432/yuvi";
    expect(normalizePostgresConnectionString(ipv6Url, "win32")).toBe(ipv6Url);
  });

  it("leaves invalid and non-postgres strings unchanged", () => {
    expect(normalizePostgresConnectionString("localhost:5432", "win32")).toBe("localhost:5432");
    expect(normalizePostgresConnectionString("mysql://localhost/db", "win32")).toBe(
      "mysql://localhost/db"
    );
  });
});

describe("memory module imports", () => {
  it("do not change Node DNS default result order", async () => {
    const before = getDefaultResultOrder();
    await import("./index.js");
    expect(getDefaultResultOrder()).toBe(before);
  });
});
