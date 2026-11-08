import { describe, expect, it } from "vitest";
import { identify, isId, ownerFromUrl, repoIdFromUrl } from "../identity";

// The cases from `ci-runner/crates/iwci/src/adapters/caches.rs`
// (`owners_come_from_the_repository_url`), so the two agree.
describe("identity", () => {
  it("derives owners as the runner does", () => {
    expect(ownerFromUrl("https://github.com/Infrawrench/Infrawrench")).toBe(
      "github.com-infrawrench",
    );
    expect(ownerFromUrl("https://github.com/acme/web.git")).toBe("github.com-acme");
    expect(ownerFromUrl("git@github.com:acme/web.git")).toBe("github.com-acme");
    expect(ownerFromUrl("https://x-access-token:t@github.com/acme/web")).toBe("github.com-acme");
    expect(ownerFromUrl("https://gitlab.example.com:8443/team/proj")).toBe(
      "gitlab.example.com-team",
    );
    expect(ownerFromUrl("file:///tmp/repo") ?? "").not.toContain("github");
  });

  it("derives repository ids and prefers explicit ones", () => {
    expect(repoIdFromUrl("https://github.com/acme/Web.git")).toBe("web");
    expect(repoIdFromUrl("git@github.com:acme/web.git/")).toBe("web");
    expect(identify({ repo: "https://github.com/acme/web" })).toEqual({
      owner: "github.com-acme",
      repoId: "web",
    });
    expect(identify({ repo: "https://github.com/acme/web", owner: "o", "repo-id": "r" })).toEqual({
      owner: "o",
      repoId: "r",
    });
    expect(identify({ repo: "/tmp/x" }).owner).toBe("local");
  });

  it("validates ids like RepoId::new", () => {
    expect(isId("github.com-acme")).toBe(true);
    expect(isId("a..b")).toBe(false);
    expect(isId("a/b")).toBe(false);
    expect(isId("")).toBe(false);
  });
});
