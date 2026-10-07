import type {
  ChatMessage,
  ChatStreamEvent,
  CreateFieldConfig,
  CreateResourceConfig,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  QuotaUsage,
  ResourceCreateReturn,
  ResourceInstance,
  ResourceTypeDefinition,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { QuotaAccessError, withMetricsCapability } from "@infrawrench/plugin-base";
import { collectPages, errorText, isStatus, PineconeApi } from "./api.js";
import {
  externalOf,
  mapApiKey,
  mapAssistant,
  mapBackup,
  mapBackupSchedule,
  mapCollection,
  mapIndex,
  mapProject,
  mapRestoreJob,
  mapServiceAccount,
  parseTags,
  tagPatch,
} from "./mappers.js";
import { fetchIndexStats, prometheusSeries, scrapeProject, statsSeries } from "./metrics.js";
import {
  ENRICH_BACKUPS,
  ENRICH_FILES,
  ENRICH_HISTORY,
  ENRICH_NAMESPACES,
  ENRICH_SCHEDULES,
  formatSize,
  renderPineconeDetail,
  renderPineconeSidebarItem,
  type NamespaceRow,
} from "./render.js";
import {
  API_KEY_ROLE_LABELS,
  API_KEY_ROLES,
  POD_TYPES,
  SERVERLESS_REGIONS,
} from "./resource-types.js";
import type {
  PcApiKey,
  PcAssistant,
  PcAssistantFile,
  PcBackup,
  PcBackupSchedule,
  PcCollection,
  PcIndex,
  PcModel,
  PcPagination,
  PcProject,
  PcRestoreJob,
  PcServiceAccount,
} from "./types.js";

const INDEX_TTL_MS = 30_000;
const CATALOG_TTL_MS = 10 * 60_000;
const FAN_OUT = 6;
const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,43}[a-z0-9])?$/;
const ASSISTANT_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Secret-store keys for values Pinecone shows exactly once. */
export const API_KEY_VALUE_FIELD = "apiKeyValue";
export const CLIENT_SECRET_FIELD = "clientSecret";

const enc = encodeURIComponent;

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v).trim();
}

