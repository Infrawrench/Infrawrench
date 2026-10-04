import type {
  CommitmentRecord,
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  CreditBalance,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  QuotaUsage,
  ResourceInstance,
  ResourceTypeDefinition,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import {
  CreditAccessError,
  QuotaAccessError,
  withMetricsCapability,
} from "@infrawrench/plugin-base";
import { CrusoeApi, isStatus } from "./api.js";
import { fetchCrusoeCostData } from "./cost-data.js";
import { buildCreateConfig } from "./create-config.js";
import {
  externalOf,
  mapCluster,
  mapDisk,
  mapFirewallRule,
  mapLoadBalancer,
  mapNetwork,
  mapNodePool,
  mapProject,
  mapReservation,
  mapSnapshot,
  mapSshKey,
  mapSubnet,
  mapVm,
  parseFirewallTargets,
  parseScopedId,
  scopedId,
  splitList,
} from "./mappers.js";
import { DEFAULT_METRICS_WINDOW_MS, fetchVmMetrics } from "./metrics.js";
import { renderCrusoeDetail, renderCrusoeSidebarItem } from "./render.js";
import type {
  CrusoeAsyncResponse,
  CrusoeCluster,
  CrusoeDisk,
  CrusoeEntity,
  CrusoeFirewallRule,
  CrusoeKubeCredentials,
  CrusoeLoadBalancer,
  CrusoeNodePool,
  CrusoeOperation,
  CrusoeProject,
  CrusoeQuota,
  CrusoeReservation,
  CrusoeSnapshot,
  CrusoeSshKey,
  CrusoeVm,
  CrusoeVmType,
  CrusoeVpcNetwork,
  CrusoeVpcSubnet,
} from "./types.js";

/** Collection path under `/projects/{id}` for each project-scoped type. */
export const COLLECTIONS: Record<string, string> = {
  vm: "compute/vms/instances",
  disk: "storage/disks",
  snapshot: "storage/snapshots",
  "vpc-network": "networking/vpc-networks",
  "vpc-subnet": "networking/vpc-subnets",
  "firewall-rule": "networking/vpc-firewall-rules",
  "kubernetes-cluster": "kubernetes/clusters",
  "node-pool": "kubernetes/nodepools",
  "load-balancer": "networking/load-balancers",
};

const CACHE_TTL_MS = 60_000;
const OPERATION_POLL_MS = 2_000;
const OPERATION_TIMEOUT_MS = 120_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v).trim();
}

/**
 * Crusoe Cloud plugin client. One per account (access key pair). The key is a
 * user's key, so an account sees every organization and project that user
 * belongs to; project-scoped listings fan out across all of them.
 */
export class CrusoeClient implements PluginClient {
  readonly api: CrusoeApi;
  private readonly resourceTypes: ResourceTypeDefinition[];
  private orgsCache: { at: number; value: Promise<CrusoeEntity[]> } | undefined;
  private projectsCache: { at: number; value: Promise<CrusoeProject[]> } | undefined;
  private readonly vmTypesCache = new Map<string, Promise<CrusoeVmType[]>>();

  constructor(
    credentials: Record<string, string>,
    resourceTypes: ResourceTypeDefinition[],
    services?: HostServices,
  ) {
    const accessKeyId = str(credentials["accessKeyId"]);
    const secretKey = str(credentials["secretKey"]);
    if (!accessKeyId || !secretKey) {
      throw new Error("Crusoe plugin: missing accessKeyId or secretKey credential");
    }
    this.api = new CrusoeApi(
      {
        accessKeyId,
        secretKey,
        monitoringToken: str(credentials["monitoringToken"]),
        caCert: credentials["caCert"] ?? "",
      },
      services,
    );
    this.resourceTypes = resourceTypes;
  }

  // ── Discovery ────────────────────────────────────────────────────────

