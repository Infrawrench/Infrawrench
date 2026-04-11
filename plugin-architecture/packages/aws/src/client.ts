import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  ResourceStatus,
  StorageObject,
  CreateResourceConfig,
  RegionOption,
  SizeOption,
} from "@infrawrench/plugin-base";
import {
  renderDnsRecordDetail,
  renderDnsRecordSidebar,
  dnsZoneStatus,
} from "@infrawrench/plugin-base";
import { signRequest, parseXml, ensureArray } from "./auth.js";
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
  listMQBrokers,
  listBatchJobQueues,
  listSageMakerEndpoints,
} from "./resource-listers-extended.js";

const SERVICE_HOSTS: Record<string, string> = {
  ec2: "ec2.{region}.amazonaws.com",
  s3: "s3.{region}.amazonaws.com",
  rds: "rds.{region}.amazonaws.com",
  lambda: "lambda.{region}.amazonaws.com",
  ecs: "ecs.{region}.amazonaws.com",
  eks: "eks.{region}.amazonaws.com",
  dynamodb: "dynamodb.{region}.amazonaws.com",
  elasticache: "elasticache.{region}.amazonaws.com",
  sqs: "sqs.{region}.amazonaws.com",
  sns: "sns.{region}.amazonaws.com",
  ecr: "api.ecr.{region}.amazonaws.com",
  secretsmanager: "secretsmanager.{region}.amazonaws.com",
  cloudfront: "cloudfront.amazonaws.com",
  iam: "iam.amazonaws.com",
  route53: "route53.amazonaws.com",
  elasticloadbalancing: "elasticloadbalancing.{region}.amazonaws.com",
  autoscaling: "autoscaling.{region}.amazonaws.com",
  states: "states.{region}.amazonaws.com",
  events: "events.{region}.amazonaws.com",
  kinesis: "kinesis.{region}.amazonaws.com",
  redshift: "redshift.{region}.amazonaws.com",
  es: "es.{region}.amazonaws.com",
  acm: "acm.{region}.amazonaws.com",
  wafv2: "wafv2.{region}.amazonaws.com",
  codebuild: "codebuild.{region}.amazonaws.com",
  codepipeline: "codepipeline.{region}.amazonaws.com",
  cloudformation: "cloudformation.{region}.amazonaws.com",
  ssm: "ssm.{region}.amazonaws.com",
  elasticfilesystem: "elasticfilesystem.{region}.amazonaws.com",
  apigateway: "apigateway.{region}.amazonaws.com",
  monitoring: "monitoring.{region}.amazonaws.com",
  logs: "logs.{region}.amazonaws.com",
  apprunner: "apprunner.{region}.amazonaws.com",
  glue: "glue.{region}.amazonaws.com",
  kafka: "kafka.{region}.amazonaws.com",
  cloudtrail: "cloudtrail.{region}.amazonaws.com",
  mq: "mq.{region}.amazonaws.com",
  batch: "batch.{region}.amazonaws.com",
  sagemaker: "api.sagemaker.{region}.amazonaws.com",
  neptune: "rds.{region}.amazonaws.com",
};

// Services that are global (no region in hostname)
const GLOBAL_SERVICES = new Set(["cloudfront", "iam", "route53"]);

export class AWSClient implements PluginClient {
  private readonly creds: AwsCredentials;

  constructor(credentials: Record<string, string>) {
    const accessKeyId = credentials["accessKeyId"];
    const secretAccessKey = credentials["secretAccessKey"];
    const region = credentials["region"] ?? "us-east-1";
    if (!accessKeyId || !secretAccessKey) {
      throw new Error("AWS plugin: missing accessKeyId or secretAccessKey");
    }
    this.creds = { accessKeyId, secretAccessKey, region };
  }

  private hostForService(service: string): string {
    const template = SERVICE_HOSTS[service] ?? `${service}.${this.creds.region}.amazonaws.com`;
    return template.replace("{region}", this.creds.region);
  }

