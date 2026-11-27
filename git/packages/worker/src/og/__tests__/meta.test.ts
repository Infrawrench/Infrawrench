import { describe, expect, it } from "vitest";
import { firstLine } from "../facts";
import { SITE_CARD, cardOf, cardVersion, genericMeta, pageMeta } from "../meta";
import { pageOf } from "../pages";
import { FIXTURES } from "./fixtures";

const ORIGIN = "https://git.infrawrench.com";
const IMAGE = /^https:\/\/git\.infrawrench\.com\/-\/og\/[0-9a-f]{16}(\/.*)?$/;

const meta = (path: string, fixture: string | null) =>
  pageMeta(pageOf(path), fixture === null ? null : FIXTURES[fixture]!, ORIGIN);

describe("pageMeta", () => {
  it("gives every page without facts the site's tags, whatever its path", async () => {
    const site = await genericMeta(ORIGIN);
    expect(site).toMatchObject({
      title: "Infrawrench Git",
      url: `${ORIGIN}/`,
      canonical: `${ORIGIN}/`,
      image: { width: 1200, height: 630, alt: "Infrawrench Git" },
    });
    expect(site.image.url).toBe(`${ORIGIN}/-/og/${await cardVersion(SITE_CARD)}`);
    // A private repository, a missing one, a signed-in page, a private issue: one answer.
    for (const path of [
      "/",
      "/acme/secret",
      "/acme/nothing",
      "/settings",
      "/acme/secret/issues/4",
    ]) {
      expect(await meta(path, null), path).toEqual(site);
    }
  });

  it("names explore", async () => {
    expect(await meta("/explore", null)).toMatchObject({
      title: "Explore · Infrawrench Git",
      url: `${ORIGIN}/explore`,
    });
  });

  it("describes a repository by its own words and numbers", async () => {
    const tags = await meta("/acme/platform-infra", "repository");
    expect(tags.title).toBe("acme/platform-infra · Infrawrench Git");
    expect(tags.description).toBe(
      "Terraform for the platform team: networking, the Kubernetes clusters, and the staging and production databases. HCL · 1,284 stars · 87 forks · 23 open issues.",
    );
    expect(tags.canonical).toBe(`${ORIGIN}/acme/platform-infra`);
    expect(tags.image.url).toMatch(IMAGE);
    expect(tags.image.url).toMatch(/\/acme\/platform-infra$/);
  });

  it("names a repository's tab and a file, and shows the repository's card", async () => {
    const repo = await meta("/acme/platform-infra", "repository");
    const issues = await meta("/acme/platform-infra/issues", "repository");
    expect(issues.title).toBe("Issues · acme/platform-infra · Infrawrench Git");
    expect(issues.canonical).toBe(`${ORIGIN}/acme/platform-infra/issues`);
    expect(issues.image).toEqual(repo.image);
    const file = await meta("/acme/platform-infra/blob/main/modules/vpc/main.tf", "repository");
    expect(file.title).toBe("modules/vpc/main.tf · acme/platform-infra · Infrawrench Git");
    expect(file.image).toEqual(repo.image);
  });

  it("describes a commit, an issue and a branch page", async () => {
    const commit = await meta(
      "/acme/platform-infra/commit/3f9c2a71be04d8a5c6e1f20b9d7a4c3e5f6a7b8c",
      "commit",
    );
    expect(commit.title).toMatch(/^Move the staging database .* · acme\/platform-infra@3f9c2a7 · /);
    expect(commit.description).toBe(
      "Alice Example committed 3f9c2a7 on 2026-11-20. 7 files changed, 184 additions, 39 deletions.",
    );

    const issue = await meta("/acme/platform-infra/issues/412", "issue");
    expect(issue.title).toBe(
      "Staging budget alarm fires at 80 percent although spend is flat · Issue #412 · acme/platform-infra · Infrawrench Git",
    );
    expect(issue.description).toBe("Open · Opened by Bob Builder · 14 comments");
    expect(issue.image.url).toMatch(/\/acme\/platform-infra\/issues\/412$/);

    const branch = await meta("/acme/platform-infra/pulls/9", "branch");
    expect(branch.canonical).toBe(`${ORIGIN}/acme/platform-infra/branches/claude/budget-alarm`);
    expect(branch.description).toBe(
      "The staging budget alarm keeps paging at 80 percent when nothing changed. Make it useful. Open · claude/budget-alarm into main · 3 versions · Open findings: 1 must fix, 2 should fix, 4 notes · Agent: Claude Code",
    );
    expect(branch.image.url).toMatch(/\/acme\/platform-infra\/branches\/claude\/budget-alarm$/);
  });

  it("describes a namespace and a bot", async () => {
    expect(await meta("/acme", "namespace")).toMatchObject({
      title: "Acme Corporation (acme) · Infrawrench Git",
      description:
        "Infrastructure, tooling and the services behind acme.example. · 42 public repositories",
      type: "profile",
    });
    expect((await meta("/claude", "bot")).title).toBe("Claude (bot) · Infrawrench Git");
  });

  it("moves an image's version with what it draws, and only then", async () => {
    const base = FIXTURES["issue"]!;
    if (base.kind !== "issue") throw new Error("fixture");
    const same = await cardVersion(cardOf({ ...base }).card);
    const more = await cardVersion(cardOf({ ...base, comments: base.comments + 1 }).card);
    expect(same).toBe(await cardVersion(cardOf(base).card));
    expect(more).not.toBe(same);
  });

  it("writes no em dash", async () => {
    for (const [name, facts] of Object.entries(FIXTURES)) {
      const tags = await pageMeta({ kind: "home" }, facts, ORIGIN);
      expect(JSON.stringify(tags), name).not.toContain("\u2014");
    }
  });
});

describe("firstLine", () => {
  it("takes the first line that says something, without its Markdown", () => {
    expect(firstLine("## Ask\n\nMake the **alarm** useful.")).toBe("Ask");
    expect(firstLine("\n\n- [ ] [Fix](https://x) the `alarm`\n")).toBe("Fix the alarm");
    expect(firstLine("```\ncode\n```\nAfter the fence")).toBe("After the fence");
    expect(firstLine("my_snake_case stays")).toBe("my_snake_case stays");
    expect(firstLine("  \n")).toBeNull();
    expect(firstLine("x".repeat(300))!.length).toBe(200);
  });
});
