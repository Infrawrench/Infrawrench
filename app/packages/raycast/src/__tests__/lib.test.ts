import { describe, expect, it, vi } from "vitest";
import type { CloudFetch, Incident, SearchResult } from "@infrawrench/client-core";
import type { Client } from "../lib/client";
import { formatSpend, sortIncidents } from "../lib/format";
import { loadResourceInsight } from "../lib/insight";

function incident(over: Partial<Incident>): Incident {
  return {
    id: "i",
    title: "t",
    severity: "sev3",
    status: "open",
    summary: null,
    startedAt: "2026-10-01T00:00:00Z",
    mitigatedAt: null,
    resolvedAt: null,
    declaredByUserId: null,
    declaredByName: null,
    resolvedByUserId: null,
    affectedResourceIds: [],
    affectedAccountIds: [],
    issueUrl: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    artifacts: [],
    noteCount: 0,
    ...over,
  };
}

describe("sortIncidents", () => {
  it("puts open before mitigated, then worst severity, then newest", () => {
    const list = [
      incident({ id: "mit-sev1", status: "mitigated", severity: "sev1" }),
      incident({ id: "open-sev3-old", severity: "sev3", startedAt: "2026-09-01T00:00:00Z" }),
      incident({ id: "open-sev3-new", severity: "sev3", startedAt: "2026-10-05T00:00:00Z" }),
      incident({ id: "open-sev2", severity: "sev2" }),
    ];
    expect(sortIncidents(list).map((i) => i.id)).toEqual([
      "open-sev2",
      "open-sev3-new",
      "open-sev3-old",
      "mit-sev1",
    ]);
  });
});

describe("formatSpend", () => {
  it("never renders missing data as zero", () => {
    expect(formatSpend([])).toBe("No cost data");
    expect(formatSpend([{ amount: 12.345, currency: "USD" }])).toBe("$12.35");
  });
});

describe("loadResourceInsight", () => {
  const result: SearchResult = {
    id: "r1",
    pluginId: "aws",
    pluginDisplayName: "AWS",
    pluginLogoSvg: "",
    resourceTypeId: "ec2-instance",
    resourceTypeLabel: "EC2 Instance",
    accountId: "acc",
    accountName: "prod",
    displayName: "web-1",
  };

  it("loads each part independently and reports the ones it cannot read", async () => {
    const org = vi.fn(async (_org: string, path: string) => {
      if (path.startsWith("/accounts/acc/resources")) {
        return [{ id: "r1", externalId: "i-1", fieldsJson: { state: "running" } }];
      }
      if (path === "/costs/query") throw new Error("403 costs:read");
      if (path.startsWith("/iac/resource")) {
        return { status: "drifted", stateId: "s", stateLabel: "prod", terraformAddress: "aws_instance.web", driftFieldCount: 2 };
      }
      if (path.startsWith("/services/for-resources")) {
        return { services: { r1: [{ id: "s1", name: "Checkout", slug: "checkout", tier: 1 }] } };
      }
      if (path === "/posture") {
        return { findings: [{ resourceId: "r1", severity: "high", title: "Open SSH", ruleId: "x" }] };
      }
      if (path === "/incidents") {
        return {
          incidents: [
            incident({ id: "a", affectedResourceIds: ["r1"] }),
            incident({ id: "b", affectedResourceIds: ["r1"], status: "resolved" }),
            incident({ id: "c", affectedResourceIds: ["other"] }),
          ],
        };
      }
      throw new Error(`unexpected ${path}`);
    });
    const client: Client = {
      api: { org } as unknown as CloudFetch,
      orgId: "o",
      cloudUrl: "https://x.test",
      openIn: "web",
    };
    const insight = await loadResourceInsight(client, result);
    expect(insight.status).toBe("running");
    expect(insight.spend.ok).toBe(false);
    expect(insight.iac).toMatchObject({ ok: true, value: { status: "drifted" } });
    expect(insight.services).toMatchObject({ ok: true, value: [{ name: "Checkout" }] });
    expect(insight.findings.ok && insight.findings.value).toHaveLength(1);
    expect(insight.incidents.ok && insight.incidents.value.map((i) => i.id)).toEqual(["a"]);
  });
});
