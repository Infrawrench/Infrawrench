import { describe, expect, test } from "vitest";
import { safeImageUrl, safeLinkUrl, sitePath, webUrl } from "../safe-url";

/** Values from data that must never become a link or an image source. */
const REFUSED = [
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  " javascript:alert(1)",
  "\tjavascript:alert(1)",
  "java\tscript:alert(1)",
  "java\nscript:alert(1)",
  "javascript\u0000:alert(1)",
  "vbscript:msgbox(1)",
  "data:text/html,<script>alert(1)</script>",
  "data:image/svg+xml,<svg onload=alert(1)>",
  "DATA:text/html;base64,PHNjcmlwdD4=",
  "file:///etc/passwd",
  "blob:https://example.com/0000",
  "//evil.example/x",
  "/\\evil.example/x",
  "\\\\evil.example/x",
  "/\t/evil.example/x",
  "",
  null,
  undefined,
];

describe("safeLinkUrl", () => {
  test.each(REFUSED)("refuses %j", (value) => {
    expect(safeLinkUrl(value, { mailto: true })).toBeNull();
  });

  test.each([
    ["/acme/infra", "/acme/infra"],
    ["/acme/infra/issues?q=is%3Aopen#top", "/acme/infra/issues?q=is%3Aopen#top"],
    ["#L12", "#L12"],
    ["?tab=stars", "?tab=stars"],
    ["docs/runbook.md", "docs/runbook.md"],
    ["../README.md", "../README.md"],
    ["https://example.com/a?b#c", "https://example.com/a?b#c"],
    ["HTTP://Example.COM", "http://example.com/"],
  ])("keeps %j", (value, expected) => {
    expect(safeLinkUrl(value)).toBe(expected);
  });

  test("mailto only where the caller allows it", () => {
    expect(safeLinkUrl("mailto:a@example.com")).toBeNull();
    expect(safeLinkUrl("mailto:a@example.com", { mailto: true })).toBe("mailto:a@example.com");
  });
});

describe("safeImageUrl", () => {
  test.each([...REFUSED, "http://example.com/a.png", "mailto:a@example.com"])(
    "refuses %j",
    (value) => {
      expect(safeImageUrl(value)).toBeNull();
    },
  );

  test("keeps https and this site", () => {
    expect(safeImageUrl("https://example.com/a.png")).toBe("https://example.com/a.png");
    expect(safeImageUrl("/acme/infra/raw/main/a.png")).toBe("/acme/infra/raw/main/a.png");
    expect(safeImageUrl("images/a.png")).toBe("images/a.png");
  });
});

describe("sitePath", () => {
  test.each(["/", "/acme", "/acme/infra?x=1#y"])("keeps %j", (value) => {
    expect(sitePath(value)).toBe(value);
  });

  test.each([
    "//evil.example",
    "/\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "acme",
    "https://evil.example/",
    "javascript:alert(1)",
    undefined,
  ])("refuses %j", (value) => {
    expect(sitePath(value)).toBeNull();
  });
});

describe("webUrl", () => {
  test("only http and https, normalised", () => {
    expect(webUrl("https://example.com")).toBe("https://example.com/");
    expect(webUrl("example.com")).toBeNull();
    expect(webUrl("ftp://example.com")).toBeNull();
    expect(webUrl("https://exa mple.com")).toBeNull();
  });
});
