/**
 * VPC Flow Log attribution for AWS.
 *
 * **Where the aggregation happens, and why it has to happen there.** A flow log
 * for a moderately busy VPC writes single-digit gigabytes a day. Pulling those
 * records out of CloudWatch and grouping them here would move the whole volume
 * across the internet every day to compute a few hundred numbers. So the
 * `GROUP BY` runs inside CloudWatch Logs Insights and only the grouped result
 * comes back — two queries per log group per day, a few hundred rows total.
 *
 * **This costs the customer money.** Logs Insights bills per GB of log data
 * scanned, against the account whose credentials we hold. That is why
 * `queriesBillable` is declared, why collection is off until an org turns it
 * on, and why the pass collects at most a few days per run.
 *
 * **What it can and cannot tell you.** Only flow logs delivering to CloudWatch
 * Logs are readable — S3 and Firehose destinations would need Athena (a new
 * dependency, a results bucket we would have to write to, and a partition
 * layout we do not control), so they are reported as sources we can see but not
 * query rather than silently skipped. And the record format decides everything:
 * a flow log in the default format is version 2, has no `flow-direction`, and
 * cannot be attributed at all. See `flow-log-format.ts`.
 */
import {
  DescribeFlowLogsCommand,
  DescribeNetworkInterfacesCommand,
  type FlowLog,
  type NetworkInterface,
} from "@aws-sdk/client-ec2";
import {
  GetQueryResultsCommand,
  StartQueryCommand,
  type ResultField,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  NetworkFlowSetupError,
  type NetworkFlowCapabilityDeclaration,
  type NetworkFlowEndpoint,
  type NetworkFlowFetchResult,
  type NetworkFlowRecord,
  type NetworkFlowScope,
  type NetworkFlowSource,
  type NetworkFlowTotal,
} from "@infrawrench/plugin-base";

import type { AwsCredentials } from "./auth.js";
import { getAwsClients } from "./aws-clients.js";
import {
  buildPairQuery,
  buildTotalsQuery,
  classifyScope,
  FLOW_FORMAT_HELP_URL,
  insightsAlias,
  missingRequiredFields,
  parseLogFormat,
  totalsAreExactFor,
  unusableReason,
  type FlowScope,
} from "./flow-log-format.js";

/**
 * AWS data-transfer list rates, US regions, per GB (10^9 bytes).
 *
 * Checked against https://aws.amazon.com/ec2/pricing/on-demand/ and
 * https://aws.amazon.com/vpc/pricing/ on the `asOf` date below. Every one of
 * these is a *list* rate with no free tier and no volume tier applied — see
 * `server-core/src/network-flow/pricing.ts` for why modelling either would be
 * worse than not modelling them.
 */
export const AWS_NETWORK_FLOW_RATES: NetworkFlowCapabilityDeclaration["rates"] = {
  currency: "USD",
  asOf: "2026-08-11",
  perGb: {
    // Same AZ over private addressing. Free, and the reason "move it into the
    // same zone" is the first recommendation anyone gives.
    intra_zone: 0,
    // $0.01/GB **in each direction**, which is why both directions are stored
    // and priced separately rather than deduplicated: AWS captures the flow at
    // both ENIs and charges both ends, so summing the egress record and the
    // ingress record at $0.01 each reproduces the real charge exactly.
    cross_zone: 0.01,
    // Inter-region transfer out of a US region.
    cross_region: 0.02,
    // First tier of internet egress. The 100 GB/month account-wide free
    // allowance is not deducted (it is consumed by services we cannot see) and
    // the step down above 10 TB is not applied, so large bills are over-stated.
    internet_egress: 0.09,
    // Inbound from the internet is free on every AWS region.
    internet_ingress: 0,
    // A first-party endpoint in-region over a gateway endpoint.
    provider_service: 0,
    // NAT gateway data processing, on top of the onward transfer charge.
    nat_gateway: 0.045,
    // Data out over a Site-to-Site VPN is billed at internet egress rates; the
    // hourly connection charge is a resource cost and is not a flow.
    private_interconnect: 0.09,
    // Deliberately unpriced. See `classifyScope` — this is the bucket for
    // traffic whose boundary the record did not determine, and putting a rate
    // on it would turn "we do not know" into money.
    unknown: 0,
  },
};

