import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { ListerContext } from "../resource-listers.js";
import type { MetricsContext } from "../metrics/cw-helpers.js";

const fetchSigned = vi.fn();
vi.mock("../signed-request.js", () => ({ fetchSigned: (...a: unknown[]) => fetchSigned(...a) }));

import {
  listBedrockModels,
  listElastiCacheServerlessCaches,
} from "../resource-listers-extended.js";
import { foundationModelIdFromArn } from "../resource-listers-extended/compute.js";
import { bedrockModelMetrics } from "../metrics/misc-metrics.js";
import { elastiCacheServerlessCacheMetrics } from "../metrics/db-metrics.js";
import {
  buildLambdaConfigurationUpdate,
  buildServerlessCacheModifyParams,
} from "../update-handlers.js";
import { parseXml } from "../xml.js";

function makeCtx(
  ec2Query?: (service: string, action: string, params?: Record<string, string>) => unknown,
): ListerContext {
  return {
    ec2: vi.fn(async () => ({})) as never,
    json: vi.fn(async () => ({})) as never,
    jsonGet: vi.fn(async () => ({})) as never,
    restJson: vi.fn(async () => ({})) as never,
    ec2Query: vi.fn(
      async (service: string, action: string, _v: string, params?: Record<string, string>) =>
        ec2Query?.(service, action, params) ?? {},
    ) as never,
    xmlGet: vi.fn(async () => ({})) as never,
    id: (a, t, e) => `${a}:${t}:${e}`,
    now: () => "2020-01-01T00:00:00Z",
    region: "us-east-1",
    creds: { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-1" },
  };
}

// Braces matter: a function returned from beforeEach is run as its teardown,
// and mockReset returns the mock itself.
beforeEach(() => {
  fetchSigned.mockReset();
});

function jsonResponse(body: unknown) {
  return { json: async () => body };
}

const FOUNDATION_MODELS = {
  modelSummaries: [
    {
      modelId: "amazon.titan-text-express-v1",
      modelName: "Titan Text Express",
      providerName: "Amazon",
      modelArn: "arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-text-express-v1",
      outputModalities: ["TEXT"],
      inferenceTypesSupported: ["ON_DEMAND"],
      responseStreamingSupported: true,
      modelLifecycle: { status: "LEGACY" },
    },
    {
      modelId: "anthropic.claude-sonnet-4-5-20250929-v1:0",
      modelName: "Claude Sonnet 4.5",
      providerName: "Anthropic",
      outputModalities: ["TEXT"],
      inferenceTypesSupported: ["INFERENCE_PROFILE"],
      responseStreamingSupported: true,
      modelLifecycle: { status: "ACTIVE" },
    },
    {
      modelId: "amazon.titan-embed-text-v2:0",
      outputModalities: ["EMBEDDING"],
      inferenceTypesSupported: ["ON_DEMAND"],
    },
  ],
};

const SONNET_ARN = (region: string) =>
  `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0`;

describe("listBedrockModels", () => {
  it("lists on-demand text models plus inference profiles over text models", async () => {
    fetchSigned.mockImplementation(async ({ url }: { url: string }) => {
      if (url.includes("/foundation-models")) return jsonResponse(FOUNDATION_MODELS);
      if (url.includes("nextToken=t2")) {
        return jsonResponse({
          inferenceProfileSummaries: [
            {
              inferenceProfileId: "app123",
              inferenceProfileArn:
                "arn:aws:bedrock:us-east-1:111122223333:application-inference-profile/app123",
              inferenceProfileName: "team-chat",
              type: "APPLICATION",
              status: "ACTIVE",
              models: [{ modelArn: SONNET_ARN("us-east-1") }],
            },
          ],
        });
      }
      return jsonResponse({
        inferenceProfileSummaries: [
          {
            inferenceProfileId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
            inferenceProfileArn: "arn:profile/us.sonnet",
            inferenceProfileName: "US Claude Sonnet 4.5",
            type: "SYSTEM_DEFINED",
            status: "ACTIVE",
            models: [{ modelArn: SONNET_ARN("us-east-1") }, { modelArn: SONNET_ARN("us-west-2") }],
          },
          {
            // Routes only to an embedding model: not chat-capable.
            inferenceProfileId: "us.amazon.titan-embed-text-v2:0",
            type: "SYSTEM_DEFINED",
            status: "ACTIVE",
            models: [
              {
                modelArn:
                  "arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0",
              },
            ],
          },
        ],
        nextToken: "t2",
      });
    });

    const out = await listBedrockModels(makeCtx(), "acct");
    const ids = out.map((r) => r.fields.modelId);
    expect(ids).toEqual([
      "amazon.titan-text-express-v1",
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "arn:aws:bedrock:us-east-1:111122223333:application-inference-profile/app123",
    ]);
    expect(out[0]!.fields.kind).toBe("foundation-model");
    expect(out[0]!.fields.lifecycleStatus).toBe("LEGACY");
    const profile = out[1]!;
    expect(profile.fields.kind).toBe("inference-profile");
    expect(profile.fields.providerName).toBe("Anthropic");
    // Both regions' ARNs name the same model, so it is listed once.
    expect(profile.fields.sourceModels).toBe("anthropic.claude-sonnet-4-5-20250929-v1:0");
    expect(profile.displayName).toBe("US Claude Sonnet 4.5");
    expect(profile.resolvedOutputs.arn).toBe("arn:profile/us.sonnet");
    expect(out[2]!.fields.kind).toBe("application-inference-profile");
  });

  it("keeps the on-demand models when the profile listing is denied", async () => {
    fetchSigned.mockImplementation(async ({ url }: { url: string }) => {
      if (url.includes("/foundation-models")) return jsonResponse(FOUNDATION_MODELS);
      throw new Error("AccessDeniedException");
    });
    const out = await listBedrockModels(makeCtx(), "acct");
    expect(out.map((r) => r.fields.modelId)).toEqual(["amazon.titan-text-express-v1"]);
  });

  it("extracts model ids from foundation-model ARNs", () => {
    expect(foundationModelIdFromArn(SONNET_ARN("eu-west-1"))).toBe(
      "anthropic.claude-sonnet-4-5-20250929-v1:0",
    );
    expect(foundationModelIdFromArn("arn:aws:bedrock:us-east-1:1:custom-model/x")).toBe("");
  });
});

const SERVERLESS_XML = `<?xml version="1.0"?>
<DescribeServerlessCachesResponse xmlns="http://elasticache.amazonaws.com/doc/2015-02-02/">
  <DescribeServerlessCachesResult>
    <ServerlessCaches>
      <member>
        <ServerlessCacheName>sessions</ServerlessCacheName>
        <Engine>valkey</Engine>
        <MajorEngineVersion>8</MajorEngineVersion>
        <FullEngineVersion>8.0</FullEngineVersion>
        <Status>available</Status>
        <Description>web sessions</Description>
        <CacheUsageLimits>
          <DataStorage><Maximum>10</Maximum><Unit>GB</Unit></DataStorage>
          <ECPUPerSecond><Maximum>50000</Maximum></ECPUPerSecond>
        </CacheUsageLimits>
        <Endpoint><Address>sessions-abc.serverless.use1.cache.amazonaws.com</Address><Port>6379</Port></Endpoint>
        <ReaderEndpoint><Address>sessions-abc.serverless.use1.cache.amazonaws.com</Address><Port>6380</Port></ReaderEndpoint>
        <ARN>arn:aws:elasticache:us-east-1:1:serverlesscache:sessions</ARN>
        <SecurityGroupIds><SecurityGroupId>sg-1</SecurityGroupId></SecurityGroupIds>
        <SubnetIds><SubnetId>subnet-a</SubnetId><SubnetId>subnet-b</SubnetId></SubnetIds>
        <SnapshotRetentionLimit>7</SnapshotRetentionLimit>
        <DailySnapshotTime>04:00</DailySnapshotTime>
        <NetworkType>ipv4</NetworkType>
      </member>
      <member>
        <ServerlessCacheName>mc</ServerlessCacheName>
        <Engine>memcached</Engine>
        <Status>creating</Status>
      </member>
    </ServerlessCaches>
  </DescribeServerlessCachesResult>
</DescribeServerlessCachesResponse>`;

describe("listElastiCacheServerlessCaches", () => {
  it("parses the documented XML shape", async () => {
    const out = await listElastiCacheServerlessCaches(
      makeCtx(() => parseXml(SERVERLESS_XML)),
      "acct",
    );
    expect(out).toHaveLength(2);
    const v = out[0]!;
    expect(v.id).toBe("acct:elasticache-serverless-cache:sessions");
    expect(v.fields.engine).toBe("valkey");
    expect(v.fields.engineVersion).toBe("8.0");
    expect(v.fields.maxDataStorageGb).toBe(10);
    expect(v.fields.maxEcpuPerSecond).toBe(50000);
    expect(v.fields.connectionType).toBe("vpc");
    expect(v.fields.subnetIds).toBe("subnet-a, subnet-b");
    expect(v.fields.securityGroupIds).toBe("sg-1");
    expect(v.resolvedOutputs.connectionString).toBe(
      "rediss://sessions-abc.serverless.use1.cache.amazonaws.com:6379",
    );
    expect(v.resolvedOutputs.readerEndpoint).toBe(
      "sessions-abc.serverless.use1.cache.amazonaws.com",
    );
    // Memcached has no rediss:// form, and no endpoint while creating.
    expect(out[1]!.resolvedOutputs.connectionString).toBe("");
  });

  it("follows NextToken", async () => {
    const tokens: Array<string | undefined> = [];
    const ctx = makeCtx((_s, _a, params) => {
      tokens.push(params?.["NextToken"]);
      return params?.["NextToken"]
        ? {
            DescribeServerlessCachesResult: {
              ServerlessCaches: { member: [{ ServerlessCacheName: "b" }] },
            },
          }
        : {
            DescribeServerlessCachesResult: {
              ServerlessCaches: { member: [{ ServerlessCacheName: "a" }] },
              NextToken: "n1",
            },
          };
    });
    const out = await listElastiCacheServerlessCaches(ctx, "acct");
    expect(out.map((r) => r.externalId)).toEqual(["a", "b"]);
    expect(tokens).toEqual([undefined, "n1"]);
  });
});

describe("buildLambdaConfigurationUpdate", () => {
  it("sends only the changed settings", () => {
    expect(buildLambdaConfigurationUpdate({ memorySize: "1024" })).toEqual({ MemorySize: 1024 });
    expect(buildLambdaConfigurationUpdate({ timeout: "60", ephemeralStorageMb: "4096" })).toEqual({
      Timeout: 60,
      EphemeralStorage: { Size: 4096 },
    });
    expect(buildLambdaConfigurationUpdate({ runtime: "python3.14" })).toEqual({
      Runtime: "python3.14",
    });
    expect(buildLambdaConfigurationUpdate({ memorySize: "" })).toEqual({});
  });

  it("pairs log levels with the JSON format", () => {
    expect(buildLambdaConfigurationUpdate({ applicationLogLevel: "ERROR" })).toEqual({
      LoggingConfig: { LogFormat: "JSON", ApplicationLogLevel: "ERROR" },
    });
    expect(buildLambdaConfigurationUpdate({ logFormat: "Text", systemLogLevel: "DEBUG" })).toEqual({
      LoggingConfig: { LogFormat: "Text" },
    });
  });

  it("rejects values Lambda would refuse", () => {
    expect(() => buildLambdaConfigurationUpdate({ memorySize: "64" })).toThrow(/memorySize/);
    expect(() => buildLambdaConfigurationUpdate({ timeout: "901" })).toThrow(/timeout/);
    expect(() => buildLambdaConfigurationUpdate({ ephemeralStorageMb: "abc" })).toThrow(/number/);
  });
});

describe("buildServerlessCacheModifyParams", () => {
  it("re-sends the unchanged usage limit alongside the changed one", () => {
    expect(
      buildServerlessCacheModifyParams(
        "c",
        { maxEcpuPerSecond: "100000" },
        { maxDataStorageGb: 10, maxEcpuPerSecond: 5000 },
      ),
    ).toEqual({
      ServerlessCacheName: "c",
      "CacheUsageLimits.DataStorage.Maximum": "10",
      "CacheUsageLimits.DataStorage.Unit": "GB",
      "CacheUsageLimits.ECPUPerSecond.Maximum": "100000",
    });
  });

  it("maps snapshot settings and description", () => {
    expect(
      buildServerlessCacheModifyParams(
        "c",
        { snapshotRetentionLimit: "7", dailySnapshotTime: "05:00", description: "d" },
        {},
      ),
    ).toEqual({
      ServerlessCacheName: "c",
      Description: "d",
      SnapshotRetentionLimit: "7",
      DailySnapshotTime: "05:00",
    });
    expect(() =>
      buildServerlessCacheModifyParams("c", { snapshotRetentionLimit: "36" }, {}),
    ).toThrow(/between 0 and 35/);
    expect(() => buildServerlessCacheModifyParams("c", { maxDataStorageGb: "-1" }, {})).toThrow(
      /at least 0/,
    );
  });
});

function res(fields: Record<string, unknown>, externalId = ""): ResourceInstance {
  return {
    id: "x",
    pluginId: "aws",
    resourceTypeId: "t",
    accountId: "a",
    displayName: "x",
    fields: fields as ResourceInstance["fields"],
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    createdAt: "",
    updatedAt: "",
  };
}

function ctxWithData(): { ctx: MetricsContext; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const ctx: MetricsContext = {
    creds: { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-1" },
    start: 0,
    end: 3600_000,
    period: 60,
    fetchCw: (async (ns: string, metric: string, dims: unknown, stat: string) => {
      calls.push([ns, metric, dims, stat]);
      return { label: metric, unit: "Count", points: [{ timestamp: 1, value: 1 }] };
    }) as MetricsContext["fetchCw"],
  };
  return { ctx, calls };
}

describe("new metric handlers", () => {
  it("bedrockModelMetrics queries AWS/Bedrock by ModelId", async () => {
    const { ctx, calls } = ctxWithData();
    const out = await bedrockModelMetrics(ctx, res({ modelId: "us.anthropic.x" }));
    expect(out.length).toBe(11);
    expect(calls[0]![0]).toBe("AWS/Bedrock");
    expect(calls[0]![2]).toEqual([{ Name: "ModelId", Value: "us.anthropic.x" }]);
    expect(out.find((s) => s.label === "Latency")!.unit).toBe("ms");
    expect(await bedrockModelMetrics(ctx, res({}))).toEqual([]);
  });

  it("elastiCacheServerlessCacheMetrics uses the lowercase clusterId dimension", async () => {
    const { ctx, calls } = ctxWithData();
    const out = await elastiCacheServerlessCacheMetrics(ctx, res({ name: "sessions" }));
    expect(out.length).toBe(14);
    expect(calls[0]![2]).toEqual([{ Name: "clusterId", Value: "sessions" }]);
    expect(out.find((s) => s.label === "Read Latency")!.unit).toBe("μs");
    expect(await elastiCacheServerlessCacheMetrics(ctx, res({}))).toEqual([]);
  });
});
