import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
import type {
  CiComputeStatus,
  CiExecutorKind,
  CiHandle,
  CiPreflightResult,
  CiStartSpec,
  CiTaggedCompute,
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
  rethrowIncompleteList,
  withMetricsCapability,
} from "@infrawrench/plugin-base";
import type { ApiBody } from "@infrawrench/plugin-base";
import {
  createCrusoeApi,
  isStatus,
  listAll,
  pageItems,
  requireId,
  seg,
  type CrusoeApi,
} from "./api.js";
import type { operations } from "./api-types.gen.js";
import {
  crusoeCiListTagged,
  crusoeCiPreflight,
  crusoeCiStart,
  crusoeCiStatus,
  crusoeCiTeardown,
} from "./ci-executor.js";
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
  CrusoeEntity,
  CrusoeOperation,
  CrusoeProject,
  CrusoeQuota,
  CrusoeVmType,
} from "./types.js";

type Collection =
  | "compute/vms/instances"
  | "storage/disks"
  | "storage/snapshots"
  | "networking/vpc-networks"
  | "networking/vpc-subnets"
  | "networking/vpc-firewall-rules"
  | "kubernetes/clusters"
  | "kubernetes/nodepools"
  | "networking/load-balancers";

/** Collection path under `/projects/{id}` for each project-scoped type. */
export const COLLECTIONS: Record<string, Collection> = {
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

const VM_ACTIONS = { start: "START", stop: "STOP", reset: "RESET" } as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A body whose every field was left out, so there is nothing to ask for. */
function isBlank(body: object): boolean {
  return Object.values(body).every((value) => value === undefined);
}

function str(v: string | null | undefined): string {
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
    credentials: Credentials,
    resourceTypes: ResourceTypeDefinition[],
    services?: HostServices,
  ) {
    const accessKeyId = str(credentials["accessKeyId"]);
    const secretKey = str(credentials["secretKey"]);
    if (!accessKeyId || !secretKey) {
      throw new Error("Crusoe plugin: missing accessKeyId or secretKey credential");
    }
    this.api = createCrusoeApi(
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
        .get("/organizations/entities")
        .then((r) => pageItems(r, "/organizations/entities"));
      value.catch(() => (this.orgsCache = undefined));
      this.orgsCache = { at: Date.now(), value };
    }
    return this.orgsCache.value;
  }

  async projects(): Promise<CrusoeProject[]> {
    if (!this.projectsCache || Date.now() - this.projectsCache.at > CACHE_TTL_MS) {
      const value = this.api
        .get("/organizations/projects")
        .then((r) => pageItems(r, "/organizations/projects"));
      value.catch(() => (this.projectsCache = undefined));
      this.projectsCache = { at: Date.now(), value };
    }
    return this.projectsCache.value;
  }

  async vmTypes(projectId: string): Promise<CrusoeVmType[]> {
    let cached = this.vmTypesCache.get(projectId);
    if (!cached) {
      cached = this.api
        .get(`/projects/${seg(projectId)}/compute/vms/types`)
        .then((r) => r?.items ?? [])
        .catch(() => {
          this.vmTypesCache.delete(projectId);
          return [];
        });
      this.vmTypesCache.set(projectId, cached);
    }
    return cached;
  }

  async locations(): Promise<string[]> {
    const res = await this.api.get("/locations");
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

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      switch (typeId) {
        case "project": {
          const [projects, orgs] = await Promise.all([
            this.projects(),
            // Only the organization's name on each row, but not at the cost of hiding a bad list.
            this.organizations().catch((err) => {
              rethrowIncompleteList(err);
              return [];
            }),
          ]);
          const byId = new Map(orgs.map((o) => [o.id, o]));
          return projects.map((p) => mapProject(p, accountId, byId));
        }
        case "ssh-key": {
          const res = await this.api.get("/users/ssh-keys");
          return pageItems(res, "/users/ssh-keys").map((k) => mapSshKey(k, accountId));
        }
        case "reservation":
          return this.listReservations(accountId);
        case "vm":
          return this.perProject(async (pid) => {
            const [vms, types] = await Promise.all([
              listAll("/projects/{project_id}/compute/vms/instances", (query) =>
                this.api.get(`/projects/${seg(pid)}/compute/vms/instances`, { query }),
              ),
              this.vmTypes(pid),
            ]);
            const byName = new Map(types.map((t) => [t.product_name, t]));
            return vms.map((vm) => mapVm(vm, pid, accountId, byName));
          });
        case "disk":
          return this.perProject(async (pid) =>
            (
              await listAll("/projects/{project_id}/storage/disks", (query) =>
                this.api.get(`/projects/${seg(pid)}/storage/disks`, { query }),
              )
            ).map((d) => mapDisk(d, pid, accountId)),
          );
        case "snapshot":
          return this.perProject(async (pid) =>
            (
              await listAll("/projects/{project_id}/storage/snapshots", (query) =>
                this.api.get(`/projects/${seg(pid)}/storage/snapshots`, { query }),
              )
            ).map((s) => mapSnapshot(s, pid, accountId)),
          );
        case "vpc-network":
          return this.perProject(async (pid) =>
            (
              await listAll("/projects/{project_id}/networking/vpc-networks", (query) =>
                this.api.get(`/projects/${seg(pid)}/networking/vpc-networks`, { query }),
              )
            ).map((n) => mapNetwork(n, pid, accountId)),
          );
        case "vpc-subnet":
          return this.perProject(async (pid) =>
            (
              await listAll("/projects/{project_id}/networking/vpc-subnets", (query) =>
                this.api.get(`/projects/${seg(pid)}/networking/vpc-subnets`, { query }),
              )
            ).map((s) => mapSubnet(s, pid, accountId)),
          );
        case "firewall-rule":
          return this.perProject(async (pid) =>
            (
              await listAll("/projects/{project_id}/networking/vpc-firewall-rules", (query) =>
                this.api.get(`/projects/${seg(pid)}/networking/vpc-firewall-rules`, { query }),
              )
            ).map((r) => mapFirewallRule(r, pid, accountId)),
          );
        case "kubernetes-cluster":
          return this.perProject(async (pid) =>
            (
              await listAll("/projects/{project_id}/kubernetes/clusters", (query) =>
                this.api.get(`/projects/${seg(pid)}/kubernetes/clusters`, { query }),
              )
            ).map((c) => mapCluster(c, pid, accountId)),
          );
        case "node-pool":
          return this.perProject(async (pid) =>
            (
              await listAll("/projects/{project_id}/kubernetes/nodepools", (query) =>
                this.api.get(`/projects/${seg(pid)}/kubernetes/nodepools`, { query }),
              )
            ).map((np) => mapNodePool(np, pid, accountId)),
          );
        case "load-balancer":
          return this.perProject(async (pid) =>
            (
              await listAll("/projects/{project_id}/networking/load-balancers", (query) =>
                this.api.get(`/projects/${seg(pid)}/networking/load-balancers`, { query }),
              )
            ).map((lb) => mapLoadBalancer(lb, pid, accountId)),
          );
        default:
          throw new Error(`Crusoe plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  private async listReservations(accountId: string): Promise<ResourceInstance[]> {
    const orgs = await this.organizations();
    const lists = await Promise.all(
      orgs.map(async (org) => {
        try {
          const res = await this.api.get(`/organizations/${seg(org.id)}/reservations`);
          return pageItems(res, "/organizations/{organization_id}/reservations").map((r) =>
            mapReservation(r, org.id, accountId),
          );
        } catch (e) {
          // Reservations are an org-member feature; a key without access lists none.
          if (isStatus(e, 403, 404)) return [];
          throw e;
        }
      }),
    );
    return lists.flat();
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const all = await runPluginEffect(this.listResources(typeId, accountId));
      const external = externalOf(resourceId);
      const found = all.find((r) => r.id === resourceId || r.externalId === external);
      if (!found) throw new Error(`Crusoe plugin: resource ${typeId}/${resourceId} not found`);
      return found;
    });
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      if (typeId === "kubernetes-cluster" && outputKey === "kubeconfig") {
        const { projectId, id } = parseScopedId(resourceId);
        const creds = await this.api.post(
          `/projects/${seg(projectId)}/kubernetes/clusters/${seg(id)}/get-credentials`,
          { query: { auth_type: "admin_cert" } },
        );
        return creds?.kube_config ?? "";
      }
      const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      return resource.resolvedOutputs[outputKey] ?? "";
    });
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
      op = await this.api.get(
        `/projects/${seg(projectId)}/${collection}/operations/${seg(op.operation_id)}`,
      );
    }
    if (op?.state === "FAILED") {
      throw new Error(`Crusoe operation failed: ${op.result?.message ?? "no reason given"}`);
    }
    return op;
  }

  // ── Create / update / delete ─────────────────────────────────────────

  getCreateConfig(typeId: string, parentResourceId?: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      return buildCreateConfig(this, typeId, parentResourceId);
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const name = str(fields["name"]);
      const parentExternal = parentResourceId ? externalOf(parentResourceId) : "";
      const projectFromParent =
        parentResourceId?.includes(":project:") === true ? parentExternal : "";

      if (typeId === "project") {
        const orgs = await this.organizations();
        const organizationId = str(fields["organizationId"]) || orgs[0]?.id;
        if (!organizationId)
          throw new Error("Crusoe plugin: no organization to create the project in");
        const res = await this.api.post("/organizations/projects", {
          body: { name, organization_id: organizationId },
        });
        this.invalidate();
        if (!res?.project) throw new Error("Crusoe plugin: project create returned no project");
        return mapProject(res.project, accountId, new Map(orgs.map((o) => [o.id, o])));
      }

      if (typeId === "ssh-key") {
        const res = await this.api.post("/users/ssh-keys", {
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
          await this.api.post(`/projects/${seg(projectId)}/storage/snapshots`, {
            body: { name, disk_id: diskId },
          }),
        );
        return this.resolveCreated(typeId, accountId, projectId, op, name);
      }
      if (typeId === "vpc-subnet") {
        const { projectId, id: networkId } = parseScopedId(str(fields["networkId"]));
        const res = await this.api.post(`/projects/${seg(projectId)}/networking/vpc-subnets`, {
          body: {
            name,
            cidr: str(fields["cidr"]),
            location: str(fields["location"]),
            vpc_network_id: networkId,
            nat_gateway_enabled: fields["natGateway"] === "true",
          },
        });
        if (res?.subnet) return mapSubnet(res.subnet, projectId, accountId);
        return this.resolveCreated(typeId, accountId, projectId, undefined, name);
      }
      if (typeId === "firewall-rule") {
        const { projectId, id: networkId } = parseScopedId(str(fields["networkId"]));
        const destinations = str(fields["destinations"]);
        const op = await this.awaitOperation(
          projectId,
          typeId,
          await this.api.post(`/projects/${seg(projectId)}/networking/vpc-firewall-rules`, {
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
          }),
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
          await this.api.post(`/projects/${seg(projectId)}/kubernetes/nodepools`, {
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
            await this.api.post(`/projects/${seg(projectId)}/compute/vms/instances`, {
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
            }),
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
            await this.api.post(`/projects/${seg(projectId)}/storage/disks`, {
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
          const res = await this.api.post(`/projects/${seg(projectId)}/networking/vpc-networks`, {
            body: { name, cidr: str(fields["cidr"]) },
          });
          if (res?.network) return mapNetwork(res.network, projectId, accountId);
          return this.resolveCreated(typeId, accountId, projectId, undefined, name);
        }
        case "kubernetes-cluster": {
          const subnet = str(fields["subnetId"]);
          const op = await this.awaitOperation(
            projectId,
            typeId,
            await this.api.post(`/projects/${seg(projectId)}/kubernetes/clusters`, {
              body: {
                name,
                location: str(fields["location"]),
                version: str(fields["version"]),
                private: fields["private"] === "true",
                ...(subnet ? { subnet_id: subnet } : {}),
              },
            }),
          );
          return this.resolveCreated(typeId, accountId, projectId, op, name);
        }
        default:
          throw new Error(`Crusoe plugin: cannot create "${typeId}"`);
      }
    });
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
    const resultId = op?.result?.id;
    const all = await runPluginEffect(this.listResources(typeId, accountId)).catch(() => []);
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

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      if (typeId === "project") {
        if (fields["name"] === undefined) {
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        const id = requireId(externalOf(resourceId));
        await this.api.put("/organizations/projects", {
          query: { project_id: id },
          body: { name: str(fields["name"]) },
        });
        this.invalidate();
        return runPluginEffect(this.getResource(typeId, resourceId, accountId));
      }
      const { projectId, id } = parseScopedId(resourceId);
      if (!COLLECTIONS[typeId]) throw new Error(`Crusoe plugin: cannot update "${typeId}"`);
      const project = seg(projectId);
      const item = seg(id);
      const current = () => runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const settled = async (res: CrusoeAsyncResponse | undefined) => {
        await this.awaitOperation(projectId, typeId, res);
        return current();
      };
      /** A field the form left out is not sent: `JSON.stringify` drops `undefined`. */
      const given = <T>(key: string, read: (value: string) => T): T | undefined => {
        const value = fields[key];
        return value === undefined ? undefined : read(value);
      };

      switch (typeId) {
        case "vm":
          if (!fields["type"]) return current();
          return settled(
            await this.api.patch(`/projects/${project}/compute/vms/instances/${item}`, {
              body: { action: "UPDATE", type: str(fields["type"]) },
            }),
          );
        case "disk": {
          const size = Number(fields["sizeGib"]);
          if (!Number.isFinite(size) || size <= 0) return current();
          return settled(
            await this.api.patch(`/projects/${project}/storage/disks/${item}`, {
              body: { size: `${Math.round(size)}GiB` },
            }),
          );
        }
        case "vpc-network":
          if (fields["name"] === undefined) return current();
          return settled(
            await this.api.patch(`/projects/${project}/networking/vpc-networks/${item}`, {
              body: { name: str(fields["name"]) },
            }),
          );
        case "vpc-subnet": {
          const body: ApiBody<operations["patchVPCSubnet"]> = {
            name: given("name", str),
            nat_gateway_action: given("natGateway", (v) => (v === "true" ? "enable" : "disable")),
          };
          if (isBlank(body)) return current();
          // The document requires a name on every patch, even one that only moves the NAT
          // gateway, such as a revert carrying just that field.
          body.name ??= str(String((await current()).fields["name"] ?? "")) || undefined;
          return settled(
            await this.api.patch(`/projects/${project}/networking/vpc-subnets/${item}`, { body }),
          );
        }
        case "firewall-rule": {
          const body: ApiBody<operations["patchVPCFirewallRule"]> = {
            name: given("name", str),
            protocols: given("protocols", splitList),
            sources: given("sources", parseFirewallTargets),
            source_ports: given("sourcePorts", splitList),
            destinations: given("destinations", parseFirewallTargets),
            destination_ports: given("destinationPorts", splitList),
          };
          if (isBlank(body)) return current();
          return settled(
            await this.api.patch(`/projects/${project}/networking/vpc-firewall-rules/${item}`, {
              body,
            }),
          );
        }
        case "node-pool": {
          const pool = await current();
          const touchesAutoscaling =
            fields["autoscaling"] !== undefined ||
            fields["minNodes"] !== undefined ||
            fields["maxNodes"] !== undefined;
          const pick = (key: string) => fields[key] ?? String(pool.fields[key] ?? "");
          const body: ApiBody<operations["updateNodePool"]> = {
            // Required by the document, whose own text says it defaults to UPDATE.
            action: undefined,
            count: given("count", Number),
            autoscaling_config: touchesAutoscaling
              ? {
                  enabled: pick("autoscaling") === "true",
                  min_node_size: Number(pick("minNodes")) || 0,
                  max_node_size: Number(pick("maxNodes")) || 0,
                }
              : undefined,
          };
          if (isBlank(body)) return current();
          return settled(
            await this.api.patch(`/projects/${project}/kubernetes/nodepools/${item}`, { body }),
          );
        }
        default:
          throw new Error(`Crusoe plugin: cannot update "${typeId}"`);
      }
    });
  }

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      if (typeId === "project") {
        await this.api.delete(`/organizations/projects/${seg(externalOf(resourceId))}`);
        this.invalidate();
        return;
      }
      if (typeId === "ssh-key") {
        await this.api.delete("/users/ssh-keys", {
          query: { id: requireId(externalOf(resourceId)) },
        });
        return;
      }
      const collection = COLLECTIONS[typeId];
      if (!collection) throw new Error(`Crusoe plugin: cannot delete "${typeId}"`);
      const { projectId, id } = parseScopedId(resourceId);
      const res = await this.api.delete(`/projects/${seg(projectId)}/${collection}/${seg(id)}`);
      await this.awaitOperation(projectId, typeId, res);
    });
  }

  // ── Actions ──────────────────────────────────────────────────────────

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const { projectId, id } = parseScopedId(resourceId);
      if (
        typeId === "vm" &&
        (actionId === "start" || actionId === "stop" || actionId === "reset")
      ) {
        const res = await this.api.patch(
          `/projects/${seg(projectId)}/compute/vms/instances/${seg(id)}`,
          {
            body: { action: VM_ACTIONS[actionId] },
          },
        );
        await this.awaitOperation(projectId, typeId, res);
        return;
      }
      if (typeId === "disk" && actionId === "detach") {
        const disk = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
        const vmIds = splitList(String(disk.fields["attachedVmIds"] ?? ""));
        for (const vmId of vmIds) {
          const res = await this.api.post(
            `/projects/${seg(projectId)}/compute/vms/instances/${seg(vmId)}/detach-disks`,
            { body: { detach_disks: [id] } },
          );
          await this.awaitOperation(projectId, "vm", res);
        }
        return;
      }
      if (typeId === "disk" && actionId === "snapshot") {
        const disk = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
        const res = await this.api.post(`/projects/${seg(projectId)}/storage/snapshots`, {
          body: {
            disk_id: id,
            name: `${String(disk.fields["name"] || id)}-${stamp}`.slice(0, 63),
          },
        });
        await this.awaitOperation(projectId, "snapshot", res);
        return;
      }
      throw new Error(`Crusoe plugin: action "${actionId}" is not supported for "${typeId}"`);
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
      if (sourceTypeId !== "disk" || targetTypeId !== "vm") {
        throw new Error(`Crusoe plugin: cannot attach ${sourceTypeId} to ${targetTypeId}`);
      }
      const disk = parseScopedId(sourceResourceId);
      const vm = parseScopedId(targetResourceId);
      if (disk.projectId !== vm.projectId) {
        throw new Error("Crusoe plugin: a disk can only be attached to a VM in the same project");
      }
      const res = await this.api.post(
        `/projects/${seg(vm.projectId)}/compute/vms/instances/${seg(vm.id)}/attach-disks`,
        {
          body: {
            attach_disks: [{ disk_id: disk.id, attachment_type: "data", mode: "read-write" }],
          },
        },
      );
      await this.awaitOperation(vm.projectId, "vm", res);
    });
  }

  // ── Metrics ──────────────────────────────────────────────────────────

  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      if (resourceTypeId !== "vm") return [];
      const { projectId, id } = parseScopedId(resourceId);
      return fetchVmMetrics(this.api, projectId, id, timeRange);
    });
  }

  // ── Rendering ────────────────────────────────────────────────────────

  // ── CI jobs (see ci-executor.ts) ─────────────────────────────────────

  ciPreflight(kind: CiExecutorKind, region?: string): PluginEffect<CiPreflightResult> {
    return attempt(() => crusoeCiPreflight(this, kind, region));
  }

  ciStart(spec: CiStartSpec): PluginEffect<CiHandle> {
    return attempt(() => crusoeCiStart(this, spec));
  }

  ciStatus(handle: CiHandle): PluginEffect<CiComputeStatus> {
    return attempt(() => crusoeCiStatus(this, handle));
  }

  ciTeardown(handle: CiHandle): PluginEffect<void> {
    return attempt(() => crusoeCiTeardown(this, handle));
  }

  ciListTagged(tagKey: string, _regions: readonly string[]): PluginEffect<CiTaggedCompute[]> {
    return attempt(() => crusoeCiListTagged(this, tagKey));
  }

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

  fetchCostData(_accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      const [orgs, projects] = await Promise.all([
        this.organizations(),
        this.projects().catch((err) => {
          rethrowIncompleteList(err);
          return [];
        }),
      ]);
      const names = new Map(projects.map((p) => [p.id, p.name || p.id]));
      return fetchCrusoeCostData(this.api, orgs, names, range);
    });
  }

  fetchCreditBalance(_accountId: string): PluginEffect<CreditBalance[]> {
    return attempt(async () => {
      const orgs = await this.organizations();
      const balances: CreditBalance[] = [];
      let denied = 0;
      for (const org of orgs) {
        try {
          const res = await this.api.get(`/organizations/${seg(org.id)}/billing/credit-balance`);
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
    });
  }

  fetchCommitments(_accountId: string): PluginEffect<CommitmentRecord[]> {
    return attempt(async () => {
      const orgs = await this.organizations();
      const records: CommitmentRecord[] = [];
      const now = Date.now();
      for (const org of orgs) {
        let items;
        try {
          const res = await this.api.get(`/organizations/${seg(org.id)}/reservations`);
          items = pageItems(res, "/organizations/{organization_id}/reservations");
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
    });
  }

  fetchQuotas(_accountId: string): PluginEffect<QuotaUsage[]> {
    return attempt(async () => {
      const orgs = await this.organizations();
      const out: QuotaUsage[] = [];
      let denied = 0;
      for (const org of orgs) {
        try {
          const res = await this.api.get(`/organizations/${seg(org.id)}/quotas`);
          const quotas: CrusoeQuota[] = res?.quotas ?? [];
          for (const q of quotas) {
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
        throw new QuotaAccessError(
          "Crusoe refused the organization quota list for this access key.",
        );
      }
      return out;
    });
  }
}
