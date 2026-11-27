import { describe, expect, test } from "vitest";
import { autolink } from "../autolink";
import { centreSquare } from "../avatar-upload";
import { checkHref, sortChecks, summarizeChecks } from "../checks";

const repo = { owner: "acme", repo: "infra" };

describe("a check's link", () => {
  test("goes to the run's page here when CI reported it", () => {
    expect(
      checkHref(repo, { runId: "run_1", targetUrl: "https://app.example.test/org/o/ci/run_1" }),
    ).toBe("/acme/infra/ci/runs/run_1");
  });

  test("else to the reporter's link, when a page may follow it", () => {
    expect(checkHref(repo, { runId: null, targetUrl: "https://deploy.example.test/42" })).toBe(
      "https://deploy.example.test/42",
    );
    expect(checkHref(repo, { runId: null, targetUrl: "/acme/infra/infrastructure/prod" })).toBe(
      "/acme/infra/infrastructure/prod",
    );
    expect(checkHref(repo, { runId: null, targetUrl: "javascript:alert(1)" })).toBeNull();
    expect(checkHref(repo, { runId: null, targetUrl: null })).toBeNull();
  });
});

describe("a list of checks", () => {
  const checks = [
    { context: "ci / lint", state: "success" },
    { context: "ci / test", state: "failure" },
    { context: "ci / build", state: "pending" },
    { context: "ci / audit", state: "error" },
    { context: "ci / fmt", state: "success" },
  ] as const;

  test("is summed up worst first, naming only what occurs", () => {
    expect(summarizeChecks(checks)).toEqual({
      title: "5 checks",
      detail: "1 failed, 1 errored, 1 running, 2 passed",
    });
    expect(summarizeChecks([{ state: "success" }])).toEqual({
      title: "1 check",
      detail: "1 passed",
    });
    expect(summarizeChecks([])).toEqual({ title: "0 checks", detail: "" });
  });

  test("shows failures first, then what runs, then what passed", () => {
    expect(sortChecks(checks).map((check) => check.context)).toEqual([
      "ci / audit",
      "ci / test",
      "ci / build",
      "ci / fmt",
      "ci / lint",
    ]);
  });
});

describe("a bio's links", () => {
  test("web addresses become links and the rest stays text", () => {
    expect(autolink("Notes at https://example.test/a?b=1#c and more")).toEqual([
      { text: "Notes at ", href: null },
      { text: "https://example.test/a?b=1#c", href: "https://example.test/a?b=1#c" },
      { text: " and more", href: null },
    ]);
    expect(autolink("no links here")).toEqual([{ text: "no links here", href: null }]);
    expect(autolink("")).toEqual([]);
  });

  test("the sentence's punctuation is not the address's", () => {
    expect(autolink("See https://example.test/docs.")).toEqual([
      { text: "See ", href: null },
      { text: "https://example.test/docs", href: "https://example.test/docs" },
      { text: ".", href: null },
    ]);
    expect(autolink("(at https://example.test/x), ok")[1]).toEqual({
      text: "https://example.test/x",
      href: "https://example.test/x",
    });
    // A bracket the address opened is its own.
    expect(autolink("https://example.test/wiki/A_(b)")[0]?.text).toBe(
      "https://example.test/wiki/A_(b)",
    );
  });

  test("markup and other schemes are text, never a link", () => {
    for (const text of [
      '<a href="javascript:alert(1)">x</a>',
      "<img src=x onerror=alert(1)>",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "ftp://example.test/file",
      "mailto:someone@example.test",
    ]) {
      expect(autolink(text), text).toEqual([{ text, href: null }]);
    }
    // An address stops at a quote or an angle bracket, so it cannot carry markup.
    expect(autolink('https://example.test/"><script>')).toEqual([
      { text: "https://example.test/", href: "https://example.test/" },
      { text: '"><script>', href: null },
    ]);
  });
});

describe("the square a picture is cropped to", () => {
  test("is the centre of the shorter side, no larger than the cap", () => {
    expect(centreSquare(1200, 800, 512)).toEqual({ sx: 200, sy: 0, side: 800, size: 512 });
    expect(centreSquare(300, 900, 512)).toEqual({ sx: 0, sy: 300, side: 300, size: 300 });
    expect(centreSquare(512, 512, 512)).toEqual({ sx: 0, sy: 0, side: 512, size: 512 });
  });
});
