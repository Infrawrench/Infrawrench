/**
 * Metric-based idle findings for AWS (`manifest.idleFindings`).
 *
 * One CloudWatch `GetMetricData` batch per region reads every metric the
 * enabled rules need over the lookback window at a one-day period (a day is a
 * multiple of 3600, which keeps the request valid however old the window's
 * start is), then each rule's pure judge decides from the daily values.
 *
 * Metric names, statistics and dimensions are from the service guides
 * (verified 2026-10):
 * - NAT gateway: https://docs.aws.amazon.com/vpc/latest/userguide/metrics-dimensions-nat-gateway.html
 *   (`NatGatewayId`; regional NAT gateways add `AvailabilityZone`, so they are
 *   read through a SEARCH summed over zones).
 * - ALB: https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-cloudwatch-metrics.html
 *   (`LoadBalancer` = `app/name/id`; request and byte counts are published only
 *   when non-zero, `ConsumedLCUs` always, `HealthyHostCount` per target group).
 * - NLB: https://docs.aws.amazon.com/elasticloadbalancing/latest/network/load-balancer-cloudwatch-metrics.html
 *   (`net/name/id`; `NewFlowCount`, `ProcessedBytes` always reported).
 * - Classic: https://docs.aws.amazon.com/elasticloadbalancing/latest/classic/elb-cloudwatch-metrics.html
 *   (`LoadBalancerName`; `RequestCount` only when non-zero, `HealthyHostCount`
 *   only while instances are registered).
 * - ElastiCache: https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/CacheMetrics.Redis.html
 *   (per node, `CacheClusterId` + `CacheNodeId`; `CurrConnections` includes the
 *   4 to 6 connections ElastiCache itself uses to monitor the node).
 * - DynamoDB: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/metrics-dimensions.html
 *   (`TableName` is the name, not the ARN; consumed units are a Sum per
 *   period, provisioned units an Average).
 * - RDS: `AWS/RDS` `DatabaseConnections` by `DBInstanceIdentifier`.
 *
 * The honesty rules from plugin-base's `idle-findings.ts` apply: a metric AWS
 * always publishes must cover the window before anything is judged on it
 * (absence there means the read was wrong or the resource is new, not that it
 * is idle), and only metrics AWS documents as "published when non-zero" read
 * an absence as zero.
 */
import {
  IdleFindingAccessError,
  type IdleFindingRecord,
  type IdleFindingsCapabilityDeclaration,
  type IdleMetricEvidence,
  type IdleScanRequest,
  type IdleScanResource,
} from "@infrawrench/plugin-base";

import type { AwsCredentials } from "./auth.js";
import { queryPostCall } from "./client-transport.js";
import {
  fetchDynamoDbRates,
  fetchElastiCacheNodeHourlyUsd,
  fetchLoadBalancerHourlyUsd,
  fetchNatGatewayHourlyUsd,
  fetchRdsMonthlyPrice,
  HOURS_PER_MONTH,
} from "./pricing.js";
import { ensureArray } from "./xml.js";

const DAY_SECONDS = 86_400;
const MB = 1_000_000;

