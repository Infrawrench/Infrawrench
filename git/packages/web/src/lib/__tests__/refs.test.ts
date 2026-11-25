import { describe, expect, test } from "vitest";
import { paths } from "../paths";
import { parseCompare, pathCrumbs, resolveRelative, splitRefPath } from "../refs";

const refs = ["main", "feature/x", "feature/x-2", "release/2026.11", "v1.0.0"];

describe("splitRefPath", () => {
  test("a plain branch and a path", () => {
    expect(splitRefPath("main/src/a.ts", refs)).toEqual({ ref: "main", path: "src/a.ts" });
  });

  test("a branch with a slash takes its whole name", () => {
    expect(splitRefPath("feature/x/src/a.ts", refs)).toEqual({
      ref: "feature/x",
      path: "src/a.ts",
    });
    expect(splitRefPath("release/2026.11", refs)).toEqual({ ref: "release/2026.11", path: "" });
  });

  test("the longest ref wins over a shorter one that is also a prefix", () => {
    expect(splitRefPath("feature/x/y/a.ts", [...refs, "feature/x/y"])).toEqual({
      ref: "feature/x/y",
      path: "a.ts",
    });
  });

  test("a full commit id is the ref whatever the ref list holds", () => {
    const oid = "3b18e512dba79e4c8300dd08aeb37f8e728b8dad";
    expect(splitRefPath(`${oid}/docs/x.md`, [oid + "/docs"])).toEqual({
      ref: oid,
      path: "docs/x.md",
    });
  });

  test("an unknown first segment is taken as the ref", () => {
    expect(splitRefPath("3b18e51/src/a.ts", refs)).toEqual({ ref: "3b18e51", path: "src/a.ts" });
  });

  test("empty and trailing slashes", () => {
    expect(splitRefPath("", refs)).toEqual({ ref: "", path: "" });
    expect(splitRefPath("main/src/", refs)).toEqual({ ref: "main", path: "src" });
  });

  test("round-trips through the URL builders", () => {
    const repo = { owner: "acme", repo: "infra" };
    for (const [ref, path] of [
      ["feature/x", "modules/network/main.tf"],
      ["main", "docs/a file#1.md"],
      ["v1.0.0", ""],
    ] as const) {
      const url = paths.tree(repo, ref, path);
      const splat = decodeURIComponent(url.slice("/acme/infra/tree/".length));
      expect(splitRefPath(splat, refs)).toEqual({ ref, path });
    }
  });
});

describe("parseCompare", () => {
  test("base and head, with slashes on both sides", () => {
    expect(parseCompare("main...feature/x")).toEqual({ base: "main", head: "feature/x" });
    expect(parseCompare("release/2026.11...feature/x-2")).toEqual({
      base: "release/2026.11",
      head: "feature/x-2",
    });
  });

  test("head alone compares against the default branch", () => {
    expect(parseCompare("feature/x")).toEqual({ base: null, head: "feature/x" });
  });

  test("nothing, or half a pair, is no comparison", () => {
    expect(parseCompare("")).toBeNull();
    expect(parseCompare("main...")).toBeNull();
    expect(parseCompare("...main")).toBeNull();
  });

  test("round-trips through paths.compare", () => {
    const url = paths.compare({ owner: "a", repo: "b" }, "main", "feature/x");
    expect(parseCompare(decodeURIComponent(url.slice("/a/b/compare/".length)))).toEqual({
      base: "main",
      head: "feature/x",
    });
  });
});

describe("resolveRelative", () => {
  test("relative to the file's directory", () => {
    expect(resolveRelative("docs/guide.md", "images/a.png")).toBe("docs/images/a.png");
    expect(resolveRelative("docs/guide.md", "./b.md#top")).toBe("docs/b.md");
    expect(resolveRelative("docs/guide.md", "../README.md")).toBe("README.md");
    expect(resolveRelative("README.md", "/docs/x.md")).toBe("docs/x.md");
  });

  test("URLs, anchors and paths that climb out are left alone", () => {
    expect(resolveRelative("README.md", "https://example.com/a")).toBeNull();
    expect(resolveRelative("README.md", "mailto:a@example.com")).toBeNull();
    expect(resolveRelative("README.md", "#section")).toBeNull();
    expect(resolveRelative("README.md", "//example.com/a")).toBeNull();
    expect(resolveRelative("README.md", "../outside")).toBeNull();
  });
});

test("pathCrumbs", () => {
  expect(pathCrumbs("a/b/c.ts")).toEqual([
    { name: "a", path: "a" },
    { name: "b", path: "a/b" },
    { name: "c.ts", path: "a/b/c.ts" },
  ]);
  expect(pathCrumbs("")).toEqual([]);
});
