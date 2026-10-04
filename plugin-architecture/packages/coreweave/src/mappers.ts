import type { ResourceInstance } from "@infrawrench/plugin-base";
import { HOURS_PER_MONTH, LIST_PRICES, instanceSpec, type InstanceSpec } from "./catalog.js";
import type { NegotiatedRates } from "./rates.js";
import { instanceHourRate } from "./rates.js";

export const PLUGIN_ID = "coreweave";

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface CwCluster {
  id?: string;
  name?: string;
  zone?: string;
  vpcId?: string;
  public?: boolean;
  version?: string;
  network?: {
    podCidrName?: string;
    serviceCidrName?: string;
    internalLbCidrNames?: string[];
  };
  apiServerEndpoint?: string;
  createdAt?: string;
  updatedAt?: string;
  isUpgradeable?: boolean;
  status?: string;
}

export interface CwVpcPrefix {
  name?: string;
  value?: string;
  status?: string;
}

export interface CwVpc {
  id?: string;
  name?: string;
  status?: string;
  zone?: string;
  vpcPrefixes?: CwVpcPrefix[];
  hostPrefix?: string;
  hostPrefixes?: Array<{ name?: string; type?: string; prefixes?: string[] }>;
  ingress?: { disablePublicServices?: boolean };
  egress?: { disablePublicAccess?: boolean };
  createdAt?: string;
  updatedAt?: string;
}

export interface CwNodePool {
  metadata?: {
    name?: string;
    uid?: string;
    creationTimestamp?: string;
    annotations?: Record<string, string>;
    resourceVersion?: string;
  };
  spec?: {
    computeClass?: string;
    instanceType?: string;
    targetNodes?: number;
    targetRacks?: number;
    minNodes?: number;
    maxNodes?: number;
    autoscaling?: boolean;
    gpu?: { version?: string };
    lifecycle?: { scaleDownStrategy?: string };
  };
  status?: {
    queuedNodes?: number;
    inProgress?: number;
    currentNodes?: number;
    nodeProfile?: string;
    pendingNodeConfiguration?: { nodeProfile?: string; summary?: string[] };
    rackStatus?: { target?: number; current?: number; queued?: number };
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
  };
}

export interface CwBucket {
  name?: string;
  creationTime?: string;
  location?: string;
  settings?: {
    auditLoggingEnabled?: boolean;
    archiveEnabled?: boolean;
    archiveAfterLastAccessDays?: number;
    configuredCapacityCapBytes?: string;
  };
  usage?: Array<{ measurementType?: string; value?: string; valueHumanReadable?: string }>;
}