  async organizations(): Promise<CrusoeEntity[]> {
    if (!this.orgsCache || Date.now() - this.orgsCache.at > CACHE_TTL_MS) {
      const value = this.api
        .request<{ items?: CrusoeEntity[] }>("/organizations/entities")
        .then((r) => r?.items ?? []);
      value.catch(() => (this.orgsCache = undefined));
      this.orgsCache = { at: Date.now(), value };
    }
    return this.orgsCache.value;
  }

  async projects(): Promise<CrusoeProject[]> {
    if (!this.projectsCache || Date.now() - this.projectsCache.at > CACHE_TTL_MS) {
      const value = this.api
        .request<{ items?: CrusoeProject[] }>("/organizations/projects")
        .then((r) => r?.items ?? []);
      value.catch(() => (this.projectsCache = undefined));
      this.projectsCache = { at: Date.now(), value };
    }
    return this.projectsCache.value;
  }

  async vmTypes(projectId: string): Promise<CrusoeVmType[]> {
    let cached = this.vmTypesCache.get(projectId);
    if (!cached) {
      cached = this.api
        .request<{ items?: CrusoeVmType[] }>(`/projects/${projectId}/compute/vms/types`)
        .then((r) => r?.items ?? [])
        .catch(() => []);
      this.vmTypesCache.set(projectId, cached);
    }
    return cached;
  }

  async locations(): Promise<string[]> {
    const res = await this.api.request<{ items?: string[] }>("/locations");
    return res?.items ?? [];
  }

  private invalidate(): void {
    this.projectsCache = undefined;
  }

  /** Run `fn` per project in parallel; a project the key cannot read lists empty. */
  private async perProject<T>(fn: (projectId: string) => Promise<T[]>): Promise<T[]> {
    const projects = await this.projects();
    const results = await Promise.all(
      projects.map(async (p) => {
        try {
          return await fn(p.id);
        } catch (e) {
          if (isStatus(e, 403, 404)) return [];
          throw e;
        }
      }),
    );
    return results.flat();
  }

