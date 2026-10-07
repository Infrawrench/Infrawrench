import type {
  CreateResourceConfig,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  ResourceInstance,
  ResourceTypeDefinition,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { PaperspaceApi } from "./api.js";
import { buildCreateConfig, NONE } from "./create-config.js";
import {
  externalOf,
  mapCustomTemplate,
  mapDeployment,
  mapMachine,
  mapNetwork,
  mapProject,
  mapPublicIp,
  mapRegistry,
  mapSharedDrive,
  mapSnapshot,
  mapStartupScript,
} from "./mappers.js";
import { fetchDeploymentMetrics } from "./metrics.js";
import { renderPaperspaceDetail, renderPaperspaceSidebarItem } from "./render.js";
import type {
  PDeployment,
  PMachine,
  PMachineEvent,
  PNetwork,
  POsTemplate,
  PProject,
  PPublicIp,
  PRegistry,
  PSharedDrive,
  PSnapshot,
  PStartupScript,
} from "./types.js";

const EVENT_POLL_MS = 2_000;
const EVENT_TIMEOUT_MS = 90_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v).trim();
}

function picked(v: string | undefined): string {
  const s = str(v);
  return s === NONE ? "" : s;
}

function bool(v: string | undefined): boolean | undefined {
  if (v === undefined || v === "") return undefined;
  return v === "true";
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Collection path per type. */
const PATHS: Record<string, string> = {
  project: "/projects",
  machine: "/machines",
  "shared-drive": "/shared-drives",
  snapshot: "/snapshots",
  "custom-template": "/custom-templates",
  "private-network": "/private-networks",
  "public-ip": "/public-ips",
  "startup-script": "/startup-scripts",
  deployment: "/deployments",
  "container-registry": "/container-registries",
};

/**
 * Paperspace plugin client. One per account (API key); keys are team-scoped,
 * so every listing is the team's.
 */
export class PaperspaceClient implements PluginClient {
  readonly api: PaperspaceApi;
  private readonly resourceTypes: ResourceTypeDefinition[];

  constructor(
    credentials: Record<string, string>,
    resourceTypes: ResourceTypeDefinition[],
    services?: HostServices,
  ) {
    const apiKey = str(credentials["apiKey"]);
    if (!apiKey) throw new Error("Paperspace plugin: missing apiKey credential");
    this.api = new PaperspaceApi(apiKey, credentials["caCert"] ?? "", services);
    this.resourceTypes = resourceTypes;
  }

  readonly raw = {
    projects: () => this.api.listAll<PProject>("/projects"),
    machines: () => this.api.listAll<PMachine>("/machines"),
    sharedDrives: () => this.api.listAll<PSharedDrive>("/shared-drives"),
    snapshots: () => this.api.listAll<PSnapshot>("/snapshots"),
    customTemplates: () => this.api.listAll<POsTemplate>("/custom-templates"),
    osTemplates: () => this.api.listAll<POsTemplate>("/os-templates"),
    networks: () => this.api.listAll<PNetwork>("/private-networks"),
    publicIps: () => this.api.listAll<PPublicIp>("/public-ips"),
    startupScripts: () => this.api.listAll<PStartupScript>("/startup-scripts"),
    deployments: () => this.api.listAll<PDeployment>("/deployments"),
    registries: () => this.api.listAll<PRegistry>("/container-registries"),
  };

  /**
   * Machine, snapshot and template operations answer with an event to poll.
   * Waits for it to settle and throws its error; a slow event is not an
   * error, the next sync shows the outcome.
   */
  async awaitEvent(event: PMachineEvent | undefined): Promise<void> {
    if (!event?.id) return;
    let current = event;
    const deadline = Date.now() + EVENT_TIMEOUT_MS;
    while ((current.state === "new" || current.state === "in progress") && Date.now() < deadline) {
      await sleep(EVENT_POLL_MS);
      current = await this.api.request<PMachineEvent>(
        `/machine-events/${encodeURIComponent(event.id)}`,
      );
    }
    if (current.state === "error") {
      throw new Error(
        `Paperspace ${current.name ?? "operation"} failed: ${current.error ?? "no reason given"}`,
      );
    }
  }

  // ── Listing ──────────────────────────────────────────────────────────

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "project":
        return (await this.raw.projects()).map((p) => mapProject(p, accountId));
      case "machine":
        return (await this.raw.machines()).map((m) => mapMachine(m, accountId));
      case "shared-drive":
        return (await this.raw.sharedDrives()).map((d) => mapSharedDrive(d, accountId));
      case "snapshot":
        return (await this.raw.snapshots()).map((s) => mapSnapshot(s, accountId));
      case "custom-template":
        return (await this.raw.customTemplates()).map((t) => mapCustomTemplate(t, accountId));
      case "private-network":
        return (await this.raw.networks()).map((n) => mapNetwork(n, accountId));
      case "public-ip":
        return (await this.raw.publicIps()).map((p) => mapPublicIp(p, accountId));
      case "startup-script":
        return (await this.raw.startupScripts()).map((s) => mapStartupScript(s, accountId));
      case "deployment":
        return (await this.raw.deployments()).map((d) => mapDeployment(d, accountId));
      case "container-registry":
        return (await this.raw.registries()).map((r) => mapRegistry(r, accountId));
      default:
        throw new Error(`Paperspace plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalOf(resourceId);
    if (typeId === "public-ip") {
      const found = (await this.raw.publicIps()).find((p) => p.ip === id);
      if (!found) {
        const err = new Error(`Paperspace plugin: public IP ${id} not found`);
        (err as Error & { status: number }).status = 404;
        throw err;
      }
      return mapPublicIp(found, accountId);
    }
    const path = PATHS[typeId];
    if (!path) throw new Error(`Paperspace plugin: unknown resource type "${typeId}"`);
    const item = await this.api.request<unknown>(`${path}/${encodeURIComponent(id)}`);
    return this.mapOne(typeId, item, accountId);
  }

  private mapOne(typeId: string, item: unknown, accountId: string): ResourceInstance {
    switch (typeId) {
      case "project":
        return mapProject(item as PProject, accountId);
      case "machine":
        return mapMachine(item as PMachine, accountId);
      case "shared-drive":
        return mapSharedDrive(item as PSharedDrive, accountId);
      case "snapshot":
        return mapSnapshot(item as PSnapshot, accountId);
      case "custom-template":
        return mapCustomTemplate(item as POsTemplate, accountId);
      case "private-network":
        return mapNetwork(item as PNetwork, accountId);
      case "public-ip":
        return mapPublicIp(item as PPublicIp, accountId);
      case "startup-script":
        return mapStartupScript(item as PStartupScript, accountId);
      case "deployment":
        return mapDeployment(item as PDeployment, accountId);
      case "container-registry":
        return mapRegistry(item as PRegistry, accountId);
      default:
        throw new Error(`Paperspace plugin: unknown resource type "${typeId}"`);
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "shared-drive" && outputKey === "password") {
      const d = await this.api.request<PSharedDrive>(
        `/shared-drives/${encodeURIComponent(externalOf(resourceId))}`,
      );
      return d?.password ?? "";
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    return resource.resolvedOutputs[outputKey] ?? "";
  }

  // ── Create / update / delete ─────────────────────────────────────────

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    return buildCreateConfig(this, typeId);
  }

  machineBody(fields: Record<string, string>): Record<string, unknown> {
    const network = picked(fields["networkId"]);
    const script = picked(fields["startupScriptId"]);
    const autoShutdown = bool(fields["autoShutdownEnabled"]) ?? false;
    return {
      name: str(fields["name"]),
      region: str(fields["region"]),
      machineType: str(fields["machineType"]),
      templateId: str(fields["templateId"]),
      diskSize: num(fields["diskSize"]) ?? 100,
      publicIpType: str(fields["publicIpType"]) || "dynamic",
      startOnCreate: bool(fields["startOnCreate"]) ?? true,
      autoShutdownEnabled: autoShutdown,
      ...(autoShutdown ? { autoShutdownTimeout: num(fields["autoShutdownTimeout"]) ?? 8 } : {}),
      ...(network ? { networkId: network } : {}),
      ...(script ? { startupScriptId: script } : {}),
    };
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const name = str(fields["name"]);
    switch (typeId) {
      case "project":
        return mapProject(
          await this.api.request<PProject>("/projects", { method: "POST", body: { name } }),
          accountId,
        );
      case "machine": {
        const res = await this.api.request<{ data?: PMachine; event?: PMachineEvent }>(
          "/machines",
          {
            method: "POST",
            body: this.machineBody(fields),
          },
        );
        if (!res?.data) throw new Error("Paperspace plugin: machine create returned no machine");
        return mapMachine(res.data, accountId);
      }
      case "shared-drive": {
        const networkId = str(fields["networkId"]);
        const networks = await this.raw.networks().catch(() => [] as PNetwork[]);
        const region = networks.find((n) => n.id === networkId)?.region;
        if (!region) throw new Error("Paperspace plugin: choose a private network");
        return mapSharedDrive(
          await this.api.request<PSharedDrive>("/shared-drives", {
            method: "POST",
            body: { name, size: num(fields["size"]) ?? 100, region, networkId },
          }),
          accountId,
        );
      }
      case "snapshot":
      case "custom-template": {
        const res = await this.api.request<{
          data?: PSnapshot | POsTemplate;
          event?: PMachineEvent;
        }>(PATHS[typeId]!, { method: "POST", body: { name, machineId: str(fields["machineId"]) } });
        await this.awaitEvent(res?.event);
        if (!res?.data) throw new Error(`Paperspace plugin: ${typeId} create returned nothing`);
        return this.mapOne(typeId, res.data, accountId);
      }
      case "private-network":
        return mapNetwork(
          await this.api.request<PNetwork>("/private-networks", {
            method: "POST",
            body: {
              name,
              region: str(fields["region"]),
              migrateMachines: bool(fields["migrateMachines"]) ?? false,
            },
          }),
          accountId,
        );
      case "public-ip":
        return mapPublicIp(
          await this.api.request<PPublicIp>("/public-ips", {
            method: "POST",
            body: { region: str(fields["region"]) },
          }),
          accountId,
        );
      case "startup-script":
        return mapStartupScript(
          await this.api.request<PStartupScript>("/startup-scripts", {
            method: "POST",
            body: {
              name,
              script: fields["script"] ?? "",
              isRunOnce: bool(fields["runOnce"]) ?? false,
            },
          }),
          accountId,
        );
      case "container-registry":
        return mapRegistry(
          await this.api.request<PRegistry>("/container-registries", {
            method: "POST",
            body: {
              name,
              kind: str(fields["kind"]) || "other",
              url: str(fields["url"]),
              namespace: str(fields["namespace"]),
              username: str(fields["username"]),
              password: fields["password"] ?? "",
            },
          }),
          accountId,
        );
      default:
        throw new Error(`Paperspace plugin: cannot create "${typeId}"`);
    }
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = encodeURIComponent(externalOf(resourceId));
    const body: Record<string, unknown> = {};
    const has = (k: string) => fields[k] !== undefined;
    if (has("name")) body["name"] = str(fields["name"]);
    switch (typeId) {
      case "machine": {
        if (has("machineType") && str(fields["machineType"]))
          body["machineType"] = str(fields["machineType"]);
        if (has("publicIpType") && str(fields["publicIpType"]))
          body["publicIpType"] = str(fields["publicIpType"]);
        for (const k of ["autoShutdownEnabled", "autoShutdownForce", "autoSnapshotEnabled"]) {
          if (has(k)) body[k] = bool(fields[k]) ?? false;
        }
        for (const k of ["autoShutdownTimeout", "autoSnapshotSaveCount"]) {
          const v = num(fields[k]);
          if (v !== undefined && v > 0) body[k] = v;
        }
        if (has("autoSnapshotFrequency") && str(fields["autoSnapshotFrequency"])) {
          body["autoSnapshotFrequency"] = str(fields["autoSnapshotFrequency"]);
        }
        const res = await this.api.request<{ data?: PMachine; event?: PMachineEvent }>(
          `/machines/${id}`,
          {
            method: "PUT",
            body,
          },
        );
        await this.awaitEvent(res?.event);
        return this.getResource(typeId, resourceId, accountId);
      }
      case "startup-script":
        if (str(fields["script"])) body["script"] = fields["script"];
        if (has("enabled")) body["isEnabled"] = bool(fields["enabled"]) ?? true;
        if (has("runOnce")) body["isRunOnce"] = bool(fields["runOnce"]) ?? false;
        break;
      case "container-registry":
        for (const k of ["kind", "url", "namespace", "username"]) {
          if (has(k) && str(fields[k])) body[k] = str(fields[k]);
        }
        if (fields["password"]) body["password"] = fields["password"];
        break;
      case "project":
      case "shared-drive":
      case "snapshot":
      case "custom-template":
      case "private-network":
        break;
      default:
        throw new Error(`Paperspace plugin: cannot update "${typeId}"`);
    }
    if (Object.keys(body).length === 0) return this.getResource(typeId, resourceId, accountId);
    return this.mapOne(
      typeId,
      await this.api.request<unknown>(`${PATHS[typeId]}/${id}`, { method: "PUT", body }),
      accountId,
    );
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const path = PATHS[typeId];
    if (!path) throw new Error(`Paperspace plugin: cannot delete "${typeId}"`);
    await this.api.request(`${path}/${encodeURIComponent(externalOf(resourceId))}`, {
      method: "DELETE",
    });
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    const raw = externalOf(resourceId);
    const id = encodeURIComponent(raw);
    switch (`${typeId}:${actionId}`) {
      case "machine:start":
      case "machine:stop":
      case "machine:restart":
        await this.api.request(`/machines/${id}/${actionId}`, { method: "PATCH" });
        return;
      case "machine:snapshot": {
        const m = await this.getResource("machine", resourceId, accountId);
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
        await this.api.request("/snapshots", {
          method: "POST",
          body: { name: `${String(m.fields["name"] || raw)}-${stamp}`, machineId: raw },
        });
        return;
      }
      case "snapshot:restore":
        await this.api.request(`/snapshots/${id}/restore`, {
          method: "POST",
          body: { createSnapshotBeforeRestore: true },
        });
        return;
      case "startup-script:unassign-all": {
        const s = await this.api.request<PStartupScript>(`/startup-scripts/${id}`);
        for (const machineId of s?.assignedMachineIds ?? []) {
          await this.api.request(`/startup-scripts/${id}/unassign`, {
            method: "POST",
            body: { machineId },
          });
        }
        return;
      }
      case "container-registry:test-connection": {
        const res = await this.api.request<{ success?: boolean; error?: string }>(
          `/container-registries/${id}/test-connection`,
        );
        if (!res?.success) {
          throw new Error(
            `Paperspace could not reach the registry: ${res?.error ?? "unknown error"}`,
          );
        }
        return;
      }
      default:
        throw new Error(`Paperspace plugin: action "${actionId}" is not supported for "${typeId}"`);
    }
  }

  async attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    _accountId: string,
  ): Promise<void> {
    if (targetTypeId !== "machine") {
      throw new Error(`Paperspace plugin: cannot attach ${sourceTypeId} to ${targetTypeId}`);
    }
    const machineId = externalOf(targetResourceId);
    const source = encodeURIComponent(externalOf(sourceResourceId));
    if (sourceTypeId === "public-ip") {
      await this.api.request(`/public-ips/${source}`, { method: "PUT", body: { machineId } });
      return;
    }
    if (sourceTypeId === "startup-script") {
      await this.api.request(`/startup-scripts/${source}/assign`, {
        method: "POST",
        body: { machineId },
      });
      return;
    }
    throw new Error(`Paperspace plugin: cannot attach ${sourceTypeId} to ${targetTypeId}`);
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== "deployment") return [];
    return fetchDeploymentMetrics(this.api, externalOf(resourceId), timeRange);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderPaperspaceDetail(resource, this.resourceTypes);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderPaperspaceSidebarItem(resource);
  }
}
