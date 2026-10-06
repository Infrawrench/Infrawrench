import type {
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  PluginClient,
  PreflightResult,
  ResourceCreateReturn,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type {
  CAllowlistEntry,
  CApiKey,
  CBackupConfig,
  CCluster,
  CFolder,
  CInvoice,
  CrdbContext,
  CServiceAccount,
} from "./api.js";
import { crdb, CrdbApiError, enc, paged, statusOf } from "./api.js";
import { getCreateConfig } from "./create-config.js";
import { invoicesToCostRows } from "./cost-data.js";
import { verifyCockroachCredentials } from "./preflight.js";
import { renderDetail, renderSidebarItem } from "./render.js";

type Fields = ResourceInstance["fields"];

export const PASSWORD_FIELD = "password";

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
    pluginId: "cockroachdb-cloud",
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
  if (!Number.isFinite(n)) throw new Error(`CockroachDB Cloud plugin: "${v}" is not a number.`);
  return n;
}

function required(v: string | undefined, what: string): string {
  const s = (v ?? "").trim();
  if (!s) throw new Error(`CockroachDB Cloud plugin: ${what} is required.`);
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

/** Protobuf JSON durations ("21600s") to hours, and back. */
export function durationHours(d: string | undefined): number | undefined {
  if (!d) return undefined;
  const m = /^(-?\d+(?:\.\d+)?)s$/.exec(d.trim());
  return m ? Number(m[1]) / 3600 : undefined;
}

export function hoursDuration(h: number): string {
  return `${Math.round(h * 3600)}s`;
}

function randomPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(28);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function split(externalId: string): [string, string] {
  const i = externalId.indexOf("/");
  return i < 0 ? [externalId, ""] : [externalId.slice(0, i), externalId.slice(i + 1)];
}

async function settle<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch {
    return undefined;
  }
}