  // ── Listing ──────────────────────────────────────────────────────────

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "project": {
        const [projects, orgs] = await Promise.all([
          this.projects(),
          this.organizations().catch(() => []),
        ]);
        const byId = new Map(orgs.map((o) => [o.id, o]));
        return projects.map((p) => mapProject(p, accountId, byId));
      }
      case "ssh-key": {
        const res = await this.api.request<{ items?: CrusoeSshKey[] }>("/users/ssh-keys");
        return (res?.items ?? []).map((k) => mapSshKey(k, accountId));
      }
      case "reservation":
        return this.listReservations(accountId);
      case "vm":
        return this.perProject(async (pid) => {
          const [vms, types] = await Promise.all([
            this.api.listAll<CrusoeVm>(`/projects/${pid}/${COLLECTIONS["vm"]}`),
            this.vmTypes(pid),
          ]);
          const byName = new Map(types.map((t) => [t.product_name, t]));
          return vms.map((vm) => mapVm(vm, pid, accountId, byName));
        });
      case "disk":
        return this.perProject(async (pid) =>
          (await this.api.listAll<CrusoeDisk>(`/projects/${pid}/${COLLECTIONS["disk"]}`)).map((d) =>
            mapDisk(d, pid, accountId),
          ),
        );
      case "snapshot":
        return this.perProject(async (pid) =>
          (
            await this.api.listAll<CrusoeSnapshot>(`/projects/${pid}/${COLLECTIONS["snapshot"]}`)
          ).map((s) => mapSnapshot(s, pid, accountId)),
        );
      case "vpc-network":
        return this.perProject(async (pid) =>
          (
            await this.api.listAll<CrusoeVpcNetwork>(
              `/projects/${pid}/${COLLECTIONS["vpc-network"]}`,
            )
          ).map((n) => mapNetwork(n, pid, accountId)),
        );
      case "vpc-subnet":
        return this.perProject(async (pid) =>
          (
            await this.api.listAll<CrusoeVpcSubnet>(`/projects/${pid}/${COLLECTIONS["vpc-subnet"]}`)
          ).map((s) => mapSubnet(s, pid, accountId)),
        );
      case "firewall-rule":
        return this.perProject(async (pid) =>
          (
            await this.api.listAll<CrusoeFirewallRule>(
              `/projects/${pid}/${COLLECTIONS["firewall-rule"]}`,
            )
          ).map((r) => mapFirewallRule(r, pid, accountId)),
        );
      case "kubernetes-cluster":
        return this.perProject(async (pid) =>
          (
            await this.api.listAll<CrusoeCluster>(
              `/projects/${pid}/${COLLECTIONS["kubernetes-cluster"]}`,
            )
          ).map((c) => mapCluster(c, pid, accountId)),
        );
      case "node-pool":
        return this.perProject(async (pid) =>
          (
            await this.api.listAll<CrusoeNodePool>(`/projects/${pid}/${COLLECTIONS["node-pool"]}`)
          ).map((np) => mapNodePool(np, pid, accountId)),
        );
      case "load-balancer":
        return this.perProject(async (pid) =>
          (
            await this.api.listAll<CrusoeLoadBalancer>(
              `/projects/${pid}/${COLLECTIONS["load-balancer"]}`,
            )
          ).map((lb) => mapLoadBalancer(lb, pid, accountId)),
        );
      default:
        throw new Error(`Crusoe plugin: unknown resource type "${typeId}"`);
    }
  }

  private async listReservations(accountId: string): Promise<ResourceInstance[]> {
    const orgs = await this.organizations();
    const lists = await Promise.all(
      orgs.map(async (org) => {
        try {
          const res = await this.api.request<{ items?: CrusoeReservation[] }>(
            `/organizations/${org.id}/reservations`,
          );
          return (res?.items ?? []).map((r) => mapReservation(r, org.id, accountId));
        } catch (e) {
          // Reservations are an org-member feature; a key without access lists none.
          if (isStatus(e, 403, 404)) return [];
          throw e;
        }
      }),
    );
    return lists.flat();
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const external = externalOf(resourceId);
    const found = all.find((r) => r.id === resourceId || r.externalId === external);
    if (!found) throw new Error(`Crusoe plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "kubernetes-cluster" && outputKey === "kubeconfig") {
      const { projectId, id } = parseScopedId(resourceId);
      const creds = await this.api.request<CrusoeKubeCredentials>(
        `/projects/${projectId}/kubernetes/clusters/${id}/get-credentials`,
        { method: "POST", query: { auth_type: "admin_cert" } },
      );
      return creds?.kube_config ?? "";
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    return resource.resolvedOutputs[outputKey] ?? "";
  }

  // ── Async operations ─────────────────────────────────────────────────

  /**
   * Crusoe answers every mutation with an operation to poll at
   * `/projects/{id}/<collection>/operations/{op}`. Returns the final
   * operation (whose `result` is the affected object on success) and throws
   * the operation's own message on failure. A slow operation is not an
   * error: after the timeout the last state is returned and the next sync
   * shows the outcome.
   */
  async awaitOperation(
    projectId: string,
    typeId: string,
    response: CrusoeAsyncResponse | undefined,
  ): Promise<CrusoeOperation | undefined> {
    let op = response?.operation;
    const collection = COLLECTIONS[typeId];
    if (!op?.operation_id || !collection) return op;
    const deadline = Date.now() + OPERATION_TIMEOUT_MS;
    while (op?.state === "IN_PROGRESS" && Date.now() < deadline) {
      await sleep(OPERATION_POLL_MS);
      op = await this.api.request<CrusoeOperation>(
        `/projects/${projectId}/${collection}/operations/${op.operation_id}`,
      );
    }
    if (op?.state === "FAILED") {
      const result = op.result as { message?: string } | undefined;
      throw new Error(`Crusoe operation failed: ${result?.message ?? "no reason given"}`);
    }
    return op;
  }

  // ── Create / update / delete ─────────────────────────────────────────

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    return buildCreateConfig(this, typeId, parentResourceId);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const name = str(fields["name"]);
    const parentExternal = parentResourceId ? externalOf(parentResourceId) : "";
    const projectFromParent =
      parentResourceId?.includes(":project:") === true ? parentExternal : "";

    if (typeId === "project") {
      const orgs = await this.organizations();
      const organizationId = str(fields["organizationId"]) || orgs[0]?.id;
      if (!organizationId)
        throw new Error("Crusoe plugin: no organization to create the project in");
      const res = await this.api.request<{ project?: CrusoeProject }>("/organizations/projects", {
        method: "POST",
        body: { name, organization_id: organizationId },
      });
      this.invalidate();
      if (!res?.project) throw new Error("Crusoe plugin: project create returned no project");
      return mapProject(res.project, accountId, new Map(orgs.map((o) => [o.id, o])));
    }

    if (typeId === "ssh-key") {
      const res = await this.api.request<{ ssh_key?: CrusoeSshKey }>("/users/ssh-keys", {
        method: "POST",
        body: { name, public_key: str(fields["publicKey"]) },
      });
      if (!res?.ssh_key) throw new Error("Crusoe plugin: SSH key create returned no key");
      return mapSshKey(res.ssh_key, accountId);
    }

    // Types whose parent picker carries the project in a scoped id.
    if (typeId === "snapshot") {
      const { projectId, id: diskId } = parseScopedId(str(fields["diskId"]));
      const op = await this.awaitOperation(
        projectId,
        typeId,
        await this.api.request<CrusoeAsyncResponse>(`/projects/${projectId}/storage/snapshots`, {
          method: "POST",
          body: { name, disk_id: diskId },
        }),
      );
      return this.resolveCreated(typeId, accountId, projectId, op, name);
    }
    if (typeId === "vpc-subnet") {
      const { projectId, id: networkId } = parseScopedId(str(fields["networkId"]));
      const res = await this.api.request<{ subnet?: CrusoeVpcSubnet }>(
        `/projects/${projectId}/networking/vpc-subnets`,
        {
          method: "POST",
          body: {
            name,
            cidr: str(fields["cidr"]),
            location: str(fields["location"]),
            vpc_network_id: networkId,
            nat_gateway_enabled: fields["natGateway"] === "true",
          },
        },
      );
      if (res?.subnet) return mapSubnet(res.subnet, projectId, accountId);
      return this.resolveCreated(typeId, accountId, projectId, undefined, name);
    }
    if (typeId === "firewall-rule") {
      const { projectId, id: networkId } = parseScopedId(str(fields["networkId"]));
      const destinations = str(fields["destinations"]);
      const op = await this.awaitOperation(
        projectId,
        typeId,
        await this.api.request<CrusoeAsyncResponse>(
          `/projects/${projectId}/networking/vpc-firewall-rules`,
          {
            method: "POST",
            body: {
              name,
              vpc_network_id: networkId,
              direction: str(fields["direction"]) || "ingress",
              action: str(fields["action"]) || "allow",
              protocols: splitList(fields["protocols"] || "tcp"),
              sources: parseFirewallTargets(str(fields["sources"]) || "0.0.0.0/0"),
              source_ports: splitList(fields["sourcePorts"] || "1-65535"),
              // No destination means "the whole VPC network".
              destinations: destinations
                ? parseFirewallTargets(destinations)
                : [{ resource_id: networkId }],
              destination_ports: splitList(fields["destinationPorts"] || "1-65535"),
            },
          },
        ),
      );
      return this.resolveCreated(typeId, accountId, projectId, op, name);
    }
    if (typeId === "node-pool") {
      const clusterRef = parentResourceId?.includes(":kubernetes-cluster:")
        ? parentExternal
        : str(fields["clusterId"]);
      const { projectId, id: clusterId } = parseScopedId(clusterRef);
      const count = Number(fields["count"] || "1");
      const version = str(fields["version"]);
      const op = await this.awaitOperation(
        projectId,
        typeId,
        await this.api.request<CrusoeAsyncResponse>(`/projects/${projectId}/kubernetes/nodepools`, {
          method: "POST",
          body: {
            name,
            cluster_id: clusterId,
            product_name: str(fields["type"]),
            count: Number.isFinite(count) ? count : 1,
            ssh_public_key: str(fields["sshPublicKey"]),
            ...(version ? { node_pool_version: version } : {}),
          },
        }),
      );
      return this.resolveCreated(typeId, accountId, projectId, op, name);
    }

    const projectId = projectFromParent || str(fields["projectId"]);
    if (!projectId) throw new Error("Crusoe plugin: choose a project");

    switch (typeId) {
      case "vm": {
        const startup = fields["startupScript"] ?? "";
        const op = await this.awaitOperation(
          projectId,
          typeId,
          await this.api.request<CrusoeAsyncResponse>(
            `/projects/${projectId}/compute/vms/instances`,
            {
              method: "POST",
              body: {
                name,
                type: str(fields["type"]),
                location: str(fields["location"]),
                image: str(fields["image"]),
                ssh_public_key: str(fields["sshPublicKey"]),
                ...(startup.trim() ? { startup_script: startup } : {}),
                reservation_specification: {
                  selection_strategy: str(fields["reservationStrategy"]) || "lowest_cost",
                },
              },
            },
          ),
        );
        return this.resolveCreated(typeId, accountId, projectId, op, name);
      }
      case "disk": {
        const size = Number(fields["sizeGib"]);
        if (!Number.isFinite(size) || size <= 0)
          throw new Error("Crusoe plugin: enter a disk size");
        const op = await this.awaitOperation(
          projectId,
          typeId,
          await this.api.request<CrusoeAsyncResponse>(`/projects/${projectId}/storage/disks`, {
            method: "POST",
            body: {
              name,
              location: str(fields["location"]),
              size: `${Math.round(size)}GiB`,
              type: str(fields["type"]) || "persistent-ssd",
            },
          }),
        );
        return this.resolveCreated(typeId, accountId, projectId, op, name);
      }
      case "vpc-network": {
        const res = await this.api.request<{ network?: CrusoeVpcNetwork }>(
          `/projects/${projectId}/networking/vpc-networks`,
          { method: "POST", body: { name, cidr: str(fields["cidr"]) } },
        );
        if (res?.network) return mapNetwork(res.network, projectId, accountId);
        return this.resolveCreated(typeId, accountId, projectId, undefined, name);
      }
      case "kubernetes-cluster": {
        const subnet = str(fields["subnetId"]);
        const op = await this.awaitOperation(
          projectId,
          typeId,
          await this.api.request<CrusoeAsyncResponse>(
            `/projects/${projectId}/kubernetes/clusters`,
            {
              method: "POST",
              body: {
                name,
                location: str(fields["location"]),
                version: str(fields["version"]),
                private: fields["private"] === "true",
                ...(subnet ? { subnet_id: subnet } : {}),
              },
            },
          ),
        );
        return this.resolveCreated(typeId, accountId, projectId, op, name);
      }
      default:
        throw new Error(`Crusoe plugin: cannot create "${typeId}"`);
    }
  }

  /**
   * Find what a create produced: by the id in the operation result when it
   * has one, else by name. Falls back to a placeholder the next sync replaces
   * when the operation is still running.
   */
  private async resolveCreated(
    typeId: string,
    accountId: string,
    projectId: string,
    op: CrusoeOperation | undefined,
    name: string,
  ): Promise<ResourceInstance> {
    const resultId = (op?.result as { id?: string } | undefined)?.id;
    const all = await this.listResources(typeId, accountId).catch(() => []);
    const found =
      (resultId && all.find((r) => r.externalId === scopedId(projectId, resultId))) ||
      all.find((r) => r.fields["projectId"] === projectId && r.fields["name"] === name);
    if (found) return found;
    const now = new Date().toISOString();
    const externalId = scopedId(projectId, resultId || name);
    return {
      id: `${accountId}:${typeId}:${externalId}`,
      pluginId: "crusoe",
      resourceTypeId: typeId,
      accountId,
      displayName: name,
      fields: { name, projectId, ...(typeId === "vm" ? { state: "provisioning" } : {}) },
      resolvedOutputs: {},
      secretStates: [],
      externalId,
      createdAt: now,
      updatedAt: now,
    };
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId === "project") {
      const id = externalOf(resourceId);
      await this.api.request("/organizations/projects", {
        method: "PUT",
        query: { project_id: id },
        body: { name: str(fields["name"]) },
      });
      this.invalidate();
      return this.getResource(typeId, resourceId, accountId);
    }
    const { projectId, id } = parseScopedId(resourceId);
    const collection = COLLECTIONS[typeId];
    if (!collection) throw new Error(`Crusoe plugin: cannot update "${typeId}"`);
    const path = `/projects/${projectId}/${collection}/${id}`;
    let body: Record<string, unknown> = {};

    switch (typeId) {
      case "vm":
        if (!fields["type"]) break;
        body = { action: "UPDATE", type: str(fields["type"]) };
        break;
      case "disk": {
        const size = Number(fields["sizeGib"]);
        if (!Number.isFinite(size) || size <= 0) break;
        body = { size: `${Math.round(size)}GiB` };
        break;
      }
      case "vpc-network":
        if (fields["name"] !== undefined) body = { name: str(fields["name"]) };
        break;
      case "vpc-subnet":
        if (fields["name"] !== undefined) body["name"] = str(fields["name"]);
        if (fields["natGateway"] !== undefined) {
          body["nat_gateway_action"] = fields["natGateway"] === "true" ? "enable" : "disable";
        }
        break;
      case "firewall-rule":
        if (fields["name"] !== undefined) body["name"] = str(fields["name"]);
        if (fields["protocols"] !== undefined) body["protocols"] = splitList(fields["protocols"]);
        if (fields["sources"] !== undefined)
          body["sources"] = parseFirewallTargets(fields["sources"]);
        if (fields["sourcePorts"] !== undefined) {
          body["source_ports"] = splitList(fields["sourcePorts"]);
        }
        if (fields["destinations"] !== undefined) {
          body["destinations"] = parseFirewallTargets(fields["destinations"]);
        }
        if (fields["destinationPorts"] !== undefined) {
          body["destination_ports"] = splitList(fields["destinationPorts"]);
        }
        break;
      case "node-pool": {
        const current = await this.getResource(typeId, resourceId, accountId);
        if (fields["count"] !== undefined) body["count"] = Number(fields["count"]);
        const touchesAutoscaling =
          fields["autoscaling"] !== undefined ||
          fields["minNodes"] !== undefined ||
          fields["maxNodes"] !== undefined;
        if (touchesAutoscaling) {
          const pick = (key: string) => fields[key] ?? String(current.fields[key] ?? "");
          body["autoscaling_config"] = {
            enabled: pick("autoscaling") === "true",
            min_node_size: Number(pick("minNodes")) || 0,
            max_node_size: Number(pick("maxNodes")) || 0,
          };
        }
        break;
      }
      default:
        throw new Error(`Crusoe plugin: cannot update "${typeId}"`);
    }
    if (Object.keys(body).length === 0) return this.getResource(typeId, resourceId, accountId);
    const res = await this.api.request<CrusoeAsyncResponse>(path, { method: "PATCH", body });
    await this.awaitOperation(projectId, typeId, res);
    return this.getResource(typeId, resourceId, accountId);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    if (typeId === "project") {
      await this.api.request(`/organizations/projects/${externalOf(resourceId)}`, {
        method: "DELETE",
      });
      this.invalidate();
      return;
    }
    if (typeId === "ssh-key") {
      await this.api.request("/users/ssh-keys", {
        method: "DELETE",
        query: { id: externalOf(resourceId) },
      });
      return;
    }
    const collection = COLLECTIONS[typeId];
    if (!collection) throw new Error(`Crusoe plugin: cannot delete "${typeId}"`);
    const { projectId, id } = parseScopedId(resourceId);
    const res = await this.api.request<CrusoeAsyncResponse>(
      `/projects/${projectId}/${collection}/${id}`,
      { method: "DELETE" },
    );
    await this.awaitOperation(projectId, typeId, res);
  }

  // ── Actions ──────────────────────────────────────────────────────────

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    const { projectId, id } = parseScopedId(resourceId);
    if (typeId === "vm" && (actionId === "start" || actionId === "stop" || actionId === "reset")) {
      const res = await this.api.request<CrusoeAsyncResponse>(
        `/projects/${projectId}/compute/vms/instances/${id}`,
        { method: "PATCH", body: { action: actionId.toUpperCase() } },
      );
      await this.awaitOperation(projectId, typeId, res);
      return;
    }
    if (typeId === "disk" && actionId === "detach") {
      const disk = await this.getResource(typeId, resourceId, accountId);
      const vmIds = splitList(String(disk.fields["attachedVmIds"] ?? ""));
      for (const vmId of vmIds) {
        const res = await this.api.request<CrusoeAsyncResponse>(
          `/projects/${projectId}/compute/vms/instances/${vmId}/detach-disks`,
          { method: "POST", body: { detach_disks: [id] } },
        );
        await this.awaitOperation(projectId, "vm", res);
      }
      return;
    }
    if (typeId === "disk" && actionId === "snapshot") {
      const disk = await this.getResource(typeId, resourceId, accountId);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      const res = await this.api.request<CrusoeAsyncResponse>(
        `/projects/${projectId}/storage/snapshots`,
        {
          method: "POST",
          body: { disk_id: id, name: `${String(disk.fields["name"] || id)}-${stamp}`.slice(0, 63) },
        },
      );
      await this.awaitOperation(projectId, "snapshot", res);
      return;
    }
    throw new Error(`Crusoe plugin: action "${actionId}" is not supported for "${typeId}"`);
  }

  async attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    _accountId: string,
  ): Promise<void> {
    if (sourceTypeId !== "disk" || targetTypeId !== "vm") {
      throw new Error(`Crusoe plugin: cannot attach ${sourceTypeId} to ${targetTypeId}`);
    }
    const disk = parseScopedId(sourceResourceId);
    const vm = parseScopedId(targetResourceId);
    if (disk.projectId !== vm.projectId) {
      throw new Error("Crusoe plugin: a disk can only be attached to a VM in the same project");
    }
    const res = await this.api.request<CrusoeAsyncResponse>(
      `/projects/${vm.projectId}/compute/vms/instances/${vm.id}/attach-disks`,
      {
        method: "POST",
        body: { attach_disks: [{ disk_id: disk.id, attachment_type: "data", mode: "read-write" }] },
      },
    );
    await this.awaitOperation(vm.projectId, "vm", res);
  }

  // ── Metrics ──────────────────────────────────────────────────────────

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== "vm") return [];
    const { projectId, id } = parseScopedId(resourceId);
    return fetchVmMetrics(this.api, projectId, id, timeRange);
  }

  // ── Rendering ────────────────────────────────────────────────────────

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return withMetricsCapability(
      renderCrusoeDetail(resource, this.resourceTypes),
      this.resourceTypes,
      resource.resourceTypeId,
      DEFAULT_METRICS_WINDOW_MS,
    );
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderCrusoeSidebarItem(resource);
  }

  // ── Cost, credits, commitments, quotas ───────────────────────────────

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    const [orgs, projects] = await Promise.all([
      this.organizations(),
      this.projects().catch(() => []),
    ]);
    const names = new Map(projects.map((p) => [p.id, p.name || p.id]));
    return fetchCrusoeCostData(this.api, orgs, names, range);
  }

  async fetchCreditBalance(_accountId: string): Promise<CreditBalance[]> {
    const orgs = await this.organizations();
    const balances: CreditBalance[] = [];
    let denied = 0;
    for (const org of orgs) {
      try {
        const res = await this.api.request<{ total_balance?: string; grants_count?: number }>(
          `/organizations/${org.id}/billing/credit-balance`,
        );
        const remaining = Number(res?.total_balance ?? "0");
        if (!Number.isFinite(remaining)) continue;
        balances.push({
          key: org.id,
          label: orgs.length > 1 ? `${org.name || org.id} credits` : "Credit balance",
          remaining,
          currency: "USD",
        });
      } catch (e) {
        if (isStatus(e, 401, 403)) {
          denied++;
          continue;
        }
        throw e;
      }
    }
    if (orgs.length > 0 && denied === orgs.length) {
      throw new CreditAccessError(
        "Crusoe refused the credit balance. It needs an access key from a user with the organization's admin or billing role.",
        { label: "Open Crusoe Cloud billing", url: "https://console.crusoecloud.com/billing" },
      );
    }
    return balances;
  }

  async fetchCommitments(_accountId: string): Promise<CommitmentRecord[]> {
    const orgs = await this.organizations();
    const records: CommitmentRecord[] = [];
    const now = Date.now();
    for (const org of orgs) {
      let items: CrusoeReservation[];
      try {
        const res = await this.api.request<{ items?: CrusoeReservation[] }>(
          `/organizations/${org.id}/reservations`,
        );
        items = res?.items ?? [];
      } catch (e) {
        // No reservations feature for this org: it holds none. Anything else
        // must throw, because a short list reads as commitments ending.
        if (isStatus(e, 403, 404)) continue;
        throw e;
      }
      for (const r of items) {
        const start = r.contract_start_date || r.date_delivered;
        if (!start) continue;
        const startMs = Date.parse(start);
        const endMs = r.contract_end_date ? Date.parse(r.contract_end_date) : Number.NaN;
        const state =
          Number.isFinite(startMs) && startMs > now
            ? "queued"
            : Number.isFinite(endMs) && endMs < now
              ? "expired"
              : "active";
        records.push({
          id: r.id,
          kind: "reservation",
          description: `${r.product_line ?? "Reserved capacity"} × ${r.quantity ?? 0}`,
          ...(r.locations?.length ? { region: r.locations.join(", ") } : {}),
          scope: org.name || org.id,
          startDate: start,
          ...(r.contract_end_date ? { endDate: r.contract_end_date } : {}),
          // Crusoe reports the reserved quantity of the product line, not a
          // dollar commitment, so the record carries units and no money.
          ...(r.quantity
            ? { unitCommitments: [{ unit: r.product_line || "instances", amount: r.quantity }] }
            : {}),
          state,
        });
      }
    }
    return records;
  }

  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
    const orgs = await this.organizations();
    const out: QuotaUsage[] = [];
    let denied = 0;
    for (const org of orgs) {
      try {
        const res = await this.api.request<{ quotas?: CrusoeQuota[] }>(
          `/organizations/${org.id}/quotas`,
        );
        for (const q of res?.quotas ?? []) {
          if (typeof q.max !== "number" || q.max <= 0 || !q.programmatic_name) continue;
          out.push({
            id: `${org.id}/${q.programmatic_name}`,
            service: q.category || "Crusoe Cloud",
            name: q.description || q.programmatic_name,
            limit: q.max,
            used: q.used ?? 0,
            adjustable: true,
          });
        }
      } catch (e) {
        if (isStatus(e, 401, 403)) {
          denied++;
          continue;
        }
        throw e;
      }
    }
    if (orgs.length > 0 && denied === orgs.length) {
      throw new QuotaAccessError("Crusoe refused the organization quota list for this access key.");
    }
    return out;
  }
}
