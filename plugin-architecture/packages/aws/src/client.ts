import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  ResourceTypeDefinition,
  StorageObject,
  ArtifactEntry,
  CreateResourceConfig,
  DashboardStat,
  MetricSeries,
  CostFetchRange,
  CostRow,
  CredentialExport,
  HostServices,
  ChatMessage,
  ChatStreamEvent,
  PublishMessagePayload,
  PublishMessageResult,
} from "@infrawrench/plugin-base";
import type { AwsCredentials } from "./auth.js";
import type { ListerContext } from "./resource-listers.js";
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
} from "./resource-listers.js";
import {
  listRoute53HostedZones,
  listRoute53RecordSets,
  listALBs,
  listTargetGroups,
  listAutoScalingGroups,
  listIAMRoles,
  listSecurityGroups,
  listSubnets,
  listRouteTables,
  listNATGateways,
  listElasticIPs,
  listStepFunctions,
  listEventBridgeRules,
  listKinesisStreams,
  listRedshiftClusters,
  listRDSClusters,
  listOpenSearchDomains,
  listACMCertificates,
  listWAFWebACLs,
  listCodeBuildProjects,
  listCodePipelines,
  listCloudFormationStacks,
  listSSMParameters,
  listEFSFileSystems,
  listAPIGateways,
  listCloudWatchAlarms,
  listCloudWatchLogGroups,
  listAppRunnerServices,
  listGlueDatabases,
  listInternetGateways,
  listCloudTrailTrails,
  listMSKClusters,
  listNeptuneClusters,
  listDocumentDBClusters,
  listDBSubnetGroups,
  listMQBrokers,
  listBatchJobQueues,
  listSageMakerEndpoints,
  listBedrockModels,
  listRoute53HealthChecks,
  listCognitoUserPools,
  listBackupVaults,
} from "./resource-listers-extended.js";
import type { AwsCreateContext } from "./create-handlers.js";
import { awsGetCreateConfig, awsCreateResource } from "./create-handlers.js";
import {
  ec2Call,
  ec2QueryCall,
  hostForService,
  jsonCall,
  jsonGetCall,
  queryPostCall,
  restJsonCall,
  xmlGetCall,
} from "./client-transport.js";
import { listAllIAMPolicies, policiesToOptions } from "./iam-policies.js";
import {
  deleteStorageObject,
  getBucketPolicy,
  listStorageObjects,
  makeStorageFolder,
  putBucketPolicy,
  uploadStorageObject,
} from "./s3-storage.js";
import {
  renderDetail as renderDetailImpl,
  renderSidebarItem as renderSidebarItemImpl,
} from "./render-resource.js";
import {
  fetchDashboardStats as fetchDashboardStatsImpl,
  fetchMetricSeries as fetchMetricSeriesImpl,
} from "./dashboard-metrics.js";
import { getCreateCostEstimate as getCreateCostEstimateImpl } from "./cost-estimate.js";
import { fetchEc2MonthlyPrices } from "./pricing.js";
import { fetchAwsCostData } from "./cost-data.js";
import { attachResource as attachResourceImpl } from "./attach-handlers.js";
import { resolveOutput as resolveOutputImpl } from "./resolve-output.js";
import { deleteResource as deleteResourceImpl } from "./delete-handlers.js";
import { executeFieldAction as executeFieldActionImpl } from "./field-actions.js";
import { executeDynamoDbCommand } from "./dynamodb-handlers.js";
import { publishSqs, publishSns, publishKinesis, publishEventBridge } from "./publish-handlers.js";
import { fetchSigned } from "./signed-request.js";

export class AWSClient implements PluginClient {
  private readonly creds: AwsCredentials;
  private readonly resourceTypes: ResourceTypeDefinition[];

