import { describe, expect, it } from "vitest";
import { SITE_TITLE, titleForPath } from "../title";

describe("titleForPath", () => {
  it.each([
    ["/", SITE_TITLE],
    ["/explore", `Explore · ${SITE_TITLE}`],
    ["/new", `New repository · ${SITE_TITLE}`],
    ["/settings/keys", `SSH keys · Settings · ${SITE_TITLE}`],
    ["/settings", `Settings · ${SITE_TITLE}`],
    ["/acme", `acme · ${SITE_TITLE}`],
    ["/acme/infra", `acme/infra · ${SITE_TITLE}`],
    ["/acme/infra/issues", `Issues · acme/infra · ${SITE_TITLE}`],
    ["/acme/infra/issues/12", `Issue #12 · acme/infra · ${SITE_TITLE}`],
    ["/acme/infra/issues/milestones", `Milestones · acme/infra · ${SITE_TITLE}`],
    ["/acme/infra/pulls/new", `New pull request · acme/infra · ${SITE_TITLE}`],
    ["/acme/infra/pulls/7/files", `Pull request #7 · acme/infra · ${SITE_TITLE}`],
    ["/acme/infra/commit/0123456789abcdef", `Commit 0123456 · acme/infra · ${SITE_TITLE}`],
    ["/acme/infra/ci/runs/r1", `CI run · acme/infra · ${SITE_TITLE}`],
    ["/acme/infra/infrastructure/prod/state", `prod · Infrastructure · acme/infra · ${SITE_TITLE}`],
    ["/acme/infra/settings/branches", `Branches · Settings · acme/infra · ${SITE_TITLE}`],
    ["/acme/infra/tree/main/src", `acme/infra · ${SITE_TITLE}`],
    ["/acme/my%20repo/blame/main/a.ts", `Blame · acme/my repo · ${SITE_TITLE}`],
  ])("%s", (path, title) => {
    expect(titleForPath(path)).toBe(title);
  });
});
