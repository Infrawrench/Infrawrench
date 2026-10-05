import { describe, expect, it } from "vitest";
import {
  defaultGithubIssueSettings,
  indexGithubLinks,
  resolveGithubIssueRoute,
  validateGithubIssueSettings,
  type GithubIssueLink,
  type GithubIssueSettingsInput,
} from "../github-issues";

const repoA = { installationId: 1, fullName: "acme/infra" };
const repoB = { installationId: 1, fullName: "acme/payments" };
const repoC = { installationId: 2, fullName: "acme/data" };

const settings = {
  defaultRepo: repoA,
  labels: ["infrawrench"],
  assignees: ["oncall"],
  routes: [
    {
      id: "r1",
      match: { kind: "cost_centre" as const, costCentreId: "cc-pay" },
      repo: repoB,
      labels: ["payments"],
      assignees: [],
    },
    {
      id: "r2",
      match: { kind: "tag" as const, tagKey: "team", tagValue: null },
      repo: repoC,
      labels: [],
      assignees: ["data-lead"],
    },
  ],
};

describe("resolveGithubIssueRoute", () => {
  it("falls back to the default repository", () => {
    expect(resolveGithubIssueRoute(settings, {})).toEqual({
      repo: repoA,
      labels: ["infrawrench"],
      assignees: ["oncall"],
      routeId: null,
    });
  });

  it("first match wins, labels add and assignees replace only when set", () => {
    const r = resolveGithubIssueRoute(settings, {
      costCentreId: "cc-pay",
      tags: { team: "data" },
    });
    expect(r.routeId).toBe("r1");
    expect(r.repo).toEqual(repoB);
    expect(r.labels).toEqual(["infrawrench", "payments"]);
    expect(r.assignees).toEqual(["oncall"]);
  });

  it("a null tag value matches any value of the key", () => {
    const r = resolveGithubIssueRoute(settings, { tags: { team: "anything" } });
    expect(r.routeId).toBe("r2");
    expect(r.assignees).toEqual(["data-lead"]);
  });

  it("absent facts never match", () => {
    expect(
      resolveGithubIssueRoute(settings, { costCentreId: null, tags: null }).routeId,
    ).toBeNull();
  });
});

describe("indexGithubLinks", () => {
  const link = (id: string, state: "open" | "closed"): GithubIssueLink => ({
    id,
    sourceKind: "orphan",
    sourceId: "res-1",
    fingerprint: "fp",
    repo: "acme/infra",
    installationId: 1,
    issueNumber: Number(id),
    issueUrl: `https://github.com/acme/infra/issues/${id}`,
    state,
    autoFiled: false,
    pullRequestNumber: null,
    pullRequestUrl: null,
    createdByUserId: null,
    createdAt: "2026-10-01T00:00:00Z",
    resolvedAt: null,
  });

  it("prefers an open link over a newer closed one", () => {
    const index = indexGithubLinks([link("2", "closed"), link("1", "open")]);
    expect(index.get("orphan:res-1")?.id).toBe("1");
  });
});

describe("validateGithubIssueSettings", () => {
  const base = (): GithubIssueSettingsInput => {
    const { updatedAt: _u, ...rest } = defaultGithubIssueSettings();
    return rest;
  };

  it("accepts the defaults", () => {
    expect(validateGithubIssueSettings(base())).toBeNull();
  });

  it("refuses enabling without a default repository", () => {
    expect(validateGithubIssueSettings({ ...base(), enabled: true })).toMatch(/default repository/);
  });

  it("refuses two sources for one IaC scope, and parent-directory escapes", () => {
    const source = { iacAccountId: null, repo: repoA, baseBranch: null, directory: "infra" };
    expect(validateGithubIssueSettings({ ...base(), iacSources: [source, { ...source }] })).toMatch(
      /one repository/,
    );
    expect(
      validateGithubIssueSettings({ ...base(), iacSources: [{ ...source, directory: "../x" }] }),
    ).toMatch(/\.\./);
  });
});