export const AWS_IDLE_FINDINGS: IdleFindingsCapabilityDeclaration = {
  rules: [
    {
      id: "nat-gateway",
      label: "Idle NAT gateway",
      description:
        "No connections and next to no bytes sent to the internet over the lookback window. A NAT gateway bills by the hour whether or not anything routes through it.",
      resourceTypeIds: ["nat-gateway"],
      action: "remove",
      thresholds: [
        {
          key: "maxBytesOut",
          label: "Bytes sent to destinations",
          description: "Total BytesOutToDestination over the window at or under which it is idle.",
          unit: "bytes",
          default: 1 * MB,
          min: 0,
          max: 10_000 * MB,
        },
        {
          key: "maxActiveConnections",
          label: "Peak active connections",
          description:
            "Highest ActiveConnectionCount over the window at or under which it is idle.",
          unit: "count",
          default: 0,
          min: 0,
          max: 1000,
        },
      ],
    },
    {
      id: "load-balancer",
      label: "Idle load balancer",
      description:
        "An Application or Network Load Balancer that served next to no requests (or new flows) and bytes over the lookback window, or had no healthy target the whole time.",
      resourceTypeIds: ["alb"],
      action: "remove",
      thresholds: [
        {
          key: "maxRequests",
          label: "Requests or new flows",
          description:
            "Total RequestCount (Application) or NewFlowCount (Network) over the window at or under which it is idle.",
          unit: "count",
          default: 100,
          min: 0,
          max: 1_000_000,
        },
        {
          key: "maxProcessedBytes",
          label: "Processed bytes",
          unit: "bytes",
          default: 10 * MB,
          min: 0,
          max: 100_000 * MB,
        },
      ],
    },
    {
      id: "classic-load-balancer",
      label: "Idle Classic Load Balancer",
      description:
        "A Classic Load Balancer that served next to no requests over the lookback window, or had no healthy registered instance the whole time.",
      resourceTypeIds: ["classic-elb"],
      action: "remove",
      thresholds: [
        {
          key: "maxRequests",
          label: "Requests",
          unit: "count",
          default: 100,
          min: 0,
          max: 1_000_000,
        },
      ],
    },
    {
      id: "elasticache-cluster",
      label: "Idle ElastiCache cluster",
      description:
        "No client connections beyond ElastiCache's own monitoring and next to no reads or writes over the lookback window.",
      resourceTypeIds: ["elasticache-cluster"],
      action: "remove",
      thresholds: [
        {
          key: "maxConnections",
          label: "Peak connections per node",
          description:
            "Highest CurrConnections on any node. ElastiCache itself holds 4 to 6 connections to monitor a node, so 0 would never match.",
          unit: "count",
          default: 6,
          min: 0,
          max: 1000,
        },
        {
          key: "maxCommands",
          label: "Read and write commands",
          description:
            "Total GetTypeCmds + SetTypeCmds (Valkey, Redis OSS) or CmdGet + CmdSet (Memcached) across nodes.",
          unit: "count",
          default: 100,
          min: 0,
          max: 10_000_000,
        },
      ],
    },
    {
      id: "dynamodb-provisioned",
      label: "Over-provisioned DynamoDB table",
      description:
        "A provisioned-capacity table that consumed only a small share of its read and write capacity over the lookback window. Switching it to on-demand (or lowering capacity) bills for what it uses.",
      resourceTypeIds: ["dynamodb-table"],
      action: "reconfigure",
      thresholds: [
        {
          key: "maxUtilization",
          label: "Capacity used",
          description:
            "Consumed units as a share of provisioned units, for reads and writes alike, at or under which it is flagged.",
          unit: "percent",
          default: 5,
          min: 0,
          max: 50,
        },
      ],
    },
    {
      id: "rds-instance",
      label: "Idle RDS instance",
      description:
        "A running database instance with no connections over the lookback window. Stopping it keeps the data and stops the instance hours.",
      resourceTypeIds: ["rds-instance"],
      action: "stop",
      thresholds: [
        {
          key: "maxConnections",
          label: "Peak connections",
          unit: "count",
          default: 0,
          min: 0,
          max: 100,
        },
      ],
    },
  ],
};

/* --------------------------------------------------------------------------
 * CloudWatch GetMetricData
 * ------------------------------------------------------------------------ */

type Dimension = { Name: string; Value: string };

/** One query: a plain metric, or an expression (a SEARCH aggregated to one series). */
export type MetricQuery =
  | {
      id: string;
      namespace: string;
      metric: string;
      dimensions: Dimension[];
      stat: "Sum" | "Maximum" | "Average" | "Minimum";
    }
  | { id: string; expression: string };

/** Daily values per query id, oldest first; an empty array is "no data". */
export type MetricResults = Map<string, number[]>;

/** Seam for tests: run a batch of queries over a window. */
export type MetricReader = (
  creds: AwsCredentials,
  queries: MetricQuery[],
  window: { start: Date; end: Date },
) => Promise<MetricResults>;

/**
 * Quote a value for an exact match in a CloudWatch SEARCH expression: `"`,
 * `\`, `(` and `)` are backslash-escaped (search-expression-syntax.html), and
 * a single quote, which would end the expression string, cannot appear in any
 * dimension value searched on here and is dropped.
 */
function searchValue(value: string): string {
  return `"${value.replace(/'/g, "").replace(/(["\\()])/g, "\\$1")}"`;
}

/**
 * `AGG(SEARCH('…', 'Stat', 86400))`: every series matching the property
 * filters, reduced to one. Used where a resource's metrics are split across
 * dimension sets we cannot enumerate from stored fields (per node, per zone,
 * per target group).
 */
export function searchExpression(
  aggregate: "SUM" | "MAX",
  schema: string,
  filters: Record<string, string>,
  stat: "Sum" | "Maximum" | "Average",
): string {
  const terms = Object.entries(filters)
    .map(([k, v]) => `${k}=${searchValue(v)}`)
    .join(" ");
  return `${aggregate}(SEARCH('${schema} ${terms}', '${stat}', ${DAY_SECONDS}))`;
}

const MAX_QUERIES_PER_CALL = 500;

