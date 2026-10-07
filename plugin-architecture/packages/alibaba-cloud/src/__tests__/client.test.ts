import { describe, expect, it } from "vitest";
import { AliApiError, flattenParams } from "../api.js";
import { billToRows, parseBillTags, parseMoney } from "../billing.js";
import { analyseRules, apiEndpointOf, parseListBuckets } from "../listers.js";
import { parseDatapoints } from "../metrics.js";
import { plugin } from "../plugin.js";
import { regionIdForLabel } from "../regions.js";
import { parseStatusFeed } from "../status-feed.js";
import { makeClient } from "./helpers.js";

const instance = (id: string, region: string) => ({
  InstanceId: id,
  InstanceName: `vm-${id}`,
  RegionId: region,
  ZoneId: `${region}-a`,
  InstanceType: "ecs.g7.large",
  Cpu: 2,
  Memory: 8192,
  Status: "Running",
  InstanceChargeType: "PostPaid",
  PublicIpAddress: { IpAddress: ["47.1.2.3"] },
  VpcAttributes: {
    VpcId: "vpc-1",
    VSwitchId: "vsw-1",
    PrivateIpAddress: { IpAddress: ["10.0.0.5"] },
  },
  SecurityGroupIds: { SecurityGroupId: ["sg-1", "sg-2"] },
  CreationTime: "2026-01-02T03:04Z",
});

describe("transport", () => {
  it("signs RPC calls with ACS3 and pages DescribeInstances by NextToken in every region", async () => {
    const { client, calls } = makeClient((req) => {
      if (req.action !== "DescribeInstances") return undefined;
      const region = req.params["RegionId"]!;
      if (region === "ap-southeast-1" && !req.params["NextToken"]) {
        return { body: { Instances: { Instance: [instance("i-a", region)] }, NextToken: "t2" } };
      }
      if (region === "ap-southeast-1") {
        return { body: { Instances: { Instance: [instance("i-b", region)] } } };
      }
      return { body: { Instances: { Instance: [instance("i-c", region)] } } };
    });
    const list = await client.listResources("ecs-instance", "acct");
    expect(list.map((r) => r.externalId).sort()).toEqual([
      "ap-southeast-1/i-a",
      "ap-southeast-1/i-b",
      "eu-central-1/i-c",
    ]);
    const first = list.find((r) => r.externalId === "ap-southeast-1/i-a")!;
    expect(first.resolvedOutputs).toMatchObject({
      publicIp: "47.1.2.3",
      privateIp: "10.0.0.5",
      id: "i-a",
    });
    expect(first.fields).toMatchObject({
      memoryGb: 8,
      securityGroupIds: "sg-1, sg-2",
      sshUsername: "root",
    });
    const call = calls[0]!;
    expect(call.url.host).toMatch(/^ecs\.(ap-southeast-1|eu-central-1)\.aliyuncs\.com$/);
    expect(call.method).toBe("POST");
    expect(call.headers["x-acs-version"]).toBe("2014-05-26");
    expect(call.headers["authorization"]).toMatch(
      /^ACS3-HMAC-SHA256 Credential=LTAI5ttest,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=[0-9a-f]{64}$/,
    );
  });

  it("lists a refused region as empty but throws when every region refuses", async () => {
    const partial = makeClient((req) =>
      req.params["RegionId"] === "eu-central-1"
        ? { status: 403, body: { Code: "Forbidden.RAM", Message: "no" } }
        : {
            body: {
              Vpcs: { Vpc: [{ VpcId: "vpc-1", VpcName: "main", CidrBlock: "10.0.0.0/8" }] },
              TotalCount: 1,
            },
          },
    );
    expect(await partial.client.listResources("vpc", "acct")).toHaveLength(1);

    const refused = makeClient(() => ({
      status: 403,
      body: { Code: "Forbidden.RAM", Message: "no" },
    }));
    await expect(refused.client.listResources("vpc", "acct")).rejects.toMatchObject({
      status: 403,
      code: "Forbidden.RAM",
    });
  });

  it("maps errors to AliApiError with the HTTP status and retries throttling", async () => {
    let n = 0;
    const { client } = makeClient((req) => {
      if (req.action !== "GetCallerIdentity") return undefined;
      n++;
      return n === 1
        ? { status: 400, body: { Code: "Throttling.User", Message: "slow down" } }
        : { body: { AccountId: "5123", Arn: "acs:ram::5123:user/ci", IdentityType: "RAMUser" } };
    });
    const [account] = await client.listResources("account", "acct");
    expect(account?.externalId).toBe("5123");
    expect(n).toBe(2);

    const bad = makeClient(() => ({
      status: 404,
      body: { Code: "InvalidAccessKeyId.NotFound", Message: "Specified access key is not found." },
    }));
    const err = await bad.client.listResources("account", "acct").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AliApiError);
    expect((err as AliApiError).status).toBe(404);
  });

  it("sends Quota Center parameters as a signed form body", async () => {
    const { client, calls } = makeClient((req) =>
      req.action === "ListProductQuotas"
        ? {
            body: {
              Quotas: [
                {
                  QuotaActionCode: "q_vcpu",
                  QuotaName: "vCPUs",
                  TotalQuota: 500,
                  TotalUsage: 40,
                  Consumable: true,
                  Adjustable: true,
                },
                {
                  QuotaActionCode: "q_static",
                  QuotaName: "Static",
                  TotalQuota: 10,
                  Consumable: false,
                },
              ],
            },
          }
        : undefined,
    );
    const quotas = await client.fetchQuotas("acct");
    expect(quotas).toEqual([
      expect.objectContaining({
        id: "ecs/q_vcpu/ap-southeast-1",
        limit: 500,
        used: 40,
        adjustable: true,
      }),
      expect.objectContaining({ id: "vpc/q_vcpu/ap-southeast-1" }),
    ]);
    const call = calls[0]!;
    expect(call.url.host).toBe("quotas.aliyuncs.com");
    expect(call.url.search).toBe("");
    expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(call.params).toMatchObject({
      ProductCode: "ecs",
      "Dimensions.1.Key": "regionId",
      "Dimensions.1.Value": "ap-southeast-1",
    });
  });

  it("flattens list and object parameters the SDK way", () => {
    expect(
      flattenParams({
        Tag: [{ Key: "a", Value: "b" }],
        SystemDisk: { Size: 40 },
        Ids: ["x", "y"],
        Empty: "",
      }),
    ).toEqual({
      "Tag.1.Key": "a",
      "Tag.1.Value": "b",
      "SystemDisk.Size": "40",
      "Ids.1": "x",
      "Ids.2": "y",
    });
  });
});

