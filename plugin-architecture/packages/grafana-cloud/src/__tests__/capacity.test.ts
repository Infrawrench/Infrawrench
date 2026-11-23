import { capacityDeclarations, resolveCapacityLimit } from "@infrawrench/plugin-base";
import { beforeEach, describe, expect, it } from "vitest";
import { resetCachesForTests } from "../account.js";
import { fetchBillSummary } from "../cost-data.js";
import { mapOrganization } from "../mappers.js";
import { OrganizationResourceType } from "../resource-types.js";
import { ctxWith, makeHttp } from "./helpers.js";

beforeEach(() => resetCachesForTests());

// The billed usage example from the Cloud API reference, trimmed to the fields read.
const BILLED = {
  items: [
    {
      dimensionId: "hl",
      dimensionName: "Logs",
      unit: "GB",
      includedUsage: 50,
      totalUsage: 12.5,
      amountDue: 0,
      periodStart: "2026-11-01T00:00:00Z",
      periodEnd: "2026-11-30T23:59:59Z",
    },
    {
      dimensionId: "hm",
      dimensionName: "Metrics",
      unit: "series",
      includedUsage: 10000,
      totalUsage: 7200,
      amountDue: 0,
      periodStart: "2026-11-01T00:00:00Z",
      periodEnd: "2026-11-30T23:59:59Z",
    },
    {
      dimensionId: "hg",
      dimensionName: "Grafana Users",
      unit: "user",
      includedUsage: 3,
      totalUsage: 2,
      amountDue: 0,
    },
  ],
};

describe("included usage on the organization", () => {
  it("stores each tracked dimension's usage beside its included amount", async () => {
    const { http } = makeHttp((url) => {
      if (url.pathname === "/api/orgs/acme") return { body: { id: 1, slug: "acme" } };
      if (url.pathname === "/api/orgs/acme/instances") return { body: { items: [] } };
      if (url.pathname === "/api/orgs/acme/billed-usage") return { body: BILLED };
      return { status: 404 };
    });
    const bill = await fetchBillSummary(ctxWith(http), "acme", new Date("2026-11-10T00:00:00Z"));
    const org = mapOrganization("acct", { id: 1, slug: "acme" } as never, { bill });
    expect(org.fields).toMatchObject({
      metricsSeries: 7200,
      metricsSeriesIncluded: 10000,
      logsIngestedGb: 12.5,
      logsIncludedGb: 50,
      grafanaUsers: 2,
      grafanaUsersIncluded: 3,
      billingPeriodStart: "2026-11-01T00:00:00Z",
      billingPeriodEnd: "2026-11-30T23:59:59Z",
    });
    const decls = capacityDeclarations(OrganizationResourceType);
    expect(decls.map((d) => d.key)).toEqual(["metricsSeries", "logsIngestedGb", "grafanaUsers"]);
    for (const d of decls) {
      expect(d.declaration.cycle?.startField).toBe("billingPeriodStart");
      expect(resolveCapacityLimit(d.declaration.limit, org.fields)).not.toBeNull();
    }
  });

  it("leaves the usage fields out without a bill", () => {
    const org = mapOrganization("acct", { id: 1, slug: "acme" } as never);
    expect(org.fields).not.toHaveProperty("metricsSeries");
    expect(org.fields).not.toHaveProperty("logsIncludedGb");
    expect(org.fields).not.toHaveProperty("billingPeriodStart");
  });
});