export interface CwAccessKey {
  accessKeyId?: string;
  status?: string;
  principalName?: string;
  attributes?: Record<string, string>;
  expiry?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const now = () => new Date().toISOString();

function base(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, string | number | boolean | undefined>,
  extra: Partial<ResourceInstance> = {},
): ResourceInstance {
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== "") clean[k] = v;
  }
  const created = typeof clean["createdAt"] === "string" ? clean["createdAt"] : now();
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName,
    fields: clean,
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    createdAt: created,
    updatedAt: now(),
    ...extra,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Rounded to 4 places so GPU-hour prices of a few dollars keep their cents. */
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Turn a FOCUS-style SKU or API status like `STATUS_READY` into `Ready`. */
export function prettyStatus(raw: string | undefined): string {
  if (!raw) return "";
  const s = raw
    .replace(/^STATUS_/, "")
    .replace(/_/g, " ")
    .toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Prefixes as the editable `name=CIDR, …` text. */
export function prefixesToText(prefixes: CwVpcPrefix[] | undefined): string {
  return (prefixes ?? [])
    .filter((p) => p.name && p.value)
    .map((p) => `${p.name}=${p.value}`)
    .join(", ");
}

/** Parse `name=CIDR` entries (comma or newline separated). */
export function parsePrefixes(text: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const entry of text.split(/[,\n]/)) {
    const eq = entry.lastIndexOf("=");
    if (eq < 0) {
      if (entry.trim()) throw new Error(`"${entry.trim()}" is not in name=CIDR form.`);
      continue;
    }
    const name = entry.slice(0, eq).trim();
    const value = entry.slice(eq + 1).trim();
    if (!name || !value) throw new Error(`"${entry.trim()}" is not in name=CIDR form.`);
    if (name.length > 30) throw new Error(`Prefix name "${name}" is longer than 30 characters.`);
    if (!/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(value)) {
      throw new Error(`"${value}" is not a CIDR range.`);
    }
    out.push({ name, value });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export interface ClusterRollup {
  nodePoolCount: number;
  nodeCount: number;
  gpuCount: number;
  hourlyRunRate?: number;
}

export function mapCluster(
  accountId: string,
  c: CwCluster,
  vpcName?: string,
  rollup?: ClusterRollup,
): ResourceInstance {
  const id = c.id ?? c.name ?? "";
  return base(accountId, "cks-cluster", id, c.name ?? id, {
    name: c.name,
    zone: c.zone,
    version: c.version,
    public: c.public === true,
    status: c.status,
    vpcId: c.vpcId,
    vpcName,
    apiServerEndpoint: c.apiServerEndpoint,
    publicEndpoint: c.public === true ? c.apiServerEndpoint : undefined,
    podCidrName: c.network?.podCidrName,
    serviceCidrName: c.network?.serviceCidrName,
    internalLbCidrNames: (c.network?.internalLbCidrNames ?? []).join(", "),
    upgradeable: c.isUpgradeable,
    nodePoolCount: rollup?.nodePoolCount,
    nodeCount: rollup?.nodeCount,
    gpuCount: rollup?.gpuCount,
    hourlyRunRate: rollup?.hourlyRunRate !== undefined ? round2(rollup.hourlyRunRate) : undefined,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  });
}

export function mapVpc(accountId: string, v: CwVpc): ResourceInstance {
  const id = v.id ?? v.name ?? "";
  const host =
    v.hostPrefixes && v.hostPrefixes.length > 0
      ? v.hostPrefixes.map((h) => `${h.name ?? ""} ${(h.prefixes ?? []).join(" ")}`.trim())
      : v.hostPrefix
        ? [v.hostPrefix]
        : [];
  return base(accountId, "vpc", id, v.name ?? id, {
    name: v.name,
    zone: v.zone,
    status: prettyStatus(v.status),
    prefixes: prefixesToText(v.vpcPrefixes),
    hostPrefixes: host.join(", "),
    disablePublicServices: v.ingress?.disablePublicServices === true,
    disablePublicAccess: v.egress?.disablePublicAccess === true,
    createdAt: v.createdAt,
  });
}

/** Annotation holding the size a pool had before Scale to zero. */
export const RESTORE_ANNOTATION = "infrawrench.io/restore-scale";

export interface RestoreState {
  targetNodes?: number;
  targetRacks?: number;
  autoscaling?: boolean;
  minNodes?: number;
  maxNodes?: number;
}

export function readRestoreState(pool: CwNodePool): RestoreState | undefined {
  const raw = pool.metadata?.annotations?.[RESTORE_ANNOTATION];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as RestoreState;
  } catch {
    return undefined;
  }
}

/** Nodes a pool is asking for, counting racks as 18 Nodes each. */
export function targetNodesOf(pool: CwNodePool): number {
  if (typeof pool.spec?.targetNodes === "number") return pool.spec.targetNodes;
  if (typeof pool.spec?.targetRacks === "number") return pool.spec.targetRacks * 18;
  return 0;
}

export function mapNodePool(
  accountId: string,
  cluster: { id: string; name: string },
  pool: CwNodePool,
  rates: NegotiatedRates,
): ResourceInstance {
  const name = pool.metadata?.name ?? "";
  const instanceType = pool.spec?.instanceType ?? "";
  const spec = instanceSpec(instanceType);
  const current = pool.status?.currentNodes ?? 0;
  const target = targetNodesOf(pool);
  const plan = pool.spec?.computeClass === "spot" ? "spot" : "on-demand";
  const priced = instanceHourRate(rates, instanceType, plan);
  const ready = (pool.status?.conditions ?? []).find((c) => c.type === "Ready");
  const scaledToZero = target === 0 && readRestoreState(pool) !== undefined;
  return base(
    accountId,
    "node-pool",
    `${cluster.id}/${name}`,
    name,
    {
      name,
      clusterName: cluster.name,
      instanceType,
      gpuModel: spec?.gpuModel,
      computeClass: pool.spec?.computeClass ?? "default",
      targetNodes: target,
      autoscaling: pool.spec?.autoscaling === true,
      minNodes: pool.spec?.minNodes,
      maxNodes: pool.spec?.maxNodes,
      scaleDownStrategy: pool.spec?.lifecycle?.scaleDownStrategy,
      currentNodes: current,
      queuedNodes: pool.status?.queuedNodes,
      inProgressNodes: pool.status?.inProgress,
      gpuCount: spec ? current * spec.gpuCount : undefined,
      hourlyRate: priced.source === "unpriced" ? undefined : round4(priced.rate),
      hourlyRunRate: priced.source === "unpriced" ? undefined : round2(priced.rate * current),
      state: scaledToZero ? "scaled-to-zero" : "running",
      ready: ready ? `${ready.status ?? ""}${ready.reason ? ` (${ready.reason})` : ""}` : undefined,
      nodeProfile: pool.status?.nodeProfile,
      pendingConfiguration: (pool.status?.pendingNodeConfiguration?.summary ?? []).join("; "),
      gpuDriver: pool.spec?.gpu?.version,
      createdAt: pool.metadata?.creationTimestamp,
    },
    { parentResourceId: `${accountId}:cks-cluster:${cluster.id}` },
  );
}

export function mapInstanceType(
  accountId: string,
  spec: InstanceSpec,
  rates: NegotiatedRates,
  inUseNodes: number,
): ResourceInstance {
  const priced = instanceHourRate(rates, spec.id, "on-demand");
  const hourly = priced.source === "unpriced" ? undefined : priced.rate;
  return base(accountId, "instance-type", spec.id, `${spec.name} (${spec.id})`, {
    name: spec.name,
    family: spec.family === "gpu" ? "GPU" : "CPU",
    gpuModel: spec.gpuModel,
    gpuCount: spec.gpuCount || undefined,
    gpuMemoryGb: spec.gpuMemoryGb || undefined,
    cpuModel: spec.cpuModel,
    vcpus: spec.vcpus,
    ramGb: spec.ramGb,
    storageTb: spec.storageTb,
    hourlyUsd: hourly,
    gpuHourlyUsd:
      hourly !== undefined && spec.gpuCount > 0 ? round4(hourly / spec.gpuCount) : undefined,
    monthlyUsd: hourly !== undefined ? round2(hourly * HOURS_PER_MONTH) : undefined,
    priceSource:
      priced.source === "negotiated"
        ? "Negotiated rate"
        : priced.source === "list"
          ? "Published on-demand price"
          : "Not published (contact CoreWeave sales)",
    rackScale: spec.rackScale === true,
    zones: spec.zones.join(", "),
    inUseNodes,
  });
}

export function bucketSizeBytes(b: CwBucket): number {
  const usage = (b.usage ?? []).find((u) => /USAGE_BYTES|BYTES/i.test(u.measurementType ?? ""));
  const n = Number(usage?.value ?? NaN);
  return Number.isFinite(n) ? n : 0;
}

export function mapBucket(
  accountId: string,
  b: CwBucket,
  rates: NegotiatedRates,
): ResourceInstance {
  const name = b.name ?? "";
  const bytes = bucketSizeBytes(b);
  const perGbMonth = rates.objectGbMonth ?? LIST_PRICES.objectHotGbMonth;
  const cap = Number(b.settings?.configuredCapacityCapBytes ?? NaN);
  return base(accountId, "bucket", name, name, {
    name,
    zone: b.location,
    sizeBytes: bytes,
    size: formatBytes(bytes),
    estimatedMonthlyUsd: round2((bytes / 1e9) * perGbMonth),
    auditLogging: b.settings?.auditLoggingEnabled === true,
    archiveEnabled: b.settings?.archiveEnabled === true,
    archiveAfterDays: b.settings?.archiveAfterLastAccessDays,
    capacityCapGb: Number.isFinite(cap) ? round2(cap / 1e9) : undefined,
    createdAt: b.creationTime,
  });
}

export function mapAccessKey(accountId: string, k: CwAccessKey): ResourceInstance {
  const id = k.accessKeyId ?? "";
  const name = k.attributes?.["name"];
  // Permanent keys may report a sentinel far-future expiry; hide it.
  const expiry =
    k.expiry && !k.expiry.startsWith("0001") && k.expiry < "9000" ? k.expiry : undefined;
  return base(accountId, "access-key", id, name ? `${name} (${id})` : id, {
    accessKeyId: id,
    name,
    status: prettyStatus(k.status),
    principal: k.principalName,
    expiresAt: expiry,
  });
}
