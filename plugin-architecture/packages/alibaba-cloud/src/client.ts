import type {
  CostEstimate,
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  CreateSizePricingRequest,
  CreditBalance,
  CredentialExport,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  QuotaUsage,
  ResourceInstance,
  SidebarItemSchema,
  StorageObject,
} from "@infrawrench/plugin-base";
import { buildCostEstimate, externalIdOf } from "@infrawrench/plugin-base";
import { AliApi, isPermissionGap, mapLimit } from "./api.js";
import { fetchBalance, fetchCostData, fetchQuotas, monthToDate } from "./billing.js";
import { createResource, getCreateConfig, RDS_ENGINES } from "./create.js";
import { getResourceByExternalId } from "./get.js";
import { Inventory } from "./inventory.js";
import {
  functionHttpUrl,
  listAccount,
  listAlbs,
  listBuckets,
  listClusters,
  listDisks,
  listDomains,
  listEips,
  listFunctions,
  listInstances,
  listNodePools,
  listRamUsers,
  listRds,
  listRecords,
  listRedis,
  listSecurityGroups,
  listSlbs,
  listSnapshots,
  listVSwitches,
  listVpcs,
  splitRegional,
  xmlValue,
  type ListContext,
} from "./listers.js";
import { fetchSeries, metricTarget } from "./metrics.js";
import { DEFAULT_REGION } from "./regions.js";
import { renderDetail, renderSidebarItem } from "./render.js";
import { RESOURCE_TYPES } from "./resource-types.js";

const HOURS_PER_MONTH = 730;

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * Alibaba Cloud (international site) plugin client, one per AccessKey. See
 * `api.ts` and `signer.ts` for transport and signing, `inventory.ts` for how
 * regions are chosen, and `listers.ts` for each type.
 */
