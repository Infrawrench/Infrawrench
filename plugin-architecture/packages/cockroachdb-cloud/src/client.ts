import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
import type {
  ApiBody,
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
import { externalIdOf, pathEncode } from "@infrawrench/plugin-base";
import type { components, operations } from "./api-types.gen.js";
import type {
  CAllowlistEntry,
  CBackupConfig,
  CCluster,
  CFolder,
  CrdbApi,
  CRestore,
  CServiceAccount,
} from "./api.js";
import { createCrdbApi, CrdbApiError, statusOf } from "./api.js";
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
      const parsed: unknown = JSON.parse(t);
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
  readonly api: CrdbApi;
  private readonly services: HostServices | undefined;

  constructor(credentials: Credentials, services?: HostServices) {
    const token = (credentials["apiKey"] ?? "").trim();
    if (!token) throw new Error("CockroachDB Cloud plugin: missing apiKey credential");
    const caCert = credentials["caCert"] ?? "";
    this.api = createCrdbApi({
      token,
      ...(services?.http ? { http: services.http } : {}),
      ...(caCert ? { caCert } : {}),
    });
    this.services = services;
  }

  verifyCredentials(): PluginEffect<PreflightResult> {
    return attempt(async () => {
      return verifyCockroachCredentials(this);
    });
  }

  clusters(): Promise<CCluster[]> {
    return this.api.getAll("/api/v1/clusters", "clusters");
  }

  folders(): Promise<CFolder[]> {
    return this.api.getAll("/api/v1/folders", "folders");
  }

  serviceAccounts(): Promise<CServiceAccount[]> {
    return this.api.getAll("/api/v1/service-accounts", "service_accounts");
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

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      return this.list(typeId, accountId);
    });
  }

  private async list(
    typeId: string,
    accountId: string,
    only?: CCluster[],
  ): Promise<ResourceInstance[]> {
    const id = (c: CCluster) => pathEncode(c.id);
    const child = (c: CCluster) => ({ typeId: "crdb-cluster", externalId: c.id });
    switch (typeId) {
      case "crdb-organization": {
        const org = await this.api.get("/api/v1/organization");
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
            (await this.api.getAll(`/api/v1/clusters/${id(c)}/databases`, "databases")).map((d) =>
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
            (await this.api.getAll(`/api/v1/clusters/${id(c)}/sql-users`, "users")).map((u) =>
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
              await this.api.getAll(`/api/v1/clusters/${id(c)}/networking/allowlist`, "allowlist")
            ).map((e) => allowlistResource(c.id, e, accountId)),
          only,
        );
      case "crdb-backup":
        return this.perCluster(
          async (c) =>
            (await this.api.getAll(`/api/v1/clusters/${id(c)}/backups`, "backups")).map((b) =>
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
            (await this.api.getAll(`/api/v1/clusters/${id(c)}/restores`, "restores")).map((r) =>
              restoreResource(c.id, r, accountId),
            ),
          only,
          [400, 403, 404],
        );
      case "crdb-log-export":
        return this.perCluster(
          async (c) => {
            const le = await this.api.get(`/api/v1/clusters/${id(c)}/logexport`);
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
          const [datadog, cloudwatch, prometheus] = await Promise.all([
            settle(this.api.get(`/api/v1/clusters/${id(c)}/metricexport/datadog`)),
            settle(this.api.get(`/api/v1/clusters/${id(c)}/metricexport/cloudwatch`)),
            settle(this.api.get(`/api/v1/clusters/${id(c)}/metricexport/prometheus`)),
          ]);
          const results = [
            metricExportResource(
              c,
              "datadog",
              datadog,
              (res) => `Datadog ${String(res.site ?? "")}`,
              accountId,
            ),
            metricExportResource(
              c,
              "cloudwatch",
              cloudwatch,
              (res) => String(res.role_arn ?? ""),
              accountId,
            ),
            metricExportResource(
              c,
              "prometheus",
              prometheus,
              (res) =>
                Object.entries(res.targets ?? {})
                  .map(([region, url]) => `${region}: ${url}`)
                  .join(", "),
              accountId,
            ),
          ];
          return results.filter((r): r is ResourceInstance => r !== null);
        }, only);
      case "crdb-blackout-window":
        return this.perCluster(
          async (c) => {
            if (c.plan && c.plan !== "ADVANCED") return [];
            const res = await this.api.get(`/api/v1/clusters/${id(c)}/blackout-windows`);
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
            const res = await this.api.get(`/api/v1/clusters/${id(c)}/networking/egress-rules`);
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
          this.api.getAll("/api/v1/api-keys", "api_keys"),
          this.serviceAccounts().catch((): CServiceAccount[] => []),
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
    const id = pathEncode(c.id);
    const advanced = c.plan === "ADVANCED" || !!c.config.dedicated;
    const [backups, deferral, window, cmek, allowlist] = await Promise.all([
      settle(this.api.get(`/api/v1/clusters/${id}/backups-config`)),
      settle(this.api.get(`/api/v1/clusters/${id}/version-deferral`)),
      advanced ? settle(this.api.get(`/api/v1/clusters/${id}/maintenance-window`)) : undefined,
      advanced ? settle(this.api.get(`/api/v1/clusters/${id}/cmek`)) : undefined,
      c.config.host
        ? undefined
        : settle(this.api.getAll(`/api/v1/clusters/${id}/networking/allowlist`, "allowlist")),
    ]);
    return clusterResource(c, accountId, { backups, deferral, window, cmek, allowlist });
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const externalId = externalIdOf(resourceId);
      const clusterScoped =
        typeId.startsWith("crdb-") &&
        !["crdb-organization", "crdb-folder", "crdb-service-account", "crdb-api-key"].includes(
          typeId,
        );
      let all: ResourceInstance[];
      if (clusterScoped) {
        const [clusterId] = split(externalId);
        const c = await this.api.get(`/api/v1/clusters/${pathEncode(clusterId)}`);
        all = await this.list(typeId, accountId, [c]);
      } else {
        all = await this.list(typeId, accountId);
      }
      const found = all.find((r) => r.id === resourceId);
      if (!found)
        throw new CrdbApiError(404, `CockroachDB Cloud plugin: ${typeId}/${externalId} not found`);
      return found;
    });
  }

  // ---- outputs -------------------------------------------------------------------

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    _accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      const externalId = externalIdOf(resourceId);
      const [first, rest] = split(externalId);
      switch (`${typeId}.${outputKey}`) {
        case "crdb-organization.organizationId":
        case "crdb-folder.folderId":
        case "crdb-cluster.clusterId":
        case "crdb-service-account.serviceAccountId":
          return externalId;
        case "crdb-cluster.sqlHost": {
          const c = await this.api.get(`/api/v1/clusters/${pathEncode(externalId)}`);
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
    });
  }

  private async connectionString(clusterId: string, sqlUser?: string): Promise<string> {
    const res = await this.api.get(`/api/v1/clusters/${pathEncode(clusterId)}/connection-string`, {
      query: { ...(sqlUser ? { sql_user: sqlUser } : {}), os: "LINUX" },
    });
    return res.connection_string;
  }

  rerollOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    _accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      if (typeId === "crdb-sql-user" && outputKey === "connectionString") {
        await this.setPassword(resourceId);
        return;
      }
      throw new Error(`CockroachDB Cloud plugin: "${outputKey}" cannot be reissued.`);
    });
  }

  applySecretReroll(
    typeId: string,
    resourceId: string,
    _accountId: string,
    fieldKey: string,
    plaintext: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      if (typeId === "crdb-sql-user" && fieldKey === PASSWORD_FIELD)
        await this.setPassword(resourceId, plaintext);
    });
  }

  private async setPassword(resourceId: string, chosen?: string): Promise<void> {
    const [clusterId, user] = split(externalIdOf(resourceId));
    const password = chosen || randomPassword();
    await this.api.put(
      `/api/v1/clusters/${pathEncode(clusterId)}/sql-users/${pathEncode(user)}/password`,
      { body: { password } },
    );
    if (!this.services?.secrets?.setPlaintext) {
      throw new Error(
        `The password was changed but this host cannot store it. The new password is: ${password}`,
      );
    }
    await this.services.secrets.setPlaintext(resourceId, PASSWORD_FIELD, password);
  }

  executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): PluginEffect<unknown> {
    return attempt(async () => {
      let values: Record<string, string> = {};
      try {
        values = JSON.parse(String(args[0] ?? "{}"));
      } catch {
        values = {};
      }
      if (typeId === "crdb-sql-user" && command === "reset-password") {
        await this.setPassword(resourceId, values["password"]);
        return { ok: true };
      }
      if (typeId === "crdb-cluster" && command === "move-to-folder") {
        await this.api.patch(`/api/v1/clusters/${pathEncode(externalIdOf(resourceId))}`, {
          body: { parent_id: values["folderId"] || "root" },
        });
        return { ok: true };
      }
      if (typeId === "crdb-cluster" && command === "upgrade") {
        await this.api.patch(`/api/v1/clusters/${pathEncode(externalIdOf(resourceId))}`, {
          body: { cockroach_version: required(values["version"], "a version") },
        });
        return { ok: true };
      }
      throw new Error(`CockroachDB Cloud plugin: unknown command "${command}".`);
    });
  }

  // ---- detail views ----------------------------------------------------------------

  enrichDetail(resource: ResourceInstance): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const fields = { ...resource.fields };
      if (resource.resourceTypeId === "crdb-cluster") {
        const id = String(resource.externalId ?? "");
        const [nodes, versions, folders] = await Promise.all([
          settle(this.api.getAll(`/api/v1/clusters/${pathEncode(id)}/nodes`, "nodes")),
          settle(this.api.getAll("/api/v1/cluster-versions", "versions")),
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
        const invoices = await settle(this.api.getAll("/api/v1/invoices", "invoices"));
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
      if (typeId !== "crdb-cluster") return [];
      const r = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      return [
        { label: "Plan", value: String(r.fields["plan"] ?? "") },
        { label: "Region", value: String(r.fields["region"] ?? "") },
        { label: "Version", value: String(r.fields["version"] ?? "") },
      ];
    });
  }

  // ---- create / update / delete ----------------------------------------------------

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
      const parent = parentResourceId ? externalIdOf(parentResourceId) : "";
      const clusterId = () => required(parent || fields["clusterId"], "a cluster");
      const cluster = () => pathEncode(clusterId());
      switch (typeId) {
        case "crdb-folder": {
          const fo = await this.api.post("/api/v1/folders", {
            body: {
              name: required(fields["name"], "a name"),
              parent_id: fields["parentId"] || "root",
            },
          });
          return folderResource(fo, accountId);
        }
        case "crdb-cluster": {
          const c = await this.api.post("/api/v1/clusters", { body: clusterCreateBody(fields) });
          return clusterResource(c, accountId, {});
        }
        case "crdb-database": {
          const name = required(fields["name"], "a name");
          await this.api.post(`/api/v1/clusters/${cluster()}/databases`, { body: { name } });
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
          await this.api.post(`/api/v1/clusters/${cluster()}/sql-users`, {
            body: { name, password },
          });
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
          const e = await this.api.post(`/api/v1/clusters/${cluster()}/networking/allowlist`, {
            body: {
              cidr_ip: ip,
              cidr_mask: mask,
              ...(fields["name"] ? { name: fields["name"] } : {}),
              sql: fields["sql"] !== "false",
              ui: fields["ui"] === "true",
            },
          });
          return allowlistResource(clusterId(), e, accountId);
        }
        case "crdb-log-export": {
          const type = required(fields["type"], "a destination");
          await this.api.post(`/api/v1/clusters/${cluster()}/logexport`, {
            body: {
              type,
              log_name: required(fields["logName"], "a log name"),
              ...(fields["authPrincipal"] ? { auth_principal: fields["authPrincipal"] } : {}),
              ...(fields["otlpEndpoint"] ? { otlp_endpoint: fields["otlpEndpoint"] } : {}),
              ...(fields["otlpAuthorization"]
                ? { otlp_headers: { authorization: fields["otlpAuthorization"] } }
                : {}),
              ...(fields["region"] ? { region: fields["region"] } : {}),
              ...(bool(fields["redact"]) !== undefined ? { redact: bool(fields["redact"]) } : {}),
            },
          });
          return runPluginEffect(
            this.getResource(typeId, `${accountId}:${typeId}:${clusterId()}`, accountId),
          ).catch(() =>
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
          await this.api.post(`/api/v1/clusters/${cluster()}/metricexport/${pathEncode(kind)}`, {
            body,
          });
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
          const w = await this.api.post(`/api/v1/clusters/${cluster()}/blackout-windows`, {
            body: {
              start_time: required(fields["startTime"], "a start time"),
              end_time: required(fields["endTime"], "an end time"),
            },
          });
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
          const res = await this.api.post(`/api/v1/clusters/${cluster()}/networking/egress-rules`, {
            body: {
              name: required(fields["name"], "a name"),
              type: fields["type"] === "CIDR" ? "CIDR" : "FQDN",
              destination: required(fields["destination"], "a destination"),
              description: fields["description"] ?? "",
              ...(ports.length ? { ports } : {}),
            },
          });
          const id = res?.Rule?.id ?? "";
          return runPluginEffect(
            this.getResource(typeId, `${accountId}:${typeId}:${clusterId()}/${id}`, accountId),
          );
        }
        case "crdb-service-account": {
          const roles = listValue(fields["roles"]);
          const sa = await this.api.post("/api/v1/service-accounts", {
            body: {
              name: required(fields["name"], "a name"),
              description: fields["description"] ?? "",
              roles: roles.map((name) => ({ name, resource: { type: "ORGANIZATION" } })),
            },
          });
          return serviceAccountResource(sa, accountId);
        }
        case "crdb-api-key": {
          const sa = parent || required(fields["serviceAccountId"], "a service account");
          const res = await this.api.post("/api/v1/api-keys", {
            body: {
              name: required(fields["name"], "a name"),
              service_account_id: sa,
            },
          });
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
    });
  }

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const externalId = externalIdOf(resourceId);
      const [first, rest] = split(externalId);
      switch (typeId) {
        case "crdb-folder":
          if (fields["name"])
            await this.api.patch(`/api/v1/folders/${pathEncode(externalId)}`, {
              body: { name: fields["name"] },
            });
          break;
        case "crdb-cluster":
          await this.updateCluster(externalId, fields);
          break;
        case "crdb-database":
          if (fields["name"] && fields["name"] !== rest) {
            await this.api.patch(
              `/api/v1/clusters/${pathEncode(first)}/databases/${pathEncode(rest)}`,
              { body: { name: rest, new_name: fields["name"] } },
            );
            return runPluginEffect(
              this.getResource(
                typeId,
                `${accountId}:${typeId}:${first}/${fields["name"]}`,
                accountId,
              ),
            );
          }
          break;
        case "crdb-sql-user":
          if (fields["password"]) await this.setPassword(resourceId, fields["password"]);
          break;
        case "crdb-allowlist-entry": {
          const [ip, mask] = parseCidr(rest);
          const current = (
            await this.api.getAll(
              `/api/v1/clusters/${pathEncode(first)}/networking/allowlist`,
              "allowlist",
            )
          ).find((e) => e.cidr_ip === ip && e.cidr_mask === mask);
          await this.api.patch(
            `/api/v1/clusters/${pathEncode(first)}/networking/allowlist/${pathEncode(ip)}/${pathEncode(mask)}`,
            {
              body: {
                name: fields["name"] ?? current?.name ?? "",
                sql: bool(fields["sql"]) ?? current?.sql ?? true,
                ui: bool(fields["ui"]) ?? current?.ui ?? false,
              },
            },
          );
          break;
        }
        case "crdb-blackout-window":
          await this.api.patch(
            `/api/v1/clusters/${pathEncode(first)}/blackout-windows/${pathEncode(rest)}`,
            {
              body: {
                ...(fields["startTime"] ? { start_time: fields["startTime"] } : {}),
                ...(fields["endTime"] ? { end_time: fields["endTime"] } : {}),
              },
            },
          );
          break;
        case "crdb-egress-rule": {
          const current = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
          await this.api.patch(
            `/api/v1/clusters/${pathEncode(first)}/networking/egress-rules/${pathEncode(rest)}`,
            {
              body: {
                type: String(current.fields["type"] ?? "FQDN"),
                ...(fields["description"] !== undefined
                  ? { description: fields["description"] }
                  : {}),
                ...(fields["ports"] !== undefined
                  ? { ports: listValue(fields["ports"]).map(Number).filter(Number.isFinite) }
                  : {}),
              },
            },
          );
          break;
        }
        case "crdb-service-account":
          await this.api.patch(`/api/v1/service-accounts/${pathEncode(externalId)}`, {
            body: {
              ...(fields["name"] ? { name: fields["name"] } : {}),
              ...(fields["description"] !== undefined
                ? { description: fields["description"] }
                : {}),
            },
          });
          break;
        case "crdb-api-key":
          if (fields["name"])
            await this.api.patch(`/api/v1/api-keys/${pathEncode(externalId)}`, {
              body: { name: fields["name"] },
            });
          break;
        default:
          throw new Error(`CockroachDB Cloud plugin: cannot update "${typeId}".`);
      }
      return runPluginEffect(this.getResource(typeId, resourceId, accountId));
    });
  }

  private async updateCluster(clusterId: string, fields: Record<string, string>): Promise<void> {
    const id = pathEncode(clusterId);
    const current = await this.api.get(`/api/v1/clusters/${id}`);
    const dp = bool(fields["deleteProtection"]);
    const body: ApiBody<operations["CockroachCloud_UpdateCluster"]> = {
      ...(dp !== undefined ? { delete_protection: protection(dp) } : {}),
      ...planUpdate(current, fields),
    };
    if (Object.keys(body).length) await this.api.patch(`/api/v1/clusters/${id}`, { body });

    const enabled = bool(fields["backupsEnabled"]);
    const frequency = num(fields["backupFrequencyMinutes"]);
    const retention = num(fields["backupRetentionDays"]);
    const backup: ApiBody<operations["CockroachCloud_UpdateBackupConfiguration"]> = {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(frequency !== undefined ? { frequency_minutes: frequency } : {}),
      ...(retention !== undefined ? { retention_days: retention } : {}),
    };
    if (Object.keys(backup).length) {
      await this.api.patch(`/api/v1/clusters/${id}/backups-config`, { body: backup });
    }

    if (fields["deferralPolicy"]) {
      await this.api.put(`/api/v1/clusters/${id}/version-deferral`, {
        body: { deferral_policy: fields["deferralPolicy"] },
      });
    }

    const offset = num(fields["maintenanceOffsetHours"]);
    const length = num(fields["maintenanceDurationHours"]);
    if (offset !== undefined || length !== undefined) {
      const cur = await settle(this.api.get(`/api/v1/clusters/${id}/maintenance-window`));
      await this.api.put(`/api/v1/clusters/${id}/maintenance-window`, {
        body: {
          offset_duration: hoursDuration(offset ?? durationHours(cur?.offset_duration) ?? 0),
          window_duration: hoursDuration(length ?? durationHours(cur?.window_duration) ?? 6),
        },
      });
    }
  }

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const externalId = externalIdOf(resourceId);
      const [first, rest] = split(externalId);
      const id = pathEncode(first);
      const item = pathEncode(rest);
      switch (typeId) {
        case "crdb-folder":
          await this.api.delete(`/api/v1/folders/${pathEncode(externalId)}`);
          return;
        case "crdb-cluster":
          await this.api.delete(`/api/v1/clusters/${pathEncode(externalId)}`);
          return;
        case "crdb-database":
          await this.api.delete(`/api/v1/clusters/${id}/databases/${item}`);
          return;
        case "crdb-sql-user":
          await this.api.delete(`/api/v1/clusters/${id}/sql-users/${item}`);
          return;
        case "crdb-allowlist-entry": {
          const [ip, mask] = parseCidr(rest);
          await this.api.delete(
            `/api/v1/clusters/${id}/networking/allowlist/${pathEncode(ip)}/${pathEncode(mask)}`,
          );
          return;
        }
        case "crdb-log-export":
          await this.api.delete(`/api/v1/clusters/${pathEncode(externalId)}/logexport`);
          return;
        case "crdb-metric-export":
          await this.api.delete(`/api/v1/clusters/${id}/metricexport/${item}`);
          return;
        case "crdb-blackout-window":
          await this.api.delete(`/api/v1/clusters/${id}/blackout-windows/${item}`);
          return;
        case "crdb-egress-rule":
          await this.api.delete(`/api/v1/clusters/${id}/networking/egress-rules/${item}`);
          return;
        case "crdb-service-account":
          await this.api.delete(`/api/v1/service-accounts/${pathEncode(externalId)}`);
          return;
        case "crdb-api-key":
          await this.api.delete(`/api/v1/api-keys/${pathEncode(externalId)}`);
          return;
        default:
          throw new Error(`CockroachDB Cloud plugin: "${typeId}" cannot be deleted.`);
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
      const externalId = externalIdOf(resourceId);
      if (typeId === "crdb-backup" && actionId === "restore-cluster") {
        const [clusterId, backupId] = split(externalId);
        await this.api.post(`/api/v1/clusters/${pathEncode(clusterId)}/restores`, {
          body: { type: "CLUSTER", backup_id: backupId },
        });
        return;
      }
      if (typeId === "crdb-cluster") {
        if (actionId === "finalize-upgrade") {
          await this.api.patch(`/api/v1/clusters/${pathEncode(externalId)}`, {
            body: { upgrade_status: "FINALIZED" },
          });
          return;
        }
        if (actionId === "rollback-upgrade") {
          await this.api.patch(`/api/v1/clusters/${pathEncode(externalId)}`, {
            body: { upgrade_status: "ROLLBACK_RUNNING" },
          });
          return;
        }
        if (actionId === "enable-prometheus") {
          await this.api.post(`/api/v1/clusters/${pathEncode(externalId)}/metricexport/prometheus`);
          return;
        }
      }
      throw new CrdbApiError(
        400,
        `CockroachDB Cloud plugin: unknown action "${actionId}" for "${typeId}".`,
      );
    });
  }

  // ---- costs ---------------------------------------------------------------------

  fetchCostData(_accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      // The list endpoint already embeds invoice items and line items.
      const invoices = await this.api.getAll("/api/v1/invoices", "invoices", {
        query: { start_time: `${range.fromDate.slice(0, 7)}-01T00:00:00Z` },
      });
      return invoicesToCostRows(invoices, range);
    });
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