export class CockroachClient implements PluginClient {
  readonly ctx: CrdbContext;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const token = (credentials["apiKey"] ?? "").trim();
    if (!token) throw new Error("CockroachDB Cloud plugin: missing apiKey credential");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      token,
      ...(services?.http ? { http: services.http } : {}),
      ...(caCert ? { caCert } : {}),
    };
    this.services = services;
  }

  verifyCredentials(): Promise<PreflightResult> {
    return verifyCockroachCredentials(this);
  }

  clusters(): Promise<CCluster[]> {
    return paged<CCluster>(this.ctx, "/api/v1/clusters", "clusters");
  }

  folders(): Promise<CFolder[]> {
    return paged<CFolder>(this.ctx, "/api/v1/folders", "folders");
  }

  serviceAccounts(): Promise<CServiceAccount[]> {
    return paged<CServiceAccount>(this.ctx, "/api/v1/service-accounts", "service_accounts");
  }

  /**
   * Run `fn` for each cluster. A 400/404 (the feature does not exist on this
   * plan, e.g. maintenance windows on Basic) skips that cluster; anything else
   * fails the listing, because a short list reads as deletions.
   */
  private async perCluster<T>(
    fn: (c: CCluster) => Promise<T[]>,
    only?: CCluster[],
    tolerate: number[] = [400, 404],
  ): Promise<T[]> {
    const clusters = (only ?? (await this.clusters())).filter((c) => c.state !== "DELETED");
    const lists = await Promise.all(
      clusters.map(async (c) => {
        try {
          return await fn(c);
        } catch (err) {
          if (tolerate.includes(statusOf(err))) return [];
          throw err;
        }
      }),
    );
    return lists.flat();
  }

  // ---- listing -----------------------------------------------------------------

  listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    return this.list(typeId, accountId);
  }

  private async list(
    typeId: string,
    accountId: string,
    only?: CCluster[],
  ): Promise<ResourceInstance[]> {
    const base = (c: CCluster) => `/api/v1/clusters/${enc(c.id)}`;
    const child = (c: CCluster) => ({ typeId: "crdb-cluster", externalId: c.id });
    switch (typeId) {
      case "crdb-organization": {
        const org = await crdb<{ id: string; name: string; label: string; created_at: string }>(
          this.ctx,
          "GET",
          "/api/v1/organization",
        );
        return [
          instance(accountId, typeId, org.id, org.name, {
            name: org.name,
            label: org.label,
            organizationId: org.id,
            createdAt: org.created_at,
          }),
        ];
      }
      case "crdb-folder":
        return (await this.folders()).map((fo) => folderResource(fo, accountId));
      case "crdb-cluster": {
        const clusters = (only ?? (await this.clusters())).filter((c) => c.state !== "DELETED");
        return Promise.all(clusters.map((c) => this.clusterResource(c, accountId)));
      }
      case "crdb-database":
        return this.perCluster(
          async (c) =>
            (
              await paged<{ name: string; table_count?: string }>(
                this.ctx,
                `${base(c)}/databases`,
                "databases",
              )
            ).map((d) =>
              instance(
                accountId,
                typeId,
                `${c.id}/${d.name}`,
                d.name,
                {
                  name: d.name,
                  clusterId: c.id,
                  tableCount: d.table_count !== undefined ? Number(d.table_count) : undefined,
                },
                child(c),
              ),
            ),
          only,
        );
      case "crdb-sql-user":
        return this.perCluster(
          async (c) =>
            (await paged<{ name: string }>(this.ctx, `${base(c)}/sql-users`, "users")).map((u) =>
              instance(
                accountId,
                typeId,
                `${c.id}/${u.name}`,
                u.name,
                { name: u.name, clusterId: c.id },
                child(c),
              ),
            ),
          only,
        );
      case "crdb-allowlist-entry":
        return this.perCluster(
          async (c) =>
            (
              await paged<CAllowlistEntry>(this.ctx, `${base(c)}/networking/allowlist`, "allowlist")
            ).map((e) => allowlistResource(c.id, e, accountId)),
          only,
        );
      case "crdb-backup":
        return this.perCluster(
          async (c) =>
            (
              await paged<{ id: string; as_of_time: string }>(
                this.ctx,
                `${base(c)}/backups`,
                "backups",
              )
            ).map((b) =>
              instance(
                accountId,
                typeId,
                `${c.id}/${b.id}`,
                `${c.name} · ${b.as_of_time.slice(0, 16).replace("T", " ")}`,
                { clusterId: c.id, backupId: b.id, asOfTime: b.as_of_time },
                child(c),
                b.as_of_time,
              ),
            ),
          only,
          [400, 403, 404],
        );
      case "crdb-restore":
        return this.perCluster(
          async (c) =>
            (await paged<Record<string, unknown>>(this.ctx, `${base(c)}/restores`, "restores")).map(
              (r) => restoreResource(c.id, r, accountId),
            ),
          only,
          [400, 403, 404],
        );
      case "crdb-log-export":
        return this.perCluster(
          async (c) => {
            const le = await crdb<{
              status?: string;
              delivery_status?: string;
              user_message?: string;
              delivery_status_message?: string;
              created_at?: string;
              spec?: { type?: string; log_name?: string; region?: string; redact?: boolean };
            }>(this.ctx, "GET", `${base(c)}/logexport`);
            if (!le?.spec?.type || le.status === "DISABLED") return [];
            return [
              instance(
                accountId,
                typeId,
                c.id,
                `${c.name} logs → ${le.spec.type}`,
                {
                  type: le.spec.type,
                  clusterId: c.id,
                  status: le.status,
                  deliveryStatus: le.delivery_status,
                  message: le.delivery_status_message || le.user_message,
                  logName: le.spec.log_name,
                  region: le.spec.region,
                  redact: le.spec.redact,
                },
                child(c),
                le.created_at,
              ),
            ];
          },
          only,
          [400, 403, 404],
        );
      case "crdb-metric-export":
        return this.perCluster(async (c) => {
          const kinds = ["datadog", "cloudwatch", "prometheus"] as const;
          const results = await Promise.all(
            kinds.map(async (kind) => {
              const res = await settle(
                crdb<Record<string, unknown>>(this.ctx, "GET", `${base(c)}/metricexport/${kind}`),
              );
              const status = typeof res?.["status"] === "string" ? (res["status"] as string) : "";
              if (!res || !status || status === "NOT_DEPLOYED") return null;
              const target =
                kind === "datadog"
                  ? `Datadog ${String(res["site"] ?? "")}`
                  : kind === "cloudwatch"
                    ? String(res["role_arn"] ?? "")
                    : Object.entries((res["targets"] as Record<string, string>) ?? {})
                        .map(([region, url]) => `${region}: ${url}`)
                        .join(", ");
              return instance(
                accountId,
                typeId,
                `${c.id}/${kind}`,
                `${c.name} metrics → ${kind}`,
                {
                  kind,
                  clusterId: c.id,
                  status,
                  message: String(res["user_message"] ?? ""),
                  target,
                },
                child(c),
              );
            }),
          );
          return results.filter((r): r is ResourceInstance => r !== null);
        }, only);
      case "crdb-blackout-window":
        return this.perCluster(
          async (c) => {
            if (c.plan && c.plan !== "ADVANCED") return [];
            const res = await crdb<{
              blackout_windows?: Array<{ id: string; start_time: string; end_time: string }>;
            }>(this.ctx, "GET", `${base(c)}/blackout-windows`);
            return (res?.blackout_windows ?? []).map((w) =>
              instance(
                accountId,
                typeId,
                `${c.id}/${w.id}`,
                `${w.start_time.slice(0, 10)} → ${w.end_time.slice(0, 10)}`,
                { clusterId: c.id, startTime: w.start_time, endTime: w.end_time },
                child(c),
              ),
            );
          },
          only,
          [400, 403, 404],
        );
      case "crdb-egress-rule":
        return this.perCluster(
          async (c) => {
            const res = await crdb<{
              rules?: Array<{
                id: string;
                name: string;
                type: string;
                destination: string;
                ports?: number[];
                description: string;
                state: string;
                crl_managed: boolean;
                created_at?: string;
              }>;
            }>(this.ctx, "GET", `${base(c)}/networking/egress-rules`);
            return (res?.rules ?? []).map((r) =>
              instance(
                accountId,
                typeId,
                `${c.id}/${r.id}`,
                r.name,
                {
                  name: r.name,
                  clusterId: c.id,
                  type: r.type,
                  destination: r.destination,
                  ports: (r.ports ?? []).join(", "),
                  description: r.description,
                  state: r.state,
                  managed: r.crl_managed,
                },
                child(c),
                r.created_at,
              ),
            );
          },
          only,
          [400, 403, 404],
        );
      case "crdb-service-account":
        return (await this.serviceAccounts()).map((sa) => serviceAccountResource(sa, accountId));
      case "crdb-api-key": {
        const [keys, sas] = await Promise.all([
          paged<CApiKey>(this.ctx, "/api/v1/api-keys", "api_keys"),
          this.serviceAccounts().catch(() => [] as CServiceAccount[]),
        ]);
        const names = new Map(sas.map((s) => [s.id, s.name]));
        return keys.map((k) =>
          instance(
            accountId,
            typeId,
            k.id,
            k.name,
            {
              name: k.name,
              serviceAccountId: k.service_account_id,
              serviceAccountName: names.get(k.service_account_id) ?? "",
              createdAt: k.created_at,
            },
            { typeId: "crdb-service-account", externalId: k.service_account_id },
            k.created_at,
          ),
        );
      }
      default:
        throw new Error(`CockroachDB Cloud plugin: unknown resource type "${typeId}"`);
    }
  }

  private async clusterResource(c: CCluster, accountId: string): Promise<ResourceInstance> {
    const base = `/api/v1/clusters/${enc(c.id)}`;
    const advanced = c.plan === "ADVANCED" || !!c.config.dedicated;
    const [backups, deferral, window, cmek, allowlist] = await Promise.all([
      settle(crdb<CBackupConfig>(this.ctx, "GET", `${base}/backups-config`)),
      settle(crdb<{ deferral_policy?: string }>(this.ctx, "GET", `${base}/version-deferral`)),
      advanced
        ? settle(
            crdb<{ offset_duration?: string; window_duration?: string }>(
              this.ctx,
              "GET",
              `${base}/maintenance-window`,
            ),
          )
        : undefined,
      advanced ? settle(crdb<{ status?: string }>(this.ctx, "GET", `${base}/cmek`)) : undefined,
      c.config.host
        ? undefined
        : settle(paged<CAllowlistEntry>(this.ctx, `${base}/networking/allowlist`, "allowlist")),
    ]);
    return clusterResource(c, accountId, { backups, deferral, window, cmek, allowlist });
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const externalId = externalIdOf(resourceId);
    const clusterScoped =
      typeId.startsWith("crdb-") &&
      !["crdb-organization", "crdb-folder", "crdb-service-account", "crdb-api-key"].includes(
        typeId,
      );
    let all: ResourceInstance[];
    if (clusterScoped) {
      const [clusterId] = split(externalId);
      const c = await crdb<CCluster>(this.ctx, "GET", `/api/v1/clusters/${enc(clusterId)}`);
      all = await this.list(typeId, accountId, [c]);
    } else {
      all = await this.list(typeId, accountId);
    }
    const found = all.find((r) => r.id === resourceId);
    if (!found)
      throw new CrdbApiError(404, `CockroachDB Cloud plugin: ${typeId}/${externalId} not found`);
    return found;
  }

  // ---- outputs -------------------------------------------------------------------

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    _accountId: string,
  ): Promise<string> {
    const externalId = externalIdOf(resourceId);
    const [first, rest] = split(externalId);
    switch (`${typeId}.${outputKey}`) {
      case "crdb-organization.organizationId":
      case "crdb-folder.folderId":
      case "crdb-cluster.clusterId":
      case "crdb-service-account.serviceAccountId":
        return externalId;
      case "crdb-cluster.sqlHost": {
        const c = await crdb<CCluster>(this.ctx, "GET", `/api/v1/clusters/${enc(externalId)}`);
        return c.sql_dns || c.regions[0]?.sql_dns || "";
      }
      case "crdb-cluster.connectionStringTemplate":
        return this.connectionString(externalId);
      case "crdb-database.databaseName":
      case "crdb-sql-user.username":
        return rest;
      case "crdb-sql-user.connectionString": {
        const password = await this.services?.secrets?.getPlaintext(resourceId, PASSWORD_FIELD);
        if (!password) {
          throw new Error(
            'CockroachDB Cloud never returns SQL passwords. Use "Set password" on this SQL user so Infrawrench can build its connection string.',
          );
        }
        return withPassword(portable(await this.connectionString(first, rest)), rest, password);
      }
      case "crdb-api-key.secret":
        throw new Error(
          "CockroachDB Cloud shows an API key's secret only when it is created. Create a new key to get one.",
        );
    }
    throw new Error(
      `CockroachDB Cloud plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
    );
  }

  private async connectionString(clusterId: string, sqlUser?: string): Promise<string> {
    const res = await crdb<{ connection_string: string }>(
      this.ctx,
      "GET",
      `/api/v1/clusters/${enc(clusterId)}/connection-string`,
      undefined,
      { ...(sqlUser ? { sql_user: sqlUser } : {}), os: "LINUX" },
    );
    return res.connection_string;
  }

  async rerollOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    _accountId: string,
  ): Promise<void> {
    if (typeId === "crdb-sql-user" && outputKey === "connectionString") {
      await this.setPassword(resourceId);
      return;
    }
    throw new Error(`CockroachDB Cloud plugin: "${outputKey}" cannot be reissued.`);
  }

  async applySecretReroll(
    typeId: string,
    resourceId: string,
    _accountId: string,
    fieldKey: string,
    plaintext: string,
  ): Promise<void> {
    if (typeId === "crdb-sql-user" && fieldKey === PASSWORD_FIELD)
      await this.setPassword(resourceId, plaintext);
  }

  private async setPassword(resourceId: string, chosen?: string): Promise<void> {
    const [clusterId, user] = split(externalIdOf(resourceId));
    const password = chosen || randomPassword();
    await crdb(
      this.ctx,
      "PUT",
      `/api/v1/clusters/${enc(clusterId)}/sql-users/${enc(user)}/password`,
      { password },
    );
    if (!this.services?.secrets?.setPlaintext) {
      throw new Error(
        `The password was changed but this host cannot store it. The new password is: ${password}`,
      );
    }
    await this.services.secrets.setPlaintext(resourceId, PASSWORD_FIELD, password);
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    let values: Record<string, string> = {};
    try {
      values = JSON.parse(String(args[0] ?? "{}")) as Record<string, string>;
    } catch {
      values = {};
    }
    if (typeId === "crdb-sql-user" && command === "reset-password") {
      await this.setPassword(resourceId, values["password"]);
      return { ok: true };
    }
    if (typeId === "crdb-cluster" && command === "move-to-folder") {
      await crdb(this.ctx, "PATCH", `/api/v1/clusters/${enc(externalIdOf(resourceId))}`, {
        parent_id: values["folderId"] || "root",
      });
      return { ok: true };
    }
    if (typeId === "crdb-cluster" && command === "upgrade") {
      await crdb(this.ctx, "PATCH", `/api/v1/clusters/${enc(externalIdOf(resourceId))}`, {
        cockroach_version: required(values["version"], "a version"),
      });
      return { ok: true };
    }
    throw new Error(`CockroachDB Cloud plugin: unknown command "${command}".`);
  }

  // ---- detail views ----------------------------------------------------------------

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const fields = { ...resource.fields };
    if (resource.resourceTypeId === "crdb-cluster") {
      const id = String(resource.externalId ?? "");
      const [nodes, versions, folders] = await Promise.all([
        settle(
          paged<{ name: string; region_name: string; status: string }>(
            this.ctx,
            `/api/v1/clusters/${enc(id)}/nodes`,
            "nodes",
          ),
        ),
        settle(
          paged<{
            version: string;
            allowed_upgrades: string[];
            support_status: string;
            support_end: string;
          }>(this.ctx, "/api/v1/cluster-versions", "versions"),
        ),
        settle(this.folders()),
      ]);
      if (nodes) fields["_nodes"] = JSON.stringify(nodes);
      if (versions) fields["_versions"] = JSON.stringify(versions);
      if (folders)
        fields["_folders"] = JSON.stringify(
          folders.map((fo) => ({ id: fo.resource_id, name: fo.name })),
        );
    }
    if (resource.resourceTypeId === "crdb-organization") {
      const invoices = await settle(paged<CInvoice>(this.ctx, "/api/v1/invoices", "invoices"));
      const latest = invoices?.sort((a, b) => b.period_start.localeCompare(a.period_start))[0];
      if (latest)
        fields["_latestInvoice"] = JSON.stringify({
          period_start: latest.period_start,
          status: latest.status,
          totals: latest.totals,
          balances: latest.balances,
        });
    }
    return { ...resource, fields };
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderSidebarItem(resource);
  }

  async fetchDashboardStats(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    if (typeId !== "crdb-cluster") return [];
    const r = await this.getResource(typeId, resourceId, accountId);
    return [
      { label: "Plan", value: String(r.fields["plan"] ?? "") },
      { label: "Region", value: String(r.fields["region"] ?? "") },
      { label: "Version", value: String(r.fields["version"] ?? "") },
    ];
  }

  // ---- create / update / delete ----------------------------------------------------

  getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    return getCreateConfig(this, typeId, parentResourceId);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceCreateReturn> {
    const parent = parentResourceId ? externalIdOf(parentResourceId) : "";
    const clusterId = () => required(parent || fields["clusterId"], "a cluster");
    const base = () => `/api/v1/clusters/${enc(clusterId())}`;
    switch (typeId) {
      case "crdb-folder": {
        const fo = await crdb<CFolder>(this.ctx, "POST", "/api/v1/folders", {
          name: required(fields["name"], "a name"),
          parent_id: fields["parentId"] || "root",
        });
        return folderResource(fo, accountId);
      }
      case "crdb-cluster": {
        const c = await crdb<CCluster>(
          this.ctx,
          "POST",
          "/api/v1/clusters",
          clusterCreateBody(fields),
        );
        return clusterResource(c, accountId, {});
      }
      case "crdb-database": {
        const name = required(fields["name"], "a name");
        await crdb(this.ctx, "POST", `${base()}/databases`, { name });
        return instance(
          accountId,
          typeId,
          `${clusterId()}/${name}`,
          name,
          { name, clusterId: clusterId(), tableCount: 0 },
          {
            typeId: "crdb-cluster",
            externalId: clusterId(),
          },
        );
      }
      case "crdb-sql-user": {
        const name = required(fields["name"], "a name");
        const password = fields["password"] || randomPassword();
        await crdb(this.ctx, "POST", `${base()}/sql-users`, { name, password });
        const r = instance(
          accountId,
          typeId,
          `${clusterId()}/${name}`,
          name,
          { name, clusterId: clusterId() },
          {
            typeId: "crdb-cluster",
            externalId: clusterId(),
          },
        );
        const warnings = [];
        if (this.services?.secrets?.setPlaintext) {
          await this.services.secrets.setPlaintext(r.id, PASSWORD_FIELD, password);
        } else {
          warnings.push({
            code: "password-not-stored",
            message: `Save this password now, it is not stored: ${password}`,
          });
        }
        return { resource: r, warnings };
      }
      case "crdb-allowlist-entry": {
        const [ip, mask] = parseCidr(required(fields["cidr"], "a CIDR"));
        const e = await crdb<CAllowlistEntry>(this.ctx, "POST", `${base()}/networking/allowlist`, {
          cidr_ip: ip,
          cidr_mask: mask,
          ...(fields["name"] ? { name: fields["name"] } : {}),
          sql: fields["sql"] !== "false",
          ui: fields["ui"] === "true",
        });
        return allowlistResource(clusterId(), e, accountId);
      }
      case "crdb-log-export": {
        const type = required(fields["type"], "a destination");
        await crdb(this.ctx, "POST", `${base()}/logexport`, {
          type,
          log_name: required(fields["logName"], "a log name"),
          ...(fields["authPrincipal"] ? { auth_principal: fields["authPrincipal"] } : {}),
          ...(fields["otlpEndpoint"] ? { otlp_endpoint: fields["otlpEndpoint"] } : {}),
          ...(fields["otlpAuthorization"]
            ? { otlp_headers: { authorization: fields["otlpAuthorization"] } }
            : {}),
          ...(fields["region"] ? { region: fields["region"] } : {}),
          ...(bool(fields["redact"]) !== undefined ? { redact: bool(fields["redact"]) } : {}),
        });
        return this.getResource(typeId, `${accountId}:${typeId}:${clusterId()}`, accountId).catch(
          () =>
            instance(accountId, typeId, clusterId(), `logs → ${type}`, {
              type,
              clusterId: clusterId(),
              status: "ENABLING",
            }),
        );
      }
      case "crdb-metric-export": {
        const kind = required(fields["kind"], "a destination");
        const body =
          kind === "datadog"
            ? {
                api_key: required(fields["datadogApiKey"], "a Datadog API key"),
                site: fields["datadogSite"] || "US1",
              }
            : kind === "cloudwatch"
              ? {
                  role_arn: required(fields["roleArn"], "an IAM role ARN"),
                  ...(fields["targetRegion"] ? { target_region: fields["targetRegion"] } : {}),
                  ...(fields["logGroupName"] ? { log_group_name: fields["logGroupName"] } : {}),
                }
              : {};
        await crdb(this.ctx, "POST", `${base()}/metricexport/${enc(kind)}`, body);
        return instance(
          accountId,
          typeId,
          `${clusterId()}/${kind}`,
          `metrics → ${kind}`,
          {
            kind,
            clusterId: clusterId(),
            status: "ENABLING",
          },
          { typeId: "crdb-cluster", externalId: clusterId() },
        );
      }
      case "crdb-blackout-window": {
        const w = await crdb<{ id: string; start_time: string; end_time: string }>(
          this.ctx,
          "POST",
          `${base()}/blackout-windows`,
          {
            start_time: required(fields["startTime"], "a start time"),
            end_time: required(fields["endTime"], "an end time"),
          },
        );
        return instance(
          accountId,
          typeId,
          `${clusterId()}/${w.id}`,
          `${w.start_time.slice(0, 10)} → ${w.end_time.slice(0, 10)}`,
          {
            clusterId: clusterId(),
            startTime: w.start_time,
            endTime: w.end_time,
          },
          { typeId: "crdb-cluster", externalId: clusterId() },
        );
      }
      case "crdb-egress-rule": {
        const ports = listValue(fields["ports"]).map(Number).filter(Number.isFinite);
        const res = await crdb<{ Rule?: { id: string } }>(
          this.ctx,
          "POST",
          `${base()}/networking/egress-rules`,
          {
            name: required(fields["name"], "a name"),
            type: fields["type"] === "CIDR" ? "CIDR" : "FQDN",
            destination: required(fields["destination"], "a destination"),
            description: fields["description"] ?? "",
            ...(ports.length ? { ports } : {}),
          },
        );
        const id = res?.Rule?.id ?? "";
        return this.getResource(typeId, `${accountId}:${typeId}:${clusterId()}/${id}`, accountId);
      }
      case "crdb-service-account": {
        const roles = listValue(fields["roles"]);
        const sa = await crdb<CServiceAccount>(this.ctx, "POST", "/api/v1/service-accounts", {
          name: required(fields["name"], "a name"),
          description: fields["description"] ?? "",
          roles: roles.map((name) => ({ name, resource: { type: "ORGANIZATION" } })),
        });
        return serviceAccountResource(sa, accountId);
      }
      case "crdb-api-key": {
        const sa = parent || required(fields["serviceAccountId"], "a service account");
        const res = await crdb<{ api_key: CApiKey; secret: string }>(
          this.ctx,
          "POST",
          "/api/v1/api-keys",
          {
            name: required(fields["name"], "a name"),
            service_account_id: sa,
          },
        );
        const r = instance(
          accountId,
          typeId,
          res.api_key.id,
          res.api_key.name,
          { name: res.api_key.name, serviceAccountId: sa, createdAt: res.api_key.created_at },
          { typeId: "crdb-service-account", externalId: sa },
          res.api_key.created_at,
        );
        r.resolvedOutputs["secret"] = res.secret;
        return r;
      }
      default:
        throw new Error(`CockroachDB Cloud plugin: cannot create "${typeId}".`);
    }
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const externalId = externalIdOf(resourceId);
    const [first, rest] = split(externalId);
    switch (typeId) {
      case "crdb-folder":
        if (fields["name"])
          await crdb(this.ctx, "PATCH", `/api/v1/folders/${enc(externalId)}`, {
            name: fields["name"],
          });
        break;
      case "crdb-cluster":
        await this.updateCluster(externalId, fields);
        break;
      case "crdb-database":
        if (fields["name"] && fields["name"] !== rest) {
          await crdb(this.ctx, "PATCH", `/api/v1/clusters/${enc(first)}/databases/${enc(rest)}`, {
            name: rest,
            new_name: fields["name"],
          });
          return this.getResource(
            typeId,
            `${accountId}:${typeId}:${first}/${fields["name"]}`,
            accountId,
          );
        }
        break;
      case "crdb-sql-user":
        if (fields["password"]) await this.setPassword(resourceId, fields["password"]);
        break;
      case "crdb-allowlist-entry": {
        const [ip, mask] = parseCidr(rest);
        const current = (
          await paged<CAllowlistEntry>(
            this.ctx,
            `/api/v1/clusters/${enc(first)}/networking/allowlist`,
            "allowlist",
          )
        ).find((e) => e.cidr_ip === ip && e.cidr_mask === mask);
        await crdb(
          this.ctx,
          "PATCH",
          `/api/v1/clusters/${enc(first)}/networking/allowlist/${enc(ip)}/${mask}`,
          {
            name: fields["name"] ?? current?.name ?? "",
            sql: bool(fields["sql"]) ?? current?.sql ?? true,
            ui: bool(fields["ui"]) ?? current?.ui ?? false,
          },
        );
        break;
      }
      case "crdb-blackout-window":
        await crdb(
          this.ctx,
          "PATCH",
          `/api/v1/clusters/${enc(first)}/blackout-windows/${enc(rest)}`,
          {
            ...(fields["startTime"] ? { start_time: fields["startTime"] } : {}),
            ...(fields["endTime"] ? { end_time: fields["endTime"] } : {}),
          },
        );
        break;
      case "crdb-egress-rule": {
        const current = await this.getResource(typeId, resourceId, accountId);
        await crdb(
          this.ctx,
          "PATCH",
          `/api/v1/clusters/${enc(first)}/networking/egress-rules/${enc(rest)}`,
          {
            type: String(current.fields["type"] ?? "FQDN"),
            ...(fields["description"] !== undefined ? { description: fields["description"] } : {}),
            ...(fields["ports"] !== undefined
              ? { ports: listValue(fields["ports"]).map(Number).filter(Number.isFinite) }
              : {}),
          },
        );
        break;
      }
      case "crdb-service-account":
        await crdb(this.ctx, "PATCH", `/api/v1/service-accounts/${enc(externalId)}`, {
          ...(fields["name"] ? { name: fields["name"] } : {}),
          ...(fields["description"] !== undefined ? { description: fields["description"] } : {}),
        });
        break;
      case "crdb-api-key":
        if (fields["name"])
          await crdb(this.ctx, "PATCH", `/api/v1/api-keys/${enc(externalId)}`, {
            name: fields["name"],
          });
        break;
      default:
        throw new Error(`CockroachDB Cloud plugin: cannot update "${typeId}".`);
    }
    return this.getResource(typeId, resourceId, accountId);
  }

  private async updateCluster(id: string, fields: Record<string, string>): Promise<void> {
    const base = `/api/v1/clusters/${enc(id)}`;
    const current = await crdb<CCluster>(this.ctx, "GET", base);
    const body: Record<string, unknown> = {};
    const dp = bool(fields["deleteProtection"]);
    if (dp !== undefined) body["delete_protection"] = dp ? "ENABLED" : "DISABLED";

    if (current.config.dedicated) {
      const hardware: Record<string, unknown> = {};
      if (num(fields["vcpus"]) !== undefined)
        hardware["machine_spec"] = { num_virtual_cpus: num(fields["vcpus"]) };
      if (num(fields["storageGib"]) !== undefined)
        hardware["storage_gib"] = num(fields["storageGib"]);
      if (num(fields["diskIops"]) !== undefined) hardware["disk_iops"] = num(fields["diskIops"]);
      const dedicated: Record<string, unknown> = {};
      if (Object.keys(hardware).length) dedicated["hardware"] = hardware;
      if (num(fields["nodeCount"]) !== undefined) {
        dedicated["region_nodes"] = Object.fromEntries(
          current.regions.map((r) => [r.name, num(fields["nodeCount"])]),
        );
      }
      if (Object.keys(dedicated).length) body["dedicated"] = dedicated;
    } else if (current.config.serverless) {
      const limits: Record<string, string> = {};
      if (num(fields["provisionedVcpus"]) !== undefined)
        limits["provisioned_virtual_cpus"] = String(num(fields["provisionedVcpus"]));
      if (num(fields["requestUnitLimit"]) !== undefined)
        limits["request_unit_limit"] = String(num(fields["requestUnitLimit"]));
      if (num(fields["storageMibLimit"]) !== undefined)
        limits["storage_mib_limit"] = String(num(fields["storageMibLimit"]));
      const serverless: Record<string, unknown> = {};
      if (Object.keys(limits).length) serverless["usage_limits"] = limits;
      if (fields["upgradeType"]) serverless["upgrade_type"] = fields["upgradeType"];
      if (Object.keys(serverless).length) body["serverless"] = serverless;
    }
    if (Object.keys(body).length) await crdb(this.ctx, "PATCH", base, body);

    const backup: Record<string, unknown> = {};
    if (bool(fields["backupsEnabled"]) !== undefined)
      backup["enabled"] = bool(fields["backupsEnabled"]);
    if (num(fields["backupFrequencyMinutes"]) !== undefined)
      backup["frequency_minutes"] = num(fields["backupFrequencyMinutes"]);
    if (num(fields["backupRetentionDays"]) !== undefined)
      backup["retention_days"] = num(fields["backupRetentionDays"]);
    if (Object.keys(backup).length) await crdb(this.ctx, "PATCH", `${base}/backups-config`, backup);

    if (fields["deferralPolicy"]) {
      await crdb(this.ctx, "PUT", `${base}/version-deferral`, {
        deferral_policy: fields["deferralPolicy"],
      });
    }

    const offset = num(fields["maintenanceOffsetHours"]);
    const length = num(fields["maintenanceDurationHours"]);
    if (offset !== undefined || length !== undefined) {
      const cur = await settle(
        crdb<{ offset_duration?: string; window_duration?: string }>(
          this.ctx,
          "GET",
          `${base}/maintenance-window`,
        ),
      );
      await crdb(this.ctx, "PUT", `${base}/maintenance-window`, {
        offset_duration: hoursDuration(offset ?? durationHours(cur?.offset_duration) ?? 0),
        window_duration: hoursDuration(length ?? durationHours(cur?.window_duration) ?? 6),
      });
    }
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = externalIdOf(resourceId);
    const [first, rest] = split(externalId);
    const base = `/api/v1/clusters/${enc(first)}`;
    switch (typeId) {
      case "crdb-folder":
        await crdb(this.ctx, "DELETE", `/api/v1/folders/${enc(externalId)}`);
        return;
      case "crdb-cluster":
        await crdb(this.ctx, "DELETE", `/api/v1/clusters/${enc(externalId)}`);
        return;
      case "crdb-database":
        await crdb(this.ctx, "DELETE", `${base}/databases/${enc(rest)}`);
        return;
      case "crdb-sql-user":
        await crdb(this.ctx, "DELETE", `${base}/sql-users/${enc(rest)}`);
        return;
      case "crdb-allowlist-entry": {
        const [ip, mask] = parseCidr(rest);
        await crdb(this.ctx, "DELETE", `${base}/networking/allowlist/${enc(ip)}/${mask}`);
        return;
      }
      case "crdb-log-export":
        await crdb(this.ctx, "DELETE", `/api/v1/clusters/${enc(externalId)}/logexport`);
        return;
      case "crdb-metric-export":
        await crdb(this.ctx, "DELETE", `${base}/metricexport/${enc(rest)}`);
        return;
      case "crdb-blackout-window":
        await crdb(this.ctx, "DELETE", `${base}/blackout-windows/${enc(rest)}`);
        return;
      case "crdb-egress-rule":
        await crdb(this.ctx, "DELETE", `${base}/networking/egress-rules/${enc(rest)}`);
        return;
      case "crdb-service-account":
        await crdb(this.ctx, "DELETE", `/api/v1/service-accounts/${enc(externalId)}`);
        return;
      case "crdb-api-key":
        await crdb(this.ctx, "DELETE", `/api/v1/api-keys/${enc(externalId)}`);
        return;
      default:
        throw new Error(`CockroachDB Cloud plugin: "${typeId}" cannot be deleted.`);
    }
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const externalId = externalIdOf(resourceId);
    if (typeId === "crdb-backup" && actionId === "restore-cluster") {
      const [clusterId, backupId] = split(externalId);
      await crdb(this.ctx, "POST", `/api/v1/clusters/${enc(clusterId)}/restores`, {
        type: "CLUSTER",
        backup_id: backupId,
      });
      return;
    }
    if (typeId === "crdb-cluster") {
      if (actionId === "finalize-upgrade") {
        await crdb(this.ctx, "PATCH", `/api/v1/clusters/${enc(externalId)}`, {
          upgrade_status: "FINALIZED",
        });
        return;
      }
      if (actionId === "rollback-upgrade") {
        await crdb(this.ctx, "PATCH", `/api/v1/clusters/${enc(externalId)}`, {
          upgrade_status: "ROLLBACK_RUNNING",
        });
        return;
      }
      if (actionId === "enable-prometheus") {
        await crdb(this.ctx, "POST", `/api/v1/clusters/${enc(externalId)}/metricexport/prometheus`);
        return;
      }
    }
    throw new CrdbApiError(
      400,
      `CockroachDB Cloud plugin: unknown action "${actionId}" for "${typeId}".`,
    );
  }

  // ---- costs ---------------------------------------------------------------------

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    // The list endpoint already embeds invoice items and line items.
    const invoices = await paged<CInvoice>(this.ctx, "/api/v1/invoices", "invoices", {
      start_time: `${range.fromDate.slice(0, 7)}-01T00:00:00Z`,
    });
    return invoicesToCostRows(invoices, range);
  }
}

// ---- mappers -------------------------------------------------------------------------

export function parseCidr(cidr: string): [string, number] {
  const [ip, mask] = cidr.split("/");
  const m = mask === undefined ? 32 : Number(mask);
  if (!ip || !Number.isInteger(m) || m < 0 || m > 32)
    throw new Error(`CockroachDB Cloud plugin: "${cidr}" is not an IPv4 CIDR.`);
  return [ip, m];
}

/**
 * The Cloud API formats Advanced-cluster strings with `sslrootcert` pointing at
 * a file on the caller's machine, which does not exist anywhere Infrawrench
 * connects from. Drop it and keep TLS required.
 */
export function portable(connectionString: string): string {
  if (!/[?&]sslrootcert=/.test(connectionString)) return connectionString;
  return connectionString
    .replace(/([?&])sslrootcert=[^&]*&?/, "$1")
    .replace(/sslmode=verify-full/, "sslmode=require")
    .replace(/[?&]$/, "");
}

/** Put a password into the Cloud API's credential-less connection string. */
export function withPassword(template: string, user: string, password: string): string {
  const pw = encodeURIComponent(password);
  const u = encodeURIComponent(user);
  if (template.includes(`${u}@`) || template.includes(`${user}@`)) {
    return template.replace(
      new RegExp(`://${u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(:[^@]*)?@`),
      `://${u}:${pw}@`,
    );
  }
  return template.replace("://", `://${u}:${pw}@`);
}