export class AlibabaCloudClient implements PluginClient {
  private readonly api: AliApi;
  private readonly inventory: Inventory;
  private readonly priceCache = new Map<string, Promise<number | null>>();

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const accessKeyId = (credentials["accessKeyId"] ?? "").trim();
    const accessKeySecret = (credentials["accessKeySecret"] ?? "").trim();
    if (!accessKeyId) throw new Error("Alibaba Cloud plugin: missing accessKeyId credential");
    if (!accessKeySecret)
      throw new Error("Alibaba Cloud plugin: missing accessKeySecret credential");
    const region = (credentials["region"] ?? "").trim() || DEFAULT_REGION;
    const regions = (credentials["regions"] ?? "")
      .split(/[,\s]+/)
      .map((r) => r.trim())
      .filter(Boolean);
    this.api = new AliApi(
      { accessKeyId, accessKeySecret },
      services?.http,
      credentials["caCert"] ?? "",
    );
    this.inventory = new Inventory(this.api, region, regions);
  }

  private ctx(accountId: string, regionHint?: string): ListContext {
    return {
      api: this.api,
      inventory: this.inventory,
      accountId,
      ...(regionHint ? { regionHint } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Listing

  async listResources(
    typeId: string,
    accountId: string,
    opts?: { regionHint?: string },
  ): Promise<ResourceInstance[]> {
    const ctx = this.ctx(accountId, opts?.regionHint);
    switch (typeId) {
      case "account":
        return listAccount(ctx);
      case "ecs-instance":
        return listInstances(ctx);
      case "disk":
        return listDisks(ctx);
      case "snapshot":
        return listSnapshots(ctx);
      case "vpc":
        return listVpcs(ctx);
      case "vswitch":
        return listVSwitches(ctx);
      case "security-group":
        return listSecurityGroups(ctx);
      case "eip":
        return listEips(ctx);
      case "slb":
        return listSlbs(ctx);
      case "alb":
        return listAlbs(ctx);
      case "rds-instance":
        return listRds(ctx);
      case "redis-instance":
        return listRedis(ctx);
      case "oss-bucket":
        return listBuckets(ctx);
      case "ack-cluster":
        return listClusters(ctx);
      case "ack-node-pool":
        return listNodePools(ctx);
      case "fc-function":
        return listFunctions(ctx);
      case "dns-domain":
        return listDomains(ctx);
      case "dns-record":
        return listRecords(ctx);
      case "ram-user":
        return listRamUsers(ctx);
      default:
        throw badRequest(`Alibaba Cloud plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    return getResourceByExternalId(this.ctx(accountId), typeId, externalIdOf(resourceId));
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const externalId = externalIdOf(resourceId);
    if (typeId === "ack-cluster" && outputKey === "kubeconfig") {
      return (await this.kubeconfig(externalId)).config;
    }
    if (typeId === "fc-function" && outputKey === "httpUrl") {
      const { region, id } = splitRegional(externalId);
      return functionHttpUrl(this.api, region, id);
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.resolvedOutputs[outputKey];
    if (value === undefined) {
      throw badRequest(
        `Alibaba Cloud plugin: cannot resolve output "${outputKey}" for "${typeId}"`,
      );
    }
    return value;
  }

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const fields = { ...resource.fields };
    const outputs = { ...resource.resolvedOutputs };
    const ext = resource.externalId ?? "";
    switch (resource.resourceTypeId) {
      case "account": {
        const [mtd, balance] = await Promise.allSettled([
          monthToDate(this.api),
          fetchBalance(this.api),
        ]);
        if (mtd.status === "fulfilled") fields["_mtd"] = JSON.stringify(mtd.value);
        if (balance.status === "fulfilled" && balance.value[0]) {
          fields["_balance"] = JSON.stringify(balance.value[0]);
        }
        break;
      }
      case "slb": {
        const { region, id } = splitRegional(ext);
        const attr = await this.api.rpc<{
          ListenerPortsAndProtocol?: {
            ListenerPortAndProtocol?: Array<{ ListenerPort: number; ListenerProtocol: string }>;
          };
          BackendServers?: {
            BackendServer?: Array<{ ServerId: string; Weight?: number; Type?: string }>;
          };
        }>("slb", region, "DescribeLoadBalancerAttribute", {
          LoadBalancerId: id,
          RegionId: region,
        });
        fields["_listeners"] = JSON.stringify(
          (attr.ListenerPortsAndProtocol?.ListenerPortAndProtocol ?? []).map((l) => ({
            port: l.ListenerPort,
            protocol: l.ListenerProtocol,
          })),
        );
        fields["_backends"] = JSON.stringify(
          (attr.BackendServers?.BackendServer ?? []).map((b) => ({
            id: b.ServerId,
            weight: b.Weight ?? 0,
            type: b.Type ?? "ecs",
          })),
        );
        break;
      }
      case "oss-bucket": {
        const { region, id } = splitRegional(ext);
        const res = await this.api.oss({ method: "GET", region, bucket: id, query: { stat: "" } });
        fields["_stat"] = JSON.stringify({
          objects: Number(xmlValue(res.body, "ObjectCount")) || 0,
          bytes: Number(xmlValue(res.body, "Storage")) || 0,
        });
        break;
      }
      case "fc-function": {
        const { region, id } = splitRegional(ext);
        const url = await functionHttpUrl(this.api, region, id).catch(() => "");
        if (url) outputs["httpUrl"] = url;
        break;
      }
      default:
        return resource;
    }
    return { ...resource, fields, resolvedOutputs: outputs };
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderDetail(resource, RESOURCE_TYPES);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderSidebarItem(resource);
  }

  // -------------------------------------------------------------------------
  // Create / update / delete / actions

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    return getCreateConfig(this.ctx(""), typeId, parentResourceId);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    return createResource(this.ctx(accountId), typeId, fields, parentResourceId);
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const ext = externalIdOf(resourceId);
    const has = (k: string) => fields[k] !== undefined;
    const rpc = this.api.rpc.bind(this.api);
    switch (typeId) {
      case "ecs-instance": {
        const { region, id } = splitRegional(ext);
        if (has("name") || has("description")) {
          await rpc("ecs", region, "ModifyInstanceAttribute", {
            InstanceId: id,
            InstanceName: fields["name"] || undefined,
            Description: has("description") ? fields["description"] : undefined,
          });
        }
        if (fields["instanceType"]) {
          const current = await this.getResource(typeId, resourceId, accountId);
          if (current.fields["chargeType"] === "PrePaid") {
            await rpc("ecs", region, "ModifyPrepayInstanceSpec", {
              RegionId: region,
              InstanceId: id,
              InstanceType: fields["instanceType"],
              AutoPay: true,
            });
          } else {
            await rpc("ecs", region, "ModifyInstanceSpec", {
              InstanceId: id,
              InstanceType: fields["instanceType"],
            });
          }
        }
        break;
      }
      case "disk": {
        const { region, id } = splitRegional(ext);
        if (has("name") || has("description") || has("deleteWithInstance")) {
          await rpc("ecs", region, "ModifyDiskAttribute", {
            DiskId: id,
            DiskName: fields["name"] || undefined,
            Description: has("description") ? fields["description"] : undefined,
            DeleteWithInstance: has("deleteWithInstance")
              ? fields["deleteWithInstance"] === "true"
              : undefined,
          });
        }
        if (fields["sizeGb"]) {
          const current = await this.getResource(typeId, resourceId, accountId);
          await rpc("ecs", region, "ResizeDisk", {
            DiskId: id,
            NewSize: fields["sizeGb"],
            Type: current.fields["status"] === "In_use" ? "online" : "offline",
          });
        }
        break;
      }
      case "snapshot": {
        const { region, id } = splitRegional(ext);
        await rpc("ecs", region, "ModifySnapshotAttribute", {
          SnapshotId: id,
          SnapshotName: fields["name"] || undefined,
          Description: has("description") ? fields["description"] : undefined,
          RetentionDays: fields["retentionDays"] || undefined,
        });
        break;
      }
      case "vpc": {
        const { region, id } = splitRegional(ext);
        await rpc("vpc", region, "ModifyVpcAttribute", {
          RegionId: region,
          VpcId: id,
          VpcName: fields["name"] || undefined,
          Description: has("description") ? fields["description"] : undefined,
        });
        break;
      }
      case "vswitch": {
        const { region, id } = splitRegional(ext);
        await rpc("vpc", region, "ModifyVSwitchAttribute", {
          RegionId: region,
          VSwitchId: id,
          VSwitchName: fields["name"] || undefined,
          Description: has("description") ? fields["description"] : undefined,
        });
        break;
      }
      case "security-group": {
        const { region, id } = splitRegional(ext);
        await rpc("ecs", region, "ModifySecurityGroupAttribute", {
          RegionId: region,
          SecurityGroupId: id,
          SecurityGroupName: fields["name"] || undefined,
          Description: has("description") ? fields["description"] : undefined,
        });
        break;
      }
      case "eip": {
        const { region, id } = splitRegional(ext);
        await rpc("vpc", region, "ModifyEipAddressAttribute", {
          RegionId: region,
          AllocationId: id,
          Name: fields["name"] || undefined,
          Bandwidth: fields["bandwidthMbps"] || undefined,
        });
        break;
      }
      case "slb": {
        const { region, id } = splitRegional(ext);
        if (fields["name"]) {
          await rpc("slb", region, "SetLoadBalancerName", {
            RegionId: region,
            LoadBalancerId: id,
            LoadBalancerName: fields["name"],
          });
        }
        break;
      }
      case "alb": {
        const { region, id } = splitRegional(ext);
        if (fields["name"]) {
          await rpc("alb", region, "UpdateLoadBalancerAttribute", {
            LoadBalancerId: id,
            LoadBalancerName: fields["name"],
          });
        }
        break;
      }
      case "rds-instance": {
        const { region, id } = splitRegional(ext);
        if (fields["name"]) {
          await rpc("rds", region, "ModifyDBInstanceDescription", {
            DBInstanceId: id,
            DBInstanceDescription: fields["name"],
          });
        }
        if (fields["instanceClass"] || fields["storageGb"]) {
          await rpc("rds", region, "ModifyDBInstanceSpec", {
            DBInstanceId: id,
            DBInstanceClass: fields["instanceClass"] || undefined,
            DBInstanceStorage: fields["storageGb"] || undefined,
          });
        }
        break;
      }
      case "redis-instance": {
        const { region, id } = splitRegional(ext);
        if (fields["name"]) {
          await rpc("redis", region, "ModifyInstanceAttribute", {
            InstanceId: id,
            InstanceName: fields["name"],
          });
        }
        if (fields["instanceClass"]) {
          await rpc("redis", region, "ModifyInstanceSpec", {
            RegionId: region,
            InstanceId: id,
            InstanceClass: fields["instanceClass"],
            AutoPay: true,
          });
        }
        break;
      }
      case "oss-bucket": {
        const { region, id } = splitRegional(ext);
        if (fields["acl"]) {
          await this.api.oss({
            method: "PUT",
            region,
            bucket: id,
            query: { acl: "" },
            headers: { "x-oss-acl": fields["acl"] },
          });
        }
        if (fields["versioning"] && fields["versioning"] !== "Disabled") {
          await this.api.oss({
            method: "PUT",
            region,
            bucket: id,
            query: { versioning: "" },
            headers: { "content-type": "application/xml" },
            body: `<?xml version="1.0" encoding="UTF-8"?><VersioningConfiguration><Status>${fields["versioning"]}</Status></VersioningConfiguration>`,
          });
        }
        break;
      }
      case "ack-cluster": {
        const { region, id } = splitRegional(ext);
        if (fields["name"]) {
          await this.api.roa({
            product: "cs",
            region,
            action: "ModifyCluster",
            method: "PUT",
            path: `/api/v2/clusters/${id}`,
            body: { cluster_name: fields["name"] },
          });
        }
        if (fields["kubernetesVersion"]) {
          await this.api.roa({
            product: "cs",
            region,
            action: "UpgradeCluster",
            method: "POST",
            path: `/api/v2/clusters/${id}/upgrade`,
            body: { next_version: fields["kubernetesVersion"], master_only: true },
          });
        }
        break;
      }
      case "ack-node-pool": {
        const [region, clusterId, poolId] = ext.split("/");
        const body: Record<string, unknown> = {};
        if (fields["name"]) body["nodepool_info"] = { name: fields["name"] };
        if (fields["desiredSize"])
          body["scaling_group"] = { desired_size: Number(fields["desiredSize"]) };
        if (Object.keys(body).length) {
          await this.api.roa({
            product: "cs",
            region: region!,
            action: "ModifyClusterNodePool",
            method: "PUT",
            path: `/clusters/${clusterId}/nodepools/${poolId}`,
            body,
          });
        }
        break;
      }
      case "fc-function": {
        const { region, id } = splitRegional(ext);
        const body: Record<string, unknown> = {};
        if (fields["memoryMb"]) body["memorySize"] = Number(fields["memoryMb"]);
        if (fields["cpu"]) body["cpu"] = Number(fields["cpu"]);
        if (fields["timeoutSeconds"]) body["timeout"] = Number(fields["timeoutSeconds"]);
        if (has("description")) body["description"] = fields["description"];
        await this.api.roa({
          product: "fc",
          region,
          action: "UpdateFunction",
          method: "PUT",
          path: `/2023-03-30/functions/${id}`,
          body,
        });
        break;
      }
      case "dns-record": {
        const current = await this.getResource(typeId, resourceId, accountId);
        const merged = { ...current.fields, ...fields } as Record<string, unknown>;
        const recordId = ext.slice(ext.lastIndexOf("/") + 1);
        await rpc("alidns", "", "UpdateDomainRecord", {
          RecordId: recordId,
          RR: String(merged["name"] ?? "@"),
          Type: String(merged["type"] ?? ""),
          Value: String(merged["content"] ?? ""),
          TTL:
            merged["ttl"] !== undefined && merged["ttl"] !== "" ? String(merged["ttl"]) : undefined,
          Priority:
            merged["type"] === "MX" && merged["priority"] !== undefined
              ? String(merged["priority"])
              : undefined,
          Lang: "en",
        });
        break;
      }
      case "ram-user":
        await rpc("ram", "", "UpdateUser", {
          UserName: ext,
          NewDisplayName: fields["displayName"] || undefined,
          NewEmail: has("email") ? fields["email"] : undefined,
          NewComments: has("comments") ? fields["comments"] : undefined,
        });
        break;
      default:
        throw badRequest(`Alibaba Cloud plugin: "${typeId}" cannot be edited`);
    }
    return this.getResource(typeId, resourceId, accountId);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const ext = externalIdOf(resourceId);
    const rpc = this.api.rpc.bind(this.api);
    const regional = () => splitRegional(ext);
    switch (typeId) {
      case "ecs-instance": {
        const { region, id } = regional();
        await rpc("ecs", region, "DeleteInstance", { InstanceId: id, Force: true });
        return;
      }
      case "disk": {
        const { region, id } = regional();
        await rpc("ecs", region, "DeleteDisk", { DiskId: id });
        return;
      }
      case "snapshot": {
        const { region, id } = regional();
        await rpc("ecs", region, "DeleteSnapshot", { SnapshotId: id });
        return;
      }
      case "vpc": {
        const { region, id } = regional();
        await rpc("vpc", region, "DeleteVpc", { RegionId: region, VpcId: id });
        return;
      }
      case "vswitch": {
        const { region, id } = regional();
        await rpc("vpc", region, "DeleteVSwitch", { RegionId: region, VSwitchId: id });
        return;
      }
      case "security-group": {
        const { region, id } = regional();
        await rpc("ecs", region, "DeleteSecurityGroup", { RegionId: region, SecurityGroupId: id });
        return;
      }
      case "eip": {
        const { region, id } = regional();
        await rpc("vpc", region, "ReleaseEipAddress", { RegionId: region, AllocationId: id });
        return;
      }
      case "slb": {
        const { region, id } = regional();
        await rpc("slb", region, "DeleteLoadBalancer", { RegionId: region, LoadBalancerId: id });
        return;
      }
      case "alb": {
        const { region, id } = regional();
        await rpc("alb", region, "DeleteLoadBalancer", { LoadBalancerId: id });
        return;
      }
      case "rds-instance": {
        const { region, id } = regional();
        await rpc("rds", region, "DeleteDBInstance", { DBInstanceId: id });
        return;
      }
      case "redis-instance": {
        const { region, id } = regional();
        await rpc("redis", region, "DeleteInstance", { InstanceId: id });
        return;
      }
      case "oss-bucket": {
        const { region, id } = regional();
        await this.api.oss({ method: "DELETE", region, bucket: id });
        return;
      }
      case "ack-cluster": {
        const { region, id } = regional();
        await this.api.roa({
          product: "cs",
          region,
          action: "DeleteCluster",
          method: "DELETE",
          path: `/clusters/${id}`,
        });
        return;
      }
      case "ack-node-pool": {
        const [region, clusterId, poolId] = ext.split("/");
        await this.api.roa({
          product: "cs",
          region: region!,
          action: "DeleteClusterNodepool",
          method: "DELETE",
          path: `/clusters/${clusterId}/nodepools/${poolId}`,
        });
        return;
      }
      case "fc-function": {
        const { region, id } = regional();
        await this.api.roa({
          product: "fc",
          region,
          action: "DeleteFunction",
          method: "DELETE",
          path: `/2023-03-30/functions/${id}`,
        });
        return;
      }
      case "dns-domain":
        await rpc("alidns", "", "DeleteDomain", { DomainName: ext, Lang: "en" });
        return;
      case "dns-record":
        await rpc("alidns", "", "DeleteDomainRecord", {
          RecordId: ext.slice(ext.lastIndexOf("/") + 1),
          Lang: "en",
        });
        return;
      case "ram-user":
        await rpc("ram", "", "DeleteUser", { UserName: ext });
        return;
      default:
        throw badRequest(`Alibaba Cloud plugin: "${typeId}" cannot be deleted`);
    }
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    const ext = externalIdOf(resourceId);
    const rpc = this.api.rpc.bind(this.api);
    const key = `${typeId}:${actionId}`;
    if (typeId === "dns-record" && (actionId === "enable" || actionId === "disable")) {
      await rpc("alidns", "", "SetDomainRecordStatus", {
        RecordId: ext.slice(ext.lastIndexOf("/") + 1),
        Status: actionId === "enable" ? "Enable" : "Disable",
        Lang: "en",
      });
      return;
    }
    const { region, id } = splitRegional(ext);
    switch (key) {
      case "ecs-instance:start":
        await rpc("ecs", region, "StartInstance", { InstanceId: id });
        return;
      case "ecs-instance:stop":
      case "ecs-instance:stop-force": {
        const current = await this.getResource(typeId, resourceId, accountId);
        await rpc("ecs", region, "StopInstance", {
          InstanceId: id,
          ForceStop: actionId === "stop-force",
          // Economical mode releases vCPUs and memory for pay-as-you-go instances.
          StoppedMode: current.fields["chargeType"] === "PostPaid" ? "StopCharging" : undefined,
        });
        return;
      }
      case "ecs-instance:reboot":
        await rpc("ecs", region, "RebootInstance", { InstanceId: id });
        return;
      case "disk:snapshot":
        await rpc("ecs", region, "CreateSnapshot", {
          DiskId: id,
          SnapshotName: `${id}-${new Date().toISOString().slice(0, 10)}`,
        });
        return;
      case "disk:detach": {
        const current = await this.getResource(typeId, resourceId, accountId);
        await rpc("ecs", region, "DetachDisk", {
          DiskId: id,
          InstanceId: String(current.fields["instanceId"] ?? ""),
        });
        return;
      }
      case "eip:unassociate": {
        const current = await this.getResource(typeId, resourceId, accountId);
        await rpc("vpc", region, "UnassociateEipAddress", {
          RegionId: region,
          AllocationId: id,
          InstanceId: String(current.fields["instanceId"] ?? ""),
          InstanceType: String(current.fields["instanceType"] ?? "") || undefined,
        });
        return;
      }
      case "slb:activate":
      case "slb:deactivate":
        await rpc("slb", region, "SetLoadBalancerStatus", {
          RegionId: region,
          LoadBalancerId: id,
          LoadBalancerStatus: actionId === "activate" ? "active" : "inactive",
        });
        return;
      case "rds-instance:restart":
        await rpc("rds", region, "RestartDBInstance", { DBInstanceId: id });
        return;
      case "redis-instance:restart":
        await rpc("redis", region, "RestartInstance", { InstanceId: id });
        return;
      case "fc-function:enable-invocation":
      case "fc-function:disable-invocation":
        await this.api.roa({
          product: "fc",
          region,
          action:
            actionId === "enable-invocation"
              ? "EnableFunctionInvocation"
              : "DisableFunctionInvocation",
          method: "POST",
          path: `/2023-03-30/functions/${id}/invoke/${actionId === "enable-invocation" ? "enable" : "disable"}`,
          ...(actionId === "disable-invocation" ? { body: {} } : {}),
        });
        return;
      default:
        throw badRequest(
          `Alibaba Cloud plugin: action "${actionId}" is not supported for "${typeId}"`,
        );
    }
  }

  async attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    _accountId: string,
  ): Promise<void> {
    const source = splitRegional(externalIdOf(sourceResourceId));
    const target = splitRegional(externalIdOf(targetResourceId));
    if (targetTypeId !== "ecs-instance") {
      throw badRequest(`Alibaba Cloud plugin: cannot attach ${sourceTypeId} to ${targetTypeId}`);
    }
    if (sourceTypeId === "disk") {
      await this.api.rpc("ecs", source.region, "AttachDisk", {
        DiskId: source.id,
        InstanceId: target.id,
      });
      return;
    }
    if (sourceTypeId === "eip") {
      await this.api.rpc("vpc", source.region, "AssociateEipAddress", {
        RegionId: source.region,
        AllocationId: source.id,
        InstanceId: target.id,
        InstanceType: "EcsInstance",
      });
      return;
    }
    throw badRequest(`Alibaba Cloud plugin: cannot attach ${sourceTypeId} to ${targetTypeId}`);
  }

  private async kubeconfig(externalId: string): Promise<{ config: string; expiration?: string }> {
    const { region, id } = splitRegional(externalId);
    return this.api.roa<{ config: string; expiration?: string }>({
      product: "cs",
      region,
      action: "DescribeClusterUserKubeconfig",
      method: "GET",
      path: `/k8s/${id}/user_config`,
    });
  }

  async exportCredential(
    typeId: string,
    resourceId: string,
    _accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    if (typeId !== "ack-cluster" || formatId !== "kubeconfig") {
      throw badRequest(`Alibaba Cloud plugin: no "${formatId}" credential for "${typeId}"`);
    }
    const ext = externalIdOf(resourceId);
    const res = await this.kubeconfig(ext);
    return {
      content: res.config,
      filename: `kubeconfig-${splitRegional(ext).id}.yaml`,
      mimeType: "application/yaml",
      ...(res.expiration
        ? { warning: `The client certificate in this kubeconfig expires ${res.expiration}.` }
        : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Metrics, cost, credits, quotas, estimates

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const { region, id } = splitRegional(externalIdOf(resourceId));
    const target = metricTarget(resourceTypeId, region, id);
    if (!target) return [];
    try {
      return await fetchSeries(this.api, target, timeRange);
    } catch (err) {
      if (isPermissionGap(err)) return [];
      throw err;
    }
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchCostData(this.api, range);
  }

  async fetchCreditBalance(_accountId: string): Promise<CreditBalance[]> {
    return fetchBalance(this.api);
  }

  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
    return fetchQuotas(this.api, this.inventory.homeRegion);
  }

  /** Hourly list price of an ECS configuration from `DescribePrice`, cached per configuration. */
  private ecsHourly(params: Record<string, unknown>, region: string): Promise<number | null> {
    const key = JSON.stringify({ region, ...params });
    let cached = this.priceCache.get(key);
    if (!cached) {
      cached = this.api
        .rpc<{ PriceInfo?: { Price?: { TradePrice?: number } } }>("ecs", region, "DescribePrice", {
          RegionId: region,
          PriceUnit: "Hour",
          ...params,
        })
        .then((r) => {
          const p = r.PriceInfo?.Price?.TradePrice;
          return typeof p === "number" && Number.isFinite(p) ? p : null;
        })
        .catch(() => null);
      this.priceCache.set(key, cached);
    }
    return cached;
  }

  async getCreateSizePricing(
    typeId: string,
    request: CreateSizePricingRequest,
  ): Promise<Record<string, number>> {
    if (typeId !== "ecs-instance" || !request.regionId) return {};
    const region = request.regionId;
    const prices = await mapLimit(request.sizes, 6, async (s) => ({
      id: s.id,
      hourly: await this.ecsHourly({ ResourceType: "instance", InstanceType: s.id }, region),
    }));
    const out: Record<string, number> = {};
    for (const p of prices) {
      if (p.hourly !== null) out[p.id] = Math.round(p.hourly * HOURS_PER_MONTH * 100) / 100;
    }
    return out;
  }

  async estimateCost(typeId: string, fields: Record<string, string>): Promise<CostEstimate | null> {
    const region = fields["region"];
    if (!region) return null;
    if (typeId === "ecs-instance") {
      const type = fields["instanceType"];
      if (!type) return null;
      const diskGb = Number(fields["systemDiskGb"] || 40);
      const category = fields["diskCategory"] || "cloud_essd";
      const [instance, withDisk] = await Promise.all([
        this.ecsHourly({ ResourceType: "instance", InstanceType: type }, region),
        this.ecsHourly(
          {
            ResourceType: "instance",
            InstanceType: type,
            "SystemDisk.Category": category,
            "SystemDisk.Size": diskGb,
          },
          region,
        ),
      ]);
      if (instance === null) return null;
      const disk = withDisk !== null ? Math.max(0, withDisk - instance) : null;
      return buildCostEstimate(
        [
          { label: `${type} (pay-as-you-go)`, monthlyAmount: instance * HOURS_PER_MONTH },
          disk !== null
            ? {
                label: `System disk ${diskGb} GB ${category}`,
                monthlyAmount: disk * HOURS_PER_MONTH,
              }
            : null,
        ],
        {
          partial: disk === null,
          notes: ["Public traffic is billed by usage and not included."],
        },
      );
    }
    if (typeId === "disk") {
      const size = Number(fields["sizeGb"] || 0);
      if (!size) return null;
      const hourly = await this.ecsHourly(
        {
          ResourceType: "disk",
          "DataDisk.1.Category": fields["category"] || "cloud_essd",
          "DataDisk.1.Size": size,
        },
        region,
      );
      if (hourly === null) return null;
      return buildCostEstimate([
        {
          label: `${size} GB ${fields["category"] || "cloud_essd"}`,
          monthlyAmount: hourly * HOURS_PER_MONTH,
        },
      ]);
    }
    if (typeId === "rds-instance") {
      const engine = RDS_ENGINES.find((e) => e.id === fields["engine"]);
      const cls = fields["instanceClass"];
      const storage = Number(fields["storageGb"] || 0);
      if (!engine || !cls || !storage) return null;
      const res = await this.api
        .rpc<{ PriceInfo?: { TradePrice?: number; Currency?: string } }>(
          "rds",
          region,
          "DescribePrice",
          {
            RegionId: region,
            CommodityCode: "bards_intl",
            Engine: engine.engine,
            EngineVersion: engine.version,
            DBInstanceClass: cls,
            DBInstanceStorage: storage,
            PayType: "Postpaid",
            TimeType: "Hour",
            UsedTime: 1,
            Quantity: 1,
            OrderType: "BUY",
          },
        )
        .catch(() => null);
      const hourly = res?.PriceInfo?.TradePrice;
      if (typeof hourly !== "number") return null;
      return buildCostEstimate(
        [{ label: `${cls} with ${storage} GB`, monthlyAmount: hourly * HOURS_PER_MONTH }],
        { currency: res?.PriceInfo?.Currency || "USD" },
      );
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // OSS browser. `bucket` is the bucket's external id (`region/name`).

  async listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    const { region, id } = splitRegional(bucket);
    const out: StorageObject[] = [];
    let token = "";
    for (let page = 0; page < 20; page++) {
      const res = await this.api.oss({
        method: "GET",
        region,
        bucket: id,
        query: {
          "list-type": "2",
          delimiter: "/",
          "max-keys": "1000",
          prefix,
          ...(token ? { "continuation-token": token } : {}),
        },
      });
      for (const p of [...res.body.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]*)<\/Prefix>/g)]) {
        const key = decodeXml(p[1]!);
        out.push({
          key,
          name: key.slice(prefix.length).replace(/\/$/, ""),
          size: 0,
          lastModified: "",
          isDirectory: true,
        });
      }
      for (const c of [...res.body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)]) {
        const key = decodeXml(xmlValue(c[1]!, "Key"));
        if (key === prefix) continue;
        out.push({
          key,
          name: key.slice(prefix.length),
          size: Number(xmlValue(c[1]!, "Size")) || 0,
          lastModified: xmlValue(c[1]!, "LastModified"),
          isDirectory: false,
        });
      }
      token = xmlValue(res.body, "NextContinuationToken");
      if (xmlValue(res.body, "IsTruncated") !== "true" || !token) break;
    }
    return out;
  }

  async uploadStorageObject(bucket: string, key: string, file: File): Promise<void> {
    const { region, id } = splitRegional(bucket);
    await this.api.oss({
      method: "PUT",
      region,
      bucket: id,
      key,
      headers: { "content-type": file.type || "application/octet-stream" },
      body: new Uint8Array(await file.arrayBuffer()),
    });
  }

  async makeStorageFolder(bucket: string, key: string): Promise<void> {
    const { region, id } = splitRegional(bucket);
    await this.api.oss({
      method: "PUT",
      region,
      bucket: id,
      key: key.endsWith("/") ? key : `${key}/`,
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(0),
    });
  }

  async deleteStorageObject(bucket: string, key: string): Promise<void> {
    const { region, id } = splitRegional(bucket);
    const keys = key.endsWith("/") ? [...(await this.allKeysUnder(bucket, key)), key] : [key];
    for (const k of [...new Set(keys)]) {
      await this.api.oss({ method: "DELETE", region, bucket: id, key: k });
    }
  }

  private async allKeysUnder(bucket: string, prefix: string): Promise<string[]> {
    const { region, id } = splitRegional(bucket);
    const keys: string[] = [];
    let token = "";
    for (let page = 0; page < 100; page++) {
      const res = await this.api.oss({
        method: "GET",
        region,
        bucket: id,
        query: {
          "list-type": "2",
          "max-keys": "1000",
          prefix,
          ...(token ? { "continuation-token": token } : {}),
        },
      });
      for (const c of [...res.body.matchAll(/<Key>([^<]*)<\/Key>/g)]) keys.push(decodeXml(c[1]!));
      token = xmlValue(res.body, "NextContinuationToken");
      if (xmlValue(res.body, "IsTruncated") !== "true" || !token) break;
    }
    return keys;
  }
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
