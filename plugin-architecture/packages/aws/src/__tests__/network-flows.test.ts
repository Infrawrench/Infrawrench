import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ResultField } from "@aws-sdk/client-cloudwatch-logs";
import type { NetworkFlowTotal } from "@infrawrench/plugin-base";

const getAwsClients = vi.fn();
vi.mock("../aws-clients.js", () => ({ getAwsClients: (...a: unknown[]) => getAwsClients(...a) }));

import { fetchAwsNetworkFlows } from "../network-flows.js";
import type { AwsCredentials } from "../auth.js";

const creds: AwsCredentials = {
  accessKeyId: "AKIA",
  secretAccessKey: "secret",
  region: "us-east-1",
};

const DAY = "2026-08-10";

/** Two instances in the same account, one per zone. */
const INTERFACES = [
  {
    NetworkInterfaceId: "eni-a",
    PrivateIpAddress: "10.0.1.4",
    AvailabilityZoneId: "use1-az1",
    Attachment: { InstanceId: "i-local" },
  },
  {
    NetworkInterfaceId: "eni-b",
    PrivateIpAddress: "10.0.2.5",
    AvailabilityZoneId: "use1-az2",
    Attachment: { InstanceId: "i-peer" },
  },
];

function row(fields: Record<string, string>): ResultField[] {
  return Object.entries(fields).map(([field, value]) => ({ field, value }));
}

/**
 * Stand in for the two AWS services this reads. Insights queries are answered
 * by shape — the pair query is the one that sorts and limits — so the fixtures
 * stay readable and neither query can be answered with the other's rows.
 */
function mockAws(opts: {
  logFormat: string;
  pairRows: ResultField[][];
  totalRows: ResultField[][];
}) {
  const results: Record<string, ResultField[][]> = {
    pair: opts.pairRows,
    totals: opts.totalRows,
  };
  getAwsClients.mockReturnValue({
    ec2: {
      send: async (command: { constructor: { name: string } }) => {
        switch (command.constructor.name) {
          case "DescribeFlowLogsCommand":
            return {
              FlowLogs: [
                {
                  FlowLogId: "fl-1",
                  ResourceId: "vpc-1",
                  LogDestinationType: "cloud-watch-logs",
                  LogGroupName: "/aws/vpc/flowlogs",
                  LogFormat: opts.logFormat,
                },
              ],
            };
          case "DescribeNetworkInterfacesCommand":
            return { NetworkInterfaces: INTERFACES };
          default:
            throw new Error(`unexpected EC2 command ${command.constructor.name}`);
        }
      },
    },
    cloudWatchLogs: {
      send: async (command: { constructor: { name: string }; input: Record<string, string> }) => {
        switch (command.constructor.name) {
          case "StartQueryCommand":
            return { queryId: command.input["queryString"]!.includes("sort ") ? "pair" : "totals" };
          case "GetQueryResultsCommand":
            return {
              status: "Complete",
              results: results[command.input["queryId"]!],
              statistics: { bytesScanned: 1_000_000 },
            };
          default:
            throw new Error(`unexpected Logs command ${command.constructor.name}`);
        }
      },
    },
  });
}

function totalOf(totals: NetworkFlowTotal[], scope: string, direction: string) {
  return totals.find((t) => t.scope === scope && t.direction === direction);
}

function sumBytes(items: { bytes: number }[]): number {
  return items.reduce((acc, t) => acc + t.bytes, 0);
}

beforeEach(() => {
  vi.clearAllMocks();
});

/*
 * The totals query is a second, separately billed scan of the same log group,
 * bought for exactly one property: the host's residual is `total − kept pairs`,
 * so the truncated tail is an exact subtraction rather than an estimate. That
 * property holds only while the totals and the pairs agree about which bucket a
 * row's bytes were counted in — and the totals query, by design, has no
 * addresses in it, so it is the classifier with less to go on.
 */
