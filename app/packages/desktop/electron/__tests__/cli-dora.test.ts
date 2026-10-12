import { describe, expect, it } from "vitest";
import { doraWindow, parseDoraScope } from "../cli/commands/dora";

const NOW = Date.parse("2026-10-12T12:00:00Z");

describe("dora CLI flags", () => {
  it("defaults to the 30 days ending now", () => {
    expect(doraWindow({}, NOW)).toEqual({
      from: "2026-09-12T12:00:00.000Z",
      to: "2026-10-12T12:00:00.000Z",
    });
  });

  it("sizes the window from --last and honours --from/--to", () => {
    expect(doraWindow({ last: "2w" }, NOW).from).toBe("2026-09-28T12:00:00.000Z");
    expect(doraWindow({ from: "2026-10-01", to: "2026-10-08" }, NOW)).toEqual({
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-08T00:00:00.000Z",
    });
    expect(() => doraWindow({ from: "2026-10-08", to: "2026-10-01" }, NOW)).toThrow(/before/);
    expect(() => doraWindow({ last: "2y" }, NOW)).toThrow();
  });

  it("parses --scope into a dimension and value", () => {
    expect(parseDoraScope(undefined)).toEqual({});
    expect(parseDoraScope("environment=production")).toEqual({
      dimension: "environment",
      value: "production",
    });
    expect(parseDoraScope("owner=user:abc")).toEqual({ dimension: "owner", value: "user:abc" });
    expect(parseDoraScope("owner")).toEqual({ dimension: "owner", value: null });
    expect(() => parseDoraScope("=x")).toThrow();
  });
});