export const AWS_NETWORK_FLOW_CAPABILITY: NetworkFlowCapabilityDeclaration = {
  rates: AWS_NETWORK_FLOW_RATES,
  /**
   * Kept at or below the host's own storage cap (`DEFAULT_MAX_PAIRS`) so the
   * host never re-cuts what this returns. The `unknown` totals below are
   * emitted net of the local pairs returned here, and that arithmetic only
   * holds while every returned pair is stored.
   */
  maxPairsPerDay: 500,
  /** CloudWatch log groups commonly retain 7–30 days; asking beyond that scans nothing and still bills. */
  maxHistoryDays: 14,
  queriesBillable: true,
};

/** How long to wait for a Logs Insights query before giving up on the day. */
const QUERY_TIMEOUT_MS = 120_000;
const QUERY_POLL_MS = 2_000;

/** Only CloudWatch Logs destinations are readable — see the module header. */
const READABLE_DESTINATION = "cloud-watch-logs";

function rowValue(row: ResultField[], field: string): string | undefined {
  const value = row.find((f) => f.field === field)?.value;
  return value === undefined || value === "-" ? undefined : value;
}

/** One resolved endpoint in the account's network. */
interface LocalEndpoint {
  ref: string;
  label: string;
  zone: string;
  region: string;
  resourceTypeId: string;
  interfaceType: string;
}

/**
 * Address → endpoint for everything with a network interface in this region.
 *
 * One paginated `DescribeNetworkInterfaces` per account per pass. This is the
 * whole attribution mechanism and it is deliberately an *exact* lookup rather
 * than a heuristic: an address is either one of the account's interfaces or it
 * is not, and the second case is `unattributed` rather than a nearest match.
 *
 * Both private and public addresses are indexed, because a flow to an instance
 * over its public address is the same instance and reporting it as an
 * unattributed internet peer is how an internal misconfiguration hides.
 */
async function loadEndpointMap(creds: AwsCredentials): Promise<Map<string, LocalEndpoint>> {
  const map = new Map<string, LocalEndpoint>();
  const ec2 = getAwsClients(creds).ec2;
  let token: string | undefined;
  do {
    const page = await ec2.send(
      new DescribeNetworkInterfacesCommand({ MaxResults: 1000, NextToken: token }),
    );
    for (const eni of page.NetworkInterfaces ?? []) {
      const endpoint = toLocalEndpoint(eni, creds.region);
      for (const address of addressesOf(eni)) map.set(address, endpoint);
    }
    token = page.NextToken;
  } while (token);
  return map;
}

function addressesOf(eni: NetworkInterface): string[] {
  const out: string[] = [];
  for (const entry of eni.PrivateIpAddresses ?? []) {
    if (entry.PrivateIpAddress) out.push(entry.PrivateIpAddress);
    if (entry.Association?.PublicIp) out.push(entry.Association.PublicIp);
  }
  if (eni.PrivateIpAddress) out.push(eni.PrivateIpAddress);
  if (eni.Association?.PublicIp) out.push(eni.Association.PublicIp);
  return out;
}

/**
 * Name an interface as the thing a user recognizes.
 *
 * An attached instance wins over the interface itself: nobody reasons about
 * their egress bill in terms of `eni-0a1b…`. A requester-managed interface (a
 * NAT gateway, a load balancer, a VPC endpoint) has no instance, and its
 * `InterfaceType` is a better name than its id, so that is what it gets.
 */
function toLocalEndpoint(eni: NetworkInterface, region: string): LocalEndpoint {
  const instanceId = eni.Attachment?.InstanceId;
  const interfaceType = (eni.InterfaceType ?? "").toLowerCase();
  const zone = eni.AvailabilityZoneId ?? "";
  if (instanceId) {
    return {
      ref: instanceId,
      label: instanceId,
      zone,
      region,
      resourceTypeId: "ec2-instance",
      interfaceType,
    };
  }
  const id = eni.NetworkInterfaceId ?? "";
  return {
    ref: id,
    label: eni.Description ? `${interfaceType || "eni"}: ${eni.Description}` : id,
    zone,
    region,
    resourceTypeId: "",
    interfaceType,
  };
}