  /** Make an EC2-style XML query API call */
  private async ec2<T>(action: string, params?: Record<string, string>): Promise<T> {
    const host = this.hostForService("ec2");
    const searchParams = new URLSearchParams({
      Action: action,
      Version: "2016-11-15",
      ...params,
    });
    const url = `https://${host}/?${searchParams}`;
    const headers = await signRequest({
      method: "GET",
      url,
      headers: { Host: host },
      service: "ec2",
      credentials: this.creds,
    });
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`EC2 ${action} failed: ${res.status}`);
    const xml = await res.text();
    return parseXml(xml) as T;
  }

  /** Make a JSON API call (DynamoDB, ECS, etc.) */
  private async json<T>(service: string, target: string, body: Record<string, unknown>): Promise<T> {
    const host = this.hostForService(service);
    const url = `https://${host}/`;
    const bodyStr = JSON.stringify(body);
    const headers = await signRequest({
      method: "POST",
      url,
      headers: {
        Host: host,
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": target,
      },
      body: bodyStr,
      service,
      credentials: this.creds,
    });
    const res = await fetch(url, { method: "POST", headers, body: bodyStr });
    if (!res.ok) throw new Error(`${service} ${target} failed: ${res.status}`);
    return res.json() as Promise<T>;
  }

  /** Make an XML Query API call for non-EC2 services */
  private async ec2Query<T>(service: string, action: string, version: string, params?: Record<string, string>): Promise<T> {
    const host = this.hostForService(service);
    const searchParams = new URLSearchParams({
      Action: action,
      Version: version,
      ...params,
    });
    const url = `https://${host}/?${searchParams}`;
    const headers = await signRequest({
      method: "GET",
      url,
      headers: { Host: host },
      service,
      credentials: this.creds,
    });
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`${service} ${action} failed: ${res.status}`);
    const xml = await res.text();
    return parseXml(xml) as T;
  }

  /** Make a JSON REST GET call (Lambda, EKS, CloudFront) */
  private async jsonGet<T>(service: string, path: string): Promise<T> {
    const host = this.hostForService(service);
    const url = `https://${host}${path}`;
    const svc = GLOBAL_SERVICES.has(service) ? service : service;
    const headers = await signRequest({
      method: "GET",
      url,
      headers: { Host: host },
      service: svc,
      credentials: this.creds,
    });
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`${service} GET ${path} failed: ${res.status}`);
    return res.json() as Promise<T>;
  }

  private makeId(accountId: string, typeId: string, externalId: string): string {
    return `${accountId}:${typeId}:${externalId}`;
  }

  private get ctx(): ListerContext {
    return {
      ec2: <T>(action: string, params?: Record<string, string>) => this.ec2<T>(action, params),
      json: <T>(service: string, target: string, body: Record<string, unknown>) => this.json<T>(service, target, body),
      jsonGet: <T>(service: string, path: string) => this.jsonGet<T>(service, path),
      ec2Query: <T>(service: string, action: string, version: string, params?: Record<string, string>) => this.ec2Query<T>(service, action, version, params),
      id: (accountId, typeId, externalId) => this.makeId(accountId, typeId, externalId),
      now: () => new Date().toISOString(),
      region: this.creds.region,
    };
  }

  private static readonly LISTERS: Record<string, (ctx: ListerContext, accountId: string) => Promise<ResourceInstance[]>> = {
    "ec2-instance": listEC2Instances,
    "ebs-volume": listEBSVolumes,
    "vpc": listVPCs,
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
    "alb": listALBs,
    "target-group": listTargetGroups,
    "auto-scaling-group": listAutoScalingGroups,
    "iam-role": listIAMRoles,
    "security-group": listSecurityGroups,
    "subnet": listSubnets,
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
    "mq-broker": listMQBrokers,
    "batch-job-queue": listBatchJobQueues,
    "sagemaker-endpoint": listSageMakerEndpoints,
  };

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    const lister = AWSClient.LISTERS[typeId];
    if (!lister) throw new Error(`AWS plugin: unknown resource type "${typeId}"`);
    return lister(this.ctx, accountId);
  }

  async getResource(typeId: string, resourceId: string, accountId: string): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`AWS plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.resolvedOutputs[outputKey];
    if (value === undefined) {
      throw new Error(`AWS plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
    }
    return String(value);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    // Use shared DNS helpers for Route 53 records
    if (resource.resourceTypeId === "route53-record-set") {
      return renderDnsRecordDetail(resource, {});
    }

    const fields = resource.fields;
    const state = String(fields["state"] ?? fields["status"] ?? "");

    const statusMap: Record<string, ResourceStatus> = {
      // Generic
      running: "healthy",
      active: "healthy",
      "in-use": "healthy",
      available: "healthy",
      issued: "healthy",
      ok: "healthy",
      enabled: "healthy",
      // Degraded / stopped
      stopped: "degraded",
      stopping: "degraded",
      paused: "degraded",
      disabled: "degraded",
      inactive: "degraded",
      "insufficient_data": "degraded",
      // Provisioning / in-progress
      pending: "provisioning",
      creating: "provisioning",
      updating: "provisioning",
      provisioning: "provisioning",
      "create_in_progress": "provisioning",
      "update_in_progress": "provisioning",
      "operation_in_progress": "provisioning",
      "pending_validation": "provisioning",
      // Error
      "shutting-down": "error",
      terminated: "error",
      deleting: "error",
      deleted: "error",
      failed: "error",
      "create_failed": "error",
      "delete_failed": "error",
      "rollback_complete": "error",
      "rollback_failed": "error",
      alarm: "error",
      revoked: "error",
      expired: "error",
    };
    const dotStatus = statusMap[state.toLowerCase()] ?? "unknown";

    return {
      title: resource.displayName,
      subtitle: `${resource.resourceTypeId} \u00B7 ${this.creds.region}`,
      status: state
        ? { kind: "status-dot", status: dotStatus, label: state }
        : { kind: "status-dot", status: dotStatus },
      sections: [
        {
          kind: "section",
          title: "Details",
          children: [
            {
              kind: "key-value-list",
              items: Object.entries(fields).map(([key, value]) => ({
                key,
                value: String(value),
              })),
            },
          ],
        },
        ...(Object.keys(resource.resolvedOutputs).length > 0
          ? [
              {
                kind: "section" as const,
                title: "Outputs",
                children: [
                  {
                    kind: "key-value-list" as const,
                    items: Object.entries(resource.resolvedOutputs).map(([key, value]) => ({
                      key,
                      value: String(value),
                      copyable: true,
                    })),
                  },
                ],
              },
            ]
          : []),
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    // Use shared DNS helpers for Route 53 records
    if (resource.resourceTypeId === "route53-record-set") {
      return renderDnsRecordSidebar(resource);
    }
    // Route 53 hosted zones use the shared dnsZoneStatus helper
    if (resource.resourceTypeId === "route53-hosted-zone") {
      const isPrivate = resource.fields["isPrivate"];
      const label = isPrivate ? "Private" : "Active";
      return {
        id: resource.id,
        label: resource.displayName,
        status: { kind: "status-dot", status: dnsZoneStatus("active"), label },
      };
    }

    const state = String(resource.fields["state"] ?? resource.fields["status"] ?? "");
    const statusMap: Record<string, ResourceStatus> = {
      running: "healthy",
      active: "healthy",
      available: "healthy",
      "in-use": "healthy",
      issued: "healthy",
      ok: "healthy",
      enabled: "healthy",
      stopped: "degraded",
      paused: "degraded",
      disabled: "degraded",
      terminated: "error",
      failed: "error",
      deleted: "error",
      alarm: "error",
    };
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: statusMap[state.toLowerCase()] ?? "unknown" },
    };
  }

  /** S3-specific XML GET for ListObjectsV2 */
  private async s3Xml<T>(bucket: string, params: Record<string, string>): Promise<T> {
    const host = `${bucket}.s3.${this.creds.region}.amazonaws.com`;
    const searchParams = new URLSearchParams(params);
    const url = `https://${host}/?${searchParams}`;
    const headers = await signRequest({
      method: "GET",
      url,
      headers: { Host: host },
      service: "s3",
      credentials: this.creds,
    });
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`S3 ListObjectsV2 failed: ${res.status}`);
    const xml = await res.text();
    return parseXml(xml) as T;
  }

  /** S3 PUT object */
  private async s3Put(bucket: string, key: string, body: string | ArrayBuffer): Promise<void> {
    const host = `${bucket}.s3.${this.creds.region}.amazonaws.com`;
    const url = `https://${host}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
    const bodyStr = typeof body === "string" ? body : "";
    const headers = await signRequest({
      method: "PUT",
      url,
      headers: { Host: host, "Content-Type": "application/octet-stream" },
      body: bodyStr,
      service: "s3",
      credentials: this.creds,
    });
    const res = await fetch(url, { method: "PUT", headers, body });
    if (!res.ok) throw new Error(`S3 PUT ${key} failed: ${res.status}`);
  }

  /** S3 DELETE object */
  private async s3Delete(bucket: string, key: string): Promise<void> {
    const host = `${bucket}.s3.${this.creds.region}.amazonaws.com`;
    const url = `https://${host}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
    const headers = await signRequest({
      method: "DELETE",
      url,
      headers: { Host: host },
      service: "s3",
      credentials: this.creds,
    });
    const res = await fetch(url, { method: "DELETE", headers });
    if (!res.ok) throw new Error(`S3 DELETE ${key} failed: ${res.status}`);
  }

  async uploadStorageObject(bucket: string, key: string, file: File): Promise<void> {
    const host = `${bucket}.s3.${this.creds.region}.amazonaws.com`;
    const url = `https://${host}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
    const body = await file.arrayBuffer();
    const bodyStr = new TextDecoder().decode(body);
    const headers = await signRequest({
      method: "PUT",
      url,
      headers: {
        Host: host,
        "Content-Type": file.type || "application/octet-stream",
        "Content-Length": String(body.byteLength),
      },
      body: bodyStr,
      service: "s3",
      credentials: this.creds,
    });
    const res = await fetch(url, { method: "PUT", headers, body });
    if (!res.ok) throw new Error(`S3 upload ${key} failed: ${res.status}`);
  }

  async listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    const results: StorageObject[] = [];
    let continuationToken: string | undefined;

    do {
      const params: Record<string, string> = {
        "list-type": "2",
        delimiter: "/",
        "max-keys": "1000",
      };
      if (prefix) params["prefix"] = prefix;
      if (continuationToken) params["continuation-token"] = continuationToken;

      const data = await this.s3Xml<Record<string, unknown>>(bucket, params);

      // Common prefixes (directories)
      const prefixes = ensureArray(data["CommonPrefixes"]) as Record<string, unknown>[];
      for (const p of prefixes) {
        const key = String(p["Prefix"] ?? "");
        const name = key.slice(prefix.length).replace(/\/$/, "");
        results.push({ key, name, size: 0, lastModified: "", isDirectory: true });
      }

      // Objects
      const contents = ensureArray(data["Contents"]) as Record<string, unknown>[];
      for (const obj of contents) {
        const key = String(obj["Key"] ?? "");
        if (key === prefix) continue; // skip folder placeholder
        const name = key.slice(prefix.length);
        results.push({
          key,
          name,
          size: Number(obj["Size"] ?? 0),
          lastModified: String(obj["LastModified"] ?? ""),
          isDirectory: false,
        });
      }

      continuationToken = data["IsTruncated"] === "true"
        ? String(data["NextContinuationToken"] ?? "")
        : undefined;
    } while (continuationToken);

    return results;
  }

  async makeStorageFolder(bucket: string, key: string): Promise<void> {
    const folderKey = key.endsWith("/") ? key : `${key}/`;
    await this.s3Put(bucket, folderKey, "");
  }

  async deleteStorageObject(bucket: string, key: string): Promise<void> {
    if (key.endsWith("/")) {
      // Delete all objects under this prefix
      const objects = await this.listStorageObjects(bucket, key);
      for (const obj of objects) {
        if (obj.isDirectory) {
          await this.deleteStorageObject(bucket, obj.key);
        } else {
          await this.s3Delete(bucket, obj.key);
        }
      }
      // Delete the folder placeholder itself
      await this.s3Delete(bucket, key);
    } else {
      await this.s3Delete(bucket, key);
    }
  }

  async fetchStorageStats(bucketName: string): Promise<{ count: number; size: string }> {
    let count = 0;
    let totalBytes = 0;
    let continuationToken: string | undefined;

    do {
      const params: Record<string, string> = {
        "list-type": "2",
        "max-keys": "1000",
      };
      if (continuationToken) params["continuation-token"] = continuationToken;

      const data = await this.s3Xml<Record<string, unknown>>(bucketName, params);
      const contents = ensureArray(data["Contents"]) as Record<string, unknown>[];
      for (const obj of contents) {
        count++;
        totalBytes += Number(obj["Size"] ?? 0);
      }

      continuationToken = data["IsTruncated"] === "true"
        ? String(data["NextContinuationToken"] ?? "")
        : undefined;
    } while (continuationToken);

    return { count, size: formatBytes(totalBytes) };
  }

  private static readonly AWS_REGIONS: RegionOption[] = [
    { id: "us-east-1", label: "us-east-1", location: "N. Virginia, USA", flag: "\u{1F1FA}\u{1F1F8}" },
    { id: "us-east-2", label: "us-east-2", location: "Ohio, USA", flag: "\u{1F1FA}\u{1F1F8}" },
    { id: "us-west-1", label: "us-west-1", location: "N. California, USA", flag: "\u{1F1FA}\u{1F1F8}" },
    { id: "us-west-2", label: "us-west-2", location: "Oregon, USA", flag: "\u{1F1FA}\u{1F1F8}" },
    { id: "ca-central-1", label: "ca-central-1", location: "Montreal, Canada", flag: "\u{1F1E8}\u{1F1E6}" },
    { id: "eu-west-1", label: "eu-west-1", location: "Ireland", flag: "\u{1F1EE}\u{1F1EA}" },
    { id: "eu-west-2", label: "eu-west-2", location: "London, UK", flag: "\u{1F1EC}\u{1F1E7}" },
    { id: "eu-west-3", label: "eu-west-3", location: "Paris, France", flag: "\u{1F1EB}\u{1F1F7}" },
    { id: "eu-central-1", label: "eu-central-1", location: "Frankfurt, Germany", flag: "\u{1F1E9}\u{1F1EA}" },
    { id: "eu-central-2", label: "eu-central-2", location: "Zurich, Switzerland", flag: "\u{1F1E8}\u{1F1ED}" },
    { id: "eu-north-1", label: "eu-north-1", location: "Stockholm, Sweden", flag: "\u{1F1F8}\u{1F1EA}" },
    { id: "eu-south-1", label: "eu-south-1", location: "Milan, Italy", flag: "\u{1F1EE}\u{1F1F9}" },
    { id: "eu-south-2", label: "eu-south-2", location: "Spain", flag: "\u{1F1EA}\u{1F1F8}" },
    { id: "ap-southeast-1", label: "ap-southeast-1", location: "Singapore", flag: "\u{1F1F8}\u{1F1EC}" },
    { id: "ap-southeast-2", label: "ap-southeast-2", location: "Sydney, Australia", flag: "\u{1F1E6}\u{1F1FA}" },
    { id: "ap-southeast-3", label: "ap-southeast-3", location: "Jakarta, Indonesia", flag: "\u{1F1EE}\u{1F1E9}" },
    { id: "ap-northeast-1", label: "ap-northeast-1", location: "Tokyo, Japan", flag: "\u{1F1EF}\u{1F1F5}" },
    { id: "ap-northeast-2", label: "ap-northeast-2", location: "Seoul, South Korea", flag: "\u{1F1F0}\u{1F1F7}" },
    { id: "ap-northeast-3", label: "ap-northeast-3", location: "Osaka, Japan", flag: "\u{1F1EF}\u{1F1F5}" },
    { id: "ap-south-1", label: "ap-south-1", location: "Mumbai, India", flag: "\u{1F1EE}\u{1F1F3}" },
    { id: "ap-south-2", label: "ap-south-2", location: "Hyderabad, India", flag: "\u{1F1EE}\u{1F1F3}" },
    { id: "ap-east-1", label: "ap-east-1", location: "Hong Kong", flag: "\u{1F1ED}\u{1F1F0}" },
    { id: "sa-east-1", label: "sa-east-1", location: "São Paulo, Brazil", flag: "\u{1F1E7}\u{1F1F7}" },
    { id: "me-south-1", label: "me-south-1", location: "Bahrain", flag: "\u{1F1E7}\u{1F1ED}" },
    { id: "me-central-1", label: "me-central-1", location: "UAE", flag: "\u{1F1E6}\u{1F1EA}" },
    { id: "af-south-1", label: "af-south-1", location: "Cape Town, South Africa", flag: "\u{1F1FF}\u{1F1E6}" },
    { id: "il-central-1", label: "il-central-1", location: "Tel Aviv, Israel", flag: "\u{1F1EE}\u{1F1F1}" },
  ];

  private static readonly EC2_SIZES: SizeOption[] = [
    // T3 burstable
    { id: "t3.nano", label: "t3.nano", vcpus: 2, memoryMb: 512, category: "T3 · Burstable" },
    { id: "t3.micro", label: "t3.micro", vcpus: 2, memoryMb: 1024, category: "T3 · Burstable" },
    { id: "t3.small", label: "t3.small", vcpus: 2, memoryMb: 2048, category: "T3 · Burstable" },
    { id: "t3.medium", label: "t3.medium", vcpus: 2, memoryMb: 4096, category: "T3 · Burstable" },
    { id: "t3.large", label: "t3.large", vcpus: 2, memoryMb: 8192, category: "T3 · Burstable" },
    { id: "t3.xlarge", label: "t3.xlarge", vcpus: 4, memoryMb: 16384, category: "T3 · Burstable" },
    { id: "t3.2xlarge", label: "t3.2xlarge", vcpus: 8, memoryMb: 32768, category: "T3 · Burstable" },
    // M6i general purpose
    { id: "m6i.large", label: "m6i.large", vcpus: 2, memoryMb: 8192, category: "M6i · General purpose" },
    { id: "m6i.xlarge", label: "m6i.xlarge", vcpus: 4, memoryMb: 16384, category: "M6i · General purpose" },
    { id: "m6i.2xlarge", label: "m6i.2xlarge", vcpus: 8, memoryMb: 32768, category: "M6i · General purpose" },
    { id: "m6i.4xlarge", label: "m6i.4xlarge", vcpus: 16, memoryMb: 65536, category: "M6i · General purpose" },
    { id: "m6i.8xlarge", label: "m6i.8xlarge", vcpus: 32, memoryMb: 131072, category: "M6i · General purpose" },
    // C6i compute-optimized
    { id: "c6i.large", label: "c6i.large", vcpus: 2, memoryMb: 4096, category: "C6i · Compute-optimized" },
    { id: "c6i.xlarge", label: "c6i.xlarge", vcpus: 4, memoryMb: 8192, category: "C6i · Compute-optimized" },
    { id: "c6i.2xlarge", label: "c6i.2xlarge", vcpus: 8, memoryMb: 16384, category: "C6i · Compute-optimized" },
    { id: "c6i.4xlarge", label: "c6i.4xlarge", vcpus: 16, memoryMb: 32768, category: "C6i · Compute-optimized" },
    // R6i memory-optimized
    { id: "r6i.large", label: "r6i.large", vcpus: 2, memoryMb: 16384, category: "R6i · Memory-optimized" },
    { id: "r6i.xlarge", label: "r6i.xlarge", vcpus: 4, memoryMb: 32768, category: "R6i · Memory-optimized" },
    { id: "r6i.2xlarge", label: "r6i.2xlarge", vcpus: 8, memoryMb: 65536, category: "R6i · Memory-optimized" },
    { id: "r6i.4xlarge", label: "r6i.4xlarge", vcpus: 16, memoryMb: 131072, category: "R6i · Memory-optimized" },
  ];

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === "ec2-instance") {
      return {
        fields: [
          { key: "name", label: "Instance Name", kind: "text", required: true, description: "Name tag for the EC2 instance" },
          { key: "region", label: "Region", kind: "region-picker", required: true, regions: AWSClient.AWS_REGIONS, defaultValue: this.creds.region },
          { key: "instanceType", label: "Instance Type", kind: "size-picker", required: true, sizes: AWSClient.EC2_SIZES },
          {
            key: "imageId", label: "AMI", kind: "image-picker", required: true,
            images: [
              { id: "ami-0c02fb55956c7d316", label: "Amazon Linux 2023", category: "Amazon Linux", family: "al2023" },
              { id: "ami-0261755bbcb8c4a84", label: "Amazon Linux 2", category: "Amazon Linux", family: "amzn2" },
              { id: "ami-0c7217cdde317cfec", label: "Ubuntu 22.04 LTS", category: "Ubuntu", family: "ubuntu-2204" },
              { id: "ami-0e001c9271cf7f3b9", label: "Ubuntu 24.04 LTS", category: "Ubuntu", family: "ubuntu-2404" },
              { id: "ami-0b0dcb5067f052a63", label: "Debian 12", category: "Debian", family: "debian-12" },
              { id: "ami-0dfcb1ef8fc5fd105", label: "Red Hat Enterprise Linux 9", category: "RHEL", family: "rhel-9" },
              { id: "ami-0b5eea76982371e91", label: "SUSE Linux Enterprise Server 15", category: "SUSE", family: "sles-15" },
            ],
          },
          { key: "diskSizeGb", label: "Root Volume Size", kind: "disk-slider", required: false, minGb: 8, maxGb: 2048, defaultGb: 20, stepGb: 1 },
          { key: "sshKey", label: "SSH Key", kind: "ssh-key-picker", required: false, description: "Key pair name for SSH access" },
        ],
      };
    }
    if (typeId === "eks-cluster") {
      return {
        fields: [
          { key: "name", label: "Cluster Name", kind: "text", required: true },
          { key: "region", label: "Region", kind: "region-picker", required: true, regions: AWSClient.AWS_REGIONS, defaultValue: this.creds.region },
          {
            key: "version", label: "Kubernetes Version", kind: "select", required: true,
            options: [
              { id: "1.32", label: "1.32" },
              { id: "1.31", label: "1.31" },
              { id: "1.30", label: "1.30" },
              { id: "1.29", label: "1.29" },
              { id: "1.28", label: "1.28" },
            ],
            defaultValue: "1.31",
          },
        ],
      };
    }
    if (typeId === "s3-bucket") {
      return {
        fields: [
          { key: "name", label: "Bucket Name", kind: "text", required: true, description: "Globally unique S3 bucket name" },
          { key: "region", label: "Region", kind: "region-picker", required: true, regions: AWSClient.AWS_REGIONS, defaultValue: this.creds.region },
        ],
      };
    }
    if (typeId === "vpc") {
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          { key: "cidrBlock", label: "CIDR Block", kind: "text", required: true, defaultValue: "10.0.0.0/16", description: "IPv4 CIDR block (e.g. 10.0.0.0/16)" },
        ],
      };
    }
    if (typeId === "security-group") {
      return {
        fields: [
          { key: "groupName", label: "Group Name", kind: "text", required: true },
          { key: "description", label: "Description", kind: "text", required: true },
          { key: "vpcId", label: "VPC ID", kind: "text", required: false, description: "VPC to create in (defaults to default VPC)" },
        ],
      };
    }
    if (typeId === "sqs-queue") {
      return {
        fields: [
          { key: "queueName", label: "Queue Name", kind: "text", required: true },
          { key: "fifo", label: "FIFO Queue", kind: "select", required: false, options: [{ id: "false", label: "Standard" }, { id: "true", label: "FIFO" }], defaultValue: "false" },
        ],
      };
    }
    if (typeId === "sns-topic") {
      return {
        fields: [
          { key: "topicName", label: "Topic Name", kind: "text", required: true },
          { key: "fifo", label: "FIFO Topic", kind: "select", required: false, options: [{ id: "false", label: "Standard" }, { id: "true", label: "FIFO" }], defaultValue: "false" },
        ],
      };
    }
    if (typeId === "dynamodb-table") {
      return {
        fields: [
          { key: "tableName", label: "Table Name", kind: "text", required: true },
          { key: "partitionKey", label: "Partition Key", kind: "text", required: true, description: "Primary key attribute name" },
          { key: "partitionKeyType", label: "Partition Key Type", kind: "select", required: true, options: [{ id: "S", label: "String" }, { id: "N", label: "Number" }, { id: "B", label: "Binary" }], defaultValue: "S" },
          { key: "sortKey", label: "Sort Key", kind: "text", required: false, description: "Optional sort key attribute name" },
          { key: "sortKeyType", label: "Sort Key Type", kind: "select", required: false, options: [{ id: "S", label: "String" }, { id: "N", label: "Number" }, { id: "B", label: "Binary" }], defaultValue: "S" },
          { key: "billingMode", label: "Billing Mode", kind: "select", required: true, options: [{ id: "PAY_PER_REQUEST", label: "On-demand" }, { id: "PROVISIONED", label: "Provisioned" }], defaultValue: "PAY_PER_REQUEST" },
        ],
      };
    }
    throw new Error(`AWS plugin: getCreateConfig not supported for type "${typeId}"`);
  }

  async createResource(typeId: string, accountId: string, fields: Record<string, string>): Promise<ResourceInstance> {
    if (typeId === "ec2-instance") {
      const params: Record<string, string> = {
        "ImageId": fields["imageId"] ?? "",
        "InstanceType": fields["instanceType"] ?? "t3.micro",
        "MinCount": "1",
        "MaxCount": "1",
      };
      if (fields["sshKey"]) params["KeyName"] = fields["sshKey"];
      if (fields["diskSizeGb"]) {
        params["BlockDeviceMapping.1.DeviceName"] = "/dev/xvda";
        params["BlockDeviceMapping.1.Ebs.VolumeSize"] = fields["diskSizeGb"];
        params["BlockDeviceMapping.1.Ebs.VolumeType"] = "gp3";
      }

      const data = await this.ec2<Record<string, unknown>>("RunInstances", params);
      const instancesSet = data["instancesSet"] as Record<string, unknown> | undefined;
      const instances = ensureArray(instancesSet?.["item"]) as Record<string, unknown>[];
      const inst = instances[0];
      if (!inst) throw new Error("EC2 RunInstances returned no instance");

      const instanceId = String(inst["instanceId"] ?? "");

      // Tag with name
      if (fields["name"]) {
        await this.ec2("CreateTags", {
          "ResourceId.1": instanceId,
          "Tag.1.Key": "Name",
          "Tag.1.Value": fields["name"],
        });
      }

      return {
        id: this.makeId(accountId, "ec2-instance", instanceId),
        pluginId: "aws",
        resourceTypeId: "ec2-instance",
        accountId,
        displayName: fields["name"] || instanceId,
        fields: {
          name: fields["name"] ?? "",
          instanceId,
          instanceType: String(inst["instanceType"] ?? ""),
          availabilityZone: String(
            (inst["placement"] as Record<string, unknown> | undefined)?.["availabilityZone"] ?? "",
          ),
          state: "pending",
          imageId: String(inst["imageId"] ?? ""),
          vpcId: String(inst["vpcId"] ?? ""),
          subnetId: String(inst["subnetId"] ?? ""),
        },
        resolvedOutputs: {
          publicIp: "",
          privateIp: String(inst["privateIpAddress"] ?? ""),
          publicDns: "",
        },
        secretStates: [],
        externalId: instanceId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    if (typeId === "s3-bucket") {
      const bucketName = fields["name"] ?? "";
      const host = `${bucketName}.s3.${this.creds.region}.amazonaws.com`;
      const url = `https://${host}/`;
      const bodyXml = this.creds.region === "us-east-1"
        ? ""
        : `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${this.creds.region}</LocationConstraint></CreateBucketConfiguration>`;
      const headers = await signRequest({
        method: "PUT",
        url,
        headers: { Host: host },
        body: bodyXml,
        service: "s3",
        credentials: this.creds,
      });
      const res = await fetch(url, { method: "PUT", headers, ...(bodyXml ? { body: bodyXml } : {}) });
      if (!res.ok) throw new Error(`S3 CreateBucket failed: ${res.status} ${await res.text()}`);

      return {
        id: this.makeId(accountId, "s3-bucket", bucketName),
        pluginId: "aws",
        resourceTypeId: "s3-bucket",
        accountId,
        displayName: bucketName,
        fields: { name: bucketName, region: this.creds.region, creationDate: new Date().toISOString() },
        resolvedOutputs: {
          bucketArn: `arn:aws:s3:::${bucketName}`,
          endpoint: `https://${bucketName}.s3.${this.creds.region}.amazonaws.com`,
        },
        secretStates: [],
        externalId: bucketName,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    if (typeId === "vpc") {
      const data = await this.ec2<Record<string, unknown>>("CreateVpc", {
        CidrBlock: fields["cidrBlock"] ?? "10.0.0.0/16",
      });
      const vpc = (data["vpc"] ?? data) as Record<string, unknown>;
      const vpcId = String(vpc["vpcId"] ?? "");
      // Tag with name
      if (fields["name"]) {
        await this.ec2("CreateTags", {
          "ResourceId.1": vpcId,
          "Tag.1.Key": "Name",
          "Tag.1.Value": fields["name"],
        });
      }
      return {
        id: this.makeId(accountId, "vpc", vpcId),
        pluginId: "aws",
        resourceTypeId: "vpc",
        accountId,
        displayName: fields["name"] || vpcId,
        fields: {
          vpcId,
          name: fields["name"] ?? "",
          cidrBlock: fields["cidrBlock"] ?? "10.0.0.0/16",
          state: "available",
          isDefault: false,
          tenancy: "default",
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: vpcId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    if (typeId === "security-group") {
      const params: Record<string, string> = {
        GroupName: fields["groupName"] ?? "",
        GroupDescription: fields["description"] ?? "",
      };
      if (fields["vpcId"]) params["VpcId"] = fields["vpcId"];
      const data = await this.ec2<Record<string, unknown>>("CreateSecurityGroup", params);
      const groupId = String(data["groupId"] ?? "");
      return {
        id: this.makeId(accountId, "security-group", groupId),
        pluginId: "aws",
        resourceTypeId: "security-group",
        accountId,
        displayName: fields["groupName"] ?? groupId,
        fields: {
          groupId,
          groupName: fields["groupName"] ?? "",
          description: fields["description"] ?? "",
          vpcId: fields["vpcId"] ?? "",
          inboundRuleCount: 0,
          outboundRuleCount: 1,
        },
        resolvedOutputs: { groupId },
        secretStates: [],
        externalId: groupId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    if (typeId === "sqs-queue") {
      const queueName = fields["fifo"] === "true"
        ? (fields["queueName"] ?? "").replace(/\.fifo$/, "") + ".fifo"
        : fields["queueName"] ?? "";
      const body: Record<string, unknown> = { QueueName: queueName };
      if (fields["fifo"] === "true") {
        body["Attributes"] = { FifoQueue: "true" };
      }
      const data = await this.json<{ QueueUrl?: string }>(
        "sqs",
        "AmazonSQS.CreateQueue",
        body,
      );
      const queueUrl = data.QueueUrl ?? "";
      return {
        id: this.makeId(accountId, "sqs-queue", queueName),
        pluginId: "aws",
        resourceTypeId: "sqs-queue",
        accountId,
        displayName: queueName,
        fields: {
          queueName,
          queueUrl,
          approximateMessages: 0,
          approximateMessagesDelayed: 0,
          approximateMessagesNotVisible: 0,
          isFifo: queueName.endsWith(".fifo"),
        },
        resolvedOutputs: { queueArn: "" },
        secretStates: [],
        externalId: queueName,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    if (typeId === "sns-topic") {
      const topicName = fields["fifo"] === "true"
        ? (fields["topicName"] ?? "").replace(/\.fifo$/, "") + ".fifo"
        : fields["topicName"] ?? "";
      const body: Record<string, unknown> = { Name: topicName };
      if (fields["fifo"] === "true") {
        body["Attributes"] = { FifoTopic: "true" };
      }
      const data = await this.json<{ TopicArn?: string }>(
        "sns",
        "SNS.CreateTopic",
        body,
      );
      const topicArn = data.TopicArn ?? "";
      return {
        id: this.makeId(accountId, "sns-topic", topicName),
        pluginId: "aws",
        resourceTypeId: "sns-topic",
        accountId,
        displayName: topicName,
        fields: {
          topicName,
          topicArn,
          subscriptionCount: 0,
          isFifo: topicName.endsWith(".fifo"),
        },
        resolvedOutputs: { topicArn },
        secretStates: [],
        externalId: topicName,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    if (typeId === "dynamodb-table") {
      const keySchema: Array<{ AttributeName: string; KeyType: string }> = [
        { AttributeName: fields["partitionKey"] ?? "id", KeyType: "HASH" },
      ];
      const attrDefs: Array<{ AttributeName: string; AttributeType: string }> = [
        { AttributeName: fields["partitionKey"] ?? "id", AttributeType: fields["partitionKeyType"] ?? "S" },
      ];
      if (fields["sortKey"]) {
        keySchema.push({ AttributeName: fields["sortKey"], KeyType: "RANGE" });
        attrDefs.push({ AttributeName: fields["sortKey"], AttributeType: fields["sortKeyType"] ?? "S" });
      }
      const body: Record<string, unknown> = {
        TableName: fields["tableName"] ?? "",
        KeySchema: keySchema,
        AttributeDefinitions: attrDefs,
        BillingMode: fields["billingMode"] ?? "PAY_PER_REQUEST",
      };
      if (fields["billingMode"] === "PROVISIONED") {
        body["ProvisionedThroughput"] = {
          ReadCapacityUnits: 5,
          WriteCapacityUnits: 5,
        };
      }
      const data = await this.json<{ TableDescription: Record<string, unknown> }>(
        "dynamodb",
        "DynamoDB_20120810.CreateTable",
        body,
      );
      const t = data.TableDescription;
      const tableName = String(t["TableName"] ?? fields["tableName"] ?? "");
      return {
        id: this.makeId(accountId, "dynamodb-table", tableName),
        pluginId: "aws",
        resourceTypeId: "dynamodb-table",
        accountId,
        displayName: tableName,
        fields: {
          tableName,
          status: String(t["TableStatus"] ?? "CREATING"),
          itemCount: 0,
          sizeBytes: 0,
          billingMode: fields["billingMode"] ?? "PAY_PER_REQUEST",
          partitionKey: fields["partitionKey"] ?? "id",
          ...(fields["sortKey"] ? { sortKey: fields["sortKey"] } : {}),
        },
        resolvedOutputs: {
          tableArn: String(t["TableArn"] ?? ""),
        },
        secretStates: [],
        externalId: tableName,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    throw new Error(`AWS plugin: createResource not supported for type "${typeId}"`);
  }

  async getCreateCostEstimate(typeId: string, fields: Record<string, string>): Promise<number | null> {
    if (typeId === "ec2-instance") {
      // Approximate monthly on-demand pricing (us-east-1, Linux)
      const ec2Pricing: Record<string, number> = {
        "t3.nano": 3.80, "t3.micro": 7.59, "t3.small": 15.18, "t3.medium": 30.37,
        "t3.large": 60.74, "t3.xlarge": 121.47, "t3.2xlarge": 242.94,
        "m6i.large": 69.35, "m6i.xlarge": 138.70, "m6i.2xlarge": 277.40,
        "m6i.4xlarge": 554.80, "m6i.8xlarge": 1109.60,
        "c6i.large": 61.32, "c6i.xlarge": 122.64, "c6i.2xlarge": 245.28, "c6i.4xlarge": 490.56,
        "r6i.large": 91.98, "r6i.xlarge": 183.96, "r6i.2xlarge": 367.92, "r6i.4xlarge": 735.84,
      };
      const instanceType = fields["instanceType"] ?? "";
      const basePrice = ec2Pricing[instanceType];
      if (!basePrice) return null;
      // gp3 EBS: $0.08/GB/month
      const diskGb = Number(fields["diskSizeGb"] ?? "20");
      const diskCost = diskGb * 0.08;
      return basePrice + diskCost;
    }
    return null;
  }

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    const externalId = resource.externalId ?? "";

    switch (typeId) {
      case "ec2-instance":
        await this.ec2("TerminateInstances", { "InstanceId.1": externalId });
        break;
      case "ebs-volume":
        await this.ec2("DeleteVolume", { VolumeId: externalId });
        break;
      case "vpc":
        await this.ec2("DeleteVpc", { VpcId: externalId });
        break;
      case "subnet":
        await this.ec2("DeleteSubnet", { SubnetId: externalId });
        break;
      case "security-group":
        await this.ec2("DeleteSecurityGroup", { GroupId: externalId });
        break;
      case "nat-gateway":
        await this.ec2("DeleteNatGateway", { NatGatewayId: externalId });
        break;
      case "elastic-ip":
        await this.ec2("ReleaseAddress", { AllocationId: externalId });
        break;
      case "s3-bucket":
        await this.json("s3", "AmazonS3.DeleteBucket", { Bucket: externalId });
        break;
      case "lambda-function":
        await this.jsonGet("lambda", `/2015-03-31/functions/${encodeURIComponent(externalId)}`);
        // Lambda uses DELETE method — need a separate helper
        {
          const host = this.hostForService("lambda");
          const url = `https://${host}/2015-03-31/functions/${encodeURIComponent(externalId)}`;
          const headers = await signRequest({
            method: "DELETE",
            url,
            headers: { Host: host },
            service: "lambda",
            credentials: this.creds,
          });
          const res = await fetch(url, { method: "DELETE", headers });
          if (!res.ok) throw new Error(`Lambda delete ${externalId} failed: ${res.status}`);
        }
        break;
      case "sqs-queue": {
        const queueUrl = String(resource.fields["queueUrl"] ?? "");
        await this.json("sqs", "AmazonSQS.DeleteQueue", { QueueUrl: queueUrl });
        break;
      }
      case "sns-topic": {
        const topicArn = String(resource.fields["topicArn"] ?? "");
        await this.json("sns", "SNS.DeleteTopic", { TopicArn: topicArn });
        break;
      }
      case "dynamodb-table":
        await this.json("dynamodb", "DynamoDB_20120810.DeleteTable", { TableName: externalId });
        break;
      case "secrets-manager-secret":
        await this.json("secretsmanager", "secretsmanager.DeleteSecret", {
          SecretId: externalId,
          ForceDeleteWithoutRecovery: true,
        });
        break;
      case "ecr-repository":
        await this.json("ecr", "AmazonEC2ContainerRegistry_V20150921.DeleteRepository", {
          repositoryName: externalId,
          force: true,
        });
        break;
      case "cloudformation-stack":
        await this.json("cloudformation", "CloudFormation.DeleteStack", { StackName: externalId });
        break;
      case "ssm-parameter":
        await this.json("ssm", "AmazonSSM.DeleteParameter", { Name: externalId });
        break;
      case "cloudwatch-alarm":
        await this.json("monitoring", "GraniteServiceVersion20100801.DeleteAlarms", {
          AlarmNames: [externalId],
        });
        break;
      case "cloudwatch-log-group":
        await this.json("logs", "Logs_20140328.DeleteLogGroup", {
          logGroupName: externalId,
        });
        break;
      case "internet-gateway":
        await this.ec2("DeleteInternetGateway", { InternetGatewayId: externalId });
        break;
      case "cloudtrail-trail":
        await this.json("cloudtrail", "com.amazonaws.cloudtrail.v20131101.CloudTrail_20131101.DeleteTrail", {
          Name: externalId,
        });
        break;
      case "sagemaker-endpoint": {
        const host = this.hostForService("sagemaker");
        const url = `https://${host}`;
        const headers = await signRequest({
          method: "POST",
          url,
          headers: {
            Host: host,
            "Content-Type": "application/x-amz-json-1.1",
            "X-Amz-Target": "SageMaker.DeleteEndpoint",
          },
          body: JSON.stringify({ EndpointName: externalId }),
          service: "sagemaker",
          credentials: this.creds,
        });
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ EndpointName: externalId }),
        });
        if (!res.ok) throw new Error(`SageMaker delete endpoint ${externalId} failed: ${res.status}`);
        break;
      }
      default:
        throw new Error(`AWS plugin: deleteResource not supported for type "${typeId}"`);
    }
  }

  async getManifest(resourceId: string, accountId: string): Promise<string> {
    // Determine the type from the resourceId pattern (accountId:typeId:externalId)
    const parts = resourceId.split(":");
    const typeId = parts[1] ?? "";

    const resource = await this.getResource(typeId, resourceId, accountId);
    return JSON.stringify({
      resourceTypeId: resource.resourceTypeId,
      externalId: resource.externalId,
      displayName: resource.displayName,
      fields: resource.fields,
      resolvedOutputs: resource.resolvedOutputs,
    }, null, 2);
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[i]}`;
}
