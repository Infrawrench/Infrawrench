import type {
  CreateFieldConfig,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  RegionOption,
  ResourceInstance,
  ResourceCreateResult,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { decodePromptArgs, externalIdOf, withMetricsCapability } from "@infrawrench/plugin-base";
import type { AstraContext } from "./api.js";
import {
  METRICS_API,
  astraRequest,
  devops,
  fetchText,
  isUnavailable,
  statusOf,
  unwrapBody,
} from "./api.js";
import {
  ADMIN_ROLE_NAMES,
  apiEndpointOf,
  instance,
  isCustomRole,
  keyspacesOf,
  mapCollection,
  mapDatabase,
  mapKeyspace,
  mapPcuGroup,
  mapRegion,
  mapRole,
  mapTenant,
  mapUser,
  splitFirst,
  compact,
} from "./mappers.js";
import { DATABASE_METRICS, PCU_METRICS, parsePrometheusText, samplesToSeries } from "./metrics.js";
import { ENRICH, policyOptions, renderAstraDetail, renderAstraSidebar } from "./render.js";
import { RESOURCE_TYPES, T } from "./resource-types.js";
import type {
  AstraAccessList,
  AstraCdc,
  AstraClient,
  AstraCollection,
  AstraDatabase,
  AstraPcuAssociation,
  AstraPcuGroup,
  AstraPrivateLinkOrg,
  AstraRegion,
  AstraRole,
  AstraStreamingCluster,
  AstraTenant,
  AstraUser,
} from "./types.js";

const CACHE_MS = 20_000;
const DB_PAGE = 100;
const MAX_SNAPSHOTS = 30;
/** Data API calls wake a hibernated database, so collections are only read from active ones. */
const ACTIVE = "ACTIVE";

function csv(raw: string | undefined): string[] {
  const text = String(raw ?? "").trim();
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed))
        return parsed
          .map(String)
          .map((s) => s.trim())
          .filter(Boolean);
    } catch {
      /* fall through */
    }
  }
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function boolish(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === "") return undefined;
  return raw === "true" || raw === "1" || raw === "yes";
}

function positiveInt(raw: string | undefined, label: string, min = 0): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min)
    throw new Error(`${label} must be a whole number of at least ${min}.`);
  return n;
}

function notFound(what: string): Error {
  const err = new Error(`Astra plugin: ${what} not found`) as Error & { status: number };
  err.status = 404;
  return err;
}

