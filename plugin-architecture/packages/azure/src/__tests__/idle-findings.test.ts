import { describe, expect, it, vi } from "vitest";
import {
  pluginManifestSchema,
  type IdleScanRequest,
  type IdleScanResource,
} from "@infrawrench/plugin-base";
import {
  appGatewayMonthly,
  armResourceId,
  AZURE_IDLE_FINDINGS,
  azureMonitorReader,
  fetchAzureIdleFindings,
  loadBalancerMonthly,
  natGatewayMonthly,
  type MetricReader,
  type PriceReader,
} from "../idle-findings.js";
import { azureRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";
import type { RetailPriceItem } from "../pricing.js";

const DAYS = 14;
const days = (v: number, n = DAYS) => Array.from({ length: n }, () => v);
const SUB = "00000000-0000-0000-0000-000000000000";

function res(
  id: string,
  resourceTypeId: string,
  fields: IdleScanResource["fields"],
): IdleScanResource {
  return {
    id,
    resourceTypeId,
    externalId: `rg/${id}`,
    displayName: id,
    fields,
    resolvedOutputs: {},
  };
}

function request(resources: IdleScanResource[]): IdleScanRequest {
  const rules: IdleScanRequest["rules"] = {};
  for (const r of AZURE_IDLE_FINDINGS.rules) {
    rules[r.id] = { thresholds: Object.fromEntries(r.thresholds.map((t) => [t.key, t.default])) };
  }
  return { lookbackDays: DAYS, windowEnd: "2026-10-16T12:00:00Z", rules, resources };
}

function price(
  meterName: string,
  retailPrice: number,
  extra: Partial<RetailPriceItem> = {},
): RetailPriceItem {
  return {
    currencyCode: "USD",
    retailPrice,
    unitPrice: retailPrice,
    armRegionName: "Global",
    meterName,
    productName: "",
    skuName: "Standard",
    serviceName: "",
    serviceFamily: "Networking",
    unitOfMeasure: "1 Hour",
    type: "Consumption",
    armSkuName: "",
    ...extra,
  } as RetailPriceItem;
}

const prices: PriceReader = async (filter) => {
  if (filter.includes("Load Balancer"))
    return [
      price("Standard Included LB Rules and Outbound Rules", 0.025),
      price("Standard Overage LB Rules and Outbound Rules", 0.01, { unitOfMeasure: "1/Hour" }),
      price("Standard Data Processed", 0.005, { unitOfMeasure: "1 GB" }),
    ];
  if (filter.includes("NAT Gateway"))
    return [
      price("Standard Gateway", 0.045),
      price("Standard Data Processed", 0.045, { unitOfMeasure: "1 GB" }),
    ];
  if (filter.includes("Application Gateway Standard v2"))
    return [
      price("Standard Fixed Cost", 0.2, { unitOfMeasure: "1/Hour" }),
      price("Standard Capacity Units", 0.008, { unitOfMeasure: "1/Hour" }),
    ];
  return [];
};

function run(resources: IdleScanResource[], answer: (metric: string) => number[]) {
  const calls: Array<{ id: string; metric: string; aggregation: string }> = [];
  const read: MetricReader = async (id, metric, aggregation) => {
    calls.push({ id, metric, aggregation });
    return answer(metric);
  };
  return {
    calls,
    findings: fetchAzureIdleFindings(request(resources), { subscriptionId: SUB, read, prices }),
  };
}

const lb = res("web-lb", "azure-load-balancer", {
  name: "web-lb",
  resourceGroup: "rg",
  sku: "Standard",
  ruleCount: 7,
});
const nat = res("egress", "azure-nat-gateway", {
  name: "egress",
  resourceGroup: "rg",
  sku: "Standard",
  subnetCount: 1,
});
const agw = res("front", "azure-app-gateway", {
  name: "front",
  resourceGroup: "rg",
  location: "eastus",
  tier: "Standard_v2",
  operationalState: "Running",
});

describe("declaration", () => {
  it("is on the manifest, validates, and names declared types", () => {
    expect(plugin.manifest.idleFindings).toBe(AZURE_IDLE_FINDINGS);
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
    const types = new Set(plugin.resourceTypes.map((t) => t.id));
    for (const rule of AZURE_IDLE_FINDINGS.rules)
      for (const id of rule.resourceTypeIds) expect(types.has(id)).toBe(true);
  });

  it("builds the ARM id from resource group and name", () => {
    expect(armResourceId(SUB, "Microsoft.Network/loadBalancers", lb)).toBe(
      `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.Network/loadBalancers/web-lb`,
    );
  });
});

describe("load balancer", () => {
  it("flags a Standard balancer with rules and no bytes, priced with rule overage", async () => {
    const { findings, calls } = run([lb], (m) => (m === "VipAvailability" ? days(100) : days(0)));
    const [f] = await findings;
    // (0.025 + 2 × 0.01) × 730
    expect(f!.estimate?.monthlyAmount).toBe(32.85);
    expect(calls.map((c) => `${c.metric}:${c.aggregation}`).sort()).toEqual([
      "ByteCount:Total",
      "VipAvailability:Average",
    ]);
  });

  it("skips Basic balancers, ones with no rules (no charge), busy ones and unproven reads", async () => {
    const basic = res("b", "azure-load-balancer", { ...lb.fields, sku: "Basic" });
    const noRules = res("n", "azure-load-balancer", { ...lb.fields, ruleCount: 0 });
    expect(await run([basic, noRules], () => days(0)).findings).toEqual([]);
    expect(
      await run([lb], (m) => (m === "VipAvailability" ? days(100) : days(5e7))).findings,
    ).toEqual([]);
    expect(await run([lb], () => []).findings).toEqual([]);
  });
});

describe("NAT gateway", () => {
  it("flags a gateway attached to no subnet without reading metrics", async () => {
    const detached = res("d", "azure-nat-gateway", { ...nat.fields, subnetCount: 0 });
    const { findings, calls } = run([detached], () => days(0));
    const [f] = await findings;
    expect(f!.reason).toMatch(/^Attached to no subnet/);
    expect(f!.estimate?.monthlyAmount).toBe(32.85);
    expect(calls).toEqual([]);
  });

  it("flags an attached gateway with no traffic, not a busy one", async () => {
    expect(
      await run([nat], (m) => (m === "DatapathAvailability" ? days(100) : days(0))).findings,
    ).toHaveLength(1);
    expect(
      await run([nat], (m) => (m === "DatapathAvailability" ? days(100) : days(9e6))).findings,
    ).toEqual([]);
  });
});

describe("application gateway", () => {
  it("flags a running v2 gateway with no requests at its tier's fixed cost", async () => {
    const [f] = await run([agw], (m) =>
      m === "CapacityUnits" ? days(1) : m === "HealthyHostCount" ? days(2) : days(0),
    ).findings;
    expect(f!.estimate?.monthlyAmount).toBe(146);
  });

  it("flags a busy gateway with no healthy backend and skips a stopped one", async () => {
    const [f] = await run([agw], (m) =>
      m === "CapacityUnits" ? days(1) : m === "HealthyHostCount" ? days(0) : days(5000),
    ).findings;
    expect(f!.reason).toMatch(/^No healthy backend/);
    const stopped = res("s", "azure-app-gateway", { ...agw.fields, operationalState: "Stopped" });
    expect(await run([stopped], () => days(0)).findings).toEqual([]);
  });
});

describe("pricing helpers", () => {
  it("return null when the meter is missing rather than guessing", async () => {
    expect(await loadBalancerMonthly(3, async () => [])).toBeNull();
    expect(
      await natGatewayMonthly("StandardV2", async () => [price("Standard Gateway", 0.045)]),
    ).toBeNull();
    expect(await appGatewayMonthly("Standard", "eastus", prices)).toBeNull();
  });
});

describe("azureMonitorReader", () => {
  it("reads one-day totals, oldest first, and counts only days with a value", async () => {
    const get = vi.fn(async (_url: string) => ({
      value: [
        {
          timeseries: [
            {
              data: [
                { timeStamp: "2026-10-03T00:00:00Z", total: 5 },
                { timeStamp: "2026-10-02T00:00:00Z", total: 1 },
                { timeStamp: "2026-10-04T00:00:00Z" },
              ],
            },
          ],
        },
      ],
    }));
    const read = azureMonitorReader(get as never);
    const out = await read(`/subscriptions/${SUB}/x`, "ByteCount", "Total", {
      start: new Date("2026-10-02T00:00:00Z"),
      end: new Date("2026-10-16T00:00:00Z"),
    });
    expect(out).toEqual([1, 5]);
    const url = get.mock.calls[0]![0];
    expect(url).toContain("/providers/Microsoft.Insights/metrics?api-version=2018-01-01");
    expect(url).toContain("metricnames=ByteCount");
    expect(url).toContain("interval=P1D&aggregation=Total");
  });

  it("turns an authorization failure into an access error", async () => {
    const read = azureMonitorReader((async () => {
      throw new Error("Azure 403 AuthorizationFailed");
    }) as never);
    await expect(
      read("/x", "ByteCount", "Total", { start: new Date(), end: new Date() }),
    ).rejects.toMatchObject({
      name: "IdleFindingAccessError",
    });
  });
});

describe("remediation", () => {
  const cmds = (idleRuleId: string, resource: IdleScanResource) =>
    azureRemediationCommands({
      kind: "orphan",
      reason: "idle",
      idleRuleId,
      resource: {
        resourceTypeId: resource.resourceTypeId,
        displayName: resource.displayName,
        externalId: resource.externalId,
        fields: resource.fields,
      },
    }).map((c) => c.command);

  it("deletes or stops the idle resource in its resource group", () => {
    expect(cmds("load-balancer", lb)).toEqual([
      'az network lb delete --resource-group rg --name web-lb --subscription "$AZURE_SUBSCRIPTION_ID"',
    ]);
    expect(cmds("nat-gateway", nat)[0]).toContain(
      "az network nat gateway delete --resource-group rg --name egress",
    );
    expect(cmds("app-gateway", agw)).toEqual([
      'az network application-gateway stop --resource-group rg --name front --subscription "$AZURE_SUBSCRIPTION_ID"',
      'az network application-gateway delete --resource-group rg --name front --subscription "$AZURE_SUBSCRIPTION_ID"',
    ]);
  });
});
