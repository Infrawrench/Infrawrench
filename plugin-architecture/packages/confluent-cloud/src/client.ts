import type {
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  CreateSizePricingRequest,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  PreflightResult,
  ResourceInstance,
  SidebarItemSchema,
  SizeOption,
} from "@infrawrench/plugin-base";
import type { ConfluentContext } from "./api.js";
import { ccFetch, ccList, statusOf } from "./api.js";
import type { CostContext, ResourceLocation } from "./cost-data.js";
import { ckuHourlyRates, fetchConfluentCostData } from "./cost-data.js";
import type { ClusterUsage, ConnectionKind } from "./mappers.js";
import {
  CONNECTION_PATHS,
  PLUGIN_ID,
  bootstrapHost,
  connectionKindForSlug,
  connectorRoute,
  envScoped,
  mapApiKey,
  mapComputePool,
  mapConnector,
  mapEncryptionKey,
  mapEnvironment,
  mapKafkaCluster,
  mapKsqlCluster,
  mapNetwork,
  mapNetworkConnection,
  mapSchemaRegistry,
  mapServiceAccount,
  routeOf,
} from "./mappers.js";
import type { SeriesSpec } from "./metrics.js";
import {
  CLUSTER_SERIES,
  COMPUTE_POOL_SERIES,
  CONNECTOR_SERIES,
  KSQL_SERIES,
  SCHEMA_REGISTRY_SERIES,
  fetchClusterUsage,
  fetchConnectorUsage,
  rangeOrDefault,
  seriesFor,
} from "./metrics.js";
import { verifyConfluentCredentials } from "./preflight.js";
import { renderConfluentDetail, renderConfluentSidebar } from "./render.js";
import { CREATE_KAFKA_KEY_COMMAND } from "./resource-types.js";
import type {
  CcApiKey,
  CcByokKey,
  CcComputePool,
  CcConnectorExpanded,
  CcEnvironment,
  CcFlinkRegion,
  CcKafkaCluster,
  CcKsqlCluster,
  CcNetwork,
  CcNetworkConnection,
  CcPrivateLinkAttachment,
  CcSchemaRegistry,
  CcServiceAccount,
} from "./types.js";

/** Secret field keys the minted cluster API key is stored under, per cluster resource. */
export const KAFKA_KEY_FIELD = "kafkaApiKey";
export const KAFKA_SECRET_FIELD = "kafkaApiSecret";

const CACHE_MS = 60_000;
const HOURS_PER_MONTH = 730;
/** The rightsizing catalog: CKU counts a Dedicated cluster can be sized to. */
const MAX_CATALOG_CKU = 24;
const RATE_CACHE_MS = 6 * 60 * 60 * 1000;

const ELASTIC_TYPES = new Set(["Basic", "Standard", "Enterprise", "Freight"]);

function parseValues(args: (string | number)[]): Record<string, string> {
  const first = args[0];
  if (typeof first !== "string" || !first) return {};
  try {
    const parsed = JSON.parse(first) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v ?? "")]));
  } catch {
    return {};
  }
}

/** A resource-picker may hand back a plain id or a resource id (`acc:type:sa-…`). */
function pickedId(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  const last = value.split(":").pop() ?? value;
  return last.split("/").pop() ?? last;
}

function positiveInt(raw: string | undefined, label: string): number {
  const n = Number((raw ?? "").trim());
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`${label} must be a whole number of at least 1.`);
  return n;
}

