import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pluginManifestSchema,
  type IdleScanRequest,
  type IdleScanResource,
  type RemediationCommand,
} from "@infrawrench/plugin-base";
import type { AwsIdlePricing, MetricQuery, MetricReader } from "../idle-findings.js";

const queryPostCall = vi.fn();
vi.mock("../client-transport.js", async (orig) => ({
  ...(await orig<typeof import("../client-transport.js")>()),
  queryPostCall: (...args: unknown[]) => queryPostCall(...args),
}));

const {
  AWS_IDLE_FINDINGS,
  elbv2Dimension,
  fetchAwsIdleFindings,
  getMetricData,
  resetQueryIds,
  searchExpression,
} = await import("../idle-findings.js");
const { awsRemediationCommands } = await import("../remediation.js");
const { plugin } = await import("../plugin.js");

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
});
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  resetQueryIds();
  queryPostCall.mockReset();
});

const creds = {
  accessKeyId: "test-access-key",
  secretAccessKey: "not-a-secret",
  region: "us-east-1",
};
const DAYS = 14;

function res(
  id: string,
  resourceTypeId: string,
  fields: IdleScanResource["fields"],
  resolvedOutputs: Record<string, string> = {},
): IdleScanResource {
  return { id, resourceTypeId, externalId: id, displayName: id, fields, resolvedOutputs };
}

function request(resources: IdleScanResource[], rules?: IdleScanRequest["rules"]): IdleScanRequest {
  const all: IdleScanRequest["rules"] = {};
  for (const r of AWS_IDLE_FINDINGS.rules) {
    all[r.id] = { thresholds: Object.fromEntries(r.thresholds.map((t) => [t.key, t.default])) };
  }
  return { lookbackDays: DAYS, windowEnd: "2026-10-16T12:00:00Z", rules: rules ?? all, resources };
}

/**
 * A fake CloudWatch: answers each query from a function of the query, so a
 * test states "this metric has these daily values" without knowing ids.
 */
function reader(answer: (q: MetricQuery) => number[]): {
  read: MetricReader;
  seen: MetricQuery[];
} {
  const seen: MetricQuery[] = [];
  return {
    seen,
    read: async (_creds, queries) => {
      seen.push(...queries);
      return new Map(queries.map((q) => [q.id, answer(q)]));
    },
  };
}

const days = (value: number, n = DAYS) => Array.from({ length: n }, () => value);
const name = (q: MetricQuery) => ("metric" in q ? q.metric : q.expression);

const pricing: AwsIdlePricing = {
  natHourly: async (_c, _r, regional) => (regional ? 0.05 : 0.045),
  elbHourly: async (_c, _r, kind) => (kind === "classic" ? 0.025 : 0.0225),
  cacheNodeHourly: async () => 0.017,
  dynamoRates: async () => ({
    readCapacityHour: 0.00013,
    writeCapacityHour: 0.00065,
    readRequestUnit: 0.000000125,
    writeRequestUnit: 0.000000625,
  }),
  rdsMonthly: async () => 12.41,
};

function run(
  resources: IdleScanResource[],
  answer: (q: MetricQuery) => number[],
  rules?: IdleScanRequest["rules"],
) {
  const r = reader(answer);
  return {
    seen: r.seen,
    findings: fetchAwsIdleFindings(request(resources, rules), {
      credsFor: (region) => ({ ...creds, region }),
      homeRegion: "us-east-1",
      readMetrics: r.read,
      pricing,
    }),
  };
}

describe("declaration", () => {
  it("is on the manifest and validates against plugin-base's schema", async () => {
    expect(plugin.manifest.idleFindings).toBe(AWS_IDLE_FINDINGS);
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
  });

  it("only names resource types the plugin declares", () => {
    const types = new Set(plugin.resourceTypes.map((t) => t.id));
    for (const rule of AWS_IDLE_FINDINGS.rules) {
      for (const id of rule.resourceTypeIds) expect(types.has(id)).toBe(true);
    }
  });
});

