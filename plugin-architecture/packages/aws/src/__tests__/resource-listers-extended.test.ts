import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ListerContext } from "../resource-listers.js";

const fetchSigned = vi.fn();
vi.mock("../signed-request.js", () => ({ fetchSigned: (...a: unknown[]) => fetchSigned(...a) }));

import {
  listRoute53HostedZones,
  listRoute53RecordSets,
  listRoute53HealthChecks,
  listALBs,
  listTargetGroups,
  listSecurityGroups,
  listSubnets,
  listNATGateways,
  listElasticIPs,
  listInternetGateways,
  listAutoScalingGroups,
  listAppRunnerServices,
  listBatchJobQueues,
  listSageMakerEndpoints,
  listBedrockModels,
  listKinesisStreams,
  listMSKClusters,
  listMQBrokers,
  listEventBridgeRules,
  listStepFunctions,
  listRedshiftClusters,
  listRDSClusters,
  listOpenSearchDomains,
  listNeptuneClusters,
  listDocumentDBClusters,
  listEFSFileSystems,
  listCloudWatchAlarms,
  listCloudWatchLogGroups,
  listCloudTrailTrails,
  listBackupVaults,
  listIAMRoles,
  listACMCertificates,
  listWAFWebACLs,
  listSSMParameters,
  listCognitoUserPools,
  listCodeBuildProjects,
  listCodePipelines,
  listCloudFormationStacks,
  listGlueDatabases,
  listAPIGateways,
} from "../resource-listers-extended.js";

interface MockResponses {
  ec2?: (action: string) => unknown;
  json?: (service: string, target: string, body: Record<string, unknown>) => unknown;
  jsonGet?: (service: string, path: string) => unknown;
  ec2Query?: (service: string, action: string) => unknown;
  restJson?: (service: string, path: string) => unknown;
}