export class ConfluentCloudClient implements PluginClient {
  private readonly ctx: ConfluentContext;
  private readonly services: HostServices | undefined;
  private envCache: { at: number; value: Promise<CcEnvironment[]> } | undefined;
  private clusterCache: { at: number; value: Promise<CcKafkaCluster[]> } | undefined;
  private rateCache: { at: number; value: Promise<Map<string, number>> } | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    const apiSecret = (credentials["apiSecret"] ?? "").trim();
    if (!apiKey) throw new Error("Confluent Cloud plugin: missing apiKey credential");
    if (!apiSecret) throw new Error("Confluent Cloud plugin: missing apiSecret credential");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      apiKey,
      apiSecret,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
    this.services = services;
  }

  // -------------------------------------------------------------------------
  // Shared reads
  // -------------------------------------------------------------------------

  private environments(): Promise<CcEnvironment[]> {
    if (!this.envCache || Date.now() - this.envCache.at > CACHE_MS) {
      const value = ccList<CcEnvironment>(this.ctx, "/org/v2/environments");
      value.catch(() => (this.envCache = undefined));
      this.envCache = { at: Date.now(), value };
    }
    return this.envCache.value;
  }

  private async envNames(): Promise<Map<string, string>> {
    const envs = await this.environments().catch(() => [] as CcEnvironment[]);
    return new Map(envs.map((e) => [e.id ?? "", e.display_name ?? e.id ?? ""]));
  }

  /**
   * Run `load` once per environment and concatenate. A 403 on one
   * environment means the key's owner has no role there; the others still
   * list.
   */
  private async perEnvironment<T>(load: (env: string) => Promise<T[]>): Promise<T[]> {
    const envs = await this.environments();
    const batches = await Promise.all(
      envs.map((e) =>
        load(e.id ?? "").catch((err: unknown) => {
          if (statusOf(err) === 403) return [] as T[];
          throw err;
        }),
      ),
    );
    return batches.flat();
  }

  private clusters(): Promise<CcKafkaCluster[]> {
    if (!this.clusterCache || Date.now() - this.clusterCache.at > CACHE_MS) {
      const value = this.perEnvironment((env) =>
        ccList<CcKafkaCluster>(this.ctx, "/cmk/v2/clusters", { environment: env }),
      );
      value.catch(() => (this.clusterCache = undefined));
      this.clusterCache = { at: Date.now(), value };
    }
    return this.clusterCache.value;
  }

  /** A 403 lists the type empty (no role for it); 401 still throws. */
  private async scoped(load: () => Promise<ResourceInstance[]>): Promise<ResourceInstance[]> {
    try {
      return await load();
    } catch (err) {
      if (statusOf(err) === 403) return [];
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "environment":
        return (await this.environments()).map((e) => mapEnvironment(accountId, e));
      case "kafka-cluster":
        return this.listClusters(accountId);
      case "connector":
        return this.scoped(() => this.listConnectors(accountId));
      case "flink-compute-pool":
        return this.scoped(async () =>
          (
            await this.perEnvironment((env) =>
              ccList<CcComputePool>(this.ctx, "/fcpm/v2/compute-pools", { environment: env }),
            )
          ).map((p) => mapComputePool(accountId, p)),
        );
      case "ksqldb-cluster":
        return this.scoped(async () =>
          (
            await this.perEnvironment((env) =>
              ccList<CcKsqlCluster>(this.ctx, "/ksqldbcm/v2/clusters", { environment: env }),
            )
          ).map((k) => mapKsqlCluster(accountId, k)),
        );
      case "schema-registry":
        return this.scoped(async () =>
          (
            await this.perEnvironment((env) =>
              ccList<CcSchemaRegistry>(this.ctx, "/srcm/v3/clusters", { environment: env }),
            )
          ).map((s) => mapSchemaRegistry(accountId, s)),
        );
      case "service-account":
        return this.scoped(async () =>
          (await ccList<CcServiceAccount>(this.ctx, "/iam/v2/service-accounts")).map((s) =>
            mapServiceAccount(accountId, s),
          ),
        );
      case "api-key":
        return this.scoped(() => this.listApiKeys(accountId));
      case "network":
        return this.scoped(async () =>
          (
            await this.perEnvironment((env) =>
              ccList<CcNetwork>(this.ctx, "/networking/v1/networks", { environment: env }),
            )
          ).map((n) => mapNetwork(accountId, n)),
        );
      case "network-connection":
        return this.scoped(() => this.listNetworkConnections(accountId));
      case "encryption-key":
        return this.scoped(async () =>
          (await ccList<CcByokKey>(this.ctx, "/byok/v1/keys")).map((k) =>
            mapEncryptionKey(accountId, k),
          ),
        );
      default:
        throw new Error(`Confluent Cloud plugin: unknown resource type "${typeId}"`);
    }
  }

  private async listClusters(accountId: string): Promise<ResourceInstance[]> {
    const [clusters, names] = await Promise.all([this.clusters(), this.envNames()]);
    const ids = clusters.map((c) => c.id ?? "").filter(Boolean);
    const usage = await fetchClusterUsage(this.ctx, ids).catch(() => undefined);
    return clusters.map((c) => {
      const id = c.id ?? "";
      const u: ClusterUsage = {};
      if (usage) {
        if (usage.topics.has(id)) u.topics = usage.topics.get(id)!;
        if (usage.partitions.size > 0 || usage.topics.size > 0) {
          u.partitions = usage.partitions.get(id) ?? 0;
        }
        if (usage.retainedBytes.size > 0 || usage.topics.size > 0) {
          u.retainedBytes = usage.retainedBytes.get(id) ?? 0;
        }
        if (usage.throughputKnown) {
          u.bytesIn7d = usage.bytesIn.get(id) ?? 0;
          u.bytesOut7d = usage.bytesOut.get(id) ?? 0;
        }
      }
      return mapKafkaCluster(accountId, c, names.get(c.spec?.environment?.id ?? ""), u);
    });
  }

  private async fetchConnectors(
    env: string,
    cluster: string,
  ): Promise<Record<string, CcConnectorExpanded>> {
    return (
      (await ccFetch<Record<string, CcConnectorExpanded>>(
        this.ctx,
        `/connect/v1/environments/${encodeURIComponent(env)}/clusters/${encodeURIComponent(cluster)}/connectors`,
        { query: { expand: "info,status,id" } },
      )) ?? {}
    );
  }

  private async listConnectors(accountId: string): Promise<ResourceInstance[]> {
    const clusters = await this.clusters();
    const found: Array<{ env: string; cluster: string; name: string; c: CcConnectorExpanded }> = [];
    await Promise.all(
      clusters.map(async (cl) => {
        const env = cl.spec?.environment?.id ?? "";
        const cluster = cl.id ?? "";
        if (!env || !cluster) return;
        const byName = await this.fetchConnectors(env, cluster).catch((err: unknown) => {
          // Clusters still provisioning, or without managed Connect, answer 4xx.
          if (statusOf(err) >= 400 && statusOf(err) < 500) return {};
          throw err;
        });
        for (const [name, c] of Object.entries(byName)) found.push({ env, cluster, name, c });
      }),
    );
    const ids = found.map((x) => x.c.id?.id ?? "").filter(Boolean);
    const usage = await fetchConnectorUsage(this.ctx, ids).catch(() => undefined);
    return found.map(({ env, cluster, name, c }) => {
      const id = c.id?.id ?? "";
      return mapConnector(
        accountId,
        env,
        cluster,
        name,
        c,
        usage?.known && id
          ? {
              recordsIn7d: usage.recordsIn.get(id) ?? 0,
              recordsOut7d: usage.recordsOut.get(id) ?? 0,
            }
          : undefined,
      );
    });
  }

  private async listApiKeys(accountId: string): Promise<ResourceInstance[]> {
    const [keys, accounts] = await Promise.all([
      ccList<CcApiKey>(this.ctx, "/iam/v2/api-keys"),
      ccList<CcServiceAccount>(this.ctx, "/iam/v2/service-accounts").catch(
        () => [] as CcServiceAccount[],
      ),
    ]);
    const names = new Map(accounts.map((a) => [a.id ?? "", a.display_name ?? ""]));
    return keys.map((k) => mapApiKey(accountId, k, names));
  }

  private async listNetworkConnections(accountId: string): Promise<ResourceInstance[]> {
    const kinds = Object.keys(CONNECTION_PATHS) as ConnectionKind[];
    const all = await Promise.all(
      kinds.map(async (kind) =>
        (
          await this.perEnvironment((env) =>
            ccList<CcNetworkConnection | CcPrivateLinkAttachment>(
              this.ctx,
              CONNECTION_PATHS[kind].path,
              { environment: env },
            ),
          ).catch((err: unknown) => {
            if (statusOf(err) === 403) return [];
            throw err;
          })
        ).map((c) => mapNetworkConnection(accountId, kind, c)),
      ),
    );
    return all.flat();
  }

  // -------------------------------------------------------------------------
  // Single reads
  // -------------------------------------------------------------------------

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const { env, id } = envScoped(resourceId);
    switch (typeId) {
      case "environment": {
        const e = await ccFetch<CcEnvironment>(
          this.ctx,
          `/org/v2/environments/${encodeURIComponent(routeOf(resourceId)[0] ?? "")}`,
        );
        return mapEnvironment(accountId, e);
      }
      case "kafka-cluster": {
        const c = await ccFetch<CcKafkaCluster>(
          this.ctx,
          `/cmk/v2/clusters/${encodeURIComponent(id)}`,
          { query: { environment: env } },
        );
        const names = await this.envNames();
        const usage = await fetchClusterUsage(this.ctx, [id]).catch(() => undefined);
        const u: ClusterUsage = {};
        if (usage) {
          if (usage.topics.has(id)) u.topics = usage.topics.get(id)!;
          u.partitions = usage.partitions.get(id) ?? 0;
          u.retainedBytes = usage.retainedBytes.get(id) ?? 0;
          if (usage.throughputKnown) {
            u.bytesIn7d = usage.bytesIn.get(id) ?? 0;
            u.bytesOut7d = usage.bytesOut.get(id) ?? 0;
          }
        }
        return mapKafkaCluster(accountId, c, names.get(env), u);
      }
      case "connector": {
        const r = connectorRoute(resourceId);
        const byName = await this.fetchConnectors(r.env, r.cluster);
        const c = byName[r.name];
        if (!c) throw new Error(`Confluent Cloud plugin: connector ${r.name} not found`);
        return mapConnector(accountId, r.env, r.cluster, r.name, c);
      }
      case "flink-compute-pool":
        return mapComputePool(
          accountId,
          await ccFetch<CcComputePool>(
            this.ctx,
            `/fcpm/v2/compute-pools/${encodeURIComponent(id)}`,
            {
              query: { environment: env },
            },
          ),
        );
      case "ksqldb-cluster":
        return mapKsqlCluster(
          accountId,
          await ccFetch<CcKsqlCluster>(
            this.ctx,
            `/ksqldbcm/v2/clusters/${encodeURIComponent(id)}`,
            {
              query: { environment: env },
            },
          ),
        );
      case "schema-registry":
        return mapSchemaRegistry(
          accountId,
          await ccFetch<CcSchemaRegistry>(this.ctx, `/srcm/v3/clusters/${encodeURIComponent(id)}`, {
            query: { environment: env },
          }),
        );
      case "service-account":
        return mapServiceAccount(
          accountId,
          await ccFetch<CcServiceAccount>(
            this.ctx,
            `/iam/v2/service-accounts/${encodeURIComponent(routeOf(resourceId)[0] ?? "")}`,
          ),
        );
      case "network":
        return mapNetwork(
          accountId,
          await ccFetch<CcNetwork>(this.ctx, `/networking/v1/networks/${encodeURIComponent(id)}`, {
            query: { environment: env },
          }),
        );
      case "network-connection": {
        const [connEnv = "", slug = "", connId = ""] = routeOf(resourceId);
        const kind = connectionKindForSlug(slug);
        if (kind) {
          const c = await ccFetch<CcNetworkConnection>(
            this.ctx,
            `${CONNECTION_PATHS[kind].path}/${encodeURIComponent(connId)}`,
            { query: { environment: connEnv } },
          );
          return mapNetworkConnection(accountId, kind, c);
        }
        break;
      }
      default:
        break;
    }
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found)
      throw new Error(`Confluent Cloud plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "kafka-cluster" && outputKey === "connectionString") {
      return this.kafkaConnectionString(resourceId, accountId);
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    const resolved = resource.resolvedOutputs[outputKey];
    if (resolved !== undefined) return resolved;
    const field = resource.fields[outputKey];
    if (field !== undefined) return String(field);
    throw new Error(
      `Confluent Cloud plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
    );
  }

  /**
   * `kafka://` URL the Kafka plugin understands: SASL/PLAIN over TLS with
   * the cluster API key minted by `create-kafka-api-key`. Credentials ride
   * as query parameters so an API secret's `+` and `/` survive intact.
   */
  private async kafkaConnectionString(resourceId: string, accountId: string): Promise<string> {
    const secrets = this.services?.secrets;
    const [key, secret] = secrets
      ? await Promise.all([
          secrets.getPlaintext(resourceId, KAFKA_KEY_FIELD),
          secrets.getPlaintext(resourceId, KAFKA_SECRET_FIELD),
        ])
      : [null, null];
    if (!key || !secret) {
      throw new Error(
        "No Kafka API key is stored for this cluster yet. Use Create Kafka API key to make one; Confluent only shows a key's secret when it is created.",
      );
    }
    const cluster = await this.getResource("kafka-cluster", resourceId, accountId);
    const host = bootstrapHost(String(cluster.fields["bootstrapEndpoint"] ?? ""));
    if (!host) throw new Error("This cluster has no bootstrap endpoint yet.");
    const params = new URLSearchParams({ sasl: "plain", ssl: "true", user: key, password: secret });
    return `kafka://${host}?${params.toString()}`;
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    const envField = async () => {
      const envs = await this.environments().catch(() => [] as CcEnvironment[]);
      return {
        key: "environmentId",
        label: "Environment",
        kind: "select" as const,
        required: true,
        options: envs.map((e) => ({ id: e.id ?? "", label: e.display_name || e.id || "" })),
        ...(envs[0]?.id ? { defaultValue: envs[0].id } : {}),
      };
    };
    switch (typeId) {
      case "environment":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "production" },
            {
              key: "streamGovernance",
              label: "Stream Governance package",
              kind: "select",
              required: true,
              defaultValue: "ESSENTIALS",
              options: [
                { id: "ESSENTIALS", label: "Essentials" },
                { id: "ADVANCED", label: "Advanced" },
              ],
              description:
                "Essentials includes Schema Registry; Advanced adds the stream catalog, lineage and data quality rules and is billed per hour.",
            },
          ],
        };
      case "flink-compute-pool": {
        const regions = await ccList<CcFlinkRegion>(this.ctx, "/fcpm/v2/regions").catch(
          () => [] as CcFlinkRegion[],
        );
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            ...(parentResourceId ? [] : [await envField()]),
            {
              key: "region",
              label: "Region",
              kind: "region-picker",
              required: true,
              regions: regions.map((r) => ({
                id: `${r.cloud ?? ""}:${r.region_name ?? ""}`,
                label: r.region_name ?? r.id ?? "",
                location: [r.cloud, r.display_name].filter(Boolean).join(" "),
              })),
            },
            {
              key: "maxCfu",
              label: "Max CFUs",
              kind: "select",
              required: true,
              defaultValue: "10",
              options: ["5", "10", "20", "30", "40", "50"].map((v) => ({ id: v, label: v })),
              description: "The pool scales up to this many CFUs and bills per CFU-minute used.",
            },
          ],
        };
      }
      case "service-account":
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              description: "Unique in the organization; cannot be changed later.",
            },
            { key: "description", label: "Description", kind: "text", required: false },
          ],
        };
      case "kafka-cluster": {
        // Not offered as a create form (supportsCreate is false): this is the
        // CKU catalog the Oversized finder reads. "vCPUs" are CKUs and memory
        // scales with them, so its projection is load x current / candidate.
        const sizes: SizeOption[] = [];
        for (let n = 1; n <= MAX_CATALOG_CKU; n++) {
          sizes.push({
            id: String(n),
            label: `${n} CKU${n === 1 ? "" : "s"}`,
            vcpus: n,
            memoryMb: n * 1024,
          });
        }
        return {
          fields: [{ key: "cku", label: "CKUs", kind: "size-picker", required: true, sizes }],
        };
      }
      default:
        throw new Error(`Confluent Cloud plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  /**
   * Monthly price per CKU count at a placement, from what this organization
   * actually paid per CKU-hour there over the last month (Billing Costs API).
   * Multi-zone placements omit 1 CKU, which Confluent does not allow, so the
   * Oversized finder never recommends it.
   */
  async getCreateSizePricing(
    typeId: string,
    request: CreateSizePricingRequest,
  ): Promise<Record<string, number>> {
    if (typeId !== "kafka-cluster" || !request.regionId) return {};
    const rates = await this.ckuRates();
    const hourly = rates.get(request.regionId);
    if (!hourly) return {};
    const multiZone = request.regionId.toUpperCase().endsWith("/MULTI_ZONE");
    const out: Record<string, number> = {};
    for (const s of request.sizes) {
      const n = Number(s.id);
      if (!Number.isInteger(n) || n < 1 || (multiZone && n < 2)) continue;
      out[s.id] = Math.round(hourly * HOURS_PER_MONTH * n * 100) / 100;
    }
    return out;
  }

  private ckuRates(): Promise<Map<string, number>> {
    if (!this.rateCache || Date.now() - this.rateCache.at > RATE_CACHE_MS) {
      const value = (async () => {
        const clusters = await this.clusters();
        const placements = new Map<string, string>();
        for (const c of clusters) {
          const mapped = mapKafkaCluster("", c);
          const placement = String(mapped.fields["placement"] ?? "");
          if (c.id && placement) placements.set(c.id, placement);
        }
        return ckuHourlyRates(this.ctx, placements);
      })();
      value.catch(() => (this.rateCache = undefined));
      this.rateCache = { at: Date.now(), value };
    }
    return this.rateCache.value;
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const name = (fields["name"] ?? "").trim();
    if (!name) throw new Error("Name is required.");
    switch (typeId) {
      case "environment": {
        const e = await ccFetch<CcEnvironment>(this.ctx, "/org/v2/environments", {
          method: "POST",
          body: JSON.stringify({
            display_name: name,
            stream_governance_config: { package: fields["streamGovernance"] || "ESSENTIALS" },
          }),
        });
        this.envCache = undefined;
        return mapEnvironment(accountId, e);
      }
      case "flink-compute-pool": {
        const env =
          (fields["environmentId"] ?? "").trim() ||
          (parentResourceId ? (routeOf(parentResourceId)[0] ?? "") : "");
        if (!env) throw new Error("Pick an environment.");
        const [cloud = "", region = ""] = (fields["region"] ?? "").split(":");
        if (!cloud || !region) throw new Error("Pick a region.");
        const p = await ccFetch<CcComputePool>(this.ctx, "/fcpm/v2/compute-pools", {
          method: "POST",
          body: JSON.stringify({
            spec: {
              display_name: name,
              cloud,
              region,
              max_cfu: positiveInt(fields["maxCfu"], "Max CFUs"),
              environment: { id: env },
            },
          }),
        });
        return mapComputePool(accountId, p);
      }
      case "service-account": {
        const s = await ccFetch<CcServiceAccount>(this.ctx, "/iam/v2/service-accounts", {
          method: "POST",
          body: JSON.stringify({
            display_name: name,
            ...(fields["description"] ? { description: fields["description"] } : {}),
          }),
        });
        return mapServiceAccount(accountId, s);
      }
      default:
        throw new Error(`Confluent Cloud plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const { env, id } = envScoped(resourceId);
    switch (typeId) {
      case "environment": {
        const body: Record<string, unknown> = {};
        if ("name" in fields) body["display_name"] = (fields["name"] ?? "").trim();
        if (fields["streamGovernance"]) {
          body["stream_governance_config"] = { package: fields["streamGovernance"] };
        }
        const e = await ccFetch<CcEnvironment>(
          this.ctx,
          `/org/v2/environments/${encodeURIComponent(routeOf(resourceId)[0] ?? "")}`,
          { method: "PATCH", body: JSON.stringify(body) },
        );
        this.envCache = undefined;
        return mapEnvironment(accountId, e);
      }
      case "kafka-cluster":
        return this.updateCluster(resourceId, accountId, fields);
      case "flink-compute-pool": {
        const spec: Record<string, unknown> = { environment: { id: env } };
        if ("name" in fields) spec["display_name"] = (fields["name"] ?? "").trim();
        if ("maxCfu" in fields) spec["max_cfu"] = positiveInt(fields["maxCfu"], "Max CFUs");
        const p = await ccFetch<CcComputePool>(
          this.ctx,
          `/fcpm/v2/compute-pools/${encodeURIComponent(id)}`,
          { method: "PATCH", body: JSON.stringify({ spec }) },
        );
        return mapComputePool(accountId, p);
      }
      case "service-account": {
        const s = await ccFetch<CcServiceAccount>(
          this.ctx,
          `/iam/v2/service-accounts/${encodeURIComponent(routeOf(resourceId)[0] ?? "")}`,
          { method: "PATCH", body: JSON.stringify({ description: fields["description"] ?? "" }) },
        );
        return mapServiceAccount(accountId, s);
      }
      case "api-key": {
        const spec: Record<string, unknown> = {};
        if ("name" in fields) spec["display_name"] = fields["name"] ?? "";
        if ("description" in fields) spec["description"] = fields["description"] ?? "";
        await ccFetch<CcApiKey>(
          this.ctx,
          `/iam/v2/api-keys/${encodeURIComponent(routeOf(resourceId)[0] ?? "")}`,
          { method: "PATCH", body: JSON.stringify({ spec }) },
        );
        return this.getResource("api-key", resourceId, accountId);
      }
      default:
        throw new Error(`Confluent Cloud plugin: "${typeId}" cannot be edited from Infrawrench`);
    }
  }

  /**
   * `PATCH /cmk/v2/clusters/{id}`: rename, resize a Dedicated cluster's
   * CKUs, or move an elastic cluster's eCKU ceiling. The spec wants the
   * environment and the config's `kind` on every update.
   */
  private async updateCluster(
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const { env, id } = envScoped(resourceId);
    const current = await ccFetch<CcKafkaCluster>(
      this.ctx,
      `/cmk/v2/clusters/${encodeURIComponent(id)}`,
      { query: { environment: env } },
    );
    const kind = current.spec?.config?.kind ?? "";
    const spec: Record<string, unknown> = { environment: { id: env } };
    if ("name" in fields && fields["name"]?.trim()) spec["display_name"] = fields["name"].trim();
    if ("cku" in fields && fields["cku"]) {
      if (kind !== "Dedicated") throw new Error("Only Dedicated clusters are sized in CKUs.");
      const cku = positiveInt(fields["cku"], "CKUs");
      if ((current.spec?.availability ?? "").toUpperCase().includes("MULTI") && cku < 2) {
        throw new Error("Multi-zone Dedicated clusters need at least 2 CKUs.");
      }
      spec["config"] = { kind, cku };
    }
    if ("maxEcku" in fields && fields["maxEcku"]) {
      if (!ELASTIC_TYPES.has(kind)) {
        throw new Error(
          "Only Basic, Standard, Enterprise and Freight clusters have an eCKU ceiling.",
        );
      }
      spec["config"] = { kind, max_ecku: positiveInt(fields["maxEcku"], "Max eCKUs") };
    }
    const c = await ccFetch<CcKafkaCluster>(
      this.ctx,
      `/cmk/v2/clusters/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ spec }),
      },
    );
    this.clusterCache = undefined;
    const names = await this.envNames();
    return mapKafkaCluster(accountId, c ?? current, names.get(env));
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const { env, id } = envScoped(resourceId);
    const del = (path: string, query?: Record<string, string>) =>
      ccFetch<unknown>(this.ctx, path, { method: "DELETE", ...(query ? { query } : {}) });
    switch (typeId) {
      case "environment":
        await del(`/org/v2/environments/${encodeURIComponent(routeOf(resourceId)[0] ?? "")}`);
        this.envCache = undefined;
        return;
      case "kafka-cluster":
        await del(`/cmk/v2/clusters/${encodeURIComponent(id)}`, { environment: env });
        this.clusterCache = undefined;
        return;
      case "connector": {
        const r = connectorRoute(resourceId);
        await del(
          `/connect/v1/environments/${encodeURIComponent(r.env)}/clusters/${encodeURIComponent(r.cluster)}/connectors/${encodeURIComponent(r.name)}`,
        );
        return;
      }
      case "flink-compute-pool":
        await del(`/fcpm/v2/compute-pools/${encodeURIComponent(id)}`, { environment: env });
        return;
      case "ksqldb-cluster":
        await del(`/ksqldbcm/v2/clusters/${encodeURIComponent(id)}`, { environment: env });
        return;
      case "service-account":
        await del(`/iam/v2/service-accounts/${encodeURIComponent(routeOf(resourceId)[0] ?? "")}`);
        return;
      case "api-key":
        await del(`/iam/v2/api-keys/${encodeURIComponent(routeOf(resourceId)[0] ?? "")}`);
        return;
      default:
        throw new Error(`Confluent Cloud plugin: "${typeId}" cannot be deleted from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    if (typeId === "connector" && ["pause", "resume", "restart"].includes(actionId)) {
      const r = connectorRoute(resourceId);
      const base = `/connect/v1/environments/${encodeURIComponent(r.env)}/clusters/${encodeURIComponent(r.cluster)}/connectors/${encodeURIComponent(r.name)}`;
      await ccFetch<unknown>(this.ctx, `${base}/${actionId}`, {
        method: actionId === "restart" ? "POST" : "PUT",
      });
      return;
    }
    throw new Error(`Confluent Cloud plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    if (typeId !== "kafka-cluster") {
      throw new Error(`Confluent Cloud plugin: unknown command "${command}" for "${typeId}"`);
    }
    const values = parseValues(args);
    if (command === "resize") {
      const update: Record<string, string> = {};
      if (values["cku"]) update["cku"] = values["cku"];
      if (values["maxEcku"]) update["maxEcku"] = values["maxEcku"];
      if (Object.keys(update).length === 0) throw new Error("Pick a size.");
      await this.updateCluster(resourceId, accountId, update);
      return { ok: true };
    }
    if (command === CREATE_KAFKA_KEY_COMMAND) {
      return this.createKafkaApiKey(resourceId, values);
    }
    throw new Error(`Confluent Cloud plugin: unknown command "${command}"`);
  }

  /**
   * Mint a cluster-scoped API key and store its secret, which Confluent
   * returns exactly once. With no owner picked the key belongs to the owner
   * of this account's own Cloud API key (read from `GET /iam/v2/api-keys/{id}`),
   * who already has their own access. A picked service account can also be
   * granted CloudClusterAdmin on the cluster, without which it can do nothing.
   */
  private async createKafkaApiKey(
    resourceId: string,
    values: Record<string, string>,
  ): Promise<{ ok: true; key: string }> {
    const secrets = this.services?.secrets;
    if (!secrets?.setPlaintext) {
      throw new Error("This host can't store credentials, so the key could not be kept.");
    }
    const { env, id } = envScoped(resourceId);
    const cluster = await ccFetch<CcKafkaCluster>(
      this.ctx,
      `/cmk/v2/clusters/${encodeURIComponent(id)}`,
      { query: { environment: env } },
    );
    let owner = pickedId(values["owner"] ?? "");
    const isServiceAccount = owner.startsWith("sa-");
    if (!owner) {
      const own = await ccFetch<CcApiKey>(
        this.ctx,
        `/iam/v2/api-keys/${encodeURIComponent(this.ctx.apiKey)}`,
      );
      owner = own?.spec?.owner?.id ?? "";
      if (!owner) throw new Error("Could not read who owns this account's Cloud API key.");
    }
    if (isServiceAccount && values["grantRole"] && cluster.metadata?.resource_name) {
      try {
        await ccFetch<unknown>(this.ctx, "/iam/v2/role-bindings", {
          method: "POST",
          body: JSON.stringify({
            principal: `User:${owner}`,
            role_name: values["grantRole"],
            crn_pattern: cluster.metadata.resource_name,
          }),
        });
      } catch (err) {
        // 409: the binding already exists, which is what we wanted.
        if (statusOf(err) !== 409) throw err;
      }
    }
    const created = await ccFetch<CcApiKey>(this.ctx, "/iam/v2/api-keys", {
      method: "POST",
      body: JSON.stringify({
        spec: {
          display_name: `infrawrench-${cluster.spec?.display_name ?? id}`.slice(0, 64),
          description: "Created by Infrawrench for the Kafka topic browser.",
          owner: { id: owner },
          resource: { id, environment: env },
        },
      }),
    });
    const key = created?.id ?? "";
    const secret = created?.spec?.secret ?? "";
    if (!key || !secret) throw new Error("Confluent Cloud returned no secret for the new key.");
    await secrets.setPlaintext(resourceId, KAFKA_KEY_FIELD, key);
    await secrets.setPlaintext(resourceId, KAFKA_SECRET_FIELD, secret);
    return { ok: true, key };
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
    const n = (v: unknown) => (v === undefined ? "—" : Number(v).toLocaleString("en-US"));
    switch (resourceTypeId) {
      case "kafka-cluster":
        return [
          {
            label: f["clusterType"] === "Dedicated" ? "CKUs" : "Max eCKUs",
            value: n(f["clusterType"] === "Dedicated" ? f["cku"] : f["maxEcku"]),
          },
          { label: "Topics", value: n(f["topics"]) },
          { label: "Partitions", value: n(f["partitions"]) },
        ];
      case "connector": {
        const state = String(f["state"] ?? "");
        return [
          {
            label: "State",
            value: state || "—",
            variant:
              state === "RUNNING"
                ? "status-healthy"
                : state === "FAILED"
                  ? "status-error"
                  : state === "DEGRADED"
                    ? "status-degraded"
                    : "default",
          },
          { label: "Tasks", value: n(f["tasks"]) },
        ];
      }
      case "flink-compute-pool":
        return [
          { label: "Current CFUs", value: n(f["currentCfu"]) },
          { label: "Max CFUs", value: n(f["maxCfu"]) },
        ];
      case "ksqldb-cluster":
        return [{ label: "CSUs", value: n(f["csu"]) }];
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
    const range = rangeOrDefault(timeRange);
    const { id } = envScoped(resourceId);
    switch (resourceTypeId) {
      case "kafka-cluster": {
        const r = await this.getResource("kafka-cluster", resourceId, accountId).catch(
          () => undefined,
        );
        const type = String(r?.fields["clusterType"] ?? "");
        const specs: SeriesSpec[] = CLUSTER_SERIES.filter((s) => !s.onlyFor || s.onlyFor(type));
        return seriesFor(this.ctx, "resource.kafka.id", id, specs, range);
      }
      case "connector": {
        const r = await this.getResource("connector", resourceId, accountId).catch(() => undefined);
        const connectorId = String(r?.fields["connectorId"] ?? "");
        if (!connectorId) return [];
        return seriesFor(this.ctx, "resource.connector.id", connectorId, CONNECTOR_SERIES, range);
      }
      case "flink-compute-pool":
        return seriesFor(this.ctx, "resource.compute_pool.id", id, COMPUTE_POOL_SERIES, range);
      case "ksqldb-cluster":
        return seriesFor(this.ctx, "resource.ksql.id", id, KSQL_SERIES, range);
      case "schema-registry":
        return seriesFor(
          this.ctx,
          "resource.schema_registry.id",
          id,
          SCHEMA_REGISTRY_SERIES,
          range,
        );
      default:
        return [];
    }
  }

  /**
   * Where each billed resource lives, so cost rows can carry a region (the
   * Costs API has none). Best effort: a listing failure only drops regions.
   */
  private async costContext(): Promise<CostContext> {
    const locations = new Map<string, ResourceLocation>();
    const environments = await this.envNames();
    const clusters = await this.clusters().catch(() => [] as CcKafkaCluster[]);
    for (const c of clusters) {
      if (c.id) {
        locations.set(c.id, {
          ...(c.spec?.region ? { region: c.spec.region } : {}),
          ...(c.spec?.cloud ? { cloud: c.spec.cloud } : {}),
        });
      }
    }
    const [pools, registries, ksql] = await Promise.all([
      this.perEnvironment((env) =>
        ccList<CcComputePool>(this.ctx, "/fcpm/v2/compute-pools", { environment: env }),
      ).catch(() => [] as CcComputePool[]),
      this.perEnvironment((env) =>
        ccList<CcSchemaRegistry>(this.ctx, "/srcm/v3/clusters", { environment: env }),
      ).catch(() => [] as CcSchemaRegistry[]),
      this.perEnvironment((env) =>
        ccList<CcKsqlCluster>(this.ctx, "/ksqldbcm/v2/clusters", { environment: env }),
      ).catch(() => [] as CcKsqlCluster[]),
    ]);
    for (const p of [...pools, ...registries]) {
      if (p.id) {
        locations.set(p.id, {
          ...(p.spec?.region ? { region: p.spec.region } : {}),
          ...(p.spec?.cloud ? { cloud: p.spec.cloud } : {}),
        });
      }
    }
    for (const k of ksql) {
      const parent = k.spec?.kafka_cluster?.id ? locations.get(k.spec.kafka_cluster.id) : undefined;
      if (k.id && parent) locations.set(k.id, parent);
    }
    // Connectors bill under their own id and run in their cluster's region.
    await Promise.all(
      clusters.map(async (cl) => {
        const env = cl.spec?.environment?.id ?? "";
        if (!env || !cl.id) return;
        const byName = await this.fetchConnectors(env, cl.id).catch(() => ({}));
        for (const c of Object.values(byName)) {
          const connectorId = c.id?.id;
          const parent = locations.get(cl.id);
          if (connectorId && parent) locations.set(connectorId, parent);
        }
      }),
    );
    return { locations, environments };
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    const context = await this.costContext().catch(() => undefined);
    return fetchConfluentCostData(this.ctx, range, context);
  }

  async verifyCredentials(): Promise<PreflightResult> {
    return verifyConfluentCredentials(this.ctx);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderConfluentDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderConfluentSidebar(resource);
  }
}

export { PLUGIN_ID };