function intField(raw: string | undefined, label: string, min: number): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${label} must be a whole number of at least ${min}.`);
  }
  return n;
}

function checkName(name: string, what: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `${what} names are 1 to 45 lowercase letters, digits or hyphens, starting and ending with a letter or digit.`,
    );
  }
}

function parseFormArg(raw: string | number | undefined): Record<string, string> {
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) out[k] = String(v ?? "");
    return out;
  } catch {
    return {};
  }
}

/** Roles from a policy-picker JSON array or a comma-separated list, validated. */
export function parseRoles(raw: string): string[] {
  let list: string[];
  const t = raw.trim();
  if (t.startsWith("[")) {
    try {
      list = (JSON.parse(t) as unknown[]).map((r) => String(r).trim());
    } catch {
      throw new Error("Roles could not be read.");
    }
  } else {
    list = t.split(",").map((r) => r.trim());
  }
  const roles = [...new Set(list.filter(Boolean))];
  const bad = roles.filter((r) => !(API_KEY_ROLES as readonly string[]).includes(r));
  if (bad.length) {
    throw new Error(`Unknown role ${bad.join(", ")}. Use any of: ${API_KEY_ROLES.join(", ")}.`);
  }
  return roles;
}

/** Parse the assistant metadata field: a JSON object or blank. */
export function parseMetadata(raw: string): Record<string, unknown> | null {
  const t = raw.trim();
  if (!t) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    throw new Error('Metadata must be a JSON object, e.g. {"team": "support"}.');
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error('Metadata must be a JSON object, e.g. {"team": "support"}.');
  }
  return parsed as Record<string, unknown>;
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
 * Pinecone plugin client. One account is one project, reached with that
 * project's API key; an optional service account adds the organization-level
 * Admin API (projects, API keys, service accounts).
 */
export class PineconeClient implements PluginClient {
  readonly api: PineconeApi;
  private readonly projectId: string;
  private indexCache: Cached<PcIndex[]> | undefined;
  private modelCache: Cached<PcModel[]> | undefined;
  private projectCache: Cached<PcProject[]> | undefined;

  constructor(
    credentials: Record<string, string>,
    private readonly resourceTypes: ResourceTypeDefinition[],
    private readonly services?: HostServices,
  ) {
    const apiKey = str(credentials["apiKey"]);
    if (!apiKey) throw new Error("Pinecone plugin: missing apiKey credential");
    this.api = new PineconeApi(
      {
        apiKey,
        clientId: str(credentials["clientId"]),
        clientSecret: str(credentials["clientSecret"]),
        caCert: credentials["caCert"] ?? "",
      },
      services,
    );
    this.projectId = str(credentials["projectId"]);
  }

  // ── Discovery ────────────────────────────────────────────────────────

  indexes(): Promise<PcIndex[]> {
    this.indexCache = cached(this.indexCache, INDEX_TTL_MS, () =>
      this.api.control<{ indexes?: PcIndex[] }>("/indexes").then((r) => r?.indexes ?? []),
    );
    return this.indexCache.value;
  }

  private invalidateIndexes(): void {
    this.indexCache = undefined;
  }

  models(): Promise<PcModel[]> {
    this.modelCache = cached(this.modelCache, CATALOG_TTL_MS, () =>
      this.api
        .control<{ models?: PcModel[] }>("/models", { query: { type: "embed" } })
        .then((r) => r?.models ?? []),
    );
    return this.modelCache.value;
  }

  projects(): Promise<PcProject[]> {
    this.projectCache = cached(this.projectCache, CATALOG_TTL_MS, () =>
      this.api.admin<{ data?: PcProject[] }>("/projects").then((r) => r?.data ?? []),
    );
    return this.projectCache.value;
  }

  private async describeIndex(name: string): Promise<PcIndex> {
    return this.api.control<PcIndex>(`/indexes/${enc(name)}`);
  }

  private async listBackups(): Promise<PcBackup[]> {
    return collectPages<PcBackup>((token) =>
      this.api.control("/backups", { query: { limit: 100, paginationToken: token } }),
    );
  }

  private async listSchedules(indexName: string): Promise<PcBackupSchedule[]> {
    return collectPages<PcBackupSchedule>((token) =>
      this.api.control(`/indexes/${enc(indexName)}/backup-schedules`, {
        query: { limit: 100, paginationToken: token },
      }),
    );
  }

  private async listAssistants(): Promise<PcAssistant[]> {
    const out: PcAssistant[] = [];
    let token: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await this.api.control<
        { assistants?: PcAssistant[]; pagination?: PcPagination | null } | undefined
      >("/assistant/assistants", { query: { limit: 100, pagination_token: token } });
      out.push(...(res?.assistants ?? []));
      const next = res?.pagination?.next;
      if (!next || next === token) break;
      token = next;
    }
    return out;
  }

  private async listServiceAccounts(): Promise<PcServiceAccount[]> {
    return collectPages<PcServiceAccount>((token) =>
      this.api.admin("/service-accounts", { query: { limit: 100, paginationToken: token } }),
    );
  }

  private async projectApiKeys(project: PcProject): Promise<PcApiKey[]> {
    const res = await this.api.admin<{ data?: PcApiKey[] }>(
      `/projects/${enc(project.id)}/api-keys`,
    );
    return res?.data ?? [];
  }

  // ── Listing ──────────────────────────────────────────────────────────

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "index":
        return (await this.indexes()).map((i) => mapIndex(i, accountId));
      case "collection": {
        const res = await this.api.control<{ collections?: PcCollection[] }>("/collections");
        return (res?.collections ?? []).map((c) => mapCollection(c, accountId));
      }
      case "backup":
        return (await this.listBackups()).map((b) => mapBackup(b, accountId));
      case "backup-schedule": {
        const indexes = (await this.indexes()).filter(
          (i) => i.deployment?.deployment_type !== "pod",
        );
        const lists = await mapLimit(indexes, FAN_OUT, async (i) => {
          try {
            return (await this.listSchedules(i.name)).map((s) =>
              mapBackupSchedule(s, i.name, accountId),
            );
          } catch (e) {
            if (isStatus(e, 400, 403, 404)) return [];
            throw e;
          }
        });
        return lists.flat();
      }
      case "restore-job": {
        const jobs = await collectPages<PcRestoreJob>((token) =>
          this.api.control("/restore-jobs", { query: { limit: 100, paginationToken: token } }),
        );
        return jobs.map((j) => mapRestoreJob(j, accountId));
      }
      case "assistant":
        return (await this.listAssistants()).map((a) => mapAssistant(a, accountId));
      case "project":
        if (!this.api.hasAdmin) return [];
        return (await this.projects()).map((p) => mapProject(p, accountId));
      case "api-key": {
        if (!this.api.hasAdmin) return [];
        const projects = await this.projects();
        const lists = await mapLimit(projects, FAN_OUT, async (p) =>
          (await this.projectApiKeys(p)).map((k) => mapApiKey(k, p.name, accountId)),
        );
        return lists.flat();
      }
      case "service-account":
        if (!this.api.hasAdmin) return [];
        return (await this.listServiceAccounts()).map((s) => mapServiceAccount(s, accountId));
      default:
        throw new Error(`Pinecone plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalOf(resourceId);
    switch (typeId) {
      case "index":
        return mapIndex(await this.describeIndex(id), accountId);
      case "collection":
        return mapCollection(
          await this.api.control<PcCollection>(`/collections/${enc(id)}`),
          accountId,
        );
      case "backup":
        return mapBackup(await this.api.control<PcBackup>(`/backups/${enc(id)}`), accountId);
      case "backup-schedule": {
        const [s, indexes] = await Promise.all([
          this.api.control<PcBackupSchedule>(`/backup-schedules/${enc(id)}`),
          this.indexes().catch(() => [] as PcIndex[]),
        ]);
        const indexName = await this.indexNameForId(s.index_id ?? "", indexes);
        return mapBackupSchedule(s, indexName, accountId);
      }
      case "restore-job":
        return mapRestoreJob(
          await this.api.control<PcRestoreJob>(`/restore-jobs/${enc(id)}`),
          accountId,
        );
      case "assistant":
        return mapAssistant(
          await this.api.control<PcAssistant>(`/assistant/assistants/${enc(id)}`),
          accountId,
        );
      case "project":
        return mapProject(await this.api.admin<PcProject>(`/projects/${enc(id)}`), accountId);
      case "api-key": {
        const key = await this.api.admin<PcApiKey>(`/api-keys/${enc(id)}`);
        const projects = await this.projects().catch(() => [] as PcProject[]);
        const project = projects.find((p) => p.id === key.project_id);
        return mapApiKey(key, project?.name ?? "", accountId);
      }
      case "service-account":
        return mapServiceAccount(
          await this.api.admin<PcServiceAccount>(`/service-accounts/${enc(id)}`),
          accountId,
        );
      default:
        throw new Error(`Pinecone plugin: unknown resource type "${typeId}"`);
    }
  }

  /**
   * Backup schedules report the index's id, not its name. The index list
   * carries no id either, so match by describing the schedules of each
   * index until one of them owns the schedule.
   */
  private async indexNameForId(indexId: string, indexes: PcIndex[]): Promise<string> {
    if (!indexId) return "";
    for (const i of indexes) {
      if (i.deployment?.deployment_type === "pod") continue;
      const schedules = await this.listSchedules(i.name).catch(() => []);
      if (schedules.some((s) => s.index_id === indexId)) return i.name;
    }
    return "";
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "index" && outputKey === "apiKey") return this.api.apiKey;
    if (typeId === "api-key" && outputKey === "apiKey") {
      const v = await this.services?.secrets?.getPlaintext(resourceId, API_KEY_VALUE_FIELD);
      if (!v) {
        throw new Error(
          "Pinecone only shows an API key's value when it is created. Create a new key from Infrawrench to keep its value here.",
        );
      }
      return v;
    }
    if (typeId === "service-account" && outputKey === "clientSecret") {
      const v = await this.services?.secrets?.getPlaintext(resourceId, CLIENT_SECRET_FIELD);
      if (!v) {
        throw new Error(
          "Pinecone only shows a client secret when it is created or rotated. Rotate it from Infrawrench to keep the new secret here.",
        );
      }
      return v;
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    return resource.resolvedOutputs[outputKey] ?? "";
  }

  // ── Detail ───────────────────────────────────────────────────────────

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const fields = { ...resource.fields };
    const id = resource.externalId ?? externalOf(resource.id);
    if (resource.resourceTypeId === "index") {
      const host = String(fields["host"] ?? "");
      const isPod = fields["deploymentType"] === "pod";
      const [stats, schedules, backups] = await Promise.all([
        host && fields["status"] === "Ready"
          ? fetchIndexStats(this.api, host).catch(() => null)
          : Promise.resolve(null),
        isPod ? Promise.resolve([]) : this.listSchedules(id).catch(() => []),
        isPod ? Promise.resolve([]) : this.listBackups().catch(() => []),
      ]);
      if (stats) {
        const rows: NamespaceRow[] = Object.entries(stats.namespaces ?? {})
          .map(([name, ns]) => ({ name, records: ns.vectorCount ?? 0 }))
          .sort((a, b) => b.records - a.records)
          .slice(0, 200);
        fields["recordCount"] = stats.totalVectorCount ?? 0;
        fields["namespaceCount"] = Object.keys(stats.namespaces ?? {}).length;
        if (rows.length) fields[ENRICH_NAMESPACES] = JSON.stringify(rows);
      }
      if (schedules.length) {
        fields[ENRICH_SCHEDULES] = JSON.stringify(
          schedules.map((s) => ({
            name: s.name ?? s.schedule_id,
            frequency: s.frequency ?? "",
            retention: String(s.retention_expire_after_days ?? ""),
            next: s.enabled === false ? "Disabled" : (s.next_scheduled_run ?? ""),
          })),
        );
      }
      const own = backups.filter((b) => b.source_index_name === id).slice(0, 50);
      if (own.length) {
        fields[ENRICH_BACKUPS] = JSON.stringify(
          own.map((b) => ({
            name: b.name || b.backup_id,
            status: b.status ?? "",
            records: b.record_count === undefined ? "" : String(b.record_count),
            created: b.created_at ?? "",
          })),
        );
      }
    } else if (resource.resourceTypeId === "backup-schedule") {
      const history = await collectPages<PcBackup & { scheduled_execution_at?: string }>(
        (token) =>
          this.api.control(`/backup-schedules/${enc(id)}/history`, {
            query: { limit: 100, paginationToken: token },
          }),
        3,
      ).catch(() => []);
      if (history.length) {
        fields[ENRICH_HISTORY] = JSON.stringify(
          history.slice(0, 50).map((b) => ({
            name: b.name || b.backup_id,
            status: b.status ?? "",
            size: formatSize(b.size_bytes),
            created:
              b.status === "Scheduled" ? (b.scheduled_execution_at ?? "") : (b.created_at ?? ""),
          })),
        );
      }
    } else if (resource.resourceTypeId === "assistant") {
      const host = String(fields["host"] ?? "");
      if (host) {
        const files = await this.api
          .dataPlane<{ files?: PcAssistantFile[] }>(host, `/files/${enc(id)}`)
          .then((r) => r?.files ?? [])
          .catch(() => null);
        if (files) {
          fields["fileCount"] = files.length;
          fields[ENRICH_FILES] = JSON.stringify(
            files.slice(0, 200).map((f) => ({
              name: f.name ?? f.id ?? "",
              status: f.status ?? "",
              size: formatSize(f.size),
              created: f.created_on ?? "",
            })),
          );
        }
      }
    }
    return { ...resource, fields };
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return withMetricsCapability(
      renderPineconeDetail(resource, this.resourceTypes),
      this.resourceTypes,
      resource.resourceTypeId,
    );
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderPineconeSidebarItem(resource);
  }

  // ── Create ───────────────────────────────────────────────────────────

  private async indexOptions(filter: (i: PcIndex) => boolean) {
    const indexes = await this.indexes().catch(() => [] as PcIndex[]);
    return indexes.filter(filter).map((i) => ({
      id: i.name,
      label: i.name,
      description:
        i.deployment?.deployment_type === "pod"
          ? `pod, ${i.deployment.environment ?? ""}`
          : `${i.deployment?.cloud ?? ""} ${i.deployment?.region ?? ""}`.trim(),
    }));
  }

  private async projectOptions() {
    const projects = await this.projects().catch(() => [] as PcProject[]);
    return projects.map((p) => ({ id: p.id, label: p.name, description: p.id }));
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    const fromParent = (type: string) => parentResourceId?.includes(`:${type}:`) === true;
    switch (typeId) {
      case "index": {
        const models = await this.models().catch(() => [] as PcModel[]);
        const fields: CreateFieldConfig[] = [
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            placeholder: "products",
            description: "Lowercase letters, digits and hyphens, up to 45 characters",
          },
          {
            key: "kind",
            label: "Index kind",
            kind: "select",
            required: true,
            defaultValue: models.length ? "integrated" : "dense",
            options: [
              ...(models.length
                ? [
                    {
                      id: "integrated",
                      label: "Integrated embedding",
                      description: "Pinecone embeds your text with a hosted model",
                    },
                  ]
                : []),
              { id: "dense", label: "Dense vectors", description: "You bring the embeddings" },
              {
                id: "sparse",
                label: "Sparse vectors",
                description: "Keyword-style sparse vectors, dotproduct similarity",
              },
            ],
          },
          {
            key: "model",
            label: "Embedding model",
            kind: "select",
            required: true,
            showWhen: { fieldKey: "kind", fieldValue: "integrated" },
            ...(models[0] ? { defaultValue: models[0].model } : {}),
            options: models.map((m) => ({
              id: m.model,
              label: m.model,
              description: [
                m.vector_type,
                m.default_dimension ? `${m.default_dimension} dims` : "",
                m.short_description ?? "",
              ]
                .filter(Boolean)
                .join(" · ")
                .slice(0, 160),
            })),
          },
          {
            key: "textField",
            label: "Text field to embed",
            kind: "text",
            required: true,
            defaultValue: "text",
            showWhen: { fieldKey: "kind", fieldValue: "integrated" },
            description: "The record field Pinecone embeds at upsert and query time",
          },
          {
            key: "dimension",
            label: "Dimension",
            kind: "number",
            required: true,
            minValue: 1,
            maxValue: 20000,
            defaultValue: "1536",
            showWhen: { fieldKey: "kind", fieldValue: "dense" },
            description: "Must match the embedding model you write vectors from",
          },
          {
            key: "metric",
            label: "Metric",
            kind: "select",
            required: true,
            defaultValue: "cosine",
            showWhen: { fieldKey: "kind", fieldValue: "dense" },
            options: [
              { id: "cosine", label: "Cosine" },
              { id: "dotproduct", label: "Dot product" },
              { id: "euclidean", label: "Euclidean" },
            ],
          },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            defaultValue: "aws/us-east-1",
            regions: SERVERLESS_REGIONS.map((r) => ({
              id: `${r.cloud}/${r.region}`,
              label: r.label,
            })),
            description: "Starter-plan projects can only use AWS us-east-1",
          },
          {
            key: "readCapacityMode",
            label: "Read capacity",
            kind: "select",
            required: false,
            defaultValue: "OnDemand",
            options: [
              { id: "OnDemand", label: "On-demand", description: "Billed per read unit" },
              {
                id: "Dedicated",
                label: "Dedicated read nodes",
                description: "Fixed hourly price, predictable latency",
              },
            ],
          },
          {
            key: "nodeType",
            label: "Read node type",
            kind: "select",
            required: false,
            defaultValue: "b1",
            showWhen: { fieldKey: "readCapacityMode", fieldValue: "Dedicated" },
            options: [
              { id: "b1", label: "b1" },
              { id: "t1", label: "t1 (more CPU and memory)" },
            ],
          },
          {
            key: "replicas",
            label: "Read replicas",
            kind: "number",
            required: false,
            minValue: 1,
            defaultValue: "1",
            showWhen: { fieldKey: "readCapacityMode", fieldValue: "Dedicated" },
          },
          {
            key: "shards",
            label: "Read shards",
            kind: "number",
            required: false,
            minValue: 1,
            defaultValue: "1",
            showWhen: { fieldKey: "readCapacityMode", fieldValue: "Dedicated" },
            description: "250 GB of storage each",
          },
          {
            key: "deletionProtection",
            label: "Deletion protection",
            kind: "select",
            required: false,
            defaultValue: "disabled",
            options: [
              { id: "disabled", label: "Disabled" },
              { id: "enabled", label: "Enabled" },
            ],
          },
          {
            key: "tags",
            label: "Tags",
            kind: "text",
            required: false,
            placeholder: "env=prod, team=search",
          },
        ];
        return { fields };
      }
      case "collection":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "source",
              label: "Source index",
              kind: "select",
              required: true,
              description: "Only pod-based indexes can be saved as collections",
              options: await this.indexOptions((i) => i.deployment?.deployment_type === "pod"),
            },
          ],
        };
      case "backup":
        return {
          fields: [
            {
              key: "indexName",
              label: "Index",
              kind: "select",
              required: true,
              options: await this.indexOptions((i) => i.deployment?.deployment_type !== "pod"),
            },
            { key: "name", label: "Name", kind: "text", required: false },
            { key: "description", label: "Description", kind: "text", required: false },
          ],
        };
      case "backup-schedule":
        return {
          fields: [
            ...(fromParent("index")
              ? []
              : [
                  {
                    key: "indexName",
                    label: "Index",
                    kind: "select" as const,
                    required: true,
                    options: await this.indexOptions(
                      (i) => i.deployment?.deployment_type !== "pod",
                    ),
                  },
                ]),
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "nightly" },
            {
              key: "frequency",
              label: "Frequency",
              kind: "select",
              required: true,
              defaultValue: "daily",
              options: [
                { id: "daily", label: "Daily" },
                { id: "weekly", label: "Weekly" },
                { id: "monthly", label: "Monthly" },
              ],
            },
            {
              key: "retentionDays",
              label: "Keep each backup for (days)",
              kind: "number",
              required: true,
              minValue: 1,
              defaultValue: "7",
            },
          ],
        };
      case "assistant":
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              description: "Lowercase letters, digits and hyphens, up to 63 characters",
            },
            {
              key: "region",
              label: "Region",
              kind: "select",
              required: true,
              defaultValue: "us",
              options: [
                { id: "us", label: "United States" },
                { id: "eu", label: "Europe" },
              ],
            },
            {
              key: "instructions",
              label: "Instructions",
              kind: "text",
              multiline: true,
              required: false,
              placeholder: "Answer in a friendly tone and cite the document you used.",
            },
          ],
        };
      case "project":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "maxPods",
              label: "Max pods",
              kind: "number",
              required: false,
              minValue: 0,
              defaultValue: "0",
              description: "0 keeps the project serverless only",
            },
            {
              key: "forceEncryptionWithCmek",
              label: "Require CMEK encryption",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "No" },
                { id: "true", label: "Yes (cannot be turned off later)" },
              ],
            },
          ],
        };
      case "api-key":
        return {
          fields: [
            ...(fromParent("project")
              ? []
              : [
                  {
                    key: "projectId",
                    label: "Project",
                    kind: "select" as const,
                    required: true,
                    options: await this.projectOptions(),
                  },
                ]),
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "roles",
              label: "Roles",
              kind: "policy-picker",
              required: false,
              description: "Leave empty for ProjectEditor, Pinecone's default",
              policies: API_KEY_ROLES.map((r) => ({
                id: r,
                label: r,
                description: API_KEY_ROLE_LABELS[r] ?? "",
              })),
            },
          ],
        };
      case "service-account":
        return {
          fields: [{ key: "name", label: "Name", kind: "text", required: true }],
        };
      default:
        throw new Error(`Pinecone plugin: cannot create "${typeId}"`);
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceCreateReturn> {
    switch (typeId) {
      case "index":
        return this.createIndex(accountId, fields);
      case "collection": {
        const name = str(fields["name"]);
        checkName(name, "Collection");
        const source = str(fields["source"]);
        if (!source) throw new Error("Choose the pod-based index to copy.");
        const c = await this.api.control<PcCollection>("/collections", {
          method: "POST",
          body: { name, source },
        });
        const inst = mapCollection(c ?? { name, status: "Initializing" }, accountId);
        inst.fields["sourceIndex"] = source;
        return inst;
      }
      case "backup": {
        const indexName = str(fields["indexName"]);
        if (!indexName) throw new Error("Choose the index to back up.");
        return mapBackup(await this.createBackup(indexName, fields), accountId);
      }
      case "backup-schedule": {
        const indexName = parentResourceId?.includes(":index:")
          ? externalOf(parentResourceId)
          : str(fields["indexName"]);
        if (!indexName) throw new Error("Choose the index to back up.");
        const name = str(fields["name"]);
        if (!name) throw new Error("Enter a name for the schedule.");
        const frequency = str(fields["frequency"]) || "daily";
        const days = intField(fields["retentionDays"], "Retention", 1) ?? 7;
        const s = await this.api.control<PcBackupSchedule>(
          `/indexes/${enc(indexName)}/backup-schedules`,
          {
            method: "POST",
            body: {
              name,
              schedule: { type: "time-based", frequency },
              retention: { expire_after_days: days },
            },
          },
        );
        return mapBackupSchedule(s, indexName, accountId);
      }
      case "assistant": {
        const name = str(fields["name"]);
        if (!ASSISTANT_NAME_RE.test(name)) {
          throw new Error(
            "Assistant names are 1 to 63 lowercase letters, digits or hyphens, starting and ending with a letter or digit.",
          );
        }
        const instructions = fields["instructions"] ?? "";
        const a = await this.api.control<PcAssistant>("/assistant/assistants", {
          method: "POST",
          body: {
            name,
            region: str(fields["region"]) || "us",
            ...(instructions.trim() ? { instructions } : {}),
          },
        });
        return mapAssistant(a ?? { name, status: "Initializing" }, accountId);
      }
      case "project": {
        const name = str(fields["name"]);
        if (!name) throw new Error("Enter a project name.");
        const maxPods = intField(fields["maxPods"], "Max pods", 0);
        const p = await this.api.admin<PcProject>("/projects", {
          method: "POST",
          body: {
            name,
            ...(maxPods !== undefined ? { max_pods: maxPods } : {}),
            ...(fields["forceEncryptionWithCmek"] === "true"
              ? { force_encryption_with_cmek: true }
              : {}),
          },
        });
        this.projectCache = undefined;
        return mapProject(p, accountId);
      }
      case "api-key": {
        const projectId = parentResourceId?.includes(":project:")
          ? externalOf(parentResourceId)
          : str(fields["projectId"]);
        if (!projectId) throw new Error("Choose a project.");
        const name = str(fields["name"]);
        if (!name || name.length > 80) throw new Error("API key names are 1 to 80 characters.");
        const roles = parseRoles(fields["roles"] ?? "");
        const res = await this.api.admin<{ key: PcApiKey; value: string }>(
          `/projects/${enc(projectId)}/api-keys`,
          { method: "POST", body: { name, ...(roles.length ? { roles } : {}) } },
        );
        const projects = await this.projects().catch(() => [] as PcProject[]);
        const inst = mapApiKey(
          res.key,
          projects.find((p) => p.id === projectId)?.name ?? "",
          accountId,
        );
        await this.services?.secrets?.setPlaintext?.(inst.id, API_KEY_VALUE_FIELD, res.value);
        return inst;
      }
      case "service-account": {
        const name = str(fields["name"]);
        if (!name || name.length > 80) {
          throw new Error("Service account names are 1 to 80 characters.");
        }
        const res = await this.api.admin<{
          service_account: PcServiceAccount;
          client_secret: string;
        }>("/service-accounts", { method: "POST", body: { name } });
        const inst = mapServiceAccount(res.service_account, accountId);
        await this.services?.secrets?.setPlaintext?.(
          inst.id,
          CLIENT_SECRET_FIELD,
          res.client_secret,
        );
        return inst;
      }
      default:
        throw new Error(`Pinecone plugin: cannot create "${typeId}"`);
    }
  }

  private readCapacityBody(fields: Record<string, string>): Record<string, unknown> | undefined {
    const mode = str(fields["readCapacityMode"]);
    if (mode !== "Dedicated") return mode === "OnDemand" ? { mode: "OnDemand" } : undefined;
    return {
      mode: "Dedicated",
      dedicated: {
        node_type: str(fields["nodeType"]) || "b1",
        scaling: "Manual",
        manual: {
          replicas: intField(fields["replicas"], "Replicas", 0) ?? 1,
          shards: intField(fields["shards"], "Shards", 1) ?? 1,
        },
      },
    };
  }

  private async createIndex(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const name = str(fields["name"]);
    checkName(name, "Index");
    const [cloud, region] = (str(fields["region"]) || "aws/us-east-1").split("/");
    if (!cloud || !region) throw new Error("Choose a region.");
    const kind = str(fields["kind"]) || "dense";
    const tags = parseTags(fields["tags"] ?? "");
    const protection = str(fields["deletionProtection"]) || "disabled";
    const readCapacity = this.readCapacityBody(fields);
    const common = {
      ...(Object.keys(tags).length ? { tags } : {}),
      deletion_protection: protection,
      ...(readCapacity ? { read_capacity: readCapacity } : {}),
    };
    let created: PcIndex;
    if (kind === "integrated") {
      const model = str(fields["model"]);
      if (!model) throw new Error("Choose an embedding model.");
      const textField = str(fields["textField"]) || "text";
      created = await this.api.control<PcIndex>("/indexes/create-for-model", {
        method: "POST",
        body: { name, cloud, region, embed: { model, field_map: { text: textField } }, ...common },
      });
    } else {
      const schemaFields =
        kind === "sparse"
          ? { _sparse_values: { type: "sparse_vector" } }
          : {
              _values: {
                type: "dense_vector",
                dimension: intField(fields["dimension"], "Dimension", 1) ?? 1536,
                metric: str(fields["metric"]) || "cosine",
              },
            };
      created = await this.api.control<PcIndex>("/indexes", {
        method: "POST",
        body: {
          name,
          deployment: { deployment_type: "managed", cloud, region },
          schema: { fields: schemaFields },
          ...common,
        },
      });
    }
    this.invalidateIndexes();
    return mapIndex(created ?? { name, status: { state: "Initializing" } }, accountId);
  }

  private async createBackup(indexName: string, fields: Record<string, string>): Promise<PcBackup> {
    const name = str(fields["name"]);
    if (name) checkName(name, "Backup");
    const description = str(fields["description"]);
    return this.api.control<PcBackup>(`/indexes/${enc(indexName)}/backups`, {
      method: "POST",
      body: { ...(name ? { name } : {}), ...(description ? { description } : {}) },
    });
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
      case "index": {
        const current = await this.describeIndex(id);
        const body = buildConfigurePatch(current, fields);
        if (Object.keys(body).length) {
          await this.api.control(`/indexes/${enc(id)}`, { method: "PATCH", body });
          this.invalidateIndexes();
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "backup-schedule": {
        const body: Record<string, unknown> = {};
        if (fields["frequency"]) body["frequency"] = str(fields["frequency"]);
        const days = intField(fields["retentionDays"], "Retention", 1);
        if (days !== undefined) body["retention"] = { expire_after_days: days };
        if (fields["enabled"] !== undefined && fields["enabled"] !== "") {
          body["enabled"] = fields["enabled"] === "true";
        }
        if (Object.keys(body).length) {
          await this.api.control(`/backup-schedules/${enc(id)}`, { method: "PATCH", body });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "assistant": {
        const body: Record<string, unknown> = {};
        if (fields["instructions"] !== undefined) body["instructions"] = fields["instructions"];
        if (fields["metadata"] !== undefined) body["metadata"] = parseMetadata(fields["metadata"]);
        if (Object.keys(body).length) {
          await this.api.control(`/assistant/assistants/${enc(id)}`, { method: "PATCH", body });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "project": {
        const body: Record<string, unknown> = {};
        if (fields["name"]) body["name"] = str(fields["name"]);
        const maxPods = intField(fields["maxPods"], "Max pods", 0);
        if (maxPods !== undefined) body["max_pods"] = maxPods;
        if (fields["forceEncryptionWithCmek"] === "true") {
          body["force_encryption_with_cmek"] = true;
        } else if (fields["forceEncryptionWithCmek"] === "false") {
          const current = await this.api.admin<PcProject>(`/projects/${enc(id)}`);
          if (current.force_encryption_with_cmek) {
            throw new Error("Pinecone does not allow turning CMEK enforcement off once it is on.");
          }
        }
        if (Object.keys(body).length) {
          await this.api.admin(`/projects/${enc(id)}`, { method: "PATCH", body });
          this.projectCache = undefined;
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "api-key": {
        const body: Record<string, unknown> = {};
        if (fields["name"]) body["name"] = str(fields["name"]);
        if (fields["roles"] !== undefined) {
          const roles = parseRoles(fields["roles"]);
          if (!roles.length) throw new Error("An API key needs at least one role.");
          body["roles"] = roles;
        }
        if (Object.keys(body).length) {
          await this.api.admin(`/api-keys/${enc(id)}`, { method: "PATCH", body });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "service-account": {
        const name = str(fields["name"]);
        if (name) {
          await this.api.admin(`/service-accounts/${enc(id)}`, {
            method: "PATCH",
            body: { name },
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      default:
        throw new Error(`Pinecone plugin: cannot update "${typeId}"`);
    }
  }

  // ── Delete ───────────────────────────────────────────────────────────

  async deleteResource(typeId: string, resourceId: string): Promise<void> {
    const id = externalOf(resourceId);
    const paths: Record<string, () => Promise<unknown>> = {
      index: () => this.api.control(`/indexes/${enc(id)}`, { method: "DELETE" }),
      collection: () => this.api.control(`/collections/${enc(id)}`, { method: "DELETE" }),
      backup: () => this.api.control(`/backups/${enc(id)}`, { method: "DELETE" }),
      "backup-schedule": () =>
        this.api.control(`/backup-schedules/${enc(id)}`, { method: "DELETE" }),
      assistant: () => this.api.control(`/assistant/assistants/${enc(id)}`, { method: "DELETE" }),
      project: () => this.api.admin(`/projects/${enc(id)}`, { method: "DELETE" }),
      "api-key": () => this.api.admin(`/api-keys/${enc(id)}`, { method: "DELETE" }),
      "service-account": () => this.api.admin(`/service-accounts/${enc(id)}`, { method: "DELETE" }),
    };
    const run = paths[typeId];
    if (!run) throw new Error(`Pinecone plugin: cannot delete "${typeId}"`);
    try {
      await run();
    } catch (e) {
      if (typeId === "index" && isStatus(e, 403, 412)) {
        throw new Error(
          `${errorText(e)}. If deletion protection is on, disable it on the index first.`,
        );
      }
      throw e;
    }
    if (typeId === "index") this.invalidateIndexes();
    if (typeId === "project") this.projectCache = undefined;
  }

  // ── Actions ──────────────────────────────────────────────────────────

  async invokeAction(typeId: string, resourceId: string, actionId: string): Promise<void> {
    const id = externalOf(resourceId);
    if (typeId === "index") {
      const patches: Record<string, Record<string, unknown>> = {
        "enable-deletion-protection": { deletion_protection: "enabled" },
        "disable-deletion-protection": { deletion_protection: "disabled" },
        "read-capacity-on-demand": { read_capacity: { mode: "OnDemand" } },
      };
      const body = patches[actionId];
      if (body) {
        await this.api.control(`/indexes/${enc(id)}`, { method: "PATCH", body });
        this.invalidateIndexes();
        return;
      }
    }
    if (typeId === "service-account" && actionId === "rotate-secret") {
      const res = await this.api.admin<{ client_secret: string }>(
        `/service-accounts/${enc(id)}/rotate-secret`,
        { method: "POST" },
      );
      await this.services?.secrets?.setPlaintext?.(
        resourceId,
        CLIENT_SECRET_FIELD,
        res.client_secret,
      );
      return;
    }
    throw new Error(`Pinecone plugin: action "${actionId}" is not supported for "${typeId}"`);
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const id = externalOf(resourceId);
    const vals = parseFormArg(args[0]);
    if (typeId === "index" && command === "createBackup") {
      await this.createBackup(id, vals);
      return null;
    }
    if (typeId === "index" && command === "createCollection") {
      const name = str(vals["name"]);
      checkName(name, "Collection");
      await this.api.control("/collections", { method: "POST", body: { name, source: id } });
      return null;
    }
    if (typeId === "backup" && command === "restoreBackup") {
      const name = str(vals["name"]);
      checkName(name, "Index");
      const res = await this.api.control<{ restore_job_id: string; index_id: string }>(
        `/backups/${enc(id)}/create-index`,
        {
          method: "POST",
          body: { name, deletion_protection: str(vals["deletionProtection"]) || "disabled" },
        },
      );
      this.invalidateIndexes();
      return res;
    }
    throw new Error(`Pinecone plugin: unknown command "${command}"`);
  }

  // ── Chat (assistants) ────────────────────────────────────────────────

  /**
   * One round-trip through the assistant's OpenAI-compatible endpoint
   * (`POST https://{assistant host}/chat/{name}/chat/completions`). Sent
   * non-streaming so it goes through the host HTTP service like every other
   * call; the full answer arrives as one delta.
   */
  async *streamChatMessage(
    typeId: string,
    resourceId: string,
    accountId: string,
    messages: ChatMessage[],
    options?: { model?: string },
  ): AsyncGenerator<ChatStreamEvent, void, unknown> {
    if (typeId !== "assistant") {
      yield { kind: "error", message: "Only assistants can chat." };
      return;
    }
    try {
      const assistant = await this.getResource(typeId, resourceId, accountId);
      const host = String(assistant.fields["host"] ?? "");
      const name = assistant.externalId ?? externalOf(resourceId);
      const res = await this.api.dataPlane<{
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      }>(host, `/chat/${enc(name)}/chat/completions`, {
        method: "POST",
        body: {
          messages: messages
            .filter((m) => m.role !== "system")
            .map((m) => ({ role: m.role, content: m.content })),
          stream: false,
          ...(options?.model ? { model: options.model } : {}),
        },
      });
      const text = res?.choices?.[0]?.message?.content ?? "";
      if (text) yield { kind: "delta", text };
      const usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};
      if (res?.usage?.prompt_tokens !== undefined) usage.inputTokens = res.usage.prompt_tokens;
      if (res?.usage?.completion_tokens !== undefined) {
        usage.outputTokens = res.usage.completion_tokens;
      }
      if (res?.usage?.total_tokens !== undefined) usage.totalTokens = res.usage.total_tokens;
      yield {
        kind: "done",
        message: { role: "assistant", content: text },
        ...(Object.keys(usage).length ? { usage } : {}),
      };
    } catch (e) {
      yield { kind: "error", message: errorText(e) };
    }
  }

  // ── Metrics and quotas ───────────────────────────────────────────────

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== "index") return [];
    const name = externalOf(resourceId);
    const index = await this.getResource("index", resourceId, accountId);
    const host = String(index.fields["host"] ?? "");
    const now = Date.now();
    const [stats, prom] = await Promise.all([
      host ? fetchIndexStats(this.api, host).catch(() => null) : Promise.resolve(null),
      this.projectId && index.fields["deploymentType"] !== "pod"
        ? scrapeProject(this.api, this.projectId).catch(() => [])
        : Promise.resolve([]),
    ]);
    return [...(stats ? statsSeries(stats, now) : []), ...prometheusSeries(prom, name, now)];
  }

  /**
   * Pods in use against the project's `max_pods`. Both halves come from
   * Pinecone: the limit from the Admin API project, the usage from the pod
   * indexes' `shards × replicas`. Needs the service account and project ID;
   * a serverless-only project (`max_pods` 0) has no pod quota to report.
   */
  async fetchQuotas(): Promise<QuotaUsage[]> {
    if (!this.api.hasAdmin || !this.projectId) {
      throw new QuotaAccessError(
        "Pod quotas need a service account and the project ID on this account.",
      );
    }
    let project: PcProject;
    try {
      project = await this.api.admin<PcProject>(`/projects/${enc(this.projectId)}`);
    } catch (e) {
      if (isStatus(e, 401, 403, 404)) {
        throw new QuotaAccessError(`Pinecone refused the project lookup: ${errorText(e)}`);
      }
      throw e;
    }
    if (!project.max_pods || project.max_pods <= 0) return [];
    const indexes = await this.indexes();
    const used = indexes
      .filter((i) => i.deployment?.deployment_type === "pod")
      .reduce((n, i) => n + (i.deployment?.replicas ?? 1) * (i.deployment?.shards ?? 1), 0);
    return [
      {
        id: `pods/${project.id}`,
        service: "Pod-based indexes",
        name: `Pods in project ${project.name}`,
        limit: project.max_pods,
        used,
        unit: "pods",
        adjustable: true,
      },
    ];
  }
}

/** ConfigureIndexRequest for the edited fields, skipping what is unchanged. */
export function buildConfigurePatch(
  current: PcIndex,
  fields: Record<string, string>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const isPod = current.deployment?.deployment_type === "pod";
  if (
    fields["deletionProtection"] &&
    fields["deletionProtection"] !== current.deletion_protection
  ) {
    body["deletion_protection"] = fields["deletionProtection"];
  }
  if (fields["tags"] !== undefined) {
    const patch = tagPatch(current.tags ?? {}, parseTags(fields["tags"]));
    if (Object.keys(patch).length) body["tags"] = patch;
  }
  if (isPod) {
    const deployment: Record<string, unknown> = {};
    const replicas = intField(fields["replicas"], "Replicas", 1);
    if (replicas !== undefined && replicas !== current.deployment?.replicas) {
      deployment["replicas"] = replicas;
    }
    const podType = str(fields["podType"]);
    if (podType && podType !== current.deployment?.pod_type) {
      if (!POD_TYPES.includes(podType)) {
        throw new Error(`Pod type must be one of ${POD_TYPES.join(", ")}.`);
      }
      deployment["pod_type"] = podType;
    }
    if (fields["shards"] !== undefined && fields["shards"] !== "") {
      if (Number(fields["shards"]) !== (current.deployment?.shards ?? 1)) {
        throw new Error("Shards of a pod-based index are fixed at creation.");
      }
    }
    if (Object.keys(deployment).length) body["deployment"] = deployment;
    return body;
  }
  const touched = ["readCapacityMode", "nodeType", "replicas", "shards"].some(
    (k) => fields[k] !== undefined && fields[k] !== "",
  );
  if (!touched) return body;
  const currentMode = current.read_capacity?.mode ?? "OnDemand";
  const mode = str(fields["readCapacityMode"]) || currentMode;
  if (mode === "OnDemand") {
    if (currentMode !== "OnDemand") body["read_capacity"] = { mode: "OnDemand" };
    return body;
  }
  const cur = current.read_capacity?.dedicated;
  const nodeType = str(fields["nodeType"]) || cur?.node_type || "b1";
  if (!["b1", "t1"].includes(nodeType)) throw new Error("Read node type must be b1 or t1.");
  const replicas = intField(fields["replicas"], "Replicas", 0) ?? cur?.manual?.replicas ?? 1;
  const shards = intField(fields["shards"], "Shards", 1) ?? cur?.manual?.shards ?? 1;
  body["read_capacity"] = {
    mode: "Dedicated",
    dedicated: { node_type: nodeType, scaling: "Manual", manual: { replicas, shards } },
  };
  return body;
}