function metricExportResource<Res extends { status?: string; user_message?: string }>(
  c: CCluster,
  kind: string,
  res: Res | undefined,
  target: (res: Res) => string,
  accountId: string,
): ResourceInstance | null {
  const status = typeof res?.status === "string" ? res.status : "";
  if (!res || !status || status === "NOT_DEPLOYED") return null;
  return instance(
    accountId,
    "crdb-metric-export",
    `${c.id}/${kind}`,
    `${c.name} metrics → ${kind}`,
    {
      kind,
      clusterId: c.id,
      status,
      message: String(res.user_message ?? ""),
      target: target(res),
    },
    { typeId: "crdb-cluster", externalId: c.id },
  );
}

function restoreResource(clusterId: string, r: CRestore, accountId: string): ResourceInstance {
  const s = (v: string | undefined) => (typeof v === "string" ? v : "");
  const objects = Array.isArray(r.objects)
    ? r.objects.map((o) => [o.database, o.schema, o.table].filter(Boolean).join(".")).join(", ")
    : "";
  return instance(
    accountId,
    "crdb-restore",
    `${clusterId}/${s(r.id)}`,
    `${s(r.type)} restore ${s(r.created_at).slice(0, 10)}`,
    {
      clusterId,
      type: s(r.type),
      status: s(r.status),
      progressPercent:
        typeof r.completion_percent === "number"
          ? Math.round(r.completion_percent * 100)
          : undefined,
      backupId: s(r.backup_id),
      backupEndTime: s(r.backup_end_time),
      sourceCluster: s(r.source_cluster_name),
      objects,
      error: s(r.client_error_message),
      createdAt: s(r.created_at),
      completedAt: s(r.completed_at),
    },
    { typeId: "crdb-cluster", externalId: clusterId },
    s(r.created_at),
  );
}

