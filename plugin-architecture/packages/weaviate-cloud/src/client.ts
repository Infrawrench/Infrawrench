import type {
  CreateFieldConfig,
  CreateResourceConfig,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  ResourceCreateReturn,
  ResourceInstance,
  ResourceTypeDefinition,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { withMetricsCapability } from "@infrawrench/plugin-base";
import { clusterKeyOf, errorText, isStatus, normalizeEndpoint, WeaviateApi } from "./api.js";
import { WeaviateCloudApi } from "./cloud.js";
import type { ClusterConnection, ClusterScope, ClusterView } from "./mappers.js";
import {
  clusterResourceId,
  collectionStats,
  externalOf,
  mapAlias,
  mapBackup,
  mapCluster,
  mapCollection,
  mapRole,
  mapTenant,
  mapUser,
  partsOf,
  splitScoped,
} from "./mappers.js";
import {
  ENRICH_COLLECTIONS,
  ENRICH_NODES,
  ENRICH_PERMISSIONS,
  ENRICH_PROPERTIES,
  ENRICH_SHARDS,
  renderWeaviateDetail,
  renderWeaviateSidebarItem,
} from "./render.js";
import { TENANT_STATUSES } from "./resource-types.js";
import type {
  WcCluster,
  WcRegion,
  WvAlias,
  WvBackup,
  WvClass,
  WvDbUser,
  WvMeta,
  WvNode,
  WvRole,
  WvTenant,
} from "./types.js";

const NODES_TTL_MS = 30_000;
const META_TTL_MS = 5 * 60_000;
const FAN_OUT = 6;
const MAX_TENANT_COLLECTIONS = 50;

export const USER_KEY_FIELD = "apiKey";

/** Weaviate data types offered in the collection create form. */
export const DATA_TYPES = [
  "text",
  "text[]",
  "int",
  "int[]",
  "number",
  "number[]",
  "boolean",
  "boolean[]",
  "date",
  "date[]",
  "uuid",
  "uuid[]",
  "geoCoordinates",
  "phoneNumber",
  "blob",
  "object",
  "object[]",
];

const enc = encodeURIComponent;

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v).trim();
}

function intField(raw: string | undefined, label: string, min: number): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min)
    throw new Error(`${label} must be a whole number of at least ${min}.`);
  return n;
}

function parseFormArg(raw: string | number | undefined): Record<string, string> {
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed))
      out[k] = typeof v === "string" ? v : JSON.stringify(v);
    return out;
  } catch {
    return {};
  }
}

function parseList(raw: string | undefined): string[] {
  const t = (raw ?? "").trim();
  if (!t) return [];
  if (t.startsWith("[")) {
    try {
      return (JSON.parse(t) as unknown[]).map((x) => String(x).trim()).filter(Boolean);
    } catch {
      return [];
    }
  }
  return t
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Collection names must start with an uppercase letter (Weaviate capitalises them otherwise). */
export function checkCollectionName(name: string): void {
  if (!/^[A-Z][_0-9A-Za-z]*$/.test(name)) {
    throw new Error(
      "Collection names start with a capital letter and use letters, digits and underscores.",
    );
  }
}

/** `[{"name":"title","dataType":"text"}]` (the key-value-list field) to Weaviate properties. */
export function parseProperties(
  raw: string | undefined,
): Array<{ name: string; dataType: string[] }> {
  const t = (raw ?? "").trim();
  if (!t) return [];
  let rows: Array<Record<string, unknown>>;
  try {
    rows = JSON.parse(t) as Array<Record<string, unknown>>;
  } catch {
    throw new Error("Properties could not be read.");
  }
  return rows
    .map((r) => ({ name: str(r["name"]), type: str(r["dataType"]) || "text" }))
    .filter((r) => r.name)
    .map((r) => {
      if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(r.name)) {
        throw new Error(
          `Property "${r.name}" must start with a letter or underscore and use letters, digits and underscores.`,
        );
      }
      if (!DATA_TYPES.includes(r.type))
        throw new Error(`Unknown data type ${r.type} for ${r.name}.`);
      return { name: r.name, dataType: [r.type] };
    });
}

/** Backup backends the cluster has a module for (`backup-gcs` → `gcs`). */
export function backupBackends(meta: WvMeta | undefined): string[] {
  return Object.keys(meta?.modules ?? {})
    .filter((m) => m.startsWith("backup-"))
    .map((m) => m.slice("backup-".length));
}

/** Vectorizer modules the cluster has loaded (`text2vec-*`, `multi2vec-*`, ...). */
export function vectorizerModules(meta: WvMeta | undefined): string[] {
  return Object.keys(meta?.modules ?? {})
    .filter((m) => /^(text2vec|multi2vec|img2vec|ref2vec)-/.test(m))
    .sort();
}

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

function cached<T>(slot: Cached<T> | undefined, ttl: number, load: () => Promise<T>): Cached<T> {
  if (slot && Date.now() - slot.at < ttl) return slot;
  const value = load();
  const next = { at: Date.now(), value };
  value.catch(() => {
    next.at = 0;
  });
  return next;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** One `<endpoint> <api key>` per line; `#` starts a comment, the key may be omitted. */
export function parseClusterLines(
  raw: string | undefined,
): Array<{ endpoint: string; apiKey: string }> {
  const out: Array<{ endpoint: string; apiKey: string }> = [];
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const [endpoint = "", apiKey = ""] = t.split(/[\s,]+/);
    const normalized = normalizeEndpoint(endpoint);
    if (normalized) out.push({ endpoint: normalized, apiKey: apiKey.trim() });
  }
  return out;
}

/** In-cluster key stored for a connected cluster, and the marker for a cluster Infrawrench created. */
export const CLUSTER_KEY_FIELD = "apiKey";
export const PENDING_KEY_FIELD = "pendingKey";

const CLOUD_TTL_MS = 60_000;
const REGIONS_TTL_MS = 10 * 60_000;
const NOT_CONNECTED =
  "is not connected. Open the cluster and use Connect, or add its endpoint and key under More clusters in the account settings.";

/** A cluster Infrawrench holds a key for. */
interface Conn {
  key: string;
  endpoint: string;
  apiKey: string;
  connection: Exclude<ClusterConnection, "none">;
  api: WeaviateApi;
  metaCache?: Cached<WvMeta> | undefined;
  nodesCache?: Cached<WvNode[]> | undefined;
}

