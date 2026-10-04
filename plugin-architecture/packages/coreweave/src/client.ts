import type {
  CostFetchRange,
  CostRow,
  CreateFieldConfig,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  PreflightResult,
  ResourceInstance,
  SidebarItemSchema,
  StorageObject,
} from "@infrawrench/plugin-base";
import {
  deleteS3Object,
  externalIdOf,
  listS3Objects,
  makeS3Folder,
  uploadS3Object,
} from "@infrawrench/plugin-base";
import type { CoreWeaveContext } from "./api.js";
import { apiServerOrigin, cwFetch, statusOf } from "./api.js";
import {
  INSTANCE_TYPES,
  KUBERNETES_VERSIONS,
  ZONES,
  instanceSpec,
  isRackScale,
} from "./catalog.js";
import { buildCostRows, exportWindow, fetchCoreWeaveCostData, summarise } from "./cost-data.js";
import type { FocusRow } from "./focus.js";
import { fetchFocusRows } from "./focus.js";
import type { CwCluster, CwNodePool, CwVpc } from "./mappers.js";
import {
  mapAccessKey,
  mapBucket,
  mapCluster,
  mapInstanceType,
  mapNodePool,
  mapVpc,
  parsePrefixes,
  PLUGIN_ID,
  targetNodesOf,
} from "./mappers.js";
import {
  DEFAULT_METRICS_WINDOW_MS,
  USAGE_METRICS_WINDOW_MS,
  clusterSelector,
  gpuHourSeries,
  gpuHourSeriesFromRows,
  gpuSeries,
  nodesSelector,
  rangeOrDefault,
  spendSeries,
} from "./metrics.js";
import {
  createNodePool,
  deleteNodePool,
  getNodePool,
  listNodePools,
  nodeNamesInPool,
  patchNodePool,
  restorePatch,
  scaleToZeroPatch,
  validatePoolName,
  validatePoolSize,
  buildNodePoolSpec,
  wholeNumber,
} from "./node-pools.js";
import {
  TemporaryS3Credentials,
  createBucket,
  deleteBucket,
  getBucket,
  listAccessKeys,
  listBuckets,
  s3ConfigFor,
  S3_ENDPOINT,
  setBucketSettings,
  setPrincipalKeyStatus,
  validateBucketName,
} from "./object-storage.js";
import type { BucketSettingsInput } from "./object-storage.js";
import { verifyCoreWeaveCredentials } from "./preflight.js";
import type { NegotiatedRates } from "./rates.js";
import {
  hasNegotiatedRates,
  instanceHourRate,
  nodeHourlyRatesJson,
  parseNegotiatedRates,
} from "./rates.js";
import { SUMMARY_KEY, renderCoreWeaveDetail, renderCoreWeaveSidebar } from "./render.js";

/** How long a cluster or VPC listing is reused inside one client. */
const LIST_TTL_MS = 30_000;
/** Parallel Kubernetes API calls when walking clusters. */
const KUBE_CONCURRENCY = 4;

const ORG_ID = "organization";

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

async function mapPooled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

function bool(raw: string | undefined): boolean {
  return raw === "true" || raw === "yes" || raw === "1";
}

function yesNo(key: string, label: string, def: boolean, description?: string): CreateFieldConfig {
  return {
    key,
    label,
    kind: "select",
    required: true,
    defaultValue: def ? "true" : "false",
    options: [
      { id: "true", label: "Yes" },
      { id: "false", label: "No" },
    ],
    ...(description ? { description } : {}),
  };
}

function zoneField(description: string): CreateFieldConfig {
  return {
    key: "zone",
    label: "Zone",
    kind: "select",
    required: true,
    description,
    options: ZONES.map((z) => ({ id: z, label: z })),
  };
}

/** The default prefixes CoreWeave's own Terraform example gives a cluster VPC. */
const DEFAULT_VPC_PREFIXES =
  "pod cidr=10.0.0.0/13, service cidr=10.16.0.0/22, internal lb cidr=10.32.4.0/22";

