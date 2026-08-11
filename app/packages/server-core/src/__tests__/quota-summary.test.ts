import { describe, expect, it } from "vitest";
import type { QuotaRow } from "@infrawrench/client-core";
import {
  MAX_LISTED_QUOTAS,
  formatQuotaPushBody,
  formatQuotaSlackBody,
  formatQuotaTeamsBody,
  quotaContext,
  quotaRowLine,
  quotaTitle,
  summarizeQuotas,
} from "../quotas/summary";

function row(over: Partial<QuotaRow> = {}): QuotaRow {
  return {
    key: "ec2/L-1216C47A/eu-west-1",
    accountId: "acc-1",
    accountName: "prod-aws",
    pluginId: "aws",
    service: "ec2",
    name: "Running On-Demand Standard instances",
    region: "eu-west-1",
    limit: 1024,
    used: 912,
    utilization: 912 / 1024,
    unit: "vCPUs",
    adjustable: true,
    docsUrl: null,
    observedAt: "2026-08-11T00:00:00.000Z",
    severity: "critical",
    trend: { perDay: 0.02, daysToExhaustion: 6, points: 12 },
    ...over,
  };
}

describe("summarizeQuotas", () => {
  it("counts every alertable bucket, zeros included", () => {
    const summary = summarizeQuotas(
      [row({ severity: "exhausted" }), row({ key: "b", severity: "critical" })],
      0.8,
    );
    expect(summary.counts).toEqual({ exhausted: 1, critical: 1, trending: 0 });
    expect(summary.total).toBe(2);
  });

  it("caps the named rows and reports the remainder", () => {
    const rows = Array.from({ length: MAX_LISTED_QUOTAS + 5 }, (_, i) => row({ key: `q${i}` }));
    const summary = summarizeQuotas(rows, 0.8);
    expect(summary.rows).toHaveLength(MAX_LISTED_QUOTAS);
    expect(summary.omitted).toBe(5);
  });
});

describe("quotaTitle", () => {
  // "3 quotas over threshold" next to a fourth that is already refusing
  // requests buries the only line describing an outage in progress.
  it("leads with the exhausted count when there is one", () => {
    const summary = summarizeQuotas(
      [row({ severity: "exhausted" }), row({ key: "b", severity: "critical" })],
      0.8,
    );
    expect(quotaTitle(summary)).toBe("Quota radar: 1 quota at the limit, 1 approaching");
  });

  it("names the threshold when nothing is exhausted", () => {
    const summary = summarizeQuotas([row(), row({ key: "b" })], 0.8);
    expect(quotaTitle(summary)).toBe("Quota radar: 2 quotas past 80% utilisation");
  });
});

describe("quotaRowLine", () => {
  // A percentage alone does not say whether the fix is a support ticket or a
  // redeploy: 89% of 1,024 vCPUs has 112 left, 89% of 5 Elastic IPs has none.
  it("carries the absolute figures alongside the percentage", () => {
    expect(quotaRowLine(row())).toBe(
      "prod-aws · ec2 Running On-Demand Standard instances (eu-west-1) — " +
        "912 vCPUs of 1,024 vCPUs, 89%, full in 6 days",
    );
  });

  it("omits the region for an account-wide quota", () => {
    const line = quotaRowLine(
      row({ region: null, service: "account", name: "Droplets", unit: "droplets" }),
    );
    expect(line).not.toContain("(");
    expect(line).toContain("account Droplets");
  });

  it("omits the trend clause when there is no exhaustion date", () => {
    const line = quotaRowLine(row({ trend: { perDay: null, daysToExhaustion: null, points: 1 } }));
    expect(line).not.toContain("full in");
  });
});

describe("bodies", () => {
  const summary = summarizeQuotas(
    [row({ severity: "exhausted", utilization: 1.02, used: 1044 }), row({ key: "b" })],
    0.8,
  );

  it("bolds for Slack and does not for Teams", () => {
    expect(formatQuotaSlackBody(summary)).toContain("*2 quotas*");
    // The Teams Adaptive Card escaper turns `*` into a literal asterisk, so
    // Teams must never receive mrkdwn.
    expect(formatQuotaTeamsBody(summary)).not.toContain("*");
    expect(formatQuotaTeamsBody(summary)).toContain("2 quotas");
  });

  it("gives push the worst row plus the counts", () => {
    const body = formatQuotaPushBody(summary);
    expect(body).toContain("prod-aws");
    expect(body).toContain("1 at the limit");
    expect(body).toContain("1 over threshold");
  });

  it("omits empty buckets from the counts line", () => {
    expect(formatQuotaPushBody(summary)).not.toContain("trending to exhaustion");
  });

  it("names the threshold and the provenance in the context line", () => {
    expect(quotaContext(summary)).toBe("80% threshold · readings from your providers' quota APIs");
  });
});
