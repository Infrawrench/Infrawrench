import { describe, expect, it } from "vitest";

import {
  buildNetworkFlowReport,
  DEFAULT_NETWORK_FLOW_REPORT_CONFIG,
  emptyNetworkFlowReportTotals,
  networkFlowReportBucketOf,
  networkFlowReportBuckets,
  networkFlowReportCsvFileName,
  networkFlowReportPairsToCsv,
  networkFlowReportToCsv,
  networkFlowSampledShare,
  normalizeNetworkFlowReportConfig,
  normalizeNetworkFlowReportInput,
  splitNetworkFlowPairKey,
  NETWORK_FLOW_PAIR_SEPARATOR,
  NETWORK_FLOW_REPORT_LIMITS,
  NETWORK_FLOW_REPORT_OTHER_KEY,
  type NetworkFlowReportCell,
  type NetworkFlowReportGroupTotal,
  type NetworkFlowReportTalker,
} from "../network-flow-reports";

function cell(
  bucket: string,
  groupKey: string,
  bytes: number,
  estimatedCost: number,
  extra: Partial<NetworkFlowReportCell> = {},
): NetworkFlowReportCell {
  return {
    ...emptyNetworkFlowReportTotals(),
    bucket,
    groupKey,
    currency: "USD",
    bytes,
    estimatedCost,
    ...extra,
  };
}

function group(
  groupKey: string,
  bytes: number,
  estimatedCost: number,
): NetworkFlowReportGroupTotal {
  return {
    ...emptyNetworkFlowReportTotals(),
    groupKey,
    label: groupKey,
    currency: "USD",
    pairCount: 1,
    bytes,
    estimatedCost,
  };
}

function talker(ref: string, bytes: number, estimatedCost: number): NetworkFlowReportTalker {
  const end = (r: string) => ({
    ref: r,
    label: r,
    zone: "use1-az1",
    region: "us-east-1",
    service: "",
    resourceTypeId: "",
    network: "vpc-1",
  });
  return {
    source: end(ref),
    destination: end("internet"),
    scope: "internet_egress",
    direction: "egress",
    attribution: "resolved",
    bytes,
    packets: 0,
    estimatedCost,
    currency: "USD",
    accountId: "acct-1",
    accountName: "Prod",
    pluginId: "aws",
    days: 3,
    sampled: false,
  };
}

