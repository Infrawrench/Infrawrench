import { describe, expect, it } from "vitest";
import { findingCodeAnchor, resolveNeedsCode, traceCodeAnchor } from "../needs-code";

describe("resolveNeedsCode", () => {
  const none = { file: false, line: false };
  const file = { file: true, line: false };
  const lines = { file: true, line: true };

  it("follows the lines when the writer says nothing", () => {
    expect(resolveNeedsCode(undefined, lines)).toBe(true);
    expect(resolveNeedsCode(null, lines)).toBe(true);
    expect(resolveNeedsCode(undefined, file)).toBe(false);
    expect(resolveNeedsCode(undefined, none)).toBe(false);
  });

  it("keeps a false as said, whatever the entry points at", () => {
    expect(resolveNeedsCode(false, lines)).toBe(false);
    expect(resolveNeedsCode(false, file)).toBe(false);
    expect(resolveNeedsCode(false, none)).toBe(false);
  });

  it("keeps a true only where there is a file to show", () => {
    expect(resolveNeedsCode(true, lines)).toBe(true);
    expect(resolveNeedsCode(true, file)).toBe(true);
    expect(resolveNeedsCode(true, none)).toBe(false);
  });
});

describe("what an entry points at", () => {
  it("is a trace entry's anchors, with a line where one starts on a line", () => {
    expect(traceCodeAnchor([])).toEqual({ file: false, line: false });
    expect(traceCodeAnchor([{ startLine: null }, {}])).toEqual({ file: true, line: false });
    expect(traceCodeAnchor([{}, { startLine: 4 }])).toEqual({ file: true, line: true });
  });

  it("is a finding's path, with a line where either end is given", () => {
    expect(findingCodeAnchor({ path: null, startLine: null, endLine: null })).toEqual({
      file: false,
      line: false,
    });
    expect(findingCodeAnchor({ path: "a.ts", startLine: null, endLine: null })).toEqual({
      file: true,
      line: false,
    });
    expect(findingCodeAnchor({ path: "a.ts", startLine: 3, endLine: null })).toEqual({
      file: true,
      line: true,
    });
    expect(findingCodeAnchor({ path: "a.ts", startLine: null, endLine: 3 })).toEqual({
      file: true,
      line: true,
    });
    // Lines mean nothing without a file.
    expect(findingCodeAnchor({ path: null, startLine: 3, endLine: 3 })).toEqual({
      file: false,
      line: false,
    });
  });
});
