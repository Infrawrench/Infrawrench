import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BusinessMetricSourceRange } from "@infrawrench/plugin-base";

const queryPostCall = vi.fn();
vi.mock("../client-transport.js", () => ({
  queryPostCall: (...a: unknown[]) => queryPostCall(...a),
}));

import {
  AWS_BUSINESS_METRIC_SOURCE,
  decodeDimensions,
  encodeDimensions,
  listCloudWatchSourceOptions,
  runCloudWatchSource,
} from "../business-metric-source.js";
import { plugin } from "../plugin.js";

const base = { accessKeyId: "AKIA", secretAccessKey: "s", region: "eu-west-1" };
const credsFor = (region: string) => ({ ...base, region });

const NOW = Date.parse("2026-10-04T12:00:00Z");

function range(over: Partial<BusinessMetricSourceRange> = {}): BusinessMetricSourceRange {
  return {
    from: "2026-09-01",
    to: "2026-09-02",
    timezone: "UTC",
    maxRows: 50_000,
    timeoutMs: 5_000,
    ...over,
  };
}

function statsResponse(datapoints: Array<Record<string, unknown>>) {
  return { GetMetricStatisticsResult: { Label: "m", Datapoints: { member: datapoints } } };
}

function paramsOf(call: number): Record<string, string> {
  return queryPostCall.mock.calls[call]![4] as Record<string, string>;
}

beforeEach(() => {
  queryPostCall.mockReset();
});

describe("manifest", () => {
  it("declares an enforced read-only CloudWatch metric source", () => {
    expect(plugin.manifest.businessMetricSource).toBe(AWS_BUSINESS_METRIC_SOURCE);
    expect(AWS_BUSINESS_METRIC_SOURCE.kind).toBe("metric");
    expect(AWS_BUSINESS_METRIC_SOURCE.readOnly).toBe("enforced");
    expect(AWS_BUSINESS_METRIC_SOURCE.fields.map((f) => f.key)).toEqual([
      "region",
      "namespace",
      "metricName",
      "dimensions",
      "stat",
    ]);
    const stat = AWS_BUSINESS_METRIC_SOURCE.fields.find((f) => f.key === "stat");
    expect(stat?.options?.map((o) => o.id)).toContain("p99");
  });
});

describe("dimension encoding", () => {
  it("round-trips names and values containing separators", () => {
    const dims = [
      { Name: "Service", Value: "a,b=c\\d" },
      { Name: "Api", Value: "orders" },
    ];
    const encoded = encodeDimensions(dims);
    expect(encoded).toBe("Api=orders,Service=a\\,b\\=c\\\\d");
    expect(decodeDimensions(encoded)).toEqual([
      { Name: "Api", Value: "orders" },
      { Name: "Service", Value: "a,b=c\\d" },
    ]);
  });

  it("treats an empty string as no dimensions and rejects malformed input", () => {
    expect(decodeDimensions("")).toEqual([]);
    expect(() => decodeDimensions("JustAName")).toThrow(/Name=Value/);
  });
});