  constructor(
    credentials: Record<string, string>,
    resourceTypes: ResourceTypeDefinition[] = [],
    services?: HostServices,
  ) {
    this.resourceTypes = resourceTypes;
    const accessKeyId = credentials["accessKeyId"];
    const secretAccessKey = credentials["secretAccessKey"];
    const region = credentials["region"] ?? "us-east-1";
    if (!accessKeyId || !secretAccessKey) {
      throw new Error("AWS plugin: missing accessKeyId or secretAccessKey");
    }
    this.creds = {
      accessKeyId,
      secretAccessKey,
      region,
      ...(services?.http ? { http: services.http } : {}),
    };
  }

  private makeId(accountId: string, typeId: string, externalId: string): string {
    return `${accountId}:${typeId}:${externalId}`;
  }

  /**
   * Resource types that live outside any single region (S3 ListBuckets, IAM,
   * Route 53, CloudFront, ACM-on-CloudFront, …). Listing these once is enough
   * — fanning out across regions would just yield duplicates. Per-bucket S3
   * detail calls still pin to the bucket's home region, but discovery is
   * global.
   */
  private static readonly GLOBAL_TYPES = new Set([
    "s3-bucket",
    "iam-user",
    "iam-role",
    "route53-hosted-zone",
    "route53-record-set",
    "cloudfront-distribution",
  ]);

  /**
   * Maximum number of regions queried in parallel during a fan-out list. AWS
   * accounts have a single shared API rate limit, and the plugin's own rate
   * limiter (capacity 120, refill 8/s in manifest) is the real ceiling — so
   * picking a moderate concurrency keeps a typed-out user-action snappy
   * without burning the bucket on a single refresh.
   */
  private static readonly REGION_FANOUT_CONCURRENCY = 8;

  private enabledRegionsCache: string[] | null = null;
  private enabledRegionsPromise: Promise<string[]> | null = null;

  private credsFor(region: string): AwsCredentials {
    return { ...this.creds, region };
  }

  private ctxFor(region: string): ListerContext {
    const creds = this.credsFor(region);
    return {
      ec2: <T>(action: string, params?: Record<string, string>) =>
        ec2Call<T>(creds, action, params),
      json: <T>(service: string, target: string, body: Record<string, unknown>) =>
        jsonCall<T>(creds, service, target, body),
      jsonGet: <T>(service: string, path: string) => jsonGetCall<T>(creds, service, path),
      restJson: <T>(
        service: string,
        path: string,
        body?: Record<string, unknown>,
        method?: "POST" | "GET",
      ) => restJsonCall<T>(creds, service, path, body, method),
      ec2Query: <T>(
        service: string,
        action: string,
        version: string,
        params?: Record<string, string>,
      ) => ec2QueryCall<T>(creds, service, action, version, params),
      xmlGet: <T>(service: string, path?: string) => xmlGetCall<T>(creds, service, path),
      id: (accountId, typeId, externalId) => this.makeId(accountId, typeId, externalId),
      now: () => new Date().toISOString(),
      region,
      creds,
    };
  }

  private createCtxFor(region: string): AwsCreateContext {
    const creds = this.credsFor(region);
    const sub: AwsCreateContext = {
      creds,
      hostForService: (s) => hostForService(creds, s),
      ec2: <T>(action: string, params?: Record<string, string>) =>
        ec2Call<T>(creds, action, params),
      json: <T>(service: string, target: string, body: Record<string, unknown>) =>
        jsonCall<T>(creds, service, target, body),
      ec2Query: <T>(
        service: string,
        action: string,
        version: string,
        params?: Record<string, string>,
      ) => ec2QueryCall<T>(creds, service, action, version, params),
      queryPost: <T>(
        service: string,
        action: string,
        version: string,
        params?: Record<string, string>,
      ) => queryPostCall<T>(creds, service, action, version, params),
      xmlGet: <T>(service: string, path?: string) => xmlGetCall<T>(creds, service, path),
      makeId: (accountId, typeId, externalId) => this.makeId(accountId, typeId, externalId),
      listAllIAMPolicies: (scope) => listAllIAMPolicies(creds, scope),
      policiesToOptions: (raw, category) => policiesToOptions(raw, category),
      getResource: (typeId, resourceId, accountId) =>
        this.getResource(typeId, resourceId, accountId),
      withRegion: (r: string) => this.createCtxFor(r),
    };
    return sub;
  }