/**
 * An address that resolved to nothing in this account.
 *
 * Returns a *class token*, never the address. An address is unbounded
 * cardinality and churns — the same workload behind a new lease is a new row
 * every day — so the stored endpoint is the class and the honest label is that
 * we could not identify it.
 */
function unresolvedEndpoint(scope: FlowScope, service: string | undefined): NetworkFlowEndpoint {
  if (service) {
    return { ref: `aws:${service.toLowerCase()}`, label: service, service: service.toLowerCase() };
  }
  if (scope === "internet_egress" || scope === "internet_ingress") {
    return { ref: "internet", label: "Internet" };
  }
  return { ref: "infrawrench:unattributed", label: "Unidentified peer" };
}

function toEndpoint(local: LocalEndpoint): NetworkFlowEndpoint {
  return {
    ref: local.ref,
    label: local.label,
    ...(local.zone ? { zone: local.zone } : {}),
    ...(local.region ? { region: local.region } : {}),
    ...(local.resourceTypeId ? { resourceTypeId: local.resourceTypeId } : {}),
  };
}

/** Run a Logs Insights query over one UTC day and wait for it. */
async function runInsightsQuery(
  creds: AwsCredentials,
  logGroupName: string,
  queryString: string,
  day: string,
): Promise<{ rows: ResultField[][]; bytesScanned: number }> {
  const logs = getAwsClients(creds).cloudWatchLogs;
  const startMs = Date.parse(`${day}T00:00:00.000Z`);
  const endMs = Date.parse(`${day}T23:59:59.999Z`);
  const started = await logs.send(
    new StartQueryCommand({
      logGroupName,
      startTime: Math.floor(startMs / 1000),
      endTime: Math.floor(endMs / 1000),
      queryString,
    }),
  );
  const queryId = started.queryId;
  if (!queryId) throw new Error(`CloudWatch Logs Insights did not return a query id`);

  const deadline = Date.now() + QUERY_TIMEOUT_MS;
  for (;;) {
    const result = await logs.send(new GetQueryResultsCommand({ queryId }));
    const status = result.status ?? "Running";
    if (status === "Complete") {
      return {
        rows: result.results ?? [],
        bytesScanned: result.statistics?.bytesScanned ?? 0,
      };
    }
    if (status === "Failed" || status === "Cancelled" || status === "Timeout") {
      throw new Error(`CloudWatch Logs Insights query ${status.toLowerCase()} for ${logGroupName}`);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `CloudWatch Logs Insights query for ${logGroupName} did not finish within ` +
          `${QUERY_TIMEOUT_MS / 1000}s — the log group is too large for a single-day scan`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, QUERY_POLL_MS));
  }
}

/** A flow log we discovered, with everything needed to decide what to do with it. */
interface DiscoveredSource {
  source: NetworkFlowSource;
  logGroupName: string;
  fields: string[];
}

function discover(flowLogs: FlowLog[], region: string): DiscoveredSource[] {
  return flowLogs.map((log) => {
    const id = log.FlowLogId ?? "unknown";
    const destinationType = log.LogDestinationType ?? "cloud-watch-logs";
    const base = {
      id,
      target: log.ResourceId ?? "",
      region,
      destinationType,
    };
    if (destinationType !== READABLE_DESTINATION) {
      return {
        source: {
          ...base,
          usable: false,
          unusableReason:
            `Flow log ${id} delivers to ${destinationType}. Only CloudWatch Logs ` +
            `destinations can be queried in place; an S3 or Firehose destination would ` +
            `need an Athena workgroup and a results bucket we do not create. Add a ` +
            `second flow log with a CloudWatch Logs destination to attribute this ${base.target}.`,
          helpUrl: FLOW_FORMAT_HELP_URL,
        },
        logGroupName: "",
        fields: [],
      };
    }
    const fields = parseLogFormat(log.LogFormat);
    const missing = missingRequiredFields(fields);
    if (missing.length > 0) {
      return {
        source: {
          ...base,
          usable: false,
          unusableReason: unusableReason(id, missing),
          helpUrl: FLOW_FORMAT_HELP_URL,
        },
        logGroupName: log.LogGroupName ?? "",
        fields,
      };
    }
    if (!log.LogGroupName) {
      return {
        source: {
          ...base,
          usable: false,
          unusableReason: `Flow log ${id} reports no log group name.`,
        },
        logGroupName: "",
        fields,
      };
    }
    return { source: { ...base, usable: true }, logGroupName: log.LogGroupName, fields };
  });
}

