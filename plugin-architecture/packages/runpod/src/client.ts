import type {
  CommitmentRecord,
  CostEstimate,
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  CreditBalance,
  DetailViewSchema,
  HostServices,
  PluginClient,
  QuotaUsage,
  ResourceInstance,
  ResourceTypeDefinition,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { buildCostEstimate, CreditAccessError, QuotaAccessError } from "@infrawrench/plugin-base";
import { isStatus, RunpodApi } from "./api.js";
import { fetchRunpodCostData } from "./cost-data.js";
import { ANY, buildCreateConfig, NONE } from "./create-config.js";
import {
  externalOf,
  mapEndpoint,
  mapNetworkVolume,
  mapPod,
  mapRegistryAuth,
  mapSshKey,
  mapTemplate,
  splitList,
  volumeUsers,
} from "./mappers.js";
import { renderRunpodDetail, renderRunpodSidebarItem } from "./render.js";
import { fingerprintId, joinSshKeys, parseSshKeys, sshFingerprint } from "./ssh-keys.js";
import type {
  RpDataCenter,
  RpEndpoint,
  RpEndpointHealth,
  RpGpuType,
  RpMyself,
  RpNetworkVolume,
  RpPod,
  RpPodExtras,
  RpRegistryAuth,
  RpTemplate,
} from "./types.js";

const CACHE_TTL_MS = 60_000;
const HOURS_PER_MONTH = 730;

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v).trim();
}