export class CoreWeaveClient implements PluginClient {
  private readonly ctx: CoreWeaveContext;
  private readonly rates: NegotiatedRates;
  private readonly s3: TemporaryS3Credentials;
  private clustersCache: Cached<CwCluster[]> | undefined;
  private vpcsCache: Cached<CwVpc[]> | undefined;
  private poolsCache: Cached<Map<string, CwNodePool[]>> | undefined;
  private readonly bucketZones = new Map<string, string>();

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const token = (credentials["apiToken"] ?? "").trim();
    if (!token) throw new Error("CoreWeave plugin: missing apiToken credential");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      token,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
    this.rates = parseNegotiatedRates(credentials["negotiatedRates"]);
    this.s3 = new TemporaryS3Credentials(this.ctx);
  }

  // -------------------------------------------------------------------------
  // Cached listings
  // -------------------------------------------------------------------------

  private cached<T>(slot: Cached<T> | undefined, load: () => Promise<T>): Cached<T> {
    if (slot && Date.now() - slot.at < LIST_TTL_MS) return slot;
    const value = load();
    value.catch(() => undefined);
    return { at: Date.now(), value };
  }

  private clusters(): Promise<CwCluster[]> {
    this.clustersCache = this.cached(this.clustersCache, async () => {
      const res = await cwFetch<{ items?: CwCluster[] }>(this.ctx, "/v1beta1/cks/clusters", {
        query: { returnPartialSuccess: true },
      });
      return res?.items ?? [];
    });
    return this.clustersCache.value;
  }

  private vpcs(): Promise<CwVpc[]> {
    this.vpcsCache = this.cached(this.vpcsCache, async () => {
      const res = await cwFetch<{ items?: CwVpc[] }>(this.ctx, "/v1beta1/networking/vpcs");
      return res?.items ?? [];
    });
    return this.vpcsCache.value;
  }

  /**
   * Node Pools of every reachable cluster, keyed by cluster id. A private
   * cluster, one still provisioning, or one the token has no RBAC on lists no
   * pools rather than failing the sync.
   */
  private allPools(): Promise<Map<string, CwNodePool[]>> {
    this.poolsCache = this.cached(this.poolsCache, async () => {
      const clusters = await this.clusters();
      const out = new Map<string, CwNodePool[]>();
      await mapPooled(clusters, KUBE_CONCURRENCY, async (c) => {
        if (!c.id || !c.apiServerEndpoint) return;
        const pools = await listNodePools(this.ctx, c.apiServerEndpoint).catch(() => undefined);
        if (pools) out.set(c.id, pools);
      });
      return out;
    });
    return this.poolsCache.value;
  }

  private invalidate(): void {
    this.clustersCache = undefined;
    this.vpcsCache = undefined;
    this.poolsCache = undefined;
  }

  private async clusterById(id: string): Promise<CwCluster> {
    try {
      const res = await cwFetch<{ cluster?: CwCluster }>(
        this.ctx,
        `/v1beta1/cks/clusters/${encodeURIComponent(id)}`,
      );
      if (res?.cluster) return res.cluster;
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
    }
    throw new Error(`CoreWeave plugin: cluster ${id} not found`);
  }

  private rollup(pools: CwNodePool[] | undefined) {
    if (!pools) return undefined;
    let nodeCount = 0;
    let gpuCount = 0;
    let rate = 0;
    let priced = false;
    for (const p of pools) {
      const current = p.status?.currentNodes ?? 0;
      const type = p.spec?.instanceType ?? "";
      nodeCount += current;
      gpuCount += current * (instanceSpec(type)?.gpuCount ?? 0);
      const r = instanceHourRate(
        this.rates,
        type,
        p.spec?.computeClass === "spot" ? "spot" : "on-demand",
      );
      if (r.source !== "unpriced") {
        priced = true;
        rate += r.rate * current;
      }
    }
    return {
      nodePoolCount: pools.length,
      nodeCount,
      gpuCount,
      ...(priced ? { hourlyRunRate: rate } : {}),
    };
  }

  private async mapClusters(accountId: string, clusters: CwCluster[]): Promise<ResourceInstance[]> {
    const [vpcs, pools] = await Promise.all([
      this.vpcs().catch(() => [] as CwVpc[]),
      this.allPools().catch(() => new Map<string, CwNodePool[]>()),
    ]);
    const vpcNames = new Map(vpcs.map((v) => [v.id ?? "", v.name ?? ""]));
    return clusters.map((c) =>
      mapCluster(accountId, c, vpcNames.get(c.vpcId ?? ""), this.rollup(pools.get(c.id ?? ""))),
    );
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  /** 403 on one surface means the token lacks that role; the rest still lists. */
  private async scoped(load: () => Promise<ResourceInstance[]>): Promise<ResourceInstance[]> {
    try {
      return await load();
    } catch (err) {
      if (statusOf(err) === 403) return [];
      throw err;
    }
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "organization":
        return [this.organizationRow(accountId)];
      case "cks-cluster":
        return this.scoped(async () => this.mapClusters(accountId, await this.clusters()));
      case "node-pool":
        return this.scoped(async () => {
          const [clusters, pools] = await Promise.all([this.clusters(), this.allPools()]);
          return clusters.flatMap((c) =>
            (pools.get(c.id ?? "") ?? []).map((p) =>
              mapNodePool(accountId, { id: c.id ?? "", name: c.name ?? "" }, p, this.rates),
            ),
          );
        });
      case "instance-type": {
        const inUse = new Map<string, number>();
        const pools = await this.allPools().catch(() => new Map<string, CwNodePool[]>());
        for (const list of pools.values()) {
          for (const p of list) {
            const t = p.spec?.instanceType ?? "";
            inUse.set(t, (inUse.get(t) ?? 0) + (p.status?.currentNodes ?? 0));
          }
        }
        return INSTANCE_TYPES.map((s) =>
          mapInstanceType(accountId, s, this.rates, inUse.get(s.id) ?? 0),
        );
      }
      case "vpc":
        return this.scoped(async () => (await this.vpcs()).map((v) => mapVpc(accountId, v)));
      case "bucket":
        return this.scoped(async () => {
          const buckets = await listBuckets(this.ctx);
          for (const b of buckets)
            if (b.name && b.location) this.bucketZones.set(b.name, b.location);
          return buckets.map((b) => mapBucket(accountId, b, this.rates));
        });
      case "access-key":
        return this.scoped(async () =>
          (await listAccessKeys(this.ctx)).map((k) => mapAccessKey(accountId, k)),
        );
      default:
        throw new Error(`CoreWeave plugin: unknown resource type "${typeId}"`);
    }
  }

  private organizationRow(accountId: string): ResourceInstance {
    const now = new Date().toISOString();
    return {
      id: `${accountId}:organization:${ORG_ID}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: "organization",
      accountId,
      displayName: "CoreWeave organization",
      fields: {
        name: "CoreWeave organization",
        pricing: hasNegotiatedRates(this.rates)
          ? "Negotiated rates, list prices for the rest"
          : "Published on-demand list prices",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: ORG_ID,
      createdAt: now,
      updatedAt: now,
    };
  }

  // -------------------------------------------------------------------------
  // Single reads
  // -------------------------------------------------------------------------

  private splitPoolId(resourceId: string): { clusterId: string; name: string } {
    const ext = externalIdOf(resourceId);
    const slash = ext.indexOf("/");
    if (slash < 0) throw new Error(`CoreWeave plugin: malformed Node Pool id "${ext}"`);
    return { clusterId: ext.slice(0, slash), name: ext.slice(slash + 1) };
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "organization":
        return this.organizationDetail(accountId);
      case "cks-cluster": {
        const cluster = await this.clusterById(id);
        const [mapped] = await this.mapClusters(accountId, [cluster]);
        if (mapped) return mapped;
        break;
      }
      case "node-pool": {
        const { clusterId, name } = this.splitPoolId(resourceId);
        const cluster = await this.clusterById(clusterId);
        const pool = await getNodePool(this.ctx, cluster.apiServerEndpoint ?? "", name);
        return mapNodePool(
          accountId,
          { id: clusterId, name: cluster.name ?? "" },
          pool,
          this.rates,
        );
      }
      case "vpc": {
        const res = await cwFetch<{ vpc?: CwVpc }>(
          this.ctx,
          `/v1beta1/networking/vpcs/${encodeURIComponent(id)}`,
        );
        if (res?.vpc) return mapVpc(accountId, res.vpc);
        break;
      }
      case "bucket": {
        const b = await getBucket(this.ctx, id);
        if (b.location) this.bucketZones.set(id, b.location);
        return mapBucket(accountId, b, this.rates);
      }
      default:
        break;
    }
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId || r.externalId === id);
    if (!found) throw new Error(`CoreWeave plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  /** Month-to-date usage and estimated spend for the organization page. */
  private async organizationDetail(accountId: string): Promise<ResourceInstance> {
    const row = this.organizationRow(accountId);
    const today = new Date().toISOString().slice(0, 10);
    const range = { fromDate: `${today.slice(0, 7)}-01`, toDate: today };
    const window = exportWindow(range);
    if (!window) return row;
    try {
      const location = await fetchFocusRows(this.ctx, {
        startTime: window.start,
        endTime: window.end,
        groupBy: "location",
      });
      const plans = await fetchFocusRows(this.ctx, {
        startTime: window.start,
        endTime: window.end,
        groupBy: "capacity_plan",
      }).catch(() => [] as FocusRow[]);
      const summary = summarise(buildCostRows(location, plans, this.rates), location, window);
      return {
        ...row,
        fields: {
          ...row.fields,
          gpuHoursMtd: summary.gpuHours,
          estimatedMtd: summary.estimatedUsd,
          usageExport: "Enabled",
        },
        resolvedOutputs: { [SUMMARY_KEY]: JSON.stringify(summary) },
      };
    } catch (err) {
      return {
        ...row,
        fields: {
          ...row.fields,
          usageExport:
            statusOf(err) === 403
              ? "Not enabled for this organization (ask CoreWeave Support to enable FOCUS export)"
              : "Unavailable",
        },
      };
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const id = externalIdOf(resourceId);
    if (typeId === "cks-cluster") {
      if (outputKey === "nodeHourlyRates") {
        // Must never throw: the host resolves every credentialMapping before
        // building the Kubernetes peer, so a failure would take the tab down.
        const types = [
          ...INSTANCE_TYPES.map((t) => t.id),
          ...Object.keys(this.rates.instance),
          ...Object.keys(this.rates.byPlan["on-demand"]),
        ];
        return nodeHourlyRatesJson(this.rates, types);
      }
      if (outputKey === "clusterId") return id;
      const cluster = await this.clusterById(id);
      if (outputKey === "apiServerEndpoint")
        return apiServerOrigin(cluster.apiServerEndpoint ?? "");
      if (outputKey === "kubeconfig") return this.kubeconfig(cluster);
    }
    if (typeId === "bucket") {
      if (outputKey === "bucketName") return id;
      if (outputKey === "endpoint") return S3_ENDPOINT;
      if (outputKey === "region") return this.bucketZone(id);
    }
    if (typeId === "vpc" && outputKey === "vpcId") return id;
    if (typeId === "node-pool" && outputKey === "nodePoolName")
      return this.splitPoolId(resourceId).name;
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.resolvedOutputs[outputKey] ?? resource.fields[outputKey];
    if (value !== undefined) return String(value);
    throw new Error(`CoreWeave plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  /**
   * A kubeconfig for one cluster carrying the account's API token inline,
   * the same shape the Cloud Console's "Get kubeconfig" produces. The API
   * server presents a publicly trusted certificate, so no CA data is needed,
   * and only inline credentials are used, which is what the server-side
   * kubeconfig policy allows.
   */
  private kubeconfig(cluster: CwCluster): string {
    const server = apiServerOrigin(cluster.apiServerEndpoint ?? "");
    if (!server) {
      throw new Error(
        "CoreWeave plugin: this cluster has no API server endpoint yet. It appears once the control plane is Healthy.",
      );
    }
    const name = cluster.name || cluster.id || "cks";
    const user = `infrawrench-${name}`;
    const q = (s: string) => JSON.stringify(s);
    return [
      "apiVersion: v1",
      "kind: Config",
      "clusters:",
      `  - name: ${q(name)}`,
      "    cluster:",
      `      server: ${q(server)}`,
      "contexts:",
      `  - name: ${q(name)}`,
      "    context:",
      `      cluster: ${q(name)}`,
      `      user: ${q(user)}`,
      `current-context: ${q(name)}`,
      "users:",
      `  - name: ${q(user)}`,
      "    user:",
      `      token: ${q(this.ctx.token)}`,
      "",
    ].join("\n");
  }

  // -------------------------------------------------------------------------
  // Stats, metrics, costs
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = r.fields;
    const usd = (v: unknown) =>
      typeof v === "number" ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "—";
    switch (resourceTypeId) {
      case "organization":
        return [
          { label: "GPU-hours (MTD)", value: String(f["gpuHoursMtd"] ?? "—") },
          { label: "Estimated (MTD)", value: usd(f["estimatedMtd"]) },
        ];
      case "cks-cluster":
        return [
          { label: "Status", value: String(f["status"] ?? "—") },
          { label: "GPUs", value: String(f["gpuCount"] ?? "—") },
          {
            label: "Run rate",
            value: typeof f["hourlyRunRate"] === "number" ? `${usd(f["hourlyRunRate"])}/h` : "—",
          },
        ];
      case "node-pool":
        return [
          {
            label: "Nodes",
            value: `${String(f["currentNodes"] ?? 0)} / ${String(f["targetNodes"] ?? 0)}`,
          },
          {
            label: "Run rate",
            value: typeof f["hourlyRunRate"] === "number" ? `${usd(f["hourlyRunRate"])}/h` : "—",
          },
        ];
      case "bucket":
        return [
          { label: "Size", value: String(f["size"] ?? "—") },
          { label: "Est. monthly", value: usd(f["estimatedMonthlyUsd"]) },
        ];
      default:
        return [];
    }
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    switch (resourceTypeId) {
      case "organization": {
        const range = rangeOrDefault(timeRange, USAGE_METRICS_WINDOW_MS);
        const costRange = {
          fromDate: new Date(range.startMs).toISOString().slice(0, 10),
          toDate: new Date(range.endMs).toISOString().slice(0, 10),
        };
        const window = exportWindow(costRange);
        if (!window) return [];
        const location = await fetchFocusRows(this.ctx, {
          startTime: window.start,
          endTime: window.end,
          groupBy: "location",
        }).catch(() => [] as FocusRow[]);
        const plans = await fetchFocusRows(this.ctx, {
          startTime: window.start,
          endTime: window.end,
          groupBy: "capacity_plan",
        }).catch(() => [] as FocusRow[]);
        return [
          ...gpuHourSeriesFromRows(location),
          ...spendSeries(buildCostRows(location, plans, this.rates)),
        ];
      }
      case "cks-cluster": {
        const range = rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS);
        const id = externalIdOf(resourceId);
        const cluster = await this.clusterById(id);
        const [gpu, hours] = await Promise.all([
          gpuSeries(this.ctx, clusterSelector(cluster.name ?? ""), range),
          // Daily buckets: widen a short window to a few days so there is a line.
          gpuHourSeries(
            this.ctx,
            { startMs: Math.min(range.startMs, range.endMs - 7 * 86_400_000), endMs: range.endMs },
            id,
          ),
        ]);
        return [...gpu, ...hours];
      }
      case "node-pool": {
        const range = rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS);
        const { clusterId, name } = this.splitPoolId(resourceId);
        const cluster = await this.clusterById(clusterId);
        const nodes = await nodeNamesInPool(this.ctx, cluster.apiServerEndpoint ?? "", name).catch(
          () => [] as string[],
        );
        if (nodes.length === 0) return [];
        return gpuSeries(this.ctx, nodesSelector(cluster.name ?? "", nodes), range);
      }
      default:
        return [];
    }
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchCoreWeaveCostData(this.ctx, this.rates, range);
  }

  async verifyCredentials(): Promise<PreflightResult> {
    return verifyCoreWeaveCredentials(this.ctx);
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "cks-cluster":
        return this.clusterCreateConfig();
      case "node-pool":
        return this.nodePoolCreateConfig(parentResourceId);
      case "vpc":
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              description: "Up to 30 characters.",
            },
            zoneField("A cluster can only use a VPC in its own zone."),
            {
              key: "prefixes",
              label: "VPC Prefixes",
              kind: "text",
              required: false,
              defaultValue: DEFAULT_VPC_PREFIXES,
              description:
                "Named ranges as name=CIDR, comma separated. A CKS cluster needs one for pods, one for services and one for internal load balancers; these defaults are the ones CoreWeave's own examples use.",
            },
            yesNo("disablePublicServices", "Block Public Ingress", false),
            yesNo("disablePublicAccess", "Block Internet Egress", false),
          ],
        };
      case "bucket":
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              description:
                "Globally unique. Lowercase letters, numbers, dots and hyphens; cannot start with cw- or vip-.",
            },
            zoneField(
              "Where the bucket's data lives. Put it in the same zone as the clusters that read it.",
            ),
          ],
        };
      default:
        throw new Error(`CoreWeave plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  private async clusterCreateConfig(): Promise<CreateResourceConfig> {
    const [vpcs, clusters] = await Promise.all([
      this.vpcs().catch(() => [] as CwVpc[]),
      this.clusters().catch(() => [] as CwCluster[]),
    ]);
    const versions = [
      ...new Set([...KUBERNETES_VERSIONS, ...clusters.map((c) => c.version ?? "").filter(Boolean)]),
    ];
    const prefixOptions = vpcs.flatMap((v) =>
      (v.vpcPrefixes ?? [])
        .filter((p) => p.name)
        .map((p) => ({
          id: `${v.id ?? ""}/${p.name ?? ""}`,
          label: `${v.name ?? v.id}: ${p.name}`,
          ...(p.value ? { description: p.value } : {}),
        })),
    );
    const prefixField = (key: string, label: string, description: string, match: RegExp) => {
      const preferred = prefixOptions.find((o) => match.test(o.label));
      return {
        key,
        label,
        kind: "select" as const,
        required: true,
        description,
        options: prefixOptions,
        ...(preferred ? { defaultValue: preferred.id } : {}),
      };
    };
    return {
      fields: [
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: true,
          description: "1 to 30 lowercase letters, numbers and hyphens. Cannot be changed later.",
        },
        {
          key: "vpcId",
          label: "VPC",
          kind: "select",
          required: true,
          description:
            "The cluster is created in this VPC's zone. No VPC yet? Create one first under VPCs; the default prefixes cover a cluster.",
          options: vpcs.map((v) => ({
            id: v.id ?? "",
            label: `${v.name ?? v.id} (${v.zone ?? ""})`,
          })),
        },
        {
          key: "version",
          label: "Kubernetes Version",
          kind: "select",
          required: true,
          defaultValue: versions[0] ?? "",
          options: versions.map((v) => ({ id: v, label: v })),
        },
        yesNo(
          "public",
          "Public API Server",
          true,
          "Reachable from the Internet. Infrawrench needs this (or a bastion in the VPC) to show the cluster's workloads.",
        ),
        prefixField("podCidrName", "Pod CIDR Prefix", "Must belong to the VPC you picked.", /pod/i),
        prefixField(
          "serviceCidrName",
          "Service CIDR Prefix",
          "Must belong to the VPC you picked.",
          /service/i,
        ),
        prefixField(
          "internalLbCidrName",
          "Internal Load Balancer Prefix",
          "Must belong to the VPC you picked. More can be added later in the CoreWeave Console.",
          /lb|load/i,
        ),
      ],
    };
  }

  private async nodePoolCreateConfig(parentResourceId?: string): Promise<CreateResourceConfig> {
    const fields: CreateFieldConfig[] = [];
    let zone = "";
    if (parentResourceId) {
      zone =
        (await this.clusterById(externalIdOf(parentResourceId)).catch(() => undefined))?.zone ?? "";
    } else {
      const clusters = await this.clusters().catch(() => [] as CwCluster[]);
      fields.push({
        key: "clusterId",
        label: "Cluster",
        kind: "select",
        required: true,
        options: clusters.map((c) => ({
          id: c.id ?? "",
          label: `${c.name ?? c.id} (${c.zone ?? ""})`,
        })),
      });
    }
    const types = [...INSTANCE_TYPES].sort((a, b) => {
      const az = zone && a.zones.includes(zone) ? 0 : 1;
      const bz = zone && b.zones.includes(zone) ? 0 : 1;
      return az - bz || (a.family === b.family ? 0 : a.family === "gpu" ? -1 : 1);
    });
    fields.push(
      {
        key: "name",
        label: "Name",
        kind: "text",
        required: true,
        description: "Lowercase letters, numbers and hyphens.",
      },
      {
        key: "instanceType",
        label: "Instance Type",
        kind: "select",
        required: true,
        description:
          "Cannot be changed later. Types offered in the cluster's zone are listed first; rack-scale NVL72 types are sized in racks of 18 Nodes.",
        options: types.map((t) => {
          const rate = instanceHourRate(this.rates, t.id, "on-demand");
          const hw = t.gpuModel ? `${t.gpuCount}× ${t.gpuModel}` : `${t.vcpus} vCPU`;
          const price =
            rate.source === "unpriced" ? "price on request" : `$${rate.rate.toFixed(2)}/h`;
          const where = zone && !t.zones.includes(zone) ? `, not listed in ${zone}` : "";
          return { id: t.id, label: `${t.name} (${t.id})`, description: `${hw}, ${price}${where}` };
        }),
      },
      {
        key: "computeClass",
        label: "Compute Class",
        kind: "select",
        required: true,
        defaultValue: "default",
        options: [
          { id: "default", label: "Reserved or On-Demand", description: "Standard capacity." },
          { id: "spot", label: "Spot", description: "Preemptible, with a 7-minute warning." },
        ],
      },
      {
        key: "targetNodes",
        label: "Target Nodes",
        kind: "number",
        required: false,
        defaultValue: "1",
        minValue: 0,
        description:
          "Multiples of 18 for rack-scale types. With autoscaling, between the bounds below.",
      },
      yesNo("autoscaling", "Autoscaling", false),
      {
        key: "minNodes",
        label: "Autoscaler Minimum",
        kind: "number",
        required: false,
        minValue: 0,
        showWhen: { fieldKey: "autoscaling", fieldValue: "true" },
      },
      {
        key: "maxNodes",
        label: "Autoscaler Maximum",
        kind: "number",
        required: false,
        minValue: 0,
        showWhen: { fieldKey: "autoscaling", fieldValue: "true" },
      },
      {
        key: "gpuDriver",
        label: "GPU Driver Major Version",
        kind: "text",
        required: false,
        placeholder: "Leave empty for the CKS default",
      },
    );
    return { fields };
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const name = (fields["name"] ?? "").trim();
    switch (typeId) {
      case "cks-cluster":
        return this.createCluster(accountId, name, fields);
      case "node-pool": {
        const clusterId = parentResourceId
          ? externalIdOf(parentResourceId)
          : (fields["clusterId"] ?? "").trim();
        if (!clusterId) throw new Error("Pick the cluster the Node Pool belongs to.");
        const nameError = validatePoolName(name);
        if (nameError) throw new Error(nameError);
        const instanceType = (fields["instanceType"] ?? "").trim();
        if (!instanceType) throw new Error("Pick an instance type.");
        const autoscaling = bool(fields["autoscaling"]);
        const spec = buildNodePoolSpec(
          {
            instanceType,
            targetNodes: wholeNumber("Target Nodes", fields["targetNodes"]),
            autoscaling,
            minNodes: autoscaling
              ? wholeNumber("Autoscaler minimum", fields["minNodes"])
              : undefined,
            maxNodes: autoscaling
              ? wholeNumber("Autoscaler maximum", fields["maxNodes"])
              : undefined,
            computeClass: fields["computeClass"],
          },
          (fields["gpuDriver"] ?? "").trim() || undefined,
        );
        const cluster = await this.clusterById(clusterId);
        const created = await createNodePool(this.ctx, cluster.apiServerEndpoint ?? "", {
          metadata: { name },
          spec,
        });
        this.invalidate();
        return mapNodePool(
          accountId,
          { id: clusterId, name: cluster.name ?? "" },
          created,
          this.rates,
        );
      }
      case "vpc": {
        if (!name || name.length > 30) throw new Error("VPC names are 1 to 30 characters.");
        const zone = (fields["zone"] ?? "").trim();
        if (!zone) throw new Error("Pick a zone.");
        const prefixes = parsePrefixes(fields["prefixes"] ?? "");
        const res = await cwFetch<{ vpc?: CwVpc }>(this.ctx, "/v1beta1/networking/vpcs", {
          method: "POST",
          body: JSON.stringify({
            name,
            zone,
            ...(prefixes.length > 0 ? { vpcPrefixes: prefixes } : {}),
            ingress: { disablePublicServices: bool(fields["disablePublicServices"]) },
            egress: { disablePublicAccess: bool(fields["disablePublicAccess"]) },
          }),
        });
        this.invalidate();
        if (!res?.vpc) throw new Error("CoreWeave plugin: VPC create returned no VPC");
        return mapVpc(accountId, res.vpc);
      }
      case "bucket": {
        const error = validateBucketName(name);
        if (error) throw new Error(error);
        const zone = (fields["zone"] ?? "").trim();
        if (!zone) throw new Error("Pick a zone.");
        await createBucket(this.s3, name, zone);
        this.bucketZones.set(name, zone);
        const b = await getBucket(this.ctx, name).catch(() => ({ name, location: zone }));
        return mapBucket(accountId, b, this.rates);
      }
      default:
        throw new Error(`CoreWeave plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  private async createCluster(
    accountId: string,
    name: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (!/^[a-z0-9]([-a-z0-9]{0,28}[a-z0-9])?$/.test(name)) {
      throw new Error(
        "Cluster names are 1 to 30 lowercase letters, numbers and hyphens, and cannot start or end with a hyphen.",
      );
    }
    const vpcId = (fields["vpcId"] ?? "").trim();
    const vpc = (await this.vpcs()).find((v) => v.id === vpcId);
    if (!vpc) throw new Error("Pick the VPC the cluster runs in.");
    const prefix = (key: string, label: string): string => {
      const raw = (fields[key] ?? "").trim();
      const slash = raw.indexOf("/");
      const owner = slash >= 0 ? raw.slice(0, slash) : vpcId;
      const prefixName = slash >= 0 ? raw.slice(slash + 1) : raw;
      if (!prefixName) throw new Error(`Pick the ${label}.`);
      if (owner !== vpcId || !(vpc.vpcPrefixes ?? []).some((p) => p.name === prefixName)) {
        throw new Error(
          `The ${label} "${prefixName}" is not a prefix of VPC ${vpc.name ?? vpcId}. Pick one of that VPC's prefixes, or add it to the VPC first.`,
        );
      }
      return prefixName;
    };
    const body = {
      name,
      zone: vpc.zone,
      vpcId,
      public: bool(fields["public"] ?? "true"),
      version: (fields["version"] ?? "").trim() || KUBERNETES_VERSIONS[0],
      network: {
        podCidrName: prefix("podCidrName", "pod CIDR prefix"),
        serviceCidrName: prefix("serviceCidrName", "service CIDR prefix"),
        internalLbCidrNames: [prefix("internalLbCidrName", "internal load balancer prefix")],
      },
    };
    const res = await cwFetch<{ cluster?: CwCluster }>(this.ctx, "/v1beta1/cks/clusters", {
      method: "POST",
      body: JSON.stringify(body),
    });
    this.invalidate();
    if (!res?.cluster) throw new Error("CoreWeave plugin: cluster create returned no cluster");
    return mapCluster(accountId, res.cluster, vpc.name);
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "cks-cluster": {
        const current = await this.clusterById(id);
        const mask: string[] = [];
        const body: Record<string, unknown> = { id, version: current.version };
        if ("version" in fields) {
          const version = (fields["version"] ?? "").trim();
          if (!/^v\d+\.\d+$/.test(version)) throw new Error("Use a minor version such as v1.36.");
          body["version"] = version;
          mask.push("version");
        }
        if ("public" in fields) {
          body["public"] = bool(fields["public"]);
          mask.push("public");
        }
        if (mask.length === 0) return this.getResource(typeId, resourceId, accountId);
        await cwFetch<unknown>(this.ctx, `/v1beta1/cks/clusters/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify({ ...body, updateMask: mask.join(",") }),
        });
        this.invalidate();
        return this.getResource(typeId, resourceId, accountId);
      }
      case "node-pool":
        return this.updateNodePool(resourceId, accountId, fields);
      case "vpc": {
        const res = await cwFetch<{ vpc?: CwVpc }>(
          this.ctx,
          `/v1beta1/networking/vpcs/${encodeURIComponent(id)}`,
        );
        const vpc = res?.vpc;
        if (!vpc) throw new Error(`CoreWeave plugin: VPC ${id} not found`);
        const mask: string[] = [];
        const body: Record<string, unknown> = { id };
        if ("prefixes" in fields) {
          body["vpcPrefixes"] = parsePrefixes(fields["prefixes"] ?? "");
          mask.push("vpcPrefixes");
        }
        if ("disablePublicServices" in fields) {
          body["ingress"] = { disablePublicServices: bool(fields["disablePublicServices"]) };
          mask.push("ingress");
        }
        if ("disablePublicAccess" in fields) {
          body["egress"] = { disablePublicAccess: bool(fields["disablePublicAccess"]) };
          mask.push("egress");
        }
        if (mask.length > 0) {
          await cwFetch<unknown>(this.ctx, `/v1beta1/networking/vpcs/${encodeURIComponent(id)}`, {
            method: "PATCH",
            body: JSON.stringify({ ...body, updateMask: mask.join(",") }),
          });
          this.invalidate();
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "bucket": {
        const settings: BucketSettingsInput = {};
        const current = await getBucket(this.ctx, id);
        if ("auditLogging" in fields) settings.auditLoggingEnabled = bool(fields["auditLogging"]);
        const archiveOn =
          "archiveEnabled" in fields
            ? bool(fields["archiveEnabled"])
            : current.settings?.archiveEnabled === true;
        if ("archiveEnabled" in fields) settings.archiveEnabled = archiveOn;
        if ("archiveAfterDays" in fields || ("archiveEnabled" in fields && archiveOn)) {
          const days =
            wholeNumber("Archive after", fields["archiveAfterDays"]) ??
            current.settings?.archiveAfterLastAccessDays;
          if (archiveOn && (days === undefined || days < 1)) {
            throw new Error("Archiving needs the number of days without access, 1 or more.");
          }
          if (days !== undefined) settings.archiveAfterLastAccessDays = days;
        }
        if ("capacityCapGb" in fields) {
          const raw = (fields["capacityCapGb"] ?? "").trim();
          if (raw !== "") {
            const gb = Number(raw);
            if (!Number.isFinite(gb) || gb < 0)
              throw new Error("The capacity cap must be 0 GB or more.");
            settings.capacityCapBytes = String(Math.round(gb * 1e9));
          }
        }
        if (Object.keys(settings).length > 0) await setBucketSettings(this.ctx, id, settings);
        return this.getResource(typeId, resourceId, accountId);
      }
      default:
        throw new Error(`CoreWeave plugin: "${typeId}" cannot be edited from Infrawrench`);
    }
  }

  private async updateNodePool(
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const { clusterId, name } = this.splitPoolId(resourceId);
    const cluster = await this.clusterById(clusterId);
    const endpoint = cluster.apiServerEndpoint ?? "";
    const pool = await getNodePool(this.ctx, endpoint, name);
    const spec = pool.spec ?? {};
    const autoscaling =
      "autoscaling" in fields ? bool(fields["autoscaling"]) : spec.autoscaling === true;
    const pick = (
      key: "targetNodes" | "minNodes" | "maxNodes",
      label: string,
      current: number | undefined,
    ) => (key in fields ? wholeNumber(label, fields[key]) : current);
    const targetNodes = pick("targetNodes", "Target Nodes", targetNodesOf(pool));
    const minNodes = pick("minNodes", "Autoscaler minimum", spec.minNodes);
    const maxNodes = pick("maxNodes", "Autoscaler maximum", spec.maxNodes);
    const instanceType = spec.instanceType ?? "";
    validatePoolSize({
      instanceType,
      targetNodes,
      autoscaling,
      minNodes,
      maxNodes,
      computeClass: spec.computeClass,
    });
    const patch: Record<string, unknown> = {};
    if ("targetNodes" in fields && targetNodes !== undefined) {
      const usesRacks = typeof spec.targetRacks === "number" && spec.targetNodes === undefined;
      if (usesRacks && isRackScale(instanceType)) patch["targetRacks"] = targetNodes / 18;
      else patch["targetNodes"] = targetNodes;
    }
    if ("autoscaling" in fields) patch["autoscaling"] = autoscaling;
    if (autoscaling && ("minNodes" in fields || "autoscaling" in fields) && minNodes !== undefined)
      patch["minNodes"] = minNodes;
    if (autoscaling && ("maxNodes" in fields || "autoscaling" in fields) && maxNodes !== undefined)
      patch["maxNodes"] = maxNodes;
    if ("scaleDownStrategy" in fields && fields["scaleDownStrategy"]) {
      patch["lifecycle"] = { scaleDownStrategy: fields["scaleDownStrategy"] };
    }
    if (Object.keys(patch).length === 0) {
      return mapNodePool(accountId, { id: clusterId, name: cluster.name ?? "" }, pool, this.rates);
    }
    const updated = await patchNodePool(this.ctx, endpoint, name, { spec: patch });
    this.invalidate();
    return mapNodePool(accountId, { id: clusterId, name: cluster.name ?? "" }, updated, this.rates);
  }

  // -------------------------------------------------------------------------
  // Delete and actions
  // -------------------------------------------------------------------------

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "cks-cluster":
        await cwFetch<unknown>(this.ctx, `/v1beta1/cks/clusters/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        break;
      case "node-pool": {
        const { clusterId, name } = this.splitPoolId(resourceId);
        const cluster = await this.clusterById(clusterId);
        await deleteNodePool(this.ctx, cluster.apiServerEndpoint ?? "", name);
        break;
      }
      case "vpc":
        await cwFetch<unknown>(this.ctx, `/v1beta1/networking/vpcs/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        break;
      case "bucket":
        await deleteBucket(this.s3, id, await this.bucketZone(id));
        this.bucketZones.delete(id);
        break;
      default:
        throw new Error(`CoreWeave plugin: "${typeId}" cannot be deleted from Infrawrench`);
    }
    this.invalidate();
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    if (typeId === "node-pool" && (actionId === "scale-to-zero" || actionId === "restore")) {
      const { clusterId, name } = this.splitPoolId(resourceId);
      const cluster = await this.clusterById(clusterId);
      const endpoint = cluster.apiServerEndpoint ?? "";
      const pool = await getNodePool(this.ctx, endpoint, name);
      if (actionId === "scale-to-zero") {
        if (targetNodesOf(pool) === 0 && !pool.spec?.autoscaling) return;
        await patchNodePool(this.ctx, endpoint, name, scaleToZeroPatch(pool));
      } else {
        await patchNodePool(this.ctx, endpoint, name, restorePatch(pool));
      }
      this.invalidate();
      return;
    }
    if (
      typeId === "access-key" &&
      (actionId === "suspend-principal" || actionId === "activate-principal")
    ) {
      const key = await this.getResource(typeId, resourceId, accountId);
      const principal = String(key.fields["principal"] ?? "");
      if (!principal) throw new Error("CoreWeave did not report an owner for this access key.");
      await setPrincipalKeyStatus(
        this.ctx,
        principal,
        actionId === "suspend-principal" ? "SUSPENDED" : "ACTIVE",
      );
      return;
    }
    throw new Error(`CoreWeave plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Storage browser
  // -------------------------------------------------------------------------

  private async bucketZone(bucket: string): Promise<string> {
    const known = this.bucketZones.get(bucket);
    if (known) return known;
    const b = await getBucket(this.ctx, bucket);
    if (!b.location) throw new Error(`CoreWeave plugin: bucket "${bucket}" reported no zone`);
    this.bucketZones.set(bucket, b.location);
    return b.location;
  }

  async listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    return listS3Objects(await s3ConfigFor(this.s3, await this.bucketZone(bucket)), bucket, prefix);
  }

  async uploadStorageObject(bucket: string, key: string, file: File): Promise<void> {
    return uploadS3Object(
      await s3ConfigFor(this.s3, await this.bucketZone(bucket)),
      bucket,
      key,
      file,
    );
  }

  async makeStorageFolder(bucket: string, key: string): Promise<void> {
    return makeS3Folder(await s3ConfigFor(this.s3, await this.bucketZone(bucket)), bucket, key);
  }

  async deleteStorageObject(bucket: string, key: string): Promise<void> {
    return deleteS3Object(await s3ConfigFor(this.s3, await this.bucketZone(bucket)), bucket, key);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderCoreWeaveDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderCoreWeaveSidebar(resource);
  }
}
