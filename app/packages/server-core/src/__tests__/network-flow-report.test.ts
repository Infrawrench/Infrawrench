/**
 * Running a saved network flow report: which rows it reads (re-cut plugins
 * out unless their account is named), how sampled plugins are passed down and
 * labelled, the notices, and the labels only the server can give.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({
  cells: vi.fn(),
  groups: vi.fn(),
  talkers: vi.fn(),
  dims: vi.fn(),
}));
const state = vi.hoisted(() => ({
  accounts: [] as Array<{ id: string; displayName: string; pluginId: string }>,
  enabled: true,
}));

vi.mock("../clickhouse/network-flow-report-readers", () => ({
  readNetworkFlowReportCells: reads.cells,
  readNetworkFlowReportGroups: reads.groups,
  readNetworkFlowReportTalkers: reads.talkers,
  readNetworkFlowReportDimensionValues: reads.dims,
}));
vi.mock("../db/client", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => state.accounts }) }),
  },
}));
vi.mock("../network-flow/settings", () => ({
  getNetworkFlowSettings: async () => ({ enabled: state.enabled, initialLookbackDays: 3 }),
}));
vi.mock("../plugin-loader", () => ({
  loadPlugins: async () => [
    { plugin: { manifest: { id: "aws", networkFlows: { rates: {}, maxPairsPerDay: 500 } } } },
    {
      plugin: {
        manifest: {
          id: "kubernetes",
          networkFlows: { rates: {}, maxPairsPerDay: 500, recut: true },
        },
      },
    },
    {
      plugin: {
        manifest: { id: "gcp", networkFlows: { rates: {}, maxPairsPerDay: 500, sampled: true } },
      },
    },
    { plugin: { manifest: { id: "azure" } } },
  ],
}));

const { runNetworkFlowReportConfig, getNetworkFlowReportOptions, NetworkFlowReportError } =
  await import("../network-flow/report");

const ORG = "org-1";
const TODAY = new Date("2026-09-30T12:00:00Z");

const figures = {
  bytes: 0,
  estimated_cost: 0,
  sampled_bytes: 0,
  sampled_cost: 0,
  unattributed_bytes: 0,
  truncated_bytes: 0,
};

beforeEach(() => {
  reads.cells.mockReset().mockResolvedValue([]);
  reads.groups.mockReset().mockResolvedValue({ rows: [], count: 0 });
  reads.talkers.mockReset().mockResolvedValue([]);
  reads.dims.mockReset();
  state.enabled = true;
  state.accounts = [
    { id: "acct-aws", displayName: "Prod AWS", pluginId: "aws" },
    { id: "acct-k8s", displayName: "Cluster", pluginId: "kubernetes" },
    { id: "acct-gcp", displayName: "GCP", pluginId: "gcp" },
    { id: "acct-az", displayName: "Azure", pluginId: "azure" },
  ];
});

const config = {
  version: 1 as const,
  dateRange: { kind: "relative" as const, preset: "30d" as const },
  granularity: "weekly" as const,
  groupBy: "pair" as const,
  filters: {},
  metric: "cost" as const,
};

describe("runNetworkFlowReportConfig", () => {
  it("leaves re-cut plugins out of an org-wide report and says so", async () => {
    const result = await runNetworkFlowReportConfig(ORG, config, TODAY);
    const filters = reads.cells.mock.calls[0]![1].filters;
    expect(filters.excludePluginIds).toEqual(["kubernetes"]);
    expect(result.notices).toContain("recut_excluded");
    expect(reads.cells.mock.calls[0]![1].range).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("includes a cluster's rows when its account is named", async () => {
    const result = await runNetworkFlowReportConfig(
      ORG,
      { ...config, filters: { accountIds: ["acct-k8s"] } },
      TODAY,
    );
    const filters = reads.groups.mock.calls[0]![1].filters;
    expect(filters.excludePluginIds).toEqual([]);
    expect(filters.accountIds).toEqual(["acct-k8s"]);
    expect(result.notices).not.toContain("recut_excluded");
  });

  it("maps report filters onto reader filters", async () => {
    await runNetworkFlowReportConfig(
      ORG,
      {
        ...config,
        filters: {
          services: ["s3"],
          resourceTypes: ["ec2-instance"],
          trafficClasses: ["cross_zone"],
          directions: ["egress"],
          networks: ["vpc-1"],
        },
      },
      TODAY,
    );
    expect(reads.talkers.mock.calls[0]![1].filters).toMatchObject({
      peerServices: ["s3"],
      peerResourceTypes: ["ec2-instance"],
      scopes: ["cross_zone"],
      directions: ["egress"],
      networks: ["vpc-1"],
    });
  });

  it("passes sampled plugins down and marks their talkers", async () => {
    reads.talkers.mockResolvedValue([
      {
        src_ref: "vm-1",
        src_label: "",
        src_zone: "",
        src_region: "",
        src_service: "",
        src_resource_type_id: "",
        src_network: "",
        dst_ref: "internet",
        dst_label: "Internet",
        dst_zone: "",
        dst_region: "",
        dst_service: "",
        dst_resource_type_id: "",
        dst_network: "",
        scope: "internet_egress",
        direction: "egress",
        attribution: "resolved",
        bytes: 10,
        packets: 1,
        estimated_cost: 1,
        currency: "USD",
        account_id: "acct-gcp",
        plugin_id: "gcp",
        days: 2,
        sampled: 1,
      },
    ]);
    const result = await runNetworkFlowReportConfig(ORG, config, TODAY);
    expect(reads.talkers.mock.calls[0]![1].sampledPluginIds).toEqual(["gcp"]);
    expect(result.sampledPluginIds).toEqual(["gcp"]);
    expect(result.topTalkers[0]).toMatchObject({
      sampled: true,
      accountName: "GCP",
      source: { label: "vm-1" },
    });
  });

  it("charts only the largest groups and labels pairs from both ends", async () => {
    reads.groups.mockResolvedValue({
      rows: [
        {
          group_key: "i-a\u001fi-b",
          label_a: "web",
          label_b: "",
          currency: "USD",
          pair_count: 1,
          ...figures,
          estimated_cost: 5,
        },
      ],
      count: 12,
    });
    const result = await runNetworkFlowReportConfig(ORG, config, TODAY);
    // Second cells read is the chart's, restricted to the ranked keys.
    expect(reads.cells.mock.calls[1]![1]).toMatchObject({
      split: "pair",
      groupKeys: ["i-a\u001fi-b"],
    });
    expect(result.groups[0]!.label).toBe("web → i-b");
    expect(result.groupCount).toBe(12);
  });

  it("raises collection, availability and retention notices", async () => {
    state.enabled = false;
    state.accounts = [{ id: "acct-az", displayName: "Azure", pluginId: "azure" }];
    const result = await runNetworkFlowReportConfig(
      ORG,
      { ...config, dateRange: { kind: "relative", preset: "6m" } },
      TODAY,
    );
    expect(result.notices).toEqual(
      expect.arrayContaining(["collection_disabled", "no_flow_accounts", "beyond_retention"]),
    );
  });

  it("refuses a resolved window past the limit", async () => {
    await expect(
      runNetworkFlowReportConfig(
        ORG,
        { ...config, dateRange: { kind: "absolute", from: "2024-01-01", to: "2026-09-01" } },
        TODAY,
      ),
    ).rejects.toBeInstanceOf(NetworkFlowReportError);
  });
});

describe("getNetworkFlowReportOptions", () => {
  it("offers flow-capable accounts and every traffic class, seen ones first", async () => {
    reads.dims.mockResolvedValue({
      networks: ["vpc-1"],
      regions: ["us-east-1"],
      zones: ["use1-az1"],
      services: ["s3"],
      resourceTypes: ["ec2-instance"],
      scopes: ["internet_egress"],
      endpoints: [{ ref: "i-1", label: "web", resource_type_id: "ec2-instance", side: "source" }],
    });
    const options = await getNetworkFlowReportOptions(ORG, TODAY);
    expect(options.accounts.map((a) => a.id)).toEqual(["acct-k8s", "acct-gcp", "acct-aws"]);
    expect(options.accounts.find((a) => a.id === "acct-k8s")?.recut).toBe(true);
    expect(options.trafficClasses[0]).toBe("internet_egress");
    expect(options.trafficClasses).toHaveLength(9);
    expect(options.endpoints[0]).toEqual({
      ref: "i-1",
      label: "web",
      resourceTypeId: "ec2-instance",
      side: "source",
    });
    expect(reads.dims.mock.calls[0]![1]).toEqual({ from: "2026-07-03", to: "2026-09-30" });
  });
});