describe("fetchAwsNetworkFlows — totals against pairs", () => {
  /**
   * A format with the four required fields plus `az-id`: no `next-hop-az-id`
   * and no `traffic-path`, which is what makes the two views disagree.
   */
  const NO_HOP_FORMAT =
    "${version} ${srcaddr} ${dstaddr} ${bytes} ${packets} ${flow-direction} ${az-id} ${log-status}";

  /** Ingress from a peer that resolves to this account's other-zone instance. */
  const localIngressPair = row({
    srcaddr: "10.0.2.5",
    dstaddr: "10.0.1.4",
    flowDirection: "ingress",
    azId: "use1-az1",
    flowBytes: "1000",
    flowPackets: "10",
  });

  const ingressTotal = (bytes: string) =>
    row({ flowDirection: "ingress", azId: "use1-az1", flowBytes: bytes });

  // Regression: the pair query resolved the peer to a local interface and
  // called this cross-zone, while the totals query — which cannot see the
  // address, and had no `next-hop-az-id` to fall back on — called the same
  // bytes internet ingress. The residual only ever netted against `unknown`, so
  // the bytes stayed in both buckets: once as the pair, once again as a
  // spurious unattributed internet-ingress row.
  it("counts address-resolved local ingress once when the format has no next-hop or traffic-path", async () => {
    mockAws({
      logFormat: NO_HOP_FORMAT,
      pairRows: [localIngressPair],
      totalRows: [ingressTotal("1000")],
    });

    const result = await fetchAwsNetworkFlows(creds, DAY);

    expect(result.degraded).toBeUndefined();
    expect(result.flows).toHaveLength(1);
    expect(result.flows[0]).toMatchObject({
      scope: "cross_zone",
      direction: "ingress",
      bytes: 1000,
    });

    // The bytes moved into the bucket the pair is stored under, so the host's
    // `total − kept` lands on zero instead of leaving a second copy behind.
    expect(result.totals).toEqual([
      { date: DAY, scope: "cross_zone", direction: "ingress", bytes: 1000 },
    ]);
    expect(totalOf(result.totals!, "internet_ingress", "ingress")).toBeUndefined();
    // The day moved 1000 bytes. Anything above that is the same bytes twice.
    expect(sumBytes(result.totals!)).toBe(1000);
  });

  it("calls the un-itemized tail unknown when the format cannot place the peer", async () => {
    mockAws({
      logFormat: NO_HOP_FORMAT,
      pairRows: [localIngressPair],
      // 3000 bytes of ingress that day, only 1000 of it in the top pairs.
      totalRows: [ingressTotal("3000")],
    });

    const result = await fetchAwsNetworkFlows(creds, DAY);

    // The itemized pair keeps its resolved scope — it had an address.
    expect(totalOf(result.totals!, "cross_zone", "ingress")?.bytes).toBe(1000);
    // The remaining 2000 has no address and this format carries no
    // `next-hop-az-id`, and AWS never populates `traffic-path` on ingress — so
    // nothing distinguishes a local peer from the internet. Labelling it
    // internet ingress would be a guess dressed as a boundary crossing, and it
    // is the label a reader would act on. It stays unknown.
    expect(totalOf(result.totals!, "internet_ingress", "ingress")).toBeUndefined();
    expect(totalOf(result.totals!, "unknown", "ingress")?.bytes).toBe(2000);
    // Still every byte, once.
    expect(sumBytes(result.totals!)).toBe(3000);
  });

  // A provider whose totals come in under its own pairs is telling us
  // something; the shortfall reaches the host as a bucket smaller than what was
  // kept (which it records as a negative residual) rather than being papered
  // over with bytes invented in the fold.
  it("never moves more bytes than the totals actually reported", async () => {
    mockAws({
      logFormat: NO_HOP_FORMAT,
      pairRows: [localIngressPair],
      totalRows: [ingressTotal("400")],
    });

    const result = await fetchAwsNetworkFlows(creds, DAY);

    expect(result.totals).toEqual([
      { date: DAY, scope: "cross_zone", direction: "ingress", bytes: 400 },
    ]);
    expect(sumBytes(result.totals!)).toBe(400);
  });

  it("agrees without moving anything when the format carries next-hop-az-id", async () => {
    mockAws({
      logFormat:
        "${version} ${srcaddr} ${dstaddr} ${bytes} ${flow-direction} ${az-id} ${next-hop-az-id} ${log-status}",
      pairRows: [
        row({
          srcaddr: "10.0.2.5",
          dstaddr: "10.0.1.4",
          flowDirection: "ingress",
          azId: "use1-az1",
          nextHopAzId: "use1-az2",
          flowBytes: "1000",
        }),
      ],
      totalRows: [
        row({
          flowDirection: "ingress",
          azId: "use1-az1",
          nextHopAzId: "use1-az2",
          flowBytes: "2500",
        }),
      ],
    });

    const result = await fetchAwsNetworkFlows(creds, DAY);

    expect(result.flows[0]).toMatchObject({ scope: "cross_zone", direction: "ingress" });
    expect(result.totals).toEqual([
      { date: DAY, scope: "cross_zone", direction: "ingress", bytes: 2500 },
    ]);
  });

  // Egress with nothing to go on was already folded into `unknown` by both
  // views; the netting must still not double it.
  it("counts an unresolved egress peer once, under unknown", async () => {
    mockAws({
      logFormat: NO_HOP_FORMAT,
      pairRows: [
        row({
          srcaddr: "10.0.1.4",
          dstaddr: "203.0.113.7",
          flowDirection: "egress",
          azId: "use1-az1",
          flowBytes: "800",
        }),
      ],
      totalRows: [row({ flowDirection: "egress", azId: "use1-az1", flowBytes: "800" })],
    });

    const result = await fetchAwsNetworkFlows(creds, DAY);

    expect(result.flows[0]).toMatchObject({ scope: "unknown", direction: "egress", bytes: 800 });
    expect(result.totals).toEqual([
      { date: DAY, scope: "unknown", direction: "egress", bytes: 800 },
    ]);
    expect(sumBytes(result.totals!)).toBe(800);
  });
});
