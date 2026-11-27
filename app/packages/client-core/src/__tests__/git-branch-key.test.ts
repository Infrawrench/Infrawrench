import { describe, expect, it } from "vitest";
import { formatGitBranchKey, gitBranchPagePath, parseGitBranchKey } from "../git-branch-key";

describe("a branch page's key", () => {
  it("is the branch's name, slashes and all", () => {
    expect(parseGitBranchKey("feature/a/b")).toEqual({
      fork: null,
      branch: "feature/a/b",
      ordinal: null,
    });
  });

  it("names a fork's branch with the fork before a colon", () => {
    expect(parseGitBranchKey("bob/infra:feature/a")).toEqual({
      fork: { owner: "bob", name: "infra" },
      branch: "feature/a",
      ordinal: null,
    });
    expect(parseGitBranchKey("-:feature/a")).toEqual({
      fork: "gone",
      branch: "feature/a",
      ordinal: null,
    });
  });

  it("names an earlier page of a reused name with ~n", () => {
    expect(parseGitBranchKey("fix/login~2")).toEqual({
      fork: null,
      branch: "fix/login",
      ordinal: 2,
    });
    expect(parseGitBranchKey("bob/infra:fix~10")?.ordinal).toBe(10);
  });

  it("refuses what is no key", () => {
    for (const text of ["", "~2", "bob:feature", "a/b/c:feature", "/infra:feature", "a:b:c"]) {
      expect(parseGitBranchKey(text), text).toBeNull();
    }
    // `~0` and `~x` are no ordinal, and a branch's name holds no tilde.
    expect(parseGitBranchKey("feature~0")).toBeNull();
    expect(parseGitBranchKey("feature~x")).toBeNull();
  });

  it("formats what it parses", () => {
    for (const key of ["main", "feature/a/b", "bob/infra:feature/a", "-:old", "fix/login~3"]) {
      expect(formatGitBranchKey(parseGitBranchKey(key)!)).toBe(key);
    }
  });

  it("keeps a key's slashes in the page's path", () => {
    expect(gitBranchPagePath("acme", "infra", "feature/a/b")).toBe(
      "/acme/infra/branches/feature/a/b",
    );
    expect(gitBranchPagePath("acme", "infra", "bob/infra:fix#1~2")).toBe(
      "/acme/infra/branches/bob/infra%3Afix%231~2",
    );
  });
});
