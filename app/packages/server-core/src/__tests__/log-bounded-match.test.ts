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
    // Passes the shape guard (no quantified group) and can never match, so
    // the backtracking has to run to exhaustion: minutes on any runner.
    const search = compileLogSearch(`/${"a?".repeat(60)}${"a".repeat(60)}b/`);
    expect(search.error).toBeNull();
    await expect(
      evaluateLogMatchesBounded(`${"a".repeat(60)}\n`, search, { timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(RegexTimeoutError);
  });
});
