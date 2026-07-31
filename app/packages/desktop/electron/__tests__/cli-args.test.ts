import { describe, expect, it, vi } from "vitest";

// `cli/args` reaches `cli/context` for CliError, which pulls the Electron app
// object and the plugin host at import time. None of it runs here.
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  ipcMain: { handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import { parseCliArgs, parseLastDays, resolveDayWindow } from "../cli/args";

describe("parseCliArgs — flags for changes / graph / anomalies", () => {
  it("reads --anomalies as a costs modifier, not a command", () => {
    const parsed = parseCliArgs(["costs", "--anomalies"]);
    expect(parsed.positionals).toEqual(["costs"]);
    expect(parsed.anomalies).toBe(true);
  });

  it("defaults --anomalies off", () => {
    expect(parseCliArgs(["costs"]).anomalies).toBe(false);
  });

  it("parses the numeric window flags as numbers", () => {
    const { range } = parseCliArgs(["changes", "--days", "14", "--limit", "20"]);
    expect(range.days).toBe(14);
    expect(range.limit).toBe(20);
  });

  it("rejects a non-integer window with exit code 2", () => {
    expect(() => parseCliArgs(["changes", "--days", "2.5"])).toThrow(/whole number/);
    try {
      parseCliArgs(["changes", "--limit", "0"]);
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as { exitCode?: number }).exitCode).toBe(2);
    }
  });

  it("carries --kind and --resource through unparsed", () => {
    const { range } = parseCliArgs([
      "changes",
      "--kind",
      "updated",
      "--resource",
      "acct:droplet:123",
    ]);
    expect(range.kind).toBe("updated");
    expect(range.resource).toBe("acct:droplet:123");
  });

  it("leaves the new flags undefined when absent", () => {
    const { range } = parseCliArgs(["graph"]);
    expect(range.days).toBeUndefined();
    expect(range.limit).toBeUndefined();
    expect(range.kind).toBeUndefined();
    expect(range.resource).toBeUndefined();
  });
});

describe("parseLastDays", () => {
  it("converts days, weeks and months", () => {
    expect(parseLastDays("7d")).toBe(7);
    expect(parseLastDays("2w")).toBe(14);
    expect(parseLastDays("3m")).toBe(90);
  });

  it("rejects an hour span — these commands are day-granular", () => {
    expect(() => parseLastDays("6h")).toThrow(/Invalid --last/);
  });
});

describe("resolveDayWindow", () => {
  it("falls back to the caller's default", () => {
    expect(resolveDayWindow({}, 30, 90)).toBe(30);
  });

  it("prefers an explicit --days over --last", () => {
    expect(resolveDayWindow({ days: 7, last: "30d" }, 30, 90)).toBe(7);
  });

  it("converts --last", () => {
    expect(resolveDayWindow({ last: "2w" }, 30, 90)).toBe(14);
  });

  it("refuses a window the endpoint would reject, before the round trip", () => {
    expect(() => resolveDayWindow({ days: 120 }, 30, 90)).toThrow(/at most 90 days/);
  });
});