/** The real reader: `GetMetricData` over the Query protocol, batched and paged. */
export const getMetricData: MetricReader = async (creds, queries, window) => {
  const out: MetricResults = new Map(queries.map((q) => [q.id, [] as number[]]));
  for (let i = 0; i < queries.length; i += MAX_QUERIES_PER_CALL) {
    const batch = queries.slice(i, i + MAX_QUERIES_PER_CALL);
    let nextToken: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const params: Record<string, string> = {
        StartTime: window.start.toISOString(),
        EndTime: window.end.toISOString(),
        ScanBy: "TimestampAscending",
        ...(nextToken ? { NextToken: nextToken } : {}),
      };
      batch.forEach((q, n) => {
        const p = `MetricDataQueries.member.${n + 1}`;
        params[`${p}.Id`] = q.id;
        if ("expression" in q) {
          params[`${p}.Expression`] = q.expression;
          params[`${p}.Period`] = String(DAY_SECONDS);
        } else {
          params[`${p}.MetricStat.Metric.Namespace`] = q.namespace;
          params[`${p}.MetricStat.Metric.MetricName`] = q.metric;
          q.dimensions.forEach((d, j) => {
            params[`${p}.MetricStat.Metric.Dimensions.member.${j + 1}.Name`] = d.Name;
            params[`${p}.MetricStat.Metric.Dimensions.member.${j + 1}.Value`] = d.Value;
          });
          params[`${p}.MetricStat.Period`] = String(DAY_SECONDS);
          params[`${p}.MetricStat.Stat`] = q.stat;
        }
        params[`${p}.ReturnData`] = "true";
      });
      const raw = await queryPostCall<Record<string, unknown>>(
        creds,
        "monitoring",
        "GetMetricData",
        "2010-08-01",
        params,
      );
      const error = raw["Error"] as Record<string, unknown> | undefined;
      if (error) {
        const code = String(error["Code"] ?? "");
        const message = String(error["Message"] ?? code);
        if (/AccessDenied|UnauthorizedOperation|NotAuthorized/i.test(code)) {
          throw new IdleFindingAccessError(
            `CloudWatch denied GetMetricData in ${creds.region}: ${message}. Add cloudwatch:GetMetricData to the credential's policy.`,
            {
              label: "CloudWatch permissions",
              url: "https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_GetMetricData.html",
            },
          );
        }
        throw new Error(`CloudWatch GetMetricData failed in ${creds.region}: ${message}`);
      }
      const result = (raw["GetMetricDataResult"] ?? raw) as Record<string, unknown>;
      const members = ensureArray(
        (result["MetricDataResults"] as Record<string, unknown> | undefined)?.["member"],
      ) as Record<string, unknown>[];
      for (const m of members) {
        const id = String(m["Id"] ?? "");
        const values = ensureArray((m["Values"] as Record<string, unknown> | undefined)?.["member"])
          .map((v) => Number(v))
          .filter((v) => Number.isFinite(v));
        out.get(id)?.push(...values);
      }
      nextToken = String(result["NextToken"] ?? "") || undefined;
      if (!nextToken) break;
    }
  }
  return out;
};

/* --------------------------------------------------------------------------
 * Pure helpers
 * ------------------------------------------------------------------------ */

const sum = (v: number[]): number | null => (v.length === 0 ? null : v.reduce((a, b) => a + b, 0));
const max = (v: number[]): number | null => (v.length === 0 ? null : Math.max(...v));
const mean = (v: number[]): number | null => (v.length === 0 ? null : (sum(v) ?? 0) / v.length);

/** Daily points needed before an always-published metric is trusted: the window less two days. */
export function requiredCoverage(lookbackDays: number): number {
  return Math.max(1, lookbackDays - 2);
}

/** False when the stored creation time says the resource is younger than the window. */
export function oldEnough(fields: IdleScanResource["fields"], windowStart: Date): boolean {
  const raw = fields["createdTime"];
  if (typeof raw !== "string" || raw === "") return true; // unknown: coverage decides
  const t = Date.parse(raw);
  return !Number.isFinite(t) || t <= windowStart.getTime();
}

function evidence(
  metric: string,
  label: string,
  statistic: IdleMetricEvidence["statistic"],
  value: number | null,
  unit: IdleMetricEvidence["unit"],
  threshold?: number,
): IdleMetricEvidence {
  return {
    metric,
    label,
    statistic,
    value,
    unit,
    ...(threshold !== undefined ? { threshold, comparison: "atMost" as const } : {}),
  };
}

function fmtBytes(n: number): string {
  if (n < 1000) return `${Math.round(n)} B`;
  if (n < MB) return `${(n / 1000).toFixed(1)} KB`;
  if (n < 1000 * MB) return `${(n / MB).toFixed(1)} MB`;
  return `${(n / (1000 * MB)).toFixed(1)} GB`;
}