export function folderResource(fo: CFolder, accountId: string): ResourceInstance {
  return instance(accountId, "crdb-folder", fo.resource_id, fo.name, {
    name: fo.name,
    parentId: fo.parent_id,
    path: [...(fo.path ?? []).map((p) => p.name ?? ""), fo.name].filter(Boolean).join(" / "),
  });
}

export function allowlistResource(
  clusterId: string,
  e: CAllowlistEntry,
  accountId: string,
): ResourceInstance {
  const cidr = `${e.cidr_ip}/${e.cidr_mask}`;
  return instance(
    accountId,
    "crdb-allowlist-entry",
    `${clusterId}/${cidr}`,
    e.name ? `${e.name} (${cidr})` : cidr,
    { cidr, clusterId, name: e.name ?? "", sql: e.sql, ui: e.ui },
    { typeId: "crdb-cluster", externalId: clusterId },
  );
}

export function serviceAccountResource(sa: CServiceAccount, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "crdb-service-account",
    sa.id,
    sa.name,
    {
      name: sa.name,
      description: sa.description,
      roles: sa.roles
        .map(
          (r) =>
            `${r.name}${r.resource.type !== "ORGANIZATION" ? ` (${r.resource.type.toLowerCase()})` : ""}`,
        )
        .join(", "),
      orgAdmin: sa.roles.some(
        (r) =>
          r.name === "ORG_ADMIN" ||
          (r.name === "CLUSTER_ADMIN" && r.resource.type === "ORGANIZATION"),
      ),
      creator: sa.creator_name,
      createdAt: sa.created_at,
    },
    undefined,
    sa.created_at,
  );
}