describe("NAT gateway", () => {
  const nat = res("nat-0abc", "nat-gateway", {
    natGatewayId: "nat-0abc",
    region: "eu-west-1",
    state: "available",
    availabilityMode: "zonal",
  });

  it("flags a zonal gateway with no traffic, reading {NatGatewayId} in its region", async () => {
    const { findings, seen } = run([nat], () => days(0));
    const [f] = await findings;
    expect(f).toMatchObject({
      ruleId: "nat-gateway",
      resourceId: "nat-0abc",
      estimate: { monthlyAmount: 32.85, currency: "USD", basis: "list-price" },
      fields: { region: "eu-west-1" },
    });
    expect(f!.evidence[0]).toMatchObject({
      metric: "BytesOutToDestination",
      value: 0,
      threshold: 1_000_000,
    });
    const q = seen.find((s) => name(s) === "BytesOutToDestination");
    expect(q).toMatchObject({
      namespace: "AWS/NATGateway",
      dimensions: [{ Name: "NatGatewayId", Value: "nat-0abc" }],
      stat: "Sum",
    });
  });

  it("reads a regional gateway through a per-zone SEARCH", async () => {
    const regional = res("nat-0reg", "nat-gateway", {
      ...nat.fields,
      natGatewayId: "nat-0reg",
      availabilityMode: "regional",
    });
    const { findings, seen } = run([regional], () => days(0));
    expect((await findings)[0]!.estimate?.monthlyAmount).toBe(36.5);
    expect(
      seen.some(
        (q) =>
          "expression" in q &&
          q.expression.includes("{AWS/NATGateway,AvailabilityZone,NatGatewayId}"),
      ),
    ).toBe(true);
  });

  it("does not flag a busy gateway, or one whose metrics do not cover the window", async () => {
    expect(
      await run([nat], (q) => (name(q) === "BytesOutToDestination" ? days(5_000_000) : days(0)))
        .findings,
    ).toEqual([]);
    expect(
      await run([nat], (q) => (name(q) === "ActiveConnectionCount" ? days(3) : days(0))).findings,
    ).toEqual([]);
    expect(await run([nat], () => days(0, 5)).findings).toEqual([]);
  });

  it("skips a gateway created inside the window", async () => {
    const young = res("nat-young", "nat-gateway", {
      ...nat.fields,
      createdTime: "2026-10-10T00:00:00Z",
    });
    const { findings, seen } = run([young], () => days(0));
    expect(await findings).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("honours the org's thresholds and skips disabled rules", async () => {
    const rules = {
      "nat-gateway": { thresholds: { maxBytesOut: 10_000_000, maxActiveConnections: 5 } },
    };
    const busyish = (q: MetricQuery) =>
      name(q) === "BytesOutToDestination" ? days(100_000) : days(2);
    expect(await run([nat], busyish, rules).findings).toHaveLength(1);
    expect(await run([nat], () => days(0), {}).findings).toEqual([]);
  });
});

describe("load balancers", () => {
  const alb = res(
    "web-alb",
    "alb",
    { name: "web-alb", type: "application", state: "active", region: "us-east-1" },
    {
      loadBalancerArn:
        "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/web-alb/50dc6c495c0c9188",
    },
  );

  it("uses the app/name/id ARN slice as the LoadBalancer dimension", () => {
    expect(elbv2Dimension(alb.resolvedOutputs["loadBalancerArn"]!)).toBe(
      "app/web-alb/50dc6c495c0c9188",
    );
    expect(elbv2Dimension("arn:aws:elasticloadbalancing:us-east-1:1:targetgroup/x/1")).toBe("");
  });

  it("reads absent request counts as zero once ConsumedLCUs proves the read", async () => {
    const { findings } = run([alb], (q) => (name(q) === "ConsumedLCUs" ? days(0.01) : []));
    const [f] = await findings;
    expect(f!.reason).toContain("0 requests");
    expect(f!.estimate?.monthlyAmount).toBe(16.43);
    expect(f!.fields).toMatchObject({ loadBalancerArn: alb.resolvedOutputs["loadBalancerArn"] });
  });

  it("never flags when ConsumedLCUs is missing (a wrong read is not an idle balancer)", async () => {
    expect(await run([alb], () => []).findings).toEqual([]);
  });

  it("flags a busy balancer with no healthy target", async () => {
    const { findings } = run([alb], (q) =>
      name(q) === "RequestCount" ? days(10_000) : "expression" in q ? days(0) : days(1),
    );
    expect((await findings)[0]!.reason).toMatch(/^No healthy target/);
  });

  it("queries a network load balancer under AWS/NetworkELB with NewFlowCount", async () => {
    const nlb = res(
      "tcp-nlb",
      "alb",
      { ...alb.fields, type: "network" },
      {
        loadBalancerArn:
          "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/net/tcp-nlb/73e2d6bc24d8a067",
      },
    );
    const { findings, seen } = run([nlb], (q) => (name(q) === "ConsumedLCUs" ? days(0) : days(0)));
    expect(await findings).toHaveLength(1);
    expect(seen.find((q) => name(q) === "NewFlowCount")).toMatchObject({
      namespace: "AWS/NetworkELB",
    });
    expect(seen.find((q) => name(q) === "RequestCount")).toBeUndefined();
  });

  it("flags a classic balancer with no registered instance, but only once it is old enough", async () => {
    const clb = res("legacy", "classic-elb", {
      name: "legacy",
      region: "us-east-1",
      createdTime: "2024-01-01T00:00:00Z",
    });
    const { findings, seen } = run([clb], () => []);
    expect((await findings)[0]!.reason).toMatch(/^No healthy registered instance/);
    expect(seen[0]).toMatchObject({
      namespace: "AWS/ELB",
      dimensions: [{ Name: "LoadBalancerName", Value: "legacy" }],
    });
    const unknownAge = res("x", "classic-elb", { name: "x", region: "us-east-1" });
    expect(await run([unknownAge], () => []).findings).toEqual([]);
  });
});

describe("ElastiCache", () => {
  const cache = res("sessions", "elasticache-cluster", {
    clusterId: "sessions",
    region: "us-east-1",
    engine: "valkey",
    nodeType: "cache.t3.micro",
    numNodes: 2,
    status: "available",
  });

  it("flags a cluster whose only connections are ElastiCache's own", async () => {
    const { findings, seen } = run([cache], (q) =>
      "expression" in q && q.expression.includes("CurrConnections") ? days(5) : days(0),
    );
    const [f] = await findings;
    expect(f!.estimate?.monthlyAmount).toBe(24.82);
    expect(seen.map(name).join(" ")).toContain("GetTypeCmds");
  });

  it("does not flag one with client traffic", async () => {
    expect(
      await run([cache], (q) =>
        "expression" in q && q.expression.includes("GetTypeCmds") ? days(500) : days(5),
      ).findings,
    ).toEqual([]);
  });

  it("reads Memcached command counts", async () => {
    const mc = res("mc", "elasticache-cluster", {
      ...cache.fields,
      clusterId: "mc",
      engine: "memcached",
    });
    const { seen } = run([mc], () => days(0));
    await Promise.resolve();
    expect(seen.map(name).join(" ")).toContain("CmdGet");
  });
});

describe("DynamoDB", () => {
  const table = res("orders", "dynamodb-table", {
    tableName: "orders",
    region: "us-east-1",
    billingMode: "PROVISIONED",
    provisionedReadCapacityUnits: 100,
    provisionedWriteCapacityUnits: 50,
  });

  it("flags a provisioned table using a sliver of its capacity and prices the on-demand switch", async () => {
    const { findings } = run([table], (q) => {
      if (name(q) === "ProvisionedReadCapacityUnits") return days(100);
      if (name(q) === "ProvisionedWriteCapacityUnits") return days(50);
      if (name(q) === "ConsumedReadCapacityUnits") return days(8640); // 0.1 RCU/s on average
      return days(0);
    });
    const [f] = await findings;
    expect(f!.reason).toBe("Used 0.1% of provisioned reads and 0% of writes over 14 days");
    // Provisioned (100×0.00013 + 50×0.00065)×730 = 33.215; on-demand reads
    // 120,960 units over 14 days scaled to a month ≈ $0.03.
    expect(f!.estimate?.monthlyAmount).toBe(33.18);
  });

  it("ignores on-demand tables and busy ones", async () => {
    const onDemand = res("x", "dynamodb-table", {
      ...table.fields,
      billingMode: "PAY_PER_REQUEST",
    });
    expect(await run([onDemand], () => days(0)).findings).toEqual([]);
    expect(
      await run([table], (q) =>
        name(q) === "ConsumedReadCapacityUnits" ? days(5_000_000) : days(100),
      ).findings,
    ).toEqual([]);
  });
});

describe("RDS", () => {
  const db = res("reporting", "rds-instance", {
    dbInstanceId: "reporting",
    region: "us-east-1",
    status: "available",
    engine: "postgres",
    instanceClass: "db.t3.micro",
    multiAZ: false,
  });

  it("flags an instance with no connections", async () => {
    const [f] = await run([db], () => days(0)).findings;
    expect(f).toMatchObject({ ruleId: "rds-instance", estimate: { monthlyAmount: 12.41 } });
  });

  it("skips stopped instances and connected ones", async () => {
    expect(
      await run([{ ...db, fields: { ...db.fields, status: "stopped" } }], () => days(0)).findings,
    ).toEqual([]);
    expect(await run([db], () => days(2)).findings).toEqual([]);
  });
});

describe("GetMetricData", () => {
  it("encodes stat and expression queries for the Query protocol and collects values", async () => {
    queryPostCall.mockResolvedValue({
      GetMetricDataResult: {
        MetricDataResults: {
          member: [
            { Id: "a", Values: { member: ["1", "2"] } },
            { Id: "b", Values: { member: ["7"] } },
          ],
        },
      },
    });
    const queries: MetricQuery[] = [
      {
        id: "a",
        namespace: "AWS/NATGateway",
        metric: "BytesOutToDestination",
        dimensions: [{ Name: "NatGatewayId", Value: "nat-1" }],
        stat: "Sum",
      },
      { id: "b", expression: searchExpression("MAX", "{AWS/X,Y}", { Y: 'a"b' }, "Maximum") },
    ];
    const out = await getMetricData(creds, queries, {
      start: new Date("2026-10-02T00:00:00Z"),
      end: new Date("2026-10-16T00:00:00Z"),
    });
    expect(out.get("a")).toEqual([1, 2]);
    expect(out.get("b")).toEqual([7]);
    const [, service, action, version, params] = queryPostCall.mock.calls[0]!;
    expect([service, action, version]).toEqual(["monitoring", "GetMetricData", "2010-08-01"]);
    expect(params).toMatchObject({
      "MetricDataQueries.member.1.MetricStat.Metric.Dimensions.member.1.Name": "NatGatewayId",
      "MetricDataQueries.member.1.MetricStat.Period": "86400",
      "MetricDataQueries.member.1.MetricStat.Stat": "Sum",
      "MetricDataQueries.member.2.Expression": `MAX(SEARCH('{AWS/X,Y} Y="a\\"b"', 'Maximum', 86400))`,
    });
  });

  it("turns an access denial into an IdleFindingAccessError", async () => {
    queryPostCall.mockResolvedValue({ Error: { Code: "AccessDenied", Message: "not authorized" } });
    await expect(
      getMetricData(creds, [{ id: "a", expression: "x" }], { start: new Date(), end: new Date() }),
    ).rejects.toMatchObject({ name: "IdleFindingAccessError" });
  });
});

describe("remediation", () => {
  const lines = (cmds: RemediationCommand[]) =>
    cmds.map((c) => `${c.destructive ? "[destructive] " : ""}${c.command}`);
  const idle = (
    idleRuleId: string,
    resourceTypeId: string,
    fields: Record<string, string | number | boolean>,
  ) =>
    awsRemediationCommands({
      kind: "orphan",
      reason: "idle",
      idleRuleId,
      resource: { resourceTypeId, displayName: "x", externalId: null, fields },
    });

  it("deletes a NAT gateway and releases its address", () => {
    expect(
      lines(
        idle("nat-gateway", "nat-gateway", {
          natGatewayId: "nat-0abc",
          region: "eu-west-1",
          allocationId: "eipalloc-1",
        }),
      ),
    ).toMatchInlineSnapshot(`
      [
        "[destructive] aws ec2 delete-nat-gateway --nat-gateway-id nat-0abc --region eu-west-1 --profile "$AWS_PROFILE"",
        "aws ec2 wait nat-gateway-deleted --nat-gateway-ids nat-0abc --region eu-west-1 --profile "$AWS_PROFILE"",
        "[destructive] aws ec2 release-address --allocation-id eipalloc-1 --region eu-west-1 --profile "$AWS_PROFILE"",
      ]
    `);
  });

  it("switches a provisioned table to on-demand without anything destructive", () => {
    expect(
      lines(
        idle("dynamodb-provisioned", "dynamodb-table", {
          tableName: "orders; rm",
          region: "us-east-1",
        }),
      ),
    ).toMatchInlineSnapshot(`
      [
        "aws dynamodb update-table --table-name 'orders; rm' --billing-mode PAY_PER_REQUEST --region us-east-1 --profile "$AWS_PROFILE"",
      ]
    `);
  });

  it("deletes load balancers by ARN or name", () => {
    expect(
      lines(
        idle("load-balancer", "alb", {
          region: "us-east-1",
          loadBalancerArn: "arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/app/a/1",
        }),
      ),
    ).toHaveLength(2);
    expect(
      lines(idle("classic-load-balancer", "classic-elb", { name: "legacy", region: "us-east-1" })),
    ).toEqual([
      '[destructive] aws elb delete-load-balancer --load-balancer-name legacy --region us-east-1 --profile "$AWS_PROFILE"',
    ]);
  });

  it("snapshots before deleting a Valkey cluster and deletes its replication group when it has one", () => {
    expect(
      lines(
        idle("elasticache-cluster", "elasticache-cluster", {
          clusterId: "c1",
          region: "us-east-1",
          engine: "valkey",
        }),
      )[0],
    ).toContain("--final-snapshot-identifier c1-final-20261016");
    expect(
      lines(
        idle("elasticache-cluster", "elasticache-cluster", {
          clusterId: "c1-001",
          replicationGroupId: "c1",
          region: "us-east-1",
          engine: "redis",
        }),
      )[0],
    ).toContain("delete-replication-group --replication-group-id c1");
  });

  it("stops an idle database with a snapshot, or its Aurora cluster", () => {
    expect(
      lines(idle("rds-instance", "rds-instance", { dbInstanceId: "db1", region: "us-east-1" }))[0],
    ).toContain(
      "stop-db-instance --db-instance-identifier db1 --db-snapshot-identifier db1-pre-stop-20261016",
    );
    expect(
      lines(
        idle("rds-instance", "rds-instance", {
          dbInstanceId: "db1",
          dbClusterIdentifier: "aur",
          region: "us-east-1",
        }),
      )[0],
    ).toContain("stop-db-cluster --db-cluster-identifier aur");
  });

  it("returns nothing it cannot address, and leaves plain orphans alone", () => {
    expect(idle("nat-gateway", "nat-gateway", { region: "us-east-1" })).toEqual([]);
    expect(idle("unknown", "nat-gateway", {})).toEqual([]);
  });
});
