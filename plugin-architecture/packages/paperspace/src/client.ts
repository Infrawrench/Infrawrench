import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
import { pathEncode, type ApiBody } from "@infrawrench/plugin-base";
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
import { createPaperspaceApi, listAll, type ListReadOptions, type PaperspaceApi } from "./api.js";
import type { operations } from "./api-types.gen.js";
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
import type { PMachineEvent } from "./types.js";

const EVENT_POLL_MS = 2_000;
const EVENT_TIMEOUT_MS = 90_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function str(v: string | undefined): string {
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

/**
 * Paperspace plugin client. One per account (API key); keys are team-scoped,
 * so every listing is the team's.
 */
export class PaperspaceClient implements PluginClient {
  readonly api: PaperspaceApi;
  private readonly resourceTypes: ResourceTypeDefinition[];

  constructor(
    credentials: Credentials,
    resourceTypes: ResourceTypeDefinition[],
    services?: HostServices,
  ) {
    const apiKey = str(credentials["apiKey"]);
    if (!apiKey) throw new Error("Paperspace plugin: missing apiKey credential");
    this.api = createPaperspaceApi(apiKey, credentials["caCert"] ?? "", services);
    this.resourceTypes = resourceTypes;
  }

  readonly raw = {
    projects: (options?: ListReadOptions) =>
      listAll("/projects", (query) => this.api.get("/projects", { query }), options),
    machines: (options?: ListReadOptions) =>
      listAll("/machines", (query) => this.api.get("/machines", { query }), options),
    sharedDrives: (options?: ListReadOptions) =>
      listAll("/shared-drives", (query) => this.api.get("/shared-drives", { query }), options),
    snapshots: (options?: ListReadOptions) =>
      listAll("/snapshots", (query) => this.api.get("/snapshots", { query }), options),
    customTemplates: (options?: ListReadOptions) =>
      listAll(
        "/custom-templates",
        (query) => this.api.get("/custom-templates", { query }),
        options,
      ),
    osTemplates: (options?: ListReadOptions) =>
      listAll("/os-templates", (query) => this.api.get("/os-templates", { query }), options),
    networks: (options?: ListReadOptions) =>
      listAll(
        "/private-networks",
        (query) => this.api.get("/private-networks", { query }),
        options,
      ),
    publicIps: (options?: ListReadOptions) =>
      listAll("/public-ips", (query) => this.api.get("/public-ips", { query }), options),
    startupScripts: (options?: ListReadOptions) =>
      listAll("/startup-scripts", (query) => this.api.get("/startup-scripts", { query }), options),
    deployments: (options?: ListReadOptions) =>
      listAll("/deployments", (query) => this.api.get("/deployments", { query }), options),
    registries: (options?: ListReadOptions) =>
      listAll(
        "/container-registries",
        (query) => this.api.get("/container-registries", { query }),
        options,
      ),
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
      current = await this.api.get(`/machine-events/${pathEncode(event.id)}`);
    }
    if (current.state === "error") {
      throw new Error(
        `Paperspace ${current.name ?? "operation"} failed: ${current.error ?? "no reason given"}`,
      );
    }
  }

  // ── Listing ──────────────────────────────────────────────────────────

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
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
    });
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const raw = externalOf(resourceId);
      const id = pathEncode(raw);
      switch (typeId) {
        case "project":
          return mapProject(await this.api.get(`/projects/${id}`), accountId);
        case "machine":
          return mapMachine(await this.api.get(`/machines/${id}`), accountId);
        case "shared-drive":
          return mapSharedDrive(await this.api.get(`/shared-drives/${id}`), accountId);
        case "snapshot":
          return mapSnapshot(await this.api.get(`/snapshots/${id}`), accountId);
        case "custom-template":
          return mapCustomTemplate(await this.api.get(`/custom-templates/${id}`), accountId);
        case "private-network":
          return mapNetwork(await this.api.get(`/private-networks/${id}`), accountId);
        case "public-ip": {
          const found = (await this.raw.publicIps()).find((p) => p.ip === raw);
          if (!found) {
            throw Object.assign(new Error(`Paperspace plugin: public IP ${raw} not found`), {
              status: 404,
            });
          }
          return mapPublicIp(found, accountId);
        }
        case "startup-script":
          return mapStartupScript(await this.api.get(`/startup-scripts/${id}`), accountId);
        case "deployment":
          return mapDeployment(await this.api.get(`/deployments/${id}`), accountId);
        case "container-registry":
          return mapRegistry(await this.api.get(`/container-registries/${id}`), accountId);
        default:
          throw new Error(`Paperspace plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      if (typeId === "shared-drive" && outputKey === "password") {
        const d = await this.api.get(`/shared-drives/${pathEncode(externalOf(resourceId))}`);
        return d?.password ?? "";
      }
      const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      return resource.resolvedOutputs[outputKey] ?? "";
    });
  }

  // ── Create / update / delete ─────────────────────────────────────────

  getCreateConfig(typeId: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      return buildCreateConfig(this, typeId);
    });
  }

  machineBody(fields: Record<string, string>): ApiBody<operations["machines-create"]> {
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

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const name = str(fields["name"]);
      switch (typeId) {
        case "project":
          return mapProject(await this.api.post("/projects", { body: { name } }), accountId);
        case "machine": {
          const res = await this.api.post("/machines", { body: this.machineBody(fields) });
          if (!res?.data) throw new Error("Paperspace plugin: machine create returned no machine");
          return mapMachine(res.data, accountId);
        }
        case "shared-drive": {
          const networkId = str(fields["networkId"]);
          const networks = await this.raw.networks().catch(() => []);
          const region = networks.find((n) => n.id === networkId)?.region;
          if (!region) throw new Error("Paperspace plugin: choose a private network");
          return mapSharedDrive(
            await this.api.post("/shared-drives", {
              body: { name, size: num(fields["size"]) ?? 100, region, networkId },
            }),
            accountId,
          );
        }
        case "snapshot": {
          const res = await this.api.post("/snapshots", {
            body: { name, machineId: str(fields["machineId"]) },
          });
          await this.awaitEvent(res?.event);
          if (!res?.data) throw new Error(`Paperspace plugin: ${typeId} create returned nothing`);
          return mapSnapshot(res.data, accountId, res.event?.dtCreated);
        }
        case "custom-template": {
          const res = await this.api.post("/custom-templates", {
            body: { name, machineId: str(fields["machineId"]) },
          });
          await this.awaitEvent(res?.event);
          if (!res?.data) throw new Error(`Paperspace plugin: ${typeId} create returned nothing`);
          return mapCustomTemplate(res.data, accountId);
        }
        case "private-network":
          return mapNetwork(
            await this.api.post("/private-networks", {
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
            await this.api.post("/public-ips", { body: { region: str(fields["region"]) } }),
            accountId,
          );
        case "startup-script":
          return mapStartupScript(
            await this.api.post("/startup-scripts", {
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
            await this.api.post("/container-registries", {
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
    });
  }

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = pathEncode(externalOf(resourceId));
      const has = (k: string) => fields[k] !== undefined;
      const reread = () => runPluginEffect(this.getResource(typeId, resourceId, accountId));
      // Sent whenever the form holds the field, even empty.
      const renamed = has("name") ? { name: str(fields["name"]) } : undefined;
      switch (typeId) {
        case "machine": {
          const body: ApiBody<operations["machines-update"]> = { ...renamed };
          if (has("machineType") && str(fields["machineType"]))
            body.machineType = str(fields["machineType"]);
          if (has("publicIpType") && str(fields["publicIpType"]))
            body.publicIpType = str(fields["publicIpType"]);
          for (const k of [
            "autoShutdownEnabled",
            "autoShutdownForce",
            "autoSnapshotEnabled",
          ] as const) {
            if (has(k)) body[k] = bool(fields[k]) ?? false;
          }
          for (const k of ["autoShutdownTimeout", "autoSnapshotSaveCount"] as const) {
            const v = num(fields[k]);
            if (v !== undefined && v > 0) body[k] = v;
          }
          if (has("autoSnapshotFrequency") && str(fields["autoSnapshotFrequency"])) {
            body.autoSnapshotFrequency = str(fields["autoSnapshotFrequency"]);
          }
          const res = await this.api.put(`/machines/${id}`, { body });
          await this.awaitEvent(res?.event);
          return reread();
        }
        case "startup-script": {
          const body: ApiBody<operations["startupScripts-update"]> = { ...renamed };
          if (str(fields["script"])) body.script = fields["script"];
          if (has("enabled")) body.isEnabled = bool(fields["enabled"]) ?? true;
          if (has("runOnce")) body.isRunOnce = bool(fields["runOnce"]) ?? false;
          if (Object.keys(body).length === 0) return reread();
          return mapStartupScript(
            await this.api.put(`/startup-scripts/${id}`, { body }),
            accountId,
          );
        }
        case "container-registry": {
          const body: ApiBody<operations["containerRegistries-update"]> = { ...renamed };
          for (const k of ["kind", "url", "namespace", "username"] as const) {
            if (has(k) && str(fields[k])) body[k] = str(fields[k]);
          }
          if (fields["password"]) body.password = fields["password"];
          if (Object.keys(body).length === 0) return reread();
          return mapRegistry(
            await this.api.put(`/container-registries/${id}`, { body }),
            accountId,
          );
        }
        case "project":
          if (!renamed) return reread();
          return mapProject(await this.api.put(`/projects/${id}`, { body: renamed }), accountId);
        case "shared-drive":
          if (!renamed) return reread();
          return mapSharedDrive(
            await this.api.put(`/shared-drives/${id}`, { body: renamed }),
            accountId,
          );
        case "snapshot":
          if (!renamed) return reread();
          return mapSnapshot(await this.api.put(`/snapshots/${id}`, { body: renamed }), accountId);
        case "custom-template":
          if (!renamed) return reread();
          return mapCustomTemplate(
            await this.api.put(`/custom-templates/${id}`, { body: renamed }),
            accountId,
          );
        case "private-network":
          if (!renamed) return reread();
          return mapNetwork(
            await this.api.put(`/private-networks/${id}`, { body: renamed }),
            accountId,
          );
        default:
          throw new Error(`Paperspace plugin: cannot update "${typeId}"`);
      }
    });
  }

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = pathEncode(externalOf(resourceId));
      switch (typeId) {
        case "project":
          await this.api.delete(`/projects/${id}`);
          return;
        case "machine":
          await this.api.delete(`/machines/${id}`);
          return;
        case "shared-drive":
          await this.api.delete(`/shared-drives/${id}`);
          return;
        case "snapshot":
          await this.api.delete(`/snapshots/${id}`);
          return;
        case "custom-template":
          await this.api.delete(`/custom-templates/${id}`);
          return;
        case "private-network":
          await this.api.delete(`/private-networks/${id}`);
          return;
        case "public-ip":
          await this.api.delete(`/public-ips/${id}`);
          return;
        case "startup-script":
          await this.api.delete(`/startup-scripts/${id}`);
          return;
        case "deployment":
          await this.api.delete(`/deployments/${id}`);
          return;
        case "container-registry":
          await this.api.delete(`/container-registries/${id}`);
          return;
        default:
          throw new Error(`Paperspace plugin: cannot delete "${typeId}"`);
      }
    });
  }

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const raw = externalOf(resourceId);
      const id = pathEncode(raw);
      switch (`${typeId}:${actionId}`) {
        case "machine:start":
          await this.api.patch(`/machines/${id}/start`);
          return;
        case "machine:stop":
          await this.api.patch(`/machines/${id}/stop`);
          return;
        case "machine:restart":
          await this.api.patch(`/machines/${id}/restart`);
          return;
        case "machine:snapshot": {
          const m = await runPluginEffect(this.getResource("machine", resourceId, accountId));
          const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
          await this.api.post("/snapshots", {
            body: { name: `${String(m.fields["name"] || raw)}-${stamp}`, machineId: raw },
          });
          return;
        }
        case "snapshot:restore":
          await this.api.post(`/snapshots/${id}/restore`, {
            body: { createSnapshotBeforeRestore: true },
          });
          return;
        case "startup-script:unassign-all": {
          const s = await this.api.get(`/startup-scripts/${id}`);
          for (const machineId of s?.assignedMachineIds ?? []) {
            await this.api.post(`/startup-scripts/${id}/unassign`, { body: { machineId } });
          }
          return;
        }
        case "container-registry:test-connection": {
          const res = await this.api.get(`/container-registries/${id}/test-connection`);
          if (!res?.success) {
            throw new Error(
              `Paperspace could not reach the registry: ${res?.error ?? "unknown error"}`,
            );
          }
          return;
        }
        default:
          throw new Error(
            `Paperspace plugin: action "${actionId}" is not supported for "${typeId}"`,
          );
      }
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
      if (targetTypeId !== "machine") {
        throw new Error(`Paperspace plugin: cannot attach ${sourceTypeId} to ${targetTypeId}`);
      }
      const machineId = externalOf(targetResourceId);
      const source = pathEncode(externalOf(sourceResourceId));
      if (sourceTypeId === "public-ip") {
        await this.api.put(`/public-ips/${source}`, { body: { machineId } });
        return;
      }
      if (sourceTypeId === "startup-script") {
        await this.api.post(`/startup-scripts/${source}/assign`, { body: { machineId } });
        return;
      }
      throw new Error(`Paperspace plugin: cannot attach ${sourceTypeId} to ${targetTypeId}`);
    });
  }

  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      if (resourceTypeId !== "deployment") return [];
      return fetchDeploymentMetrics(this.api, externalOf(resourceId), timeRange);
    });
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderPaperspaceDetail(resource, this.resourceTypes);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderPaperspaceSidebarItem(resource);
  }
}
