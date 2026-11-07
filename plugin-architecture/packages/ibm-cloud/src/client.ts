import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
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
import {
  ListPageError,
  ListTruncatedError,
  externalIdOf,
  pathEncode,
  type ApiResponse,
} from "@infrawrench/plugin-base";
import { IbmApi, isPermissionGap } from "./api.js";
import type { operations as DatabaseOperations } from "./api-types.databases.gen.js";
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
  malformedId,
  mapApp,
  mapServiceInstance,
  notFound,
  poolsOf,
  splitApp,
  splitPool,
  splitRegional,
  xmlValue,
  type ListContext,
} from "./listers.js";
import { DEFAULT_REGION, VPC_QUERY, cosEndpoint, hostRegion } from "./regions.js";
import { renderDetail, renderSidebarItem } from "./render.js";
import { RESOURCE_TYPES } from "./resource-types.js";

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

/** VPC and Code Engine writes are JSON Merge Patch. */
const MERGE_PATCH = { "content-type": "application/merge-patch+json" };

const VPC_LISTERS: Record<string, (ctx: ListContext) => Promise<ResourceInstance[]>> = {
  volume: listVolumes,
  vpc: listVpcs,
  subnet: listSubnets,
  "security-group": listSecurityGroups,
  "floating-ip": listFloatingIps,
  "load-balancer": listLoadBalancers,
  "ssh-key": listKeys,
};

interface ConnectionHost {
  hostname?: string;
  port?: number;
}

/** Database connection blocks are keyed by protocol; take whichever one is present. */
function firstHost(
  connection: ApiResponse<DatabaseOperations["getConnection"]>["connection"],
): ConnectionHost | undefined {
  if (!connection) return undefined;
  for (const value of Object.values(connection)) {
    const hosts = value && typeof value === "object" && "hosts" in value ? value.hosts : undefined;
    if (hosts?.[0]) return hosts[0];
  }
  return undefined;
}

const INSTANCE_ACTIONS = ["start", "stop", "stop-force", "reboot"] as const;

function isInstanceAction(action: string): action is (typeof INSTANCE_ACTIONS)[number] {
  return INSTANCE_ACTIONS.some((known) => known === action);
}

/** A Code Engine app, from the parts of its external id. */
function appPath(projectId: string, name: string) {
  return `/projects/${pathEncode(projectId)}/apps/${pathEncode(name)}` as const;
}