  private get createCtx(): AwsCreateContext {
    return this.createCtxFor(this.creds.region);
  }

  /**
   * Return the regions enabled on this AWS account. Calls `DescribeRegions`
   * once and caches the result for the lifetime of this client instance. The
   * call is signed from the user's home region so it works even if some
   * regions are disabled.
   */
  private async getEnabledRegions(): Promise<string[]> {
    if (this.enabledRegionsCache) return this.enabledRegionsCache;
    if (this.enabledRegionsPromise) return this.enabledRegionsPromise;
    this.enabledRegionsPromise = (async () => {
      try {
        const data = await ec2Call<Record<string, unknown>>(this.creds, "DescribeRegions");
        const regionInfo = data["regionInfo"] as Record<string, unknown> | undefined;
        const items = Array.isArray(regionInfo?.["item"])
          ? (regionInfo["item"] as Record<string, unknown>[])
          : regionInfo?.["item"]
            ? [regionInfo["item"] as Record<string, unknown>]
            : [];
        const names = items
          .map((r) => String(r["regionName"] ?? ""))
          .filter((n): n is string => Boolean(n));
        const result = names.length > 0 ? names : [this.creds.region];
        this.enabledRegionsCache = result;
        return result;
      } catch {
        // If DescribeRegions fails (lacking ec2:DescribeRegions permission,
        // restricted partition, …), fall back to just the home region so the
        // app keeps working in a degraded but predictable mode.
        const result = [this.creds.region];
        this.enabledRegionsCache = result;
        return result;
      } finally {
        this.enabledRegionsPromise = null;
      }
    })();
    return this.enabledRegionsPromise;
  }

  private static readonly LISTERS: Record<
    string,
    (ctx: ListerContext, accountId: string) => Promise<ResourceInstance[]>
  > = {
    "ec2-instance": listEC2Instances,
    "ebs-volume": listEBSVolumes,
    vpc: listVPCs,
    "eks-cluster": listEKSClusters,
    "rds-instance": listRDSInstances,
    "s3-bucket": listS3Buckets,
    "lambda-function": listLambdaFunctions,
    "ecs-service": listECSServices,
    "dynamodb-table": listDynamoDBTables,
    "elasticache-cluster": listElastiCacheClusters,
    "sqs-queue": listSQSQueues,
    "sns-topic": listSNSTopics,
    "ecr-repository": listECRRepositories,
    "secrets-manager-secret": listSecretsManagerSecrets,
    "cloudfront-distribution": listCloudFrontDistributions,
    "iam-user": listIAMUsers,
    "route53-hosted-zone": listRoute53HostedZones,
    "route53-record-set": listRoute53RecordSets,
    alb: listALBs,
    "target-group": listTargetGroups,
    "auto-scaling-group": listAutoScalingGroups,
    "iam-role": listIAMRoles,
    "security-group": listSecurityGroups,
    subnet: listSubnets,
    "route-table": listRouteTables,
    "nat-gateway": listNATGateways,
    "elastic-ip": listElasticIPs,
    "step-function": listStepFunctions,
    "eventbridge-rule": listEventBridgeRules,
    "kinesis-stream": listKinesisStreams,
    "redshift-cluster": listRedshiftClusters,
    "rds-cluster": listRDSClusters,
    "opensearch-domain": listOpenSearchDomains,
    "acm-certificate": listACMCertificates,
    "waf-web-acl": listWAFWebACLs,
    "codebuild-project": listCodeBuildProjects,
    "codepipeline-pipeline": listCodePipelines,
    "cloudformation-stack": listCloudFormationStacks,
    "ssm-parameter": listSSMParameters,
    "efs-file-system": listEFSFileSystems,
    "api-gateway": listAPIGateways,
    "cloudwatch-alarm": listCloudWatchAlarms,
    "cloudwatch-log-group": listCloudWatchLogGroups,
    "apprunner-service": listAppRunnerServices,
    "glue-database": listGlueDatabases,
    "internet-gateway": listInternetGateways,
    "cloudtrail-trail": listCloudTrailTrails,
    "msk-cluster": listMSKClusters,
    "neptune-cluster": listNeptuneClusters,
    "documentdb-cluster": listDocumentDBClusters,
    "db-subnet-group": listDBSubnetGroups,
    "mq-broker": listMQBrokers,
    "batch-job-queue": listBatchJobQueues,
    "sagemaker-endpoint": listSageMakerEndpoints,
    "bedrock-model": listBedrockModels,
    "route53-health-check": listRoute53HealthChecks,
    "cognito-user-pool": listCognitoUserPools,
    "backup-vault": listBackupVaults,
  };

