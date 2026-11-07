/**
 * What a failed read does to a list. A sync soft-deletes whatever a list stops
 * returning, so these run the real client, listers and signing over a fake host
 * transport, with AWS's own error bodies, and check that only an answer meaning
 * "not available to this credential" reads as no rows.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import net from "node:net";
import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { HttpHostServices, ResourceInstance } from "@infrawrench/plugin-base";

import { AWSClient } from "../client.js";
import { fetchSigned } from "../signed-request.js";
import { fetchAwsVulnerabilityFindings } from "../vulnerabilities.js";
import type { ListerContext } from "../resource-listers.js";
import {
  listDynamoDBTables,
  listECSServices,
  listEKSClusters,
  listLambdaFunctions,
  listSNSTopics,
  listSQSQueues,
} from "../resource-listers.js";
import {
  listACMCertificates,
  listAutoScalingGroups,
  listBedrockModels,
  listClassicELBs,
  listCognitoUserPools,
  listElastiCacheServerlessCaches,
  listKinesisStreams,
  listOpenSearchDomains,
  listRedshiftClusters,
  listRoute53RecordSets,
  listStepFunctions,
  listWAFWebACLs,
} from "../resource-listers-extended.js";

const CREDS = { accessKeyId: "AKIAFAKE", secretAccessKey: "secret", region: "us-east-1" };

type Answer = { status: number; body?: string; headers?: Record<string, string> } | Error;

const accessDenied = (): Answer => ({
  status: 403,
  headers: { "x-amzn-errortype": "AccessDeniedException" },
  body: JSON.stringify({
    Message:
      "User: arn:aws:iam::123456789012:user/x is not authorized to perform: lambda:ListFunctions with an explicit deny in a service control policy",
  }),
});
const expiredRest = (): Answer => ({
  status: 403,
  headers: { "x-amzn-errortype": "ExpiredTokenException" },
  body: JSON.stringify({ message: "The security token included in the request is expired" }),
});
const authFailure = (): Answer => ({
  status: 401,
  body: "<Response><Errors><Error><Code>AuthFailure</Code><Message>AWS was not able to validate the provided access credentials</Message></Error></Errors></Response>",
});
const serverError = (): Answer => ({ status: 500, body: "InternalFailure" });
const throttled = (): Answer => ({
  status: 429,
  headers: { "x-amzn-errortype": "TooManyRequestsException" },
  body: JSON.stringify({ message: "Rate exceeded" }),
});
const noSuchHost = (host: string): Answer =>
  new TypeError("fetch failed", {
    cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }),
  });

function regionsXml(names: string[]): Answer {
  const items = names.map((n) => `<item><regionName>${n}</regionName></item>`).join("");
  return {
    status: 200,
    body: `<DescribeRegionsResponse><regionInfo>${items}</regionInfo></DescribeRegionsResponse>`,
  };
}

const lambdaPage = (name: string): Answer => ({
  status: 200,
  body: JSON.stringify({ Functions: [{ FunctionName: name }] }),
});

/** A host transport answering by URL. Anything it was not told about fails the test. */
function fakeHost(answer: (url: URL) => Answer | undefined) {
  const request = vi.fn(async (req: { url: string }) => {
    const url = new URL(req.url);
    const a = answer(url);
    if (!a) throw new Error(`unexpected request: ${req.url}`);
    if (a instanceof Error) throw a;
    return { status: a.status, headers: a.headers ?? {}, body: a.body ?? "" };
  });
  const http: HttpHostServices = { request };
  return { http, request };
}

function client(answer: (url: URL) => Answer | undefined) {
  const { http, request } = fakeHost(answer);
  return { c: hostClient(new AWSClient(CREDS, [], { http })), request };
}

/** Lambda across two regions, with each region's answer given. */
function lambdaClient(useast: Answer, euwest: Answer) {
  return client((url) => {
    if (url.hostname.startsWith("ec2.")) return regionsXml(["us-east-1", "eu-west-1"]);
    if (url.hostname === "lambda.us-east-1.amazonaws.com") return useast;
    if (url.hostname === "lambda.eu-west-1.amazonaws.com") return euwest;
    return undefined;
  });
}