describe("listCloudWatchSourceOptions", () => {
  it("lists the account's region first", async () => {
    const options = await listCloudWatchSourceOptions(credsFor, "eu-west-1", "region", {});
    expect(options[0]).toMatchObject({ id: "eu-west-1", label: "eu-west-1 (account region)" });
    expect(options.filter((o) => o.id === "eu-west-1")).toHaveLength(1);
    expect(queryPostCall).not.toHaveBeenCalled();
  });

  it("pages ListMetrics, dedupes namespaces and adds common AWS ones", async () => {
    queryPostCall
      .mockResolvedValueOnce({
        ListMetricsResult: {
          Metrics: {
            member: [
              { Namespace: "AWS/Lambda", MetricName: "Invocations" },
              { Namespace: "MyApp", MetricName: "Signups" },
            ],
          },
          NextToken: "tok",
        },
      })
      .mockResolvedValueOnce({
        ListMetricsResult: {
          Metrics: { member: [{ Namespace: "AWS/Lambda", MetricName: "Errors" }] },
        },
      });
    const options = await listCloudWatchSourceOptions(credsFor, "eu-west-1", "namespace", {
      region: "us-east-2",
    });
    expect(queryPostCall).toHaveBeenCalledTimes(2);
    expect(queryPostCall.mock.calls[0]![0]).toMatchObject({ region: "us-east-2" });
    expect(queryPostCall.mock.calls[0]![2]).toBe("ListMetrics");
    expect(paramsOf(1)["NextToken"]).toBe("tok");
    const ids = options.map((o) => o.id);
    expect(ids.slice(0, 2)).toEqual(["MyApp", "AWS/Lambda"]);
    expect(ids.filter((id) => id === "AWS/Lambda")).toHaveLength(1);
    expect(ids).toContain("AWS/SQS");
  });

  it("lists distinct metric names for a namespace", async () => {
    queryPostCall.mockResolvedValueOnce({
      ListMetricsResult: {
        Metrics: {
          member: [
            { Namespace: "AWS/Lambda", MetricName: "Invocations" },
            { Namespace: "AWS/Lambda", MetricName: "Invocations" },
            { Namespace: "AWS/Lambda", MetricName: "Duration" },
          ],
        },
      },
    });
    const options = await listCloudWatchSourceOptions(credsFor, "eu-west-1", "metricName", {
      region: "eu-west-1",
      namespace: "AWS/Lambda",
    });
    expect(paramsOf(0)["Namespace"]).toBe("AWS/Lambda");
    expect(options.map((o) => o.id)).toEqual(["Duration", "Invocations"]);
  });

  it("offers each dimension set seen, plus no dimensions", async () => {
    queryPostCall.mockResolvedValueOnce({
      ListMetricsResult: {
        Metrics: {
          member: [
            {
              Namespace: "AWS/Lambda",
              MetricName: "Invocations",
              Dimensions: { member: [{ Name: "FunctionName", Value: "checkout" }] },
            },
            {
              Namespace: "AWS/Lambda",
              MetricName: "Invocations",
              Dimensions: {
                member: [
                  { Name: "Resource", Value: "checkout:prod" },
                  { Name: "FunctionName", Value: "checkout" },
                ],
              },
            },
            { Namespace: "AWS/Lambda", MetricName: "Invocations" },
          ],
        },
      },
    });
    const options = await listCloudWatchSourceOptions(credsFor, "eu-west-1", "dimensions", {
      region: "eu-west-1",
      namespace: "AWS/Lambda",
      metricName: "Invocations",
    });
    expect(paramsOf(0)["MetricName"]).toBe("Invocations");
    expect(options.map((o) => o.id)).toEqual([
      "",
      "FunctionName=checkout",
      "FunctionName=checkout,Resource=checkout:prod",
    ]);
    expect(options[2]!.label).toBe("FunctionName=checkout, Resource=checkout:prod");
  });
});