  async listResources(
    typeId: string,
    accountId: string,
    opts?: { regionHint?: string },
  ): Promise<ResourceInstance[]> {
    const lister = AWSClient.LISTERS[typeId];
    if (!lister) throw new Error(`AWS plugin: unknown resource type "${typeId}"`);

    // Global resources have no concept of region — list them once.
    if (AWSClient.GLOBAL_TYPES.has(typeId)) {
      return lister(this.ctxFor(this.creds.region), accountId);
    }

    // When the host knows the caller only cares about one region (e.g. the
    // create-form resource picker after the user has selected a region), skip
    // the fan-out entirely. Spinning up DescribeVpcs/DescribeSecurityGroups in
    // 30 regions to populate a picker for a single-region resource is the #1
    // cause of "Loading resources..." spinning forever.
    if (opts?.regionHint) {
      return lister(this.ctxFor(opts.regionHint), accountId);
    }

    // Regional resources fan out across every enabled region. We process the
    // regions in bounded-concurrency batches so a single refresh of a sparsely
    // populated account doesn't open 30 sockets at once. Per-region failures
    // are swallowed: an opt-in region with bad credentials should not make
    // every other region's listing disappear.
    const regions = await this.getEnabledRegions();
    const results: ResourceInstance[] = [];
    const concurrency = AWSClient.REGION_FANOUT_CONCURRENCY;
    for (let i = 0; i < regions.length; i += concurrency) {
      const batch = regions.slice(i, i + concurrency);
      const settled = await Promise.allSettled(
        batch.map((region) => lister(this.ctxFor(region), accountId)),
      );
      for (const s of settled) {
        if (s.status === "fulfilled") results.push(...s.value);
      }
    }
    return results;
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`AWS plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    accountId: string,
  ): Promise<void> {
    return attachResourceImpl(
      {
        creds: this.creds,
        credsFor: (region: string) => this.credsFor(region),
        getResource: (t, r, a) => this.getResource(t, r, a),
      },
      sourceTypeId,
      sourceResourceId,
      targetTypeId,
      targetResourceId,
      accountId,
    );
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    return resolveOutputImpl(
      {
        creds: this.creds,
        credsFor: (region: string) => this.credsFor(region),
        getResource: (t, r, a) => this.getResource(t, r, a),
        exportCredential: (t, r, a, f) => this.exportCredential(t, r, a, f),
      },
      typeId,
      resourceId,
      outputKey,
      accountId,
    );
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    return fetchDashboardStatsImpl(resource, resourceTypeId);
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const region = String(resource.fields["region"] ?? this.creds.region);
    return fetchMetricSeriesImpl(this.credsFor(region), resource, resourceTypeId, timeRange);
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchAwsCostData(this.creds, range);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    const region = String(resource.fields["region"] ?? this.creds.region);
    return renderDetailImpl(resource, this.resourceTypes, region);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderSidebarItemImpl(resource);
  }

  async uploadStorageObject(bucket: string, key: string, file: File): Promise<void> {
    return uploadStorageObject(this.creds, bucket, key, file);
  }

  async listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    return listStorageObjects(this.creds, bucket, prefix);
  }

  async makeStorageFolder(bucket: string, key: string): Promise<void> {
    return makeStorageFolder(this.creds, bucket, key);
  }

  async deleteStorageObject(bucket: string, key: string): Promise<void> {
    return deleteStorageObject(this.creds, bucket, key);
  }

  async listArtifacts(
    typeId: string,
    resourceId: string,
    accountId: string,
    params?: { pageToken?: string; prefix?: string },
  ): Promise<{ items: ArtifactEntry[]; nextPageToken?: string }> {
    if (typeId !== "ecr-repository") {
      throw new Error(`listArtifacts not supported for type ${typeId}`);
    }
    const repositoryName = resourceId.split(":").pop() ?? resourceId;
    const body: Record<string, unknown> = {
      repositoryName,
      maxResults: 50,
    };
    if (params?.pageToken) body["nextToken"] = params.pageToken;
    const resource = await this.getResource(typeId, resourceId, accountId);
    const region = String(resource.fields["region"] ?? this.creds.region);
    const data = await jsonCall<{
      imageDetails?: Array<Record<string, unknown>>;
      nextToken?: string;
    }>(this.credsFor(region), "ecr", "AmazonEC2ContainerRegistry_V20150921.DescribeImages", body);
    const items: ArtifactEntry[] = (data.imageDetails ?? []).map((img) => {
      const tags = Array.isArray(img["imageTags"]) ? (img["imageTags"] as string[]) : undefined;
      const entry: ArtifactEntry = {
        name: repositoryName,
      };
      const firstTag = tags?.[0];
      if (tags && tags.length > 0) {
        entry.tags = tags;
        if (firstTag) entry.version = firstTag;
      }
      if (img["imageDigest"]) entry.digest = String(img["imageDigest"]);
      if (img["imageSizeInBytes"] != null) entry.sizeBytes = Number(img["imageSizeInBytes"]);
      if (img["imagePushedAt"]) entry.updatedAt = String(img["imagePushedAt"]);
      if (img["artifactMediaType"]) entry.mediaType = String(img["artifactMediaType"]);
      return entry;
    });
    const prefix = params?.prefix?.trim();
    const filtered = prefix
      ? items.filter(
          (i) =>
            i.name.includes(prefix) ||
            (i.tags ?? []).some((t) => t.includes(prefix)) ||
            (i.digest ?? "").includes(prefix),
        )
      : items;
    const result: { items: ArtifactEntry[]; nextPageToken?: string } = { items: filtered };
    if (data.nextToken) result.nextPageToken = data.nextToken;
    return result;
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    return awsGetCreateConfig(this.createCtx, typeId, parentResourceId);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    return awsCreateResource(this.createCtx, typeId, accountId, fields, parentResourceId);
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId === "route53-record-set") {
      // Merge the changed field(s) over the current record, then UPSERT the
      // whole record set (Route 53 has no partial update). `value` is the
      // create-form key; the stored resource field is `values`.
      const current = await this.getResource(typeId, resourceId, accountId);
      const cur = current.fields;
      const hostedZoneId = String(cur["hostedZoneId"] ?? "");
      const recordName = String(cur["name"] ?? "");
      const recordType = String(cur["type"] ?? "A");
      const ttl = String(cur["ttl"] ?? "300");
      const value = fields["value"] ?? String(cur["values"] ?? "");
      const host = hostForService(this.creds, "route53");
      const url = `https://${host}/2013-04-01/hostedzone/${hostedZoneId}/rrset`;
      const bodyXml = [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">`,
        `<ChangeBatch><Changes><Change>`,
        `<Action>UPSERT</Action>`,
        `<ResourceRecordSet>`,
        `<Name>${recordName}</Name>`,
        `<Type>${recordType}</Type>`,
        `<TTL>${ttl}</TTL>`,
        `<ResourceRecords><ResourceRecord><Value>${value}</Value></ResourceRecord></ResourceRecords>`,
        `</ResourceRecordSet>`,
        `</Change></Changes></ChangeBatch>`,
        `</ChangeResourceRecordSetsRequest>`,
      ].join("");
      await fetchSigned({
        method: "POST",
        url,
        headers: { Host: host, "Content-Type": "application/xml" },
        body: bodyXml,
        service: "route53",
        credentials: this.creds,
      });
      return {
        ...current,
        fields: { ...cur, values: value },
        updatedAt: new Date().toISOString(),
      };
    }