function makeCtx(r: MockResponses): ListerContext {
  return {
    ec2: vi.fn(async (action) => r.ec2?.(action) ?? {}) as never,
    json: vi.fn(async (service, target, body) => r.json?.(service, target, body) ?? {}) as never,
    jsonGet: vi.fn(async (service, path) => r.jsonGet?.(service, path) ?? {}) as never,
    restJson: vi.fn(async (service, path) => r.restJson?.(service, path) ?? {}) as never,
    ec2Query: vi.fn(async (service, action) => r.ec2Query?.(service, action) ?? {}) as never,
    xmlGet: vi.fn(async () => ({})) as never,
    id: (a, t, e) => `${a}:${t}:${e}`,
    now: () => "2020-01-01T00:00:00Z",
    region: "us-east-1",
    creds: { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-1" },
  };
}

beforeEach(() => fetchSigned.mockReset());

describe("dns listers", () => {
  it("listRoute53HostedZones maps zones", async () => {
    const ctx = makeCtx({
      jsonGet: () => ({
        HostedZones: [
          {
            Id: "/hostedzone/Z1",
            Name: "ex.com.",
            ResourceRecordSetCount: 3,
            Config: { PrivateZone: true, Comment: "c" },
          },
        ],
      }),
    });
    const out = await listRoute53HostedZones(ctx, "acct");
    expect(out[0]!.externalId).toBe("Z1");
    expect(out[0]!.fields.isPrivate).toBe(true);
  });
  it("listRoute53RecordSets lists records per zone and tolerates failures", async () => {
    const ctx = makeCtx({
      jsonGet: (_s, path) => {
        if (path === "/2013-04-01/hostedzone")
          return { HostedZones: [{ Id: "/hostedzone/Z1", Name: "ex.com." }] };
        if (path.endsWith("/rrset"))
          return {
            ResourceRecordSets: [
              { Name: "a.ex.com.", Type: "A", TTL: 300, ResourceRecords: [{ Value: "1.2.3.4" }] },
            ],
          };
        return {};
      },
    });
    const out = await listRoute53RecordSets(ctx, "acct");
    expect(out[0]!.fields.values).toBe("1.2.3.4");
  });
  it("listRoute53HealthChecks maps checks", async () => {
    const ctx = makeCtx({
      jsonGet: () => ({
        HealthChecks: [
          {
            Id: "hc1",
            HealthCheckConfig: { Type: "HTTP", FullyQualifiedDomainName: "ex.com", Port: 80 },
          },
        ],
      }),
    });
    const out = await listRoute53HealthChecks(ctx, "acct");
    expect(out[0]!.fields.type).toBe("HTTP");
  });
});

describe("networking listers", () => {
  it("listALBs", async () => {
    const ctx = makeCtx({
      ec2Query: () => ({
        LoadBalancers: {
          member: {
            LoadBalancerName: "lb1",
            Type: "application",
            State: { Code: "active" },
            AvailabilityZones: { member: { ZoneName: "us-east-1a" } },
          },
        },
      }),
    });
    expect((await listALBs(ctx, "acct"))[0]!.fields.name).toBe("lb1");
  });
  it("listTargetGroups", async () => {
    const ctx = makeCtx({
      ec2Query: () => ({ TargetGroups: { member: { TargetGroupName: "tg1", Port: 80 } } }),
    });
    expect((await listTargetGroups(ctx, "acct"))[0]!.fields.port).toBe(80);
  });
  it("listSecurityGroups counts rules", async () => {
    const ctx = makeCtx({
      ec2: () => ({
        securityGroupInfo: {
          item: {
            groupId: "sg-1",
            groupName: "g",
            ipPermissions: { item: [{}, {}] },
            ipPermissionsEgress: { item: {} },
          },
        },
      }),
    });
    const out = await listSecurityGroups(ctx, "acct");
    expect(out[0]!.fields.inboundRuleCount).toBe(2);
    expect(out[0]!.fields.outboundRuleCount).toBe(1);
  });
  it("listSubnets reads Name tag", async () => {
    const ctx = makeCtx({
      ec2: () => ({
        subnetSet: {
          item: {
            subnetId: "subnet-1",
            tagSet: { item: { key: "Name", value: "web" } },
            mapPublicIpOnLaunch: "true",
          },
        },
      }),
    });
    const out = await listSubnets(ctx, "acct");
    expect(out[0]!.displayName).toBe("web");
    expect(out[0]!.fields.mapPublicIp).toBe(true);
  });
  it("listNATGateways", async () => {
    const ctx = makeCtx({
      ec2: () => ({
        natGatewaySet: {
          item: {
            natGatewayId: "nat-1",
            natGatewayAddressSet: { item: { publicIp: "1.1.1.1", privateIp: "10.0.0.1" } },
          },
        },
      }),
    });
    expect((await listNATGateways(ctx, "acct"))[0]!.fields.publicIp).toBe("1.1.1.1");
  });
  it("listElasticIPs", async () => {
    const ctx = makeCtx({
      ec2: () => ({ addressesSet: { item: { allocationId: "eip-1", publicIp: "2.2.2.2" } } }),
    });
    expect((await listElasticIPs(ctx, "acct"))[0]!.displayName).toBe("2.2.2.2");
  });
  it("listInternetGateways", async () => {
    const ctx = makeCtx({
      ec2: () => ({
        internetGatewaySet: {
          item: {
            internetGatewayId: "igw-1",
            attachmentSet: { item: { vpcId: "vpc-1", state: "available" } },
          },
        },
      }),
    });
    expect((await listInternetGateways(ctx, "acct"))[0]!.fields.vpcId).toBe("vpc-1");
  });
});

describe("compute extended listers", () => {
  it("listAutoScalingGroups", async () => {
    const ctx = makeCtx({
      ec2Query: () => ({
        AutoScalingGroups: {
          member: {
            AutoScalingGroupName: "asg1",
            MinSize: 1,
            MaxSize: 3,
            AvailabilityZones: { member: ["us-east-1a"] },
            Instances: { member: [{}, {}] },
            LaunchTemplate: { LaunchTemplateName: "lt", Version: "1" },
          },
        },
      }),
    });
    const out = await listAutoScalingGroups(ctx, "acct");
    expect(out[0]!.fields.instanceCount).toBe(2);
    expect(out[0]!.fields.launchTemplate).toBe("lt@1");
  });
  it("listAppRunnerServices", async () => {
    const ctx = makeCtx({
      json: () => ({ ServiceSummaryList: [{ ServiceName: "svc", ServiceArn: "arn:svc" }] }),
    });
    expect((await listAppRunnerServices(ctx, "acct"))[0]!.resolvedOutputs.serviceArn).toBe(
      "arn:svc",
    );
  });
  it("listBatchJobQueues", async () => {
    const ctx = makeCtx({
      restJson: () => ({ jobQueues: [{ jobQueueName: "jq", jobQueueArn: "arn:jq" }] }),
    });
    expect((await listBatchJobQueues(ctx, "acct"))[0]!.displayName).toBe("jq");
  });
  it("listSageMakerEndpoints", async () => {
    const ctx = makeCtx({
      json: () => ({ Endpoints: [{ EndpointName: "ep", EndpointArn: "arn:ep" }] }),
    });
    expect((await listSageMakerEndpoints(ctx, "acct"))[0]!.fields.endpointName).toBe("ep");
  });
  it("listBedrockModels filters to TEXT + ON_DEMAND", async () => {
    fetchSigned.mockResolvedValue({
      json: async () => ({
        modelSummaries: [
          {
            modelId: "m1",
            modelName: "M1",
            outputModalities: ["TEXT"],
            inferenceTypesSupported: ["ON_DEMAND"],
          },
          { modelId: "m2", outputModalities: ["IMAGE"], inferenceTypesSupported: ["ON_DEMAND"] },
        ],
      }),
    });
    const out = await listBedrockModels(ctx_creds(), "acct");
    expect(out.length).toBe(1);
    expect(out[0]!.fields.modelId).toBe("m1");
  });
});

function ctx_creds(): ListerContext {
  return makeCtx({});
}

describe("messaging extended listers", () => {
  it("listKinesisStreams describes each stream", async () => {
    const ctx = makeCtx({
      json: (_s, target) => {
        if (target.endsWith("ListStreams")) return { StreamNames: ["s1"] };
        if (target.endsWith("DescribeStream"))
          return {
            StreamDescription: { StreamStatus: "ACTIVE", Shards: [{}, {}], StreamARN: "arn:s" },
          };
        return {};
      },
    });
    const out = await listKinesisStreams(ctx, "acct");
    expect(out[0]!.fields.shardCount).toBe(2);
  });
  it("listKinesisStreams skips undescribable streams", async () => {
    const ctx = makeCtx({
      json: (_s, target) => {
        if (target.endsWith("ListStreams")) return { StreamNames: ["bad"] };
        throw new Error("denied");
      },
    });
    expect(await listKinesisStreams(ctx, "acct")).toEqual([]);
  });
  it("listMSKClusters", async () => {
    const ctx = makeCtx({
      jsonGet: () => ({
        ClusterInfoList: [
          {
            ClusterName: "c",
            ClusterArn: "arn:c",
            NumberOfBrokerNodes: 3,
            CurrentBrokerSoftwareInfo: { KafkaVersion: "3.5" },
            BrokerNodeGroupInfo: {
              InstanceType: "kafka.m5",
              StorageInfo: { EbsStorageInfo: { VolumeSize: 100 } },
            },
          },
        ],
      }),
    });
    const out = await listMSKClusters(ctx, "acct");
    expect(out[0]!.fields.storagePerBrokerGb).toBe(100);
    expect(out[0]!.fields.kafkaVersion).toBe("3.5");
  });
  it("listMQBrokers", async () => {
    const ctx = makeCtx({
      jsonGet: () => ({
        BrokerSummaries: [{ BrokerName: "b", BrokerId: "id", EngineType: "ActiveMQ" }],
      }),
    });
    expect((await listMQBrokers(ctx, "acct"))[0]!.fields.engineType).toBe("ActiveMQ");
  });
  it("listEventBridgeRules", async () => {
    const ctx = makeCtx({
      json: () => ({ Rules: [{ Name: "r", Arn: "arn:r", State: "ENABLED" }] }),
    });
    expect((await listEventBridgeRules(ctx, "acct"))[0]!.fields.state).toBe("ENABLED");
  });
  it("listStepFunctions describes machines and falls back on error", async () => {
    let first = true;
    const ctx = makeCtx({
      json: (_s, target) => {
        if (target.endsWith("ListStateMachines"))
          return {
            stateMachines: [
              { name: "sm1", stateMachineArn: "arn:1" },
              { name: "sm2", stateMachineArn: "arn:2" },
            ],
          };
        if (target.endsWith("DescribeStateMachine")) {
          if (first) {
            first = false;
            return { status: "ACTIVE", type: "STANDARD", creationDate: "2020" };
          }
          throw new Error("denied");
        }
        return {};
      },
    });
    const out = await listStepFunctions(ctx, "acct");
    expect(out.length).toBe(2);
  });
});

describe("database extended listers", () => {
  it("listRedshiftClusters builds connection string", async () => {
    const ctx = makeCtx({
      ec2Query: () => ({
        Clusters: {
          member: {
            ClusterIdentifier: "c",
            MasterUsername: "admin",
            DBName: "dev",
            Endpoint: { Address: "h", Port: 5439 },
          },
        },
      }),
    });
    expect(
      (await listRedshiftClusters(ctx, "acct"))[0]!.resolvedOutputs.connectionString,
    ).toContain("postgresql://admin@h:5439");
  });
  it("listRDSClusters aurora-postgresql connection string", async () => {
    const ctx = makeCtx({
      ec2Query: () => ({
        DescribeDBClustersResult: {
          DBClusters: {
            DBCluster: {
              DBClusterIdentifier: "c",
              Engine: "aurora-postgresql",
              MasterUsername: "u",
              Endpoint: "h",
              Port: 5432,
              DBClusterMembers: { DBClusterMember: [{}, {}] },
            },
          },
        },
      }),
    });
    const out = await listRDSClusters(ctx, "acct");
    expect(out[0]!.resolvedOutputs.connectionString).toBe("postgresql://u@h:5432");
    expect(out[0]!.fields.dbClusterMembers).toBe(2);
  });
  it("listOpenSearchDomains describes each domain", async () => {
    const ctx = makeCtx({
      jsonGet: (_s, path) => {
        if (path === "/2021-01-01/domain") return { DomainNames: [{ DomainName: "d1" }] };
        return {
          DomainStatus: {
            EngineVersion: "OpenSearch_2.5",
            ClusterConfig: { InstanceType: "t3", InstanceCount: 2 },
            Endpoint: "ep",
          },
        };
      },
    });
    const out = await listOpenSearchDomains(ctx, "acct");
    expect(out[0]!.resolvedOutputs.dashboardEndpoint).toBe("ep/_dashboards");
  });
  it("listOpenSearchDomains skips undescribable", async () => {
    const ctx = makeCtx({
      jsonGet: (_s, path) => {
        if (path === "/2021-01-01/domain") return { DomainNames: [{ DomainName: "d1" }] };
        throw new Error("denied");
      },
    });
    expect(await listOpenSearchDomains(ctx, "acct")).toEqual([]);
  });
  it("listNeptuneClusters filters by engine", async () => {
    const ctx = makeCtx({
      ec2Query: () => ({
        DescribeDBClustersResult: {
          DBClusters: {
            DBCluster: [
              { DBClusterIdentifier: "n", Engine: "neptune" },
              { DBClusterIdentifier: "x", Engine: "mysql" },
            ],
          },
        },
      }),
    });
    const out = await listNeptuneClusters(ctx, "acct");
    expect(out.length).toBe(1);
    expect(out[0]!.fields.clusterIdentifier).toBe("n");
  });
  it("listDocumentDBClusters filters by engine + builds mongo connection string", async () => {
    const ctx = makeCtx({
      ec2Query: () => ({
        DescribeDBClustersResult: {
          DBClusters: {
            DBCluster: {
              DBClusterIdentifier: "doc",
              Engine: "docdb",
              MasterUsername: "u",
              Endpoint: "h",
              Port: 27017,
            },
          },
        },
      }),
    });
    const out = await listDocumentDBClusters(ctx, "acct");
    expect(out[0]!.resolvedOutputs.connectionString).toBe("mongodb://u@h:27017/");
  });
  it("listEFSFileSystems reads Name tag + size", async () => {
    const ctx = makeCtx({
      jsonGet: () => ({
        FileSystems: [
          {
            FileSystemId: "fs-1",
            Tags: [{ Key: "Name", Value: "data" }],
            SizeInBytes: { Value: 1000 },
            Encrypted: true,
          },
        ],
      }),
    });
    const out = await listEFSFileSystems(ctx, "acct");
    expect(out[0]!.displayName).toBe("data");
    expect(out[0]!.fields.sizeInBytes).toBe(1000);
  });
});

describe("observability extended listers", () => {
  it("listCloudWatchAlarms", async () => {
    const ctx = makeCtx({
      ec2Query: () => ({
        DescribeAlarmsResult: {
          MetricAlarms: {
            member: { AlarmName: "a", StateValue: "OK", Threshold: 80, ActionsEnabled: true },
          },
        },
      }),
    });
    const out = await listCloudWatchAlarms(ctx, "acct");
    expect(out[0]!.fields.actionsEnabled).toBe(true);
  });
  it("listCloudWatchLogGroups converts creation time", async () => {
    const ctx = makeCtx({
      json: () => ({
        logGroups: [{ logGroupName: "/lg", storedBytes: 100, creationTime: 1577836800000 }],
      }),
    });
    const out = await listCloudWatchLogGroups(ctx, "acct");
    expect(out[0]!.createdAt).toContain("2020-01-01");
  });
  it("listCloudTrailTrails", async () => {
    const ctx = makeCtx({
      json: () => ({
        trailList: [{ Name: "t", S3BucketName: "bucket", IsMultiRegionTrail: true }],
      }),
    });
    expect((await listCloudTrailTrails(ctx, "acct"))[0]!.fields.isMultiRegion).toBe(true);
  });
  it("listBackupVaults", async () => {
    const ctx = makeCtx({
      restJson: () => ({ BackupVaultList: [{ BackupVaultName: "v", NumberOfRecoveryPoints: 3 }] }),
    });
    expect((await listBackupVaults(ctx, "acct"))[0]!.fields.numberOfRecoveryPoints).toBe(3);
  });
});

describe("security extended listers", () => {
  it("listIAMRoles", async () => {
    const ctx = makeCtx({
      ec2Query: () => ({ ListRolesResult: { Roles: { member: { RoleName: "r", Arn: "arn:r" } } } }),
    });
    expect((await listIAMRoles(ctx, "acct"))[0]!.resolvedOutputs.roleArn).toBe("arn:r");
  });
  it("listACMCertificates describes certs and falls back", async () => {
    let first = true;
    const ctx = makeCtx({
      json: (_s, target) => {
        if (target.endsWith("ListCertificates"))
          return {
            CertificateSummaryList: [
              { CertificateArn: "arn:1", DomainName: "a.com" },
              { CertificateArn: "arn:2", DomainName: "b.com" },
            ],
          };
        if (target.endsWith("DescribeCertificate")) {
          if (first) {
            first = false;
            return {
              Certificate: {
                DomainName: "a.com",
                Status: "ISSUED",
                SubjectAlternativeNames: ["x"],
                InUseBy: ["y"],
              },
            };
          }
          throw new Error("denied");
        }
        return {};
      },
    });
    const out = await listACMCertificates(ctx, "acct");
    expect(out.length).toBe(2);
    expect(out[0]!.fields.inUseBy).toBe(1);
  });
  it("listWAFWebACLs describes acls and falls back", async () => {
    let first = true;
    const ctx = makeCtx({
      json: (_s, target) => {
        if (target.endsWith("ListWebACLs"))
          return {
            WebACLs: [
              { Name: "a", Id: "id1", ARN: "arn:1" },
              { Name: "b", Id: "id2", ARN: "arn:2" },
            ],
          };
        if (target.endsWith("GetWebACL")) {
          if (first) {
            first = false;
            return {
              WebACL: { Description: "d", Rules: [{}], DefaultAction: { Allow: {} }, Capacity: 10 },
            };
          }
          throw new Error("denied");
        }
        return {};
      },
    });
    const out = await listWAFWebACLs(ctx, "acct");
    expect(out.length).toBe(2);
    expect(out[0]!.fields.defaultAction).toBe("ALLOW");
  });
  it("listSSMParameters", async () => {
    const ctx = makeCtx({
      json: () => ({ Parameters: [{ Name: "/p", Type: "String", Version: 1 }] }),
    });
    const out = await listSSMParameters(ctx, "acct");
    expect(out[0]!.resolvedOutputs.parameterArn).toContain(":parameter/p");
  });
  it("listCognitoUserPools describes pools and falls back", async () => {
    let first = true;
    const ctx = makeCtx({
      json: (_s, target) => {
        if (target.endsWith("ListUserPools"))
          return {
            UserPools: [
              { Id: "p1", Name: "n1" },
              { Id: "p2", Name: "n2" },
            ],
          };
        if (target.endsWith("DescribeUserPool")) {
          if (first) {
            first = false;
            return {
              UserPool: { MfaConfiguration: "ON", EstimatedNumberOfUsers: 5, Arn: "arn:p" },
            };
          }
          throw new Error("denied");
        }
        return {};
      },
    });
    const out = await listCognitoUserPools(ctx, "acct");
    expect(out.length).toBe(2);
    expect(out[0]!.fields.mfaConfiguration).toBe("ON");
  });
});

describe("devtools extended listers", () => {
  it("listCodeBuildProjects returns [] when none", async () => {
    const ctx = makeCtx({ json: () => ({ projects: [] }) });
    expect(await listCodeBuildProjects(ctx, "acct")).toEqual([]);
  });
  it("listCodeBuildProjects batch-gets projects", async () => {
    const ctx = makeCtx({
      json: (_s, target) => {
        if (target.endsWith("ListProjects")) return { projects: ["p1"] };
        if (target.endsWith("BatchGetProjects"))
          return {
            projects: [
              {
                name: "p1",
                source: { type: "GITHUB" },
                environment: { image: "img", computeType: "SMALL" },
                badge: { badgeEnabled: true },
                arn: "arn:p",
              },
            ],
          };
        return {};
      },
    });
    const out = await listCodeBuildProjects(ctx, "acct");
    expect(out[0]!.fields.sourceType).toBe("GITHUB");
    expect(out[0]!.fields.badge).toBe(true);
  });
  it("listCodePipelines", async () => {
    const ctx = makeCtx({
      json: () => ({ pipelines: [{ name: "pp", version: 2, pipelineType: "V2" }] }),
    });
    const out = await listCodePipelines(ctx, "acct");
    expect(out[0]!.resolvedOutputs.pipelineArn).toContain(":pp");
  });
  it("listCloudFormationStacks", async () => {
    const ctx = makeCtx({
      ec2Query: () => ({
        DescribeStacksResult: {
          Stacks: {
            member: {
              StackName: "s",
              StackId: "arn:s",
              StackStatus: "CREATE_COMPLETE",
              DriftInformation: { StackDriftStatus: "IN_SYNC" },
            },
          },
        },
      }),
    });
    expect((await listCloudFormationStacks(ctx, "acct"))[0]!.fields.driftStatus).toBe("IN_SYNC");
  });
  it("listGlueDatabases", async () => {
    const ctx = makeCtx({
      json: () => ({ DatabaseList: [{ Name: "db", LocationUri: "s3://x" }] }),
    });
    expect((await listGlueDatabases(ctx, "acct"))[0]!.fields.locationUri).toBe("s3://x");
  });
  it("listAPIGateways", async () => {
    const ctx = makeCtx({
      jsonGet: () => ({
        Items: [
          { Name: "api", ApiId: "a1", ProtocolType: "HTTP", RouteSelectionExpression: "$request" },
        ],
      }),
    });
    const out = await listAPIGateways(ctx, "acct");
    expect(out[0]!.fields.routeCount).toBe(1);
  });
});