describe("runCloudWatchSource", () => {
  const params = {
    region: "us-east-1",
    namespace: "MyApp",
    metricName: "Signups",
    dimensions: "Env=prod",
    stat: "Sum",
  };

  it("reads hourly sums over the zoned window and maps them to local days", async () => {
    queryPostCall.mockResolvedValueOnce(
      statsResponse([
        { Timestamp: "2026-09-01T04:00:00Z", Sum: "3" }, // 00:00 New York
        { Timestamp: "2026-09-02T03:00:00Z", Sum: "4" }, // 23:00 New York, Sep 1
        { Timestamp: "2026-09-02T04:00:00Z", Sum: "5" }, // 00:00 New York, Sep 2
      ]),
    );
    const result = await runCloudWatchSource(
      credsFor,
      "eu-west-1",
      params,
      range({ timezone: "America/New_York" }),
      NOW,
    );
    const p = paramsOf(0);
    expect(queryPostCall.mock.calls[0]![0]).toMatchObject({ region: "us-east-1" });
    expect(queryPostCall.mock.calls[0]![2]).toBe("GetMetricStatistics");
    expect(p["Period"]).toBe("3600");
    expect(p["StartTime"]).toBe("2026-09-01T04:00:00.000Z");
    expect(p["EndTime"]).toBe("2026-09-03T04:00:00.000Z");
    expect(p["Statistics.member.1"]).toBe("Sum");
    expect(p["Dimensions.member.1.Name"]).toBe("Env");
    expect(p["Dimensions.member.1.Value"]).toBe("prod");
    expect(result.points).toEqual([
      { date: "2026-09-01", value: 3 },
      { date: "2026-09-01", value: 4 },
      { date: "2026-09-02", value: 5 },
    ]);
    expect(result.notes?.[0]).toMatch(/hourly Sum/);
  });

  it("splits the window so no call asks for more than 1,440 datapoints", async () => {
    queryPostCall.mockResolvedValue(statsResponse([]));
    await runCloudWatchSource(
      credsFor,
      "eu-west-1",
      params,
      range({ from: "2026-06-01", to: "2026-09-30" }),
      NOW,
    );
    expect(queryPostCall).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) {
      const p = paramsOf(i);
      const hours = (Date.parse(p["EndTime"]!) - Date.parse(p["StartTime"]!)) / 3_600_000;
      expect(hours).toBeLessThanOrEqual(1440);
    }
    expect(paramsOf(0)["StartTime"]).toBe("2026-06-01T00:00:00.000Z");
    expect(paramsOf(2)["EndTime"]).toBe("2026-10-01T00:00:00.000Z");
  });

  it("uses daily periods past CloudWatch's 455-day hourly retention", async () => {
    queryPostCall.mockResolvedValue(statsResponse([]));
    await runCloudWatchSource(
      credsFor,
      "eu-west-1",
      params,
      range({ from: "2025-01-01", to: "2025-01-31" }),
      NOW,
    );
    expect(paramsOf(0)["Period"]).toBe("86400");
  });

  it("requests percentiles as ExtendedStatistics and reads the entry map", async () => {
    queryPostCall.mockResolvedValueOnce(
      statsResponse([
        {
          Timestamp: "2026-09-01T10:00:00Z",
          ExtendedStatistics: { entry: { key: "p99", value: "120.5" } },
        },
      ]),
    );
    const result = await runCloudWatchSource(
      credsFor,
      "eu-west-1",
      { ...params, stat: "p99" },
      range(),
      NOW,
    );
    const p = paramsOf(0);
    expect(p["ExtendedStatistics.member.1"]).toBe("p99");
    expect(p["Statistics.member.1"]).toBeUndefined();
    expect(result.points).toEqual([{ date: "2026-09-01", value: 120.5 }]);
  });

  it("falls back to the account region and no dimensions", async () => {
    queryPostCall.mockResolvedValueOnce(statsResponse([]));
    await runCloudWatchSource(
      credsFor,
      "eu-west-1",
      { namespace: "MyApp", metricName: "Signups", stat: "Sum" },
      range(),
      NOW,
    );
    expect(queryPostCall.mock.calls[0]![0]).toMatchObject({ region: "eu-west-1" });
    expect(paramsOf(0)["Dimensions.member.1.Name"]).toBeUndefined();
  });

  it("throws rather than truncating past maxRows", async () => {
    queryPostCall.mockResolvedValueOnce(
      statsResponse([
        { Timestamp: "2026-09-01T00:00:00Z", Sum: 1 },
        { Timestamp: "2026-09-01T01:00:00Z", Sum: 1 },
        { Timestamp: "2026-09-01T02:00:00Z", Sum: 1 },
      ]),
    );
    await expect(
      runCloudWatchSource(credsFor, "eu-west-1", params, range({ maxRows: 2 }), NOW),
    ).rejects.toThrow(/more than 2 datapoints/);
  });

  it("rejects an unknown statistic and a missing metric before calling AWS", async () => {
    await expect(
      runCloudWatchSource(credsFor, "eu-west-1", { ...params, stat: "Median" }, range(), NOW),
    ).rejects.toThrow(/not a supported statistic/);
    await expect(
      runCloudWatchSource(credsFor, "eu-west-1", { ...params, metricName: "" }, range(), NOW),
    ).rejects.toThrow(/Pick a CloudWatch metric/);
    expect(queryPostCall).not.toHaveBeenCalled();
  });

  it("gives up after the timeout", async () => {
    queryPostCall.mockReturnValue(new Promise(() => {}));
    await expect(
      runCloudWatchSource(credsFor, "eu-west-1", params, range({ timeoutMs: 10 }), NOW),
    ).rejects.toThrow(/did not answer/);
  });
});