function int(v: string | undefined, fallback?: number): number | undefined {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function picked(v: string | undefined): string {
  const s = str(v);
  return s === NONE || s === ANY ? "" : s;
}

/** `KEY=value` lines → object. Blank lines and `#` comments are skipped. */
export function parseEnv(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return out;
}

/**
 * The console's single "start command" string → Runpod's `dockerStartCmd`
 * array. Plain words split on whitespace; anything with quoting or shell
 * syntax runs through `bash -c` so it means what it says.
 */
export function startCommandArgs(cmd: string): string[] {
  const s = cmd.trim();
  if (!s) return [];
  if (/["'`$|&;<>(){}\\*?]/.test(s)) return ["bash", "-c", s];
  return s.split(/\s+/);
}

const PODS_EXTRAS_QUERY = `query RunpodPodExtras {
  myself {
    pods {
      id
      createdAt
      machine { podHostId dataCenterId secureCloud }
      runtime {
        uptimeInSeconds
        container { cpuPercent memoryPercent }
        gpus { id gpuUtilPercent memoryUtilPercent }
      }
    }
  }
}`;

const ACCOUNT_QUERY = `query RunpodAccount {
  myself {
    id
    clientBalance
    currentSpendPerHr
    spendLimit
    maxServerlessConcurrency
    underBalance
  }
}`;

const SAVINGS_PLANS_QUERY = `query RunpodSavingsPlans {
  myself {
    savingsPlans { id costPerHr upfrontCost startTime endTime gpuTypeId podId planLength savingsPlanType }
  }
}`;

const GPU_TYPES_QUERY = `query RunpodGpuTypes {
  gpuTypes {
    id displayName memoryInGb manufacturer secureCloud communityCloud
    securePrice communityPrice secureSpotPrice communitySpotPrice maxGpuCount
    lowestPrice(input: { gpuCount: 1 }) { stockStatus uninterruptablePrice minimumBidPrice }
  }
}`;

const DATA_CENTERS_QUERY = `query RunpodDataCenters {
  dataCenters { id name location storageSupport listed gpuAvailability { gpuTypeId available stockStatus } }
}`;

const PUBKEY_QUERY = `query RunpodPubKey { myself { id pubKey } }`;

const UPDATE_PUBKEY = `mutation RunpodUpdatePubKey($input: UpdateUserSettingsInput) {
  updateUserSettings(input: $input) { id }
}`;

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

/**
 * Runpod plugin client. One per account (API key). A Runpod key belongs to a
 * user (or a team, when created in a team context), so every listing is
 * account-wide; there is no project level.
 */
export class RunpodClient implements PluginClient {
  readonly api: RunpodApi;
  private readonly resourceTypes: ResourceTypeDefinition[];
  private gpuCache: Cached<RpGpuType[]> | undefined;
  private dcCache: Cached<RpDataCenter[]> | undefined;

  constructor(
    credentials: Record<string, string>,
    resourceTypes: ResourceTypeDefinition[],
    services?: HostServices,
  ) {
    const apiKey = str(credentials["apiKey"]);
    if (!apiKey) throw new Error("Runpod plugin: missing apiKey credential");
    this.api = new RunpodApi(apiKey, credentials["caCert"] ?? "", services);
    this.resourceTypes = resourceTypes;
  }

  // ── Raw listings ─────────────────────────────────────────────────────

  readonly listRaw = {
    pods: () =>
      this.api.rest<RpPod[]>("/pods", {
        query: { includeMachine: true, includeNetworkVolume: true },
      }),
    endpoints: () =>
      this.api.rest<RpEndpoint[]>("/endpoints", { query: { includeTemplate: true } }),
    templates: () => this.api.rest<RpTemplate[]>("/templates"),
    networkVolumes: () => this.api.rest<RpNetworkVolume[]>("/networkvolumes"),
    registryAuths: () => this.api.rest<RpRegistryAuth[]>("/containerregistryauth"),
  };

  /** Own templates plus Runpod's official ones, for the pod create form. */
  async templatesForPicker(): Promise<RpTemplate[]> {
    const all = await this.api.rest<RpTemplate[]>("/templates", {
      query: { includeRunpodTemplates: true },
    });
    return [...(all ?? [])].sort(
      (a, b) => Number(a.isRunpod ?? false) - Number(b.isRunpod ?? false),
    );
  }

  private cached<T>(slot: "gpu" | "dc", load: () => Promise<T>): Promise<T> {
    const current = (slot === "gpu" ? this.gpuCache : this.dcCache) as Cached<T> | undefined;
    if (current && Date.now() - current.at < CACHE_TTL_MS) return current.value;
    const value = load();
    const entry = { at: Date.now(), value } as Cached<unknown>;
    value.catch(() => {
      if (slot === "gpu") this.gpuCache = undefined;
      else this.dcCache = undefined;
    });
    if (slot === "gpu") this.gpuCache = entry as Cached<RpGpuType[]>;
    else this.dcCache = entry as Cached<RpDataCenter[]>;
    return value;
  }

  gpuTypes(): Promise<RpGpuType[]> {
    return this.cached("gpu", async () => {
      const res = await this.api.graphql<{ gpuTypes?: RpGpuType[] }>(GPU_TYPES_QUERY);
      return (res?.gpuTypes ?? []).filter((g) => g.id && (g.secureCloud || g.communityCloud));
    });
  }

  dataCenters(): Promise<RpDataCenter[]> {
    return this.cached("dc", async () => {
      const res = await this.api.graphql<{ dataCenters?: RpDataCenter[] }>(DATA_CENTERS_QUERY);
      return res?.dataCenters ?? [];
    });
  }

  /** Runtime telemetry and SSH proxy ids; best effort (a REST-only key still lists pods). */
  private async podExtras(): Promise<Map<string, RpPodExtras> | undefined> {
    try {
      const res = await this.api.graphql<{ myself?: { pods?: RpPodExtras[] } | null }>(
        PODS_EXTRAS_QUERY,
      );
      return new Map((res?.myself?.pods ?? []).map((p) => [p.id, p]));
    } catch {
      return undefined;
    }
  }

  private async endpointHealth(id: string): Promise<RpEndpointHealth | undefined> {
    try {
      return await this.api.serverless<RpEndpointHealth>(id, "health");
    } catch {
      return undefined;
    }
  }

  // ── Listing ──────────────────────────────────────────────────────────

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "pod": {
        const [pods, extras] = await Promise.all([this.listRaw.pods(), this.podExtras()]);
        return (pods ?? []).map((p) => mapPod(p, accountId, extras?.get(p.id)));
      }
      case "serverless-endpoint": {
        const endpoints = (await this.listRaw.endpoints()) ?? [];
        const health = await Promise.all(endpoints.map((e) => this.endpointHealth(e.id)));
        return endpoints.map((e, i) => mapEndpoint(e, accountId, health[i]));
      }
      case "template":
        return ((await this.listRaw.templates()) ?? [])
          .filter((t) => !t.isRunpod)
          .map((t) => mapTemplate(t, accountId));
      case "network-volume": {
        const [volumes, pods, endpoints] = await Promise.all([
          this.listRaw.networkVolumes(),
          this.listRaw.pods().catch(() => [] as RpPod[]),
          this.listRaw.endpoints().catch(() => [] as RpEndpoint[]),
        ]);
        const users = volumeUsers(pods ?? [], endpoints ?? []);
        return (volumes ?? []).map((v) => mapNetworkVolume(v, accountId, users));
      }
      case "container-registry-auth":
        return ((await this.listRaw.registryAuths()) ?? []).map((a) =>
          mapRegistryAuth(a, accountId),
        );
      case "ssh-key":
        return this.listSshKeys(accountId);
      default:
        throw new Error(`Runpod plugin: unknown resource type "${typeId}"`);
    }
  }

  private async readPubKey(): Promise<string> {
    const res = await this.api.graphql<{ myself?: { pubKey?: string | null } | null }>(
      PUBKEY_QUERY,
    );
    return res?.myself?.pubKey ?? "";
  }

  private async writePubKey(lines: string[]): Promise<void> {
    await this.api.graphql(UPDATE_PUBKEY, { input: { pubKey: joinSshKeys(lines) } });
  }

  private async listSshKeys(accountId: string): Promise<ResourceInstance[]> {
    const keys = parseSshKeys(await this.readPubKey());
    const seen = new Set<string>();
    const out: ResourceInstance[] = [];
    for (const k of keys) {
      const fp = await sshFingerprint(k.blob);
      const id = fingerprintId(fp);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(mapSshKey(k, fp, id, accountId));
    }
    return out;
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalOf(resourceId);
    switch (typeId) {
      case "pod": {
        const [pod, extras] = await Promise.all([
          this.api.rest<RpPod>(`/pods/${encodeURIComponent(id)}`, {
            query: { includeMachine: true, includeNetworkVolume: true },
          }),
          this.podExtras(),
        ]);
        return mapPod(pod, accountId, extras?.get(id));
      }
      case "serverless-endpoint": {
        const [endpoint, health] = await Promise.all([
          this.api.rest<RpEndpoint>(`/endpoints/${encodeURIComponent(id)}`, {
            query: { includeTemplate: true },
          }),
          this.endpointHealth(id),
        ]);
        return mapEndpoint(endpoint, accountId, health);
      }
      case "template":
        return mapTemplate(
          await this.api.rest<RpTemplate>(`/templates/${encodeURIComponent(id)}`),
          accountId,
        );
      default: {
        const all = await this.listResources(typeId, accountId);
        const found = all.find((r) => r.id === resourceId || r.externalId === id);
        if (!found) {
          const err = new Error(`Runpod plugin: resource ${typeId}/${id} not found`);
          (err as Error & { status: number }).status = 404;
          throw err;
        }
        return found;
      }
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    return resource.resolvedOutputs[outputKey] ?? "";
  }

  // ── Create / update / delete ─────────────────────────────────────────

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    return buildCreateConfig(this, typeId);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const name = str(fields["name"]);
    switch (typeId) {
      case "pod": {
        const body = this.podCreateBody(fields);
        const pod = await this.api.rest<RpPod>("/pods", { method: "POST", body });
        return mapPod(pod, accountId, undefined);
      }
      case "serverless-endpoint": {
        const cpu = str(fields["computeType"]) === "CPU";
        const dc = picked(fields["dataCenterId"]);
        const volume = picked(fields["networkVolumeId"]);
        const gpu = str(fields["gpuTypeId"]);
        const body: Record<string, unknown> = {
          name,
          templateId: str(fields["templateId"]),
          computeType: cpu ? "CPU" : "GPU",
          workersMin: int(fields["workersMin"], 0),
          workersMax: int(fields["workersMax"], 3),
          idleTimeout: int(fields["idleTimeout"], 5),
          flashboot: str(fields["flashboot"]) !== "false",
          ...(dc ? { dataCenterIds: [dc] } : {}),
          ...(volume ? { networkVolumeId: volume } : {}),
        };
        if (cpu) {
          body["cpuFlavorIds"] = [str(fields["cpuFlavorId"]) || "cpu3c"];
          body["vcpuCount"] = int(fields["vcpuCount"], 2);
        } else {
          if (gpu) body["gpuTypeIds"] = [gpu];
          body["gpuCount"] = int(fields["gpuCount"], 1);
        }
        if (!body["templateId"]) throw new Error("Runpod plugin: choose a Serverless template");
        const endpoint = await this.api.rest<RpEndpoint>("/endpoints", { method: "POST", body });
        return mapEndpoint(endpoint, accountId, undefined);
      }
      case "template": {
        const auth = picked(fields["containerRegistryAuthId"]);
        const start = startCommandArgs(str(fields["startCommand"]));
        const env = parseEnv(fields["env"]);
        const template = await this.api.rest<RpTemplate>("/templates", {
          method: "POST",
          body: {
            name,
            imageName: str(fields["imageName"]),
            isServerless: str(fields["isServerless"]) === "true",
            category: str(fields["category"]) || "NVIDIA",
            containerDiskInGb: int(fields["containerDiskInGb"], 50),
            volumeInGb: int(fields["volumeInGb"], 20),
            volumeMountPath: str(fields["volumeMountPath"]) || "/workspace",
            ports: splitList(fields["ports"]),
            ...(start.length ? { dockerStartCmd: start } : {}),
            ...(Object.keys(env).length ? { env } : {}),
            ...(auth ? { containerRegistryAuthId: auth } : {}),
            ...(str(fields["readme"]) ? { readme: fields["readme"] } : {}),
          },
        });
        return mapTemplate(template, accountId);
      }
      case "network-volume": {
        const volume = await this.api.rest<RpNetworkVolume>("/networkvolumes", {
          method: "POST",
          body: {
            name,
            dataCenterId: str(fields["dataCenterId"]),
            size: int(fields["size"], 50),
          },
        });
        return mapNetworkVolume(volume, accountId, new Map());
      }
      case "container-registry-auth": {
        const auth = await this.api.rest<RpRegistryAuth>("/containerregistryauth", {
          method: "POST",
          body: {
            name,
            username: str(fields["username"]),
            password: fields["password"] ?? "",
          },
        });
        return mapRegistryAuth(auth, accountId);
      }
      case "ssh-key": {
        const parsed = parseSshKeys(str(fields["publicKey"]))[0];
        if (!parsed) throw new Error("Runpod plugin: that is not an OpenSSH public key");
        const line =
          parsed.comment || !name ? parsed.line : `${parsed.type} ${parsed.blob} ${name}`;
        const existing = parseSshKeys(await this.readPubKey());
        const fp = await sshFingerprint(parsed.blob);
        const fps = await Promise.all(existing.map((k) => sshFingerprint(k.blob)));
        if (!fps.includes(fp)) await this.writePubKey([...existing.map((k) => k.line), line]);
        return mapSshKey(
          { ...parsed, line, comment: line.split(/\s+/).slice(2).join(" ") },
          fp,
          fingerprintId(fp),
          accountId,
        );
      }
      default:
        throw new Error(`Runpod plugin: cannot create "${typeId}"`);
    }
  }

  podCreateBody(fields: Record<string, string>): Record<string, unknown> {
    const cpu = str(fields["computeType"]) === "CPU";
    const template = picked(fields["templateId"]);
    const image = str(fields["imageName"]);
    if (!template && !image) {
      throw new Error("Runpod plugin: choose a template or enter a container image");
    }
    const dc = picked(fields["dataCenterId"]);
    const volume = picked(fields["networkVolumeId"]);
    const auth = picked(fields["containerRegistryAuthId"]);
    const env = parseEnv(fields["env"]);
    const sshKey = str(fields["sshPublicKey"]);
    if (sshKey && !env["PUBLIC_KEY"]) env["PUBLIC_KEY"] = sshKey;
    const body: Record<string, unknown> = {
      name: str(fields["name"]) || "my pod",
      computeType: cpu ? "CPU" : "GPU",
      cloudType: str(fields["cloudType"]) === "COMMUNITY" ? "COMMUNITY" : "SECURE",
      interruptible: str(fields["pricing"]) === "spot",
      containerDiskInGb: int(fields["containerDiskInGb"], 50),
      volumeInGb: int(fields["volumeInGb"], 20),
      volumeMountPath: str(fields["volumeMountPath"]) || "/workspace",
      ...(image ? { imageName: image } : {}),
      ...(template ? { templateId: template } : {}),
      ...(dc ? { dataCenterIds: [dc], dataCenterPriority: "custom" } : {}),
      ...(volume ? { networkVolumeId: volume } : {}),
      ...(auth ? { containerRegistryAuthId: auth } : {}),
      ...(Object.keys(env).length ? { env } : {}),
    };
    const ports = splitList(fields["ports"]);
    if (ports.length) body["ports"] = ports;
    if (cpu) {
      body["cpuFlavorIds"] = [str(fields["cpuFlavorId"]) || "cpu3c"];
      body["vcpuCount"] = int(fields["vcpuCount"], 2);
    } else {
      const gpu = str(fields["gpuTypeId"]);
      if (!gpu) throw new Error("Runpod plugin: choose a GPU type");
      body["gpuTypeIds"] = [gpu];
      body["gpuCount"] = int(fields["gpuCount"], 1);
    }
    return body;
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
    switch (typeId) {
      case "pod":
        if (has("name")) body["name"] = str(fields["name"]);
        if (has("imageName")) body["imageName"] = str(fields["imageName"]);
        if (has("containerDiskGb")) body["containerDiskInGb"] = int(fields["containerDiskGb"]);
        if (has("volumeGb")) body["volumeInGb"] = int(fields["volumeGb"]);
        if (has("volumeMountPath")) body["volumeMountPath"] = str(fields["volumeMountPath"]);
        if (has("ports")) body["ports"] = splitList(fields["ports"]);
        if (has("locked")) body["locked"] = fields["locked"] === "true";
        if (Object.keys(body).length) {
          await this.api.rest(`/pods/${id}`, { method: "PATCH", body });
        }
        return this.getResource(typeId, resourceId, accountId);
      case "serverless-endpoint":
        if (has("name")) body["name"] = str(fields["name"]);
        for (const k of [
          "workersMin",
          "workersMax",
          "idleTimeout",
          "scalerValue",
          "executionTimeoutMs",
        ]) {
          if (has(k)) body[k] = int(fields[k]);
        }
        if (has("scalerType") && str(fields["scalerType"])) {
          body["scalerType"] = str(fields["scalerType"]);
        }
        if (has("flashboot")) body["flashboot"] = fields["flashboot"] === "true";
        if (Object.keys(body).length) {
          await this.api.rest(`/endpoints/${id}`, { method: "PATCH", body });
        }
        return this.getResource(typeId, resourceId, accountId);
      case "template":
        if (has("name")) body["name"] = str(fields["name"]);
        if (has("imageName")) body["imageName"] = str(fields["imageName"]);
        if (has("containerDiskGb")) body["containerDiskInGb"] = int(fields["containerDiskGb"]);
        if (has("volumeGb")) body["volumeInGb"] = int(fields["volumeGb"]);
        if (has("volumeMountPath")) body["volumeMountPath"] = str(fields["volumeMountPath"]);
        if (has("ports")) body["ports"] = splitList(fields["ports"]);
        if (has("startCommand"))
          body["dockerStartCmd"] = startCommandArgs(str(fields["startCommand"]));
        if (has("isPublic")) body["isPublic"] = fields["isPublic"] === "true";
        if (has("readme")) body["readme"] = fields["readme"] ?? "";
        if (Object.keys(body).length) {
          await this.api.rest(`/templates/${id}`, { method: "PATCH", body });
        }
        return this.getResource(typeId, resourceId, accountId);
      case "network-volume": {
        if (has("name")) body["name"] = str(fields["name"]);
        if (has("sizeGb")) {
          const current = await this.getResource(typeId, resourceId, accountId);
          const size = int(fields["sizeGb"]);
          const now = Number(current.fields["sizeGb"] ?? 0);
          if (size !== undefined && size < now) {
            throw new Error("Runpod plugin: a network volume can only grow, never shrink");
          }
          if (size !== undefined && size !== now) body["size"] = size;
        }
        if (Object.keys(body).length) {
          await this.api.rest(`/networkvolumes/${id}`, { method: "PATCH", body });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      default:
        throw new Error(`Runpod plugin: cannot update "${typeId}"`);
    }
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const raw = externalOf(resourceId);
    const id = encodeURIComponent(raw);
    switch (typeId) {
      case "pod":
        await this.api.rest(`/pods/${id}`, { method: "DELETE" });
        return;
      case "serverless-endpoint":
        await this.api.rest(`/endpoints/${id}`, { method: "DELETE" });
        return;
      case "template":
        await this.api.rest(`/templates/${id}`, { method: "DELETE" });
        return;
      case "network-volume":
        await this.api.rest(`/networkvolumes/${id}`, { method: "DELETE" });
        return;
      case "container-registry-auth":
        await this.api.rest(`/containerregistryauth/${id}`, { method: "DELETE" });
        return;
      case "ssh-key": {
        const keys = parseSshKeys(await this.readPubKey());
        const fps = await Promise.all(keys.map((k) => sshFingerprint(k.blob)));
        const keep = keys.filter((_, i) => fingerprintId(fps[i]!) !== raw).map((k) => k.line);
        if (keep.length !== keys.length) await this.writePubKey(keep);
        return;
      }
      default:
        throw new Error(`Runpod plugin: cannot delete "${typeId}"`);
    }
  }

  // ── Actions ──────────────────────────────────────────────────────────

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const id = encodeURIComponent(externalOf(resourceId));
    if (typeId === "pod") {
      if (["start", "stop", "restart", "reset"].includes(actionId)) {
        await this.api.rest(`/pods/${id}/${actionId}`, { method: "POST" });
        return;
      }
      if (actionId === "lock" || actionId === "unlock") {
        await this.api.rest(`/pods/${id}`, {
          method: "PATCH",
          body: { locked: actionId === "lock" },
        });
        return;
      }
    }
    if (typeId === "serverless-endpoint" && actionId === "purge-queue") {
      await this.api.serverless(externalOf(resourceId), "purge-queue", "POST");
      return;
    }
    throw new Error(`Runpod plugin: action "${actionId}" is not supported for "${typeId}"`);
  }

  // ── Estimates ────────────────────────────────────────────────────────

  async estimateCost(typeId: string, fields: Record<string, string>): Promise<CostEstimate | null> {
    if (typeId !== "pod") return null;
    const gpuId = str(fields["gpuTypeId"]);
    if (!gpuId || str(fields["computeType"]) === "CPU") return null;
    const gpu = (await this.gpuTypes().catch(() => [] as RpGpuType[])).find((g) => g.id === gpuId);
    if (!gpu) return null;
    const community = str(fields["cloudType"]) === "COMMUNITY";
    const spot = str(fields["pricing"]) === "spot";
    const rate = spot
      ? community
        ? gpu.communitySpotPrice
        : gpu.secureSpotPrice
      : community
        ? gpu.communityPrice
        : gpu.securePrice;
    if (typeof rate !== "number" || rate <= 0) return null;
    const count = int(fields["gpuCount"], 1) ?? 1;
    return buildCostEstimate(
      [
        {
          label: `${count}× ${gpu.displayName || gpu.id}${spot ? " (spot)" : ""}`,
          monthlyAmount: rate * count * HOURS_PER_MONTH,
          detail: `${HOURS_PER_MONTH} h × ${count} GPU × $${rate.toFixed(2)}/h`,
          quantity: count,
          unit: "GPU",
        },
      ],
      {
        partial: true,
        notes: [
          "GPU time at Runpod's list price while running; container disk and pod volume storage are billed on top.",
        ],
      },
    );
  }

  // ── Rendering ────────────────────────────────────────────────────────

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderRunpodDetail(resource, this.resourceTypes);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderRunpodSidebarItem(resource);
  }

  // ── Cost, credits, commitments, quotas ───────────────────────────────

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    const [pods, endpoints] = await Promise.all([
      this.listRaw.pods().catch(() => [] as RpPod[]),
      this.listRaw.endpoints().catch(() => [] as RpEndpoint[]),
    ]);
    const regions = new Map<string, string>();
    const names = new Map<string, string>();
    for (const p of pods ?? []) {
      if (p.machine?.dataCenterId) regions.set(p.id, p.machine.dataCenterId);
      if (p.name) names.set(p.id, p.name);
    }
    for (const e of endpoints ?? []) {
      if (e.dataCenterIds?.length === 1 && e.dataCenterIds[0])
        regions.set(e.id, e.dataCenterIds[0]);
      if (e.name) names.set(e.id, e.name);
    }
    return fetchRunpodCostData(this.api, range, { regions, names });
  }

  private async account(): Promise<RpMyself | null> {
    const res = await this.api.graphql<{ myself?: RpMyself | null }>(ACCOUNT_QUERY);
    return res?.myself ?? null;
  }

  async fetchCreditBalance(_accountId: string): Promise<CreditBalance[]> {
    let me: RpMyself | null;
    try {
      me = await this.account();
    } catch (e) {
      if (isStatus(e, 401, 403)) {
        throw new CreditAccessError(
          "Runpod refused the account balance for this API key. It needs a key with All or Read Only permission.",
          { label: "Open Runpod API keys", url: "https://console.runpod.io/user/settings" },
        );
      }
      throw e;
    }
    if (!me || typeof me.clientBalance !== "number") return [];
    return [
      { key: "default", label: "Account balance", remaining: me.clientBalance, currency: "USD" },
    ];
  }

  async fetchCommitments(_accountId: string): Promise<CommitmentRecord[]> {
    const res = await this.api.graphql<{ myself?: RpMyself | null }>(SAVINGS_PLANS_QUERY);
    const now = Date.now();
    const out: CommitmentRecord[] = [];
    for (const p of res?.myself?.savingsPlans ?? []) {
      if (!p.id || !p.startTime) continue;
      const start = Date.parse(p.startTime);
      const end = p.endTime ? Date.parse(p.endTime) : Number.NaN;
      const state =
        Number.isFinite(start) && start > now
          ? "queued"
          : Number.isFinite(end) && end < now
            ? "expired"
            : "active";
      const termDays =
        Number.isFinite(start) && Number.isFinite(end)
          ? Math.round((end - start) / 86_400_000)
          : undefined;
      out.push({
        id: p.id,
        kind: "savings_plan",
        description: `Savings plan${p.gpuTypeId ? ` for ${p.gpuTypeId}` : ""}${p.planLength ? ` (${p.planLength})` : ""}`,
        ...(p.podId ? { scope: `Pod ${p.podId}` } : {}),
        startDate: p.startTime,
        ...(p.endTime ? { endDate: p.endTime } : {}),
        ...(termDays ? { termDays } : {}),
        paymentOption: "all_upfront",
        currency: "USD",
        ...(typeof p.upfrontCost === "number" ? { upfrontAmount: p.upfrontCost } : {}),
        ...(typeof p.costPerHr === "number" ? { hourlyCommitmentAmount: p.costPerHr } : {}),
        state,
      });
    }
    return out;
  }

  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
    let me: RpMyself | null;
    try {
      me = await this.account();
    } catch (e) {
      if (isStatus(e, 401, 403)) {
        throw new QuotaAccessError("Runpod refused the account limits for this API key.");
      }
      throw e;
    }
    if (!me) return [];
    const out: QuotaUsage[] = [];
    if (typeof me.spendLimit === "number" && me.spendLimit > 0) {
      out.push({
        id: "spend-limit",
        service: "Account",
        name: "Hourly spend limit",
        limit: me.spendLimit,
        used: Math.round((me.currentSpendPerHr ?? 0) * 100) / 100,
        unit: "USD/hour",
        adjustable: true,
      });
    }
    if (typeof me.maxServerlessConcurrency === "number" && me.maxServerlessConcurrency > 0) {
      const endpoints = await this.listRaw.endpoints().catch(() => [] as RpEndpoint[]);
      const used = (endpoints ?? []).reduce((sum, e) => sum + (e.workersMax ?? 0), 0);
      out.push({
        id: "serverless-workers",
        service: "Serverless",
        name: "Max workers across endpoints",
        limit: me.maxServerlessConcurrency,
        used,
        unit: "workers",
        adjustable: true,
      });
    }
    return out;
  }
}
