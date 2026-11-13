import { describe, expect, it } from "vitest";
import {
  ciBranchMatches,
  ciGrantNameFor,
  ciRepoAllowed,
  CI_GRANT_NAME,
  isCiConnectionName,
} from "../ci-access";

describe("ciBranchMatches", () => {
  it("matches every branch only without a pattern", () => {
    expect(ciBranchMatches(null, "feature/x")).toBe(true);
    expect(ciBranchMatches(undefined, "feature/x")).toBe(true);
  });
  it("matches no branch with a pattern of commas and spaces", () => {
    expect(ciBranchMatches(",", "main")).toBe(false);
    expect(ciBranchMatches(" , ", "main")).toBe(false);
    expect(ciBranchMatches("  ", "main")).toBe(false);
  });
  it("matches exact names and globs, with * stopping at a slash", () => {
    expect(ciBranchMatches("main", "main")).toBe(true);
    expect(ciBranchMatches("main", "main2")).toBe(false);
    expect(ciBranchMatches("release/*", "release/1.2")).toBe(true);
    expect(ciBranchMatches("release/*", "release/1/hotfix")).toBe(false);
    expect(ciBranchMatches("release/**", "release/1/hotfix")).toBe(true);
    expect(ciBranchMatches("main, release/*", "release/9")).toBe(true);
    expect(ciBranchMatches("v?", "v1")).toBe(true);
  });
  it("treats regex characters literally", () => {
    expect(ciBranchMatches("a.b", "aXb")).toBe(false);
    expect(ciBranchMatches("(x)", "(x)")).toBe(true);
  });
});

describe("ciRepoAllowed", () => {
  it("allows every repository when unset and compares without case", () => {
    expect(ciRepoAllowed(null, "acme/web")).toBe(true);
    expect(ciRepoAllowed(["Acme/Web"], "acme/web")).toBe(true);
    expect(ciRepoAllowed([], "acme/web")).toBe(false);
  });
});

describe("names", () => {
  it("derives a grant name the runner accepts", () => {
    expect(ciGrantNameFor("prod db (eu)")).toBe("prod-db-eu");
    expect(CI_GRANT_NAME.test(ciGrantNameFor("日本"))).toBe(true);
  });
  it("accepts connection names as the runner does", () => {
    expect(isCiConnectionName("Production cluster")).toBe(true);
    expect(isCiConnectionName(" padded")).toBe(false);
    expect(isCiConnectionName("a\nb")).toBe(false);
  });
});