export class AstraPluginClient implements PluginClient {
  readonly ctx: AstraContext;
  private cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const token = (credentials["token"] ?? "").trim();
    if (!token) throw new Error("Astra plugin: missing token credential");
    this.ctx = { token, ...(services?.http ? { http: services.http } : {}) };
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private cached<V>(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as Promise<V>;
    const value = load();
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => this.cache.delete(key));
    return value;
  }

  private invalidate(): void {
    this.cache.clear();
  }

  private api<V>(
    method: string,
    path: string,
    opts: Parameters<typeof devops>[3] = {},
  ): Promise<V> {
    return devops<V>(this.ctx, method, path, opts);
  }

  private async optional<V>(load: () => Promise<V>, fallback: V): Promise<V> {
    try {
      return await load();
    } catch (err) {
      if (isUnavailable(err)) return fallback;
      throw err;
    }
  }

  /** One Data API command against a database's endpoint. */
  private dataApi<V>(endpoint: string, path: string, command: Record<string, unknown>): Promise<V> {
    return astraRequest<V>(this.ctx, "POST", `${endpoint.replace(/\/$/, "")}/api/json/v1/${path}`, {
      body: command,
      dataApi: true,
    });
  }

  org(): Promise<{ id: string; name?: string }> {
    return this.cached("org", () =>
      this.api<{ id: string; name?: string }>("GET", "/v2/currentOrg"),
    );
  }

  databases(): Promise<AstraDatabase[]> {
    return this.cached("databases", async () => {
      const out: AstraDatabase[] = [];
      let after: string | undefined;
      for (let page = 0; page < 50; page++) {
        const batch =
          (await this.api<AstraDatabase[]>("GET", "/v2/databases", {
            query: [
              ["include", "nonterminated"],
              ["limit", DB_PAGE],
              ["starting_after", after],
            ],
          })) ?? [];
        out.push(...batch);
        if (batch.length < DB_PAGE) break;
        after = batch[batch.length - 1]!.id;
      }
      return out;
    });
  }

  private async database(id: string): Promise<AstraDatabase> {
    const hit = (await this.databases()).find((d) => d.id === id);
    if (hit) return hit;
    return this.api<AstraDatabase>("GET", `/v2/databases/${encodeURIComponent(id)}`);
  }

  private accessLists(): Promise<AstraAccessList[]> {
    return this.cached("access-lists", () =>
      this.optional(
        async () => (await this.api<AstraAccessList[]>("GET", "/v2/access-lists")) ?? [],
        [],
      ),
    );
  }

  private privateLinks(): Promise<AstraPrivateLinkOrg> {
    return this.cached("private-links", () =>
      this.optional(
        async () =>
          (await this.api<AstraPrivateLinkOrg>("GET", "/v2/organizations/private-link")) ?? {},
        {},
      ),
    );
  }

  pcuGroups(): Promise<AstraPcuGroup[]> {
    return this.cached("pcu-groups", () =>
      this.optional(
        async () =>
          (await this.api<AstraPcuGroup[]>("POST", "/v2/pcus/actions/get", { body: {} })) ?? [],
        [],
      ),
    );
  }

  private associations(groupId: string): Promise<AstraPcuAssociation[]> {
    return this.cached(`assoc-${groupId}`, () =>
      this.optional(
        async () =>
          (await this.api<AstraPcuAssociation[]>(
            "GET",
            `/v2/pcus/association/${encodeURIComponent(groupId)}`,
          )) ?? [],
        [],
      ),
    );
  }

  tenants(): Promise<AstraTenant[]> {
    return this.cached("tenants", () =>
      this.optional(
        async () => unwrapBody<AstraTenant[]>(await this.api("GET", "/v2/streaming/tenants")) ?? [],
        [],
      ),
    );
  }

  private roles(): Promise<AstraRole[]> {
    return this.cached("roles", () =>
      this.optional(
        async () => (await this.api<AstraRole[]>("GET", "/v2/organizations/roles")) ?? [],
        [],
      ),
    );
  }

  private users(): Promise<AstraUser[]> {
    return this.cached("users", () =>
      this.optional(
        async () =>
          (await this.api<{ users?: AstraUser[] }>("GET", "/v2/organizations/users"))?.users ?? [],
        [],
      ),
    );
  }

  private clients(): Promise<AstraClient[]> {
    return this.cached("clients", () =>
      this.optional(
        async () =>
          (await this.api<{ clients?: AstraClient[] }>("GET", "/v2/clientIdSecrets"))?.clients ??
          [],
        [],
      ),
    );
  }

  private async collections(db: AstraDatabase, keyspace: string): Promise<AstraCollection[]> {
    const res = await this.dataApi<{ status?: { collections?: Array<AstraCollection | string> } }>(
      apiEndpointOf(db),
      encodeURIComponent(keyspace),
      { findCollections: { options: { explain: true } } },
    );
    return (res?.status?.collections ?? []).map((c) => (typeof c === "string" ? { name: c } : c));
  }

  // -------------------------------------------------------------------------
  // Inventory
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case T.database: {
        const [dbs, lists] = await Promise.all([this.databases(), this.accessLists()]);
        return dbs.map((db) => {
          const list = lists.find((l) => l.databaseId === db.id);
          return mapDatabase(accountId, db, {
            ...(list
              ? {
                  enabled: list.configurations?.accessListEnabled ?? false,
                  entries: list.addresses?.length ?? 0,
                }
              : {}),
          });
        });
      }
      case T.region: {
        const [dbs, links] = await Promise.all([this.databases(), this.privateLinks()]);
        const linkByDc = new Map<string, { serviceName?: string; allowedPrincipals?: string[] }>();
        for (const c of links.clusters ?? []) {
          for (const d of c.datacenters ?? []) if (d.datacenterID) linkByDc.set(d.datacenterID, d);
        }
        return dbs.flatMap((db) =>
          (db.info?.datacenters ?? []).map((dc) =>
            mapRegion(accountId, db, dc, linkByDc.get(dc.id ?? "")),
          ),
        );
      }
      case T.keyspace:
        return (await this.databases()).flatMap((db) =>
          keyspacesOf(db).map((ks) => mapKeyspace(accountId, db, ks)),
        );
      case T.collection: {
        const out: ResourceInstance[] = [];
        for (const db of await this.databases()) {
          if ((db.status ?? "").toUpperCase() !== ACTIVE) continue;
          for (const ks of keyspacesOf(db)) {
            try {
              for (const c of await this.collections(db, ks))
                out.push(mapCollection(accountId, db.id, ks, c));
            } catch (err) {
              if (statusOf(err) === 401) throw err;
              // A non-vector database without the Data API, or a keyspace it refuses: no collections.
            }
          }
        }
        return out;
      }
      case T.accessEntry: {
        const lists = await this.accessLists();
        return lists.flatMap((l) =>
          (l.addresses ?? [])
            .filter((a) => a.address && l.databaseId)
            .map((a) =>
              instance(
                accountId,
                T.accessEntry,
                `${l.databaseId}/${a.address}`,
                a.description ? `${a.address} (${a.description})` : a.address!,
                compact({
                  address: a.address,
                  databaseId: l.databaseId,
                  enabled: a.enabled,
                  description: a.description,
                  updatedAt: a.lastUpdateDateTime,
                }),
                { typeId: T.database, externalId: l.databaseId! },
              ),
            ),
        );
      }
      case T.cdc: {
        const out: ResourceInstance[] = [];
        for (const db of await this.databases()) {
          const cdc = await this.optional(
            () => this.api<AstraCdc>("GET", `/v3/databases/${encodeURIComponent(db.id)}/cdc`),
            undefined as AstraCdc | undefined,
          );
          for (const t of cdc?.tables ?? []) {
            if (!t.keyspaceName || !t.tableName) continue;
            out.push(
              instance(
                accountId,
                T.cdc,
                `${db.id}/${t.keyspaceName}/${t.tableName}`,
                `${t.keyspaceName}.${t.tableName}`,
                compact({
                  table: t.tableName,
                  keyspace: t.keyspaceName,
                  databaseId: db.id,
                  tenants: Array.from(
                    new Set((cdc?.regions ?? []).map((r) => r.streamingTenantName)),
                  ).join(", "),
                  regions: (cdc?.regions ?? []).map((r) => r.datacenterRegion).join(", "),
                }),
                { typeId: T.database, externalId: db.id },
              ),
            );
          }
        }
        return out;
      }
      case T.privateEndpoint: {
        const links = await this.privateLinks();
        const out: ResourceInstance[] = [];
        for (const c of links.clusters ?? []) {
          for (const d of c.datacenters ?? []) {
            for (const e of d.endpoints ?? []) {
              if (!c.clusterID || !d.datacenterID || !e.endpointID) continue;
              out.push(
                instance(
                  accountId,
                  T.privateEndpoint,
                  `${c.clusterID}/${d.datacenterID}/${e.endpointID}`,
                  e.description || e.endpointID,
                  compact({
                    endpointId: e.endpointID,
                    description: e.description,
                    databaseId: c.clusterID,
                    datacenterId: d.datacenterID,
                    status: e.status,
                    linkId: e.linkID,
                    createdAt: e.createdDateTime,
                  }),
                  { typeId: T.region, externalId: `${c.clusterID}/${d.datacenterID}` },
                ),
              );
            }
          }
        }
        return out;
      }
      case T.snapshot: {
        const out: ResourceInstance[] = [];
        for (const db of await this.databases()) {
          const res = await this.optional(
            () =>
              this.api<{ snapshots?: Array<{ id?: string; time?: string }> }>(
                "GET",
                `/v2/databases/${encodeURIComponent(db.id)}/snapshots`,
              ),
            {},
          );
          const snaps = (res.snapshots ?? [])
            .filter((s) => s.id)
            .sort((a, b) => String(b.time ?? "").localeCompare(String(a.time ?? "")))
            .slice(0, MAX_SNAPSHOTS);
          for (const s of snaps) {
            out.push(
              instance(
                accountId,
                T.snapshot,
                `${db.id}/${s.id}`,
                `${db.info?.name ?? db.id} · ${s.time ?? s.id}`,
                compact({ snapshotId: s.id, databaseId: db.id, createdAt: s.time }),
                { typeId: T.database, externalId: db.id },
              ),
            );
          }
        }
        return out;
      }
      case T.pcuGroup: {
        const [groups, dbs] = await Promise.all([this.pcuGroups(), this.databases()]);
        const dcName = new Map<string, string>();
        for (const db of dbs) {
          for (const dc of db.info?.datacenters ?? []) {
            if (dc.id) dcName.set(dc.id, `${db.info?.name ?? db.id} (${dc.region ?? ""})`);
          }
        }
        return Promise.all(
          groups.map(async (g) => {
            const assoc = await this.associations(g.uuid);
            const names = assoc
              .map((a) => dcName.get(a.datacenterUUID ?? "") ?? a.datacenterUUID ?? "")
              .filter(Boolean);
            return mapPcuGroup(accountId, g, names);
          }),
        );
      }
      case T.tenant:
        return (await this.tenants())
          .filter((t) => t.tenantName && t.clusterName)
          .map((t) => mapTenant(accountId, t));
      case T.role:
        return (await this.roles()).filter((r) => r.id || r.name).map((r) => mapRole(accountId, r));
      case T.user:
        return (await this.users()).map((u) => mapUser(accountId, u));
      case T.token: {
        const [clients, roles] = await Promise.all([this.clients(), this.roles()]);
        const roleName = new Map(roles.map((r) => [r.id ?? "", r.name ?? r.id ?? ""]));
        return clients
          .filter((c) => c.clientId)
          .map((c) => {
            const names = (c.roles ?? []).map((r) => roleName.get(r) ?? r);
            return instance(
              accountId,
              T.token,
              c.clientId!,
              `${c.clientId}${names.length ? ` (${names.join(", ")})` : ""}`,
              compact({
                clientId: c.clientId,
                roles: names.join(", "),
                roleIds: (c.roles ?? []).join(", "),
                createdAt: c.generatedOn,
                isAdmin: names.some((n) => ADMIN_ROLE_NAMES.has(n)),
              }),
            );
          });
      }
      default:
        throw new Error(`Astra plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const ext = externalIdOf(resourceId);
    if (typeId === T.database) {
      const [db, lists] = await Promise.all([
        this.api<AstraDatabase>("GET", `/v2/databases/${encodeURIComponent(ext)}`),
        this.accessLists(),
      ]);
      const list = lists.find((l) => l.databaseId === ext);
      return mapDatabase(accountId, db, {
        ...(list
          ? {
              enabled: list.configurations?.accessListEnabled ?? false,
              entries: list.addresses?.length ?? 0,
            }
          : {}),
      });
    }
    const found = (await this.listResources(typeId, accountId)).find((r) => r.externalId === ext);
    if (!found) throw notFound(`${typeId} ${ext}`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const ext = externalIdOf(resourceId);
    if (typeId === T.database) {
      const db = await this.api<AstraDatabase>("GET", `/v2/databases/${encodeURIComponent(ext)}`);
      switch (outputKey) {
        case "databaseId":
          return db.id;
        case "apiEndpoint":
          return apiEndpointOf(db);
        case "keyspace":
          return db.info?.keyspace ?? keyspacesOf(db)[0] ?? "";
        case "region":
          return db.info?.region ?? db.info?.datacenters?.[0]?.region ?? "";
        case "secureBundleUrl": {
          const bundles = await this.api<Array<{ downloadURL?: string }>>(
            "POST",
            `/v2/databases/${encodeURIComponent(ext)}/secureBundleURL`,
          );
          return bundles?.[0]?.downloadURL ?? "";
        }
      }
    }
    if (typeId === T.region && outputKey === "apiEndpoint") {
      const r = await this.getResource(typeId, resourceId, accountId);
      return String(r.fields["dataEndpointUrl"] ?? "");
    }
    if (typeId === T.tenant) {
      const r = await this.getResource(typeId, resourceId, accountId);
      return String(r.fields[outputKey] ?? "");
    }
    if (typeId === T.token && outputKey === "token") {
      throw new Error(
        "Astra shows a token only when it is generated. Generate a new token to get one.",
      );
    }
    throw new Error(`Astra plugin: cannot resolve "${outputKey}" for "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Detail
  // -------------------------------------------------------------------------

  private async roleOptions() {
    return (await this.roles())
      .filter((r) => r.id)
      .map((r) => ({
        id: r.id!,
        label: r.name ?? r.id!,
        category: isCustomRole(r) ? "Custom" : "Default",
        ...(r.policy?.description ? { description: r.policy.description } : {}),
      }));
  }

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const out: ResourceInstance = {
      ...resource,
      fields: { ...resource.fields },
      resolvedOutputs: { ...resource.resolvedOutputs },
    };
    const put = (key: string, value: unknown) => {
      out.resolvedOutputs[key] = JSON.stringify(value);
    };
    switch (resource.resourceTypeId) {
      case T.region: {
        const region = String(resource.fields["region"] ?? "");
        const cloud = String(resource.fields["cloud"] ?? "").toUpperCase();
        const groups = await this.pcuGroups().catch(() => []);
        put(
          ENRICH.pcuGroups,
          groups
            .filter(
              (g) =>
                g.region === region && (!cloud || (g.cloudProvider ?? "").toUpperCase() === cloud),
            )
            .map((g) => ({
              id: g.uuid,
              label: g.title || g.uuid,
              description: `${g.reserved ?? 0} reserved, ${g.min ?? 0}-${g.max ?? 0}`,
            })),
        );
        break;
      }
      case T.snapshot:
        put(
          ENRICH.databases,
          (await this.databases().catch(() => [])).map((d) => ({
            id: d.id,
            label: d.info?.name ?? d.id,
            description: d.info?.region,
          })),
        );
        break;
      case T.user:
        put(ENRICH.roles, await this.roleOptions().catch(() => []));
        break;
      case T.collection: {
        const [dbId, rest] = splitFirst(resource.externalId ?? externalIdOf(resource.id));
        const [ks, name] = splitFirst(rest);
        const db = await this.database(dbId).catch(() => undefined);
        if (db && (db.status ?? "").toUpperCase() === ACTIVE) {
          const res = await this.dataApi<{ status?: { count?: number } }>(
            apiEndpointOf(db),
            `${encodeURIComponent(ks)}/${encodeURIComponent(name)}`,
            { estimatedDocumentCount: {} },
          ).catch(() => undefined);
          if (typeof res?.status?.count === "number")
            out.fields["documentCount"] = res.status.count;
        }
        break;
      }
    }
    return out;
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return withMetricsCapability(
      renderAstraDetail(resource),
      RESOURCE_TYPES,
      resource.resourceTypeId,
    );
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderAstraSidebar(resource);
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  private regionsCache(): Promise<AstraRegion[]> {
    return this.cached("regions", async () =>
      (
        (await this.api<AstraRegion[]>("GET", "/v2/regions/serverless", {
          query: [["region-type", "all"]],
        })) ?? []
      ).filter((r) => r.enabled !== false),
    );
  }

  private async regionPicker(): Promise<RegionOption[]> {
    return (await this.regionsCache()).map((r) => ({
      id: `${(r.cloudProvider ?? "").toUpperCase()}:${r.name}`,
      label: `${(r.cloudProvider ?? "").toUpperCase()} ${r.name}`,
      ...(r.displayName ? { location: r.displayName } : {}),
      availableFor: r.region_type === "vector" ? ["vector"] : ["vector", "non-vector"],
    }));
  }

  private async databaseOptions() {
    return (await this.databases()).map((d) => ({
      id: d.id,
      label: d.info?.name ?? d.id,
      description: `${(d.info?.cloudProvider ?? "").toUpperCase()} ${d.info?.region ?? ""}`.trim(),
    }));
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    const dbField = async (): Promise<CreateFieldConfig[]> =>
      parentResourceId
        ? []
        : [
            {
              key: "databaseId",
              label: "Database",
              kind: "select",
              required: true,
              options: await this.databaseOptions(),
            },
          ];
    switch (typeId) {
      case T.database: {
        const groups = await this.pcuGroups().catch(() => []);
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "vector-search",
            },
            {
              key: "dbType",
              label: "Type",
              kind: "select",
              required: true,
              options: [
                {
                  id: "vector",
                  label: "Vector",
                  description: "Collections with vector search and the Data API",
                },
                { id: "non-vector", label: "Non-vector", description: "Tables over CQL" },
              ],
              defaultValue: "vector",
            },
            {
              key: "region",
              label: "Cloud and region",
              kind: "region-picker",
              required: true,
              regions: await this.regionPicker(),
              filterByFieldKey: "dbType",
            },
            {
              key: "keyspace",
              label: "Keyspace",
              kind: "text",
              required: false,
              placeholder: "default_keyspace",
              description:
                "Up to 48 letters, digits and underscores, starting with a letter or digit.",
            },
            ...(groups.length
              ? [
                  {
                    key: "pcuGroupId",
                    label: "PCU group (optional)",
                    kind: "select" as const,
                    required: false,
                    options: [
                      { id: "", label: "On-demand serverless" },
                      ...groups.map((g) => ({
                        id: g.uuid,
                        label: g.title || g.uuid,
                        description: `${g.cloudProvider ?? ""} ${g.region ?? ""}`,
                      })),
                    ],
                    defaultValue: "",
                  },
                ]
              : []),
          ],
        };
      }
      case T.region:
        return {
          fields: [
            ...(await dbField()),
            {
              key: "region",
              label: "Region",
              kind: "region-picker",
              required: true,
              regions: await this.regionPicker(),
              description: "Extra regions must be in the same cloud as the database.",
            },
          ],
        };
      case T.keyspace:
        return {
          fields: [
            ...(await dbField()),
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "analytics",
              description: "Up to 48 letters, digits and underscores.",
            },
          ],
        };
      case T.collection: {
        const parentFields: CreateFieldConfig[] = [];
        if (!parentResourceId) {
          const options = (await this.databases()).flatMap((db) =>
            keyspacesOf(db).map((ks) => ({
              id: `${db.id}/${ks}`,
              label: `${db.info?.name ?? db.id} / ${ks}`,
            })),
          );
          parentFields.push({
            key: "keyspaceRef",
            label: "Keyspace",
            kind: "select",
            required: true,
            options,
          });
        }
        return {
          fields: [
            ...parentFields,
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "documents" },
            {
              key: "dimension",
              label: "Vector dimension",
              kind: "number",
              required: false,
              minValue: 2,
              maxValue: 4096,
              description:
                "Leave empty for a collection without vectors. Must match your embedding model.",
            },
            {
              key: "metric",
              label: "Similarity metric",
              kind: "select",
              required: false,
              options: [
                { id: "cosine", label: "Cosine" },
                { id: "dot_product", label: "Dot product" },
                { id: "euclidean", label: "Euclidean" },
              ],
              defaultValue: "cosine",
            },
          ],
        };
      }
      case T.accessEntry:
        return {
          fields: [
            ...(await dbField()),
            {
              key: "address",
              label: "Address or CIDR",
              kind: "text",
              required: true,
              placeholder: "203.0.113.0/24",
            },
            {
              key: "description",
              label: "Description",
              kind: "text",
              required: false,
              placeholder: "Office",
            },
          ],
        };
      case T.cdc: {
        const tenants = await this.tenants().catch(() => []);
        const keyspaceOptions = parentResourceId
          ? keyspacesOf(await this.database(externalIdOf(parentResourceId))).map((k) => ({
              id: k,
              label: k,
            }))
          : [];
        return {
          fields: [
            ...(await dbField()),
            ...(keyspaceOptions.length
              ? [
                  {
                    key: "keyspace",
                    label: "Keyspace",
                    kind: "select" as const,
                    required: true,
                    options: keyspaceOptions,
                  },
                ]
              : [{ key: "keyspace", label: "Keyspace", kind: "text" as const, required: true }]),
            {
              key: "table",
              label: "Table",
              kind: "text",
              required: true,
              description: "A CQL table in that keyspace.",
            },
            {
              key: "tenant",
              label: "Streaming tenant",
              kind: "select",
              required: true,
              options: tenants.map((t) => ({
                id: `${t.clusterName}/${t.tenantName}`,
                label: t.tenantName ?? "",
                description: `${t.cloudProvider ?? ""} ${t.cloudRegion ?? ""}`.trim(),
              })),
              description: "Must be in the same region as the database.",
            },
          ],
        };
      }
      case T.privateEndpoint: {
        const regions = parentResourceId
          ? []
          : (await this.databases()).flatMap((db) =>
              (db.info?.datacenters ?? []).map((dc) => ({
                id: `${db.id}/${dc.id}`,
                label: `${db.info?.name ?? db.id} · ${dc.region ?? ""}`,
              })),
            );
        return {
          fields: [
            ...(parentResourceId
              ? []
              : [
                  {
                    key: "regionRef",
                    label: "Database region",
                    kind: "select" as const,
                    required: true,
                    options: regions,
                  },
                ]),
            {
              key: "endpointId",
              label: "Your endpoint ID",
              kind: "text",
              required: true,
              placeholder: "vpce-0123456789abcdef0",
              description:
                "The endpoint you created in your cloud account against this region's private link service.",
            },
            { key: "description", label: "Description", kind: "text", required: false },
          ],
        };
      }
      case T.pcuGroup: {
        const types = await this.optional(
          async () => (await this.api<Array<{ type?: string }>>("GET", "/v2/pcus/types")) ?? [],
          [] as Array<{ type?: string }>,
        );
        const instanceTypes = Array.from(
          new Set(types.map((t) => t.type).filter((t): t is string => !!t)),
        );
        return {
          fields: [
            { key: "title", label: "Title", kind: "text", required: true },
            {
              key: "region",
              label: "Cloud and region",
              kind: "region-picker",
              required: true,
              regions: await this.regionPicker(),
            },
            {
              key: "instanceType",
              label: "Instance type",
              kind: "select",
              required: true,
              options: (instanceTypes.length ? instanceTypes : ["standard"]).map((t) => ({
                id: t,
                label: t,
              })),
              defaultValue: instanceTypes[0] ?? "standard",
            },
            {
              key: "provisionType",
              label: "Provision type",
              kind: "select",
              required: true,
              options: [
                { id: "shared", label: "Shared" },
                { id: "dedicated", label: "Dedicated" },
              ],
              defaultValue: "shared",
            },
            {
              key: "reserved",
              label: "Reserved PCUs",
              kind: "number",
              required: true,
              minValue: 0,
              stepValue: 1,
              defaultValue: "1",
            },
            {
              key: "min",
              label: "Minimum PCUs",
              kind: "number",
              required: true,
              minValue: 1,
              stepValue: 1,
              defaultValue: "1",
            },
            {
              key: "max",
              label: "Maximum PCUs",
              kind: "number",
              required: true,
              minValue: 1,
              stepValue: 1,
              defaultValue: "2",
            },
            { key: "description", label: "Description", kind: "text", required: false },
          ],
        };
      }
      case T.tenant: {
        const [clusters, users] = await Promise.all([
          this.optional(
            async () =>
              unwrapBody<AstraStreamingCluster[]>(
                await this.api("GET", "/v2/streaming/clusters"),
              ) ?? [],
            [] as AstraStreamingCluster[],
          ),
          this.users().catch(() => []),
        ]);
        return {
          fields: [
            {
              key: "tenantName",
              label: "Tenant name",
              kind: "text",
              required: true,
              description: "Lowercase letters, digits and hyphens; unique across Astra Streaming.",
            },
            {
              key: "cluster",
              label: "Streaming cluster",
              kind: "select",
              required: true,
              options: clusters
                .filter((c) => c.clusterName)
                .map((c) => ({
                  id: c.clusterName!,
                  label: `${(c.cloudProvider ?? "").toUpperCase()} ${c.cloudRegion ?? ""}`.trim(),
                  description: c.clusterName,
                })),
            },
            {
              key: "userEmail",
              label: "Owner",
              kind: "select",
              required: true,
              options: users.filter((u) => u.email).map((u) => ({ id: u.email!, label: u.email! })),
            },
          ],
        };
      }
      case T.role: {
        const org = await this.org();
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "permissions",
              label: "Permissions",
              kind: "policy-picker",
              required: true,
              policies: policyOptions(),
            },
            {
              key: "resources",
              label: "Resources",
              kind: "string-list",
              required: true,
              defaultValue: `drn:astra:org:${org.id}`,
              description:
                "The organization, or a narrower drn such as drn:astra:org:<org>:db:<database id>.",
            },
          ],
        };
      }
      case T.user:
        return {
          fields: [
            {
              key: "email",
              label: "Email",
              kind: "text",
              required: true,
              placeholder: "teammate@example.com",
            },
            {
              key: "roles",
              label: "Roles",
              kind: "policy-picker",
              required: true,
              policies: await this.roleOptions(),
            },
          ],
        };
      case T.token:
        return {
          fields: [
            {
              key: "roles",
              label: "Roles",
              kind: "policy-picker",
              required: true,
              policies: await this.roleOptions(),
              description:
                "The token can do what these roles allow. The token is shown once, right after it is generated.",
            },
          ],
        };
      default:
        throw new Error(`Astra plugin: creating "${typeId}" is not supported`);
    }
  }

  private parentDb(fields: Record<string, string>, parentResourceId?: string): string {
    const id = parentResourceId ? externalIdOf(parentResourceId) : (fields["databaseId"] ?? "");
    if (!id) throw new Error("Pick a database.");
    return id.split("/")[0]!;
  }

  private splitRegion(value: string): { cloud: string; region: string } {
    const [cloud, region] = value.includes(":") ? value.split(":") : ["", value];
    if (!region) throw new Error("Pick a region.");
    return { cloud: (cloud ?? "").toUpperCase(), region };
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance | ResourceCreateResult> {
    this.invalidate();
    switch (typeId) {
      case T.database: {
        const name = (fields["name"] ?? "").trim();
        if (!name) throw new Error("Give the database a name.");
        const { cloud, region } = this.splitRegion(fields["region"] ?? "");
        const keyspace = (fields["keyspace"] ?? "").trim();
        if (keyspace && !/^[A-Za-z0-9][A-Za-z0-9_]{0,47}$/.test(keyspace)) {
          throw new Error(
            "Keyspace names are up to 48 letters, digits and underscores, starting with a letter or digit.",
          );
        }
        await this.api("POST", "/v2/databases", {
          body: {
            name,
            ...(keyspace ? { keyspace } : {}),
            cloudProvider: cloud,
            tier: "serverless",
            capacityUnits: 1,
            region,
            ...(fields["dbType"] === "non-vector" ? {} : { dbType: "vector" }),
            ...(fields["pcuGroupId"] ? { pcuGroupUUID: fields["pcuGroupId"] } : {}),
          },
        });
        this.invalidate();
        const created = (await this.databases())
          .filter((d) => d.info?.name === name)
          .sort((a, b) =>
            String(b.creationTime ?? "").localeCompare(String(a.creationTime ?? "")),
          )[0];
        if (created) return mapDatabase(accountId, created);
        return mapDatabase(accountId, {
          id: name,
          info: { name, region, cloudProvider: cloud },
          status: "PENDING",
        });
      }
      case T.region: {
        const dbId = this.parentDb(fields, parentResourceId);
        const { cloud, region } = this.splitRegion(fields["region"] ?? "");
        const db = await this.database(dbId);
        const dbCloud = (db.info?.cloudProvider ?? "").toUpperCase();
        if (dbCloud && cloud && dbCloud !== cloud)
          throw new Error(`This database runs on ${dbCloud}; pick a ${dbCloud} region.`);
        await this.api("POST", `/v2/databases/${encodeURIComponent(dbId)}/datacenters`, {
          body: [{ tier: db.info?.tier ?? "serverless", cloudProvider: dbCloud || cloud, region }],
        });
        return mapRegion(accountId, db, {
          id: `${dbId}-pending`,
          region,
          cloudProvider: dbCloud || cloud,
          status: "PENDING",
        });
      }
      case T.keyspace: {
        const dbId = this.parentDb(fields, parentResourceId);
        const name = (fields["name"] ?? "").trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9_]{0,47}$/.test(name)) {
          throw new Error(
            "Keyspace names are up to 48 letters, digits and underscores, starting with a letter or digit.",
          );
        }
        await this.api(
          "POST",
          `/v2/databases/${encodeURIComponent(dbId)}/keyspaces/${encodeURIComponent(name)}`,
        );
        return mapKeyspace(accountId, await this.database(dbId), name);
      }
      case T.collection: {
        const ref = parentResourceId
          ? externalIdOf(parentResourceId)
          : (fields["keyspaceRef"] ?? "");
        const [dbId, ks] = splitFirst(ref);
        const db = await this.database(dbId);
        const name = (fields["name"] ?? "").trim();
        if (!/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(name)) {
          throw new Error(
            "Collection names are up to 48 letters, digits and underscores, starting with a letter.",
          );
        }
        const options: Record<string, unknown> = {};
        if (fields["dimension"]) {
          const dimension = positiveInt(fields["dimension"], "Vector dimension", 2);
          options["vector"] = { dimension, metric: fields["metric"] || "cosine" };
        }
        await this.dataApi(apiEndpointOf(db), encodeURIComponent(ks), {
          createCollection: { name, ...(Object.keys(options).length ? { options } : {}) },
        });
        return mapCollection(accountId, dbId, ks, {
          name,
          options: options as NonNullable<AstraCollection["options"]>,
        });
      }
      case T.accessEntry: {
        const dbId = this.parentDb(fields, parentResourceId);
        const address = (fields["address"] ?? "").trim();
        if (!/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(address))
          throw new Error("Give an IP address or CIDR range.");
        await this.api("POST", `/v2/databases/${encodeURIComponent(dbId)}/access-list`, {
          body: [{ address, enabled: true, description: (fields["description"] ?? "").trim() }],
        });
        return instance(
          accountId,
          T.accessEntry,
          `${dbId}/${address}`,
          address,
          compact({ address, databaseId: dbId, enabled: true, description: fields["description"] }),
          {
            typeId: T.database,
            externalId: dbId,
          },
        );
      }
      case T.cdc: {
        const dbId = this.parentDb(fields, parentResourceId);
        const db = await this.database(dbId);
        const [cluster, tenantName] = splitFirst(fields["tenant"] ?? "");
        const tenant = (await this.tenants()).find(
          (t) => t.clusterName === cluster && t.tenantName === tenantName,
        );
        const dcs = db.info?.datacenters ?? [];
        const matching = dcs.filter(
          (dc) => !tenant?.cloudRegion || dc.region === tenant.cloudRegion,
        );
        if (!matching.length) {
          throw new Error(
            `The streaming tenant is in ${tenant?.cloudRegion ?? "another region"}; CDC needs a tenant in the database's region.`,
          );
        }
        const table = {
          keyspaceName: (fields["keyspace"] ?? "").trim(),
          tableName: (fields["table"] ?? "").trim(),
        };
        if (!table.keyspaceName || !table.tableName)
          throw new Error("Give the keyspace and table.");
        const existing = await this.optional(
          () => this.api<AstraCdc>("GET", `/v3/databases/${encodeURIComponent(dbId)}/cdc`),
          undefined as AstraCdc | undefined,
        );
        const body = {
          databaseID: dbId,
          databaseName: db.info?.name ?? dbId,
          tables: [
            ...(existing?.tables ?? []).map((t) => ({
              keyspaceName: t.keyspaceName,
              tableName: t.tableName,
            })),
            table,
          ],
          regions: matching.map((dc) => ({
            datacenterID: dc.id,
            datacenterRegion: dc.region,
            streamingClusterName: cluster,
            streamingTenantName: tenantName,
          })),
        };
        await this.api(
          existing?.tables?.length ? "PUT" : "POST",
          `/v3/databases/${encodeURIComponent(dbId)}/cdc`,
          { body },
        );
        return instance(
          accountId,
          T.cdc,
          `${dbId}/${table.keyspaceName}/${table.tableName}`,
          `${table.keyspaceName}.${table.tableName}`,
          compact({
            table: table.tableName,
            keyspace: table.keyspaceName,
            databaseId: dbId,
            tenants: tenantName,
          }),
          { typeId: T.database, externalId: dbId },
        );
      }
      case T.privateEndpoint: {
        const ref = parentResourceId ? externalIdOf(parentResourceId) : (fields["regionRef"] ?? "");
        const [dbId, dcId] = splitFirst(ref);
        const endpointId = (fields["endpointId"] ?? "").trim();
        if (!endpointId) throw new Error("Give your endpoint ID.");
        await this.api(
          "POST",
          `/v2/organizations/clusters/${encodeURIComponent(dbId)}/datacenters/${encodeURIComponent(dcId)}/endpoints`,
          { body: { endpointID: endpointId, description: (fields["description"] ?? "").trim() } },
        );
        return instance(
          accountId,
          T.privateEndpoint,
          `${dbId}/${dcId}/${endpointId}`,
          fields["description"] || endpointId,
          compact({
            endpointId,
            description: fields["description"],
            databaseId: dbId,
            datacenterId: dcId,
          }),
          { typeId: T.region, externalId: `${dbId}/${dcId}` },
        );
      }
      case T.pcuGroup: {
        const { cloud, region } = this.splitRegion(fields["region"] ?? "");
        const reserved = positiveInt(fields["reserved"], "Reserved PCUs", 0);
        const min = positiveInt(fields["min"], "Minimum PCUs", 1);
        const max = positiveInt(fields["max"], "Maximum PCUs", 1);
        if (min < reserved) throw new Error("The minimum must be at least the reserved capacity.");
        if (max < min) throw new Error("The maximum must be at least the minimum.");
        const created = await this.api<AstraPcuGroup[]>("POST", "/v2/pcus", {
          body: [
            {
              title: (fields["title"] ?? "").trim(),
              cloudProvider: cloud,
              region,
              instanceType: fields["instanceType"] || "standard",
              provisionType: fields["provisionType"] || "shared",
              reserved,
              min,
              max,
              ...(fields["description"] ? { description: fields["description"] } : {}),
            },
          ],
        });
        const g = created?.[0] ?? {
          uuid: "pending",
          title: fields["title"] ?? "",
          status: "CREATED",
        };
        return mapPcuGroup(accountId, g, []);
      }
      case T.tenant: {
        const org = await this.org();
        const tenantName = (fields["tenantName"] ?? "").trim();
        if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(tenantName)) {
          throw new Error("Tenant names are lowercase letters, digits and hyphens.");
        }
        const res = unwrapBody<AstraTenant>(
          await this.api("POST", "/v2/streaming/tenants", {
            body: {
              orgID: org.id,
              orgName: org.id,
              clusterName: fields["cluster"],
              tenantName,
              userEmail: fields["userEmail"],
            },
          }),
        );
        return mapTenant(accountId, {
          ...res,
          tenantName: res?.tenantName ?? tenantName,
          clusterName: res?.clusterName ?? fields["cluster"] ?? "",
        });
      }
      case T.role: {
        const permissions = csv(fields["permissions"]);
        const resources = csv(fields["resources"]);
        if (!permissions.length) throw new Error("Pick at least one permission.");
        if (!resources.length) throw new Error("Give at least one resource.");
        const role = await this.api<AstraRole>("POST", "/v2/organizations/roles", {
          body: {
            name: (fields["name"] ?? "").trim(),
            policy: {
              description: (fields["description"] ?? "").trim(),
              resources,
              actions: permissions,
              effect: "allow",
            },
          },
        });
        return mapRole(accountId, role ?? { name: fields["name"] ?? "" });
      }
      case T.user: {
        const org = await this.org();
        const email = (fields["email"] ?? "").trim();
        const roles = csv(fields["roles"]);
        if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error("Give a valid email address.");
        if (!roles.length) throw new Error("Pick at least one role.");
        await this.api("PUT", "/v2/organizations/users", { body: { email, orgID: org.id, roles } });
        return mapUser(accountId, { userID: email, email, status: "invited" });
      }
      case T.token: {
        const roles = csv(fields["roles"]);
        if (!roles.length) throw new Error("Pick at least one role.");
        const res = await this.api<{
          clientId?: string;
          secret?: string;
          token?: string;
          roles?: string[];
        }>("POST", "/v2/clientIdSecrets", { body: { roles } });
        const r = instance(
          accountId,
          T.token,
          res?.clientId ?? "new-token",
          res?.clientId ?? "New token",
          compact({ clientId: res?.clientId, roleIds: roles.join(", ") }),
        );
        if (res?.token) r.resolvedOutputs["token"] = res.token;
        return {
          resource: r,
          warnings: [
            {
              code: "token-shown-once",
              message:
                "Copy the token from the new resource's outputs now: Astra will not show it again.",
            },
          ],
        };
      }
      default:
        throw new Error(`Astra plugin: creating "${typeId}" is not supported`);
    }
  }

  // -------------------------------------------------------------------------
  // Update / delete
  // -------------------------------------------------------------------------

  private async putAccessList(dbId: string, mutate: (list: AstraAccessList) => AstraAccessList) {
    const current =
      (await this.optional(
        () =>
          this.api<AstraAccessList>("GET", `/v2/databases/${encodeURIComponent(dbId)}/access-list`),
        undefined as AstraAccessList | undefined,
      )) ?? {};
    const next = mutate(current);
    await this.api("PUT", `/v2/databases/${encodeURIComponent(dbId)}/access-list`, {
      body: {
        addresses: (next.addresses ?? []).map((a) => ({
          address: a.address,
          enabled: a.enabled ?? true,
          description: a.description ?? "",
        })),
        configurations: { accessListEnabled: next.configurations?.accessListEnabled ?? false },
      },
    });
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const ext = externalIdOf(resourceId);
    this.invalidate();
    switch (typeId) {
      case T.database: {
        const enforce = boolish(fields["accessListEnabled"]);
        if (enforce !== undefined) {
          await this.putAccessList(ext, (l) => {
            if (enforce && !(l.addresses ?? []).length) {
              throw new Error(
                "Add at least one access list entry before enforcing the list, or every client is locked out.",
              );
            }
            return { ...l, configurations: { accessListEnabled: enforce } };
          });
        }
        break;
      }
      case T.accessEntry: {
        const [dbId, address] = splitFirst(ext);
        await this.putAccessList(dbId, (l) => {
          const addresses = (l.addresses ?? []).map((a) =>
            a.address === address
              ? {
                  ...a,
                  ...(fields["enabled"] !== undefined
                    ? { enabled: boolish(fields["enabled"]) ?? true }
                    : {}),
                  ...(fields["description"] !== undefined
                    ? { description: fields["description"] }
                    : {}),
                }
              : a,
          );
          return { ...l, addresses };
        });
        break;
      }
      case T.privateEndpoint: {
        const [dbId, rest] = splitFirst(ext);
        const [dcId, endpointId] = splitFirst(rest);
        if (fields["description"] !== undefined) {
          await this.api(
            "PUT",
            `/v2/organizations/clusters/${encodeURIComponent(dbId)}/datacenters/${encodeURIComponent(dcId)}/endpoints/${encodeURIComponent(endpointId)}`,
            { body: { description: fields["description"] } },
          );
        }
        break;
      }
      case T.pcuGroup: {
        const current = (await this.pcuGroups()).find((g) => g.uuid === ext);
        if (!current) throw notFound(`PCU group ${ext}`);
        const pick = (key: string, cur: number | undefined) =>
          fields[key] !== undefined && fields[key] !== ""
            ? positiveInt(fields[key], key, 0)
            : (cur ?? 0);
        const reserved = pick("reserved", current.reserved);
        const min = pick("min", current.min);
        const max = pick("max", current.max);
        if (min < reserved || max < min) throw new Error("Keep reserved ≤ minimum ≤ maximum.");
        await this.api("PUT", "/v2/pcus", {
          body: [
            {
              pcuGroupUUID: ext,
              title: fields["title"] ?? current.title,
              cloudProvider: current.cloudProvider,
              region: current.region,
              instanceType: current.instanceType,
              provisionType: current.provisionType,
              reserved,
              min,
              max,
              description: fields["description"] ?? current.description ?? "",
            },
          ],
        });
        break;
      }
      case T.role: {
        const role = (await this.roles()).find((r) => r.id === ext);
        if (!role) throw notFound(`role ${ext}`);
        if (!isCustomRole(role)) throw new Error("Astra's default roles cannot be changed.");
        await this.api("PUT", `/v2/organizations/roles/${encodeURIComponent(ext)}`, {
          body: {
            name: fields["name"] ?? role.name,
            policy: {
              ...role.policy,
              effect: "allow",
              description: fields["description"] ?? role.policy?.description ?? "",
            },
          },
        });
        break;
      }
      default:
        throw new Error(`Astra plugin: updating "${typeId}" is not supported`);
    }
    this.invalidate();
    return this.getResource(typeId, resourceId, accountId);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const ext = externalIdOf(resourceId);
    this.invalidate();
    switch (typeId) {
      case T.database:
        await this.api("POST", `/v2/databases/${encodeURIComponent(ext)}/terminate`);
        return;
      case T.region: {
        const [dbId, dcId] = splitFirst(ext);
        await this.api(
          "POST",
          `/v2/databases/${encodeURIComponent(dbId)}/datacenters/${encodeURIComponent(dcId)}/terminate`,
        );
        return;
      }
      case T.keyspace: {
        const [dbId, ks] = splitFirst(ext);
        const db = await this.database(dbId);
        if (db.info?.keyspace === ks) throw new Error("The default keyspace cannot be dropped.");
        await this.api(
          "DELETE",
          `/v2/databases/${encodeURIComponent(dbId)}/keyspaces/${encodeURIComponent(ks)}`,
        );
        return;
      }
      case T.collection: {
        const [dbId, rest] = splitFirst(ext);
        const [ks, name] = splitFirst(rest);
        await this.dataApi(apiEndpointOf(await this.database(dbId)), encodeURIComponent(ks), {
          deleteCollection: { name },
        });
        return;
      }
      case T.accessEntry: {
        const [dbId, address] = splitFirst(ext);
        await this.api("DELETE", `/v2/databases/${encodeURIComponent(dbId)}/access-list`, {
          query: [["addresses", address]],
        });
        return;
      }
      case T.cdc: {
        const [dbId, rest] = splitFirst(ext);
        const [keyspaceName, tableName] = splitFirst(rest);
        await this.api("DELETE", `/v3/databases/${encodeURIComponent(dbId)}/cdc`, {
          body: { databaseID: dbId, tables: [{ keyspaceName, tableName }] },
        });
        return;
      }
      case T.privateEndpoint: {
        const [dbId, rest] = splitFirst(ext);
        const [dcId, endpointId] = splitFirst(rest);
        await this.api(
          "DELETE",
          `/v2/organizations/clusters/${encodeURIComponent(dbId)}/datacenters/${encodeURIComponent(dcId)}/endpoints/${encodeURIComponent(endpointId)}`,
        );
        return;
      }
      case T.pcuGroup:
        await this.api("DELETE", `/v2/pcus/${encodeURIComponent(ext)}`);
        return;
      case T.tenant: {
        const [cluster, tenant] = splitFirst(ext);
        await this.api(
          "DELETE",
          `/v2/streaming/tenants/${encodeURIComponent(tenant)}/clusters/${encodeURIComponent(cluster)}`,
        );
        return;
      }
      case T.role:
        await this.api("DELETE", `/v2/organizations/roles/${encodeURIComponent(ext)}`);
        return;
      case T.user:
        await this.api("DELETE", `/v2/organizations/users/${encodeURIComponent(ext)}`);
        return;
      case T.token:
        await this.api("DELETE", `/v2/clientIdSecrets/${encodeURIComponent(ext)}`);
        return;
      default:
        throw new Error(`Astra plugin: deleting "${typeId}" is not supported`);
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    const ext = externalIdOf(resourceId);
    this.invalidate();
    if (typeId === T.database && actionId === "resume") {
      // Astra has no resume endpoint: any authenticated Data API request wakes a
      // hibernated database and answers 503 while it does (the Astra CLI's own
      // `db resume` works the same way).
      const db = await this.api<AstraDatabase>("GET", `/v2/databases/${encodeURIComponent(ext)}`);
      try {
        await astraRequest(this.ctx, "GET", `${apiEndpointOf(db)}/api/json/v1/resume`, {
          dataApi: true,
        });
      } catch (err) {
        const s = statusOf(err);
        if (s === 401 || s === 403 || s === 0) throw err;
      }
      return;
    }
    if (typeId === T.database && (actionId === "park" || actionId === "unpark")) {
      await this.api("POST", `/v2/databases/${encodeURIComponent(ext)}/${actionId}`);
      return;
    }
    if (typeId === T.pcuGroup && (actionId === "park" || actionId === "unpark")) {
      await this.api("POST", `/v2/pcus/${actionId}/${encodeURIComponent(ext)}`);
      return;
    }
    if (typeId === T.region && actionId === "unassign-pcu") {
      const r = await this.getResource(typeId, resourceId, accountId);
      const group = String(r.fields["pcuGroupId"] ?? "");
      if (!group) throw new Error("This region is not on a PCU group.");
      const [, dcId] = splitFirst(ext);
      await this.api(
        "DELETE",
        `/v2/pcus/association/${encodeURIComponent(group)}/${encodeURIComponent(dcId)}`,
      );
      return;
    }
    if (actionId === "revoke" && (typeId === T.user || typeId === T.token)) {
      await this.deleteResource(typeId, resourceId, accountId);
      return;
    }
    throw new Error(`Astra plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const form = decodePromptArgs(args);
    const ext = externalIdOf(resourceId);
    this.invalidate();
    if (typeId === T.database && command === "secure-bundle") {
      const bundles = await this.api<
        Array<{ datacenterID?: string; downloadURL?: string; downloadURLInternal?: string }>
      >("POST", `/v2/databases/${encodeURIComponent(ext)}/secureBundleURL`, {
        query: [["all", form["all"] === "true" ? "true" : undefined]],
      });
      const lines = (bundles ?? []).map(
        (b) => `${b.datacenterID ?? "bundle"}: ${b.downloadURL ?? ""}`,
      );
      return {
        ok: true,
        message: lines.length
          ? `Valid for about five minutes:\n${lines.join("\n")}`
          : "No bundle was returned.",
      };
    }
    if (typeId === T.region && command === "assign-pcu") {
      const target = form["pcuGroupId"];
      if (!target) throw new Error("Pick a PCU group.");
      const r = await this.getResource(typeId, resourceId, accountId);
      const [, dcId] = splitFirst(ext);
      const current = String(r.fields["pcuGroupId"] ?? "");
      if (current) {
        await this.api("POST", "/v2/pcus/association/transfer", {
          body: { fromPCUGroupUUID: current, toPCUGroupUUID: target, datacenterUUID: dcId },
        });
      } else {
        await this.api(
          "POST",
          `/v2/pcus/association/${encodeURIComponent(target)}/${encodeURIComponent(dcId)}`,
        );
      }
      return { ok: true, message: "PCU group updated." };
    }
    if (typeId === T.region && command === "allow-principals") {
      const principals = csv(form["principals"]);
      if (!principals.length) throw new Error("Give at least one principal.");
      const [dbId, dcId] = splitFirst(ext);
      const res = await this.api<{ serviceName?: string }>(
        "POST",
        `/v2/organizations/clusters/${encodeURIComponent(dbId)}/datacenters/${encodeURIComponent(dcId)}/allowed-principals`,
        { body: { allowedPrincipals: principals } },
      );
      return {
        ok: true,
        message: res?.serviceName
          ? `Saved. Create an endpoint in your cloud account against ${res.serviceName}, then add it here as a private endpoint.`
          : "Saved.",
      };
    }
    if (typeId === T.snapshot && command === "clone") {
      const [sourceDb, snapshotId] = splitFirst(ext);
      const target = form["targetDatabaseId"];
      if (!target) throw new Error("Pick the database to clone into.");
      if (target === sourceDb)
        throw new Error("Pick a different database than the snapshot's own.");
      const res = await this.api<{ status?: string; operationID?: string }>(
        "POST",
        `/v2/databases/${encodeURIComponent(target)}/cloneFrom/${encodeURIComponent(sourceDb)}`,
        { query: [["snapshotID", snapshotId]] },
      );
      return { ok: true, message: `Clone started${res?.status ? ` (${res.status})` : ""}.` };
    }
    if (typeId === T.user && command === "set-roles") {
      const roles = csv(form["roles"]);
      if (!roles.length) throw new Error("Pick at least one role.");
      await this.api("PUT", `/v2/organizations/users/${encodeURIComponent(ext)}/roles`, {
        body: { roles },
      });
      return { ok: true, message: "Roles updated." };
    }
    if (typeId === T.role && command === "set-permissions") {
      const role = (await this.roles()).find((r) => r.id === ext);
      if (!role) throw notFound(`role ${ext}`);
      if (!isCustomRole(role)) throw new Error("Astra's default roles cannot be changed.");
      const actions = csv(form["permissions"]);
      const resources = csv(form["resources"]);
      if (!actions.length || !resources.length)
        throw new Error("Pick at least one permission and one resource.");
      await this.api("PUT", `/v2/organizations/roles/${encodeURIComponent(ext)}`, {
        body: {
          name: role.name,
          policy: {
            description: role.policy?.description ?? "",
            resources,
            actions,
            effect: "allow",
          },
        },
      });
      return { ok: true, message: "Permissions updated." };
    }
    throw new Error(`Astra plugin: command "${command}" is not supported for "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Observability
  // -------------------------------------------------------------------------

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
  ): Promise<MetricSeries[]> {
    const ext = externalIdOf(resourceId);
    let url: string;
    let picks;
    if (resourceTypeId === T.database) {
      url = `${METRICS_API}/v1/databases/${encodeURIComponent(ext)}/metrics`;
      picks = DATABASE_METRICS;
    } else if (resourceTypeId === T.pcuGroup) {
      url = `${METRICS_API}/v1/pcugroup/${encodeURIComponent(ext)}/metrics`;
      picks = PCU_METRICS;
    } else {
      return [];
    }
    try {
      const body = await fetchText(this.ctx, url, {
        Authorization: `Astra-Token ${this.ctx.token}`,
      });
      return samplesToSeries(parsePrometheusText(body), picks, Date.now());
    } catch (err) {
      const s = statusOf(err);
      // Scraping is a paid-plan feature and needs the Manage Metrics permission.
      if (s === 401 || s === 403 || s === 404) return [];
      throw err;
    }
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = r.fields;
    const s = String(f["status"] ?? "");
    const variant: DashboardStat["variant"] =
      s === ACTIVE
        ? "status-healthy"
        : /ERROR|UNKNOWN/.test(s)
          ? "status-error"
          : s
            ? "status-degraded"
            : "default";
    if (resourceTypeId === T.database) {
      return [
        { label: "Status", value: s, variant },
        { label: "Type", value: String(f["dbType"] ?? "") },
        { label: "Regions", value: String(f["regions"] ?? "") },
        {
          label: "Storage",
          value: f["usedStorageGb"] !== undefined ? `${f["usedStorageGb"]} GB` : "",
        },
      ];
    }
    if (resourceTypeId === T.pcuGroup) {
      return [
        { label: "Status", value: s, variant },
        { label: "Reserved", value: String(f["reserved"] ?? "") },
        { label: "Range", value: `${f["min"] ?? "?"}-${f["max"] ?? "?"}` },
      ];
    }
    return [{ label: "Status", value: s || "Active", variant }];
  }
}
