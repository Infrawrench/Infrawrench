import { describe, expect, it } from "vitest";

import {
  buildPairQuery,
  buildTotalsQuery,
  classifyScope,
  DEFAULT_FORMAT_FIELDS,
  insightsAlias,
  missingRequiredFields,
  parseLogFormat,
  totalsAreExactFor,
} from "../flow-log-format.js";

const CUSTOM =
  "${version} ${account-id} ${interface-id} ${srcaddr} ${dstaddr} ${bytes} ${packets} " +
  "${az-id} ${flow-direction} ${traffic-path} ${pkt-dst-aws-service} ${interface-type} ${log-status}";

describe("parseLogFormat", () => {
  it("reads the field names out of a custom format template", () => {
    expect(parseLogFormat(CUSTOM)).toEqual([
      "version",
      "account-id",
      "interface-id",
      "srcaddr",
      "dstaddr",
      "bytes",
      "packets",
      "az-id",
      "flow-direction",
      "traffic-path",
      "pkt-dst-aws-service",
      "interface-type",
      "log-status",
    ]);
  });

  it("reports an empty or absent format as the version-2 default", () => {
    // DescribeFlowLogs returns "" for a flow log created without a custom
    // format. Reporting it as the default (rather than as "unknown") is what
    // lets the caller name the exact fields that are missing.
    expect(parseLogFormat("")).toEqual([...DEFAULT_FORMAT_FIELDS]);
    expect(parseLogFormat(undefined)).toEqual([...DEFAULT_FORMAT_FIELDS]);
  });
});

describe("missingRequiredFields", () => {
  it("rejects the default format because it has no direction field", () => {
    // `flow-direction` arrived in version 5; the default format is version 2.
    // Without it the local end of a record is unknowable and every inbound byte
    // would be attributed to whoever sent it.
    expect(missingRequiredFields([...DEFAULT_FORMAT_FIELDS])).toEqual(["flow-direction"]);
  });

  it("accepts a custom format carrying the four required fields", () => {
    expect(missingRequiredFields(parseLogFormat(CUSTOM))).toEqual([]);
  });
});

describe("insightsAlias", () => {
  it("camel-cases hyphenated field names, which Insights cannot parse", () => {
    expect(insightsAlias("flow-direction")).toBe("flowDirection");
    expect(insightsAlias("pkt-dst-aws-service")).toBe("pktDstAwsService");
    expect(insightsAlias("bytes")).toBe("bytes");
  });
});

describe("buildPairQuery", () => {
  it("emits one wildcard per field, in record order", () => {
    // The glob is positional: a missing wildcard shifts every field after it by
    // one and produces a query that runs, returns numbers, and is wrong.
    const query = buildPairQuery(parseLogFormat(CUSTOM), 500);
    const pattern = /parse @message "([^"]+)"/.exec(query)![1]!;
    expect(pattern.split(" ")).toHaveLength(13);
  });

  it("aggregates and truncates inside CloudWatch, not here", () => {
    const query = buildPairQuery(parseLogFormat(CUSTOM), 250);
    expect(query).toContain("stats sum(bytes) as flowBytes");
    expect(query).toContain("sort flowBytes desc");
    expect(query).toContain("limit 250");
  });

  it("filters out rejected and non-OK records", () => {
    const query = buildPairQuery(parseLogFormat(CUSTOM), 10);
    // A REJECTed packet never crossed a billing boundary.
    expect(query).toContain('filter logStatus = "OK"');
  });

  it("only groups by fields the format actually carries", () => {
    const minimal = ["srcaddr", "dstaddr", "bytes", "flow-direction"];
    const query = buildPairQuery(minimal, 10);
    expect(query).toContain("by srcaddr, dstaddr, flowDirection");
    expect(query).not.toContain("azId");
    expect(query).not.toContain("trafficPath");
  });
});

describe("buildTotalsQuery", () => {
  it("leaves the addresses out, so the group count is bounded", () => {
    const query = buildTotalsQuery(parseLogFormat(CUSTOM));
    expect(query).toContain("stats sum(bytes) as flowBytes by flowDirection");
    expect(query).not.toMatch(/by [^|]*srcaddr/);
    expect(query).not.toMatch(/by [^|]*dstaddr/);
  });
});