export interface ClusterExtras {
  backups?: CBackupConfig | undefined;
  deferral?: components["schemas"]["ClusterVersionDeferral"] | undefined;
  window?: components["schemas"]["MaintenanceWindow"] | undefined;
  cmek?: components["schemas"]["CMEKClusterInfo"] | undefined;
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

function protection(on: boolean): "ENABLED" | "DISABLED" {
  return on ? "ENABLED" : "DISABLED";
}

/** Edit-form fields → the part of `PATCH /api/v1/clusters/{id}` specific to the cluster's plan. */
function planUpdate(
  current: CCluster,
  fields: Record<string, string>,
): ApiBody<operations["CockroachCloud_UpdateCluster"]> {
  if (current.config.dedicated) {
    const vcpus = num(fields["vcpus"]);
    const storage = num(fields["storageGib"]);
    const iops = num(fields["diskIops"]);
    const nodes = num(fields["nodeCount"]);
    const hardware = {
      ...(vcpus !== undefined ? { machine_spec: { num_virtual_cpus: vcpus } } : {}),
      ...(storage !== undefined ? { storage_gib: storage } : {}),
      ...(iops !== undefined ? { disk_iops: iops } : {}),
    };
    const dedicated = {
      ...(Object.keys(hardware).length ? { hardware } : {}),
      ...(nodes !== undefined
        ? {
            region_nodes: Object.fromEntries(
              current.regions.map((r): [string, number] => [r.name, nodes]),
            ),
          }
        : {}),
    };
    return Object.keys(dedicated).length ? { dedicated } : {};
  }
  if (current.config.serverless) {
    const provisioned = num(fields["provisionedVcpus"]);
    const requestUnits = num(fields["requestUnitLimit"]);
    const storage = num(fields["storageMibLimit"]);
    const limits = {
      ...(provisioned !== undefined ? { provisioned_virtual_cpus: String(provisioned) } : {}),
      ...(requestUnits !== undefined ? { request_unit_limit: String(requestUnits) } : {}),
      ...(storage !== undefined ? { storage_mib_limit: String(storage) } : {}),
    };
    const serverless = {
      ...(Object.keys(limits).length ? { usage_limits: limits } : {}),
      ...(fields["upgradeType"] ? { upgrade_type: fields["upgradeType"] } : {}),
    };
    return Object.keys(serverless).length ? { serverless } : {};
  }
  return {};
}

/** Create-form fields → `POST /api/v1/clusters` body for Basic, Standard or Advanced. */
export function clusterCreateBody(
  fields: Record<string, string>,
): ApiBody<operations["CockroachCloud_CreateCluster"]> {
  const plan = fields["plan"] || "BASIC";
  const regions = listValue(fields["regions"]);
  if (regions.length === 0) throw new Error("CockroachDB Cloud plugin: pick at least one region.");
  const deleteProtection = bool(fields["deleteProtection"]);
  const common = {
    plan,
    ...(fields["folderId"] ? { parent_id: fields["folderId"] } : {}),
    ...(deleteProtection !== undefined ? { delete_protection: protection(deleteProtection) } : {}),
  };
  const spec: components["schemas"]["CreateClusterSpecification"] =
    plan === "ADVANCED"
      ? { ...common, dedicated: dedicatedSpec(fields, regions) }
      : { ...common, serverless: serverlessSpec(fields, regions, plan) };
  return {
    name: required(fields["name"], "a cluster name"),
    provider: fields["provider"] || "AWS",
    spec,
  };
}

function dedicatedSpec(
  fields: Record<string, string>,
  regions: string[],
): components["schemas"]["DedicatedClusterCreateSpecification"] {
  const nodes = num(fields["nodeCount"]) ?? 3;
  return {
    region_nodes: Object.fromEntries(regions.map((r): [string, number] => [r, nodes])),
    hardware: {
      machine_spec: { num_virtual_cpus: num(fields["vcpus"]) ?? 4 },
      storage_gib: num(fields["storageGib"]) ?? 0,
    },
    ...(fields["version"] ? { cockroach_version: fields["version"] } : {}),
  };
}

function serverlessSpec(
  fields: Record<string, string>,
  regions: string[],
  plan: string,
): components["schemas"]["ServerlessClusterCreateSpecification"] {
  const provisioned = plan === "STANDARD" ? num(fields["provisionedVcpus"]) : undefined;
  const [primary] = regions;
  return {
    regions,
    ...(regions.length > 1 && primary !== undefined ? { primary_region: primary } : {}),
    ...(provisioned !== undefined
      ? { usage_limits: { provisioned_virtual_cpus: String(provisioned) } }
      : {}),
    ...(fields["closedAllowlist"] === "true" ? { with_empty_ip_allowlist: true } : {}),
  };
}
