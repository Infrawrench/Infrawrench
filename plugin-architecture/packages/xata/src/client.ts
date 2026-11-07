import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
import type {
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  PreflightResult,
  QuotaUsage,
  ResourceCreateReturn,
  ResourceInstance,
  SettingDescriptor,
  SidebarItemSchema,
  SqlTableMeta,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type {
  BranchPath,
  OrgPath,
  ProjectPath,
  XApiKey,
  XataApi,
  XataContext,
  XBackup,
  XBranchPatch,
  XBranchRow,
  XBranchShort,
  XBranchSummary,
  XCredentials,
  XLogEntry,
  XMember,
  XMetricName,
  XOrg,
  XPgParameter,
  XProject,
  XProjectConfigPatch,
  XProjectPatch,
} from "./api.js";
import {
  createGatewayApi,
  createXataApi,
  enc,
  idPart,
  listOf,
  statusOf,
  withInvitationPages,
  withInvoicePages,
  XataApiError,
} from "./api.js";
import { getCreateConfig } from "./create-config.js";
import { fetchXataCostData } from "./cost-data.js";
import { verifyXataCredentials } from "./preflight.js";
import { renderDetail, renderSidebarItem } from "./render.js";

const METRICS: Array<[XMetricName, string]> = [
  ["cpu", "CPU"],
  ["memory", "Memory"],
  ["disk", "Disk"],
  ["connections_active", "Active connections"],
  ["connections_idle", "Idle connections"],
  ["network_ingress", "Network ingress"],
  ["network_egress", "Network egress"],
  ["iops_read", "Read IOPS"],
  ["iops_write", "Write IOPS"],
  ["latency_read", "Read latency"],
  ["latency_write", "Write latency"],
  ["throughput_read", "Read throughput"],
  ["throughput_write", "Write throughput"],
  ["replication_lag_time", "Replication lag"],
];

export const DEFAULT_METRICS_WINDOW_MS = 3 * 3_600_000;

/** `BranchLogsRequest.limit` has a maximum of 200 in Xata's document; the rest is paged. */
const LOG_PAGE_SIZE = 200;
const MAX_LOG_LINES = 1000;
/** A log view, so a run of short pages ends at what was read rather than failing. */
const MAX_LOG_PAGES = 10;

type Fields = ResourceInstance["fields"];

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, string | number | boolean | null | undefined>,
  parent?: { typeId: string; externalId: string },
  createdAt?: string,
): ResourceInstance {
  const clean: Fields = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) clean[k] = v;
  const now = new Date().toISOString();
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: "xata",
    resourceTypeId: typeId,
    accountId,
    displayName,
    fields: clean,
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    ...(parent ? { parentResourceId: `${accountId}:${parent.typeId}:${parent.externalId}` } : {}),
    createdAt: createdAt || now,
    updatedAt: now,
  };
}