describe("classifyScope", () => {
  const base = { direction: "egress" as const, peerIsLocal: false };

  it("classifies a NAT interface before anything else can reclassify it", () => {
    // NAT charges for processing regardless of destination, and the onward hop
    // is billed separately — at a different rate.
    expect(
      classifyScope({
        ...base,
        interfaceType: "nat_gateway",
        trafficPath: "8",
      }),
    ).toBe("nat_gateway");
    expect(classifyScope({ ...base, interfaceType: "regional_nat_gateway" })).toBe("nat_gateway");
  });

  it("reads AWS's own traffic-path over anything inferred", () => {
    expect(classifyScope({ ...base, trafficPath: "5" })).toBe("cross_region");
    expect(classifyScope({ ...base, trafficPath: "3" })).toBe("private_interconnect");
    expect(classifyScope({ ...base, trafficPath: "7" })).toBe("provider_service");
    expect(classifyScope({ ...base, trafficPath: "8" })).toBe("internet_egress");
  });

  it("prices intra-region peering as cross-zone, which is the same money", () => {
    expect(classifyScope({ ...base, trafficPath: "4" })).toBe("cross_zone");
  });

  it("distinguishes a gateway endpoint from internet egress on path 2", () => {
    // Path 2 covers both an internet gateway and a gateway VPC endpoint. The
    // same bytes are free over one and $0.09/GB over the other.
    expect(classifyScope({ ...base, trafficPath: "2" })).toBe("internet_egress");
    expect(classifyScope({ ...base, trafficPath: "2", peerService: "S3" })).toBe(
      "provider_service",
    );
  });

  it("compares zones only when both are known and the peer is ours", () => {
    expect(
      classifyScope({
        ...base,
        peerIsLocal: true,
        localZone: "use1-az1",
        peerZone: "use1-az1",
      }),
    ).toBe("intra_zone");
    expect(
      classifyScope({
        ...base,
        peerIsLocal: true,
        localZone: "use1-az1",
        peerZone: "use1-az4",
      }),
    ).toBe("cross_zone");
  });

  it("returns unknown rather than guessing when the zones are not both known", () => {
    // A guess here is an invisible error; `unknown` prices at zero and is
    // labelled unclassified on the screen.
    expect(classifyScope({ ...base, peerIsLocal: true, localZone: "use1-az1" })).toBe("unknown");
    expect(classifyScope({ ...base, peerIsLocal: true, peerZone: "use1-az1" })).toBe("unknown");
  });

  it("treats an unrouted inbound flow from a foreign peer as internet ingress", () => {
    expect(classifyScope({ direction: "ingress", peerIsLocal: false })).toBe("internet_ingress");
  });

  it("treats a '-' service as no service at all", () => {
    // AWS writes '-' for a field it could not compute; reading it as a service
    // name would classify ordinary internet egress as free.
    expect(classifyScope({ ...base, trafficPath: "2", peerService: "-" })).toBe("internet_egress");
  });
});

describe("totalsAreExactFor", () => {
  it("cannot split the zone boundaries without next-hop-az-id", () => {
    // The totals query has no addresses in it by design, so intra- vs
    // cross-zone is undecidable there unless the record itself names the
    // peer's zone. Those bytes go to `unknown` rather than being guessed.
    const fields = parseLogFormat(CUSTOM);
    expect(totalsAreExactFor("cross_zone", fields)).toBe(false);
    expect(totalsAreExactFor("intra_zone", fields)).toBe(false);
    expect(totalsAreExactFor("internet_egress", fields)).toBe(true);
    expect(totalsAreExactFor("nat_gateway", fields)).toBe(true);
  });

  it("will not call inbound traffic internet-bound without the peer's zone", () => {
    // `traffic-path` is never populated for ingress, so on an inbound record
    // the peer's zone is the only thing separating a local peer from the
    // internet. Absent it, "no next hop" is a guess, not a verdict — and the
    // un-itemized tail must not be labelled internet ingress on that basis.
    const fields = parseLogFormat(CUSTOM);
    expect(totalsAreExactFor("internet_ingress", fields)).toBe(false);
    expect(totalsAreExactFor("internet_ingress", [...fields, "next-hop-az-id"])).toBe(true);
    // Egress is unaffected: `traffic-path` does carry a verdict there.
    expect(totalsAreExactFor("internet_egress", fields)).toBe(true);
  });

  it("can split them when the format carries next-hop-az-id", () => {
    expect(totalsAreExactFor("cross_zone", [...parseLogFormat(CUSTOM), "next-hop-az-id"])).toBe(
      true,
    );
  });
});