    if (typeId === "ec2-instance") {
      // Edit = change instance type (the right-sizing apply path).
      // ModifyInstanceAttribute requires the instance to be fully stopped;
      // a running one gets EC2's IncorrectInstanceState, surfaced as-is.
      const instanceType = fields["instanceType"];
      if (!instanceType) {
        throw new Error("AWS plugin: instanceType is the only editable EC2 instance field");
      }
      const resource = await this.getResource(typeId, resourceId, accountId);
      const instanceId = String(resource.externalId ?? resource.fields["instanceId"] ?? "");
      if (!instanceId) throw new Error("Cannot determine EC2 instance ID");
      const region = String(resource.fields["region"] ?? this.creds.region);
      await ec2Call(this.credsFor(region), "ModifyInstanceAttribute", {
        InstanceId: instanceId,
        "InstanceType.Value": instanceType,
      });
      // Return the resource already in hand with the new type overlaid rather
      // than re-running the multi-region lookup: it halves the API fan-out,
      // and EC2's eventual consistency means an immediate re-describe could
      // still report the old type. The next sync reads the converged truth.
      return {
        ...resource,
        fields: { ...resource.fields, instanceType },
        updatedAt: new Date().toISOString(),
      };
    }

    throw new Error(`AWS plugin: updateResource not supported for type "${typeId}"`);
  }

  async getCreateCostEstimate(
    typeId: string,
    fields: Record<string, string>,
  ): Promise<number | null> {
    return getCreateCostEstimateImpl(typeId, fields);
  }

  /**
   * Per-region monthly on-demand prices for the size picker, via the Price
   * List Query API — the live replacement for the static `cost-estimate.ts`
   * table. Requires the `pricing:GetProducts` permission; without it the
   * result is empty and the picker simply shows no price chips.
   */
  async getCreateSizePricing(
    typeId: string,
    request: { regionId?: string; sizes: Array<{ id: string }> },
  ): Promise<Record<string, number>> {
    if (typeId !== "ec2-instance") return {};
    const region = request.regionId ?? this.creds.region;
    return fetchEc2MonthlyPrices(
      this.creds,
      region,
      request.sizes.map((s) => s.id),
    );
  }

  async executeFieldAction(
    typeId: string,
    fieldKey: string,
    actionId: string,
    _accountId: string,
    fields: Record<string, string>,
    actionFields?: Record<string, string>,
  ): Promise<{ value: string; option?: { id: string; label: string } }> {
    return executeFieldActionImpl(
      this.creds,
      typeId,
      fieldKey,
      actionId,
      fields,
      actionFields ?? {},
    );
  }

  async publishMessage(
    typeId: string,
    resourceId: string,
    accountId: string,
    payload: PublishMessagePayload,
  ): Promise<PublishMessageResult> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    const ctx = {
      credsFor: (region: string) => this.credsFor(region),
      defaultRegion: this.creds.region,
      resource: {
        fields: resource.fields,
        ...(resource.externalId !== undefined ? { externalId: resource.externalId } : {}),
        displayName: resource.displayName,
      },
    };
    switch (typeId) {
      case "sqs-queue":
        return publishSqs(ctx, payload);
      case "sns-topic":
        return publishSns(ctx, payload);
      case "kinesis-stream":
        return publishKinesis(ctx, payload);
      case "eventbridge-rule":
        return publishEventBridge(ctx, payload);
      default:
        throw new Error(`AWS plugin: publishMessage not supported for type "${typeId}"`);
    }
  }

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    return deleteResourceImpl(
      {
        creds: this.creds,
        credsFor: (region: string) => this.credsFor(region),
        getResource: (t, r, a) => this.getResource(t, r, a),
      },
      typeId,
      resourceId,
      accountId,
    );
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    if (typeId === "ec2-instance" && (actionId === "start" || actionId === "stop")) {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const instanceId = String(resource.externalId ?? resource.fields["instanceId"] ?? "");
      if (!instanceId) throw new Error("Cannot determine EC2 instance ID");
      const region = String(resource.fields["region"] ?? this.creds.region);
      await ec2Call(
        this.credsFor(region),
        actionId === "start" ? "StartInstances" : "StopInstances",
        { "InstanceId.1": instanceId },
      );
      return;
    }
    if (typeId === "rds-instance" && (actionId === "start" || actionId === "stop")) {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const dbId = String(resource.externalId ?? resource.fields["dbInstanceId"] ?? "");
      if (!dbId) throw new Error("Cannot determine RDS instance identifier");
      const region = String(resource.fields["region"] ?? this.creds.region);
      await queryPostCall(
        this.credsFor(region),
        "rds",
        actionId === "start" ? "StartDBInstance" : "StopDBInstance",
        "2014-10-31",
        { DBInstanceIdentifier: dbId },
      );
      return;
    }
    throw new Error(`AWS plugin: invokeAction "${actionId}" not supported for type "${typeId}"`);
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    if (typeId === "dynamodb-table") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const tableName = String(resource.fields["tableName"] ?? resource.externalId ?? "");
      const region = String(resource.fields["region"] ?? this.creds.region);
      return executeDynamoDbCommand(this.credsFor(region), tableName, command, args);
    }
    throw new Error(`AWS plugin: executeNoSqlCommand not supported for type "${typeId}"`);
  }

  async exportCredential(
    typeId: string,
    resourceId: string,
    accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    if (typeId === "iam-user" && formatId === "access-key") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const userName = String(resource.externalId ?? resource.fields["userName"] ?? "");
      if (!userName) throw new Error("Cannot determine IAM user name");
      const data = await queryPostCall<Record<string, unknown>>(
        this.creds,
        "iam",
        "CreateAccessKey",
        "2010-05-08",
        { UserName: userName },
      );
      const result = data["CreateAccessKeyResult"] as Record<string, unknown> | undefined;
      const accessKey = (result?.["AccessKey"] as Record<string, unknown>) ?? {};
      const id = String(accessKey["AccessKeyId"] ?? "");
      const secret = String(accessKey["SecretAccessKey"] ?? "");
      if (!id || !secret) throw new Error("AWS returned an empty access key");
      const ini = `[default]\naws_access_key_id=${id}\naws_secret_access_key=${secret}\n`;
      return {
        content: ini,
        filename: `${userName}.credentials`,
        mimeType: "text/plain",
        fields: [
          { label: "Access Key ID", value: id },
          { label: "Secret Access Key", value: secret, sensitive: true, hint: "Only shown once" },
        ],
        warning:
          "Save this secret access key now. AWS will not show it again — if lost, delete this key and create a new one.",
      };
    }
    throw new Error(
      `AWS plugin: exportCredential not supported for type "${typeId}" / format "${formatId}"`,
    );
  }

  async getManifest(resourceId: string, accountId: string): Promise<string> {
    // Determine the type from the resourceId pattern (accountId:typeId:externalId)
    const parts = resourceId.split(":");
    const typeId = parts[1] ?? "";

    if (typeId === "s3-bucket") {
      const externalId = parts.slice(2).join(":");
      const raw = await getBucketPolicy(this.creds, externalId);
      if (!raw) return "";
      // Pretty-print the JSON so the editor opens nicely formatted.
      try {
        return JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        return raw;
      }
    }

    const resource = await this.getResource(typeId, resourceId, accountId);
    return JSON.stringify(
      {
        resourceTypeId: resource.resourceTypeId,
        externalId: resource.externalId,
        displayName: resource.displayName,
        fields: resource.fields,
        resolvedOutputs: resource.resolvedOutputs,
      },
      null,
      2,
    );
  }

  async applyManifest(resourceId: string, _accountId: string, manifest: string): Promise<void> {
    const parts = resourceId.split(":");
    const typeId = parts[1] ?? "";
    if (typeId !== "s3-bucket") {
      throw new Error(`AWS plugin: applyManifest not supported for type "${typeId}"`);
    }
    const externalId = parts.slice(2).join(":");
    return putBucketPolicy(this.creds, externalId, manifest);
  }

  /**
   * Chat with a Bedrock foundation model via the (non-streaming) Converse API.
   * We make a single signed POST to `bedrock-runtime.<region>/model/<id>/
   * converse` — Converse is signed under the `bedrock` service name, same as
   * the control-plane list call. Bedrock's streaming variant uses the binary
   * `application/vnd.amazon.eventstream` framing, so we deliberately use the
   * plain-JSON non-streaming call and surface the whole reply as one delta.
   */
  async *streamChatMessage(
    typeId: string,
    resourceId: string,
    _accountId: string,
    messages: ChatMessage[],
  ): AsyncGenerator<ChatStreamEvent, void, unknown> {
    if (typeId !== "bedrock-model") {
      yield {
        kind: "error",
        message: `AWS plugin: streamChatMessage not supported for type "${typeId}".`,
      };
      return;
    }
    // resourceId is `${accountId}:bedrock-model:${modelId}`. modelIds contain
    // colons (e.g. `anthropic.claude-3-5-sonnet-20240620-v1:0`), so rejoin
    // everything past the type segment.
    const modelId = resourceId.split(":").slice(2).join(":");
    if (!modelId) {
      yield { kind: "error", message: "Couldn't determine the Bedrock model id." };
      return;
    }

    // Map our ChatMessage[] into Converse's shape: system turns collapse into
    // the top-level `system` array; user/assistant turns become content blocks.
    const systemBlocks = messages
      .filter((m) => m.role === "system")
      .map((m) => ({ text: m.content }));
    const conversation = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: [{ text: m.content }] }));
    const body: Record<string, unknown> = {
      messages: conversation,
      inferenceConfig: { maxTokens: 1024 },
      ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
    };

    const host = `bedrock-runtime.${this.creds.region}.amazonaws.com`;
    let res: Response;
    try {
      res = await fetchSigned({
        method: "POST",
        url: `https://${host}/model/${encodeURIComponent(modelId)}/converse`,
        headers: { Host: host, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        service: "bedrock",
        credentials: this.creds,
      });
    } catch (err) {
      yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
      return;
    }

    let parsed: {
      output?: { message?: { content?: Array<{ text?: string }> } };
      usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    };
    try {
      parsed = (await res.json()) as typeof parsed;
    } catch (err) {
      yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
      return;
    }

    const text = (parsed.output?.message?.content ?? []).map((block) => block.text ?? "").join("");
    yield { kind: "delta", text };

    // exactOptionalPropertyTypes is on, so only attach usage keys that the
    // response actually carried rather than assigning `undefined`.
    const usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};
    if (typeof parsed.usage?.inputTokens === "number") usage.inputTokens = parsed.usage.inputTokens;
    if (typeof parsed.usage?.outputTokens === "number") {
      usage.outputTokens = parsed.usage.outputTokens;
    }
    if (typeof parsed.usage?.totalTokens === "number") usage.totalTokens = parsed.usage.totalTokens;

    yield {
      kind: "done",
      message: { role: "assistant", content: text },
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
    };
  }
}
