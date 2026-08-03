import { describe, expect, it } from "vitest";

import {
  compileLogSearch,
  computeAppendedLines,
  evaluateLogMatches,
  logStreamKey,
  splitLogLines,
  validateLogWorkspaceQuery,
  LOG_WORKSPACE_LIMITS,
  type LogStreamSelector,
} from "../log-workspaces";

const selector = (over: Partial<LogStreamSelector> = {}): LogStreamSelector => ({
  resourceId: "res-1",
  accountId: "acc-1",
  pluginId: "kubernetes",
  resourceTypeId: "k8s-pod",
  ...over,
});

describe("compileLogSearch", () => {
  it("matches every line for the empty expression", () => {
    const s = compileLogSearch("   ");
    expect(s.matchAll).toBe(true);
    expect(s.error).toBeNull();
    expect(s.test("anything at all")).toBe(true);
  });

  it("ANDs case-insensitive substring terms", () => {
    const s = compileLogSearch("ERROR timeout");
    expect(s.test("error: upstream timeout after 30s")).toBe(true);
    expect(s.test("error: connection refused")).toBe(false);
    expect(s.test("TIMEOUT but no e-word")).toBe(false);
  });

  it("supports quoted phrases and negation", () => {
    const s = compileLogSearch('"connection reset" -health');
    expect(s.test("upstream connection reset by peer")).toBe(true);
    expect(s.test("healthcheck: connection reset")).toBe(false);
    expect(s.test("connection was reset")).toBe(false);
  });

  it("treats /pattern/ as a regex, with optional i flag", () => {
    const caseSensitive = compileLogSearch("/HTTP [45]\\d\\d/");
    expect(caseSensitive.test("GET /x HTTP 502")).toBe(true);
    expect(caseSensitive.test("GET /x http 502")).toBe(false);
    expect(caseSensitive.test("GET /x HTTP 200")).toBe(false);

    const insensitive = compileLogSearch("/fatal|panic/i");
    expect(insensitive.test("PANIC: runtime error")).toBe(true);
  });

  it("reports invalid regexes instead of throwing, and matches nothing", () => {
    const s = compileLogSearch("/[unclosed/");
    expect(s.error).toMatch(/Invalid regex/);
    expect(s.test("[unclosed")).toBe(false);
  });
});

describe("splitLogLines", () => {
  it("drops the single trailing empty line from newline-terminated text", () => {
    expect(splitLogLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLogLines("a\nb")).toEqual(["a", "b"]);
    expect(splitLogLines("")).toEqual([]);
  });
});

describe("evaluateLogMatches", () => {
  const text = ["ok start", "ERROR one", "info", "ERROR two", "ERROR three", ""].join("\n");

  it("counts matching lines and samples the newest matches in order", () => {
    const result = evaluateLogMatches(text, compileLogSearch("error"), { sampleCap: 2 });
    expect(result.matchCount).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.samples).toEqual(["ERROR two", "ERROR three"]);
  });

  it("stops counting at the match cap and flags truncation", () => {
    const result = evaluateLogMatches(text, compileLogSearch("error"), {
      matchCap: 2,
      sampleCap: 5,
    });
    expect(result.matchCount).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.samples).toEqual(["ERROR two", "ERROR three"]);
  });

  it("returns zero matches for a non-matching expression", () => {
    const result = evaluateLogMatches(text, compileLogSearch("nomatch"));
    expect(result).toEqual({ matchCount: 0, truncated: false, samples: [] });
  });

  it("clips very long sample lines", () => {
    const long = `ERROR ${"x".repeat(400)}`;
    const result = evaluateLogMatches(`${long}\n`, compileLogSearch("error"));
    expect(result.samples[0]!.length).toBeLessThanOrEqual(301);
    expect(result.samples[0]!.endsWith("…")).toBe(true);
  });
});

describe("computeAppendedLines", () => {
  it("returns the suffix past the largest prev-suffix/next-prefix overlap", () => {
    expect(computeAppendedLines(["a", "b", "c"], ["b", "c", "d", "e"])).toEqual(["d", "e"]);
  });

  it("returns nothing when the windows are identical", () => {
    expect(computeAppendedLines(["a", "b"], ["a", "b"])).toEqual([]);
  });

  it("treats a disjoint window (rotation/burst) as all-new", () => {
    expect(computeAppendedLines(["a", "b"], ["x", "y"])).toEqual(["x", "y"]);
  });

  it("handles an empty previous window", () => {
    expect(computeAppendedLines([], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("prefers the largest overlap when lines repeat", () => {
    // prev tail "b, a" overlaps next head "b, a" (2 lines) — not just "a" (1).
    expect(computeAppendedLines(["a", "b", "a"], ["b", "a", "c"])).toEqual(["c"]);
  });
});

describe("validateLogWorkspaceQuery", () => {
  const valid = { name: "prod errors", resources: [selector()], search: "error" };

  it("accepts a canonical query", () => {
    expect(validateLogWorkspaceQuery(valid)).toBeNull();
  });

  it("rejects empty names, empty resource sets and over-cap resource sets", () => {
    expect(validateLogWorkspaceQuery({ ...valid, name: "  " })).toMatch(/Name is required/);
    expect(validateLogWorkspaceQuery({ ...valid, resources: [] })).toMatch(/at least one/);
    const tooMany = Array.from({ length: LOG_WORKSPACE_LIMITS.maxResourcesPerQuery + 1 }, (_, i) =>
      selector({ resourceId: `res-${i}` }),
    );
    expect(validateLogWorkspaceQuery({ ...valid, resources: tooMany })).toMatch(/at most/);
  });

  it("rejects duplicate selectors but allows the same resource with different containers", () => {
    expect(validateLogWorkspaceQuery({ ...valid, resources: [selector(), selector()] })).toMatch(
      /twice/,
    );
    expect(
      validateLogWorkspaceQuery({
        ...valid,
        resources: [selector({ container: "app" }), selector({ container: "sidecar" })],
      }),
    ).toBeNull();
  });

  it("rejects incomplete selectors and invalid search expressions", () => {
    expect(
      validateLogWorkspaceQuery({ ...valid, resources: [selector({ accountId: "" })] }),
    ).toMatch(/needs resourceId/);
    expect(validateLogWorkspaceQuery({ ...valid, search: "/[bad/" })).toMatch(/Invalid regex/);
  });
});

describe("logStreamKey", () => {
  it("distinguishes containers on the same resource", () => {
    expect(logStreamKey(selector({ container: "app" }))).not.toBe(
      logStreamKey(selector({ container: "sidecar" })),
    );
    expect(logStreamKey(selector())).toBe(logStreamKey(selector()));
  });
});