function fmtCount(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** The `app/name/id` (or `net/…`) slice of an ELBv2 ARN, the dimension value. */
export function elbv2Dimension(arn: string): string {
  const slice = arn.split(":loadbalancer/").pop() ?? "";
  return slice.startsWith("app/") || slice.startsWith("net/") ? slice : "";
}

/* --------------------------------------------------------------------------
 * Per-rule plans: which queries a resource needs, and the verdict from them
 * ------------------------------------------------------------------------ */

interface Verdict {
  reason: string;
  evidence: IdleMetricEvidence[];
}

/** What one resource needs read, and how to judge the result. */
export interface ResourcePlan {
  ruleId: string;
  resource: IdleScanResource;
  queries: MetricQuery[];
  judge(results: MetricResults): Verdict | null;
}

let queryCounter = 0;
function qid(): string {
  queryCounter += 1;
  return `q${queryCounter}`;
}

/** Reset the id counter (tests assert on generated ids). */
export function resetQueryIds(): void {
  queryCounter = 0;
}

export function planNatGateway(
  resource: IdleScanResource,
  thresholds: Record<string, number>,
  lookbackDays: number,
): ResourcePlan | null {
  const f = resource.fields;
  const id = String(f["natGatewayId"] ?? resource.externalId ?? "");
  if (!id || String(f["state"] ?? "available") !== "available") return null;
  const regional = String(f["availabilityMode"] ?? "zonal") === "regional";
  // Zonal gateways publish on {NatGatewayId}; regional ones per zone on
  // {AvailabilityZone, NatGatewayId}, summed (or maxed) back to one series.
  const metric = (name: string, stat: "Sum" | "Maximum"): MetricQuery =>
    regional
      ? {
          id: qid(),
          expression: searchExpression(
            stat === "Sum" ? "SUM" : "MAX",
            "{AWS/NATGateway,AvailabilityZone,NatGatewayId}",
            { NatGatewayId: id, MetricName: name },
            stat,
          ),
        }
      : {
          id: qid(),
          namespace: "AWS/NATGateway",
          metric: name,
          dimensions: [{ Name: "NatGatewayId", Value: id }],
          stat,
        };
  const bytesOut = metric("BytesOutToDestination", "Sum");
  const conns = metric("ActiveConnectionCount", "Maximum");
  const bytesIn = metric("BytesInFromSource", "Sum");
  const maxBytes = thresholds["maxBytesOut"] ?? 1 * MB;
  const maxConns = thresholds["maxActiveConnections"] ?? 0;
  return {
    ruleId: "nat-gateway",
    resource,
    queries: [bytesOut, conns, bytesIn],
    judge(results) {
      const outDays = results.get(bytesOut.id) ?? [];
      const connDays = results.get(conns.id) ?? [];
      // NAT gateway metrics are published every minute, zeros included; a
      // window without them is a read we cannot trust.
      if (outDays.length < requiredCoverage(lookbackDays)) return null;
      const out = sum(outDays);
      const peak = max(connDays);
      if (out === null || out > maxBytes) return null;
      if (peak !== null && peak > maxConns) return null;
      return {
        reason:
          `Sent ${fmtBytes(out)} to the internet` +
          (peak !== null ? ` with at most ${fmtCount(peak)} active connections` : "") +
          ` over ${lookbackDays} days`,
        evidence: [
          evidence(
            "BytesOutToDestination",
            "Bytes sent to destinations",
            "sum",
            out,
            "bytes",
            maxBytes,
          ),
          evidence(
            "ActiveConnectionCount",
            "Peak active connections",
            "max",
            peak,
            "count",
            maxConns,
          ),
          evidence(
            "BytesInFromSource",
            "Bytes received from the VPC",
            "sum",
            sum(results.get(bytesIn.id) ?? []),
            "bytes",
          ),
        ],
      };
    },
  };
}

export function planElbv2(
  resource: IdleScanResource,
  thresholds: Record<string, number>,
  lookbackDays: number,
): ResourcePlan | null {
  const f = resource.fields;
  const type = String(f["type"] ?? "application");
  if (type !== "application" && type !== "network") return null; // gateway: out of scope
  if (String(f["state"] ?? "active") !== "active") return null;
  const dim = elbv2Dimension(resource.resolvedOutputs["loadBalancerArn"] ?? "");
  if (!dim) return null;
  const ns = type === "network" ? "AWS/NetworkELB" : "AWS/ApplicationELB";
  const dims = [{ Name: "LoadBalancer", Value: dim }];
  const trafficName = type === "network" ? "NewFlowCount" : "RequestCount";
  const traffic: MetricQuery = {
    id: qid(),
    namespace: ns,
    metric: trafficName,
    dimensions: dims,
    stat: "Sum",
  };
  const bytes: MetricQuery = {
    id: qid(),
    namespace: ns,
    metric: "ProcessedBytes",
    dimensions: dims,
    stat: "Sum",
  };
  // Always reported for both kinds: proves the read reached the balancer.
  const lcus: MetricQuery = {
    id: qid(),
    namespace: ns,
    metric: "ConsumedLCUs",
    dimensions: dims,
    stat: "Sum",
  };
  const healthy: MetricQuery = {
    id: qid(),
    expression: searchExpression(
      "MAX",
      `{${ns},LoadBalancer,TargetGroup}`,
      { LoadBalancer: dim, MetricName: "HealthyHostCount" },
      "Maximum",
    ),
  };
  const maxRequests = thresholds["maxRequests"] ?? 100;
  const maxBytes = thresholds["maxProcessedBytes"] ?? 10 * MB;
  return {
    ruleId: "load-balancer",
    resource,
    queries: [traffic, bytes, lcus, healthy],
    judge(results) {
      const lcuDays = results.get(lcus.id) ?? [];
      if (lcuDays.length < requiredCoverage(lookbackDays)) return null;
      const trafficDays = results.get(traffic.id) ?? [];
      // ALB request and byte counts are only published when non-zero, so an
      // absent day is a zero once ConsumedLCUs proved the balancer is read.
      const requests = sum(trafficDays) ?? 0;
      const processed = sum(results.get(bytes.id) ?? []) ?? 0;
      const healthyDays = results.get(healthy.id) ?? [];
      const healthyPeak = max(healthyDays);
      const noHealthyTargets =
        healthyDays.length >= requiredCoverage(lookbackDays) && healthyPeak === 0;
      const quiet = requests <= maxRequests && processed <= maxBytes;
      if (!quiet && !noHealthyTargets) return null;
      const noun = type === "network" ? "new flows" : "requests";
      return {
        reason: noHealthyTargets
          ? `No healthy target in ${lookbackDays} days (${fmtCount(requests)} ${noun})`
          : `${fmtCount(requests)} ${noun} and ${fmtBytes(processed)} processed over ${lookbackDays} days`,
        evidence: [
          evidence(
            trafficName,
            type === "network" ? "New flows" : "Requests",
            "sum",
            requests,
            "count",
            maxRequests,
          ),
          evidence("ProcessedBytes", "Processed bytes", "sum", processed, "bytes", maxBytes),
          evidence("HealthyHostCount", "Peak healthy targets", "max", healthyPeak, "count"),
        ],
      };
    },
  };
}

export function planClassicElb(
  resource: IdleScanResource,
  thresholds: Record<string, number>,
  lookbackDays: number,
  windowStart: Date,
): ResourcePlan | null {
  const name = String(resource.fields["name"] ?? resource.externalId ?? "");
  if (!name) return null;
  // No Classic metric is published unconditionally, so the stored creation
  // time is the only guard against flagging a balancer created last week.
  if (
    typeof resource.fields["createdTime"] !== "string" ||
    !oldEnough(resource.fields, windowStart)
  ) {
    return null;
  }
  const dims = [{ Name: "LoadBalancerName", Value: name }];
  const requests: MetricQuery = {
    id: qid(),
    namespace: "AWS/ELB",
    metric: "RequestCount",
    dimensions: dims,
    stat: "Sum",
  };
  const healthy: MetricQuery = {
    id: qid(),
    namespace: "AWS/ELB",
    metric: "HealthyHostCount",
    dimensions: dims,
    stat: "Maximum",
  };
  const maxRequests = thresholds["maxRequests"] ?? 100;
  return {
    ruleId: "classic-load-balancer",
    resource,
    queries: [requests, healthy],
    judge(results) {
      const total = sum(results.get(requests.id) ?? []) ?? 0;
      const healthyDays = results.get(healthy.id) ?? [];
      const healthyPeak = max(healthyDays);
      // HealthyHostCount is published while instances are registered: none
      // over the window means none registered, or none ever healthy.
      const noHealthy = healthyPeak === null || healthyPeak === 0;
      if (total > maxRequests && !noHealthy) return null;
      return {
        reason: noHealthy
          ? `No healthy registered instance in ${lookbackDays} days (${fmtCount(total)} requests)`
          : `${fmtCount(total)} requests over ${lookbackDays} days`,
        evidence: [
          evidence("RequestCount", "Requests", "sum", total, "count", maxRequests),
          evidence("HealthyHostCount", "Peak healthy instances", "max", healthyPeak, "count"),
        ],
      };
    },
  };
}

export function planElastiCache(
  resource: IdleScanResource,
  thresholds: Record<string, number>,
  lookbackDays: number,
): ResourcePlan | null {
  const f = resource.fields;
  const clusterId = String(f["clusterId"] ?? resource.externalId ?? "");
  if (!clusterId || String(f["status"] ?? "available") !== "available") return null;
  const memcached = String(f["engine"] ?? "").toLowerCase() === "memcached";
  const schema = "{AWS/ElastiCache,CacheClusterId,CacheNodeId}";
  const node = (metric: string, agg: "SUM" | "MAX", stat: "Sum" | "Maximum"): MetricQuery => ({
    id: qid(),
    expression: searchExpression(
      agg,
      schema,
      { CacheClusterId: clusterId, MetricName: metric },
      stat,
    ),
  });
  const conns = node("CurrConnections", "MAX", "Maximum");
  const reads = node(memcached ? "CmdGet" : "GetTypeCmds", "SUM", "Sum");
  const writes = node(memcached ? "CmdSet" : "SetTypeCmds", "SUM", "Sum");
  const maxConns = thresholds["maxConnections"] ?? 6;
  const maxCommands = thresholds["maxCommands"] ?? 100;
  return {
    ruleId: "elasticache-cluster",
    resource,
    queries: [conns, reads, writes],
    judge(results) {
      const connDays = results.get(conns.id) ?? [];
      // Published every minute per node: required to trust the zeros below.
      if (connDays.length < requiredCoverage(lookbackDays)) return null;
      const peak = max(connDays);
      const commands =
        (sum(results.get(reads.id) ?? []) ?? 0) + (sum(results.get(writes.id) ?? []) ?? 0);
      if (peak === null || peak > maxConns || commands > maxCommands) return null;
      return {
        reason: `At most ${fmtCount(peak)} connections per node and ${fmtCount(commands)} reads and writes over ${lookbackDays} days`,
        evidence: [
          evidence("CurrConnections", "Peak connections per node", "max", peak, "count", maxConns),
          evidence(
            memcached ? "CmdGet+CmdSet" : "GetTypeCmds+SetTypeCmds",
            "Read and write commands",
            "sum",
            commands,
            "count",
            maxCommands,
          ),
        ],
      };
    },
  };
}

/** What the DynamoDB judge measured, kept for the price comparison. */
interface DynamoUsage {
  consumedReads: number;
  consumedWrites: number;
  provisionedReads: number;
  provisionedWrites: number;
  windowSeconds: number;
}

export function planDynamoDb(
  resource: IdleScanResource,
  thresholds: Record<string, number>,
  lookbackDays: number,
  usage: Map<string, DynamoUsage>,
): ResourcePlan | null {
  const f = resource.fields;
  if (String(f["billingMode"] ?? "PROVISIONED").toUpperCase() !== "PROVISIONED") return null;
  // The dimension is the table name; externalId is the name too, but the
  // field is the documented spelling (KNOWLEDGE "Cloud metric dimension gotchas").
  const table = String(f["tableName"] ?? resource.externalId ?? "");
  if (!table) return null;
  const dims = [{ Name: "TableName", Value: table }];
  const q = (metric: string, stat: "Sum" | "Average"): MetricQuery => ({
    id: qid(),
    namespace: "AWS/DynamoDB",
    metric,
    dimensions: dims,
    stat,
  });
  const reads = q("ConsumedReadCapacityUnits", "Sum");
  const writes = q("ConsumedWriteCapacityUnits", "Sum");
  const provReads = q("ProvisionedReadCapacityUnits", "Average");
  const provWrites = q("ProvisionedWriteCapacityUnits", "Average");
  const maxUtil = thresholds["maxUtilization"] ?? 5;
  return {
    ruleId: "dynamodb-provisioned",
    resource,
    queries: [reads, writes, provReads, provWrites],
    judge(results) {
      const provReadDays = results.get(provReads.id) ?? [];
      if (provReadDays.length < requiredCoverage(lookbackDays)) return null;
      const readDays = results.get(reads.id) ?? [];
      const writeDays = results.get(writes.id) ?? [];
      // Consumed capacity is emitted with zeros for an idle table (its
      // SampleCount is regular), so missing days are a read we cannot trust.
      if (readDays.length < requiredCoverage(lookbackDays)) return null;
      const provisionedReads = mean(provReadDays) ?? Number(f["provisionedReadCapacityUnits"] ?? 0);
      const provisionedWrites =
        mean(results.get(provWrites.id) ?? []) ?? Number(f["provisionedWriteCapacityUnits"] ?? 0);
      if (!(provisionedReads > 0) && !(provisionedWrites > 0)) return null;
      const windowSeconds = readDays.length * DAY_SECONDS;
      const consumedReads = sum(readDays) ?? 0;
      const consumedWrites = sum(writeDays) ?? 0;
      const readUtil =
        provisionedReads > 0 ? (consumedReads / (provisionedReads * windowSeconds)) * 100 : 0;
      const writeUtil =
        provisionedWrites > 0 ? (consumedWrites / (provisionedWrites * windowSeconds)) * 100 : 0;
      if (readUtil > maxUtil || writeUtil > maxUtil) return null;
      usage.set(resource.id, {
        consumedReads,
        consumedWrites,
        provisionedReads,
        provisionedWrites,
        windowSeconds,
      });
      const pct = (n: number) => `${Number(n.toFixed(2))}%`;
      return {
        reason: `Used ${pct(readUtil)} of provisioned reads and ${pct(writeUtil)} of writes over ${lookbackDays} days`,
        evidence: [
          {
            metric: "ConsumedReadCapacityUnits",
            label: "Read capacity used",
            statistic: "average",
            value: Number(readUtil.toFixed(3)),
            unit: "percent",
            threshold: maxUtil,
            comparison: "atMost",
          },
          {
            metric: "ConsumedWriteCapacityUnits",
            label: "Write capacity used",
            statistic: "average",
            value: Number(writeUtil.toFixed(3)),
            unit: "percent",
            threshold: maxUtil,
            comparison: "atMost",
          },
          evidence(
            "ProvisionedReadCapacityUnits",
            "Provisioned read units",
            "average",
            provisionedReads,
            "count",
          ),
          evidence(
            "ProvisionedWriteCapacityUnits",
            "Provisioned write units",
            "average",
            provisionedWrites,
            "count",
          ),
        ],
      };
    },
  };
}

export function planRds(
  resource: IdleScanResource,
  thresholds: Record<string, number>,
  lookbackDays: number,
): ResourcePlan | null {
  const f = resource.fields;
  if (String(f["status"] ?? "") !== "available") return null;
  const id = String(f["dbInstanceId"] ?? resource.externalId ?? "");
  if (!id) return null;
  const conns: MetricQuery = {
    id: qid(),
    namespace: "AWS/RDS",
    metric: "DatabaseConnections",
    dimensions: [{ Name: "DBInstanceIdentifier", Value: id }],
    stat: "Maximum",
  };
  const maxConns = thresholds["maxConnections"] ?? 0;
  return {
    ruleId: "rds-instance",
    resource,
    queries: [conns],
    judge(results) {
      const days = results.get(conns.id) ?? [];
      if (days.length < requiredCoverage(lookbackDays)) return null;
      const peak = max(days);
      if (peak === null || peak > maxConns) return null;
      return {
        reason: `At most ${fmtCount(peak)} database connections over ${lookbackDays} days`,
        evidence: [
          evidence("DatabaseConnections", "Peak connections", "max", peak, "count", maxConns),
        ],
      };
    },
  };
}

/* --------------------------------------------------------------------------
 * Pricing
 * ------------------------------------------------------------------------ */

/** Seam for tests: the list-price lookups the estimates need. */
export interface AwsIdlePricing {
  natHourly(creds: AwsCredentials, region: string, regional: boolean): Promise<number | null>;
  elbHourly(
    creds: AwsCredentials,
    region: string,
    kind: "application" | "network" | "classic",
  ): Promise<number | null>;
  cacheNodeHourly(
    creds: AwsCredentials,
    region: string,
    nodeType: string,
    engine: string,
  ): Promise<number | null>;
  dynamoRates: typeof fetchDynamoDbRates;
  rdsMonthly: typeof fetchRdsMonthlyPrice;
}

export const livePricing: AwsIdlePricing = {
  natHourly: fetchNatGatewayHourlyUsd,
  elbHourly: fetchLoadBalancerHourlyUsd,
  cacheNodeHourly: fetchElastiCacheNodeHourlyUsd,
  dynamoRates: fetchDynamoDbRates,
  rdsMonthly: fetchRdsMonthlyPrice,
};

const SECONDS_PER_MONTH = HOURS_PER_MONTH * 3600;

async function estimateFor(
  plan: ResourcePlan,
  creds: AwsCredentials,
  region: string,
  pricing: AwsIdlePricing,
  dynamoUsage: Map<string, DynamoUsage>,
): Promise<IdleFindingRecord["estimate"]> {
  const f = plan.resource.fields;
  const monthly = (hourly: number | null) => (hourly === null ? null : hourly * HOURS_PER_MONTH);
  let amount: number | null = null;
  let note: string | undefined;
  switch (plan.ruleId) {
    case "nat-gateway": {
      const regional = String(f["availabilityMode"] ?? "zonal") === "regional";
      amount = monthly(await pricing.natHourly(creds, region, regional));
      note = regional
        ? "Gateway hours for one zone; a regional gateway bills each active zone. The public IPv4 address bills separately until it is released."
        : "Gateway hours only; the public IPv4 address bills separately until it is released.";
      break;
    }
    case "load-balancer": {
      const kind = String(f["type"] ?? "application") === "network" ? "network" : "application";
      amount = monthly(await pricing.elbHourly(creds, region, kind));
      note = "Load balancer hours; capacity units are near zero when idle.";
      break;
    }
    case "classic-load-balancer":
      amount = monthly(await pricing.elbHourly(creds, region, "classic"));
      note = "Load balancer hours; data processed is near zero when idle.";
      break;
    case "elasticache-cluster": {
      const hourly = await pricing.cacheNodeHourly(
        creds,
        region,
        String(f["nodeType"] ?? ""),
        String(f["engine"] ?? ""),
      );
      const nodes = Math.max(1, Number(f["numNodes"] ?? 1) || 1);
      amount = hourly === null ? null : hourly * nodes * HOURS_PER_MONTH;
      note = "On-demand node hours.";
      break;
    }
    case "dynamodb-provisioned": {
      const usage = dynamoUsage.get(plan.resource.id);
      const rates = usage ? await pricing.dynamoRates(creds, region) : null;
      if (usage && rates) {
        const provisioned =
          (usage.provisionedReads * rates.readCapacityHour +
            usage.provisionedWrites * rates.writeCapacityHour) *
          HOURS_PER_MONTH;
        const scale = SECONDS_PER_MONTH / usage.windowSeconds;
        const onDemand =
          (usage.consumedReads * rates.readRequestUnit +
            usage.consumedWrites * rates.writeRequestUnit) *
          scale;
        const saving = provisioned - onDemand;
        amount = saving > 0 ? saving : null;
        note =
          "Table-level provisioned capacity against the same usage on demand; global secondary indexes and the free tier are not included.";
      }
      break;
    }
    case "rds-instance": {
      const engine = String(f["engine"] ?? "");
      amount = await pricing.rdsMonthly(
        creds,
        region,
        String(f["instanceClass"] ?? ""),
        engine,
        f["multiAZ"] === true || f["multiAZ"] === "true",
      );
      note = "Instance hours while stopped; storage keeps billing.";
      break;
    }
  }
  if (amount === null || !Number.isFinite(amount)) return null;
  return {
    monthlyAmount: Math.round(amount * 100) / 100,
    currency: "USD",
    basis: "list-price",
    ...(note ? { note } : {}),
  };
}

/* --------------------------------------------------------------------------
 * Entry point
 * ------------------------------------------------------------------------ */

export interface AwsIdleDeps {
  /** Credentials for a region (the client's `credsFor`). */
  credsFor(region: string): AwsCredentials;
  homeRegion: string;
  readMetrics?: MetricReader;
  pricing?: AwsIdlePricing;
}

/** Fields a remediation generator reads off an idle finding beyond the stored row. */
function remediationFields(resource: IdleScanResource): Record<string, string> {
  const arn = resource.resolvedOutputs["loadBalancerArn"];
  return arn ? { loadBalancerArn: arn } : {};
}

/**
 * Judge the account's resources against the enabled rules. Throws (never a
 * short list) when a region's read fails; a resource whose metrics simply do
 * not cover the window is skipped.
 */
export async function fetchAwsIdleFindings(
  request: IdleScanRequest,
  deps: AwsIdleDeps,
): Promise<IdleFindingRecord[]> {
  const readMetrics = deps.readMetrics ?? getMetricData;
  const pricing = deps.pricing ?? livePricing;
  const end = new Date(request.windowEnd);
  // Whole UTC days, so each daily bucket is a calendar day and the first one
  // is complete.
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - request.lookbackDays * DAY_SECONDS * 1000);
  const dynamoUsage = new Map<string, DynamoUsage>();

  const plans: ResourcePlan[] = [];
  for (const resource of request.resources) {
    if (!oldEnough(resource.fields, start)) continue;
    const t = (ruleId: string) => request.rules[ruleId]?.thresholds;
    let plan: ResourcePlan | null = null;
    switch (resource.resourceTypeId) {
      case "nat-gateway":
        if (t("nat-gateway"))
          plan = planNatGateway(resource, t("nat-gateway")!, request.lookbackDays);
        break;
      case "alb":
        if (t("load-balancer"))
          plan = planElbv2(resource, t("load-balancer")!, request.lookbackDays);
        break;
      case "classic-elb":
        if (t("classic-load-balancer"))
          plan = planClassicElb(resource, t("classic-load-balancer")!, request.lookbackDays, start);
        break;
      case "elasticache-cluster":
        if (t("elasticache-cluster"))
          plan = planElastiCache(resource, t("elasticache-cluster")!, request.lookbackDays);
        break;
      case "dynamodb-table":
        if (t("dynamodb-provisioned"))
          plan = planDynamoDb(
            resource,
            t("dynamodb-provisioned")!,
            request.lookbackDays,
            dynamoUsage,
          );
        break;
      case "rds-instance":
        if (t("rds-instance")) plan = planRds(resource, t("rds-instance")!, request.lookbackDays);
        break;
    }
    if (plan) plans.push(plan);
  }

  const byRegion = new Map<string, ResourcePlan[]>();
  for (const plan of plans) {
    const region = String(plan.resource.fields["region"] ?? "") || deps.homeRegion;
    const list = byRegion.get(region) ?? [];
    list.push(plan);
    byRegion.set(region, list);
  }

  const findings: IdleFindingRecord[] = [];
  for (const [region, regionPlans] of byRegion) {
    const creds = deps.credsFor(region);
    const results = await readMetrics(
      creds,
      regionPlans.flatMap((p) => p.queries),
      { start, end },
    );
    for (const plan of regionPlans) {
      const verdict = plan.judge(results);
      if (!verdict) continue;
      const estimate = await estimateFor(plan, creds, region, pricing, dynamoUsage).catch(
        () => null,
      );
      findings.push({
        ruleId: plan.ruleId,
        subjectKey: plan.resource.externalId ?? plan.resource.id,
        resourceId: plan.resource.id,
        resourceTypeId: plan.resource.resourceTypeId,
        displayName: plan.resource.displayName,
        reason: verdict.reason,
        evidence: verdict.evidence,
        estimate,
        fields: { region, ...remediationFields(plan.resource) },
      });
    }
  }
  return findings;
}