describe("OSS", () => {
  it("lists buckets with an OSS4 signature and parses the XML", async () => {
    const xml = `<?xml version="1.0"?><ListAllMyBucketsResult><Buckets><Bucket><CreationDate>2026-01-01T00:00:00.000Z</CreationDate><Name>logs</Name><Region>eu-central-1</Region><Location>oss-eu-central-1</Location><StorageClass>Standard</StorageClass></Bucket></Buckets></ListAllMyBucketsResult>`;
    const { client, calls } = makeClient((req) => {
      if (req.url.host === "oss-ap-southeast-1.aliyuncs.com") return { raw: xml };
      if (req.url.host === "logs.oss-eu-central-1.aliyuncs.com") {
        return {
          raw: "<BucketInfo><Bucket><AccessControlList><Grant>public-read</Grant></AccessControlList><DataRedundancyType>LRS</DataRedundancyType><Versioning>Enabled</Versioning></Bucket></BucketInfo>",
        };
      }
      return undefined;
    });
    const [bucket] = await client.listResources("oss-bucket", "acct");
    expect(bucket).toMatchObject({
      externalId: "eu-central-1/logs",
      fields: { acl: "public-read", versioning: "Enabled", redundancyType: "LRS" },
      resolvedOutputs: { endpoint: "logs.oss-eu-central-1.aliyuncs.com" },
    });
    expect(calls[0]!.headers["authorization"]).toMatch(
      /^OSS4-HMAC-SHA256 Credential=LTAI5ttest\/\d{8}\/ap-southeast-1\/oss\/aliyun_v4_request,Signature=[0-9a-f]{64}$/,
    );
    expect(calls[0]!.headers["x-oss-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
  });

  it("parses truncated listings", () => {
    const page = parseListBuckets(
      "<ListAllMyBucketsResult><IsTruncated>true</IsTruncated><NextMarker>m2</NextMarker><Buckets></Buckets></ListAllMyBucketsResult>",
    );
    expect(page).toEqual({ buckets: [], nextMarker: "m2", truncated: true });
  });
});

describe("mappers", () => {
  it("flags SSH and RDP open to the internet", () => {
    const r = analyseRules([
      {
        Direction: "ingress",
        IpProtocol: "TCP",
        PortRange: "22/22",
        SourceCidrIp: "0.0.0.0/0",
        Policy: "Accept",
      },
      {
        Direction: "ingress",
        IpProtocol: "TCP",
        PortRange: "443/443",
        SourceCidrIp: "10.0.0.0/8",
        Policy: "Accept",
      },
      {
        Direction: "ingress",
        IpProtocol: "TCP",
        PortRange: "80/80",
        SourceCidrIp: "0.0.0.0/0",
        Policy: "Drop",
      },
    ]);
    expect(r.adminOpen).toBe(true);
    expect(r.openPorts).toBe("22");
    expect(
      analyseRules([{ IpProtocol: "ALL", PortRange: "-1/-1", SourceCidrIp: "0.0.0.0/0" }]),
    ).toMatchObject({
      adminOpen: true,
      openPorts: "all",
    });
  });

  it("reads the ACK API endpoint out of master_url", () => {
    expect(
      apiEndpointOf(
        '{"api_server_endpoint":"https://1.2.3.4:6443","intranet_api_server_endpoint":"https://10.0.0.1:6443"}',
      ),
    ).toBe("https://1.2.3.4:6443");
    expect(apiEndpointOf("")).toBe("");
  });

  it("maps region display names back to ids", () => {
    expect(
      regionIdForLabel("Network Access Abnormality in Zone B, Indonesia (Jakarta) Region"),
    ).toBe("ap-southeast-5");
    expect(regionIdForLabel("Singapore")).toBe("ap-southeast-1");
    expect(regionIdForLabel("Germany (Frankfurt)")).toBe("eu-central-1");
    expect(regionIdForLabel("Nowhere")).toBeUndefined();
  });

  it("parses CloudMonitor's stringified datapoints", () => {
    expect(parseDatapoints('[{"timestamp":1,"Average":2}]')).toEqual([
      { timestamp: 1, Average: 2 },
    ]);
    expect(parseDatapoints("not json")).toEqual([]);
  });
});

describe("billing", () => {
  it("turns daily bill items into cost rows", () => {
    const rows = billToRows("2026-09-01", [
      {
        ProductName: "Elastic Compute Service",
        InstanceID: "i-a",
        Region: "Singapore",
        PretaxAmount: 1.5,
        PretaxGrossAmount: 2,
        Currency: "USD",
        Tag: "key:env value:prod; key:team value:core",
        SubscriptionType: "PayAsYouGo",
      },
      {
        ProductName: "Elastic Compute Service",
        InstanceID: "i-a",
        Region: "Singapore",
        PretaxAmount: 0.5,
        PretaxGrossAmount: 0.5,
        Currency: "USD",
        Tag: "key:env value:prod; key:team value:core",
        SubscriptionType: "PayAsYouGo",
      },
      { ProductName: "Object Storage Service", Item: "Refund", PretaxAmount: -3, Currency: "USD" },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      date: "2026-09-01",
      service: "Elastic Compute Service",
      region: "ap-southeast-1",
      resourceId: "ap-southeast-1/i-a",
      amount: 2,
      listAmount: 2.5,
      tags: { env: "prod", team: "core", subscriptionType: "PayAsYouGo" },
    });
    expect(rows[1]).toMatchObject({ chargeType: "refund", amount: -3 });
  });

  it("parses tags and money strings", () => {
    expect(parseBillTags(undefined)).toEqual({});
    expect(parseMoney("1,234.56")).toBe(1234.56);
  });

  it("queries DescribeInstanceBill per day on the international BSS endpoint", async () => {
    const { client, calls } = makeClient((req) =>
      req.action === "DescribeInstanceBill"
        ? {
            body: {
              Success: true,
              Data: { Items: [{ ProductName: "ECS", PretaxAmount: 1, Currency: "USD" }] },
            },
          }
        : undefined,
    );
    const rows = await client.fetchCostData("acct", {
      fromDate: "2026-08-31",
      toDate: "2026-09-01",
    } as never);
    expect(rows.map((r) => r.date)).toEqual(["2026-08-31", "2026-09-01"]);
    expect(calls[0]!.url.host).toBe("business.ap-southeast-1.aliyuncs.com");
    expect(calls[1]!.params).toMatchObject({
      BillingCycle: "2026-09",
      BillingDate: "2026-09-01",
      Granularity: "DAILY",
    });
  });

  it("turns a refused bill read into a setup error", async () => {
    const { client } = makeClient(() => ({
      status: 403,
      body: { Code: "Forbidden.RAM", Message: "no" },
    }));
    await expect(
      client.fetchCostData("acct", { fromDate: "2026-09-01", toDate: "2026-09-01" } as never),
    ).rejects.toThrow(/AliyunBSSReadOnlyAccess/);
  });
});

describe("status feed", () => {
  it("keeps open incidents and drops recovered ones", () => {
    const body = JSON.stringify({
      success: true,
      data: [
        {
          id: 40,
          title: "[Incident] Network Access Anomaly in Zone B, Indonesia (Jakarta) Region",
          eventType: "ALARM",
          startTime: Date.parse("2026-10-06T10:00:00Z"),
          endTime: null,
        },
        {
          id: 41,
          title: "[Incident (Recovered)] Something in Singapore",
          eventType: "ALARM",
          startTime: 1,
        },
      ],
    });
    const incidents = parseStatusFeed(body);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      externalId: "40",
      regions: ["ap-southeast-5"],
      impact: "major",
      state: "investigating",
    });
  });
});

describe("terraform", () => {
  it("imports by the bare Alibaba id", () => {
    const out = plugin.terraformExport!.mapResource({
      id: "a:vpc:ap-southeast-1/vpc-1",
      pluginId: "alibaba-cloud",
      resourceTypeId: "vpc",
      accountId: "a",
      displayName: "main",
      externalId: "ap-southeast-1/vpc-1",
      fields: { name: "main", cidrBlock: "10.0.0.0/8", region: "ap-southeast-1" },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    });
    expect(out?.resource).toMatchObject({ type: "alicloud_vpc", importId: "vpc-1" });
  });
});