/** The id an edit or a delete acts on. A blank one would address the whole collection. */
function targetId(resourceId: string): string {
  const ext = externalIdOf(resourceId);
  if (!ext) throw malformedId(ext);
  return ext;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

const COS_PLACE = { vendor: "IBM Cloud", path: "/{bucket}?list-type=2" };

/** 50,000 objects at 1,000 a page, the most S3 allows, for what one folder shows. */
const MAX_BROWSE_PAGES = 50;

/** 100,000 objects. A folder delete reads all of them before it deletes any. */
const MAX_FOLDER_DELETE_PAGES = 100;

/** The token for the next page of an object listing, or nothing at the end of it. */
function nextObjectToken(xml: string): string {
  if (xmlValue(xml, "IsTruncated") !== "true") return "";
  const token = xmlValue(xml, "NextContinuationToken");
  if (!token) {
    throw new ListPageError({
      ...COS_PLACE,
      key: "NextContinuationToken",
      found: undefined,
      page: xml,
    });
  }
  return decodeXml(token);
}

/**
 * IBM Cloud plugin client, one per API key. See `api.ts` for the IAM token
 * exchange and transport and `listers.ts` for each type.
 */
export class IbmCloudClient implements PluginClient {
  private readonly api: IbmApi;
  private readonly inventory: Inventory;

  constructor(credentials: Credentials, services?: HostServices) {
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

  listResources(
    typeId: string,
    accountId: string,
    opts?: { regionHint?: string },
  ): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
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
    });
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      return this.getByExternalId(typeId, externalIdOf(resourceId), accountId);
    });
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
        return find(await poolsOf(ctx, splitPool(ext).cluster));
      case "code-engine-app": {
        const { region, projectId, name } = splitApp(ext);
        const app = await this.api.codeEngine(region).get(appPath(projectId, name));
        return mapApp(accountId, region, projectId, app);
      }
      case "code-engine-project":
        return find(await listProjects({ ...ctx, regionHint: splitRegional(ext).region }));
      case "database":
      case "service-instance": {
        const r = await this.api.resourceController.get(
          `/v2/resource_instances/${pathEncode(ext)}`,
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

  private async databaseHost(crn: string): Promise<ConnectionHost | undefined> {
    const r = await this.api.resourceController.get(`/v2/resource_instances/${pathEncode(crn)}`);
    const databases = this.api.databases(r.region_id || DEFAULT_REGION);
    const info = await databases.get(`/deployments/${pathEncode(crn)}`);
    const user = info.deployment?.admin_usernames?.["database"] ?? "admin";
    for (const endpoint of ["public", "private"]) {
      const conn = await databases
        .get(
          `/deployments/${pathEncode(crn)}/users/${pathEncode("database")}/${pathEncode(user)}/connections/${pathEncode(endpoint)}`,
        )
        .catch(() => undefined);
      const host = firstHost(conn?.connection);
      if (host?.hostname) return host;
    }
    return undefined;
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
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
      const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const value = resource.resolvedOutputs[outputKey];
      if (value === undefined)
        throw badRequest(`IBM Cloud plugin: cannot resolve output "${outputKey}" for "${typeId}"`);
      return value;
    });
  }

  enrichDetail(resource: ResourceInstance): PluginEffect<ResourceInstance> {
    return attempt(async () => {
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
    });
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderDetail(resource, RESOURCE_TYPES);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderSidebarItem(resource);
  }

  // -------------------------------------------------------------------------
  // Create / update / delete / actions

  getCreateConfig(typeId: string, parentResourceId?: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      return getCreateConfig(this.ctx(""), typeId, parentResourceId);
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      return createResource(this.ctx(accountId), typeId, fields, parentResourceId, (t, ext) =>
        this.getByExternalId(t, ext, accountId),
      );
    });
  }

  /** Edit a VPC resource: the name of any of them, an instance's profile, a volume's size. */
  private async patchVpcResource(
    typeId: string,
    { region, id }: { region: string; id: string },
    fields: Record<string, string>,
  ): Promise<void> {
    const vpc = this.api.vpc(region);
    const segment = pathEncode(id);
    const request = { query: VPC_QUERY, headers: MERGE_PATCH };
    const name = fields["name"] ? { name: fields["name"] } : {};
    if (typeId === "instance") {
      const body = {
        ...name,
        ...(fields["profile"] ? { profile: { name: fields["profile"] } } : {}),
      };
      if (Object.keys(body).length) await vpc.patch(`/instances/${segment}`, { ...request, body });
      return;
    }
    if (typeId === "volume") {
      const body = {
        ...name,
        ...(fields["capacityGb"] ? { capacity: Number(fields["capacityGb"]) } : {}),
      };
      if (Object.keys(body).length) await vpc.patch(`/volumes/${segment}`, { ...request, body });
      return;
    }
    if (!fields["name"]) return;
    const body = { name: fields["name"] };
    switch (typeId) {
      case "vpc":
        await vpc.patch(`/vpcs/${segment}`, { ...request, body });
        return;
      case "subnet":
        await vpc.patch(`/subnets/${segment}`, { ...request, body });
        return;
      case "security-group":
        await vpc.patch(`/security_groups/${segment}`, { ...request, body });
        return;
      case "floating-ip":
        await vpc.patch(`/floating_ips/${segment}`, { ...request, body });
        return;
      case "load-balancer":
        await vpc.patch(`/load_balancers/${segment}`, { ...request, body });
        return;
      case "ssh-key":
        await vpc.patch(`/keys/${segment}`, { ...request, body });
        return;
    }
  }

  private async deleteVpcResource(
    typeId: string,
    { region, id }: { region: string; id: string },
  ): Promise<void> {
    const vpc = this.api.vpc(region);
    const segment = pathEncode(id);
    const request = { query: VPC_QUERY };
    switch (typeId) {
      case "instance":
        await vpc.delete(`/instances/${segment}`, request);
        return;
      case "volume":
        await vpc.delete(`/volumes/${segment}`, request);
        return;
      case "vpc":
        await vpc.delete(`/vpcs/${segment}`, request);
        return;
      case "subnet":
        await vpc.delete(`/subnets/${segment}`, request);
        return;
      case "security-group":
        await vpc.delete(`/security_groups/${segment}`, request);
        return;
      case "floating-ip":
        await vpc.delete(`/floating_ips/${segment}`, request);
        return;
      case "load-balancer":
        await vpc.delete(`/load_balancers/${segment}`, request);
        return;
      case "ssh-key":
        await vpc.delete(`/keys/${segment}`, request);
        return;
    }
  }

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const ext = targetId(resourceId);
      if (typeId in VPC_LISTERS || typeId === "instance") {
        await this.patchVpcResource(typeId, splitRegional(ext), fields);
        return runPluginEffect(this.getResource(typeId, resourceId, accountId));
      }
      switch (typeId) {
        case "resource-group":
          await this.api.resourceManager.patch(`/v2/resource_groups/${pathEncode(ext)}`, {
            body: { name: fields["name"] },
          });
          break;
        case "kubernetes-cluster":
          if (fields["version"]) {
            await this.api.containers.post("/v2/updateMaster", {
              body: { cluster: ext, version: fields["version"] },
            });
          }
          break;
        case "worker-pool": {
          const { cluster, pool } = splitPool(ext);
          if (fields["sizePerZone"]) {
            await this.api.containers.post("/v2/resizeWorkerPool", {
              body: { cluster, workerpool: pool, size: Number(fields["sizePerZone"]) },
            });
          }
          break;
        }
        case "code-engine-app": {
          const { region, projectId, name } = splitApp(ext);
          const path = appPath(projectId, name);
          const codeEngine = this.api.codeEngine(region);
          const current = await codeEngine.getResponse(path);
          const etag = current.headers["etag"] ?? current.body.entity_tag ?? "*";
          await codeEngine.patch(path, {
            headers: { ...MERGE_PATCH, "if-match": etag },
            body: {
              ...(fields["image"] ? { image_reference: fields["image"] } : {}),
              ...(fields["port"] ? { image_port: Number(fields["port"]) } : {}),
              ...(fields["minInstances"]
                ? { scale_min_instances: Number(fields["minInstances"]) }
                : {}),
              ...(fields["maxInstances"]
                ? { scale_max_instances: Number(fields["maxInstances"]) }
                : {}),
              ...(fields["cpu"] ? { scale_cpu_limit: fields["cpu"] } : {}),
              ...(fields["memory"] ? { scale_memory_limit: fields["memory"] } : {}),
            },
          });
          break;
        }
        case "database": {
          if (fields["name"]) {
            await this.api.resourceController.patch(`/v2/resource_instances/${pathEncode(ext)}`, {
              body: { name: fields["name"] },
            });
          }
          const group = {
            ...(fields["memoryMb"]
              ? { memory: { allocation_mb: Number(fields["memoryMb"]) } }
              : {}),
            ...(fields["diskMb"] ? { disk: { allocation_mb: Number(fields["diskMb"]) } } : {}),
            ...(fields["cpu"] ? { cpu: { allocation_count: Number(fields["cpu"]) } } : {}),
          };
          if (Object.keys(group).length) {
            const current = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
            await this.api
              .databases(String(current.fields["region"] ?? DEFAULT_REGION))
              .patch(`/deployments/${pathEncode(ext)}/groups/${pathEncode("member")}`, {
                body: { group },
              });
          }
          break;
        }
        case "service-instance":
          await this.api.resourceController.patch(`/v2/resource_instances/${pathEncode(ext)}`, {
            body: { name: fields["name"] },
          });
          break;
        default:
          throw badRequest(`IBM Cloud plugin: "${typeId}" cannot be edited`);
      }
      return runPluginEffect(this.getResource(typeId, resourceId, accountId));
    });
  }

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const ext = targetId(resourceId);
      if (typeId in VPC_LISTERS || typeId === "instance") {
        await this.deleteVpcResource(typeId, splitRegional(ext));
        return;
      }
      switch (typeId) {
        case "resource-group":
          await this.api.resourceManager.delete(`/v2/resource_groups/${pathEncode(ext)}`);
          return;
        case "kubernetes-cluster":
          await this.api.containers.delete(`/v1/clusters/${pathEncode(ext)}`);
          return;
        case "worker-pool": {
          const { cluster, pool } = splitPool(ext);
          await this.api.containers.delete(
            `/v1/clusters/${pathEncode(cluster)}/workerpools/${pathEncode(pool)}`,
          );
          return;
        }
        case "code-engine-project": {
          const { region, id } = splitRegional(ext);
          await this.api.codeEngine(region).delete(`/projects/${pathEncode(id)}`);
          return;
        }
        case "code-engine-app": {
          const { region, projectId, name } = splitApp(ext);
          await this.api.codeEngine(region).delete(appPath(projectId, name));
          return;
        }
        case "cos-bucket": {
          await this.api.requestXml({ url: this.bucketUrl(ext), method: "DELETE" });
          return;
        }
        case "database":
        case "service-instance":
          await this.api.resourceController.delete(`/v2/resource_instances/${pathEncode(ext)}`);
          return;
        default:
          throw badRequest(`IBM Cloud plugin: "${typeId}" cannot be deleted`);
      }
    });
  }

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      if (typeId !== "instance" || !isInstanceAction(actionId)) {
        throw badRequest(`IBM Cloud plugin: action "${actionId}" is not supported for "${typeId}"`);
      }
      const { region, id } = splitRegional(externalIdOf(resourceId));
      await this.api.vpc(region).post(`/instances/${pathEncode(id)}/actions`, {
        query: VPC_QUERY,
        body: {
          type: actionId === "stop-force" ? "stop" : actionId,
          ...(actionId === "stop-force" ? { force: true } : {}),
        },
      });
    });
  }

  attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    _accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      if (targetTypeId !== "instance")
        throw badRequest(`IBM Cloud plugin: cannot attach ${sourceTypeId} to ${targetTypeId}`);
      const source = splitRegional(externalIdOf(sourceResourceId));
      const target = splitRegional(externalIdOf(targetResourceId));
      if (sourceTypeId === "volume") {
        await this.api
          .vpc(target.region)
          .post(`/instances/${pathEncode(target.id)}/volume_attachments`, {
            query: VPC_QUERY,
            body: { volume: { id: source.id }, delete_volume_on_instance_delete: false },
          });
        return;
      }
      if (sourceTypeId === "floating-ip") {
        const instance = await this.api
          .vpc(target.region)
          .get(`/instances/${pathEncode(target.id)}`, { query: VPC_QUERY });
        const nic = instance.primary_network_interface?.id;
        if (!nic) throw badRequest("The server has no primary network interface to bind to");
        await this.api.vpc(source.region).patch(`/floating_ips/${pathEncode(source.id)}`, {
          query: VPC_QUERY,
          headers: MERGE_PATCH,
          body: { target: { id: nic } },
        });
        return;
      }
      throw badRequest(`IBM Cloud plugin: cannot attach ${sourceTypeId} to ${targetTypeId}`);
    });
  }

  // -------------------------------------------------------------------------
  // Cost and credits

  fetchCostData(_accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      return fetchCostData(this.api, range);
    });
  }

  fetchCreditBalance(_accountId: string): PluginEffect<CreditBalance[]> {
    return attempt(async () => {
      return fetchCredits(this.api);
    });
  }

  // -------------------------------------------------------------------------
  // COS browser. `bucket` is the bucket's external id (`location/name`).

  private bucketUrl(bucket: string, key = ""): string {
    const { region: location, id: name } = splitRegional(bucket);
    const path = key ? `/${key.split("/").map(encodeURIComponent).join("/")}` : "";
    return `https://${cosEndpoint(hostRegion(location))}/${encodeURIComponent(name)}${path}`;
  }

  private async listPage(
    bucket: string,
    prefix: string,
    token: string,
    delimiter: boolean,
  ): Promise<string> {
    const xml = await this.api.requestXml({
      url: this.bucketUrl(bucket),
      query: {
        "list-type": 2,
        prefix,
        "max-keys": 1000,
        ...(delimiter ? { delimiter: "/" } : {}),
        ...(token ? { "continuation-token": token } : {}),
      },
      headers: { accept: "application/xml" },
    });
    if (!xml.includes("<ListBucketResult")) {
      throw new ListPageError({
        ...COS_PLACE,
        key: "ListBucketResult",
        found: undefined,
        page: xml,
      });
    }
    return xml;
  }

  listStorageObjects(bucket: string, prefix: string): PluginEffect<StorageObject[]> {
    return attempt(async () => {
      const out: StorageObject[] = [];
      let token = "";
      for (let page = 0; page < MAX_BROWSE_PAGES; page++) {
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
        token = nextObjectToken(xml);
        if (!token) return out;
      }
      throw new ListTruncatedError({
        ...COS_PLACE,
        items: out.length,
        maxPages: MAX_BROWSE_PAGES,
      });
    });
  }

  uploadStorageObject(bucket: string, key: string, file: File): PluginEffect<void> {
    return attempt(async () => {
      await this.api.requestXml({
        url: this.bucketUrl(bucket, key),
        method: "PUT",
        headers: { "content-type": file.type || "application/octet-stream" },
        body: new Uint8Array(await file.arrayBuffer()),
      });
    });
  }

  makeStorageFolder(bucket: string, key: string): PluginEffect<void> {
    return attempt(async () => {
      await this.api.requestXml({
        url: this.bucketUrl(bucket, key.endsWith("/") ? key : `${key}/`),
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(0),
      });
    });
  }

  deleteStorageObject(bucket: string, key: string): PluginEffect<void> {
    return attempt(async () => {
      const keys = [key];
      if (key.endsWith("/")) {
        let token = "";
        let complete = false;
        for (let page = 0; page < MAX_FOLDER_DELETE_PAGES && !complete; page++) {
          const xml = await this.listPage(bucket, key, token, false);
          for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(decodeXml(m[1]!));
          token = nextObjectToken(xml);
          complete = !token;
        }
        if (!complete) {
          throw new ListTruncatedError({
            ...COS_PLACE,
            items: keys.length,
            maxPages: MAX_FOLDER_DELETE_PAGES,
          });
        }
      }
      for (const k of [...new Set(keys)]) {
        await this.api
          .requestXml({ url: this.bucketUrl(bucket, k), method: "DELETE" })
          .catch((err: unknown) => {
            if (k === key && key.endsWith("/") && !isPermissionGap(err)) return;
            throw err;
          });
      }
    });
  }
}
