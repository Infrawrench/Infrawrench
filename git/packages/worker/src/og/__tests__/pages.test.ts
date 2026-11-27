import { describe, expect, it } from "vitest";
import { cardPagePath, pageOf } from "../pages";

describe("pageOf", () => {
  it("reads the site's own pages", () => {
    expect(pageOf("/")).toEqual({ kind: "home" });
    expect(pageOf("/explore")).toEqual({ kind: "explore" });
  });

  it("gives a signed-in person's pages the site's tags", () => {
    for (const path of [
      "/changes",
      "/reviews",
      "/mentions",
      "/new",
      "/onboarding/username",
      "/settings",
      "/settings/tokens",
      "/acme/infra/settings",
      "/acme/infra/settings/collaborators",
      "/acme/infra/start",
      "/acme/infra/issues/new",
      "/acme/infra/pulls/new",
      "/acme/infra/pulls/start",
    ]) {
      expect(pageOf(path), path).toEqual({ kind: "generic" });
    }
  });

  it("reads namespaces, bots included", () => {
    expect(pageOf("/acme")).toEqual({ kind: "namespace", owner: "acme" });
    expect(pageOf("/claude")).toEqual({ kind: "namespace", owner: "claude" });
  });

  it("reads a repository and its tabs", () => {
    const at = { owner: "acme", repo: "infra" };
    expect(pageOf("/acme/infra")).toEqual({ kind: "repository", ...at, section: null, path: null });
    expect(pageOf("/acme/infra/issues")).toMatchObject({ section: "issues" });
    expect(pageOf("/acme/infra/issues/labels")).toMatchObject({ section: "labels" });
    expect(pageOf("/acme/infra/issues/milestones/2")).toMatchObject({ section: "milestones" });
    expect(pageOf("/acme/infra/ci/runs/abc")).toMatchObject({ section: "ci" });
    expect(pageOf("/acme/infra/tags")).toMatchObject({ section: "tags" });
    expect(pageOf("/acme/infra/tree/main/src/a%20b")).toEqual({
      kind: "repository",
      ...at,
      section: "tree",
      path: "main/src/a b",
    });
  });

  it("reads the pages about one thing", () => {
    const at = { owner: "acme", repo: "infra" };
    expect(pageOf("/acme/infra/commit/ABCDEF1")).toEqual({ kind: "commit", ...at, sha: "abcdef1" });
    expect(pageOf("/acme/infra/issues/12")).toEqual({ kind: "issue", ...at, number: 12 });
    expect(pageOf("/acme/infra/branches/feature/a")).toEqual({
      kind: "branch",
      ...at,
      key: "feature/a",
    });
    expect(pageOf("/acme/infra/branches/bob/infra:feature/a~2")).toEqual({
      kind: "branch",
      ...at,
      key: "bob/infra:feature/a~2",
    });
    expect(pageOf("/acme/infra/pulls/7")).toEqual({ kind: "branch-number", ...at, number: 7 });
    expect(pageOf("/acme/infra/pulls/7/files")).toEqual({
      kind: "branch-number",
      ...at,
      number: 7,
    });
  });

  it("does not guess at what is no page", () => {
    expect(pageOf("/acme/infra/commit/not-a-sha")).toEqual({ kind: "generic" });
    expect(pageOf("/acme/infra/issues/0")).toEqual({ kind: "generic" });
    expect(pageOf("/acme/infra/nonsense")).toEqual({ kind: "generic" });
    expect(pageOf("/acme/%E0%A4%A")).toEqual({ kind: "generic" });
  });

  it("puts each card page back at a path that reads as the same page", () => {
    for (const path of [
      "/",
      "/acme",
      "/acme/infra",
      "/acme/infra/commit/abcdef1",
      "/acme/infra/issues/12",
      "/acme/infra/branches/feature/a",
      "/acme/infra/branches/bob/infra:feature/a~2",
    ]) {
      const page = pageOf(path);
      if (page.kind === "generic" || page.kind === "explore" || page.kind === "branch-number") {
        throw new Error(path);
      }
      expect(pageOf(cardPagePath(page)), path).toEqual(page);
    }
  });
});
