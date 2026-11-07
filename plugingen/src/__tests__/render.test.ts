import { describe, expect, it } from "vitest";
import type { CheckReport } from "../check.js";
import { codeSpan, fenced, oneLine } from "../text.js";
import { decodeIssues, decodePullRequests } from "../watch/github.js";
import { distillOutput } from "../watch/typecheck.js";
import {
  branchFor,
  issueTitle,
  pluginOfBranch,
  pluginOfIssueTitle,
  renderIssueBody,
  renderPullRequestBody,
} from "../watch/render.js";

const changed: CheckReport = {
  plugin: "acme",
  status: "changed",
  reason: "",
  specUrls: ["https://vendor.test/doc.json"],
  operations: ["GET /a", "POST /b"],
  documents: [],
};

describe("renderPullRequestBody", () => {
  it("gives the document, the operations and a passing typecheck", () => {
    const body = renderPullRequestBody(changed, { state: "passed" });
    expect(body).toContain("https://vendor.test/doc.json");
    expect(body).toContain("- `GET /a`");
    expect(body).toContain("- `POST /b`");
    expect(body).toContain("compiles");
  });

  it("states a failed typecheck plainly, with the output", () => {
    const body = renderPullRequestBody(changed, { state: "failed", output: "error TS2322" });
    expect(body).toContain("does not compile");
    expect(body).toContain("error TS2322");
  });

  it("does not claim a result it does not have", () => {
    const body = renderPullRequestBody(changed, { state: "not-run", reason: "no turbo" });
    expect(body).toContain("did not run");
    expect(body).not.toContain("compile");
  });

  it("keeps hostile compiler output inside its fence", () => {
    const hostile = "```\n# Injected\n@someone [click](https://evil.test)\n```````\n";
    const body = renderPullRequestBody(changed, { state: "failed", output: hostile });
    const fence = /^(`{3,})text$/m.exec(body)?.[1] ?? "";
    expect(fence.length).toBeGreaterThan(7);
    const start = body.indexOf(`${fence}text`);
    const end = body.indexOf(`\n${fence}`, start + 1);
    expect(body.slice(start, end)).toContain("# Injected");
    expect(body.slice(end + fence.length + 1)).not.toContain("Injected");
  });

  it("caps a long operation list", () => {
    const many = { ...changed, operations: Array.from({ length: 250 }, (_, i) => `GET /${i}`) };
    const body = renderPullRequestBody(many, { state: "passed" });
    expect(body).toContain("and 50 more");
    expect(body.length).toBeLessThan(65_536);
  });

  it("stays under GitHub's body limit with a huge typecheck", () => {
    const body = renderPullRequestBody(changed, {
      state: "failed",
      output: "x".repeat(10_000_000),
    });
    expect(body.length).toBeLessThan(65_536);
  });
});

describe("renderIssueBody", () => {
  it("fences the reason, which can quote the document", () => {
    const body = renderIssueBody({
      ...changed,
      status: "could-not-check",
      failure: "parse",
      reason: "no longer parses: <img src=x> @someone",
    });
    expect(body).toMatch(/```text\nno longer parses: <img src=x> @someone\n```/);
    expect(body).toContain("`parse`");
    expect(body).toContain("pnpm plugingen check acme");
  });

  it("does not vary from run to run, so an open issue is not edited daily", () => {
    const input = {
      ...changed,
      status: "could-not-check" as const,
      failure: "patch" as const,
      reason: "r",
    };
    expect(renderIssueBody(input)).toBe(renderIssueBody(input));
  });
});

describe("text", () => {
  it("oneLine removes what a log or terminal would act on", () => {
    expect(oneLine("a\r\n::error::b\u001b[31mc\u0007‮")).toBe("a ::error::bc");
    expect(oneLine("x".repeat(600))).toHaveLength(503);
  });

  it("fenced survives backticks and strips controls", () => {
    expect(fenced("a```b\u0000")).toBe("````text\na```b\n````");
  });

  it("codeSpan cannot be closed early", () => {
    expect(codeSpan("a`b\nc")).toBe("`a'b c`");
  });
});

describe("distillOutput", () => {
  const turbo = (time: string, cache: string) => `
   • Running typecheck in 1 packages
cache ${cache}, executing f29f39cc7c4f0ce8
$ tsc --noEmit
src/pricing.ts(184,38): error TS2345: Argument of type 'number' is not assignable.
  Time:    ${time}
`;

  it("keeps the diagnostics and drops what differs between runs", () => {
    expect(distillOutput(turbo("2.8s", "miss"))).toBe(
      "src/pricing.ts(184,38): error TS2345: Argument of type 'number' is not assignable.",
    );
    expect(distillOutput(turbo("9.1s", "hit"))).toBe(distillOutput(turbo("2.8s", "miss")));
  });

  it("keeps the rest when something other than the compiler failed", () => {
    const output = distillOutput(
      `cache miss, executing abc\nERROR run failed: build of plugin-base\n  Time: 1s`,
    );
    expect(output).toBe("ERROR run failed: build of plugin-base");
  });
});

describe("names", () => {
  it("round-trips the branch and the issue title", () => {
    expect(pluginOfBranch(branchFor("acme"))).toBe("acme");
    expect(pluginOfIssueTitle(issueTitle("acme-2"))).toBe("acme-2");
  });

  it("ignores near misses", () => {
    expect(pluginOfBranch("feature/plugingen/acme")).toBeUndefined();
    expect(pluginOfIssueTitle(`Re: ${issueTitle("acme")}`)).toBeUndefined();
    expect(
      pluginOfIssueTitle("plugingen: a b could not be checked against its vendor document"),
    ).toBeUndefined();
  });
});

describe("decoding gh output", () => {
  it("keeps this repository's plugingen branches only", () => {
    const rows = [
      { number: 1, url: "u1", body: "b", headRefName: "plugingen/acme", isCrossRepository: false },
      { number: 2, url: "u2", body: "b", headRefName: "plugingen/acme", isCrossRepository: true },
      { number: 3, url: "u3", body: "b", headRefName: "feat/other", isCrossRepository: false },
      { number: "x" },
    ];
    expect(decodePullRequests(JSON.stringify(rows))).toEqual([
      { number: 1, url: "u1", plugin: "acme", body: "b" },
    ]);
  });

  it("matches an issue by its exact title", () => {
    const rows = [
      { number: 1, title: issueTitle("acme"), body: "b" },
      { number: 2, title: `${issueTitle("acme")}!`, body: "b" },
    ];
    expect(decodeIssues(JSON.stringify(rows))).toEqual([{ number: 1, plugin: "acme", body: "b" }]);
  });
});