describe("normalizeNetworkFlowReportConfig", () => {
  it("accepts the default and fills defaults for omitted fields", () => {
    expect(normalizeNetworkFlowReportConfig(DEFAULT_NETWORK_FLOW_REPORT_CONFIG)).toEqual({
      ok: true,
      value: DEFAULT_NETWORK_FLOW_REPORT_CONFIG,
    });
    const parsed = normalizeNetworkFlowReportConfig({
      version: 1,
      dateRange: { kind: "relative", preset: "7d" },
    });
    expect(parsed).toMatchObject({
      ok: true,
      value: { granularity: "daily", groupBy: "none", metric: "both", filters: {} },
    });
  });

  it("refuses unknown keys, unknown filters and bad enums rather than dropping them", () => {
    const base = { version: 1, dateRange: { kind: "relative", preset: "30d" } };
    expect(normalizeNetworkFlowReportConfig({ ...base, colour: "red" })).toMatchObject({
      ok: false,
    });
    expect(normalizeNetworkFlowReportConfig({ ...base, filters: { vpc: ["x"] } })).toMatchObject({
      ok: false,
      error: 'Unknown filter "vpc".',
    });
    expect(
      normalizeNetworkFlowReportConfig({ ...base, filters: { trafficClasses: ["peering"] } }),
    ).toMatchObject({ ok: false });
    expect(
      normalizeNetworkFlowReportConfig({ ...base, filters: { directions: ["sideways"] } }),
    ).toMatchObject({ ok: false });
    expect(normalizeNetworkFlowReportConfig({ ...base, groupBy: "port" })).toMatchObject({
      ok: false,
    });
    expect(normalizeNetworkFlowReportConfig({ ...base, metric: "packets" })).toMatchObject({
      ok: false,
    });
  });

  it("says why hourly is refused", () => {
    const out = normalizeNetworkFlowReportConfig({
      version: 1,
      dateRange: { kind: "relative", preset: "7d" },
      granularity: "hourly",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/one row per day/);
  });

  it("dedupes filter values, drops empty lists and validates topN", () => {
    const out = normalizeNetworkFlowReportConfig({
      version: 1,
      dateRange: { kind: "relative", preset: "7d" },
      filters: { regions: ["us-east-1", "us-east-1"], zones: [] },
      topN: 10,
    });
    expect(out).toMatchObject({
      ok: true,
      value: { filters: { regions: ["us-east-1"] }, topN: 10 },
    });
    if (out.ok) expect(out.value.filters.zones).toBeUndefined();
    for (const topN of [0, 1.5, NETWORK_FLOW_REPORT_LIMITS.maxTopN + 1, "5"]) {
      expect(
        normalizeNetworkFlowReportConfig({
          version: 1,
          dateRange: { kind: "relative", preset: "7d" },
          topN,
        }).ok,
      ).toBe(false);
    }
  });

  it("checks absolute ranges", () => {
    const at = (from: string, to: string) =>
      normalizeNetworkFlowReportConfig({ version: 1, dateRange: { kind: "absolute", from, to } });
    expect(at("2026-09-02", "2026-09-01").ok).toBe(false);
    expect(at("2026-02-30", "2026-03-01").ok).toBe(false);
    expect(at("2025-01-01", "2026-09-01").ok).toBe(false);
    expect(at("2026-08-01", "2026-09-01").ok).toBe(true);
  });
});

describe("normalizeNetworkFlowReportInput", () => {
  it("trims, requires a name and refuses unknown fields", () => {
    expect(
      normalizeNetworkFlowReportInput({
        name: "  Egress by VPC ",
        description: "",
        config: DEFAULT_NETWORK_FLOW_REPORT_CONFIG,
      }),
    ).toEqual({
      ok: true,
      value: {
        name: "Egress by VPC",
        description: null,
        config: DEFAULT_NETWORK_FLOW_REPORT_CONFIG,
        folderId: null,
      },
    });
    expect(normalizeNetworkFlowReportInput({ name: " ", config: {} }).ok).toBe(false);
    expect(
      normalizeNetworkFlowReportInput({
        name: "x",
        config: DEFAULT_NETWORK_FLOW_REPORT_CONFIG,
        owner: "me",
      }).ok,
    ).toBe(false);
  });
});

describe("buckets", () => {
  it("starts weeks on Monday and months on the 1st", () => {
    expect(networkFlowReportBucketOf("2026-09-06", "weekly")).toBe("2026-08-31");
    expect(networkFlowReportBucketOf("2026-09-07", "weekly")).toBe("2026-09-07");
    expect(networkFlowReportBucketOf("2026-09-17", "monthly")).toBe("2026-09-01");
    expect(networkFlowReportBuckets("2026-08-30", "2026-09-02", "daily")).toHaveLength(4);
    expect(networkFlowReportBuckets("2026-07-15", "2026-09-02", "monthly")).toEqual([
      "2026-07-01",
      "2026-08-01",
      "2026-09-01",
    ]);
  });
});

describe("buildNetworkFlowReport", () => {
  const base = {
    from: "2026-09-01",
    to: "2026-09-03",
    granularity: "daily" as const,
    metric: "cost" as const,
    topN: 25,
  };

  it("fills every bucket and keeps an ungrouped report to the overall line", () => {
    const result = buildNetworkFlowReport({
      ...base,
      groupBy: "none",
      overallCells: [cell("2026-09-01", "", 100, 1), cell("2026-09-03", "", 50, 0.5)],
      seriesCells: [],
      groups: [],
      topTalkers: [],
    });
    expect(result.buckets).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(result.series).toEqual([]);
    expect(result.overall).toHaveLength(1);
    expect(result.overall[0]!.points.map((p) => p.bytes)).toEqual([100, 0, 50]);
    expect(result.overall[0]!.total).toMatchObject({ bytes: 150, estimatedCost: 1.5 });
    expect(result.estimated).toBe(true);
  });

  it("draws the largest groups and folds the rest into one series that adds up", () => {
    const keys = Array.from(
      { length: NETWORK_FLOW_REPORT_LIMITS.chartSeries + 2 },
      (_, i) => `g${i}`,
    );
    // Drawn groups: the first chartSeries keys, 10 bytes / $1 each per day.
    const drawn = keys.slice(0, NETWORK_FLOW_REPORT_LIMITS.chartSeries);
    const seriesCells = drawn.flatMap((k) => [cell("2026-09-01", k, 10, 1)]);
    const overallTotalBytes = keys.length * 10;
    const result = buildNetworkFlowReport({
      ...base,
      groupBy: "source",
      overallCells: [cell("2026-09-01", "", overallTotalBytes, keys.length)],
      seriesCells,
      groups: keys.map((k) => group(k, 10, 1)),
      topTalkers: [],
    });
    const other = result.series.find((s) => s.groupKey === NETWORK_FLOW_REPORT_OTHER_KEY);
    expect(result.series).toHaveLength(NETWORK_FLOW_REPORT_LIMITS.chartSeries + 1);
    expect(other?.total).toMatchObject({ bytes: 20, estimatedCost: 2 });
    const stacked = result.series.reduce((a, s) => a + s.total.bytes, 0);
    expect(stacked).toBe(result.overall[0]!.total.bytes);
  });

  it("ranks by bytes for a bytes report and by money otherwise", () => {
    const groups = [group("cheap-heavy", 1000, 1), group("pricey-light", 10, 50)];
    const cost = buildNetworkFlowReport({
      ...base,
      groupBy: "source",
      overallCells: [],
      seriesCells: [],
      groups,
      topTalkers: [talker("a", 1000, 1), talker("b", 10, 50)],
    });
    expect(cost.groups.map((g) => g.groupKey)).toEqual(["pricey-light", "cheap-heavy"]);
    expect(cost.topTalkers.map((t) => t.source.ref)).toEqual(["b", "a"]);
    const bytes = buildNetworkFlowReport({
      ...base,
      metric: "bytes",
      groupBy: "source",
      overallCells: [],
      seriesCells: [],
      groups,
      topTalkers: [talker("a", 1000, 1), talker("b", 10, 50)],
    });
    expect(bytes.groups.map((g) => g.groupKey)).toEqual(["cheap-heavy", "pricey-light"]);
    expect(bytes.topTalkers.map((t) => t.source.ref)).toEqual(["a", "b"]);
  });

  it("cuts groups and talkers at topN and reports the full group count", () => {
    const result = buildNetworkFlowReport({
      ...base,
      topN: 1,
      groupBy: "destination",
      overallCells: [],
      seriesCells: [],
      groups: [group("a", 1, 1), group("b", 2, 2)],
      groupCount: 40,
      topTalkers: [talker("a", 1, 1), talker("b", 2, 2)],
    });
    expect(result.groups).toHaveLength(1);
    expect(result.groupCount).toBe(40);
    expect(result.topTalkers).toHaveLength(1);
  });

  it("raises sampling, attribution and currency notices from the data", () => {
    const result = buildNetworkFlowReport({
      ...base,
      groupBy: "none",
      overallCells: [
        cell("2026-09-01", "", 100, 1, {
          sampledBytes: 40,
          unattributedBytes: 5,
          truncatedBytes: 7,
        }),
        { ...cell("2026-09-01", "", 10, 1), currency: "EUR" },
      ],
      seriesCells: [],
      groups: [],
      topTalkers: [],
      notices: ["collection_disabled"],
    });
    expect(result.notices).toEqual([
      "collection_disabled",
      "sampled_sources",
      "unattributed_traffic",
      "truncated_traffic",
      "multiple_currencies",
    ]);
    const usd = result.overall.find((s) => s.currency === "USD")!;
    expect(networkFlowSampledShare(usd.total)).toBeCloseTo(0.4);
  });
});

describe("pair keys and CSV", () => {
  it("splits pair keys on the separator", () => {
    expect(splitNetworkFlowPairKey(`a${NETWORK_FLOW_PAIR_SEPARATOR}b`)).toEqual(["a", "b"]);
    expect(splitNetworkFlowPairKey("plain")).toEqual(["plain", ""]);
  });

  it("writes series rows plus totals, and neutralises formula-looking labels", () => {
    const result = buildNetworkFlowReport({
      from: "2026-09-01",
      to: "2026-09-02",
      granularity: "daily",
      metric: "both",
      topN: 25,
      groupBy: "source",
      overallCells: [cell("2026-09-01", "", 2_000_000_000, 0.02)],
      seriesCells: [cell("2026-09-01", "=cmd", 2_000_000_000, 0.02)],
      groups: [{ ...group("=cmd", 2_000_000_000, 0.02), label: "=cmd" }],
      topTalkers: [talker("i-1", 5, 0.123)],
    });
    const csv = networkFlowReportToCsv(result);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe(
      '"bucket","group","currency","bytes","estimated_cost","sampled_share","unattributed_bytes","outside_top_pairs_bytes"',
    );
    expect(lines).toContain('"2026-09-01","\t=cmd","USD",2000000000,0.02,0,0,0');
    expect(lines.at(-1)).toBe('"total","\t=cmd","USD",2000000000,0.02,0,0,0');
    const pairs = networkFlowReportPairsToCsv(result).trim().split("\r\n");
    expect(pairs).toHaveLength(2);
    expect(pairs[1]).toContain('"i-1"');
    expect(pairs[1]).toContain("0.12");
    expect(
      networkFlowReportCsvFileName("Egress: by VPC!", "2026-09-01", "2026-09-30", "pairs"),
    ).toBe("egress-by-vpc-pairs-2026-09-01-to-2026-09-30.csv");
  });
});
