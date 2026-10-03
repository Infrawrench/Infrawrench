import { describe, expect, it } from "vitest";
import { dialTargets } from "../driver.js";

describe("libsql dialTargets", () => {
  it("reports a remote database", () => {
    expect(dialTargets("libsql://db-org.turso.io?authToken=x")).toEqual([
      { kind: "host", host: "db-org.turso.io", port: 443 },
    ]);
  });

  it.each(["file:/etc/passwd", "file:local.db", ":memory:"])("reports %s as local", (cs) => {
    expect(dialTargets(cs)[0]!.kind).toBe("local");
  });
});
