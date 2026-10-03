import { describe, expect, it } from "vitest";
import { dialTargets } from "../driver.js";

describe("redis dialTargets", () => {
  it("reports host and default port", () => {
    expect(dialTargets("rediss://:pw@cache.example.com")).toEqual([
      { kind: "host", host: "cache.example.com", port: 6379 },
    ]);
  });

  it("reads host and port from the query when the authority is empty", () => {
    expect(dialTargets("redis://?host=10.0.0.5&port=7000")).toEqual([
      { kind: "host", host: "10.0.0.5", port: 7000 },
    ]);
  });

  it.each(["/tmp/redis.sock", "redis://x?path=/tmp/redis.sock", "cache.example.com:6379"])(
    "reports %s as local",
    (cs) => {
      expect(dialTargets(cs)[0]!.kind).toBe("local");
    },
  );
});