function restoreResource(
  clusterId: string,
  r: Record<string, unknown>,
  accountId: string,
): ResourceInstance {
  const s = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : "");
  const objects = Array.isArray(r["objects"])
    ? (r["objects"] as Array<{ database?: string; schema?: string; table?: string }>)
        .map((o) => [o.database, o.schema, o.table].filter(Boolean).join("."))
        .join(", ")
    : "";
  return instance(
    accountId,
    "crdb-restore",
    `${clusterId}/${s("id")}`,
    `${s("type")} restore ${s("created_at").slice(0, 10)}`,
    {
      clusterId,
      type: s("type"),
      status: s("status"),
      progressPercent:
        typeof r["completion_percent"] === "number"
          ? Math.round((r["completion_percent"] as number) * 100)
          : undefined,
      backupId: s("backup_id"),
      backupEndTime: s("backup_end_time"),
      sourceCluster: s("source_cluster_name"),
      objects,
      error: s("client_error_message"),
      createdAt: s("created_at"),
      completedAt: s("completed_at"),
    },
    { typeId: "crdb-cluster", externalId: clusterId },
    s("created_at"),
  );
}

export interface ClusterExtras {
  backups?: CBackupConfig | undefined;
  deferral?: { deferral_policy?: string } | undefined;
  window?: { offset_duration?: string; window_duration?: string } | undefined;
  cmek?: { status?: string } | undefined;
  allowlist?: CAllowlistEntry[] | undefined;
}

