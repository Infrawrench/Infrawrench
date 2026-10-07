import type {
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  CreditBalance,
  DetailViewSchema,
  HostServices,
  PluginClient,
  ResourceInstance,
  SidebarItemSchema,
  StorageObject,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import { IbmApi, isPermissionGap } from "./api.js";
import { fetchCostData, fetchCredits, monthToDate } from "./billing.js";
import { createResource, getCreateConfig } from "./create.js";
import {
  Inventory,
  databaseResource,
  getCluster,
  getInstance,
  listAccount,
  listApps,
  listBuckets,
  listClusters,
  listDatabases,
  listFloatingIps,
  listInstances,
  listKeys,
  listLoadBalancers,
  listProjects,
  listResourceGroups,
  listSecurityGroups,
  listServiceInstances,
  listSubnets,
  listVolumes,
  listVpcs,
  listWorkerPools,
  mapApp,
  mapServiceInstance,
  notFound,
  poolsOf,
  splitRegional,
  vpcGet,
  xmlValue,
  type CeApp,
  type ListContext,
  type ResourceInstanceRc,
} from "./listers.js";
import {
  CONTAINERS,
  DEFAULT_REGION,
  RESOURCE_CONTROLLER,
  VPC_API_VERSION,
  codeEngineBase,
  cosEndpoint,
  databasesBase,
  vpcBase,
} from "./regions.js";
import { renderDetail, renderSidebarItem } from "./render.js";
import { RESOURCE_TYPES } from "./resource-types.js";

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

/** VPC collection path per resource type. */
const VPC_COLLECTIONS: Record<string, string> = {
  instance: "instances",
  volume: "volumes",
  vpc: "vpcs",
  subnet: "subnets",
  "security-group": "security_groups",
  "floating-ip": "floating_ips",
  "load-balancer": "load_balancers",
  "ssh-key": "keys",
};

const VPC_LISTERS: Record<string, (ctx: ListContext) => Promise<ResourceInstance[]>> = {
  volume: listVolumes,
  vpc: listVpcs,
  subnet: listSubnets,
  "security-group": listSecurityGroups,
  "floating-ip": listFloatingIps,
  "load-balancer": listLoadBalancers,
  "ssh-key": listKeys,
};

/** Database connection blocks are keyed by protocol; take whichever one is present. */
function firstHost(
  connection: Record<string, unknown> | undefined,
): { hostname?: string; port?: number } | undefined {
  if (!connection) return undefined;
  for (const value of Object.values(connection)) {
    const hosts = (value as { hosts?: Array<{ hostname?: string; port?: number }> } | null)?.hosts;
    if (hosts?.[0]) return hosts[0];
  }
  return undefined;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * IBM Cloud plugin client, one per API key. See `api.ts` for the IAM token
 * exchange and transport and `listers.ts` for each type.
 */
export class IbmCloudClient implements PluginClient {
  private readonly api: IbmApi;
  private readonly inventory: Inventory;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) throw new Error("IBM Cloud plugin: missing apiKey credential");
    const region = (credentials["region"] ?? "").trim() || DEFAULT_REGION;
    const regions = (credentials["regions"] ?? "")
      .split(/[,\s]+/)
      .map((r) => r.trim())
      .filter(Boolean);
    this.api = new IbmApi(apiKey, services?.http, credentials["caCert"] ?? "");
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

  async listResources(
    typeId: string,
    accountId: string,
    opts?: { regionHint?: string },
  ): Promise<ResourceInstance[]> {
    const ctx = this.ctx(accountId, opts?.regionHint);
    switch (typeId) {
      case "account":
        return listAccount(ctx);
      case "resource-group":
        return listResourceGroups(ctx);
      case "instance":
        return listInstances(ctx);
      case "kubernetes-cluster":
        return listClusters(ctx);
      case "worker-pool":
        return listWorkerPools(ctx);
      case "code-engine-project":
        return listProjects(ctx);
      case "code-engine-app":
        return listApps(ctx);
      case "cos-bucket":
        return listBuckets(ctx);
      case "database":
        return listDatabases(ctx);
      case "service-instance":
        return listServiceInstances(ctx);
      default: {
        const lister = VPC_LISTERS[typeId];
        if (!lister) throw badRequest(`IBM Cloud plugin: unknown resource type "${typeId}"`);
        return lister(ctx);
      }
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    return this.getByExternalId(typeId, externalIdOf(resourceId), accountId);
  }

  private async getByExternalId(
    typeId: string,
    ext: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const ctx = this.ctx(accountId);
    const find = (list: ResourceInstance[]) => {
      const found = list.find((r) => r.externalId === ext);
      if (!found) throw notFound(typeId, ext);
      return found;
    };
    switch (typeId) {
      case "instance": {
        const { region, id } = splitRegional(ext);
        return getInstance(ctx, region, id);
      }
      case "kubernetes-cluster":
        return getCluster(ctx, ext);
      case "worker-pool":
        return find(await poolsOf(ctx, ext.split("/")[0]!));
      case "code-engine-app": {
        const [region, projectId, name] = ext.split("/") as [string, string, string];
        const app = await this.api.get<CeApp>(
          `${codeEngineBase(region)}/projects/${projectId}/apps/${name}`,
        );
        return mapApp(accountId, region, projectId, app);
      }
      case "code-engine-project":
        return find(await listProjects({ ...ctx, regionHint: splitRegional(ext).region }));
      case "database":
      case "service-instance": {
        const r = await this.api.get<ResourceInstanceRc>(
          `${RESOURCE_CONTROLLER}/v2/resource_instances/${encodeURIComponent(ext)}`,
        );
        return typeId === "database" ? databaseResource(ctx, r) : mapServiceInstance(accountId, r);
      }
      case "account":
        return find(await listAccount(ctx));
      case "resource-group":
        return find(await listResourceGroups(ctx));
      case "cos-bucket":
        return find(await listBuckets(ctx));
      default: {
        const lister = VPC_LISTERS[typeId];
        if (!lister) throw badRequest(`IBM Cloud plugin: unknown resource type "${typeId}"`);
        return find(await lister({ ...ctx, regionHint: splitRegional(ext).region }));
      }
    }
  }

  private async databaseHost(
    crn: string,
  ): Promise<{ hostname?: string; port?: number } | undefined> {
    const r = await this.api.get<ResourceInstanceRc>(
      `${RESOURCE_CONTROLLER}/v2/resource_instances/${encodeURIComponent(crn)}`,
    );
    const base = `${databasesBase(r.region_id ?? DEFAULT_REGION)}/deployments/${encodeURIComponent(crn)}`;
    const info = await this.api.get<{ deployment?: { admin_usernames?: Record<string, string> } }>(
      base,
    );
    const user = info.deployment?.admin_usernames?.["database"] ?? "admin";
    for (const endpoint of ["public", "private"]) {
      const conn = await this.api
        .get<{ connection?: Record<string, unknown> }>(
          `${base}/users/database/${encodeURIComponent(user)}/connections/${endpoint}`,
        )
        .catch(() => undefined);
      const host = firstHost(conn?.connection);
      if (host?.hostname) return host;
    }
    return undefined;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const ext = externalIdOf(resourceId);
    if (typeId === "database" && (outputKey === "host" || outputKey === "port")) {
      const host = await this.databaseHost(ext);
      const value =
        outputKey === "host"
          ? host?.hostname
          : host?.port !== undefined
            ? String(host.port)
            : undefined;
      if (!value)
        throw Object.assign(new Error("The database has no connection endpoint yet"), {
          status: 404,
        });
      return value;
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.resolvedOutputs[outputKey];
    if (value === undefined)
      throw badRequest(`IBM Cloud plugin: cannot resolve output "${outputKey}" for "${typeId}"`);
    return value;
  }

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    if (resource.resourceTypeId === "account") {
      const mtd = await monthToDate(this.api).catch(() => undefined);
      return mtd
        ? { ...resource, fields: { ...resource.fields, _mtd: JSON.stringify(mtd) } }
        : resource;
    }
    if (resource.resourceTypeId === "database" && resource.externalId) {
      const host = await this.databaseHost(resource.externalId).catch(() => undefined);
      if (!host?.hostname) return resource;
      return {
        ...resource,
        resolvedOutputs: {
          ...resource.resolvedOutputs,
          host: host.hostname,
          ...(host.port !== undefined ? { port: String(host.port) } : {}),
        },
      };
    }
    return resource;
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
    return createResource(this.ctx(accountId), typeId, fields, parentResourceId, (t, ext) =>
      this.getByExternalId(t, ext, accountId),
    );
  }

  private vpcUrl(region: string, path: string): string {
    return `${vpcBase(region)}${path}?version=${VPC_API_VERSION}&generation=2`;
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const ext = externalIdOf(resourceId);
    const collection = VPC_COLLECTIONS[typeId];
    if (collection) {
      const { region, id } = splitRegional(ext);
      const body: Record<string, unknown> = {};
      if (fields["name"]) body["name"] = fields["name"];
      if (typeId === "instance" && fields["profile"]) body["profile"] = { name: fields["profile"] };
      if (typeId === "volume" && fields["capacityGb"])
        body["capacity"] = Number(fields["capacityGb"]);
      if (Object.keys(body).length) {
        await this.api.request({
          url: this.vpcUrl(region, `/${collection}/${id}`),
          method: "PATCH",
          body,
          mergePatch: true,
        });
      }
      return this.getResource(typeId, resourceId, accountId);
    }
    switch (typeId) {
      case "resource-group":
        await this.api.request({
          url: `${RESOURCE_CONTROLLER}/v2/resource_groups/${ext}`,
          method: "PATCH",
          body: { name: fields["name"] },
        });
        break;
      case "kubernetes-cluster":
        if (fields["version"]) {
          await this.api.request({
            url: `${CONTAINERS}/v2/updateMaster`,
            method: "POST",
            body: { cluster: ext, version: fields["version"] },
          });
        }
        break;
      case "worker-pool": {
        const [cluster, pool] = ext.split("/");
        if (fields["sizePerZone"]) {
          await this.api.request({
            url: `${CONTAINERS}/v2/resizeWorkerPool`,
            method: "POST",
            body: { cluster, workerpool: pool, size: Number(fields["sizePerZone"]) },
          });
        }
        break;
      }
      case "code-engine-app": {
        const [region, projectId, name] = ext.split("/") as [string, string, string];
        const url = `${codeEngineBase(region)}/projects/${projectId}/apps/${name}`;
        const current = await this.api.request<CeApp>({ url });
        const etag = current.headers["etag"] ?? current.data.entity_tag ?? "*";
        const body: Record<string, unknown> = {};
        if (fields["image"]) body["image_reference"] = fields["image"];
        if (fields["port"]) body["image_port"] = Number(fields["port"]);
        if (fields["minInstances"]) body["scale_min_instances"] = Number(fields["minInstances"]);
        if (fields["maxInstances"]) body["scale_max_instances"] = Number(fields["maxInstances"]);
        if (fields["cpu"]) body["scale_cpu_limit"] = fields["cpu"];
        if (fields["memory"]) body["scale_memory_limit"] = fields["memory"];
        await this.api.request({
          url,
          method: "PATCH",
          body,
          mergePatch: true,
          headers: { "if-match": etag },
        });
        break;
      }
      case "database": {
        if (fields["name"]) {
          await this.api.request({
            url: `${RESOURCE_CONTROLLER}/v2/resource_instances/${encodeURIComponent(ext)}`,
            method: "PATCH",
            body: { name: fields["name"] },
          });
        }
        const group: Record<string, unknown> = {};
        if (fields["memoryMb"]) group["memory"] = { allocation_mb: Number(fields["memoryMb"]) };
        if (fields["diskMb"]) group["disk"] = { allocation_mb: Number(fields["diskMb"]) };
        if (fields["cpu"]) group["cpu"] = { allocation_count: Number(fields["cpu"]) };
        if (Object.keys(group).length) {
          const current = await this.getResource(typeId, resourceId, accountId);
          await this.api.request({
            url: `${databasesBase(String(current.fields["region"] ?? DEFAULT_REGION))}/deployments/${encodeURIComponent(ext)}/groups/member`,
            method: "PATCH",
            body: { group },
          });
        }
        break;
      }
      case "service-instance":
        await this.api.request({
          url: `${RESOURCE_CONTROLLER}/v2/resource_instances/${encodeURIComponent(ext)}`,
          method: "PATCH",
          body: { name: fields["name"] },
        });
        break;
      default:
        throw badRequest(`IBM Cloud plugin: "${typeId}" cannot be edited`);
    }
    return this.getResource(typeId, resourceId, accountId);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const ext = externalIdOf(resourceId);
    const collection = VPC_COLLECTIONS[typeId];
    if (collection) {
      const { region, id } = splitRegional(ext);
      await this.api.request({
        url: this.vpcUrl(region, `/${collection}/${id}`),
        method: "DELETE",
        text: true,
      });
      return;
    }
    switch (typeId) {
      case "resource-group":
        await this.api.request({
          url: `${RESOURCE_CONTROLLER}/v2/resource_groups/${ext}`,
          method: "DELETE",
          text: true,
        });
        return;
      case "kubernetes-cluster":
        await this.api.request({
          url: `${CONTAINERS}/v1/clusters/${ext}`,
          method: "DELETE",
          text: true,
        });
        return;
      case "worker-pool": {
        const [cluster, pool] = ext.split("/");
        await this.api.request({
          url: `${CONTAINERS}/v1/clusters/${cluster}/workerpools/${pool}`,
          method: "DELETE",
          text: true,
        });
        return;
      }
      case "code-engine-project": {
        const { region, id } = splitRegional(ext);
        await this.api.request({
          url: `${codeEngineBase(region)}/projects/${id}`,
          method: "DELETE",
          text: true,
        });
        return;
      }
      case "code-engine-app": {
        const [region, projectId, name] = ext.split("/");
        await this.api.request({
          url: `${codeEngineBase(region!)}/projects/${projectId}/apps/${name}`,
          method: "DELETE",
          text: true,
        });
        return;
      }
      case "cos-bucket": {
        const { region: location, id: bucket } = splitRegional(ext);
        await this.api.request({
          url: `https://${cosEndpoint(location)}/${encodeURIComponent(bucket)}`,
          method: "DELETE",
          text: true,
        });
        return;
      }
      case "database":
      case "service-instance":
        await this.api.request({
          url: `${RESOURCE_CONTROLLER}/v2/resource_instances/${encodeURIComponent(ext)}`,
          method: "DELETE",
          text: true,
        });
        return;
      default:
        throw badRequest(`IBM Cloud plugin: "${typeId}" cannot be deleted`);
    }
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    if (typeId !== "instance" || !["start", "stop", "stop-force", "reboot"].includes(actionId)) {
      throw badRequest(`IBM Cloud plugin: action "${actionId}" is not supported for "${typeId}"`);
    }
    const { region, id } = splitRegional(externalIdOf(resourceId));
    await this.api.request({
      url: this.vpcUrl(region, `/instances/${id}/actions`),
      method: "POST",
      body: {
        type: actionId === "stop-force" ? "stop" : actionId,
        ...(actionId === "stop-force" ? { force: true } : {}),
      },
    });
  }

  async attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    _accountId: string,
  ): Promise<void> {
    if (targetTypeId !== "instance")
      throw badRequest(`IBM Cloud plugin: cannot attach ${sourceTypeId} to ${targetTypeId}`);
    const source = splitRegional(externalIdOf(sourceResourceId));
    const target = splitRegional(externalIdOf(targetResourceId));
    if (sourceTypeId === "volume") {
      await this.api.request({
        url: this.vpcUrl(target.region, `/instances/${target.id}/volume_attachments`),
        method: "POST",
        body: { volume: { id: source.id }, delete_volume_on_instance_delete: false },
      });
      return;
    }
    if (sourceTypeId === "floating-ip") {
      const instance = await vpcGet<{ primary_network_interface?: { id?: string } }>(
        this.api,
        target.region,
        `/instances/${target.id}`,
      );
      const nic = instance.primary_network_interface?.id;
      if (!nic) throw badRequest("The server has no primary network interface to bind to");
      await this.api.request({
        url: this.vpcUrl(source.region, `/floating_ips/${source.id}`),
        method: "PATCH",
        body: { target: { id: nic } },
        mergePatch: true,
      });
      return;
    }
    throw badRequest(`IBM Cloud plugin: cannot attach ${sourceTypeId} to ${targetTypeId}`);
  }

  // -------------------------------------------------------------------------
  // Cost and credits

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchCostData(this.api, range);
  }

  async fetchCreditBalance(_accountId: string): Promise<CreditBalance[]> {
    return fetchCredits(this.api);
  }

  // -------------------------------------------------------------------------
  // COS browser. `bucket` is the bucket's external id (`location/name`).

  private bucketUrl(bucket: string, key = ""): string {
    const { region: location, id: name } = splitRegional(bucket);
    const path = key ? `/${key.split("/").map(encodeURIComponent).join("/")}` : "";
    return `https://${cosEndpoint(location)}/${encodeURIComponent(name)}${path}`;
  }

  private async listPage(
    bucket: string,
    prefix: string,
    token: string,
    delimiter: boolean,
  ): Promise<string> {
    return (
      await this.api.request<string>({
        url: this.bucketUrl(bucket),
        query: {
          "list-type": 2,
          prefix,
          "max-keys": 1000,
          ...(delimiter ? { delimiter: "/" } : {}),
          ...(token ? { "continuation-token": token } : {}),
        },
        headers: { accept: "application/xml" },
        text: true,
      })
    ).data;
  }

  async listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    const out: StorageObject[] = [];
    let token = "";
    for (let page = 0; page < 20; page++) {
      const xml = await this.listPage(bucket, prefix, token, true);
      for (const m of xml.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]*)<\/Prefix>/g)) {
        const key = decodeXml(m[1]!);
        out.push({
          key,
          name: key.slice(prefix.length).replace(/\/$/, ""),
          size: 0,
          lastModified: "",
          isDirectory: true,
        });
      }
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = decodeXml(xmlValue(m[1]!, "Key"));
        if (key === prefix) continue;
        out.push({
          key,
          name: key.slice(prefix.length),
          size: Number(xmlValue(m[1]!, "Size")) || 0,
          lastModified: xmlValue(m[1]!, "LastModified"),
          isDirectory: false,
        });
      }
      token = xmlValue(xml, "NextContinuationToken");
      if (xmlValue(xml, "IsTruncated") !== "true" || !token) break;
    }
    return out;
  }

  async uploadStorageObject(bucket: string, key: string, file: File): Promise<void> {
    await this.api.request({
      url: this.bucketUrl(bucket, key),
      method: "PUT",
      headers: { "content-type": file.type || "application/octet-stream" },
      rawBody: new Uint8Array(await file.arrayBuffer()),
      text: true,
    });
  }

  async makeStorageFolder(bucket: string, key: string): Promise<void> {
    await this.api.request({
      url: this.bucketUrl(bucket, key.endsWith("/") ? key : `${key}/`),
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      rawBody: new Uint8Array(0),
      text: true,
    });
  }

  async deleteStorageObject(bucket: string, key: string): Promise<void> {
    const keys = [key];
    if (key.endsWith("/")) {
      let token = "";
      for (let page = 0; page < 100; page++) {
        const xml = await this.listPage(bucket, key, token, false);
        for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(decodeXml(m[1]!));
        token = xmlValue(xml, "NextContinuationToken");
        if (xmlValue(xml, "IsTruncated") !== "true" || !token) break;
      }
    }
    for (const k of [...new Set(keys)]) {
      await this.api
        .request({ url: this.bucketUrl(bucket, k), method: "DELETE", text: true })
        .catch((err: unknown) => {
          if (k === key && key.endsWith("/") && !isPermissionGap(err)) return;
          throw err;
        });
    }
  }
}
