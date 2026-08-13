import { describe, it, expect, vi } from "vitest";
import type { ListerContext } from "../resource-listers.js";
import {
  listEC2Instances,
  listEBSVolumes,
  listVPCs,
  listEKSClusters,
  listRDSInstances,
  listS3Buckets,
  listLambdaFunctions,
  listECSServices,
  listDynamoDBTables,
  listElastiCacheClusters,
  listSQSQueues,
  listSNSTopics,
  listECRRepositories,
  listSecretsManagerSecrets,
  listCloudFrontDistributions,
  listIAMUsers,
} from "../resource-listers.js";
import { parseXml } from "../xml.js";

interface MockResponses {
  ec2?: (action: string, params?: Record<string, string>) => unknown;
  json?: (service: string, target: string, body: Record<string, unknown>) => unknown;
  jsonGet?: (service: string, path: string) => unknown;
  ec2Query?: (service: string, action: string, version: string) => unknown;
  xmlGet?: (service: string, path?: string) => unknown;
  restJson?: (service: string, path: string) => unknown;
}

function makeCtx(r: MockResponses): ListerContext {
  return {
    ec2: vi.fn(async (action, params) => r.ec2?.(action, params) ?? {}) as ListerContext["ec2"],
    json: vi.fn(
      async (service, target, body) => r.json?.(service, target, body) ?? {},
    ) as ListerContext["json"],
    jsonGet: vi.fn(
      async (service, path) => r.jsonGet?.(service, path) ?? {},
    ) as ListerContext["jsonGet"],
    restJson: vi.fn(
      async (service, path) => r.restJson?.(service, path) ?? {},
    ) as ListerContext["restJson"],
    ec2Query: vi.fn(
      async (service, action, version) => r.ec2Query?.(service, action, version) ?? {},
    ) as ListerContext["ec2Query"],
    xmlGet: vi.fn(
      async (service, path) => r.xmlGet?.(service, path) ?? {},
    ) as ListerContext["xmlGet"],
    id: (a, t, e) => `${a}:${t}:${e}`,
    now: () => "2020-01-01T00:00:00Z",
    region: "us-east-1",
    creds: { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-1" },
  };
}

describe("listEC2Instances", () => {
  it("maps instances, AMI usernames, and SSH access summaries", async () => {
    const ctx = makeCtx({
      ec2: (action) => {
        if (action === "DescribeInstances")
          return {
            reservationSet: {
              item: {
                instancesSet: {
                  item: {
                    instanceId: "i-1",
                    instanceState: { name: "running" },
                    instanceType: "t3.micro",
                    imageId: "ami-1",
                    placement: { availabilityZone: "us-east-1a" },
                    ipAddress: "1.2.3.4",
                    privateIpAddress: "10.0.0.1",
                    dnsName: "ec2.example.com",
                    vpcId: "vpc-1",
                    subnetId: "subnet-1",
                    groupSet: { item: { groupId: "sg-1" } },
                    tagSet: { item: { key: "Name", value: "web" } },
                    launchTime: "2020-01-01T00:00:00Z",
                  },
                },
              },
            },
          };
        if (action === "DescribeImages")
          return { imagesSet: { item: { imageId: "ami-1", name: "ubuntu-22.04" } } };
        if (action === "DescribeSecurityGroups")
          return {
            securityGroupInfo: {
              item: {
                groupId: "sg-1",
                ipPermissions: {
                  item: {
                    ipProtocol: "tcp",
                    fromPort: 22,
                    toPort: 22,
                    ipRanges: { item: { cidrIp: "0.0.0.0/0" } },
                  },
                },
              },
            },
          };
        return {};
      },
    });
    const out = await listEC2Instances(ctx, "acct");
    expect(out).toHaveLength(1);
    expect(out[0]!.displayName).toBe("web");
    expect(out[0]!.fields.sshUsername).toBe("ubuntu");
    expect(String(out[0]!.fields.sshAccess)).toContain("open to the world");
    expect(out[0]!.resolvedOutputs.publicIp).toBe("1.2.3.4");
  });

  it("warns when no SG exposes port 22 and tolerates describe failures", async () => {
    const ctx = makeCtx({
      ec2: (action) => {
        if (action === "DescribeInstances")
          return {
            reservationSet: {
              item: {
                instancesSet: {
                  item: { instanceId: "i-2", instanceState: { name: "running" }, imageId: "" },
                },
              },
            },
          };
        if (action === "DescribeImages") throw new Error("denied");
        if (action === "DescribeSecurityGroups") throw new Error("denied");
        return {};
      },
    });
    const out = await listEC2Instances(ctx, "acct");
    expect(String(out[0]!.fields.sshAccess)).toContain("not exposed");
    expect(out[0]!.fields.sshUsername).toBe("");
  });

  it("reports a restricted-CIDR list", async () => {
    const ctx = makeCtx({
      ec2: (action) => {
        if (action === "DescribeInstances")
          return {
            reservationSet: {
              item: {
                instancesSet: {
                  item: {
                    instanceId: "i-3",
                    instanceState: { name: "running" },
                    imageId: "ami-x",
                    groupSet: { item: { groupId: "sg-9" } },
                  },
                },
              },
            },
          };
        if (action === "DescribeImages") return { imagesSet: {} };
        if (action === "DescribeSecurityGroups")
          return {
            securityGroupInfo: {
              item: {
                groupId: "sg-9",
                ipPermissions: {
                  item: {
                    ipProtocol: "-1",
                    ipRanges: { item: { cidrIp: "10.0.0.0/8" } },
                  },
                },
              },
            },
          };
        return {};
      },
    });
    const out = await listEC2Instances(ctx, "acct");
    expect(String(out[0]!.fields.sshAccess)).toContain("10.0.0.0/8");
  });
});

describe("listEBSVolumes", () => {
  it("maps volumes with attachment + name tag", async () => {
    const ctx = makeCtx({
      ec2: () => ({
        volumeSet: {
          item: {
            volumeId: "vol-1",
            availabilityZone: "us-east-1a",
            size: 100,
            volumeType: "gp3",
            status: "in-use",
            encrypted: "true",
            attachmentSet: { item: { instanceId: "i-1" } },
            tagSet: { item: { key: "Name", value: "data" } },
            createTime: "2020-01-01T00:00:00Z",
          },
        },
      }),
    });
    const out = await listEBSVolumes(ctx, "acct");
    expect(out[0]!.displayName).toBe("data");
    expect(out[0]!.fields.attachedTo).toBe("i-1");
    expect(out[0]!.fields.encrypted).toBe(true);
  });
});

describe("listVPCs", () => {
  it("maps vpcs", async () => {
    const ctx = makeCtx({
      ec2: () => ({
        vpcSet: {
          item: { vpcId: "vpc-1", cidrBlock: "10.0.0.0/16", state: "available", isDefault: "true" },
        },
      }),
    });
    const out = await listVPCs(ctx, "acct");
    expect(out[0]!.fields.isDefault).toBe(true);
    expect(out[0]!.displayName).toBe("vpc-1");
  });
});

describe("listEKSClusters", () => {
  it("maps clusters, node groups, and builds kubeconfig", async () => {
    const ctx = makeCtx({
      jsonGet: (_s, path) => {
        if (path === "/clusters") return { clusters: ["c1"] };
        if (path === "/clusters/c1")
          return {
            cluster: {
              version: "1.29",
              status: "ACTIVE",
              endpoint: "https://eks.example.com",
              certificateAuthority: { data: "CA" },
              roleArn: "arn:role",
              createdAt: "2020-01-01T00:00:00Z",
            },
          };
        if (path === "/clusters/c1/node-groups") return { nodegroups: ["ng1"] };
        if (path === "/clusters/c1/node-groups/ng1")
          return {
            nodegroup: {
              scalingConfig: { desiredSize: 3 },
              instanceTypes: ["t3.large"],
              diskSize: 20,
            },
          };
        return {};
      },
    });
    const out = await listEKSClusters(ctx, "acct");
    expect(out[0]!.fields.nodeCount).toBe(3);
    expect(out[0]!.fields.instanceTypes).toBe("t3.large");
    expect(String(out[0]!.resolvedOutputs.kubeconfig)).toContain("kind: Config");
  });

  it("skips clusters that fail to describe and tolerates missing node groups", async () => {
    const ctx = makeCtx({
      jsonGet: (_s, path) => {
        if (path === "/clusters") return { clusters: ["good", "bad"] };
        if (path === "/clusters/good")
          return { cluster: { status: "ACTIVE", endpoint: "e", certificateAuthority: {} } };
        if (path === "/clusters/good/node-groups") throw new Error("denied");
        if (path === "/clusters/bad") throw new Error("denied");
        return {};
      },
    });
    const out = await listEKSClusters(ctx, "acct");
    expect(out).toHaveLength(1);
    expect(out[0]!.fields.nodeGroupCount).toBe(0);
  });
});

describe("listRDSInstances", () => {
  it("builds connection strings per engine", async () => {
    const ctx = makeCtx({
      ec2Query: () => ({
        DescribeDBInstancesResult: {
          DBInstances: {
            DBInstance: [
              {
                DBInstanceIdentifier: "db1",
                Engine: "postgres",
                EngineVersion: "15",
                DBInstanceClass: "db.t3.micro",
                DBInstanceStatus: "available",
                AllocatedStorage: 20,
                MultiAZ: "false",
                MasterUsername: "admin",
                Endpoint: { Address: "db.host", Port: 5432 },
              },
              {
                DBInstanceIdentifier: "db2",
                Engine: "mysql",
                MasterUsername: "root",
                Endpoint: { Address: "m.host", Port: 3306 },
              },
            ],
          },
        },
      }),
    });
    const out = await listRDSInstances(ctx, "acct");
    expect(out[0]!.resolvedOutputs.connectionString).toBe("postgresql://admin@db.host:5432");
    expect(out[1]!.resolvedOutputs.connectionString).toBe("mysql://root@m.host:3306");
  });

  it("handles sqlserver and generic engines + no endpoint", async () => {
    const ctx = makeCtx({
      ec2Query: () => ({
        DescribeDBInstancesResult: {
          DBInstances: {
            DBInstance: [
              {
                DBInstanceIdentifier: "s",
                Engine: "sqlserver-ex",
                MasterUsername: "sa",
                Endpoint: { Address: "s.host", Port: 1433 },
              },
              { DBInstanceIdentifier: "g", Engine: "oracle-se2" },
            ],
          },
        },
      }),
    });
    const out = await listRDSInstances(ctx, "acct");
    expect(out[0]!.resolvedOutputs.connectionString).toBe("sqlserver://sa@s.host:1433");
    expect(out[1]!.resolvedOutputs.connectionString).toBe("");
  });
});

describe("listS3Buckets", () => {
  it("maps buckets with arn + endpoint", async () => {
    const ctx = makeCtx({
      xmlGet: () => ({ Buckets: { Bucket: { Name: "b1", CreationDate: "2020-01-01" } } }),
    });
    const out = await listS3Buckets(ctx, "acct");
    expect(out[0]!.resolvedOutputs.bucketArn).toBe("arn:aws:s3:::b1");
  });
});

describe("listLambdaFunctions", () => {
  it("maps functions", async () => {
    const ctx = makeCtx({
      jsonGet: () => ({
        Functions: [
          {
            FunctionName: "fn",
            Runtime: "nodejs20.x",
            Handler: "index.handler",
            CodeSize: 1024,
            MemorySize: 256,
            Timeout: 30,
            State: "Active",
            FunctionArn: "arn:fn",
          },
        ],
      }),
    });
    const out = await listLambdaFunctions(ctx, "acct");
    expect(out[0]!.resolvedOutputs.functionArn).toBe("arn:fn");
  });
});

describe("listECSServices", () => {
  it("lists services across clusters and skips inaccessible ones", async () => {
    const ctx = makeCtx({
      json: (_s, target, body) => {
        if (target.endsWith("ListClusters"))
          return { clusterArns: ["arn:cluster/c1", "arn:cluster/c2"] };
        if (target.endsWith("ListServices")) {
          if (body["cluster"] === "arn:cluster/c2") throw new Error("denied");
          return { serviceArns: ["arn:svc/s1"] };
        }
        if (target.endsWith("DescribeServices"))
          return {
            services: [
              {
                serviceName: "s1",
                serviceArn: "arn:svc/s1",
                status: "ACTIVE",
                launchType: "FARGATE",
                desiredCount: 2,
                runningCount: 2,
                taskDefinition: "arn:td/web:3",
              },
            ],
          };
        return {};
      },
    });
    const out = await listECSServices(ctx, "acct");
    expect(out).toHaveLength(1);
    expect(out[0]!.fields.taskDefinition).toBe("web:3");
  });

  it("skips clusters with no services", async () => {
    const ctx = makeCtx({
      json: (_s, target) => {
        if (target.endsWith("ListClusters")) return { clusterArns: ["arn:cluster/c1"] };
        if (target.endsWith("ListServices")) return { serviceArns: [] };
        return {};
      },
    });
    expect(await listECSServices(ctx, "acct")).toHaveLength(0);
  });
});

describe("listDynamoDBTables", () => {
  it("maps tables with pk/sk and indexes json", async () => {
    const ctx = makeCtx({
      json: (_s, target) => {
        if (target.endsWith("ListTables")) return { TableNames: ["T1", "Bad"] };
        if (target.endsWith("DescribeTable")) {
          return {
            Table: {
              TableStatus: "ACTIVE",
              ItemCount: 5,
              TableSizeBytes: 100,
              TableArn: "arn:t",
              KeySchema: [
                { AttributeName: "pk", KeyType: "HASH" },
                { AttributeName: "sk", KeyType: "RANGE" },
              ],
              BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" },
              AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
            },
          };
        }
        return {};
      },
    });
    const out = await listDynamoDBTables(ctx, "acct");
    // both tables described successfully
    expect(out).toHaveLength(2);
    expect(out[0]!.fields.partitionKey).toBe("pk");
    expect(out[0]!.fields.sortKey).toBe("sk");
    expect(String(out[0]!.fields._indexesJson)).toContain("attributeDefinitions");
  });

  it("skips tables that fail describe", async () => {
    const ctx = makeCtx({
      json: (_s, target, body) => {
        if (target.endsWith("ListTables")) return { TableNames: ["A"] };
        if (target.endsWith("DescribeTable") && body["TableName"] === "A")
          throw new Error("denied");
        return {};
      },
    });
    expect(await listDynamoDBTables(ctx, "acct")).toHaveLength(0);
  });
});

describe("listElastiCacheClusters", () => {
  it("maps clusters with endpoint connection string", async () => {
    const ctx = makeCtx({
      ec2Query: () => ({
        DescribeCacheClustersResult: {
          CacheClusters: {
            CacheCluster: {
              CacheClusterId: "cc1",
              Engine: "redis",
              EngineVersion: "7",
              CacheNodeType: "cache.t3.micro",
              NumCacheNodes: 1,
              CacheClusterStatus: "available",
              CacheNodes: { CacheNode: { Endpoint: { Address: "r.host", Port: 6379 } } },
            },
          },
        },
      }),
    });
    const out = await listElastiCacheClusters(ctx, "acct");
    expect(out[0]!.resolvedOutputs.connectionString).toBe("redis://r.host:6379");
  });
});

describe("listSQSQueues", () => {
  it("maps queues and skips inaccessible", async () => {
    const ctx = makeCtx({
      json: (_s, target, body) => {
        if (target.endsWith("ListQueues"))
          return { QueueUrls: ["https://sqs/acct/q1.fifo", "https://sqs/acct/bad"] };
        if (target.endsWith("GetQueueAttributes")) {
          if (String(body["QueueUrl"]).endsWith("bad")) throw new Error("denied");
          return {
            Attributes: {
              ApproximateNumberOfMessages: "3",
              QueueArn: "arn:q1",
              CreatedTimestamp: "1577836800",
            },
          };
        }
        return {};
      },
    });
    const out = await listSQSQueues(ctx, "acct");
    expect(out).toHaveLength(1);
    expect(out[0]!.fields.isFifo).toBe(true);
    expect(out[0]!.resolvedOutputs.queueArn).toBe("arn:q1");
  });
});

describe("listSNSTopics", () => {
  it("maps topics with attributes and fallback on attr failure", async () => {
    const ctx = makeCtx({
      ec2Query: (_s, action) => {
        if (action === "ListTopics")
          return {
            ListTopicsResult: {
              Topics: {
                member: [
                  { TopicArn: "arn:aws:sns:us-east-1:1:t1" },
                  { TopicArn: "arn:aws:sns:us-east-1:1:bad" },
                ],
              },
            },
          };
        if (action === "GetTopicAttributes") {
          throw new Error("denied");
        }
        return {};
      },
    });
    const out = await listSNSTopics(ctx, "acct");
    expect(out).toHaveLength(2);
    expect(out[0]!.fields.subscriptionCount).toBe(0);
  });

  it("parses attributes on success", async () => {
    const ctx = makeCtx({
      ec2Query: (_s, action) => {
        if (action === "ListTopics")
          return {
            ListTopicsResult: { Topics: { member: { TopicArn: "arn:aws:sns:us-east-1:1:t1" } } },
          };
        if (action === "GetTopicAttributes")
          return {
            GetTopicAttributesResult: {
              Attributes: { entry: { key: "SubscriptionsConfirmed", value: "4" } },
            },
          };
        return {};
      },
    });
    const out = await listSNSTopics(ctx, "acct");
    expect(out[0]!.fields.subscriptionCount).toBe(4);
  });
});

describe("listECRRepositories / listSecretsManagerSecrets / listCloudFrontDistributions / listIAMUsers", () => {
  it("ecr", async () => {
    const ctx = makeCtx({
      json: () => ({
        repositories: [
          {
            repositoryName: "r",
            registryId: "123",
            repositoryUri: "uri",
            repositoryArn: "arn",
            imageScanningConfiguration: { scanOnPush: true },
            encryptionConfiguration: { encryptionType: "KMS" },
          },
        ],
      }),
    });
    const out = await listECRRepositories(ctx, "acct");
    expect(out[0]!.fields.imageScanOnPush).toBe(true);
    expect(out[0]!.fields.encryptionType).toBe("KMS");
  });

  it("secrets", async () => {
    const ctx = makeCtx({
      json: () => ({ SecretList: [{ Name: "s", ARN: "arn:sec", RotationEnabled: true }] }),
    });
    const out = await listSecretsManagerSecrets(ctx, "acct");
    expect(out[0]!.fields.rotationEnabled).toBe(true);
  });

  // CloudFront's `ListDistributions` is REST-XML — it has no JSON
  // representation at all. Feeding the lister a hand-written JSON object used
  // to hide the fact that it called `jsonGet` (i.e. `res.json()`) and threw on
  // every real poll, so this drives the actual XML the API returns through the
  // real `parseXml` and asserts on what comes out the far side.
  const LIST_DISTRIBUTIONS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<DistributionList xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/">
  <Marker></Marker>
  <MaxItems>100</MaxItems>
  <IsTruncated>false</IsTruncated>
  <Quantity>2</Quantity>
  <Items>
    <DistributionSummary>
      <Id>E1AAAAAAAAAAAA</Id>
      <ARN>arn:aws:cloudfront::123456789012:distribution/E1AAAAAAAAAAAA</ARN>
      <Status>Deployed</Status>
      <LastModifiedTime>2024-03-04T11:22:33.123Z</LastModifiedTime>
      <DomainName>d111111abcdef8.cloudfront.net</DomainName>
      <Comment>marketing site</Comment>
      <PriceClass>PriceClass_All</PriceClass>
      <Enabled>true</Enabled>
      <HttpVersion>http2</HttpVersion>
      <Origins>
        <Quantity>2</Quantity>
        <Items>
          <Origin>
            <Id>S3-assets</Id>
            <DomainName>my-assets.s3.us-east-1.amazonaws.com</DomainName>
            <OriginPath></OriginPath>
          </Origin>
          <Origin>
            <Id>ELB-api</Id>
            <DomainName>api-lb-1234567890.us-east-1.elb.amazonaws.com</DomainName>
            <OriginPath></OriginPath>
          </Origin>
        </Items>
      </Origins>
    </DistributionSummary>
    <DistributionSummary>
      <Id>E2BBBBBBBBBBBB</Id>
      <ARN>arn:aws:cloudfront::123456789012:distribution/E2BBBBBBBBBBBB</ARN>
      <Status>InProgress</Status>
      <LastModifiedTime>2024-05-06T09:08:07.000Z</LastModifiedTime>
      <DomainName>d222222abcdef8.cloudfront.net</DomainName>
      <Comment></Comment>
      <PriceClass>PriceClass_100</PriceClass>
      <Enabled>false</Enabled>
      <HttpVersion>http1.1</HttpVersion>
      <Origins>
        <Quantity>1</Quantity>
        <Items>
          <Origin>
            <Id>S3-legacy</Id>
            <DomainName>legacy-bucket.s3.amazonaws.com</DomainName>
          </Origin>
        </Items>
      </Origins>
    </DistributionSummary>
  </Items>
</DistributionList>`;

  it("cloudfront maps a real REST-XML ListDistributions payload", async () => {
    const ctx = makeCtx({ xmlGet: () => parseXml(LIST_DISTRIBUTIONS_XML) });
    const out = await listCloudFrontDistributions(ctx, "acct");

    // The lister must use the XML transport — `jsonGet` would throw in prod.
    expect(ctx.xmlGet).toHaveBeenCalledWith("cloudfront", "/2020-05-31/distribution");
    expect(ctx.jsonGet).not.toHaveBeenCalled();

    expect(out).toHaveLength(2);

    const first = out[0]!;
    expect(first.id).toBe("acct:cloudfront-distribution:E1AAAAAAAAAAAA");
    expect(first.externalId).toBe("E1AAAAAAAAAAAA");
    expect(first.displayName).toBe("marketing site");
    expect(first.createdAt).toBe("2024-03-04T11:22:33.123Z");
    expect(first.fields).toEqual({
      distributionId: "E1AAAAAAAAAAAA",
      domainName: "d111111abcdef8.cloudfront.net",
      status: "Deployed",
      // XML carries booleans as the strings "true"/"false".
      enabled: true,
      comment: "marketing site",
      priceClass: "PriceClass_All",
      httpVersion: "http2",
      originDomains:
        "my-assets.s3.us-east-1.amazonaws.com, api-lb-1234567890.us-east-1.elb.amazonaws.com",
      // Only the S3 origin yields a bucket name; the ELB origin drops out.
      originBucketNames: "my-assets",
    });
    expect(first.resolvedOutputs.distributionArn).toBe(
      "arn:aws:cloudfront::123456789012:distribution/E1AAAAAAAAAAAA",
    );

    const second = out[1]!;
    // No comment — display name falls back to the distribution id.
    expect(second.displayName).toBe("E2BBBBBBBBBBBB");
    expect(second.fields.enabled).toBe(false);
    expect(second.fields.status).toBe("InProgress");
    // A lone <Origin> parses to a bare object rather than an array.
    expect(second.fields.originDomains).toBe("legacy-bucket.s3.amazonaws.com");
    expect(second.fields.originBucketNames).toBe("legacy-bucket");
  });

  it("cloudfront returns nothing when the account has no distributions", async () => {
    const emptyXml = `<?xml version="1.0" encoding="UTF-8"?>
<DistributionList xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/">
  <Marker></Marker>
  <MaxItems>100</MaxItems>
  <IsTruncated>false</IsTruncated>
  <Quantity>0</Quantity>
</DistributionList>`;
    const ctx = makeCtx({ xmlGet: () => parseXml(emptyXml) });
    expect(await listCloudFrontDistributions(ctx, "acct")).toEqual([]);
  });

  it("iam users", async () => {
    const ctx = makeCtx({
      ec2Query: () => ({
        ListUsersResult: { Users: { member: { UserName: "u", UserId: "id", Arn: "arn:u" } } },
      }),
    });
    const out = await listIAMUsers(ctx, "acct");
    expect(out[0]!.resolvedOutputs.userArn).toBe("arn:u");
  });
});