export function clusterResource(
  c: CCluster,
  accountId: string,
  x: ClusterExtras,
): ResourceInstance {
  const hw = c.config.dedicated ?? c.config.host;
  const limits = c.config.serverless?.usage_limits;
  const n = (v: string | undefined) => (v !== undefined && v !== "" ? Number(v) : undefined);
  return instance(
    accountId,
    "crdb-cluster",
    c.id,
    c.name,
    {
      name: c.name,
      plan: c.plan ?? c.edition ?? "",
      cloudProvider: c.cloud_provider,
      region: c.regions[0]?.name ?? "",
      regions: c.regions.map((r) => r.name).join(", "),
      version: c.cockroach_version,
      state: c.state,
      operationStatus: c.operation_status,
      upgradeStatus: c.upgrade_status,
      sqlDns: c.sql_dns || c.regions[0]?.sql_dns || "",
      networkVisibility: c.network_visibility ?? "",
      egressPolicy: c.egress_traffic_policy ?? "",
      folderId: c.parent_id && c.parent_id !== "root" ? c.parent_id : "",
      deleteProtection: c.delete_protection ? c.delete_protection === "ENABLED" : undefined,
      nodeCount: hw ? c.regions[0]?.node_count : undefined,
      vcpus: hw?.num_virtual_cpus,
      machineType: hw?.machine_type,
      memoryGib: hw?.memory_gib,
      storageGib: hw?.storage_gib,
      diskIops: hw?.disk_iops,
      provisionedVcpus: n(limits?.provisioned_virtual_cpus),
      requestUnitLimit: n(limits?.request_unit_limit),
      storageMibLimit: n(limits?.storage_mib_limit),
      upgradeType: c.config.serverless?.upgrade_type,
      backupsEnabled: x.backups?.enabled,
      backupFrequencyMinutes: x.backups ? String(x.backups.frequency_minutes) : undefined,
      backupRetentionDays: x.backups ? String(x.backups.retention_days) : undefined,
      deferralPolicy: x.deferral?.deferral_policy,
      maintenanceOffsetHours: durationHours(x.window?.offset_duration),
      maintenanceDurationHours: durationHours(x.window?.window_duration),
      cmekStatus: x.cmek?.status,
      allowlistOpen: x.allowlist ? x.allowlist.some((e) => e.cidr_mask === 0 && e.sql) : undefined,
      createdAt: c.created_at,
    },
    undefined,
    c.created_at,
  );
}