beforeAll(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("real fetch called");
  });
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => {
    throw new Error("real socket opened");
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");

/**
 * The host's list scope: its hook is a global that finds the running list through an
 * AsyncLocalStorage, so a report only counts if that context survives the plugin's
 * Effect wrapper and its fan-out. Same shape as `runListChecked` in server-core.
 */
async function inListScope<T>(fn: () => Promise<T>): Promise<{ value: T; unread: unknown[] }> {
  const storage = new AsyncLocalStorage<unknown[]>();
  Reflect.set(globalThis, UNREAD_HOOK, (part: unknown) => storage.getStore()?.push(part));
  try {
    const unread: unknown[] = [];
    const value = await storage.run(unread, fn);
    return { value, unread };
  } finally {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
  }
}

/** Every stored row of the type stays: the host filters by type before it matches a prefix. */
const WHOLE_TYPE_UNREAD = [{ idPrefixes: [""] }];

describe("a regional fan-out", () => {
  it("returns the rows when every region answers", async () => {
    const { c } = lambdaClient(lambdaPage("a"), lambdaPage("b"));
    const rows = await c.listResources("lambda-function", "acct");
    expect(rows.map((r) => r.externalId)).toEqual(["a", "b"]);
  });

  it("fails the type on a 5xx in one region, not read as that region being empty", async () => {
    const { c } = lambdaClient(lambdaPage("a"), serverError());
    await expect(c.listResources("lambda-function", "acct")).rejects.toThrow(/failed: 500/);
  });

  it("fails the type on a network failure in one region", async () => {
    const { c } = lambdaClient(
      lambdaPage("a"),
      new TypeError("fetch failed", { cause: new Error("connect ETIMEDOUT") }),
    );
    await expect(c.listResources("lambda-function", "acct")).rejects.toThrow(/fetch failed/);
  });

  it("fails the type on an unknown 400", async () => {
    const { c } = lambdaClient(lambdaPage("a"), { status: 400, body: "ValidationException" });
    await expect(c.listResources("lambda-function", "acct")).rejects.toThrow(/failed: 400/);
  });

  it("reads a region an SCP denies as none", async () => {
    const { c } = lambdaClient(lambdaPage("a"), accessDenied());
    const rows = await c.listResources("lambda-function", "acct");
    expect(rows.map((r) => r.externalId)).toEqual(["a"]);
  });

  it("reads a region that has not opted in as none", async () => {
    const { c } = lambdaClient(lambdaPage("a"), {
      status: 400,
      body: "<Response><Errors><Error><Code>OptInRequired</Code></Error></Errors></Response>",
    });
    const rows = await c.listResources("lambda-function", "acct");
    expect(rows.map((r) => r.externalId)).toEqual(["a"]);
  });

  it("reads a region with no endpoint for the service as none, through fetch's cause", async () => {
    const { c } = lambdaClient(lambdaPage("a"), noSuchHost("lambda.eu-west-1.amazonaws.com"));
    const rows = await c.listResources("lambda-function", "acct");
    expect(rows.map((r) => r.externalId)).toEqual(["a"]);
  });

  it("reads the bastion agent's own DNS failure as no endpoint, but not its allowlist refusal", async () => {
    const dns = new TypeError("fetch failed", {
      cause: Object.assign(
        new Error("Bastion b refused to open stream: getaddrinfo ENOTFOUND x.amazonaws.com"),
        { name: "BastionStreamOpenError" },
      ),
    });
    const listed = await lambdaClient(lambdaPage("a"), dns).c.listResources(
      "lambda-function",
      "acct",
    );
    expect(listed).toHaveLength(1);

    const notAllowed = new TypeError("fetch failed", {
      cause: Object.assign(
        new Error("Bastion b refused to open stream: destination not allowlisted: x"),
        { name: "BastionStreamOpenError" },
      ),
    });
    await expect(
      lambdaClient(lambdaPage("a"), notAllowed).c.listResources("lambda-function", "acct"),
    ).rejects.toThrow(/fetch failed/);
  });

  it("keeps stored rows without an error when every region refuses", async () => {
    const { c } = lambdaClient(accessDenied(), accessDenied());
    const { value, unread } = await inListScope(() => c.listResources("lambda-function", "acct"));
    expect(value).toEqual([]);
    expect(unread).toEqual(WHOLE_TYPE_UNREAD);
  });

  it("fails with the refusal when nobody keeps the rows, as on the desktop", async () => {
    const { c } = lambdaClient(accessDenied(), accessDenied());
    await expect(c.listResources("lambda-function", "acct")).rejects.toThrow(/not authorized/);
    Reflect.set(globalThis, UNREAD_HOOK, () => false);
    try {
      await expect(c.listResources("lambda-function", "acct")).rejects.toThrow(/not authorized/);
    } finally {
      Reflect.deleteProperty(globalThis, UNREAD_HOOK);
    }
  });

  it("keeps stored rows when every region has no endpoint, which may be a DNS outage", async () => {
    const { c } = lambdaClient(noSuchHost("a"), accessDenied());
    const { value, unread } = await inListScope(() => c.listResources("lambda-function", "acct"));
    expect(value).toEqual([]);
    expect(unread).toEqual(WHOLE_TYPE_UNREAD);
  });

  it("names nothing unread when some region answered, so the refused one still prunes", async () => {
    const { c } = lambdaClient(lambdaPage("a"), accessDenied());
    const { value, unread } = await inListScope(() => c.listResources("lambda-function", "acct"));
    expect(value.map((r) => r.externalId)).toEqual(["a"]);
    expect(unread).toEqual([]);
  });

  it("reports nothing and fails when a key is bad, even if another region refuses", async () => {
    const { c } = lambdaClient(accessDenied(), expiredRest());
    const unread: unknown[] = [];
    Reflect.set(globalThis, UNREAD_HOOK, (part: unknown) => unread.push(part));
    try {
      await expect(c.listResources("lambda-function", "acct")).rejects.toThrow(/expired/);
    } finally {
      Reflect.deleteProperty(globalThis, UNREAD_HOOK);
    }
    expect(unread).toEqual([]);
  });

  it("fails on a credential that is plainly expired, in any region, not as a closed region", async () => {
    for (const [useast, euwest] of [
      [expiredRest(), expiredRest()],
      [lambdaPage("a"), expiredRest()],
    ] as const) {
      const { c } = lambdaClient(useast, euwest);
      const failure = await c.listResources("lambda-function", "acct").catch((e: Error) => e);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/expired/);
    }
  });

  it("fails on EC2's AuthFailure", async () => {
    const { c } = client((url) => {
      if (url.search.includes("DescribeRegions")) return regionsXml(["us-east-1"]);
      return authFailure();
    });
    await expect(c.listResources("vpc", "acct")).rejects.toThrow(/AuthFailure/);
  });

  it("does not read a refusal on a later page as a closed region", async () => {
    const { c } = client((url) => {
      if (url.hostname.startsWith("ec2.")) return regionsXml(["us-east-1", "eu-west-1"]);
      if (url.hostname === "lambda.us-east-1.amazonaws.com") return lambdaPage("a");
      if (url.searchParams.has("Marker")) return accessDenied();
      return {
        status: 200,
        body: JSON.stringify({ Functions: [{ FunctionName: "b" }], NextMarker: "m" }),
      };
    });
    await expect(c.listResources("lambda-function", "acct")).rejects.toThrow(/not authorized/);
  });

  it("passes a truncated region's error through", async () => {
    const { c } = client((url) => {
      if (url.hostname.startsWith("ec2.")) return regionsXml(["us-east-1"]);
      return {
        status: 200,
        body: JSON.stringify({
          Functions: [],
          NextMarker: `m${url.search.length}${Math.random()}`,
        }),
      };
    });
    await expect(c.listResources("lambda-function", "acct")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });
});

describe("a global or home-region type refused whole", () => {
  const refusedEverywhere = () =>
    client((url) => {
      if (url.hostname.startsWith("ec2.")) return regionsXml(["us-east-1"]);
      return accessDenied();
    });

  it.each([
    "iam-user",
    "s3-bucket",
    "route53-hosted-zone",
    "cloudfront-distribution",
    "bedrock-model",
  ])("keeps the stored %s rows without an error", async (typeId) => {
    const { c } = refusedEverywhere();
    const { value, unread } = await inListScope(() => c.listResources(typeId, "acct"));
    expect(value).toEqual([]);
    expect(unread).toEqual(WHOLE_TYPE_UNREAD);
  });

  it("fails with the refusal when nobody keeps the rows", async () => {
    const { c } = refusedEverywhere();
    await expect(c.listResources("iam-user", "acct")).rejects.toThrow(/not authorized/);
  });

  it("still fails on a throttle, a 5xx or a bad key", async () => {
    for (const answer of [throttled(), serverError(), expiredRest()]) {
      const { c } = client(() => answer);
      const { unread } = await inListScope(async () => {
        await expect(c.listResources("iam-user", "acct")).rejects.toThrow();
      });
      expect(unread).toEqual([]);
    }
  });
});

describe("DescribeRegions", () => {
  it("falls back to the home region when permissions deny it, and stays there", async () => {
    const { c, request } = client((url) => {
      if (url.hostname.startsWith("ec2.")) {
        return {
          status: 403,
          body: "<Response><Errors><Error><Code>UnauthorizedOperation</Code></Error></Errors></Response>",
        };
      }
      return lambdaPage("home");
    });
    const rows = await c.listResources("lambda-function", "acct");
    expect(rows.map((r) => r.fields["region"])).toEqual(["us-east-1"]);
    await c.listResources("lambda-function", "acct");
    const regionCalls = request.mock.calls.filter(([r]) => r.url.includes("DescribeRegions"));
    expect(regionCalls).toHaveLength(1);
  });

  it.each([
    ["a 5xx", serverError()],
    ["an expired credential", authFailure()],
    ["a network failure", new TypeError("fetch failed", { cause: new Error("ECONNRESET") })],
  ])("fails on %s, and does not cache it", async (_name, failure) => {
    let answer = failure;
    const { c } = client((url) => {
      if (url.hostname.startsWith("ec2.")) return answer;
      return url.hostname.includes("us-east-1") ? lambdaPage("a") : lambdaPage("b");
    });
    await expect(c.listResources("lambda-function", "acct")).rejects.toThrow();

    answer = regionsXml(["us-east-1", "eu-west-1"]);
    const rows = await c.listResources("lambda-function", "acct");
    expect(rows.map((r) => r.externalId)).toEqual(["a", "b"]);
  });

  it("fails on an answer that names no region", async () => {
    const { c } = client((url) =>
      url.hostname.startsWith("ec2.") ? regionsXml([]) : lambdaPage("a"),
    );
    await expect(c.listResources("lambda-function", "acct")).rejects.toThrow(/naming a region/);
  });
});

describe("getResource", () => {
  const id = "acct:lambda-function:a";

  it("finds the row despite another region failing", async () => {
    const { c } = lambdaClient(lambdaPage("a"), serverError());
    expect((await c.getResource("lambda-function", id, "acct")).externalId).toBe("a");
  });

  it("reports the failure when the row may be what it hid", async () => {
    const { c } = lambdaClient(lambdaPage("z"), serverError());
    await expect(c.getResource("lambda-function", id, "acct")).rejects.toThrow(/failed: 500/);
  });

  it("reports the refusal, not a missing row, when every region refused", async () => {
    const { c } = lambdaClient(accessDenied(), accessDenied());
    await expect(c.getResource("lambda-function", id, "acct")).rejects.toThrow(/not authorized/);
  });

  it("says not found when every region answered", async () => {
    const { c } = lambdaClient(lambdaPage("z"), lambdaPage("y"));
    await expect(c.getResource("lambda-function", id, "acct")).rejects.toThrow(/not found/);
  });
});

/** A lister context that answers one list and sends every other call to `describe`. */
function rowCtx(isList: (args: unknown[]) => unknown, describeRow: () => unknown): ListerContext {
  const call = vi.fn(async (...args: unknown[]) => isList(args) ?? describeRow());
  return {
    ec2: call,
    json: call,
    jsonGet: call,
    restJson: call,
    ec2Query: call,
    xmlGet: call,
    id: (a: string, t: string, e: string) => `${a}:${t}:${e}`,
    now: () => "2026-01-01T00:00:00Z",
    region: "us-east-1",
    creds: CREDS,
  } as unknown as ListerContext;
}

const rowCases: Array<{
  name: string;
  lister: (ctx: ListerContext, accountId: string) => Promise<ResourceInstance[]>;
  list: (args: unknown[]) => unknown;
  /** Keeps a stub row when refused, rather than leaving it out. */
  keepsRow?: boolean;
}> = [
  {
    name: "EKS",
    lister: listEKSClusters,
    list: (a) => (String(a[1]).startsWith("/clusters?") ? { clusters: ["c1"] } : undefined),
  },
  {
    name: "ECS",
    lister: listECSServices,
    list: (a) => (String(a[1]).endsWith("ListClusters") ? { clusterArns: ["arn:c/1"] } : undefined),
  },
  {
    name: "DynamoDB",
    lister: listDynamoDBTables,
    list: (a) => (String(a[1]).endsWith("ListTables") ? { TableNames: ["t1"] } : undefined),
  },
  {
    name: "SQS",
    lister: listSQSQueues,
    list: (a) => (String(a[1]).endsWith("ListQueues") ? { QueueUrls: ["https://q/1"] } : undefined),
  },
  {
    name: "OpenSearch",
    lister: listOpenSearchDomains,
    list: (a) =>
      a[1] === "/2021-01-01/domain" ? { DomainNames: [{ DomainName: "d" }] } : undefined,
  },
  {
    name: "Kinesis",
    lister: listKinesisStreams,
    list: (a) => (String(a[1]).endsWith("ListStreams") ? { StreamNames: ["s"] } : undefined),
  },
  {
    name: "Route 53 records",
    lister: listRoute53RecordSets,
    list: (a) =>
      String(a[1]).includes("/rrset")
        ? undefined
        : { HostedZones: { HostedZone: [{ Id: "/hostedzone/Z1", Name: "a.example." }] } },
  },
  {
    name: "SNS",
    keepsRow: true,
    lister: listSNSTopics,
    list: (a) =>
      a[1] === "ListTopics"
        ? { ListTopicsResult: { Topics: { member: [{ TopicArn: "arn:t:1" }] } } }
        : undefined,
  },
  {
    name: "Step Functions",
    keepsRow: true,
    lister: listStepFunctions,
    list: (a) =>
      String(a[1]).endsWith("ListStateMachines")
        ? { stateMachines: [{ stateMachineArn: "arn:m", name: "m" }] }
        : undefined,
  },
  {
    name: "ACM",
    keepsRow: true,
    lister: listACMCertificates,
    list: (a) =>
      String(a[1]).endsWith("ListCertificates")
        ? { CertificateSummaryList: [{ CertificateArn: "arn:c" }] }
        : undefined,
  },
  {
    name: "WAF",
    keepsRow: true,
    lister: listWAFWebACLs,
    list: (a) =>
      String(a[1]).endsWith("ListWebACLs")
        ? { WebACLs: [{ Name: "w", Id: "1", ARN: "arn:w" }] }
        : undefined,
  },
  {
    name: "Cognito",
    keepsRow: true,
    lister: listCognitoUserPools,
    list: (a) =>
      String(a[1]).endsWith("ListUserPools") ? { UserPools: [{ Id: "p", Name: "p" }] } : undefined,
  },
];

describe.each(rowCases)("a failed describe in $name", ({ lister, list, keepsRow }) => {
  it("fails the list on a throttle or a 5xx, so the row is not pruned", async () => {
    for (const failure of [
      new Error("AWS x failed: 500: InternalFailure"),
      new Error("AWS x failed: 400: <Code>Throttling</Code>"),
    ]) {
      const ctx = rowCtx(list, () => {
        throw failure;
      });
      await expect(lister(ctx, "acct")).rejects.toBe(failure);
    }
  });

  it("fails the list on an expired credential", async () => {
    const failure = new Error("AWS x failed: 403: ExpiredToken");
    const ctx = rowCtx(list, () => {
      throw failure;
    });
    await expect(lister(ctx, "acct")).rejects.toBe(failure);
  });

  it(
    keepsRow
      ? "keeps the row when refused"
      : "keeps stored rows without an error when every row is refused",
    async () => {
      const ctx = rowCtx(list, () => {
        throw new Error("AWS x failed: 403: AccessDenied");
      });
      const { value, unread } = await inListScope(() => lister(ctx, "acct"));
      expect(value).toHaveLength(keepsRow ? 1 : 0);
      expect(unread).toEqual(keepsRow ? [] : WHOLE_TYPE_UNREAD);
    },
  );
});

describe.each(rowCases.filter((c) => !c.keepsRow))(
  "every describe refused in $name, where nobody keeps the rows",
  ({ lister, list }) => {
    it("fails with the refusal rather than returning none", async () => {
      const refusal = new Error("AWS x failed: 403: AccessDenied");
      const ctx = rowCtx(list, () => {
        throw refusal;
      });
      await expect(lister(ctx, "acct")).rejects.toBe(refusal);
    });
  },
);

describe("a describe refused for only some rows", () => {
  it("leaves those out and names nothing unread", async () => {
    let calls = 0;
    const ctx = rowCtx(
      (a) => (String(a[1]).endsWith("ListTables") ? { TableNames: ["t1", "t2"] } : undefined),
      () => {
        if (++calls === 1) throw new Error("AWS x failed: 403: AccessDenied");
        return { Table: {} };
      },
    );
    const { value, unread } = await inListScope(() => listDynamoDBTables(ctx, "acct"));
    expect(value).toHaveLength(1);
    expect(unread).toEqual([]);
  });
});

describe("a row deleted between the list and its describe", () => {
  it.each([
    ["DynamoDB", listDynamoDBTables, rowCases[2]!.list, "ResourceNotFoundException"],
    ["ECS", listECSServices, rowCases[1]!.list, "ClusterNotFoundException"],
    ["SQS", listSQSQueues, rowCases[3]!.list, "AWS.SimpleQueueService.NonExistentQueue"],
    ["Route 53", listRoute53RecordSets, rowCases[6]!.list, "NoSuchHostedZone"],
  ])("%s leaves it out", async (_name, lister, list, code) => {
    const ctx = rowCtx(list, () => {
      throw new Error(`AWS x failed: 400: ${code}`);
    });
    expect(await lister(ctx, "acct")).toEqual([]);
  });
});

describe("Bedrock inference profiles", () => {
  it("reads a refusal as none, and fails on anything else", async () => {
    const make = (profiles: Answer) => {
      const { http } = fakeHost((url) =>
        url.pathname === "/foundation-models"
          ? { status: 200, body: JSON.stringify({ modelSummaries: [] }) }
          : profiles,
      );
      return {
        ...rowCtx(
          () => ({}),
          () => ({}),
        ),
        creds: { ...CREDS, http },
      };
    };
    expect(await listBedrockModels(make(accessDenied()), "acct")).toEqual([]);
    await expect(listBedrockModels(make(serverError()), "acct")).rejects.toThrow(/failed: 500/);
  });
});

describe("lists past their cap throw rather than return as complete", () => {
  let n = 0;
  const next = () => `t${++n}`;
  const cases: Array<{
    name: string;
    lister: (ctx: ListerContext, accountId: string) => Promise<ResourceInstance[]>;
    page: () => unknown;
  }> = [
    {
      name: "Lambda",
      lister: listLambdaFunctions,
      page: () => ({ Functions: [{ FunctionName: "f" }], NextMarker: next() }),
    },
    {
      name: "Auto Scaling groups",
      lister: listAutoScalingGroups,
      page: () => ({ DescribeAutoScalingGroupsResult: { NextToken: next() } }),
    },
    {
      name: "Redshift clusters",
      lister: listRedshiftClusters,
      page: () => ({ DescribeClustersResult: { Marker: next() } }),
    },
    {
      name: "ElastiCache serverless caches",
      lister: listElastiCacheServerlessCaches,
      page: () => ({ DescribeServerlessCachesResult: { NextToken: next() } }),
    },
    {
      name: "classic load balancers",
      lister: listClassicELBs,
      page: () => ({ DescribeLoadBalancersResult: { NextMarker: next() } }),
    },
  ];

  it.each(cases)("$name", async ({ lister, page }) => {
    const call = vi.fn(async () => page());
    const ctx = rowCtx(
      () => undefined,
      () => page(),
    );
    Object.assign(ctx, { jsonGet: call, ec2Query: call });
    await expect(lister(ctx, "acct")).rejects.toThrow("has more than Infrawrench reads");
    expect(call).toHaveBeenCalledTimes(1000);
  });

  it("Bedrock inference profiles", async () => {
    let page = 0;
    const { http, request } = fakeHost((url) =>
      url.pathname === "/foundation-models"
        ? { status: 200, body: JSON.stringify({ modelSummaries: [] }) }
        : { status: 200, body: JSON.stringify({ nextToken: `t${++page}` }) },
    );
    const ctx = {
      ...rowCtx(
        () => ({}),
        () => ({}),
      ),
      creds: { ...CREDS, http },
    };
    await expect(listBedrockModels(ctx, "acct")).rejects.toThrow("has more than Infrawrench reads");
    expect(request).toHaveBeenCalledTimes(1001);
  });
});

describe("fetchSigned on a throttle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const signed = (http: HttpHostServices) =>
    fetchSigned({
      method: "GET",
      url: "https://lambda.us-east-1.amazonaws.com/x",
      headers: {},
      service: "lambda",
      credentials: { ...CREDS, http },
    });

  it("retries and returns the answer that got through", async () => {
    vi.useFakeTimers();
    const answers = [throttled(), throttled(), { status: 200, body: "ok" }] as const;
    let i = 0;
    const { http, request } = fakeHost(() => answers[i++]);
    const pending = signed(http);
    await vi.runAllTimersAsync();
    expect(await (await pending).text()).toBe("ok");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("gives up with an error the poller reads as a rate limit", async () => {
    vi.useFakeTimers();
    const { http, request } = fakeHost(() => throttled());
    const pending = signed(http).catch((err: unknown) => err);
    await vi.runAllTimersAsync();
    const failure = (await pending) as Error;
    expect(failure.message).toMatch(/rate limit/);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("does not retry anything else", async () => {
    const { http, request } = fakeHost(() => serverError());
    await expect(signed(http)).rejects.toThrow(/failed: 500/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("carries the status and the code from the header REST-JSON uses", async () => {
    const { http } = fakeHost(() => accessDenied());
    await expect(signed(http)).rejects.toMatchObject({
      status: 403,
      code: "AccessDeniedException",
    });
  });
});

describe("Inspector's region handling", () => {
  it("reads a missing endpoint, seen through fetch's cause, as a skipped region", async () => {
    const findings = await fetchAwsVulnerabilityFindings({
      regions: ["us-east-1", "me-central-1"],
      listFindings: async (region) => {
        if (region === "me-central-1") {
          throw noSuchHost("inspector2.me-central-1.amazonaws.com");
        }
        return { findings: [] };
      },
    });
    expect(findings).toEqual([]);
  });

  it("fails on EC2-style AuthFailure rather than skipping the region", async () => {
    await expect(
      fetchAwsVulnerabilityFindings({
        regions: ["us-east-1"],
        listFindings: async () => {
          throw new Error("AWS inspector2 POST /findings/list failed: 401: AuthFailure");
        },
      }),
    ).rejects.toThrow(/AuthFailure/);
  });
});
