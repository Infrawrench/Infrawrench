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
import { isStatus, WeaviateApi } from "./api.js";
import {
  CLUSTER_EXTERNAL_ID,
  collectionStats,
  externalOf,
  mapAlias,
  mapBackup,
  mapCluster,
  mapCollection,
  mapRole,
  mapTenant,
  mapUser,
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

/**
 * Weaviate plugin client: one account is one cluster, reached through its
 * REST endpoint with a cluster API key.
 */
export class WeaviateClient implements PluginClient {
  readonly api: WeaviateApi;
  private readonly apiKey: string;
  private metaCache: Cached<WvMeta> | undefined;
  private nodesCache: Cached<WvNode[]> | undefined;

  constructor(
    credentials: Record<string, string>,
    private readonly resourceTypes: ResourceTypeDefinition[],
    private readonly services?: HostServices,
  ) {
    const endpoint = str(credentials["endpoint"]);
    if (!endpoint) throw new Error("Weaviate plugin: missing endpoint credential");
    this.apiKey = str(credentials["apiKey"]);
    this.api = new WeaviateApi(endpoint, this.apiKey, credentials["caCert"] ?? "", services);
  }

  meta(): Promise<WvMeta> {
    this.metaCache = cached(this.metaCache, META_TTL_MS, () => this.api.request<WvMeta>("/meta"));
    return this.metaCache.value;
  }

  nodes(): Promise<WvNode[]> {
    this.nodesCache = cached(this.nodesCache, NODES_TTL_MS, () =>
      this.api
        .request<{ nodes?: WvNode[] }>("/nodes", { query: { output: "verbose" } })
        .then((r) => r?.nodes ?? []),
    );
    return this.nodesCache.value;
  }

  private async schema(): Promise<WvClass[]> {
    const res = await this.api.request<{ classes?: WvClass[] }>("/schema");
    return res?.classes ?? [];
  }

  // ── Listing ──────────────────────────────────────────────────────────

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "cluster": {
        const [meta, nodes] = await Promise.all([this.meta(), this.nodes()]);
        return [mapCluster(this.api.endpoint, meta, nodes, accountId)];
      }
      case "collection": {
        const [classes, nodes] = await Promise.all([this.schema(), this.nodes().catch(() => [])]);
        const stats = collectionStats(nodes);
        return classes.map((c) => mapCollection(c, stats.get(c.class), accountId));
      }
      case "tenant": {
        const classes = (await this.schema())
          .filter((c) => c.multiTenancyConfig?.enabled)
          .slice(0, MAX_TENANT_COLLECTIONS);
        const lists = await mapLimit(classes, FAN_OUT, async (c) => {
          const tenants = await this.tenants(c.class);
          return tenants.map((t) => mapTenant(c.class, t, accountId));
        });
        return lists.flat();
      }
      case "alias": {
        try {
          const res = await this.api.request<{ aliases?: WvAlias[] }>("/aliases");
          return (res?.aliases ?? []).map((a) => mapAlias(a, accountId));
        } catch (e) {
          // Aliases arrived in Weaviate 1.32; older clusters answer 404.
          if (isStatus(e, 404, 405)) return [];
          throw e;
        }
      }
      case "backup": {
        const backends = backupBackends(await this.meta());
        const lists = await mapLimit(backends, FAN_OUT, async (backend) => {
          try {
            const res = await this.api.request<WvBackup[]>(`/backups/${enc(backend)}`);
            return (res ?? []).map((b) => mapBackup(b, backend, accountId));
          } catch (e) {
            if (isStatus(e, 404, 405, 422, 501)) return [];
            throw e;
          }
        });
        return lists.flat();
      }
      case "db-user": {
        try {
          const res = await this.api.request<WvDbUser[]>("/users/db", {
            query: { includeLastUsedTime: true },
          });
          return (res ?? []).map((u) => mapUser(u, accountId));
        } catch (e) {
          // RBAC and DB users need Weaviate 1.30+ with RBAC on.
          if (isStatus(e, 404, 405)) return [];
          throw e;
        }
      }
      case "role": {
        try {
          const res = await this.api.request<WvRole[]>("/authz/roles");
          return (res ?? []).map((r) => mapRole(r, accountId));
        } catch (e) {
          if (isStatus(e, 404, 405)) return [];
          throw e;
        }
      }
      default:
        throw new Error(`Weaviate plugin: unknown resource type "${typeId}"`);
    }
  }

  private async tenants(collection: string): Promise<WvTenant[]> {
    const res = await this.api.request<WvTenant[] | Record<string, WvTenant>>(
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
    const id = externalOf(resourceId);
    switch (typeId) {
      case "collection": {
        const [c, nodes] = await Promise.all([
          this.api.request<WvClass>(`/schema/${enc(id)}`),
          this.nodes().catch(() => []),
        ]);
        return mapCollection(c, collectionStats(nodes).get(c.class), accountId);
      }
      case "tenant": {
        const { scope, name } = splitScoped(resourceId);
        const t = await this.api.request<WvTenant>(`/schema/${enc(scope)}/tenants/${enc(name)}`);
        return mapTenant(scope, t, accountId);
      }
      case "alias": {
        const a = await this.api.request<WvAlias>(`/aliases/${enc(id)}`);
        return mapAlias(a, accountId);
      }
      case "backup": {
        const { scope: backend, name } = splitScoped(resourceId);
        const b = await this.api.request<WvBackup>(`/backups/${enc(backend)}/${enc(name)}`);
        return mapBackup(b, backend, accountId);
      }
      case "db-user":
        return mapUser(await this.api.request<WvDbUser>(`/users/db/${enc(id)}`), accountId);
      case "role":
        return mapRole(await this.api.request<WvRole>(`/authz/roles/${enc(id)}`), accountId);
      default: {
        const all = await this.listResources(typeId, accountId);
        const found = all.find((r) => r.id === resourceId || r.externalId === id);
        if (!found) throw new Error(`Weaviate plugin: ${typeId} ${id} not found`);
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
    if (typeId === "cluster" && outputKey === "apiKey") return this.apiKey;
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
    const id = resource.externalId ?? externalOf(resource.id);
    if (resource.resourceTypeId === "cluster") {
      const [nodes, classes] = await Promise.all([
        this.nodes().catch(() => [] as WvNode[]),
        this.schema().catch(() => [] as WvClass[]),
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
      const [c, nodes] = await Promise.all([
        this.api.request<WvClass>(`/schema/${enc(id)}`).catch(() => null),
        this.nodes().catch(() => [] as WvNode[]),
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
      const r = await this.api.request<WvRole>(`/authz/roles/${enc(id)}`).catch(() => null);
      if (r?.permissions?.length) {
        fields[ENRICH_PERMISSIONS] = JSON.stringify(
          r.permissions.map((p) => {
            const scope = Object.entries(p)
              .filter(([k, v]) => k !== "action" && v && typeof v === "object")
              .map(
                ([k, v]) =>
                  `${k}: ${Object.entries(v as Record<string, unknown>)
                    .map(([kk, vv]) => `${kk}=${String(vv)}`)
                    .join(" ")}`,
              )
              .join("; ");
            return { action: p.action ?? "", scope };
          }),
        );
      }
    }
    return { ...resource, fields };
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return withMetricsCapability(
      renderWeaviateDetail(resource, this.resourceTypes),
      this.resourceTypes,
      resource.resourceTypeId,
    );
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderWeaviateSidebarItem(resource);
  }

  // ── Create ───────────────────────────────────────────────────────────

  private async collectionOptions(filter: (c: WvClass) => boolean = () => true) {
    const classes = await this.schema().catch(() => [] as WvClass[]);
    return classes.filter(filter).map((c) => ({ id: c.class, label: c.class }));
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "collection": {
        const meta = await this.meta().catch(() => undefined);
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
        const fromParent = parentResourceId?.includes(":collection:") === true;
        return {
          fields: [
            ...(fromParent
              ? []
              : [
                  {
                    key: "collection",
                    label: "Collection",
                    kind: "select" as const,
                    required: true,
                    description: "Only multi-tenant collections",
                    options: await this.collectionOptions(
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
              options: await this.collectionOptions(),
            },
          ],
        };
      case "backup": {
        const backends = backupBackends(await this.meta().catch(() => undefined));
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
              policies: (await this.collectionOptions()).map((c) => ({ id: c.id, label: c.label })),
            },
          ],
        };
      }
      case "db-user": {
        const roles = await this.api.request<WvRole[]>("/authz/roles").catch(() => [] as WvRole[]);
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

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceCreateReturn> {
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
        const c = await this.api.request<WvClass>("/schema", { method: "POST", body });
        return mapCollection(c ?? (body as WvClass), undefined, accountId);
      }
      case "tenant": {
        const collection = parentResourceId?.includes(":collection:")
          ? externalOf(parentResourceId)
          : str(fields["collection"]);
        if (!collection) throw new Error("Choose a multi-tenant collection.");
        const names = parseList(fields["names"]);
        if (!names.length) throw new Error("Enter at least one tenant name.");
        const status = str(fields["activityStatus"]) || "ACTIVE";
        const created = await this.api.request<WvTenant[]>(`/schema/${enc(collection)}/tenants`, {
          method: "POST",
          body: names.map((n) => ({ name: n, activityStatus: status })),
        });
        const first = created?.[0] ?? { name: names[0]!, activityStatus: status };
        return mapTenant(collection, first, accountId);
      }
      case "alias": {
        const alias = str(fields["alias"]);
        checkCollectionName(alias);
        const collection = str(fields["collection"]);
        if (!collection) throw new Error("Choose the collection the alias points to.");
        await this.api.request("/aliases", { method: "POST", body: { alias, class: collection } });
        return mapAlias({ alias, class: collection }, accountId);
      }
      case "backup": {
        const b = await this.startBackup(fields);
        return mapBackup(b, str(fields["backend"]), accountId);
      }
      case "db-user": {
        const userId = str(fields["userId"]);
        if (!/^[A-Za-z0-9_.@-]{1,128}$/.test(userId)) {
          throw new Error("User IDs use letters, digits, dots, @, underscores and hyphens.");
        }
        const res = await this.api.request<{ apikey?: string }>(`/users/db/${enc(userId)}`, {
          method: "POST",
          body: {},
        });
        const roles = parseList(fields["roles"]);
        if (roles.length) {
          await this.api.request(`/authz/users/${enc(userId)}/assign`, {
            method: "POST",
            body: { roles, userType: "db" },
          });
        }
        const inst = mapUser({ userId, roles, active: true, dbUserType: "db_user" }, accountId);
        if (res?.apikey)
          await this.services?.secrets?.setPlaintext?.(inst.id, USER_KEY_FIELD, res.apikey);
        return inst;
      }
      default:
        throw new Error(`Weaviate plugin: cannot create "${typeId}"`);
    }
  }

  private async startBackup(fields: Record<string, string>): Promise<WvBackup> {
    const id = str(fields["id"]);
    if (!/^[a-z0-9_-]+$/.test(id)) {
      throw new Error("Backup IDs use lowercase letters, digits, hyphens and underscores.");
    }
    let backend = str(fields["backend"]);
    if (!backend) backend = backupBackends(await this.meta())[0] ?? "";
    if (!backend) throw new Error("This cluster has no backup module enabled.");
    const include = parseList(fields["include"]);
    const res = await this.api.request<WvBackup>(`/backups/${enc(backend)}`, {
      method: "POST",
      body: { id, ...(include.length ? { include } : {}) },
    });
    return { ...(res ?? { id }), id: res?.id ?? id, ...(res?.status ? {} : { status: "STARTED" }) };
  }

  // ── Update ───────────────────────────────────────────────────────────

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalOf(resourceId);
    switch (typeId) {
      case "collection": {
        const current = await this.api.request<WvClass>(`/schema/${enc(id)}`);
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
        if (changed) await this.api.request(`/schema/${enc(id)}`, { method: "PUT", body: next });
        return this.getResource(typeId, resourceId, accountId);
      }
      case "tenant": {
        const status = str(fields["activityStatus"]);
        if (status) {
          if (!["ACTIVE", "INACTIVE", "OFFLOADED"].includes(status)) {
            throw new Error(`A tenant can be set to ${TENANT_STATUSES.slice(0, 3).join(", ")}.`);
          }
          await this.setTenantStatus(resourceId, status);
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "alias": {
        const collection = str(fields["collection"]);
        if (collection) {
          await this.api.request(`/aliases/${enc(id)}`, {
            method: "PUT",
            body: { class: collection },
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "db-user": {
        if (fields["roles"] !== undefined) {
          const current = await this.api.request<WvDbUser>(`/users/db/${enc(id)}`);
          const have = new Set(current.roles ?? []);
          const want = new Set(parseList(fields["roles"]));
          const add = [...want].filter((r) => !have.has(r));
          const remove = [...have].filter((r) => !want.has(r));
          if (add.length) {
            await this.api.request(`/authz/users/${enc(id)}/assign`, {
              method: "POST",
              body: { roles: add, userType: "db" },
            });
          }
          if (remove.length) {
            await this.api.request(`/authz/users/${enc(id)}/revoke`, {
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

  private async setTenantStatus(resourceId: string, status: string): Promise<void> {
    const { scope, name } = splitScoped(resourceId);
    await this.api.request(`/schema/${enc(scope)}/tenants`, {
      method: "PUT",
      body: [{ name, activityStatus: status }],
    });
  }

  // ── Delete ───────────────────────────────────────────────────────────

  async deleteResource(typeId: string, resourceId: string): Promise<void> {
    const id = externalOf(resourceId);
    switch (typeId) {
      case "collection":
        await this.api.request(`/schema/${enc(id)}`, { method: "DELETE" });
        return;
      case "tenant": {
        const { scope, name } = splitScoped(resourceId);
        await this.api.request(`/schema/${enc(scope)}/tenants`, { method: "DELETE", body: [name] });
        return;
      }
      case "alias":
        await this.api.request(`/aliases/${enc(id)}`, { method: "DELETE" });
        return;
      case "db-user":
        await this.api.request(`/users/db/${enc(id)}`, { method: "DELETE" });
        return;
      case "role":
        await this.api.request(`/authz/roles/${enc(id)}`, { method: "DELETE" });
        return;
      default:
        throw new Error(`Weaviate plugin: cannot delete "${typeId}"`);
    }
  }

  // ── Actions ──────────────────────────────────────────────────────────

  async invokeAction(typeId: string, resourceId: string, actionId: string): Promise<void> {
    const id = externalOf(resourceId);
    if (typeId === "db-user") {
      if (actionId === "rotate-key") {
        const res = await this.api.request<{ apikey?: string }>(`/users/db/${enc(id)}/rotate-key`, {
          method: "POST",
        });
        if (res?.apikey)
          await this.services?.secrets?.setPlaintext?.(resourceId, USER_KEY_FIELD, res.apikey);
        return;
      }
      if (actionId === "activate" || actionId === "deactivate") {
        await this.api.request(`/users/db/${enc(id)}/${actionId}`, { method: "POST", body: {} });
        return;
      }
    }
    if (typeId === "tenant" && (actionId === "activate" || actionId === "deactivate")) {
      await this.setTenantStatus(resourceId, actionId === "activate" ? "ACTIVE" : "INACTIVE");
      return;
    }
    if (typeId === "backup") {
      const { scope: backend, name } = splitScoped(resourceId);
      if (actionId === "restore") {
        await this.api.request(`/backups/${enc(backend)}/${enc(name)}/restore`, {
          method: "POST",
          body: {},
        });
        return;
      }
      if (actionId === "cancel") {
        await this.api.request(`/backups/${enc(backend)}/${enc(name)}`, { method: "DELETE" });
        return;
      }
    }
    throw new Error(`Weaviate plugin: action "${actionId}" is not supported for "${typeId}"`);
  }

  async executeNoSqlCommand(
    typeId: string,
    _resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    if (typeId === "cluster" && command === "createBackup") {
      return this.startBackup(parseFormArg(args[0]));
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
    const now = Date.now();
    const nodes = await this.nodes();
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
      const stats = collectionStats(nodes).get(externalOf(resourceId));
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

export { CLUSTER_EXTERNAL_ID };
