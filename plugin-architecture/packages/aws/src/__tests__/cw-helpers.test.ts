import { describe, it, expect, vi, beforeEach } from "vitest";

const queryPostCall = vi.fn();
vi.mock("../client-transport.js", () => ({
  queryPostCall: (...a: unknown[]) => queryPostCall(...a),
}));

import { callGetMetricStatistics, makeMetricsContext } from "../metrics/cw-helpers.js";

const creds = { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-1" };

beforeEach(() => queryPostCall.mockReset());

describe("callGetMetricStatistics", () => {
  it("builds Dimensions.member.N + Statistics.member.N params and parses result", async () => {
    queryPostCall.mockResolvedValue({
      GetMetricStatisticsResult: {
        Label: "CPUUtilization",
        Datapoints: {
          member: [{ Timestamp: "2020-01-01T00:00:00Z", Average: 5, Unit: "Percent" }],
        },
      },
    });
    const out = await callGetMetricStatistics(creds, {
      Namespace: "AWS/EC2",
      MetricName: "CPUUtilization",
      Dimensions: [{ Name: "InstanceId", Value: "i-1" }],
      StartTime: "2020-01-01T00:00:00Z",
      EndTime: "2020-01-01T01:00:00Z",
      Period: 60,
      Statistics: ["Average"],
    });
    expect(out.label).toBe("CPUUtilization");
    expect(out.datapoints.length).toBe(1);
    const params = queryPostCall.mock.calls[0]![4] as Record<string, string>;
    expect(params["Dimensions.member.1.Name"]).toBe("InstanceId");
    expect(params["Dimensions.member.1.Value"]).toBe("i-1");
    expect(params["Statistics.member.1"]).toBe("Average");
    expect(params["Period"]).toBe("60");
  });

  it("returns empty list when result missing", async () => {
    queryPostCall.mockResolvedValue({});
    const out = await callGetMetricStatistics(creds, {
      Namespace: "AWS/EC2",
      MetricName: "X",
      Dimensions: [],
      StartTime: "a",
      EndTime: "b",
      Period: 60,
      Statistics: ["Sum"],
    });
    expect(out.datapoints).toEqual([]);
    expect(out.label).toBe("");
  });
});

describe("makeMetricsContext", () => {
  it("uses provided time range and computes a period; fetchCw maps + sorts points", async () => {
    queryPostCall.mockResolvedValue({
      GetMetricStatisticsResult: {
        Label: "L",
        Datapoints: {
          member: [
            { Timestamp: "2020-01-01T00:02:00Z", Sum: 2, Unit: "Bytes" },
            { Timestamp: "2020-01-01T00:01:00Z", Sum: 1 },
          ],
        },
      },
    });
    const ctx = makeMetricsContext(creds, { startMs: 0, endMs: 600_000 });
    expect(ctx.period).toBeGreaterThanOrEqual(60);
    const series = await ctx.fetchCw(
      "AWS/EC2",
      "NetworkIn",
      [{ Name: "InstanceId", Value: "i" }],
      "Sum",
    );
    expect(series.label).toBe("NetworkIn");
    expect(series.unit).toBe("Bytes");
    // sorted ascending by timestamp
    expect(series.points[0]!.value).toBe(1);
    expect(series.points[1]!.value).toBe(2);
  });

  it("defaults the window when no range given and honors regionOverride", async () => {
    queryPostCall.mockResolvedValue({
      GetMetricStatisticsResult: { Label: "L", Datapoints: { member: [] } },
    });
    const ctx = makeMetricsContext(creds, undefined);
    await ctx.fetchCw("AWS/CloudFront", "Requests", [], "Sum", { regionOverride: "us-east-1" });
    const usedCreds = queryPostCall.mock.calls[0]![0] as { region: string };
    expect(usedCreds.region).toBe("us-east-1");
  });
});
