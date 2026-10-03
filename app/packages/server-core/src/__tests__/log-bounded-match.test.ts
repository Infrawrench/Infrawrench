import { describe, expect, it } from "vitest";

import { compileLogSearch, evaluateLogMatches } from "@infrawrench/client-core";
import { RegexTimeoutError } from "@infrawrench/workflow-runtime";

import { evaluateLogMatchesBounded } from "../log-workspaces/bounded-match";

describe("evaluateLogMatchesBounded", () => {
  const text = [
    "GET /a 200",
    "GET /b 503",
    "",
    "POST /c 500",
    "GET /b 503",
    `${"x".repeat(2500)} 502`,
    "GET /d 404",
  ].join("\n");

  it("agrees with inline evaluation for regex and term searches", async () => {
    for (const expr of ["/ 5\\d\\d$/", "/get .* 50\\d/i", "503", "GET -503", "/nomatch/"]) {
      const search = compileLogSearch(expr);
      expect(await evaluateLogMatchesBounded(text, search, { matchCap: 2 }), expr).toEqual(
        evaluateLogMatches(text, search, { matchCap: 2 }),
      );
    }
  });

  it("fails a catastrophically backtracking regex instead of blocking", async () => {
    // Passes the shape guard (no quantified group), backtracks exponentially.
    const search = compileLogSearch(`/${"a?".repeat(40)}${"a".repeat(40)}/`);
    expect(search.error).toBeNull();
    await expect(
      evaluateLogMatchesBounded(`${"a".repeat(40)}\n`, search, { timeoutMs: 250 }),
    ).rejects.toBeInstanceOf(RegexTimeoutError);
  });
});
