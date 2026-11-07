import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { ApiBody, PluginEffect } from "@infrawrench/plugin-base";
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
import { pathEncode } from "@infrawrench/plugin-base";
import type { ConfluentContext } from "./api.js";
import type { operations } from "./api-types.management.gen.js";
import { PAGE_SIZE, ccList, createConfluentContext, statusOf } from "./api.js";
import type { CostContext, ResourceLocation } from "./cost-data.js";
import { ckuHourlyRates, fetchConfluentCostData } from "./cost-data.js";
import type { ClusterUsage, ConnectionKind } from "./mappers.js";
import {
  CONNECTION_KINDS,
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
  CcConnection,
  CcConnectorExpanded,
  CcEnvironment,
  CcFlinkRegion,
  CcKafkaCluster,
  CcKsqlCluster,
  CcNetwork,
  CcSchemaRegistry,
  CcServiceAccount,
} from "./types.js";

/** What a PATCH may say about a compute pool: the document wants its environment every time. */
type PoolSpecUpdate = NonNullable<ApiBody<operations["updateFcpmV2ComputePool"]>["spec"]>;
/** The same for a Kafka cluster. */
type ClusterSpecUpdate = NonNullable<ApiBody<operations["updateCmkV2Cluster"]>["spec"]>;

/** Secret field keys the minted cluster API key is stored under, per cluster resource. */
export const KAFKA_KEY_FIELD = "kafkaApiKey";
export const KAFKA_SECRET_FIELD = "kafkaApiSecret";

const CACHE_MS = 60_000;
const HOURS_PER_MONTH = 730;
/** The rightsizing catalog: CKU counts a Dedicated cluster can be sized to. */
const MAX_CATALOG_CKU = 24;
const RATE_CACHE_MS = 6 * 60 * 60 * 1000;

type ElasticType = "Basic" | "Standard" | "Enterprise" | "Freight";

function isElastic(kind: string): kind is ElasticType {
  return kind === "Basic" || kind === "Standard" || kind === "Enterprise" || kind === "Freight";
}

/** The four kinds of connection: the same two reads, on four routes. */
const CONNECTION_READS: Record<
  ConnectionKind,
  {
    list: (ctx: ConfluentContext, environment: string) => Promise<CcConnection[]>;
    get: (ctx: ConfluentContext, environment: string, id: string) => Promise<CcConnection>;
  }
> = {
  Peering: {
    list: (ctx, environment) =>
      ccList<CcConnection>(ctx, () =>
        ctx.api.get("/networking/v1/peerings", {
          query: { environment, page_size: PAGE_SIZE },
        }),
      ),
    get: (ctx, environment, id) =>
      ctx.api.get(`/networking/v1/peerings/${pathEncode(id)}`, { query: { environment } }),
  },
  "Transit Gateway Attachment": {
    list: (ctx, environment) =>
      ccList<CcConnection>(ctx, () =>
        ctx.api.get("/networking/v1/transit-gateway-attachments", {
          query: { environment, page_size: PAGE_SIZE },
        }),
      ),
    get: (ctx, environment, id) =>
      ctx.api.get(`/networking/v1/transit-gateway-attachments/${pathEncode(id)}`, {
        query: { environment },
      }),
  },
  "Private Link Access": {
    list: (ctx, environment) =>
      ccList<CcConnection>(ctx, () =>
        ctx.api.get("/networking/v1/private-link-accesses", {
          query: { environment, page_size: PAGE_SIZE },
        }),
      ),
    get: (ctx, environment, id) =>
      ctx.api.get(`/networking/v1/private-link-accesses/${pathEncode(id)}`, {
        query: { environment },
      }),
  },
  "Private Link Attachment": {
    list: (ctx, environment) =>
      ccList<CcConnection>(ctx, () =>
        ctx.api.get("/networking/v1/private-link-attachments", {
          query: { environment, page_size: PAGE_SIZE },
        }),
      ),
    get: (ctx, environment, id) =>
      ctx.api.get(`/networking/v1/private-link-attachments/${pathEncode(id)}`, {
        query: { environment },
      }),
  },
};