interface PairRow {
  scope: FlowScope;
  /**
   * The bucket this pair's bytes were counted under by the *totals* query. Equal
   * to `scope` whenever the addresses told us nothing the totals query could not
   * work out for itself; see {@link totalsScopeOf} and {@link foldTotals}.
   */
  totalsScope: FlowScope;
  direction: "egress" | "ingress";
  source: NetworkFlowEndpoint;
  destination: NetworkFlowEndpoint;
  attribution: "resolved" | "unattributed";
  bytes: number;
  packets: number;
}

/** `flow-direction` on a grouped row. Both queries carry it — it is required. */
function directionOf(row: ResultField[]): "egress" | "ingress" {
  return rowValue(row, insightsAlias("flow-direction")) === "ingress" ? "ingress" : "egress";
}

/**
 * The bucket a grouped row's bytes land in **in the totals query**.
 *
 * Both queries group by the same non-address fields — the pair query just adds
 * `srcaddr`/`dstaddr` on top — so this runs unchanged over a row from either
 * one, and that is the entire point. The totals query exists so the truncated
 * tail can be an exact subtraction rather than an estimate, and that property
 * only survives while both queries agree about which bucket a given row's bytes
 * were counted in. Two classifiers kept in step by hand disagree the first time
 * a format omits a field: with no `next-hop-az-id` and no `traffic-path`, an
 * ingress row from an address-resolved peer is `cross_zone` to the pair query
 * and `internet_ingress` to this one, and the bytes then sit in two buckets at
 * once. So there is one classifier, called twice — once with the totals query's
 * strictly poorer view of the row (no addresses, so no resolved peer and none of
 * the ENI fallbacks), and once with everything.
 */
function totalsScopeOf(row: ResultField[], fields: string[]): FlowScope {
  const direction = directionOf(row);
  const peerServiceField = direction === "egress" ? "pkt-dst-aws-service" : "pkt-src-aws-service";
  const nextHopZone = rowValue(row, insightsAlias("next-hop-az-id"));
  const scope = classifyScope({
    direction,
    trafficPath: rowValue(row, insightsAlias("traffic-path")),
    peerService: rowValue(row, insightsAlias(peerServiceField)),
    interfaceType: rowValue(row, insightsAlias("interface-type")),
    localZone: rowValue(row, insightsAlias("az-id")),
    peerZone: nextHopZone,
    // The totals query has no addresses in it by design, so it cannot know
    // whether a peer is local. `next-hop-az-id`, when present, decides the
    // zone question without one.
    peerIsLocal: nextHopZone !== undefined,
  });
  // Boundaries this format cannot pin down without an address are counted as
  // `unknown` rather than split by a guess.
  return totalsAreExactFor(scope, fields) ? scope : "unknown";
}

/**
 * Turn one grouped Insights row into a classified pair.
 *
 * The local side is whichever end the direction says it is — that is the entire
 * purpose of requiring `flow-direction`. Without it, `srcaddr` on an ingress
 * record is the *peer*, and treating it as the local side attributes every
 * inbound byte to whoever sent it.
 */