function keyForCloud(c: WcCluster): string {
  return c.endpoint ? clusterKeyOf(c.endpoint) : `wcd-${c.id}`;
}

/**
 * Weaviate plugin client. An account covers many clusters: the ones its
 * Weaviate Cloud sign-in lists (`cloud.ts`), the account's own endpoint, and
 * every line of its "More clusters" credential. Each cluster is reached with
 * its own API key through its REST endpoint (`api.ts`).
 */
export class WeaviateClient implements PluginClient {
  private readonly caCert: string;
  private readonly credentialConns = new Map<string, Conn>();
  private readonly storedConns = new Map<string, Conn>();
  private readonly rawClusters: string;
  readonly cloud: WeaviateCloudApi | undefined;
  private cloudCache: Cached<WcCluster[]> | undefined;
  private regionsCache: Cached<WcRegion[]> | undefined;
  /** Remembered so forms, which get no account id, can still reach the sign-in's stored session. */
  private lastAccountId = "";

  constructor(
    credentials: Record<string, string>,
    private readonly resourceTypes: ResourceTypeDefinition[],
    private readonly services?: HostServices,
  ) {
    this.caCert = credentials["caCert"] ?? "";
    this.rawClusters = credentials["clusters"] ?? "";
    const primary = str(credentials["endpoint"]);
    const entries = [
      ...(primary
        ? [{ endpoint: normalizeEndpoint(primary), apiKey: str(credentials["apiKey"]) }]
        : []),
      ...parseClusterLines(this.rawClusters),
    ];
    for (const e of entries) {
      const key = clusterKeyOf(e.endpoint);
      if (!key || this.credentialConns.has(key)) continue;
      this.credentialConns.set(key, this.makeConn(key, e.endpoint, e.apiKey, "credentials"));
    }
    const token = str(credentials["cloudToken"]);
    this.cloud = token ? new WeaviateCloudApi(token, services) : undefined;
    if (!this.cloud && !this.credentialConns.size) {
      throw new Error(
        "Weaviate plugin: enter a cluster endpoint, More clusters, or a Weaviate Cloud sign-in",
      );
    }
  }

  private makeConn(
    key: string,
    endpoint: string,
    apiKey: string,
    connection: Conn["connection"],
  ): Conn {
    return {
      key,
      endpoint,
      apiKey,
      connection,
      api: new WeaviateApi(endpoint, apiKey, this.caCert, this.services),
    };
  }

  // ── Cluster discovery ────────────────────────────────────────────────

  private cloudClusters(accountId: string): Promise<WcCluster[]> {
    const cloud = this.cloud;
    if (!cloud) return Promise.resolve([]);
    if (accountId) this.lastAccountId = accountId;
    this.cloudCache = cached(this.cloudCache, CLOUD_TTL_MS, () => cloud.clusters(accountId));
    return this.cloudCache.value;
  }

  private regions(accountId: string): Promise<WcRegion[]> {
    const cloud = this.cloud;
    if (!cloud) return Promise.resolve([]);
    this.regionsCache = cached(this.regionsCache, REGIONS_TTL_MS, () => cloud.regions(accountId));
    return this.regionsCache.value;
  }

  private async storedSecret(resourceId: string, field: string): Promise<string> {
    const v = await this.services?.secrets?.getPlaintext(resourceId, field).catch(() => null);
    return v?.trim() ?? "";
  }

  private async storeSecret(resourceId: string, field: string, value: string): Promise<void> {
    if (!this.services?.secrets?.setPlaintext) {
      throw new Error("This Infrawrench host cannot store keys. Update the app and try again.");
    }
    await this.services.secrets.setPlaintext(resourceId, field, value);
  }

  /** The connection for a cluster key: the account's credentials first, then a stored key. */
  private async conn(accountId: string, key: string): Promise<Conn | null> {
    const fromCredentials = this.credentialConns.get(key);
    if (fromCredentials) return fromCredentials;
    const known = this.storedConns.get(key);
    if (known) return known;
    if (key.startsWith("wcd-")) return null;
    const apiKey = await this.storedSecret(
      clusterResourceId({ accountId, key }),
      CLUSTER_KEY_FIELD,
    );
    if (!apiKey) return null;
    const conn = this.makeConn(key, `https://${key}`, apiKey, "stored");
    this.storedConns.set(key, conn);
    return conn;
  }

  private async connFor(resourceId: string): Promise<{ conn: Conn; scope: ClusterScope }> {
    const { scope } = splitScoped(resourceId);
    const conn = await this.conn(scope.accountId, scope.key);
    if (!conn) throw new Error(`Weaviate cluster ${scope.key} ${NOT_CONNECTED}`);
    return { conn, scope };
  }

  /**
   * A cluster Infrawrench created gets its one-time API key from Weaviate
   * Cloud on the first read after it turns READY. Claim it then, so the new
   * cluster connects without anyone pasting a key.
   */
  private async claimPendingKey(accountId: string, c: WcCluster): Promise<void> {
    if (!this.cloud || c.status !== "READY" || !c.endpoint) return;
    const marker = `${accountId}:cluster:wcd-${c.id}`;
    if ((await this.storedSecret(marker, PENDING_KEY_FIELD)) !== "1") return;
    const full = await this.cloud.cluster(accountId, c.id).catch(() => null);
    const value = full?.api_key?.value;
    if (value) {
      await this.storeSecret(
        clusterResourceId({ accountId, key: clusterKeyOf(c.endpoint) }),
        CLUSTER_KEY_FIELD,
        value,
      );
    }
    // Either way the reveal is spent: a later read returns only a warning.
    if (value || full?.api_key) await this.storeSecret(marker, PENDING_KEY_FIELD, "");
  }

  /** Every cluster Infrawrench can reach, in-cluster. */
  private async connectedConns(accountId: string): Promise<Conn[]> {
    const out = new Map(this.credentialConns);
    for (const c of await this.cloudClusters(accountId)) {
      if (c.status && c.status !== "READY") continue;
      const key = keyForCloud(c);
      if (out.has(key)) continue;
      const conn = await this.conn(accountId, key);
      if (conn) out.set(key, conn);
    }
    return [...out.values()];
  }