function parseValues(args: (string | number)[]): Record<string, string> {
  const first = args[0];
  if (typeof first !== "string" || !first) return {};
  try {
    const parsed: unknown = JSON.parse(first);
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

  constructor(credentials: Credentials, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    const apiSecret = (credentials["apiSecret"] ?? "").trim();
    if (!apiKey) throw new Error("Confluent Cloud plugin: missing apiKey credential");
    if (!apiSecret) throw new Error("Confluent Cloud plugin: missing apiSecret credential");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = createConfluentContext({
      apiKey,
      apiSecret,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    });
    this.services = services;
  }

  // -------------------------------------------------------------------------
  // Shared reads
  // -------------------------------------------------------------------------

  private environments(): Promise<CcEnvironment[]> {
    if (!this.envCache || Date.now() - this.envCache.at > CACHE_MS) {
      const value = ccList<CcEnvironment>(this.ctx, () =>
        this.ctx.api.get("/org/v2/environments", { query: { page_size: PAGE_SIZE } }),
      );
      value.catch(() => (this.envCache = undefined));
      this.envCache = { at: Date.now(), value };
    }
    return this.envCache.value;
  }

  private async envNames(): Promise<Map<string, string>> {
    const envs = await this.environments().catch((): CcEnvironment[] => []);
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
        load(e.id ?? "").catch((err: unknown): T[] => {
          if (statusOf(err) === 403) return [];
          throw err;
        }),
      ),
    );
    return batches.flat();
  }

  private clusters(): Promise<CcKafkaCluster[]> {
    if (!this.clusterCache || Date.now() - this.clusterCache.at > CACHE_MS) {
      const value = this.perEnvironment((env) =>
        ccList<CcKafkaCluster>(this.ctx, () =>
          this.ctx.api.get("/cmk/v2/clusters", {
            query: { environment: env, page_size: PAGE_SIZE },
          }),
        ),
      );
      value.catch(() => (this.clusterCache = undefined));
      this.clusterCache = { at: Date.now(), value };
    }
    return this.clusterCache.value;
  }

  private computePools(env: string): Promise<CcComputePool[]> {
    return ccList<CcComputePool>(this.ctx, () =>
      this.ctx.api.get("/fcpm/v2/compute-pools", {
        query: { environment: env, page_size: PAGE_SIZE },
      }),
    );
  }

  private ksqlClusters(env: string): Promise<CcKsqlCluster[]> {
    return ccList<CcKsqlCluster>(this.ctx, () =>
      this.ctx.api.get("/ksqldbcm/v2/clusters", {
        query: { environment: env, page_size: PAGE_SIZE },
      }),
    );
  }

  private schemaRegistries(env: string): Promise<CcSchemaRegistry[]> {
    return ccList<CcSchemaRegistry>(this.ctx, () =>
      this.ctx.api.get("/srcm/v3/clusters", { query: { environment: env, page_size: PAGE_SIZE } }),
    );
  }

  private serviceAccounts(): Promise<CcServiceAccount[]> {
    return ccList<CcServiceAccount>(this.ctx, () =>
      this.ctx.api.get("/iam/v2/service-accounts", { query: { page_size: PAGE_SIZE } }),
    );
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

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      switch (typeId) {
        case "environment":
          return (await this.environments()).map((e) => mapEnvironment(accountId, e));
        case "kafka-cluster":
          return this.listClusters(accountId);
        case "connector":
          return this.scoped(() => this.listConnectors(accountId));
        case "flink-compute-pool":
          return this.scoped(async () =>
            (await this.perEnvironment((env) => this.computePools(env))).map((p) =>
              mapComputePool(accountId, p),
            ),
          );
        case "ksqldb-cluster":
          return this.scoped(async () =>
            (await this.perEnvironment((env) => this.ksqlClusters(env))).map((k) =>
              mapKsqlCluster(accountId, k),
            ),
          );
        case "schema-registry":
          return this.scoped(async () =>
            (await this.perEnvironment((env) => this.schemaRegistries(env))).map((s) =>
              mapSchemaRegistry(accountId, s),
            ),
          );
        case "service-account":
          return this.scoped(async () =>
            (await this.serviceAccounts()).map((s) => mapServiceAccount(accountId, s)),
          );
        case "api-key":
          return this.scoped(() => this.listApiKeys(accountId));
        case "network":
          return this.scoped(async () =>
            (
              await this.perEnvironment((env) =>
                ccList<CcNetwork>(this.ctx, () =>
                  this.ctx.api.get("/networking/v1/networks", {
                    query: { environment: env, page_size: PAGE_SIZE },
                  }),
                ),
              )
            ).map((n) => mapNetwork(accountId, n)),
          );
        case "network-connection":
          return this.scoped(() => this.listNetworkConnections(accountId));
        case "encryption-key":
          return this.scoped(async () =>
            (
              await ccList<CcByokKey>(this.ctx, () =>
                this.ctx.api.get("/byok/v1/keys", { query: { page_size: PAGE_SIZE } }),
              )
            ).map((k) => mapEncryptionKey(accountId, k)),
          );
        default:
          throw new Error(`Confluent Cloud plugin: unknown resource type "${typeId}"`);
      }
    });
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
      (await this.ctx.api.get(
        `/connect/v1/environments/${pathEncode(env)}/clusters/${pathEncode(cluster)}/connectors`,
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
        const byName = await this.fetchConnectors(env, cluster).catch(
          (err: unknown): Record<string, CcConnectorExpanded> => {
            // Clusters still provisioning, or without managed Connect, answer 4xx.
            if (statusOf(err) >= 400 && statusOf(err) < 500) return {};
            throw err;
          },
        );
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
      ccList<CcApiKey>(this.ctx, () =>
        this.ctx.api.get("/iam/v2/api-keys", { query: { page_size: PAGE_SIZE } }),
      ),
      this.serviceAccounts().catch((): CcServiceAccount[] => []),
    ]);
    const names = new Map(accounts.map((a) => [a.id ?? "", a.display_name ?? ""]));
    return keys.map((k) => mapApiKey(accountId, k, names));
  }

  private async listNetworkConnections(accountId: string): Promise<ResourceInstance[]> {
    const all = await Promise.all(
      CONNECTION_KINDS.map(async (kind) =>
        (
          await this.perEnvironment((env) => CONNECTION_READS[kind].list(this.ctx, env)).catch(
            (err: unknown): CcConnection[] => {
              if (statusOf(err) === 403) return [];
              throw err;
            },
          )
        ).map((c) => mapNetworkConnection(accountId, kind, c)),
      ),
    );
    return all.flat();
  }

  // -------------------------------------------------------------------------
  // Single reads
  // -------------------------------------------------------------------------

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const { env, id } = envScoped(resourceId);
      switch (typeId) {
        case "environment": {
          const e = await this.ctx.api.get(
            `/org/v2/environments/${pathEncode(routeOf(resourceId)[0] ?? "")}`,
          );
          return mapEnvironment(accountId, e);
        }
        case "kafka-cluster": {
          const c = await this.ctx.api.get(`/cmk/v2/clusters/${pathEncode(id)}`, {
            query: { environment: env },
          });
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
            await this.ctx.api.get(`/fcpm/v2/compute-pools/${pathEncode(id)}`, {
              query: { environment: env },
            }),
          );
        case "ksqldb-cluster":
          return mapKsqlCluster(
            accountId,
            await this.ctx.api.get(`/ksqldbcm/v2/clusters/${pathEncode(id)}`, {
              query: { environment: env },
            }),
          );
        case "schema-registry":
          return mapSchemaRegistry(
            accountId,
            await this.ctx.api.get(`/srcm/v3/clusters/${pathEncode(id)}`, {
              query: { environment: env },
            }),
          );
        case "service-account":
          return mapServiceAccount(
            accountId,
            await this.ctx.api.get(
              `/iam/v2/service-accounts/${pathEncode(routeOf(resourceId)[0] ?? "")}`,
            ),
          );
        case "network":
          return mapNetwork(
            accountId,
            await this.ctx.api.get(`/networking/v1/networks/${pathEncode(id)}`, {
              query: { environment: env },
            }),
          );
        case "network-connection": {
          const [connEnv = "", slug = "", connId = ""] = routeOf(resourceId);
          const kind = connectionKindForSlug(slug);
          if (kind) {
            const c = await CONNECTION_READS[kind].get(this.ctx, connEnv, connId);
            return mapNetworkConnection(accountId, kind, c);
          }
          break;
        }
        default:
          break;
      }
      const all = await runPluginEffect(this.listResources(typeId, accountId));
      const found = all.find((r) => r.id === resourceId);
      if (!found)
        throw new Error(`Confluent Cloud plugin: resource ${typeId}/${resourceId} not found`);
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
      if (typeId === "kafka-cluster" && outputKey === "connectionString") {
        return this.kafkaConnectionString(resourceId, accountId);
      }
      const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const resolved = resource.resolvedOutputs[outputKey];
      if (resolved !== undefined) return resolved;
      const field = resource.fields[outputKey];
      if (field !== undefined) return String(field);
      throw new Error(
        `Confluent Cloud plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
      );
    });
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
    const cluster = await runPluginEffect(this.getResource("kafka-cluster", resourceId, accountId));
    const host = bootstrapHost(String(cluster.fields["bootstrapEndpoint"] ?? ""));
    if (!host) throw new Error("This cluster has no bootstrap endpoint yet.");
    const params = new URLSearchParams({ sasl: "plain", ssl: "true", user: key, password: secret });
    return `kafka://${host}?${params.toString()}`;
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  getCreateConfig(typeId: string, parentResourceId?: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      const envField = async (): Promise<CreateResourceConfig["fields"][number]> => {
        const envs = await this.environments().catch((): CcEnvironment[] => []);
        return {
          key: "environmentId",
          label: "Environment",
          kind: "select",
          required: true,
          options: envs.map((e) => ({ id: e.id ?? "", label: e.display_name || e.id || "" })),
          ...(envs[0]?.id ? { defaultValue: envs[0].id } : {}),
        };
      };
      switch (typeId) {
        case "environment":
          return {
            fields: [
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: true,
                placeholder: "production",
              },
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
          const regions = await ccList<CcFlinkRegion>(this.ctx, () =>
            this.ctx.api.get("/fcpm/v2/regions", { query: { page_size: PAGE_SIZE } }),
          ).catch((): CcFlinkRegion[] => []);
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
    });
  }

  /**
   * Monthly price per CKU count at a placement, from what this organization
   * actually paid per CKU-hour there over the last month (Billing Costs API).
   * Multi-zone placements omit 1 CKU, which Confluent does not allow, so the
   * Oversized finder never recommends it.
   */
  getCreateSizePricing(
    typeId: string,
    request: CreateSizePricingRequest,
  ): PluginEffect<Record<string, number>> {
    return attempt(async () => {
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
    });
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

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const name = (fields["name"] ?? "").trim();
      if (!name) throw new Error("Name is required.");
      switch (typeId) {
        case "environment": {
          const e = await this.ctx.api.post("/org/v2/environments", {
            body: {
              display_name: name,
              stream_governance_config: { package: fields["streamGovernance"] || "ESSENTIALS" },
            },
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
          const p = await this.ctx.api.post("/fcpm/v2/compute-pools", {
            body: {
              spec: {
                display_name: name,
                cloud,
                region,
                max_cfu: positiveInt(fields["maxCfu"], "Max CFUs"),
                environment: { id: env },
              },
            },
          });
          return mapComputePool(accountId, p);
        }
        case "service-account": {
          const s = await this.ctx.api.post("/iam/v2/service-accounts", {
            body: {
              display_name: name,
              ...(fields["description"] ? { description: fields["description"] } : {}),
            },
          });
          return mapServiceAccount(accountId, s);
        }
        default:
          throw new Error(`Confluent Cloud plugin: cannot create "${typeId}" from Infrawrench`);
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
      const { env, id } = envScoped(resourceId);
      switch (typeId) {
        case "environment": {
          const body: ApiBody<operations["updateOrgV2Environment"]> = {};
          if ("name" in fields) body.display_name = (fields["name"] ?? "").trim();
          if (fields["streamGovernance"]) {
            body.stream_governance_config = { package: fields["streamGovernance"] };
          }
          const e = await this.ctx.api.patch(
            `/org/v2/environments/${pathEncode(routeOf(resourceId)[0] ?? "")}`,
            { body },
          );
          this.envCache = undefined;
          return mapEnvironment(accountId, e);
        }
        case "kafka-cluster":
          return this.updateCluster(resourceId, accountId, fields);
        case "flink-compute-pool": {
          const spec: PoolSpecUpdate = { environment: { id: env } };
          if ("name" in fields) spec.display_name = (fields["name"] ?? "").trim();
          if ("maxCfu" in fields) spec.max_cfu = positiveInt(fields["maxCfu"], "Max CFUs");
          const p = await this.ctx.api.patch(`/fcpm/v2/compute-pools/${pathEncode(id)}`, {
            body: { spec },
          });
          return mapComputePool(accountId, p);
        }
        case "service-account": {
          const s = await this.ctx.api.patch(
            `/iam/v2/service-accounts/${pathEncode(routeOf(resourceId)[0] ?? "")}`,
            { body: { description: fields["description"] ?? "" } },
          );
          return mapServiceAccount(accountId, s);
        }
        case "api-key": {
          const spec: NonNullable<CcApiKey["spec"]> = {};
          if ("name" in fields) spec.display_name = fields["name"] ?? "";
          if ("description" in fields) spec.description = fields["description"] ?? "";
          await this.ctx.api.patch(`/iam/v2/api-keys/${pathEncode(routeOf(resourceId)[0] ?? "")}`, {
            body: { spec },
          });
          return runPluginEffect(this.getResource("api-key", resourceId, accountId));
        }
        default:
          throw new Error(`Confluent Cloud plugin: "${typeId}" cannot be edited from Infrawrench`);
      }
    });
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
    const current: CcKafkaCluster = await this.ctx.api.get(`/cmk/v2/clusters/${pathEncode(id)}`, {
      query: { environment: env },
    });
    const kind = current.spec?.config?.kind ?? "";
    const spec: ClusterSpecUpdate = { environment: { id: env } };
    if ("name" in fields && fields["name"]?.trim()) spec.display_name = fields["name"].trim();
    if ("cku" in fields && fields["cku"]) {
      if (kind !== "Dedicated") throw new Error("Only Dedicated clusters are sized in CKUs.");
      const cku = positiveInt(fields["cku"], "CKUs");
      if ((current.spec?.availability ?? "").toUpperCase().includes("MULTI") && cku < 2) {
        throw new Error("Multi-zone Dedicated clusters need at least 2 CKUs.");
      }
      spec.config = { kind, cku };
    }
    if ("maxEcku" in fields && fields["maxEcku"]) {
      if (!isElastic(kind)) {
        throw new Error(
          "Only Basic, Standard, Enterprise and Freight clusters have an eCKU ceiling.",
        );
      }
      spec.config = { kind, max_ecku: positiveInt(fields["maxEcku"], "Max eCKUs") };
    }
    const c = await this.ctx.api.patch(`/cmk/v2/clusters/${pathEncode(id)}`, { body: { spec } });
    this.clusterCache = undefined;
    const names = await this.envNames();
    return mapKafkaCluster(accountId, c ?? current, names.get(env));
  }

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const { env, id } = envScoped(resourceId);
      switch (typeId) {
        case "environment":
          await this.ctx.api.delete(
            `/org/v2/environments/${pathEncode(routeOf(resourceId)[0] ?? "")}`,
          );
          this.envCache = undefined;
          return;
        case "kafka-cluster":
          await this.ctx.api.delete(`/cmk/v2/clusters/${pathEncode(id)}`, {
            query: { environment: env },
          });
          this.clusterCache = undefined;
          return;
        case "connector": {
          const r = connectorRoute(resourceId);
          await this.ctx.api.delete(
            `/connect/v1/environments/${pathEncode(r.env)}/clusters/${pathEncode(r.cluster)}/connectors/${pathEncode(r.name)}`,
          );
          return;
        }
        case "flink-compute-pool":
          await this.ctx.api.delete(`/fcpm/v2/compute-pools/${pathEncode(id)}`, {
            query: { environment: env },
          });
          return;
        case "ksqldb-cluster":
          await this.ctx.api.delete(`/ksqldbcm/v2/clusters/${pathEncode(id)}`, {
            query: { environment: env },
          });
          return;
        case "service-account":
          await this.ctx.api.delete(
            `/iam/v2/service-accounts/${pathEncode(routeOf(resourceId)[0] ?? "")}`,
          );
          return;
        case "api-key":
          await this.ctx.api.delete(`/iam/v2/api-keys/${pathEncode(routeOf(resourceId)[0] ?? "")}`);
          return;
        default:
          throw new Error(`Confluent Cloud plugin: "${typeId}" cannot be deleted from Infrawrench`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      if (typeId === "connector" && ["pause", "resume", "restart"].includes(actionId)) {
        const r = connectorRoute(resourceId);
        const env = pathEncode(r.env);
        const cluster = pathEncode(r.cluster);
        const name = pathEncode(r.name);
        if (actionId === "pause") {
          await this.ctx.api.put(
            `/connect/v1/environments/${env}/clusters/${cluster}/connectors/${name}/pause`,
          );
        } else if (actionId === "resume") {
          await this.ctx.api.put(
            `/connect/v1/environments/${env}/clusters/${cluster}/connectors/${name}/resume`,
          );
        } else {
          await this.ctx.api.post(
            `/connect/v1/environments/${env}/clusters/${cluster}/connectors/${name}/restart`,
          );
        }
        return;
      }
      throw new Error(`Confluent Cloud plugin: unknown action "${actionId}" for "${typeId}"`);
    });
  }

  executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    accountId: string,
    command: string,
    args: (string | number)[],
  ): PluginEffect<unknown> {
    return attempt(async () => {
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
    });
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
    const cluster: CcKafkaCluster = await this.ctx.api.get(`/cmk/v2/clusters/${pathEncode(id)}`, {
      query: { environment: env },
    });
    let owner = pickedId(values["owner"] ?? "");
    const isServiceAccount = owner.startsWith("sa-");
    if (!owner) {
      const own: CcApiKey = await this.ctx.api.get(
        `/iam/v2/api-keys/${pathEncode(this.ctx.apiKey)}`,
      );
      owner = own?.spec?.owner?.id ?? "";
      if (!owner) throw new Error("Could not read who owns this account's Cloud API key.");
    }
    if (isServiceAccount && values["grantRole"] && cluster.metadata?.resource_name) {
      try {
        await this.ctx.api.post("/iam/v2/role-bindings", {
          body: {
            principal: `User:${owner}`,
            role_name: values["grantRole"],
            crn_pattern: cluster.metadata.resource_name,
          },
        });
      } catch (err) {
        // 409: the binding already exists, which is what we wanted.
        if (statusOf(err) !== 409) throw err;
      }
    }
    const created: CcApiKey = await this.ctx.api.post("/iam/v2/api-keys", {
      body: {
        spec: {
          display_name: `infrawrench-${cluster.spec?.display_name ?? id}`.slice(0, 64),
          description: "Created by Infrawrench for the Kafka topic browser.",
          owner: { id: owner },
          resource: { id, environment: env },
        },
      },
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

  fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      const r = await runPluginEffect(this.getResource(resourceTypeId, resourceId, accountId));
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
    });
  }

  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      const range = rangeOrDefault(timeRange);
      const { id } = envScoped(resourceId);
      switch (resourceTypeId) {
        case "kafka-cluster": {
          const r = await runPluginEffect(
            this.getResource("kafka-cluster", resourceId, accountId),
          ).catch(() => undefined);
          const type = String(r?.fields["clusterType"] ?? "");
          const specs: SeriesSpec[] = CLUSTER_SERIES.filter((s) => !s.onlyFor || s.onlyFor(type));
          return seriesFor(this.ctx, "resource.kafka.id", id, specs, range);
        }
        case "connector": {
          const r = await runPluginEffect(
            this.getResource("connector", resourceId, accountId),
          ).catch(() => undefined);
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
    });
  }

  /**
   * Where each billed resource lives, so cost rows can carry a region (the
   * Costs API has none). Best effort: a listing failure only drops regions.
   */
  private async costContext(): Promise<CostContext> {
    const locations = new Map<string, ResourceLocation>();
    const environments = await this.envNames();
    const clusters = await this.clusters().catch((): CcKafkaCluster[] => []);
    for (const c of clusters) {
      if (c.id) {
        locations.set(c.id, {
          ...(c.spec?.region ? { region: c.spec.region } : {}),
          ...(c.spec?.cloud ? { cloud: c.spec.cloud } : {}),
        });
      }
    }
    const [pools, registries, ksql] = await Promise.all([
      this.perEnvironment((env) => this.computePools(env)).catch((): CcComputePool[] => []),
      this.perEnvironment((env) => this.schemaRegistries(env)).catch((): CcSchemaRegistry[] => []),
      this.perEnvironment((env) => this.ksqlClusters(env)).catch((): CcKsqlCluster[] => []),
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
        const byName = await this.fetchConnectors(env, cl.id).catch(
          (): Record<string, CcConnectorExpanded> => ({}),
        );
        for (const c of Object.values(byName)) {
          const connectorId = c.id?.id;
          const parent = locations.get(cl.id);
          if (connectorId && parent) locations.set(connectorId, parent);
        }
      }),
    );
    return { locations, environments };
  }

  fetchCostData(_accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      const context = await this.costContext().catch(() => undefined);
      return fetchConfluentCostData(this.ctx, range, context);
    });
  }

  verifyCredentials(): PluginEffect<PreflightResult> {
    return attempt(async () => {
      return verifyConfluentCredentials(this.ctx);
    });
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