function toPair(
  row: ResultField[],
  fields: string[],
  endpoints: Map<string, LocalEndpoint>,
): PairRow | null {
  const bytes = Number(rowValue(row, "flowBytes") ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const packets = Number(rowValue(row, "flowPackets") ?? 0);
  const direction = directionOf(row);
  const srcAddr = rowValue(row, insightsAlias("srcaddr")) ?? "";
  const dstAddr = rowValue(row, insightsAlias("dstaddr")) ?? "";

  const localAddr = direction === "egress" ? srcAddr : dstAddr;
  const peerAddr = direction === "egress" ? dstAddr : srcAddr;
  const local = endpoints.get(localAddr);
  const peer = endpoints.get(peerAddr);

  const peerServiceField = direction === "egress" ? "pkt-dst-aws-service" : "pkt-src-aws-service";
  const peerService = rowValue(row, insightsAlias(peerServiceField));
  const localZone = rowValue(row, insightsAlias("az-id")) ?? local?.zone;
  const nextHopZone = rowValue(row, insightsAlias("next-hop-az-id"));
  const interfaceType = rowValue(row, insightsAlias("interface-type")) ?? local?.interfaceType;

  const scope = classifyScope({
    direction,
    trafficPath: rowValue(row, insightsAlias("traffic-path")),
    peerService,
    interfaceType,
    localZone,
    peerZone: nextHopZone ?? peer?.zone,
    peerIsLocal: peer !== undefined,
  });

  const localEndpoint: NetworkFlowEndpoint = local
    ? toEndpoint(local)
    : {
        ref: "infrawrench:unattributed",
        label: "Unidentified local interface",
        ...(localZone ? { zone: localZone } : {}),
      };
  const peerEndpoint: NetworkFlowEndpoint = peer
    ? toEndpoint(peer)
    : unresolvedEndpoint(scope, peerService);

  // A pair is only `resolved` when *both* ends are something a user can act on.
  // A named AWS service counts as an end; an unidentified peer does not, and
  // neither does an unidentified local interface.
  const resolved =
    local !== undefined && (peer !== undefined || peerEndpoint.ref !== "infrawrench:unattributed");

  return {
    scope,
    totalsScope: totalsScopeOf(row, fields),
    direction,
    source: direction === "egress" ? localEndpoint : peerEndpoint,
    destination: direction === "egress" ? peerEndpoint : localEndpoint,
    attribution: resolved ? "resolved" : "unattributed",
    bytes,
    packets: Number.isFinite(packets) ? packets : 0,
  };
}

/**
 * Fold the totals query's rows into per-(scope, direction) byte totals, then
 * relabel them with what the pair query learned.
 *
 * The host's residual is `total − kept pairs`, per (scope, direction). So a
 * pair stored under one scope while its bytes sit in a different totals bucket
 * is counted twice: once as the pair, and once again inside that bucket's
 * residual row. The addresses the pair query has and this one does not are
 * precisely what makes the two disagree, so every pair whose two verdicts
 * differ has its bytes **moved** out of the bucket that counted them and into
 * the scope it was itemized under. After the move each bucket holds exactly the
 * bytes whose pairs are stored against it, and the subtraction is exact again.
 *
 * Moving, rather than only subtracting: subtracting alone leaves the bucket the
 * pair *is* stored under short of the pair's own bytes, which turns the tail for
 * that boundary into a spurious negative and loses it.
 */
function foldTotals(
  rows: ResultField[][],
  fields: string[],
  day: string,
  pairs: PairRow[],
): NetworkFlowTotal[] {
  const totals = new Map<string, NetworkFlowTotal>();
  const keyOf = (scope: NetworkFlowScope, direction: "egress" | "ingress") =>
    `${scope} ${direction}`;
  const add = (scope: NetworkFlowScope, direction: "egress" | "ingress", bytes: number) => {
    const entry = totals.get(keyOf(scope, direction));
    if (entry) entry.bytes += bytes;
    else totals.set(keyOf(scope, direction), { date: day, scope, direction, bytes });
  };

  for (const row of rows) {
    const bytes = Number(rowValue(row, "flowBytes") ?? 0);
    if (!Number.isFinite(bytes) || bytes <= 0) continue;
    add(totalsScopeOf(row, fields), directionOf(row), bytes);
  }

  for (const pair of pairs) {
    // Agreed: the host subtracts this one against the matching bucket itself.
    if (pair.totalsScope === pair.scope) continue;
    const from = totals.get(keyOf(pair.totalsScope, pair.direction));
    if (!from) continue;
    // Never move more than the bucket actually holds. A provider whose totals
    // come in under its own pairs leaves the destination short of what was
    // kept, which the host reports as a negative residual — the right place for
    // it — rather than being papered over with bytes invented here.
    const moved = Math.min(pair.bytes, from.bytes);
    if (moved <= 0) continue;
    from.bytes -= moved;
    add(pair.scope, pair.direction, moved);
  }

  return [...totals.values()].filter((t) => t.bytes > 0);
}

/**
 * Read one closed UTC day of flows for an account.
 *
 * Throws {@link NetworkFlowSetupError} when nothing on the account can be read,
 * so the host backs off for half a day and shows the reason with its fix rather
 * than retrying an unanswerable question hourly at the customer's expense.
 */
export async function fetchAwsNetworkFlows(
  creds: AwsCredentials,
  day: string,
  maxPairs: number = AWS_NETWORK_FLOW_CAPABILITY.maxPairsPerDay,
): Promise<NetworkFlowFetchResult> {
  const ec2 = getAwsClients(creds).ec2;
  const described = await ec2.send(new DescribeFlowLogsCommand({ MaxResults: 100 }));
  const discovered = discover(described.FlowLogs ?? [], creds.region);
  const sources = discovered.map((d) => d.source);
  const usable = discovered.filter((d) => d.source.usable);

  if (discovered.length === 0) {
    throw new NetworkFlowSetupError(
      `No VPC flow logs are configured in ${creds.region}. Create one on the VPC with a ` +
        `custom record format and a CloudWatch Logs destination, then flows will appear here ` +
        `within a day.`,
      FLOW_FORMAT_HELP_URL,
    );
  }
  if (usable.length === 0) {
    throw new NetworkFlowSetupError(
      discovered[0]!.source.unusableReason ?? `No readable VPC flow log in ${creds.region}.`,
      FLOW_FORMAT_HELP_URL,
    );
  }

  // Interfaces are read once for the whole pass, not per log group: the map is
  // account-wide and the call is the same regardless of how many VPCs log.
  const endpoints = await loadEndpointMap(creds);

  const flows: NetworkFlowRecord[] = [];
  const totals: NetworkFlowTotal[] = [];
  let bytesScanned = 0;
  let degraded = false;

  for (const entry of usable) {
    try {
      const pairResult = await runInsightsQuery(
        creds,
        entry.logGroupName,
        buildPairQuery(entry.fields, maxPairs),
        day,
      );
      bytesScanned += pairResult.bytesScanned;
      const pairs = pairResult.rows
        .map((row) => toPair(row, entry.fields, endpoints))
        .filter((p): p is PairRow => p !== null);

      for (const pair of pairs) {
        flows.push({
          date: day,
          source: pair.source,
          destination: pair.destination,
          scope: pair.scope,
          direction: pair.direction,
          attribution: pair.attribution,
          bytes: pair.bytes,
          packets: pair.packets,
        });
      }

      const totalsResult = await runInsightsQuery(
        creds,
        entry.logGroupName,
        buildTotalsQuery(entry.fields),
        day,
      );
      bytesScanned += totalsResult.bytesScanned;
      totals.push(...foldTotals(totalsResult.rows, entry.fields, day, pairs));
    } catch (e) {
      // One log group failing is not the day failing. The pass is marked
      // degraded so the surface does not present a partial day as a quiet one,
      // and the other groups still report.
      degraded = true;
      console.error(
        `[aws] flow log ${entry.source.id} failed for ${day}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  if (degraded && flows.length === 0 && totals.length === 0) {
    throw new Error(`Every readable flow log failed for ${day} in ${creds.region}`);
  }

  return {
    sources,
    flows,
    totals,
    queryBytesScanned: bytesScanned,
    ...(degraded ? { degraded: true } : {}),
  };
}