function bool(v: string | undefined): boolean | undefined {
  if (v === undefined || v === "") return undefined;
  return v === "true";
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Xata plugin: "${v}" is not a number.`);
  return n;
}

function required(v: string | undefined, what: string): string {
  const s = (v ?? "").trim();
  if (!s) throw new Error(`Xata plugin: ${what} is required.`);
  return s;
}

export function listValue(v: string | undefined): string[] {
  if (!v) return [];
  const t = v.trim();
  if (t.startsWith("[")) {
    try {
      const parsed = JSON.parse(t) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      /* comma list below */
    }
  }
  return t
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Host of a postgres:// URL, without credentials. */
export function hostOf(connectionString: string | null | undefined): string {
  if (!connectionString) return "";
  const m = /@([^/:?]+)/.exec(connectionString);
  return m?.[1] ?? "";
}

/** Xata connection strings carry no sslmode; Infrawrench always requires TLS. */
export function withSsl(connectionString: string): string {
  if (/[?&]sslmode=/.test(connectionString)) return connectionString;
  return `${connectionString}${connectionString.includes("?") ? "&" : "?"}sslmode=require`;
}

function parts(externalId: string): string[] {
  return externalId.split("/");
}

export class XataClient implements PluginClient {
  readonly api: XataApi;
  private readonly invoicePages: ReturnType<typeof withInvoicePages>;
  private readonly invitationPages: ReturnType<typeof withInvitationPages>;
  private readonly ctx: XataContext;

  constructor(credentials: Credentials, services?: HostServices) {
    const token = (credentials["apiKey"] ?? "").trim();
    if (!token) throw new Error("Xata plugin: missing apiKey credential");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      token,
      ...(services?.http ? { http: services.http } : {}),
      ...(caCert ? { caCert } : {}),
    };
    this.api = createXataApi(this.ctx);
    this.invoicePages = withInvoicePages(this.api);
    this.invitationPages = withInvitationPages(this.api);
  }

  private orgPath(org: string | undefined): OrgPath {
    return `/organizations/${enc(org)}`;
  }

  private projectPath(org: string | undefined, project: string | undefined): ProjectPath {
    return `${this.orgPath(org)}/projects/${enc(project)}`;
  }

  private branchPath(
    org: string | undefined,
    project: string | undefined,
    branch: string | undefined,
  ): BranchPath {
    return `${this.projectPath(org, project)}/branches/${enc(branch)}`;
  }

  async orgs(): Promise<XOrg[]> {
    const path = "/organizations";
    return listOf(await this.api.get(path), path, "organizations");
  }

  async projects(org: string): Promise<XProject[]> {
    const path = `${this.orgPath(org)}/projects` as const;
    return listOf(await this.api.get(path), path, "projects");
  }

  async branchSummaries(
    org: string | undefined,
    project: string | undefined,
  ): Promise<XBranchSummary[]> {
    const path = `${this.projectPath(org, project)}/branches` as const;
    return listOf(await this.api.get(path), path, "branches");
  }

  private async members(org: string): Promise<XMember[]> {
    const path = `${this.orgPath(org)}/members` as const;
    return listOf(await this.api.get(path), path, "members");
  }

  private async allProjects(): Promise<Array<{ org: string; project: XProject }>> {
    const orgs = await this.orgs();
    const lists = await Promise.all(
      orgs.map(async (o) => (await this.projects(o.id)).map((project) => ({ org: o.id, project }))),
    );
    return lists.flat();
  }

  verifyCredentials(): PluginEffect<PreflightResult> {
    return attempt(async () => {
      return verifyXataCredentials(this);
    });
  }

  // ---- listing ---------------------------------------------------------------------

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      switch (typeId) {
        case "xata-organization": {
          const orgs = await this.orgs();
          return Promise.all(
            orgs.map(async (o) => {
              // Neither is a list of what this type stores, so a failure only leaves a field blank.
              const [detail, members] = await Promise.all([
                this.api.get(this.orgPath(o.id)).catch(() => undefined),
                this.api.get(`${this.orgPath(o.id)}/members`).catch(() => undefined),
              ]);
              return orgResource({ ...o, ...detail }, accountId, members?.members?.length);
            }),
          );
        }
        case "xata-project": {
          const all = await this.allProjects();
          return Promise.all(
            all.map(async ({ org, project }) =>
              projectResource(
                org,
                project,
                accountId,
                (await this.branchSummaries(org, project.id)).length,
              ),
            ),
          );
        }
        case "xata-branch": {
          const all = await this.allProjects();
          const lists = await Promise.all(
            all.map(({ org, project }) => this.branchesOf(org, project.id, accountId)),
          );
          return lists.flat();
        }
        case "xata-backup": {
          const all = await this.allProjects();
          const lists = await Promise.all(
            all.map(async ({ org, project }) => {
              const path = `${this.projectPath(org, project.id)}/backups` as const;
              const backups = listOf(await this.api.get(path), path, "backups");
              return backups.map((b) => backupResource(org, project.id, b, accountId));
            }),
          );
          return lists.flat();
        }
        case "xata-api-key": {
          const orgs = await this.orgs();
          const lists = await Promise.all(
            orgs.map(async (o) => {
              const path = `${this.orgPath(o.id)}/api-keys` as const;
              return listOf(await this.api.get(path), path, "keys").map((k) =>
                apiKeyResource(o.id, k, accountId),
              );
            }),
          );
          return lists.flat();
        }
        case "xata-member": {
          const orgs = await this.orgs();
          const lists = await Promise.all(
            orgs.map(async (o) =>
              (await this.members(o.id)).map((m) =>
                instance(
                  accountId,
                  typeId,
                  `${o.id}/${m.id}`,
                  m.name || m.email,
                  { email: m.email, name: m.name, organizationId: o.id, role: m.role },
                  { typeId: "xata-organization", externalId: o.id },
                ),
              ),
            ),
          );
          return lists.flat();
        }
        case "xata-invitation": {
          const orgs = await this.orgs();
          const lists = await Promise.all(
            orgs.map(async (o) =>
              (
                await this.invitationPages.getAll(
                  `${this.orgPath(o.id)}/invitations`,
                  "invitations",
                )
              ).map((i) =>
                instance(
                  accountId,
                  typeId,
                  `${o.id}/${i.id}`,
                  i.email,
                  {
                    email: i.email,
                    organizationId: o.id,
                    role: i.role,
                    status: i.status,
                    expiresAt: i.expires_at,
                    createdAt: i.created_at,
                  },
                  { typeId: "xata-organization", externalId: o.id },
                  i.created_at,
                ),
              ),
            ),
          );
          return lists.flat();
        }
        default:
          throw new Error(`Xata plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  /** Branch summaries plus each branch's detail (status, instance type, storage…). */
  private async branchesOf(
    org: string,
    project: string,
    accountId: string,
  ): Promise<ResourceInstance[]> {
    const summaries = await this.branchSummaries(org, project);
    return Promise.all(
      summaries.map(async (s) => {
        try {
          return await this.branchInstance(org, project, s.id, accountId);
        } catch (err) {
          // A branch deleted between the two calls: list what the summary had.
          if (statusOf(err) !== 404) throw err;
          return branchResource(org, project, s, accountId, "");
        }
      }),
    );
  }

  /**
   * The branch answer's `connectionString` is deprecated, and Xata's document says its
   * hostname carries a `-deprecated` marker, so the Host field is the credentials
   * endpoint's. A key without `credentials:read` can still list, with what it can see.
   */
  private async branchInstance(
    org: string,
    project: string | undefined,
    branch: string | undefined,
    accountId: string,
  ): Promise<ResourceInstance> {
    const [b, creds] = await Promise.all([
      this.api.get(this.branchPath(org, project, branch)),
      this.credentials(org, project, branch).catch(() => undefined),
    ]);
    return branchResource(
      org,
      project,
      b,
      accountId,
      creds?.hostname || hostOf(b.connectionString),
    );
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const p = parts(externalIdOf(resourceId));
      if (typeId === "xata-branch") {
        const [org = "", project, branch] = p;
        return this.branchInstance(org, project, branch, accountId);
      }
      if (typeId === "xata-project") {
        const [org = "", project] = p;
        const proj = await this.api.get(this.projectPath(org, project));
        return projectResource(
          org,
          proj,
          accountId,
          (await this.branchSummaries(org, project)).length,
        );
      }
      const found = (await runPluginEffect(this.listResources(typeId, accountId))).find(
        (r) => r.id === resourceId,
      );
      if (!found)
        throw new XataApiError(404, `Xata plugin: ${typeId}/${externalIdOf(resourceId)} not found`);
      return found;
    });
  }

  // ---- outputs -------------------------------------------------------------------

  private async credentials(
    org: string | undefined,
    project: string | undefined,
    branch: string | undefined,
  ): Promise<XCredentials> {
    return this.api.get(`${this.branchPath(org, project, branch)}/credentials`);
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    _accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      const p = parts(externalIdOf(resourceId));
      if (typeId === "xata-organization" && outputKey === "organizationId") return p[0]!;
      if (typeId === "xata-project" && outputKey === "projectId") return p[1]!;
      if (typeId === "xata-branch") {
        const creds = await this.credentials(p[0], p[1], p[2]);
        if (outputKey === "connectionString") return withSsl(creds.connectionString);
        if (outputKey === "host") return creds.hostname;
        if (outputKey === "username") return creds.username;
      }
      if (typeId === "xata-api-key" && outputKey === "token") {
        throw new Error(
          "Xata shows an API key's token only when it is created. Create a new key to get one.",
        );
      }
      throw new Error(`Xata plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
    });
  }

  rerollOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    _accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      if (typeId === "xata-branch" && outputKey === "connectionString") {
        await this.rotate(resourceId);
        return;
      }
      throw new Error(`Xata plugin: "${outputKey}" cannot be reissued.`);
    });
  }

  private async rotate(resourceId: string): Promise<void> {
    const [org, project, branch] = parts(externalIdOf(resourceId));
    const creds = await this.credentials(org, project, branch).catch(() => undefined);
    await this.api.post(`${this.branchPath(org, project, branch)}/credentials/rotate`, {
      body: { username: creds?.username ?? "xata" },
    });
  }

  // ---- detail views ----------------------------------------------------------------

  enrichDetail(resource: ResourceInstance): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const fields = { ...resource.fields };
      const p = parts(String(resource.externalId ?? ""));
      if (resource.resourceTypeId === "xata-branch") {
        const [org, project] = p;
        const region = String(resource.fields["region"] ?? "");
        const [types, images, limits] = await Promise.all([
          this.api
            .get(`${this.orgPath(org)}/instanceTypes`, { query: { region } })
            .catch(() => undefined),
          this.api.get(`${this.orgPath(org)}/images`, { query: { region } }).catch(() => undefined),
          this.api.get(`${this.projectPath(org, project)}/limits`).catch(() => undefined),
        ]);
        if (types?.instanceTypes) fields["_instanceTypes"] = JSON.stringify(types.instanceTypes);
        if (images?.images) fields["_images"] = JSON.stringify(images.images);
        if (limits) fields["_limits"] = JSON.stringify(limits);
      }
      if (resource.resourceTypeId === "xata-organization") {
        const org = p[0];
        const [upcoming, limits] = await Promise.all([
          this.api.get(`${this.orgPath(org)}/billing/invoices/upcoming`).catch(() => undefined),
          this.api.get(`${this.orgPath(org)}/limits`).catch(() => undefined),
        ]);
        if (upcoming) fields["_upcoming"] = JSON.stringify(upcoming);
        if (limits) fields["_limits"] = JSON.stringify(limits);
      }
      return { ...resource, fields };
    });
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderSidebarItem(resource);
  }

  fetchDashboardStats(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      if (typeId !== "xata-branch") return [];
      const r = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const st = String(r.fields["statusType"] ?? "");
      return [
        { label: "Region", value: String(r.fields["region"] ?? "") },
        { label: "Instance", value: String(r.fields["instanceType"] ?? "") },
        {
          label: "Status",
          value: st.replace("STATUS_TYPE_", "").toLowerCase(),
          variant:
            st === "STATUS_TYPE_HEALTHY"
              ? "status-healthy"
              : st === "STATUS_TYPE_FAULT"
                ? "status-error"
                : "status-degraded",
        },
      ];
    });
  }

  // ---- Postgres settings editor (branch) -----------------------------------------

  getManifest(resourceId: string, _accountId: string): PluginEffect<string> {
    return attempt(async () => {
      const [org, project, branch] = parts(externalIdOf(resourceId));
      const res = await this.api.get(`${this.branchPath(org, project, branch)}/postgres-config`);
      return JSON.stringify({ settings: (res?.parameters ?? []).map(pgDescriptor) });
    });
  }

  applyManifest(resourceId: string, _accountId: string, manifest: string): PluginEffect<void> {
    return attempt(async () => {
      const [org, project, branch] = parts(externalIdOf(resourceId));
      const changes: Array<{ id: string; value: string }> = JSON.parse(manifest);
      if (!Array.isArray(changes)) throw new Error("Settings must be a list of {id, value} pairs.");
      const current = await this.api.get(this.branchPath(org, project, branch));
      const params: Record<string, string> = {
        ...(current.configuration.postgresConfigurationParameters ?? {}),
      };
      for (const c of changes) {
        const value = c.value === "on" ? "on" : c.value === "off" ? "off" : c.value;
        if (value === "") delete params[c.id];
        else params[c.id] = value;
      }
      await this.api.patch(this.branchPath(org, project, branch), {
        body: { postgresConfigurationParameters: params },
      });
    });
  }

  // ---- SQL through the branch gateway ----------------------------------------------

  executeQuery(
    resourceId: string,
    _accountId: string,
    sql: string,
  ): PluginEffect<{ rows: Record<string, unknown>[]; durationMs: number }> {
    return attempt(async () => {
      const [org, project, branch] = parts(externalIdOf(resourceId));
      const creds = await this.credentials(org, project, branch);
      const host = creds.hostname || hostOf(creds.connectionString);
      const start = Date.now();
      const res = await createGatewayApi(this.ctx, host, creds.connectionString).post("/sql", {
        body: { query: sql },
      });
      return { rows: Array.isArray(res?.rows) ? res.rows : [], durationMs: Date.now() - start };
    });
  }

  introspectResource(resourceId: string, accountId: string): PluginEffect<SqlTableMeta[]> {
    return attempt(async () => {
      const { rows } = await runPluginEffect(
        this.executeQuery(
          resourceId,
          accountId,
          `select table_schema, table_name, column_name, data_type from information_schema.columns
        where table_schema not in ('pg_catalog', 'information_schema') order by table_schema, table_name, ordinal_position limit 5000`,
        ),
      );
      const tables = new Map<string, SqlTableMeta>();
      for (const r of rows) {
        const schema = String(r["table_schema"]);
        const name =
          schema === "public" ? String(r["table_name"]) : `${schema}.${String(r["table_name"])}`;
        const t = tables.get(name) ?? { name, columns: [] };
        t.columns.push({ name: String(r["column_name"]), type: String(r["data_type"]) });
        tables.set(name, t);
      }
      return [...tables.values()];
    });
  }

  // ---- create / update / delete --------------------------------------------------

  getCreateConfig(typeId: string, parentResourceId?: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      return getCreateConfig(this, typeId, parentResourceId);
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): PluginEffect<ResourceCreateReturn> {
    return attempt(async () => {
      const parent = parentResourceId ? parts(externalIdOf(parentResourceId)) : [];
      switch (typeId) {
        case "xata-project": {
          const org = parent[0] || required(fields["organizationId"], "an organization");
          const proj = await this.api.post(`${this.orgPath(org)}/projects`, {
            body: { name: required(fields["name"], "a project name") },
          });
          return projectResource(org, proj, accountId, 0);
        }
        case "xata-branch": {
          const ref =
            parent.length >= 2
              ? `${parent[0]}/${parent[1]}`
              : required(fields["projectRef"], "a project");
          const [org = "", project] = ref.split("/");
          const mode = fields["mode"] || "custom";
          const scaleToZero = bool(fields["scaleToZero"]);
          const common = {
            name: required(fields["name"], "a branch name"),
            ...(fields["description"] ? { description: fields["description"] } : {}),
            ...(scaleToZero !== undefined
              ? {
                  scaleToZero: {
                    enabled: scaleToZero,
                    inactivityPeriodMinutes: num(fields["inactivityMinutes"]) ?? 30,
                  },
                }
              : {}),
          };
          let created: XBranchShort;
          if (mode === "inherit") {
            created = await this.api.post(`${this.projectPath(org, project)}/branches`, {
              body: {
                ...common,
                mode: "inherit",
                parentID: required(fields["parentId"], "a parent branch"),
              },
            });
          } else if (mode === "restore") {
            const source = required(fields["parentId"], "a branch to restore");
            const src = await this.api.get(this.branchPath(org, project, source));
            created = await this.api.post(`${this.branchPath(org, project, source)}/restore`, {
              body: { ...common, configuration: { ...src.configuration, replicas: 0 } },
            });
          } else {
            const region = required(fields["region"], "a region");
            const instanceType = required(fields["instanceType"], "an instance type");
            const image = required(fields["image"], "a Postgres image");
            const replicas = num(fields["replicas"]) ?? 0;
            const storage = num(fields["storageGb"]);
            created = await this.api.post(`${this.projectPath(org, project)}/branches`, {
              body: {
                ...common,
                mode: "custom",
                configuration: {
                  region,
                  instanceType,
                  image,
                  replicas,
                  ...(storage !== undefined ? { storage } : {}),
                },
              },
            });
          }
          return runPluginEffect(
            this.getResource(
              typeId,
              `${accountId}:${typeId}:${org}/${project}/${created.id}`,
              accountId,
            ),
          ).catch(() => branchResource(org, project, created, accountId, ""));
        }
        case "xata-api-key": {
          const org = parent[0] || required(fields["organizationId"], "an organization");
          const scopes = listValue(fields["scopes"]);
          const projects = listValue(fields["projects"]);
          const res = await this.api.post(`${this.orgPath(org)}/api-keys`, {
            body: {
              name: required(fields["name"], "a name"),
              ...(fields["expiresAt"] ? { expiry: fields["expiresAt"] } : {}),
              ...(scopes.length ? { scopes } : {}),
              ...(projects.length ? { projects } : {}),
            },
          });
          const r = apiKeyResource(org, res.key, accountId);
          if (res.key.token) r.resolvedOutputs["token"] = res.key.token;
          return r;
        }
        case "xata-invitation": {
          const org = parent[0] || required(fields["organizationId"], "an organization");
          const email = required(fields["email"], "an email");
          await this.api.post(`${this.orgPath(org)}/invitations`, {
            body: { email, role: fields["role"] === "admin" ? "admin" : "editor" },
          });
          const res = await this.api.get(`${this.orgPath(org)}/invitations`, {
            query: { email },
          });
          const inv = res?.invitations?.[0];
          return instance(
            accountId,
            typeId,
            `${org}/${inv?.id ?? email}`,
            email,
            {
              email,
              organizationId: org,
              role: inv?.role ?? fields["role"] ?? "editor",
              status: inv?.status ?? "pending",
            },
            { typeId: "xata-organization", externalId: org },
          );
        }
        default:
          throw new Error(`Xata plugin: cannot create "${typeId}".`);
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
      const p = parts(externalIdOf(resourceId));
      switch (typeId) {
        case "xata-organization":
          if (fields["name"])
            await this.api.put(this.orgPath(p[0]), { body: { name: fields["name"] } });
          break;
        case "xata-project": {
          const [org, project] = p;
          const current = await this.api.get(this.projectPath(org, project));
          const body = projectPatch(current, fields);
          await this.api.patch(this.projectPath(org, project), { body });
          break;
        }
        case "xata-branch": {
          const [org, project, branch] = p;
          const body: XBranchPatch = {};
          if (fields["name"]) body["name"] = fields["name"];
          if (fields["description"] !== undefined) body["description"] = fields["description"];
          if (num(fields["replicas"]) !== undefined) body["replicas"] = num(fields["replicas"]);
          if (num(fields["storageGb"]) !== undefined) body["storage"] = num(fields["storageGb"]);
          const retentionPeriod = num(fields["backupRetentionDays"]);
          if (retentionPeriod !== undefined) body["backupConfiguration"] = { retentionPeriod };
          if (fields["scaleToZero"] !== undefined || fields["inactivityMinutes"] !== undefined) {
            const current = await this.api.get(this.branchPath(org, project, branch));
            body["scaleToZero"] = {
              enabled: bool(fields["scaleToZero"]) ?? current.scaleToZero.enabled,
              inactivityPeriodMinutes:
                num(fields["inactivityMinutes"]) ?? current.scaleToZero.inactivityPeriodMinutes,
            };
          }
          await this.api.patch(this.branchPath(org, project, branch), { body });
          break;
        }
        case "xata-member":
          if (fields["role"]) {
            await this.api.put(`${this.orgPath(p[0])}/members/${enc(p[1])}/role`, {
              body: { role: fields["role"] },
            });
          }
          break;
        default:
          throw new Error(`Xata plugin: cannot update "${typeId}".`);
      }
      return runPluginEffect(this.getResource(typeId, resourceId, accountId));
    });
  }

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const p = parts(externalIdOf(resourceId));
      switch (typeId) {
        case "xata-project":
          await this.api.delete(this.projectPath(p[0], p[1]));
          return;
        case "xata-branch":
          await this.api.delete(this.branchPath(p[0], p[1], p[2]));
          return;
        case "xata-api-key":
          await this.api.delete(`${this.orgPath(p[0])}/api-keys`, {
            body: { ids: [idPart(p[1])] },
          });
          return;
        case "xata-member":
          await this.api.delete(`${this.orgPath(p[0])}/members/${enc(p[1])}`);
          return;
        case "xata-invitation":
          await this.api.delete(`${this.orgPath(p[0])}/invitations/${enc(p[1])}`);
          return;
        default:
          throw new Error(`Xata plugin: "${typeId}" cannot be deleted.`);
      }
    });
  }

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const p = parts(externalIdOf(resourceId));
      if (typeId === "xata-branch") {
        const path = this.branchPath(p[0], p[1], p[2]);
        if (actionId === "hibernate" || actionId === "wake") {
          await this.api.patch(path, { body: { hibernate: actionId === "hibernate" } });
          return;
        }
        if (actionId === "rotate-credentials") {
          await this.rotate(resourceId);
          return;
        }
      }
      if (typeId === "xata-invitation" && actionId === "resend") {
        await this.api.post(`${this.orgPath(p[0])}/invitations/${enc(p[1])}/resend`);
        return;
      }
      throw new Error(`Xata plugin: unknown action "${actionId}" for "${typeId}".`);
    });
  }

  /** Prompted branch changes (instance type, image) whose options enrichDetail loaded. */
  executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): PluginEffect<unknown> {
    return attempt(async () => {
      if (typeId !== "xata-branch") throw new Error(`Xata plugin: unknown command "${command}".`);
      const p = parts(externalIdOf(resourceId));
      let values: Record<string, string> = {};
      try {
        values = JSON.parse(String(args[0] ?? "{}"));
      } catch {
        values = {};
      }
      const path = this.branchPath(p[0], p[1], p[2]);
      if (command === "set-instance-type") {
        await this.api.patch(path, {
          body: { instanceType: required(values["instanceType"], "an instance type") },
        });
        return { ok: true };
      }
      if (command === "set-image") {
        await this.api.patch(path, { body: { image: required(values["image"], "an image") } });
        return { ok: true };
      }
      throw new Error(`Xata plugin: unknown command "${command}".`);
    });
  }

  // ---- observability ------------------------------------------------------------

  fetchMetricSeries(
    typeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      if (typeId !== "xata-branch") return [];
      const [org, project, branch] = parts(externalIdOf(resourceId));
      const end = timeRange?.endMs ?? Date.now();
      const start = timeRange?.startMs ?? end - DEFAULT_METRICS_WINDOW_MS;
      const res = await this.api.post(`${this.branchPath(org, project, branch)}/metrics`, {
        body: {
          start: new Date(start).toISOString(),
          end: new Date(end).toISOString(),
          metrics: METRICS.map(([id]) => id),
          aggregations: ["avg"],
        },
      });
      const labels = new Map<string, string>(METRICS);
      const out: MetricSeries[] = [];
      for (const result of res?.results ?? []) {
        const several = result.series.length > 1;
        for (const s of result.series) {
          const points = s.values
            .map((v) => ({ timestamp: Date.parse(v.timestamp), value: Number(v.value) }))
            .filter((pt) => Number.isFinite(pt.timestamp) && Number.isFinite(pt.value));
          if (points.length === 0) continue;
          const base = labels.get(result.metric) ?? result.metric;
          out.push({
            label: several ? `${base} (${s.instanceID})` : base,
            unit: result.unit,
            points,
          });
        }
      }
      return out;
    });
  }

  getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): PluginEffect<LogsFetchResult> {
    return attempt(async () => {
      if (typeId !== "xata-branch") return { text: "", containers: [], activeContainer: "" };
      const [org, project, branch] = parts(externalIdOf(resourceId));
      const containers = ["all", "warnings and errors"];
      const active =
        params.container && containers.includes(params.container) ? params.container : "all";
      const end = new Date();
      const start = new Date(end.getTime() - 24 * 3_600_000);
      const want = Math.min(Math.max(params.tailLines ?? 200, 1), MAX_LOG_LINES);
      const logs: XLogEntry[] = [];
      let cursor: string | null | undefined;
      for (let page = 0; page < MAX_LOG_PAGES && logs.length < want; page++) {
        const res = await this.api.post(`${this.branchPath(org, project, branch)}/logs`, {
          body: {
            start: start.toISOString(),
            end: end.toISOString(),
            limit: Math.min(want - logs.length, LOG_PAGE_SIZE),
            ...(active === "warnings and errors"
              ? { filters: [{ field: "level", op: "in", values: ["warning", "error"] }] }
              : {}),
            ...(cursor ? { cursor } : {}),
          },
        });
        logs.push(...(res?.logs ?? []));
        cursor = res?.nextCursor;
        if (!cursor) break;
      }
      logs.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const text = logs
        .map(
          (l) =>
            `${l.timestamp} [${l.instanceID}] ${(l.level ?? "").toUpperCase()} ${l.process ? `${l.process}: ` : ""}${l.message}\n`,
        )
        .join("");
      return { text, containers, activeContainer: active };
    });
  }

  fetchCostData(_accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      const orgs = await this.orgs();
      const lists = await Promise.all(
        orgs.map(async (o) => {
          const invoices = await this.invoicePages.getAll(
            `${this.orgPath(o.id)}/billing/invoices`,
            "data",
          );
          const upcoming = await this.api
            .get(`${this.orgPath(o.id)}/billing/invoices/upcoming`)
            .catch((err: unknown) => {
              if ([402, 403, 404].includes(statusOf(err))) return undefined;
              throw err;
            });
          return fetchXataCostData(o, invoices, upcoming, range);
        }),
      );
      return lists.flat();
    });
  }

  /**
   * Organization limits against current counts: projects, branches per
   * project, active branches across the organization, members and pending
   * invitations. Every limit comes from Xata's own limits endpoints.
   */
  fetchQuotas(_accountId: string): PluginEffect<QuotaUsage[]> {
    return attempt(async () => {
      const orgs = await this.orgs();
      const lists = await Promise.all(
        orgs.map(async (o) => {
          const [limits, membership, projects, members, invites] = await Promise.all([
            this.api.get(`${this.orgPath(o.id)}/limits`),
            this.api.get(`${this.orgPath(o.id)}/membership-limits`),
            this.projects(o.id),
            this.members(o.id),
            this.invitationPages.getAll(`${this.orgPath(o.id)}/invitations`, "invitations", {
              query: { status: "pending" },
            }),
          ]);
          const perProject = await Promise.all(
            projects.map(async (p) => ({
              project: p,
              branches: (await this.branchSummaries(o.id, p.id)).length,
              limits: await this.api.get(`${this.projectPath(o.id, p.id)}/limits`),
            })),
          );
          const totalBranches = perProject.reduce((s, x) => s + x.branches, 0);
          const q: QuotaUsage[] = [];
          const add = (id: string, name: string, used: number, limit: number | undefined) => {
            if (typeof limit === "number" && limit > 0)
              q.push({
                id: `${o.id}/${id}`,
                service: "organization",
                name,
                used,
                limit,
                adjustable: true,
              });
          };
          add("projects", `Projects (${o.name})`, projects.length, limits?.maxProjects);
          add("branches", `Active branches (${o.name})`, totalBranches, limits?.maxBranchesPerOrg);
          add("members", `Members (${o.name})`, members.length, membership?.maxMembers);
          add("invites", `Pending invitations (${o.name})`, invites.length, membership?.maxInvites);
          for (const x of perProject) {
            add(
              `branches/${x.project.id}`,
              `Branches in ${x.project.name}`,
              x.branches,
              x.limits?.maxBranchesPerProject,
            );
          }
          return q;
        }),
      );
      return lists.flat();
    });
  }
}

// ---- mappers -----------------------------------------------------------------------

export function orgResource(o: XOrg, accountId: string, memberCount?: number): ResourceInstance {
  return instance(
    accountId,
    "xata-organization",
    o.id,
    o.name,
    {
      name: o.name,
      organizationId: o.id,
      status: o.status.status,
      billingStatus: o.status.billing_status,
      billingReason: o.status.billing_reason ?? "",
      usageTier: o.status.usage_tier,
      marketplace: o.marketplace ?? "",
      memberCount,
      createdAt: o.status.created_at ?? "",
    },
    undefined,
    o.status.created_at,
  );
}

export function projectResource(
  org: string,
  p: XProject,
  accountId: string,
  branchCount?: number,
): ResourceInstance {
  const s2z = p.configuration?.scaleToZero;
  const ip = p.configuration?.ipFiltering;
  return instance(
    accountId,
    "xata-project",
    `${org}/${p.id}`,
    p.name,
    {
      name: p.name,
      projectId: p.id,
      organizationId: org,
      baseScaleToZero: s2z?.baseBranches?.enabled,
      baseInactivityMinutes: s2z?.baseBranches?.inactivityPeriodMinutes,
      childScaleToZero: s2z?.childBranches?.enabled,
      childInactivityMinutes: s2z?.childBranches?.inactivityPeriodMinutes,
      ipFilteringEnabled: ip?.enabled ?? false,
      allowedCidrs: (ip?.cidr ?? []).map((c) => c.cidr).join(", "),
      branchCount,
      createdAt: p.createdAt,
    },
    { typeId: "xata-organization", externalId: org },
    p.createdAt,
  );
}

export function projectPatch(current: XProject, fields: Record<string, string>): XProjectPatch {
  const body: XProjectPatch = {};
  if (fields["name"]) body["name"] = fields["name"];
  const s2z = current.configuration.scaleToZero;
  const touches = (keys: string[]) => keys.some((k) => fields[k] !== undefined);
  const configuration: XProjectConfigPatch = {};
  if (
    touches([
      "baseScaleToZero",
      "baseInactivityMinutes",
      "childScaleToZero",
      "childInactivityMinutes",
    ])
  ) {
    configuration["scaleToZero"] = {
      baseBranches: {
        enabled: bool(fields["baseScaleToZero"]) ?? s2z.baseBranches.enabled,
        inactivityPeriodMinutes:
          num(fields["baseInactivityMinutes"]) ?? s2z.baseBranches.inactivityPeriodMinutes,
      },
      childBranches: {
        enabled: bool(fields["childScaleToZero"]) ?? s2z.childBranches.enabled,
        inactivityPeriodMinutes:
          num(fields["childInactivityMinutes"]) ?? s2z.childBranches.inactivityPeriodMinutes,
      },
    };
  }
  if (touches(["ipFilteringEnabled", "allowedCidrs"])) {
    const ip = current.configuration.ipFiltering ?? { enabled: false, cidr: [] };
    configuration["ipFiltering"] = {
      enabled: bool(fields["ipFilteringEnabled"]) ?? ip.enabled,
      cidr:
        fields["allowedCidrs"] !== undefined
          ? listValue(fields["allowedCidrs"]).map((cidr) => ({ cidr }))
          : ip.cidr,
    };
  }
  if (Object.keys(configuration).length) body["configuration"] = configuration;
  return body;
}

export function branchResource(
  org: string,
  project: string | undefined,
  b: XBranchRow,
  accountId: string,
  host: string,
): ResourceInstance {
  return instance(
    accountId,
    "xata-branch",
    `${org}/${project}/${b.id}`,
    b.name,
    {
      name: b.name,
      description: b.description ?? "",
      branchId: b.id,
      projectId: project,
      organizationId: org,
      parentId: b.parentID ?? "",
      region: b.region,
      statusType: b.status?.statusType,
      status: b.status?.status,
      statusMessage: b.status?.message ?? "",
      instanceType: b.configuration?.instanceType,
      image: b.configuration?.image,
      replicas: b.configuration?.replicas,
      storageGb: b.configuration?.storage,
      instanceCount: b.status?.instanceCount,
      instanceReadyCount: b.status?.instanceReadyCount,
      scaleToZero: b.scaleToZero?.enabled,
      inactivityMinutes: b.scaleToZero?.inactivityPeriodMinutes,
      backupsEnabled: b.backupsEnabled,
      backupRetentionDays: b.backupConfiguration?.retentionPeriod,
      publicAccess: b.publicAccess,
      host,
      createdAt: b.createdAt,
    },
    { typeId: "xata-project", externalId: `${org}/${project}` },
    b.createdAt,
  );
}

function backupResource(
  org: string,
  project: string,
  b: XBackup,
  accountId: string,
): ResourceInstance {
  return instance(
    accountId,
    "xata-backup",
    `${org}/${project}/${b.id}`,
    b.description || b.id,
    {
      description: b.description,
      branchId: b.branchID,
      projectId: project,
      organizationId: org,
      earliestRestore: b.earliestRestore ?? "",
      latestRestore: b.latestRestore ?? "",
    },
    { typeId: "xata-project", externalId: `${org}/${project}` },
  );
}

export function apiKeyResource(org: string, k: XApiKey, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "xata-api-key",
    `${org}/${k.id}`,
    k.name,
    {
      name: k.name,
      organizationId: org,
      preview: k.preview,
      scopes: (k.scopes ?? []).join(", "),
      projects: (k.projects ?? []).join(", "),
      branches: (k.branches ?? []).join(", "),
      fullAccess: (k.scopes ?? []).length === 0 && (k.projects ?? []).length === 0,
      createdAt: k.created_at,
      expiresAt: k.expiry ?? "",
      lastUsedAt: k.last_used ?? "",
    },
    { typeId: "xata-organization", externalId: org },
    k.created_at,
  );
}

/** One Postgres parameter as a settings-editor row. */
export function pgDescriptor(p: XPgParameter): SettingDescriptor {
  const base = {
    id: p.name,
    label: p.name,
    description: `${p.description}${p.restartRequired ? " (restarts Postgres)" : ""} Default: ${p.defaultValue}.`,
    group: p.section,
  };
  if (p.type === "boolean")
    return {
      ...base,
      control: "toggle",
      value: p.currentValue === "on" || p.currentValue === "true" ? "on" : "off",
    };
  if (p.type === "enum" && p.acceptableRange?.enumValues?.length) {
    return {
      ...base,
      control: "select",
      value: p.currentValue,
      options: p.acceptableRange.enumValues.map((v) => ({ value: v, label: v })),
    };
  }
  if (p.type === "int" || p.type === "float")
    return { ...base, control: "number", value: p.currentValue };
  return { ...base, control: "text", value: p.currentValue };
}