/** Create-form fields → `POST /api/v1/clusters` body for Basic, Standard or Advanced. */
export function clusterCreateBody(fields: Record<string, string>): Record<string, unknown> {
  const plan = fields["plan"] || "BASIC";
  const regions = listValue(fields["regions"]);
  if (regions.length === 0) throw new Error("CockroachDB Cloud plugin: pick at least one region.");
  const spec: Record<string, unknown> = {
    plan,
    ...(fields["folderId"] ? { parent_id: fields["folderId"] } : {}),
    ...(bool(fields["deleteProtection"]) !== undefined
      ? { delete_protection: bool(fields["deleteProtection"]) ? "ENABLED" : "DISABLED" }
      : {}),
  };
  if (plan === "ADVANCED") {
    spec["dedicated"] = {
      region_nodes: Object.fromEntries(regions.map((r) => [r, num(fields["nodeCount"]) ?? 3])),
      hardware: {
        machine_spec: { num_virtual_cpus: num(fields["vcpus"]) ?? 4 },
        storage_gib: num(fields["storageGib"]) ?? 0,
      },
      ...(fields["version"] ? { cockroach_version: fields["version"] } : {}),
    };
  } else {
    const limits: Record<string, string> = {};
    if (plan === "STANDARD" && num(fields["provisionedVcpus"]) !== undefined) {
      limits["provisioned_virtual_cpus"] = String(num(fields["provisionedVcpus"]));
    }
    spec["serverless"] = {
      regions,
      ...(regions.length > 1 ? { primary_region: regions[0] } : {}),
      ...(Object.keys(limits).length ? { usage_limits: limits } : {}),
      ...(fields["closedAllowlist"] === "true" ? { with_empty_ip_allowlist: true } : {}),
    };
  }
  return {
    name: required(fields["name"], "a cluster name"),
    provider: fields["provider"] || "AWS",
    spec,
  };
}