  /**
   * Run a lister over every connected cluster. A cluster that refuses the key
   * (401/403) lists empty rather than failing the others.
   */
  private async perCluster(
    accountId: string,
    load: (conn: Conn, scope: ClusterScope) => Promise<ResourceInstance[]>,
  ): Promise<ResourceInstance[]> {
    const conns = await this.connectedConns(accountId);
    const lists = await mapLimit(conns, FAN_OUT, async (conn) => {
      try {
        return await load(conn, { accountId, key: conn.key });
      } catch (e) {
        if (isStatus(e, 401, 403)) return [];
        throw e;
      }
    });
    return lists.flat();
  }

  meta(conn: Conn): Promise<WvMeta> {
    conn.metaCache = cached(conn.metaCache, META_TTL_MS, () => conn.api.request<WvMeta>("/meta"));
    return conn.metaCache.value;
  }

  nodes(conn: Conn): Promise<WvNode[]> {
    conn.nodesCache = cached(conn.nodesCache, NODES_TTL_MS, () =>
      conn.api
        .request<{ nodes?: WvNode[] }>("/nodes", { query: { output: "verbose" } })
        .then((r) => r?.nodes ?? []),
    );
    return conn.nodesCache.value;
  }

  private async schema(conn: Conn): Promise<WvClass[]> {
    const res = await conn.api.request<{ classes?: WvClass[] }>("/schema");
    return res?.classes ?? [];
  }

  private async clusterViews(accountId: string): Promise<ClusterView[]> {
    const [cloudList, regions] = await Promise.all([
      this.cloudClusters(accountId),
      this.regions(accountId).catch(() => [] as WcRegion[]),
    ]);
    const regionClouds = new Map(
      regions.filter((r) => r.cloud_provider).map((r) => [r.id, r.cloud_provider!] as const),
    );
    const views = new Map<string, ClusterView>();
    for (const c of cloudList) {
      await this.claimPendingKey(accountId, c).catch(() => undefined);
      const key = keyForCloud(c);
      views.set(key, {
        scope: { accountId, key },
        endpoint: c.endpoint ? normalizeEndpoint(c.endpoint) : "",
        cloud: c,
        regionClouds,
        connection: "none",
      });
    }
    for (const conn of this.credentialConns.values()) {
      const existing = views.get(conn.key);
      views.set(conn.key, {
        ...(existing ?? { scope: { accountId, key: conn.key }, regionClouds }),
        endpoint: conn.endpoint,
        connection: "credentials",
      });
    }
    await mapLimit([...views.values()], FAN_OUT, async (view) => {
      const conn = await this.conn(accountId, view.scope.key);
      if (!conn) return;
      view.connection = conn.connection;
      if (!view.endpoint) view.endpoint = conn.endpoint;
      if (view.cloud?.status && view.cloud.status !== "READY") return;
      try {
        const [meta, nodes] = await Promise.all([this.meta(conn), this.nodes(conn)]);
        view.meta = meta;
        view.nodes = nodes;
      } catch (e) {
        view.error = errorText(e);
      }
    });
    return [...views.values()];
  }

