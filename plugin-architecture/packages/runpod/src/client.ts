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
import {
  buildCostEstimate,
  commaSeparated,
  CreditAccessError,
  pathEncode,
  QuotaAccessError,
  type ApiBody,
} from "@infrawrench/plugin-base";
import type { operations } from "./api-types.gen.js";
import { isStatus, RunpodApi } from "./api.js";
import {
  runpodCiListTagged,
  runpodCiPreflight,
  runpodCiStart,
  runpodCiStatus,
  runpodCiTeardown,
} from "./ci-executor.js";
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
  scalingValue,
  splitList,
  volumeUsers,
} from "./mappers.js";
import { runpodInstancePricing } from "./instance-pricing.js";
import { renderRunpodDetail, renderRunpodSidebarItem } from "./render.js";
import { fingerprintId, parseSshKeys, sshFingerprint, sshKeyLine } from "./ssh-keys.js";
import type {
  RpCpuType,
  RpDataCenter,
  RpEndpoint,
  RpEndpointHealth,
  RpGpuType,
  RpMyself,
  RpPodExtras,
  RpTemplate,
  RpTemplateExtras,
} from "./types.js";

const CACHE_TTL_MS = 60_000;
const HOURS_PER_MONTH = 730;

function str(v: string | null | undefined): string {
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
 * The console's single "start command" string, as the document takes it. Plain words go
 * in `args`, which Runpod splits itself; a stored `{"entrypoint":...}` goes back as it
 * came; anything with quoting or shell syntax runs through `bash -c` so it means what it
 * says, and goes as `cmd` so that Runpod's splitting cannot get at it.
 */
export function startCommandBody(command: string): { args: string } | { cmd: string[] } {
  const s = command.trim();
  if (s.startsWith("{")) return { args: s };
  if (/["'`$|&;<>(){}\\*?]/.test(s)) return { cmd: ["bash", "-c", s] };
  return { args: s };
}

/** What REST lists leave out: `runtime` is null on `GET /v2/pods`, and the rest is GraphQL's alone. */
const PODS_EXTRAS_QUERY = `query RunpodPodExtras {
  myself {
    pods {
      id
      adjustedCostPerHr
      lastStatusChange
      machine { location gpuDisplayName maintenanceStart maintenanceEnd maintenanceNote }
      runtime {
        uptimeInSeconds
        container { cpuPercent memoryPercent }
        gpus { id gpuUtilPercent memoryUtilPercent }
        ports { ip isIpPublic privatePort publicPort type }
      }
    }
  }
}`;

const TEMPLATES_EXTRAS_QUERY = `query RunpodTemplateExtras {
  myself { podTemplates { id readme earned } }
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

/** One answer kept for {@link CACHE_TTL_MS}; a failure is not kept. */
class Cached<T> {
  private entry: { at: number; value: Promise<T> } | undefined;

  get(load: () => Promise<T>): Promise<T> {
    const current = this.entry;
    if (current && Date.now() - current.at < CACHE_TTL_MS) return current.value;
    const value = load();
    const entry = { at: Date.now(), value };
    value.catch(() => {
      this.entry = undefined;
    });
    this.entry = entry;
    return value;
  }
}

const POD_ACTIONS = ["start", "stop", "restart"] as const;

function isPodAction(action: string): action is (typeof POD_ACTIONS)[number] {
  return POD_ACTIONS.some((known) => known === action);
}

const FLASHBOOT_MODES = ["OFF", "FLASHBOOT", "PRIORITY_FLASHBOOT"] as const;
type FlashbootMode = (typeof FLASHBOOT_MODES)[number];

/** A form value, or a boolean stored before Runpod's flag became an enum. */
export function flashbootMode(value: string | undefined): FlashbootMode {
  if (value === "true") return "FLASHBOOT";
  if (value === "false") return "OFF";
  const known = FLASHBOOT_MODES.find((mode) => mode === value);
  if (known) return known;
  throw new Error(`Runpod plugin: "${value}" is not a FlashBoot mode`);
}

function scaling(type: string, value: number): NonNullable<RpEndpoint["scaling"]> {
  if (type === "QUEUE_DELAY") return { type, queueDelay: value };
  if (type === "REQUEST_COUNT") return { type, requestCount: Math.round(value) };
  throw new Error(`Runpod plugin: "${type}" is not a scaler`);
}

/** Below this the document rejects a volume, and no value removes one once set. */
const MIN_VOLUME_GB = 10;

/**
 * Runpod plugin client. One per account (API key). A Runpod key belongs to a
 * user (or a team, when created in a team context), so every listing is
 * account-wide; there is no project level.
 */
export class RunpodClient implements PluginClient {
  readonly api: RunpodApi;
  private readonly resourceTypes: ResourceTypeDefinition[];
  private readonly gpuCache = new Cached<RpGpuType[]>();
  private readonly serverlessGpuCache = new Cached<RpGpuType[]>();
  private readonly cpuCache = new Cached<RpCpuType[]>();
  private readonly dcCache = new Cached<RpDataCenter[]>();

  constructor(
    credentials: Credentials,
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
      this.api.listAll(
        "/v2/pods",
        (query) => this.api.rest.get("/v2/pods", { query }),
        (page) => page.pods,
      ),
    endpoints: () =>
      this.api.listAll(
        "/v2/serverless",
        (query) => this.api.rest.get("/v2/serverless", { query }),
        (page) => page.endpoints,
      ),
    templates: () =>
      this.api.listAll(
        "/v2/templates",
        (query) => this.api.rest.get("/v2/templates", { query }),
        (page) => page.templates,
      ),
    networkVolumes: () =>
      this.api.listAll(
        "/v2/network-volumes",
        (query) => this.api.rest.get("/v2/network-volumes", { query }),
        (page) => page.networkVolumes,
      ),
    /** The document gives this list no paging, unlike the others. */
    registryAuths: async () => {
      const { registries } = await this.api.rest.get("/v2/registries");
      if (!Array.isArray(registries)) {
        throw new Error("Runpod answered /v2/registries with no list of registries");
      }
      return registries;
    },
  };

  /** Own templates, then Runpod's official ones, for the pod create form. */
  async templatesForPicker(): Promise<Array<RpTemplate & { official?: boolean }>> {
    const [own, catalog] = await Promise.all([
      this.listRaw.templates(),
      this.api.rest.get("/v2/catalog/templates").catch(() => undefined),
    ]);
    return [...own, ...(catalog?.templates ?? []).map((t) => ({ ...t, official: true }))];
  }

  private async gpuCatalog(product: "POD" | "SERVERLESS"): Promise<RpGpuType[]> {
    const { gpus } = await this.api.rest.get("/v2/catalog/gpus", {
      query: { include: commaSeparated(["AVAILABILITY"]), product: commaSeparated([product]) },
    });
    return (gpus ?? []).filter((g) => g.id && (g.secure || g.community));
  }

  /** The GPU catalog with pod stock. */
  gpuTypes(): Promise<RpGpuType[]> {
    return this.gpuCache.get(() => this.gpuCatalog("POD"));
  }

  /** The GPU catalog with Serverless stock, which can differ from pod stock. */
  serverlessGpuTypes(): Promise<RpGpuType[]> {
    return this.serverlessGpuCache.get(() => this.gpuCatalog("SERVERLESS"));
  }

  cpuTypes(): Promise<RpCpuType[]> {
    return this.cpuCache.get(async () => {
      const { cpus } = await this.api.rest.get("/v2/catalog/cpus");
      return cpus ?? [];
    });
  }

  dataCenters(): Promise<RpDataCenter[]> {
    return this.dcCache.get(async () => {
      const { dataCenters } = await this.api.rest.get("/v2/catalog/datacenters", {
        query: { include: commaSeparated(["GPU_AVAILABILITY"]) },
      });
      return dataCenters ?? [];
    });
  }

  /** Telemetry and what REST v2 dropped; best effort (a REST-only key still lists pods). */
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

  /** The readme and earnings, which REST v2 dropped; best effort, as with pods. */
  private async templateExtras(): Promise<Map<string, RpTemplateExtras> | undefined> {
    try {
      const res = await this.api.graphql<{ myself?: { podTemplates?: RpTemplateExtras[] } | null }>(
        TEMPLATES_EXTRAS_QUERY,
      );
      return new Map((res?.myself?.podTemplates ?? []).map((t) => [t.id, t]));
    } catch {
      return undefined;
    }
  }

  private async endpointHealth(
    e: Pick<RpEndpoint, "id" | "type">,
  ): Promise<RpEndpointHealth | undefined> {
    // A load balancing endpoint's health URL is the workers' own, not this queue API.
    if (e.type === "LOAD_BALANCER") return undefined;
    const id = e.id;
    try {
      return await this.api.serverless<RpEndpointHealth>(id, "health");
    } catch {
      return undefined;
    }
  }

  // ── Listing ──────────────────────────────────────────────────────────

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      switch (typeId) {
        case "pod": {
          const [pods, extras] = await Promise.all([this.listRaw.pods(), this.podExtras()]);
          return pods.map((p) => mapPod(p, accountId, extras?.get(p.id)));
        }
        case "serverless-endpoint": {
          const [endpoints, catalog] = await Promise.all([
            this.listRaw.endpoints(),
            this.gpuTypes().catch(() => undefined),
          ]);
          const health = await Promise.all(endpoints.map((e) => this.endpointHealth(e)));
          return endpoints.map((e, i) => mapEndpoint(e, accountId, health[i], catalog));
        }
        case "template": {
          const [templates, extras] = await Promise.all([
            this.listRaw.templates(),
            this.templateExtras(),
          ]);
          return templates.map((t) => mapTemplate(t, accountId, extras?.get(t.id)));
        }
        case "network-volume": {
          const [volumes, pods, endpoints] = await Promise.all([
            this.listRaw.networkVolumes(),
            this.listRaw.pods().catch(() => undefined),
            this.listRaw.endpoints().catch(() => undefined),
          ]);
          // A list that failed says nothing about what is mounted, and "" would flag
          // every volume as an orphan worth deleting.
          const users = pods && endpoints ? volumeUsers(pods, endpoints) : undefined;
          return volumes.map((v) => mapNetworkVolume(v, accountId, users));
        }
        case "container-registry-auth":
          return (await this.listRaw.registryAuths()).map((a) => mapRegistryAuth(a, accountId));
        case "ssh-key":
          return this.listSshKeys(accountId);
        default:
          throw new Error(`Runpod plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  private async readSshKeys() {
    const { keys } = await this.api.rest.get("/v2/account/ssh-keys");
    if (!Array.isArray(keys)) {
      throw new Error("Runpod answered /v2/account/ssh-keys with no list of keys");
    }
    return parseSshKeys(keys);
  }

  private async writeSshKeys(keys: string[]): Promise<void> {
    await this.api.rest.put("/v2/account/ssh-keys", { body: { keys } });
  }

  private async listSshKeys(accountId: string): Promise<ResourceInstance[]> {
    const keys = await this.readSshKeys();
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

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalOf(resourceId);
      switch (typeId) {
        case "pod": {
          const [pod, extras] = await Promise.all([
            this.api.rest.get(`/v2/pods/${pathEncode(id)}`),
            this.podExtras(),
          ]);
          return mapPod(pod, accountId, extras?.get(id));
        }
        case "serverless-endpoint": {
          const [endpoint, catalog] = await Promise.all([
            this.api.rest.get(`/v2/serverless/${pathEncode(id)}`),
            this.gpuTypes().catch(() => undefined),
          ]);
          return mapEndpoint(endpoint, accountId, await this.endpointHealth(endpoint), catalog);
        }
        case "template": {
          const [template, extras] = await Promise.all([
            this.api.rest.get(`/v2/templates/${pathEncode(id)}`),
            this.templateExtras(),
          ]);
          return mapTemplate(template, accountId, extras?.get(id));
        }
        default: {
          const all = await runPluginEffect(this.listResources(typeId, accountId));
          const found = all.find((r) => r.id === resourceId || r.externalId === id);
          if (!found) {
            throw Object.assign(new Error(`Runpod plugin: resource ${typeId}/${id} not found`), {
              status: 404,
            });
          }
          return found;
        }
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

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const name = str(fields["name"]);
      switch (typeId) {
        case "pod": {
          const body = await this.podCreateBody(fields);
          const pod = await this.api.rest.post("/v2/pods", { body });
          return mapPod(pod, accountId, undefined);
        }
        case "serverless-endpoint": {
          const body = this.endpointCreateBody(fields);
          const endpoint = await this.api.rest.post("/v2/serverless", { body });
          return mapEndpoint(endpoint, accountId, undefined);
        }
        case "template": {
          const template = await this.api.rest.post("/v2/templates", {
            body: this.templateCreateBody(fields),
          });
          return mapTemplate(template, accountId);
        }
        case "network-volume": {
          const tier = str(fields["storageType"]);
          const volume = await this.api.rest.post("/v2/network-volumes", {
            body: {
              name,
              dataCenter: str(fields["dataCenterId"]),
              size: int(fields["size"], 50),
              ...(tier === "STANDARD" || tier === "HIGH_PERFORMANCE" ? { type: tier } : {}),
            },
          });
          return mapNetworkVolume(volume, accountId, new Map());
        }
        case "container-registry-auth": {
          const auth = await this.api.rest.post("/v2/registries", {
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
          const comment = line.split(/\s+/).slice(2).join(" ");
          const existing = await this.readSshKeys();
          const fp = await sshFingerprint(parsed.blob);
          const fps = await Promise.all(existing.map((k) => sshFingerprint(k.blob)));
          if (!fps.includes(fp)) {
            await this.writeSshKeys([
              ...existing.map(sshKeyLine),
              sshKeyLine({ ...parsed, comment }),
            ]);
          }
          return mapSshKey({ ...parsed, line, comment }, fp, fingerprintId(fp), accountId);
        }
        default:
          throw new Error(`Runpod plugin: cannot create "${typeId}"`);
      }
    });
  }

  async podCreateBody(fields: Record<string, string>): Promise<ApiBody<operations["createPod"]>> {
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
    const path = str(fields["volumeMountPath"]) || "/workspace";
    const diskGb = int(fields["volumeInGb"], 0) ?? 0;
    if (!cpu && !volume && diskGb !== 0 && diskGb < MIN_VOLUME_GB) {
      throw new Error(`Runpod plugin: a pod volume is at least ${MIN_VOLUME_GB} GB, or 0 for none`);
    }
    // Every network volume has to be in the pod's data center, so "Any" means that one.
    const placement = dc
      ? [dc]
      : volume
        ? [(await this.api.rest.get(`/v2/network-volumes/${pathEncode(volume)}`)).dataCenter]
        : [];
    const ports = splitList(fields["ports"]);
    const body: ApiBody<operations["createPod"]> = {
      name: str(fields["name"]) || "my pod",
      cloud: str(fields["cloudType"]) === "COMMUNITY" ? "COMMUNITY" : "SECURE",
      disk: int(fields["containerDiskInGb"], 50),
      // A v2 pod has no SSH access or Jupyter unless it asks for them.
      startSsh: true,
      ...(image ? { image } : {}),
      ...(template ? { templateId: template } : {}),
      ...(placement.length ? { dataCenterIds: placement } : {}),
      ...(auth ? { registry: auth } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ...(ports.length ? { ports, startJupyter: ports.includes("8888/http") } : {}),
    };
    if (volume) {
      body.mounts = { network: [{ volumeId: volume, path }] };
    } else if (!cpu && diskGb > 0) {
      body.mounts = { persistent: { size: diskGb, path } };
    }
    if (cpu) {
      body.cpu = {
        id: str(fields["cpuFlavorId"]) || "cpu3c",
        vcpuCount: int(fields["vcpuCount"], 2) ?? 2,
      };
    } else {
      const gpu = str(fields["gpuTypeId"]);
      if (!gpu) throw new Error("Runpod plugin: choose a GPU type");
      body.gpu = { id: gpu, count: int(fields["gpuCount"], 1) ?? 1 };
    }
    return body;
  }

  endpointCreateBody(fields: Record<string, string>): ApiBody<operations["createEndpoint"]> {
    const cpu = str(fields["computeType"]) === "CPU";
    const dc = picked(fields["dataCenterId"]);
    const volume = picked(fields["networkVolumeId"]);
    const template = picked(fields["templateId"]);
    const image = str(fields["imageName"]);
    const pool = str(fields["gpuPool"]);
    if (!template && !image) {
      throw new Error("Runpod plugin: choose a template or enter a container image");
    }
    if (!cpu && !pool) throw new Error("Runpod plugin: choose a GPU pool");
    const routing = str(fields["endpointType"]) === "LOAD_BALANCER" ? "LOAD_BALANCER" : "QUEUE";
    const scaler = str(fields["scalerType"]) || "QUEUE_DELAY";
    if (routing === "LOAD_BALANCER" && scaler !== "REQUEST_COUNT") {
      throw new Error("Runpod plugin: a load balancing endpoint scales on request count");
    }
    const noIdle = routing === "QUEUE" && scaler === "REQUEST_COUNT";
    return {
      name: str(fields["name"]),
      type: routing,
      scaling: scaling(scaler, Number(str(fields["scalerValue"]) || 4)),
      workers: {
        min: int(fields["workersMin"], 0) ?? 0,
        max: int(fields["workersMax"], 3) ?? 3,
        ...(noIdle ? {} : { idleTimeout: int(fields["idleTimeout"], 5) ?? 5 }),
      },
      timeout: int(fields["executionTimeoutMs"], 300000),
      flashboot: flashbootMode(str(fields["flashboot"]) || "FLASHBOOT"),
      ...(template ? { templateId: template } : {}),
      ...(image ? { image } : {}),
      ...(dc ? { dataCenterIds: [dc] } : {}),
      ...(volume ? { mounts: { network: [{ volumeId: volume }] } } : {}),
      ...(cpu
        ? {
            cpu: [
              {
                id: str(fields["cpuFlavorId"]) || "cpu3c",
                vcpuCount: int(fields["vcpuCount"], 2) ?? 2,
              },
            ],
          }
        : { gpu: { pools: [pool], count: int(fields["gpuCount"], 1) ?? 1 } }),
    };
  }

  templateCreateBody(fields: Record<string, string>): ApiBody<operations["createTemplate"]> {
    const auth = picked(fields["containerRegistryAuthId"]);
    const start = str(fields["startCommand"]);
    const env = parseEnv(fields["env"]);
    const serverless = str(fields["isServerless"]) === "true";
    const diskGb = int(fields["volumeInGb"], 0) ?? 0;
    if (!serverless && diskGb !== 0 && diskGb < MIN_VOLUME_GB) {
      throw new Error(
        `Runpod plugin: a template volume is at least ${MIN_VOLUME_GB} GB, or 0 for none`,
      );
    }
    const category = str(fields["category"]);
    return {
      name: str(fields["name"]),
      image: str(fields["imageName"]),
      serverless,
      category: category === "AMD" || category === "CPU" ? category : "NVIDIA",
      disk: int(fields["containerDiskInGb"], 50),
      ports: splitList(fields["ports"]),
      ...(!serverless && diskGb > 0
        ? {
            mounts: {
              persistent: { size: diskGb, path: str(fields["volumeMountPath"]) || "/workspace" },
            },
          }
        : {}),
      ...(start ? startCommandBody(start) : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ...(auth ? { registry: auth } : {}),
    };
  }

  /** `size` and `path` of a pod's mounts change separately; which mount they mean depends on the pod. */
  private async podMountChanges(
    id: string,
    fields: Record<string, string>,
  ): Promise<ApiBody<operations["updatePod"]>["mounts"]> {
    const path =
      fields["volumeMountPath"] === undefined ? undefined : str(fields["volumeMountPath"]);
    const size = int(fields["volumeGb"]);
    const pod = await this.api.rest.get(`/v2/pods/${pathEncode(id)}`);
    const network = pod.mounts?.network?.[0];
    if (network && !pod.mounts?.persistent && size === undefined) {
      return { network: [{ volumeId: network.volumeId, ...(path ? { path } : {}) }] };
    }
    if (size !== undefined && size < MIN_VOLUME_GB) {
      throw new Error(
        `Runpod plugin: a pod volume is at least ${MIN_VOLUME_GB} GB and Runpod cannot remove one`,
      );
    }
    return {
      persistent: {
        ...(size !== undefined ? { size } : {}),
        ...(path ? { path } : {}),
      },
    };
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
      switch (typeId) {
        case "pod": {
          const body: ApiBody<operations["updatePod"]> = {};
          if (has("name")) body.name = str(fields["name"]);
          if (has("imageName")) body.image = str(fields["imageName"]);
          if (has("containerDiskGb")) body.disk = int(fields["containerDiskGb"]);
          if (has("ports")) body.ports = splitList(fields["ports"]);
          if (has("locked")) body.locked = fields["locked"] === "true";
          if (has("volumeGb") || has("volumeMountPath")) {
            body.mounts = await this.podMountChanges(externalOf(resourceId), fields);
          }
          if (Object.keys(body).length) {
            await this.api.rest.patch(`/v2/pods/${id}`, { body });
          }
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "serverless-endpoint": {
          const body: ApiBody<operations["updateEndpoint"]> = {};
          if (has("name")) body.name = str(fields["name"]);
          if (has("imageName")) body.image = str(fields["imageName"]);
          if (has("executionTimeoutMs")) body.timeout = int(fields["executionTimeoutMs"]);
          if (has("flashboot")) body.flashboot = flashbootMode(fields["flashboot"]);
          const workers = has("workersMin") || has("workersMax") || has("idleTimeout");
          const scaler = has("scalerType") || has("scalerValue");
          if (workers || scaler) {
            // A scaler is sent whole, type and threshold together, and whether
            // `idleTimeout` is allowed depends on what the endpoint is now.
            const current = await this.api.rest.get(`/v2/serverless/${id}`);
            const type = str(fields["scalerType"]) || current.scaling?.type || "QUEUE_DELAY";
            if (scaler) {
              const value = has("scalerValue")
                ? Number(str(fields["scalerValue"]))
                : scalingValue(current.scaling);
              body.scaling = scaling(type, value);
            }
            if (workers) {
              const noIdle = current.type !== "LOAD_BALANCER" && type === "REQUEST_COUNT";
              if (noIdle && int(fields["idleTimeout"])) {
                throw new Error(
                  "Runpod plugin: idle timeout does not apply to a queue endpoint scaling on request count",
                );
              }
              const idle = int(fields["idleTimeout"]) || current.workers?.idleTimeout;
              body.workers = {
                min: int(fields["workersMin"]) ?? current.workers?.min,
                max: int(fields["workersMax"]) ?? current.workers?.max,
                ...(!noIdle && idle ? { idleTimeout: idle } : {}),
              };
            }
          }
          if (Object.keys(body).length) {
            await this.api.rest.patch(`/v2/serverless/${id}`, { body });
          }
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "template": {
          const body: ApiBody<operations["updateTemplate"]> = {};
          if (has("name")) body.name = str(fields["name"]);
          if (has("imageName")) body.image = str(fields["imageName"]);
          if (has("containerDiskGb")) body.disk = int(fields["containerDiskGb"]);
          if (has("ports")) body.ports = splitList(fields["ports"]);
          if (has("isPublic")) body.public = fields["isPublic"] === "true";
          if (has("startCommand"))
            Object.assign(body, startCommandBody(str(fields["startCommand"])));
          if (has("volumeGb") || has("volumeMountPath")) {
            // Unlike a pod's, a template's mount is sent whole.
            const { mounts } = await this.api.rest.get(`/v2/templates/${id}`);
            const size = int(fields["volumeGb"]) ?? mounts?.persistent?.size ?? 0;
            if (size < MIN_VOLUME_GB) {
              throw new Error(
                `Runpod plugin: a template volume is at least ${MIN_VOLUME_GB} GB and Runpod cannot remove one`,
              );
            }
            const path = str(fields["volumeMountPath"]) || mounts?.persistent?.path || "/workspace";
            body.mounts = { persistent: { size, path } };
          }
          if (Object.keys(body).length) {
            await this.api.rest.patch(`/v2/templates/${id}`, { body });
          }
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "network-volume": {
          const body: ApiBody<operations["updateNetworkVolume"]> = {};
          if (has("name")) body.name = str(fields["name"]);
          if (has("sizeGb")) {
            const current = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
            const size = int(fields["sizeGb"]);
            const now = Number(current.fields["sizeGb"] ?? 0);
            if (size !== undefined && size < now) {
              throw new Error("Runpod plugin: a network volume can only grow, never shrink");
            }
            if (size !== undefined && size !== now) body.size = size;
          }
          if (Object.keys(body).length) {
            await this.api.rest.patch(`/v2/network-volumes/${id}`, { body });
          }
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        default:
          throw new Error(`Runpod plugin: cannot update "${typeId}"`);
      }
    });
  }

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const raw = externalOf(resourceId);
      const id = pathEncode(raw);
      switch (typeId) {
        case "pod":
          await this.api.rest.delete(`/v2/pods/${id}`);
          return;
        case "serverless-endpoint":
          await this.api.rest.delete(`/v2/serverless/${id}`);
          return;
        case "template":
          await this.api.rest.delete(`/v2/templates/${id}`);
          return;
        case "network-volume":
          await this.api.rest.delete(`/v2/network-volumes/${id}`);
          return;
        case "container-registry-auth":
          await this.api.rest.delete(`/v2/registries/${id}`);
          return;
        case "ssh-key": {
          const keys = await this.readSshKeys();
          const fps = await Promise.all(keys.map((k) => sshFingerprint(k.blob)));
          const keep = keys.filter((_, i) => fingerprintId(fps[i]!) !== raw).map(sshKeyLine);
          if (keep.length !== keys.length) await this.writeSshKeys(keep);
          return;
        }
        default:
          throw new Error(`Runpod plugin: cannot delete "${typeId}"`);
      }
    });
  }

  // ── Actions ──────────────────────────────────────────────────────────

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const id = pathEncode(externalOf(resourceId));
      if (typeId === "pod") {
        if (isPodAction(actionId)) {
          await this.api.rest.post(`/v2/pods/${id}/action`, { body: { action: actionId } });
          return;
        }
        if (actionId === "lock" || actionId === "unlock") {
          await this.api.rest.patch(`/v2/pods/${id}`, { body: { locked: actionId === "lock" } });
          return;
        }
      }
      if (typeId === "serverless-endpoint" && actionId === "purge-queue") {
        await this.api.serverless(externalOf(resourceId), "purge-queue", "POST");
        return;
      }
      throw new Error(`Runpod plugin: action "${actionId}" is not supported for "${typeId}"`);
    });
  }

  // ── Estimates ────────────────────────────────────────────────────────

  estimateCost(typeId: string, fields: Record<string, string>): PluginEffect<CostEstimate | null> {
    return attempt(async () => {
      if (typeId !== "pod") return null;
      const gpuId = str(fields["gpuTypeId"]);
      if (!gpuId || str(fields["computeType"]) === "CPU") return null;
      const gpu = (await this.gpuTypes().catch((): RpGpuType[] => [])).find((g) => g.id === gpuId);
      if (!gpu) return null;
      const community = str(fields["cloudType"]) === "COMMUNITY";
      const rate = community ? gpu.price?.community : gpu.price?.secure;
      if (typeof rate !== "number" || rate <= 0) return null;
      const count = int(fields["gpuCount"], 1) ?? 1;
      return buildCostEstimate(
        [
          {
            label: `${count}× ${gpu.name || gpu.id}`,
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
    });
  }

  // ── Rendering ────────────────────────────────────────────────────────

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    const detail = renderRunpodDetail(resource, this.resourceTypes);
    const instancePricing = runpodInstancePricing(resource);
    return instancePricing ? { ...detail, instancePricing } : detail;
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderRunpodSidebarItem(resource);
  }

  // ── Cost, credits, commitments, quotas ───────────────────────────────

  fetchCostData(_accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      const [pods, endpoints, volumes] = await Promise.all([
        this.listRaw.pods().catch(() => []),
        this.listRaw.endpoints().catch(() => []),
        this.listRaw.networkVolumes().catch(() => []),
      ]);
      const regions = new Map<string, string>();
      const names = new Map<string, string>();
      for (const p of pods) {
        if (p.dataCenterId) regions.set(p.id, p.dataCenterId);
        if (p.name) names.set(p.id, p.name);
      }
      for (const e of endpoints) {
        if (e.dataCenterIds?.length === 1 && e.dataCenterIds[0])
          regions.set(e.id, e.dataCenterIds[0]);
        if (e.name) names.set(e.id, e.name);
      }
      for (const v of volumes) {
        if (v.dataCenter) regions.set(v.id, v.dataCenter);
        if (v.name) names.set(v.id, v.name);
      }
      return fetchRunpodCostData(this.api, range, { regions, names });
    });
  }

  private async account(): Promise<RpMyself | null> {
    const res = await this.api.graphql<{ myself?: RpMyself | null }>(ACCOUNT_QUERY);
    return res?.myself ?? null;
  }

  fetchCreditBalance(_accountId: string): PluginEffect<CreditBalance[]> {
    return attempt(async () => {
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
    });
  }

  fetchCommitments(_accountId: string): PluginEffect<CommitmentRecord[]> {
    return attempt(async () => {
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
    });
  }

  fetchQuotas(_accountId: string): PluginEffect<QuotaUsage[]> {
    return attempt(async () => {
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
        const endpoints = await this.listRaw.endpoints().catch(() => []);
        const used = endpoints.reduce((sum, e) => sum + (e.workers?.max ?? 0), 0);
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
    });
  }

  // ── CI jobs (see ci-executor.ts) ─────────────────────────────────────

  ciPreflight(kind: CiExecutorKind, region?: string): PluginEffect<CiPreflightResult> {
    return attempt(() => runpodCiPreflight(this.api, kind, region));
  }

  ciStart(spec: CiStartSpec): PluginEffect<CiHandle> {
    return attempt(() => runpodCiStart(this.api, spec));
  }

  ciStatus(handle: CiHandle): PluginEffect<CiComputeStatus> {
    return attempt(() => runpodCiStatus(this.api, handle));
  }

  ciTeardown(handle: CiHandle): PluginEffect<void> {
    return attempt(() => runpodCiTeardown(this.api, handle));
  }

  ciListTagged(tagKey: string, _regions: readonly string[]): PluginEffect<CiTaggedCompute[]> {
    return attempt(() => runpodCiListTagged(this.api, tagKey));
  }
}
