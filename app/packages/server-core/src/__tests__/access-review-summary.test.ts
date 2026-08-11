import { describe, expect, it } from "vitest";
import type { AccessFinding, AccessPrincipal } from "@infrawrench/client-core";
import {
  MAX_LISTED_ACCESS_FINDINGS,
  accessFindingLine,
  formatAccessReviewPushBody,
  formatAccessReviewSlackBody,
  formatAccessReviewTeamsBody,
  joinSecurityBody,
  securityAlertTitle,
  summarizeAccessReview,
} from "../access-review/summary";
import { summarizePosture } from "../posture/summary";

function principal(overrides: Partial<AccessPrincipal> = {}): AccessPrincipal {
  return {
    resourceId: "res-1",
    pluginId: "workos",
    pluginName: "WorkOS",
    resourceTypeId: "role",
    resourceTypeName: "Role",
    accountId: "acct-1",
    accountName: "Production",
    displayName: "superuser",
    externalId: "role_1",
    role: "role",
    lastUsedAt: null,
    daysSinceLastUsed: null,
    activity: "unknown",
    createdAt: null,
    ageDays: null,
    admin: true,
    mfa: null,
    parent: null,
    owner: null,
    revokeActionId: null,
    ...overrides,
  };
}

function finding(
  severity: AccessFinding["severity"],
  displayName: string,
  title = "Administrative or wildcard permissions",
): AccessFinding {
  return {
    resourceId: `res-${displayName}`,
    ruleId: "access-review:admin-principal",
    title,
    severity,
    reason: "because",
    principal: principal({ displayName, resourceId: `res-${displayName}` }),
  };
}

describe("summarizeAccessReview", () => {
  it("counts the alertable severities and caps the named findings", () => {
    const findings = Array.from({ length: MAX_LISTED_ACCESS_FINDINGS + 3 }, (_, i) =>
      finding(i === 0 ? "critical" : "high", `p${i}`),
    );
    const summary = summarizeAccessReview(findings);
    expect(summary.total).toBe(MAX_LISTED_ACCESS_FINDINGS + 3);
    expect(summary.counts).toEqual({ critical: 1, high: MAX_LISTED_ACCESS_FINDINGS + 2 });
    expect(summary.findings).toHaveLength(MAX_LISTED_ACCESS_FINDINGS);
    expect(summary.omitted).toBe(3);
  });

  it("is empty and harmless for an empty feed", () => {
    const summary = summarizeAccessReview([]);
    expect(summary).toEqual({
      total: 0,
      counts: { critical: 0, high: 0 },
      findings: [],
      omitted: 0,
    });
  });
});

describe("accessFindingLine", () => {
  // A principal called `deploy` exists in most accounts, so the account has to
  // be in the line or the reader cannot tell which one is flagged.
  it("names the account alongside the principal", () => {
    expect(accessFindingLine(finding("high", "deploy"))).toBe(
      "deploy (Production) — Administrative or wildcard permissions (high)",
    );
  });
});

describe("securityAlertTitle", () => {
  const noPosture = summarizePosture([]);

  it("returns null when the access review found nothing to say", () => {
    expect(securityAlertTitle(noPosture, summarizeAccessReview([]))).toBeNull();
  });

  // The whole reason this helper exists: `postureTitle` on an empty posture
  // feed reads "0 high-severity findings", which is exactly wrong for a
  // window whose findings were all access findings.
  it("headlines the access review when only it found something", () => {
    expect(securityAlertTitle(noPosture, summarizeAccessReview([finding("high", "a")]))).toBe(
      "Access review: 1 high-severity finding",
    );
    expect(
      securityAlertTitle(
        noPosture,
        summarizeAccessReview([finding("critical", "a"), finding("high", "b")]),
      ),
    ).toBe("Access review: 1 critical finding, 1 high");
  });

  it("combines both halves when both found something", () => {
    const posture = summarizePosture([
      {
        resourceId: "r",
        pluginId: "aws",
        pluginName: "AWS",
        resourceTypeId: "s3-bucket",
        resourceTypeName: "S3 Bucket",
        accountId: "a",
        accountName: "Prod",
        displayName: "assets",
        externalId: null,
        ruleId: "public",
        title: "Public bucket",
        severity: "critical",
        category: "public-exposure",
        reason: "…",
      },
    ]);
    expect(securityAlertTitle(posture, summarizeAccessReview([finding("high", "a")]))).toBe(
      "Security findings: 1 posture finding, 1 access finding",
    );
  });
});

describe("bodies", () => {
  const summary = summarizeAccessReview([finding("critical", "root"), finding("high", "deploy")]);

  it("bolds only in the Slack body", () => {
    expect(formatAccessReviewSlackBody(summary)).toContain("*2 access findings*");
    expect(formatAccessReviewTeamsBody(summary)).toContain("2 access findings");
    expect(formatAccessReviewTeamsBody(summary)).not.toContain("*");
  });

  it("leads the push body with the single worst finding", () => {
    expect(formatAccessReviewPushBody(summary)).toBe(
      "root (Production) — Administrative or wildcard permissions (critical). 1 critical · 1 high",
    );
  });

  it("drops an empty half rather than leaving a blank paragraph", () => {
    expect(joinSecurityBody(["posture block", ""])).toBe("posture block");
    expect(joinSecurityBody(["", "access block"])).toBe("access block");
    expect(joinSecurityBody(["a", "b"])).toBe("a\n\nb");
  });
});