  // ── Listing ──────────────────────────────────────────────────────────

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "cluster":
        return (await this.clusterViews(accountId)).map(mapCluster);
      case "collection":
        return this.perCluster(accountId, async (conn, scope) => {
          const [classes, nodes] = await Promise.all([
            this.schema(conn),
            this.nodes(conn).catch(() => []),
          ]);
          const stats = collectionStats(nodes);
          return classes.map((c) => mapCollection(c, stats.get(c.class), scope));
        });
      case "tenant":
        return this.perCluster(accountId, async (conn, scope) => {
          const classes = (await this.schema(conn))
            .filter((c) => c.multiTenancyConfig?.enabled)
            .slice(0, MAX_TENANT_COLLECTIONS);
          const lists = await mapLimit(classes, FAN_OUT, async (c) => {
            const tenants = await this.tenants(conn, c.class);
            return tenants.map((t) => mapTenant(c.class, t, scope));
          });
          return lists.flat();
        });
      case "alias":
        return this.perCluster(accountId, async (conn, scope) => {
          try {
            const res = await conn.api.request<{ aliases?: WvAlias[] }>("/aliases");
            return (res?.aliases ?? []).map((a) => mapAlias(a, scope));
          } catch (e) {
            // Aliases arrived in Weaviate 1.32; older clusters answer 404.
            if (isStatus(e, 404, 405)) return [];
            throw e;
          }
        });
      case "backup":
        return this.perCluster(accountId, async (conn, scope) => {
          const backends = backupBackends(await this.meta(conn));
          const lists = await mapLimit(backends, FAN_OUT, async (backend) => {
            try {
              const res = await conn.api.request<WvBackup[]>(`/backups/${enc(backend)}`);
              return (res ?? []).map((b) => mapBackup(b, backend, scope));
            } catch (e) {
              if (isStatus(e, 404, 405, 422, 501)) return [];
              throw e;
            }
          });
          return lists.flat();
        });
      case "db-user":
        return this.perCluster(accountId, async (conn, scope) => {
          try {
            const res = await conn.api.request<WvDbUser[]>("/users/db", {
              query: { includeLastUsedTime: true },
            });
            return (res ?? []).map((u) => mapUser(u, scope));
          } catch (e) {
            // RBAC and DB users need Weaviate 1.30+ with RBAC on.
            if (isStatus(e, 404, 405)) return [];
            throw e;
          }
        });
      case "role":
        return this.perCluster(accountId, async (conn, scope) => {
          try {
            const res = await conn.api.request<WvRole[]>("/authz/roles");
            return (res ?? []).map((r) => mapRole(r, scope));
          } catch (e) {
            if (isStatus(e, 404, 405)) return [];
            throw e;
          }
        });
      default:
        throw new Error(`Weaviate plugin: unknown resource type "${typeId}"`);
    }
  }

  private async tenants(conn: Conn, collection: string): Promise<WvTenant[]> {
    const res = await conn.api.request<WvTenant[] | Record<string, WvTenant>>(
      `/schema/${enc(collection)}/tenants`,
    );
    if (Array.isArray(res)) return res;
    return Object.values(res ?? {});
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    if (typeId === "cluster") {
      const key = externalOf(resourceId);
      const found = (await this.clusterViews(accountId)).find((v) => v.scope.key === key);
      if (!found) throw new Error(`Weaviate plugin: cluster ${key} not found`);
      return mapCluster(found);
    }
    const { conn, scope } = await this.connFor(resourceId);
    switch (typeId) {
      case "collection": {
        const [name] = partsOf(resourceId, 1);
        const [c, nodes] = await Promise.all([
          conn.api.request<WvClass>(`/schema/${enc(name!)}`),
          this.nodes(conn).catch(() => []),
        ]);
        return mapCollection(c, collectionStats(nodes).get(c.class), scope);
      }
      case "tenant": {
        const [collection, name] = partsOf(resourceId, 2);
        const t = await conn.api.request<WvTenant>(
          `/schema/${enc(collection!)}/tenants/${enc(name!)}`,
        );
        return mapTenant(collection!, t, scope);
      }
      case "alias": {
        const [name] = partsOf(resourceId, 1);
        return mapAlias(await conn.api.request<WvAlias>(`/aliases/${enc(name!)}`), scope);
      }
      case "backup": {
        const [backend, name] = partsOf(resourceId, 2);
        const b = await conn.api.request<WvBackup>(`/backups/${enc(backend!)}/${enc(name!)}`);
        return mapBackup(b, backend!, scope);
      }
      case "db-user": {
        const [name] = partsOf(resourceId, 1);
        return mapUser(await conn.api.request<WvDbUser>(`/users/db/${enc(name!)}`), scope);
      }
      case "role": {
        const [name] = partsOf(resourceId, 1);
        return mapRole(await conn.api.request<WvRole>(`/authz/roles/${enc(name!)}`), scope);
      }
      default:
        throw new Error(`Weaviate plugin: unknown resource type "${typeId}"`);
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "cluster" && outputKey === "apiKey") {
      const { scope } = splitScoped(resourceId);
      const conn = await this.conn(accountId || scope.accountId, scope.key);
      if (!conn) throw new Error(`Weaviate cluster ${scope.key} ${NOT_CONNECTED}`);
      return conn.apiKey;
    }
    if (typeId === "db-user" && outputKey === "apiKey") {
      const v = await this.services?.secrets?.getPlaintext(resourceId, USER_KEY_FIELD);
      if (!v) {
        throw new Error(
          "Weaviate shows a user's key once. Rotate the key from Infrawrench to keep it here.",
        );
      }
      return v;
    }
    const r = await this.getResource(typeId, resourceId, accountId);
    return r.resolvedOutputs[outputKey] ?? "";
  }

  // ── Detail ───────────────────────────────────────────────────────────

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const fields = { ...resource.fields };
    const { scope, parts } = splitScoped(resource.id);
    const conn = await this.conn(resource.accountId || scope.accountId, scope.key);
    if (!conn) return resource;
    if (resource.resourceTypeId === "cluster") {
      const [nodes, classes] = await Promise.all([
        this.nodes(conn).catch(() => [] as WvNode[]),
        this.schema(conn).catch(() => [] as WvClass[]),
      ]);
      fields[ENRICH_NODES] = JSON.stringify(
        nodes.map((n) => ({
          name: n.name ?? "",
          status: n.status ?? "",
          version: n.version ?? "",
          objects: String(n.stats?.objectCount ?? ""),
          shards: String(n.stats?.shardCount ?? n.shards?.length ?? ""),
          mode: n.operationalMode ?? "",
        })),
      );
      fields[ENRICH_COLLECTIONS] = JSON.stringify(classes.map((c) => c.class));
    } else if (resource.resourceTypeId === "collection") {
      const id = parts.join("/");
      const [c, nodes] = await Promise.all([
        conn.api.request<WvClass>(`/schema/${enc(id)}`).catch(() => null),
        this.nodes(conn).catch(() => [] as WvNode[]),
      ]);
      if (c?.properties?.length) {
        fields[ENRICH_PROPERTIES] = JSON.stringify(
          c.properties.map((p) => ({
            name: p.name,
            type: (p.dataType ?? []).join(" | "),
            tokenization: p.tokenization ?? "",
            indexes: [
              p.indexFilterable !== false ? "filterable" : "",
              p.indexSearchable !== false && (p.dataType ?? []).some((t) => t.startsWith("text"))
                ? "searchable"
                : "",
              p.indexRangeFilters ? "range" : "",
            ]
              .filter(Boolean)
              .join(", "),
          })),
        );
      }
      const shards = nodes.flatMap((n) =>
        (n.shards ?? [])
          .filter((s) => s.class === id)
          .map((s) => ({
            node: n.name ?? "",
            name: s.name ?? "",
            objects: String(s.objectCount ?? 0),
            indexing: s.vectorIndexingStatus ?? "",
            queue: String(s.vectorQueueLength ?? 0),
          })),
      );
      if (shards.length) fields[ENRICH_SHARDS] = JSON.stringify(shards.slice(0, 200));
    } else if (resource.resourceTypeId === "role") {
      const id = parts.join("/");
      const r = await conn.api.request<WvRole>(`/authz/roles/${enc(id)}`).catch(() => null);
      if (r?.permissions?.length) {
        fields[ENRICH_PERMISSIONS] = JSON.stringify(
          r.permissions.map((p) => {
            const scopeText = Object.entries(p)
              .filter(([k, v]) => k !== "action" && v && typeof v === "object")
              .map(
                ([k, v]) =>
                  `${k}: ${Object.entries(v as Record<string, unknown>)
                    .map(([kk, vv]) => `${kk}=${String(vv)}`)
                    .join(" ")}`,
              )
              .join("; ");
            return { action: p.action ?? "", scope: scopeText };
          }),
        );
      }
    }
    return { ...resource, fields };
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return withMetricsCapability(
      renderWeaviateDetail(resource, this.resourceTypes, { signedIn: Boolean(this.cloud) }),
      this.resourceTypes,
      resource.resourceTypeId,
    );
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderWeaviateSidebarItem(resource);
  }

  // ── Create ───────────────────────────────────────────────────────────

  /**
   * The cluster a create form works in. `getCreateConfig` gets no account id,
   * so a cluster reached through a stored key is only found from its parent;
   * from the sidebar, the account's single credential cluster is used.
   */
  private async formConn(parentResourceId?: string): Promise<{ conn: Conn; scope: ClusterScope }> {
    if (parentResourceId) return this.connFor(parentResourceId);
    if (this.credentialConns.size === 1) {
      const conn = [...this.credentialConns.values()][0]!;
      return { conn, scope: { accountId: this.lastAccountId, key: conn.key } };
    }
    throw new Error("Open the cluster this belongs in and create it from there.");
  }

  private async collectionOptions(conn: Conn, filter: (c: WvClass) => boolean = () => true) {
    const classes = await this.schema(conn).catch(() => [] as WvClass[]);
    return classes.filter(filter).map((c) => ({ id: c.class, label: c.class }));
  }

  private async clusterCreateConfig(): Promise<CreateResourceConfig> {
    const connectFields: CreateFieldConfig[] = [
      {
        key: "endpoint",
        label: "REST endpoint",
        kind: "text",
        required: true,
        placeholder: "https://<cluster-id>.c0.<region>.gcp.weaviate.cloud",
        description:
          "From the cluster's details panel in the Weaviate Cloud console, or a self-hosted cluster's base URL",
      },
      {
        key: "apiKey",
        label: "API key",
        kind: "password",
        required: false,
        description:
          "An Admin key (or a key whose user has the admin role). Leave empty only for anonymous self-hosted access.",
      },
    ];
    if (!this.cloud) return { fields: connectFields };
    const regions = await this.regions(this.lastAccountId).catch(() => [] as WcRegion[]);
    const live = regions.filter((r) => !r.status || r.status !== "unavailable");
    const defaultRegion = live.find((r) => r.is_default)?.id ?? live[0]?.id ?? "";
    const showCreate = { fieldKey: "mode", fieldValue: "create" };
    const showConnect = { fieldKey: "mode", fieldValue: "connect" };
    return {
      fields: [
        {
          key: "mode",
          label: "Cluster",
          kind: "select",
          required: true,
          defaultValue: "create",
          options: [
            { id: "create", label: "Create a new Weaviate Cloud cluster" },
            { id: "connect", label: "Connect an existing cluster by endpoint" },
          ],
        },
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: false,
          description: "Leave empty and Weaviate Cloud picks one",
          showWhen: showCreate,
        },
        {
          key: "region",
          label: "Region",
          kind: "select",
          required: false,
          defaultValue: defaultRegion,
          options: live.length
            ? live.map((r) => ({
                id: r.id,
                label: r.name ? `${r.name} (${r.id})` : r.id,
                ...(r.cloud_provider ? { description: r.cloud_provider.toUpperCase() } : {}),
              }))
            : [{ id: "", label: "The organization's default region" }],
          showWhen: showCreate,
        },
        {
          key: "tier",
          label: "Tier",
          kind: "select",
          required: true,
          defaultValue: "free",
          options: [
            {
              id: "free",
              label: "Free sandbox",
              description: "1 collection, 100,000 objects, no backups or replication",
            },
          ],
          description:
            "Weaviate Cloud's provisioning API only creates free clusters. Paid clusters are created in the console, then appear here to connect.",
          showWhen: showCreate,
        },
        ...connectFields.map((f) => ({ ...f, showWhen: showConnect })),
      ],
    };
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    if (typeId === "cluster") return this.clusterCreateConfig();
    const { conn } = await this.formConn(parentResourceId);
    switch (typeId) {
      case "collection": {
        const meta = await this.meta(conn).catch(() => undefined);
        const vectorizers = vectorizerModules(meta);
        const fields: CreateFieldConfig[] = [
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            placeholder: "Article",
            description: "Starts with a capital letter",
          },
          { key: "description", label: "Description", kind: "text", required: false },
          {
            key: "vectorizer",
            label: "Vectorizer",
            kind: "select",
            required: true,
            defaultValue: "none",
            options: [
              { id: "none", label: "None (bring your own vectors)" },
              ...vectorizers.map((v) => ({ id: v, label: v })),
            ],
            description: "Modules the cluster has loaded",
          },
          {
            key: "vectorIndexType",
            label: "Vector index",
            kind: "select",
            required: false,
            defaultValue: "hnsw",
            options: [
              { id: "hnsw", label: "HNSW", description: "Graph index, best for large collections" },
              { id: "flat", label: "Flat", description: "Brute force, small or per-tenant data" },
              { id: "dynamic", label: "Dynamic", description: "Flat until it grows, then HNSW" },
            ],
          },
          {
            key: "properties",
            label: "Properties",
            kind: "key-value-list",
            required: false,
            entryKeyLabel: "Property",
            entryKeyPlaceholder: "title",
            entryKeyName: "name",
            entryValueLabel: "Type",
            entryValueName: "dataType",
            entryValueOptions: DATA_TYPES.map((d) => ({ id: d, label: d })),
            entryValueDefault: "text",
            addLabel: "Add property",
          },
          {
            key: "replicationFactor",
            label: "Replication factor",
            kind: "number",
            required: false,
            minValue: 1,
            defaultValue: "1",
          },
          {
            key: "multiTenancy",
            label: "Multi-tenancy",
            kind: "select",
            required: false,
            defaultValue: "false",
            options: [
              { id: "false", label: "Off" },
              { id: "true", label: "On (one shard per tenant)" },
            ],
            description: "Cannot be changed after the collection is created",
          },
        ];
        return { fields };
      }
      case "tenant": {
        const fromCollection = parentResourceId?.split(":")[1] === "collection";
        return {
          fields: [
            ...(fromCollection
              ? []
              : [
                  {
                    key: "collection",
                    label: "Collection",
                    kind: "select" as const,
                    required: true,
                    description: "Only multi-tenant collections",
                    options: await this.collectionOptions(
                      conn,
                      (c) => c.multiTenancyConfig?.enabled === true,
                    ),
                  },
                ]),
            {
              key: "names",
              label: "Tenant names",
              kind: "string-list",
              required: true,
              addLabel: "Add tenant",
            },
            {
              key: "activityStatus",
              label: "Start as",
              kind: "select",
              required: false,
              defaultValue: "ACTIVE",
              options: [
                { id: "ACTIVE", label: "Active" },
                { id: "INACTIVE", label: "Inactive" },
              ],
            },
          ],
        };
      }
      case "alias":
        return {
          fields: [
            {
              key: "alias",
              label: "Alias",
              kind: "text",
              required: true,
              placeholder: "ArticleLive",
            },
            {
              key: "collection",
              label: "Collection",
              kind: "select",
              required: true,
              options: await this.collectionOptions(conn),
            },
          ],
        };
      case "backup": {
        const backends = backupBackends(await this.meta(conn).catch(() => undefined));
        if (!backends.length) {
          throw new Error(
            "This cluster has no backup module enabled, so it cannot take backups through the API.",
          );
        }
        return {
          fields: [
            {
              key: "id",
              label: "Backup ID",
              kind: "text",
              required: true,
              description: "Lowercase letters, digits, hyphens and underscores",
            },
            {
              key: "backend",
              label: "Backend",
              kind: "select",
              required: true,
              defaultValue: backends[0]!,
              options: backends.map((b) => ({ id: b, label: b })),
            },
            {
              key: "include",
              label: "Collections",
              kind: "policy-picker",
              required: false,
              description: "Leave empty to back up every collection",
              policies: (await this.collectionOptions(conn)).map((c) => ({
                id: c.id,
                label: c.label,
              })),
            },
          ],
        };
      }
      case "db-user": {
        const roles = await conn.api.request<WvRole[]>("/authz/roles").catch(() => [] as WvRole[]);
        return {
          fields: [
            {
              key: "userId",
              label: "User ID",
              kind: "text",
              required: true,
              placeholder: "ingest-service",
            },
            {
              key: "roles",
              label: "Roles",
              kind: "policy-picker",
              required: false,
              policies: roles.map((r) => ({ id: r.name, label: r.name })),
            },
          ],
        };
      }
      default:
        throw new Error(`Weaviate plugin: cannot create "${typeId}"`);
    }
  }

  /** Check a pasted key against the cluster before keeping it. */
  private async probe(endpoint: string, apiKey: string): Promise<Conn> {
    const key = clusterKeyOf(endpoint);
    if (!key) throw new Error("Enter the cluster's REST endpoint.");
    const conn = this.makeConn(key, normalizeEndpoint(endpoint), apiKey, "stored");
    try {
      await conn.api.request("/schema");
    } catch (e) {
      if (isStatus(e, 401, 403)) {
        throw new Error(
          "The cluster refused that API key. Copy an Admin key from its details panel.",
        );
      }
      throw e;
    }
    return conn;
  }

  private async createCluster(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceCreateReturn> {
    const mode = str(fields["mode"]) || (this.cloud ? "create" : "connect");
    if (mode === "connect") {
      const endpoint = normalizeEndpoint(str(fields["endpoint"]));
      const apiKey = str(fields["apiKey"]);
      const key = clusterKeyOf(endpoint);
      if (this.credentialConns.has(key)) throw new Error(`Cluster ${key} is already connected.`);
      const conn = await this.probe(endpoint, apiKey);
      const scope = { accountId, key };
      const listed = (await this.cloudClusters(accountId).catch(() => [] as WcCluster[])).find(
        (c) => keyForCloud(c) === key,
      );
      if (listed) {
        // Listed by the organization: keep the key beside the cluster.
        await this.storeSecret(clusterResourceId(scope), CLUSTER_KEY_FIELD, apiKey);
        this.storedConns.set(key, conn);
        return await this.getResource("cluster", clusterResourceId(scope), accountId);
      }
      // Anything else is remembered in the account's More clusters credential,
      // where it can be edited or removed later.
      const line = apiKey ? `${endpoint} ${apiKey}` : endpoint;
      const next = [this.rawClusters.trim(), line].filter(Boolean).join("\n");
      const credConn = { ...conn, connection: "credentials" as const };
      this.credentialConns.set(key, credConn);
      const [meta, nodes] = await Promise.all([
        this.meta(credConn).catch(() => undefined),
        this.nodes(credConn).catch(() => undefined),
      ]);
      return {
        resource: mapCluster({ scope, endpoint, connection: "credentials", meta, nodes }),
        warnings: [],
        credentialUpdates: { clusters: next },
      };
    }
    if (!this.cloud) {
      throw new Error(
        "Creating clusters needs a Weaviate Cloud sign-in on this account (wcloud refresh token).",
      );
    }
    const name = str(fields["name"]);
    if (name && !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(name)) {
      throw new Error("Cluster names use letters, digits and hyphens.");
    }
    const region = str(fields["region"]);
    const created = await this.cloud.createCluster(accountId, {
      ...(name ? { name } : {}),
      ...(region ? { region } : {}),
      tier: str(fields["tier"]) || "free",
    });
    this.cloudCache = undefined;
    const key = keyForCloud(created);
    const scope = { accountId, key };
    const value = created.api_key?.value;
    if (value && created.endpoint) {
      await this.storeSecret(clusterResourceId(scope), CLUSTER_KEY_FIELD, value);
    } else {
      await this.storeSecret(`${accountId}:cluster:wcd-${created.id}`, PENDING_KEY_FIELD, "1");
    }
    return mapCluster({
      scope,
      endpoint: created.endpoint ? normalizeEndpoint(created.endpoint) : "",
      cloud: created,
      connection: value ? "stored" : "none",
    });
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceCreateReturn> {
    if (accountId) this.lastAccountId = accountId;
    if (typeId === "cluster") return this.createCluster(accountId, fields);
    const target = await this.formConn(parentResourceId);
    const conn = target.conn;
    const scope = { accountId, key: conn.key };
    switch (typeId) {
      case "collection": {
        const name = str(fields["name"]);
        checkCollectionName(name);
        const vectorizer = str(fields["vectorizer"]) || "none";
        const rf = intField(fields["replicationFactor"], "Replication factor", 1);
        const body: Record<string, unknown> = {
          class: name,
          vectorizer,
          vectorIndexType: str(fields["vectorIndexType"]) || "hnsw",
          properties: parseProperties(fields["properties"]),
          ...(str(fields["description"]) ? { description: str(fields["description"]) } : {}),
          ...(rf ? { replicationConfig: { factor: rf } } : {}),
          ...(fields["multiTenancy"] === "true" ? { multiTenancyConfig: { enabled: true } } : {}),
        };
        const c = await conn.api.request<WvClass>("/schema", { method: "POST", body });
        return mapCollection(c ?? (body as WvClass), undefined, scope);
      }
      case "tenant": {
        const collection =
          parentResourceId?.split(":")[1] === "collection"
            ? partsOf(parentResourceId, 1)[0]!
            : str(fields["collection"]);
        if (!collection) throw new Error("Choose a multi-tenant collection.");
        const names = parseList(fields["names"]);
        if (!names.length) throw new Error("Enter at least one tenant name.");
        const status = str(fields["activityStatus"]) || "ACTIVE";
        const created = await conn.api.request<WvTenant[]>(`/schema/${enc(collection)}/tenants`, {
          method: "POST",
          body: names.map((n) => ({ name: n, activityStatus: status })),
        });
        const first = created?.[0] ?? { name: names[0]!, activityStatus: status };
        return mapTenant(collection, first, scope);
      }
      case "alias": {
        const alias = str(fields["alias"]);
        checkCollectionName(alias);
        const collection = str(fields["collection"]);
        if (!collection) throw new Error("Choose the collection the alias points to.");
        await conn.api.request("/aliases", { method: "POST", body: { alias, class: collection } });
        return mapAlias({ alias, class: collection }, scope);
      }
      case "backup": {
        const b = await this.startBackup(conn, fields);
        return mapBackup(b, str(fields["backend"]) || b.backend || "", scope);
      }
      case "db-user": {
        const userId = str(fields["userId"]);
        if (!/^[A-Za-z0-9_.@-]{1,128}$/.test(userId)) {
          throw new Error("User IDs use letters, digits, dots, @, underscores and hyphens.");
        }
        const res = await conn.api.request<{ apikey?: string }>(`/users/db/${enc(userId)}`, {
          method: "POST",
          body: {},
        });
        const roles = parseList(fields["roles"]);
        if (roles.length) {
          await conn.api.request(`/authz/users/${enc(userId)}/assign`, {
            method: "POST",
            body: { roles, userType: "db" },
          });
        }
        const inst = mapUser({ userId, roles, active: true, dbUserType: "db_user" }, scope);
        if (res?.apikey)
          await this.services?.secrets?.setPlaintext?.(inst.id, USER_KEY_FIELD, res.apikey);
        return inst;
      }
      default:
        throw new Error(`Weaviate plugin: cannot create "${typeId}"`);
    }
  }

  private async startBackup(conn: Conn, fields: Record<string, string>): Promise<WvBackup> {
    const id = str(fields["id"]);
    if (!/^[a-z0-9_-]+$/.test(id)) {
      throw new Error("Backup IDs use lowercase letters, digits, hyphens and underscores.");
    }
    let backend = str(fields["backend"]);
    if (!backend) backend = backupBackends(await this.meta(conn))[0] ?? "";
    if (!backend) throw new Error("This cluster has no backup module enabled.");
    const include = parseList(fields["include"]);
    const res = await conn.api.request<WvBackup>(`/backups/${enc(backend)}`, {
      method: "POST",
      body: { id, ...(include.length ? { include } : {}) },
    });
    return {
      ...(res ?? { id }),
      id: res?.id ?? id,
      backend,
      ...(res?.status ? {} : { status: "STARTED" }),
    };
  }

  // ── Update ───────────────────────────────────────────────────────────

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const { conn } = await this.connFor(resourceId);
    switch (typeId) {
      case "collection": {
        const [id] = partsOf(resourceId, 1);
        const current = await conn.api.request<WvClass>(`/schema/${enc(id!)}`);
        const next: WvClass = JSON.parse(JSON.stringify(current)) as WvClass;
        let changed = false;
        if (fields["description"] !== undefined) {
          next.description = fields["description"];
          changed = true;
        }
        const rf = intField(fields["replicationFactor"], "Replication factor", 1);
        if (rf !== undefined) {
          next.replicationConfig = { ...(next.replicationConfig ?? {}), factor: rf };
          changed = true;
        }
        for (const k of ["autoTenantCreation", "autoTenantActivation"] as const) {
          if (fields[k] !== undefined && fields[k] !== "") {
            if (!next.multiTenancyConfig?.enabled) {
              throw new Error("Tenant settings only apply to multi-tenant collections.");
            }
            next.multiTenancyConfig = { ...next.multiTenancyConfig, [k]: fields[k] === "true" };
            changed = true;
          }
        }
        if (changed) {
          await conn.api.request(`/schema/${enc(id!)}`, { method: "PUT", body: next });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "tenant": {
        const status = str(fields["activityStatus"]);
        if (status) {
          if (!["ACTIVE", "INACTIVE", "OFFLOADED"].includes(status)) {
            throw new Error(`A tenant can be set to ${TENANT_STATUSES.slice(0, 3).join(", ")}.`);
          }
          await this.setTenantStatus(conn, resourceId, status);
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "alias": {
        const [id] = partsOf(resourceId, 1);
        const collection = str(fields["collection"]);
        if (collection) {
          await conn.api.request(`/aliases/${enc(id!)}`, {
            method: "PUT",
            body: { class: collection },
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "db-user": {
        const [id] = partsOf(resourceId, 1);
        if (fields["roles"] !== undefined) {
          const current = await conn.api.request<WvDbUser>(`/users/db/${enc(id!)}`);
          const have = new Set(current.roles ?? []);
          const want = new Set(parseList(fields["roles"]));
          const add = [...want].filter((r) => !have.has(r));
          const remove = [...have].filter((r) => !want.has(r));
          if (add.length) {
            await conn.api.request(`/authz/users/${enc(id!)}/assign`, {
              method: "POST",
              body: { roles: add, userType: "db" },
            });
          }
          if (remove.length) {
            await conn.api.request(`/authz/users/${enc(id!)}/revoke`, {
              method: "POST",
              body: { roles: remove, userType: "db" },
            });
          }
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      default:
        throw new Error(`Weaviate plugin: cannot update "${typeId}"`);
    }
  }

  private async setTenantStatus(conn: Conn, resourceId: string, status: string): Promise<void> {
    const [collection, name] = partsOf(resourceId, 2);
    await conn.api.request(`/schema/${enc(collection!)}/tenants`, {
      method: "PUT",
      body: [{ name, activityStatus: status }],
    });
  }

  // ── Delete ───────────────────────────────────────────────────────────

  async deleteResource(typeId: string, resourceId: string): Promise<void> {
    const { conn } = await this.connFor(resourceId);
    switch (typeId) {
      case "collection": {
        const [id] = partsOf(resourceId, 1);
        await conn.api.request(`/schema/${enc(id!)}`, { method: "DELETE" });
        return;
      }
      case "tenant": {
        const [collection, name] = partsOf(resourceId, 2);
        await conn.api.request(`/schema/${enc(collection!)}/tenants`, {
          method: "DELETE",
          body: [name],
        });
        return;
      }
      case "alias": {
        const [id] = partsOf(resourceId, 1);
        await conn.api.request(`/aliases/${enc(id!)}`, { method: "DELETE" });
        return;
      }
      case "db-user": {
        const [id] = partsOf(resourceId, 1);
        await conn.api.request(`/users/db/${enc(id!)}`, { method: "DELETE" });
        return;
      }
      case "role": {
        const [id] = partsOf(resourceId, 1);
        await conn.api.request(`/authz/roles/${enc(id!)}`, { method: "DELETE" });
        return;
      }
      default:
        throw new Error(`Weaviate plugin: cannot delete "${typeId}"`);
    }
  }

  // ── Actions ──────────────────────────────────────────────────────────

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    if (typeId === "cluster" && actionId === "disconnect") {
      const { scope } = splitScoped(resourceId);
      if (this.credentialConns.has(scope.key)) {
        throw new Error(
          "This cluster comes from the account's credentials; remove it from More clusters in the account settings.",
        );
      }
      await this.storeSecret(
        clusterResourceId({ accountId: accountId || scope.accountId, key: scope.key }),
        CLUSTER_KEY_FIELD,
        "",
      );
      this.storedConns.delete(scope.key);
      return;
    }
    const { conn } = await this.connFor(resourceId);
    if (typeId === "db-user") {
      const [id] = partsOf(resourceId, 1);
      if (actionId === "rotate-key") {
        const res = await conn.api.request<{ apikey?: string }>(
          `/users/db/${enc(id!)}/rotate-key`,
          { method: "POST" },
        );
        if (res?.apikey)
          await this.services?.secrets?.setPlaintext?.(resourceId, USER_KEY_FIELD, res.apikey);
        return;
      }
      if (actionId === "activate" || actionId === "deactivate") {
        await conn.api.request(`/users/db/${enc(id!)}/${actionId}`, { method: "POST", body: {} });
        return;
      }
    }
    if (typeId === "tenant" && (actionId === "activate" || actionId === "deactivate")) {
      await this.setTenantStatus(conn, resourceId, actionId === "activate" ? "ACTIVE" : "INACTIVE");
      return;
    }
    if (typeId === "backup") {
      const [backend, name] = partsOf(resourceId, 2);
      if (actionId === "restore") {
        await conn.api.request(`/backups/${enc(backend!)}/${enc(name!)}/restore`, {
          method: "POST",
          body: {},
        });
        return;
      }
      if (actionId === "cancel") {
        await conn.api.request(`/backups/${enc(backend!)}/${enc(name!)}`, { method: "DELETE" });
        return;
      }
    }
    throw new Error(`Weaviate plugin: action "${actionId}" is not supported for "${typeId}"`);
  }

  /** Connect: keep a pasted key, or claim the one-time key of a cluster that has not revealed it. */
  private async connectCluster(resourceId: string, accountId: string, apiKey: string) {
    const { scope } = splitScoped(resourceId);
    const acct = accountId || scope.accountId;
    if (this.credentialConns.has(scope.key)) {
      throw new Error(
        "This cluster's key comes from the account's credentials; edit it in the account settings.",
      );
    }
    let key = apiKey;
    if (!key) {
      const listed = (await this.cloudClusters(acct)).find((c) => keyForCloud(c) === scope.key);
      if (!listed || !this.cloud) throw new Error("Paste an API key for this cluster.");
      const full = await this.cloud.cluster(acct, listed.id);
      key = full.api_key?.value ?? "";
      if (!key) {
        throw new Error(
          "Weaviate Cloud has already shown this cluster's key once and will not again. Create a key in the cluster's API Keys panel in the console and paste it here.",
        );
      }
    }
    const conn = await this.probe(`https://${scope.key}`, key);
    await this.storeSecret(
      clusterResourceId({ accountId: acct, key: scope.key }),
      CLUSTER_KEY_FIELD,
      key,
    );
    this.storedConns.set(scope.key, conn);
    return { connected: true };
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    if (typeId === "cluster" && command === "connect") {
      return this.connectCluster(resourceId, accountId, str(parseFormArg(args[0])["apiKey"]));
    }
    if (typeId === "cluster" && command === "createBackup") {
      const { conn } = await this.connFor(resourceId);
      return this.startBackup(conn, parseFormArg(args[0]));
    }
    throw new Error(`Weaviate plugin: unknown command "${command}"`);
  }

  // ── Metrics ──────────────────────────────────────────────────────────

  /**
   * Weaviate exposes no time-series API over REST (Prometheus metrics, when
   * enabled, are on a separate port Weaviate Cloud does not expose). The
   * node stats are current values; the host's metrics warehouse turns
   * successive readings into a history.
   */
  async fetchMetricSeries(resourceTypeId: string, resourceId: string): Promise<MetricSeries[]> {
    const { scope, parts } = splitScoped(resourceId);
    const conn = await this.conn(scope.accountId, scope.key);
    if (!conn) return [];
    const now = Date.now();
    const nodes = await this.nodes(conn);
    const point = (label: string, unit: string, value: number): MetricSeries => ({
      label,
      unit,
      points: [{ timestamp: now, value }],
    });
    if (resourceTypeId === "cluster") {
      const shards = nodes.flatMap((n) => n.shards ?? []);
      return [
        point(
          "Objects",
          "objects",
          nodes.reduce((s, n) => s + (n.stats?.objectCount ?? 0), 0),
        ),
        point(
          "Shards",
          "shards",
          nodes.reduce((s, n) => s + (n.stats?.shardCount ?? 0), 0),
        ),
        point("Healthy Nodes", "nodes", nodes.filter((n) => n.status === "HEALTHY").length),
        point(
          "Vector Queue",
          "vectors",
          shards.reduce((s, x) => s + (x.vectorQueueLength ?? 0), 0),
        ),
      ];
    }
    if (resourceTypeId === "collection") {
      const stats = collectionStats(nodes).get(parts.join("/"));
      if (!stats) return [];
      return [
        point("Objects", "objects", stats.objects),
        point("Shards", "shards", stats.shards),
        point("Vector Queue", "vectors", stats.queue),
      ];
    }
    return [];
  }
}
