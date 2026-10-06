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
  SidebarItemSchema,
  SqlTableMeta,
  StorageObject,
} from "@infrawrench/plugin-base";
import { buildMultipartBody, externalIdOf, QuotaAccessError } from "@infrawrench/plugin-base";
import type { SupabaseContext } from "./api.js";
import { enc, projectUrl, sbFetch, sbFetchRaw, statusOf, SupabaseApiError } from "./api.js";
import { fetchSupabaseCostData } from "./cost-data.js";
import { getCreateConfig, targetProjectRef } from "./create-config.js";
import {
  fetchOrgProjectIndex,
  fetchProject,
  fetchProjects,
  listApiKeys,
  listAuth,
  listBackups,
  listBranches,
  listBuckets,
  listFunctions,
  listOrganizations,
  listProjects,
  listReadReplicas,
  listSecrets,
  listSigningKeys,
  listSsoProviders,
  listThirdPartyAuth,
  primaryPooler,
  toProjectResource,
} from "./listers.js";
import {
  splitList,
  splitScoped,
  toApiKey,
  toBranch,
  toFunction,
  toSigningKey,
  toSsoProvider,
} from "./mappers.js";
import {
  fetchDiskQuotas,
  fetchFunctionLogs,
  fetchFunctionMetrics,
  fetchProjectLogs,
  fetchProjectMetrics,
} from "./observability.js";
import { verifySupabaseCredentials } from "./preflight.js";
import { ENRICH, renderDetail, renderSidebarItem } from "./render.js";
import {
  AUTH_SETTINGS,
  authChangesBody,
  descriptors,
  groupProjectChanges,
  PROJECT_SECTIONS,
} from "./settings.js";
import {
  createBucket,
  deleteBucket,
  deleteObject,
  emptyBucket,
  listObjects,
  parseBucketHandle,
  updateBucket,
  uploadObject,
} from "./storage.js";
import type {
  SbAddons,
  SbApiKey,
  SbBranch,
  SbBranchConfig,
  SbFunction,
  SbMember,
  SbPooler,
  SbProject,
  SbSigningKey,
  SbSsoProvider,
  SbUpgradeEligibility,
} from "./types.js";

/** Secret-state key the project's postgres password is stored under. */
export const DB_PASSWORD_FIELD = "dbPassword";

/** The placeholder Supabase writes into pooler connection strings. */
const PASSWORD_PLACEHOLDER = "[YOUR-PASSWORD]";

function bool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return value === "true";
}

function randomPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** The postgres-protocol percent encoding a password needs inside a URI. */
function uriPassword(password: string): string {
  return encodeURIComponent(password);
}

export class SupabaseClient implements PluginClient {
  private readonly ctx: SupabaseContext;
  private readonly services: HostServices | undefined;
  private readonly secretKeys = new Map<string, Promise<string>>();

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const token = (credentials["accessToken"] ?? "").trim();
    if (!token) throw new Error("Supabase plugin: missing accessToken credential");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      token,
      ...(services?.http ? { http: services.http } : {}),
      ...(caCert ? { caCert } : {}),
    };
    this.services = services;
  }

  verifyCredentials(): Promise<PreflightResult> {
    return verifySupabaseCredentials(this.ctx);
  }

  // ---- listing ---------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    if (typeId === "supabase-organization") return listOrganizations(this.ctx, accountId);
    return this.listFor(typeId, accountId, await fetchProjects(this.ctx));
  }

  private listFor(
    typeId: string,
    accountId: string,
    projects: SbProject[],
  ): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "supabase-project":
        return listProjects(this.ctx, accountId, projects);
      case "supabase-branch":
        return listBranches(this.ctx, accountId, projects);
      case "supabase-function":
        return listFunctions(this.ctx, accountId, projects);
      case "supabase-secret":
        return listSecrets(this.ctx, accountId, projects);
      case "supabase-api-key":
        return listApiKeys(this.ctx, accountId, projects);
      case "supabase-bucket":
        return listBuckets(this.ctx, accountId, projects, (ref) => this.secretKey(ref));
      case "supabase-backup":
        return listBackups(this.ctx, accountId, projects);
      case "supabase-read-replica":
        return listReadReplicas(this.ctx, accountId, projects);
      case "supabase-auth":
        return listAuth(this.ctx, accountId, projects);
      case "supabase-sso-provider":
        return listSsoProviders(this.ctx, accountId, projects);
      case "supabase-third-party-auth":
        return listThirdPartyAuth(this.ctx, accountId, projects);
      case "supabase-signing-key":
        return listSigningKeys(this.ctx, accountId, projects);
      default:
        throw new Error(`Supabase plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const externalId = externalIdOf(resourceId);
    let found: ResourceInstance | undefined;
    if (typeId === "supabase-organization") {
      found = (await listOrganizations(this.ctx, accountId)).find((r) => r.id === resourceId);
    } else if (typeId === "supabase-project") {
      const project = await fetchProject(this.ctx, externalId);
      const index = await fetchOrgProjectIndex(this.ctx, [project.organization_slug]);
      found = await toProjectResource(this.ctx, project, accountId, index.get(project.ref));
    } else {
      // Children are scoped to one project: list just that project's.
      const { ref } = splitScoped(externalId);
      const project = await fetchProject(this.ctx, ref);
      found = (await this.listFor(typeId, accountId, [project])).find((r) => r.id === resourceId);
    }
    if (!found) {
      throw new SupabaseApiError(
        404,
        `Supabase plugin: resource ${typeId}/${externalId} not found`,
      );
    }
    return found;
  }

  // ---- outputs ---------------------------------------------------------------

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const externalId = externalIdOf(resourceId);
    const { ref, rest } = splitScoped(externalId);

    if (typeId === "supabase-organization" && outputKey === "slug") return externalId;

    if (typeId === "supabase-project") {
      switch (outputKey) {
        case "ref":
          return ref;
        case "apiUrl":
          return projectUrl(ref);
        case "dbHost":
          return (await fetchProject(this.ctx, ref)).database?.host ?? `db.${ref}.supabase.co`;
        case "connectionString": {
          const password = await this.dbPassword(resourceId);
          const host =
            (await fetchProject(this.ctx, ref)).database?.host ?? `db.${ref}.supabase.co`;
          return `postgresql://postgres:${uriPassword(password)}@${host}:5432/postgres`;
        }
        case "poolerConnectionString":
        case "sessionPoolerConnectionString": {
          const password = await this.dbPassword(resourceId);
          const pooler = primaryPooler(await this.poolers(ref));
          if (!pooler) throw new Error("Supabase plugin: the project has no pooler configured.");
          return poolerUrl(pooler, password, outputKey === "sessionPoolerConnectionString");
        }
        case "publishableKey":
        case "secretKey":
        case "anonKey":
        case "serviceRoleKey":
          return this.projectKey(ref, outputKey);
      }
    }

    if (typeId === "supabase-branch") {
      if (outputKey === "branchRef") return rest;
      if (outputKey === "apiUrl") return projectUrl(rest);
      if (outputKey === "connectionString") {
        const cfg = await sbFetch<SbBranchConfig>(this.ctx, "GET", `/v1/branches/${enc(rest)}`);
        if (!cfg?.db_pass) {
          throw new Error(
            "Supabase plugin: Supabase did not return this branch's database password (the token needs the environment:read scope).",
          );
        }
        return `postgresql://${cfg.db_user ?? "postgres"}:${uriPassword(cfg.db_pass)}@${cfg.db_host}:${cfg.db_port}/postgres`;
      }
    }

    if (typeId === "supabase-function") {
      if (outputKey === "url") return `${projectUrl(ref)}/functions/v1/${rest}`;
      if (outputKey === "slug") return rest;
    }

    if (typeId === "supabase-api-key" && outputKey === "apiKey") {
      if (rest.startsWith("legacy-")) {
        const keys = await this.revealedKeys(ref);
        const key = keys.find((k) => k.name === rest.slice("legacy-".length))?.api_key;
        if (!key) throw new Error("Supabase plugin: the legacy key could not be read.");
        return key;
      }
      const key = await sbFetch<SbApiKey>(
        this.ctx,
        "GET",
        `/v1/projects/${enc(ref)}/api-keys/${enc(rest)}`,
        undefined,
        { reveal: true },
      );
      if (!key?.api_key) throw new Error("Supabase plugin: the key could not be revealed.");
      return key.api_key;
    }

    if (typeId === "supabase-bucket") {
      if (outputKey === "bucketName") return rest;
      if (outputKey === "publicUrl") return `${projectUrl(ref)}/storage/v1/object/public/${rest}`;
    }

    if (typeId === "supabase-read-replica" && outputKey === "connectionString") {
      const password = await this.dbPassword(
        resourceId.replace(":supabase-read-replica:", ":supabase-project:").replace(/\/[^/]*$/, ""),
      );
      const pooler = (await this.poolers(ref)).find((p) => p.identifier === rest);
      if (!pooler) throw new Error("Supabase plugin: no pooler endpoint for this replica yet.");
      return poolerUrl(pooler, password, false);
    }

    if (typeId === "supabase-auth" && outputKey === "siteUrl") {
      const cfg = await sbFetch<Record<string, unknown>>(
        this.ctx,
        "GET",
        `/v1/projects/${enc(ref)}/config/auth`,
      );
      return typeof cfg?.["site_url"] === "string" ? cfg["site_url"] : "";
    }

    if (typeId === "supabase-signing-key" && outputKey === "publicJwk") {
      const key = await sbFetch<SbSigningKey>(
        this.ctx,
        "GET",
        `/v1/projects/${enc(ref)}/config/auth/signing-keys/${enc(rest)}`,
      );
      return key?.public_jwk ? JSON.stringify(key.public_jwk) : "";
    }

    void accountId;
    throw new Error(`Supabase plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  async rerollOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    _accountId: string,
  ): Promise<void> {
    if (
      typeId === "supabase-project" &&
      ["connectionString", "poolerConnectionString", "sessionPoolerConnectionString"].includes(
        outputKey,
      )
    ) {
      await this.resetDbPassword(resourceId);
      return;
    }
    throw new Error(`Supabase plugin: "${outputKey}" cannot be reissued.`);
  }

  private async poolers(ref: string): Promise<SbPooler[]> {
    return (
      (await sbFetch<SbPooler[]>(
        this.ctx,
        "GET",
        `/v1/projects/${enc(ref)}/config/database/pooler`,
      )) ?? []
    );
  }

  /** The stored postgres password, which Supabase itself never returns. */
  private async dbPassword(projectResourceId: string): Promise<string> {
    const stored = await this.services?.secrets?.getPlaintext(projectResourceId, DB_PASSWORD_FIELD);
    if (stored) return stored;
    throw new Error(
      'Supabase only returns the database password when a project is created. Use "Reset database password" on the project so Infrawrench can build connection strings.',
    );
  }

  private async resetDbPassword(projectResourceId: string, chosen?: string): Promise<void> {
    const ref = splitScoped(externalIdOf(projectResourceId)).ref;
    const password = chosen || randomPassword();
    await sbFetch(this.ctx, "PATCH", `/v1/projects/${enc(ref)}/database/password`, { password });
    if (!this.services?.secrets?.setPlaintext) {
      throw new Error(
        `The password was changed but this host cannot store it. The new postgres password is: ${password}`,
      );
    }
    await this.services.secrets.setPlaintext(projectResourceId, DB_PASSWORD_FIELD, password);
  }

  private revealedKeys(ref: string): Promise<SbApiKey[]> {
    return sbFetch<SbApiKey[]>(this.ctx, "GET", `/v1/projects/${enc(ref)}/api-keys`, undefined, {
      reveal: true,
    }).then((keys) => keys ?? []);
  }

  private async projectKey(
    ref: string,
    which: "publishableKey" | "secretKey" | "anonKey" | "serviceRoleKey",
  ): Promise<string> {
    const keys = await this.revealedKeys(ref);
    const pick =
      which === "publishableKey"
        ? keys.find((k) => k.type === "publishable")
        : which === "secretKey"
          ? keys.find((k) => k.type === "secret")
          : keys.find((k) => k.name === (which === "anonKey" ? "anon" : "service_role"));
    if (!pick?.api_key) {
      throw new Error(
        which === "publishableKey" || which === "secretKey"
          ? `Supabase plugin: the project has no ${which === "secretKey" ? "secret" : "publishable"} API key yet. Create one under API Keys.`
          : "Supabase plugin: the legacy key is not available (legacy keys may be disabled).",
      );
    }
    return pick.api_key;
  }

  /** A secret key for the project's Storage API, cached for the client's lifetime. */
  private secretKey(ref: string): Promise<string> {
    let pending = this.secretKeys.get(ref);
    if (!pending) {
      pending = this.revealedKeys(ref).then((keys) => {
        const key =
          keys.find((k) => k.type === "secret")?.api_key ??
          keys.find((k) => k.name === "service_role")?.api_key;
        if (!key) {
          throw new Error(
            "Supabase plugin: this project has no secret API key to reach Storage with. Create a secret key under API Keys.",
          );
        }
        return key;
      });
      pending.catch(() => this.secretKeys.delete(ref));
      this.secretKeys.set(ref, pending);
    }
    return pending;
  }

  // ---- detail views ----------------------------------------------------------

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const fields = { ...resource.fields };
    const put = (key: string, value: unknown) => {
      if (value !== undefined && value !== null) fields[key] = JSON.stringify(value);
    };
    const quiet = <T>(p: Promise<T>) => p.catch(() => undefined);

    if (resource.resourceTypeId === "supabase-project") {
      const ref = String(resource.fields["ref"] ?? resource.externalId ?? "");
      const base = `/v1/projects/${enc(ref)}`;
      const running = String(resource.fields["status"] ?? "").startsWith("ACTIVE");
      const [
        health,
        security,
        performance,
        disk,
        util,
        autoscale,
        addons,
        upgrade,
        hostname,
        vanity,
        readonly,
      ] = await Promise.all([
        running
          ? quiet(
              sbFetch(this.ctx, "GET", `${base}/health`, undefined, {
                services: "auth,db,pooler,realtime,rest,storage",
              }),
            )
          : undefined,
        running
          ? quiet(sbFetch<{ lints: unknown[] }>(this.ctx, "GET", `${base}/advisors/security`))
          : undefined,
        running
          ? quiet(sbFetch<{ lints: unknown[] }>(this.ctx, "GET", `${base}/advisors/performance`))
          : undefined,
        quiet(sbFetch(this.ctx, "GET", `${base}/config/disk`)),
        running ? quiet(sbFetch(this.ctx, "GET", `${base}/config/disk/util`)) : undefined,
        quiet(sbFetch(this.ctx, "GET", `${base}/config/disk/autoscale`)),
        quiet(sbFetch(this.ctx, "GET", `${base}/billing/addons`)),
        running ? quiet(sbFetch(this.ctx, "GET", `${base}/upgrade/eligibility`)) : undefined,
        quiet(sbFetch(this.ctx, "GET", `${base}/custom-hostname`)),
        quiet(sbFetch(this.ctx, "GET", `${base}/vanity-subdomain`)),
        running ? quiet(sbFetch(this.ctx, "GET", `${base}/readonly`)) : undefined,
      ]);
      put(ENRICH.health, health);
      if (security || performance) {
        put(ENRICH.advisors, {
          security: security?.lints ?? [],
          performance: performance?.lints ?? [],
        });
      }
      put(ENRICH.disk, disk);
      put(ENRICH.diskUtil, util);
      put(ENRICH.autoscale, autoscale);
      put(ENRICH.addons, addons);
      put(ENRICH.upgrade, upgrade);
      put(ENRICH.customHostname, hostname);
      put(ENRICH.vanity, vanity);
      put(ENRICH.readonly, readonly);
    }

    if (resource.resourceTypeId === "supabase-organization") {
      const slug = String(resource.fields["slug"] ?? resource.externalId ?? "");
      put(
        ENRICH.members,
        await quiet(sbFetch<SbMember[]>(this.ctx, "GET", `/v1/organizations/${enc(slug)}/members`)),
      );
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
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
    if (resourceTypeId === "supabase-project") {
      const status = String(r.fields["status"] ?? "");
      return [
        { label: "Region", value: String(r.fields["region"] ?? "") },
        {
          label: "Status",
          value: status === "INACTIVE" ? "Paused" : status.replace(/_/g, " ").toLowerCase(),
          variant:
            status === "ACTIVE_HEALTHY"
              ? "status-healthy"
              : status === "ACTIVE_UNHEALTHY" || status === "INACTIVE"
                ? "status-degraded"
                : "status-error",
        },
        { label: "Compute", value: String(r.fields["computeSize"] ?? "") },
      ];
    }
    if (resourceTypeId === "supabase-function") {
      return [
        { label: "Version", value: String(r.fields["version"] ?? "") },
        { label: "Status", value: String(r.fields["status"] ?? "") },
      ];
    }
    if (resourceTypeId === "supabase-bucket") {
      return [{ label: "Access", value: r.fields["public"] === true ? "Public" : "Private" }];
    }
    return [];
  }

  // ---- settings editor (project Configuration tab, Auth Settings tab) --------

  async getManifest(resourceId: string, _accountId: string): Promise<string> {
    const typeId = resourceId.split(":")[1];
    const ref = splitScoped(externalIdOf(resourceId)).ref;
    const base = `/v1/projects/${enc(ref)}`;
    if (typeId === "supabase-auth") {
      const cfg = await sbFetch<Record<string, unknown>>(this.ctx, "GET", `${base}/config/auth`);
      return JSON.stringify({ settings: descriptors(AUTH_SETTINGS, cfg ?? {}, "") });
    }
    if (typeId === "supabase-project") {
      const [postgres, poolers, postgrest, storage, realtime] = await Promise.all([
        sbFetch(this.ctx, "GET", `${base}/config/database/postgres`).catch(() => undefined),
        this.poolers(ref).catch(() => [] as SbPooler[]),
        sbFetch(this.ctx, "GET", `${base}/postgrest`).catch(() => undefined),
        sbFetch(this.ctx, "GET", `${base}/config/storage`).catch(() => undefined),
        sbFetch(this.ctx, "GET", `${base}/config/realtime`).catch(() => undefined),
      ]);
      const settings = [
        ...(postgres ? descriptors(PROJECT_SECTIONS["postgres"]!, postgres, "postgres.") : []),
        ...(poolers.length
          ? descriptors(PROJECT_SECTIONS["pooler"]!, primaryPooler(poolers), "pooler.")
          : []),
        ...(postgrest ? descriptors(PROJECT_SECTIONS["postgrest"]!, postgrest, "postgrest.") : []),
        ...(storage ? descriptors(PROJECT_SECTIONS["storage"]!, storage, "storage.") : []),
        ...(realtime ? descriptors(PROJECT_SECTIONS["realtime"]!, realtime, "realtime.") : []),
      ];
      return JSON.stringify({ settings });
    }
    throw new Error(`Supabase plugin: no settings for "${typeId}".`);
  }

  async applyManifest(resourceId: string, _accountId: string, manifest: string): Promise<void> {
    const typeId = resourceId.split(":")[1];
    const ref = splitScoped(externalIdOf(resourceId)).ref;
    const base = `/v1/projects/${enc(ref)}`;
    const changes = JSON.parse(manifest) as Array<{ id: string; value: string }>;
    if (!Array.isArray(changes)) throw new Error("Settings must be a list of {id, value} pairs.");
    if (typeId === "supabase-auth") {
      await sbFetch(this.ctx, "PATCH", `${base}/config/auth`, authChangesBody(changes));
      return;
    }
    if (typeId !== "supabase-project")
      throw new Error(`Supabase plugin: no settings for "${typeId}".`);
    const bodies = groupProjectChanges(changes);
    const routes: Record<string, [string, string]> = {
      postgres: ["PUT", `${base}/config/database/postgres`],
      pooler: ["PATCH", `${base}/config/database/pooler`],
      postgrest: ["PATCH", `${base}/postgrest`],
      storage: ["PATCH", `${base}/config/storage`],
      realtime: ["PATCH", `${base}/config/realtime`],
    };
    for (const [sectionId, body] of bodies) {
      const [method, path] = routes[sectionId]!;
      await sbFetch(this.ctx, method, path, body);
    }
  }

  // ---- SQL (Management API query endpoint) -----------------------------------

  async executeQuery(
    resourceId: string,
    _accountId: string,
    sql: string,
  ): Promise<{ rows: Record<string, unknown>[]; durationMs: number }> {
    const ref = splitScoped(externalIdOf(resourceId)).ref;
    const start = Date.now();
    const rows = await sbFetch<Record<string, unknown>[] | null>(
      this.ctx,
      "POST",
      `/v1/projects/${enc(ref)}/database/query`,
      { query: sql },
    );
    return { rows: Array.isArray(rows) ? rows : [], durationMs: Date.now() - start };
  }

  async introspectResource(resourceId: string, accountId: string): Promise<SqlTableMeta[]> {
    const { rows } = await this.executeQuery(
      resourceId,
      accountId,
      `select c.table_schema, c.table_name, c.column_name, c.data_type
         from information_schema.columns c
        where c.table_schema not in ('pg_catalog', 'information_schema', 'pg_toast')
          and c.table_schema not like 'pg_temp%'
        order by c.table_schema, c.table_name, c.ordinal_position
        limit 5000`,
    );
    const tables = new Map<string, SqlTableMeta>();
    for (const row of rows) {
      const schema = String(row["table_schema"] ?? "");
      const name =
        schema === "public" ? String(row["table_name"]) : `${schema}.${String(row["table_name"])}`;
      const table = tables.get(name) ?? { name, columns: [] };
      table.columns.push({ name: String(row["column_name"]), type: String(row["data_type"]) });
      tables.set(name, table);
    }
    return [...tables.values()];
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    if (typeId === "supabase-project" && command === "reset-db-password") {
      let chosen = "";
      try {
        const parsed = JSON.parse(String(args[0] ?? "{}")) as { password?: string };
        chosen = parsed.password ?? "";
      } catch {
        chosen = "";
      }
      await this.resetDbPassword(resourceId, chosen);
      return { ok: true };
    }
    throw new Error(`Supabase plugin: unknown command "${command}".`);
  }

  // ---- create / update / delete ----------------------------------------------

  getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    return getCreateConfig(this.ctx, typeId, parentResourceId);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceCreateReturn> {
    if (typeId === "supabase-project") return this.createProject(accountId, fields);
    const ref = targetProjectRef(fields, parentResourceId);
    const base = `/v1/projects/${enc(ref)}`;

    switch (typeId) {
      case "supabase-branch": {
        const branch = await sbFetch<SbBranch>(this.ctx, "POST", `${base}/branches`, {
          branch_name: required(fields["name"], "a branch name"),
          ...(fields["gitBranch"] ? { git_branch: fields["gitBranch"] } : {}),
          ...(bool(fields["persistent"]) !== undefined
            ? { persistent: bool(fields["persistent"]) }
            : {}),
          ...(bool(fields["withData"]) !== undefined
            ? { with_data: bool(fields["withData"]) }
            : {}),
          ...(fields["computeSize"] ? { desired_instance_size: fields["computeSize"] } : {}),
        });
        return toBranch(branch, accountId);
      }
      case "supabase-function": {
        const slug = required(fields["slug"], "a slug");
        const fn = await this.deployFunction(ref, slug, fields["code"] ?? "", {
          name: fields["name"] || slug,
          verifyJwt: bool(fields["verifyJwt"]) ?? true,
        });
        return toFunction(fn, ref, accountId);
      }
      case "supabase-secret": {
        const name = required(fields["name"], "a name");
        if (name.startsWith("SUPABASE_")) {
          throw new Error(
            "Secret names cannot start with SUPABASE_; those are set by the platform.",
          );
        }
        await sbFetch(this.ctx, "POST", `${base}/secrets`, [
          { name, value: required(fields["value"], "a value") },
        ]);
        return this.getResource(typeId, `${accountId}:${typeId}:${ref}/${name}`, accountId);
      }
      case "supabase-api-key": {
        const key = await sbFetch<SbApiKey>(
          this.ctx,
          "POST",
          `${base}/api-keys`,
          {
            type: fields["type"] === "publishable" ? "publishable" : "secret",
            name: required(fields["name"], "a name"),
            ...(fields["description"] ? { description: fields["description"] } : {}),
          },
          { reveal: true },
        );
        const resource = toApiKey(key, ref, accountId);
        if (key.api_key) resource.resolvedOutputs["apiKey"] = key.api_key;
        return resource;
      }
      case "supabase-bucket": {
        const name = required(fields["name"], "a bucket name");
        await createBucket(this.ctx, ref, await this.secretKey(ref), name, {
          public: fields["public"] === "true",
          fileSizeLimit: fields["fileSizeLimit"] ? Number(fields["fileSizeLimit"]) : null,
          allowedMimeTypes: splitList(fields["allowedMimeTypes"]),
        });
        return this.getResource(typeId, `${accountId}:${typeId}:${ref}/${name}`, accountId);
      }
      case "supabase-read-replica": {
        await sbFetch(this.ctx, "POST", `${base}/read-replicas/setup`, {
          read_replica_region: required(fields["region"], "a region"),
        });
        // The replica appears in the organization's project listing once
        // provisioning starts; return the newest one in that region.
        const replicas = await listReadReplicas(this.ctx, accountId, [
          await fetchProject(this.ctx, ref),
        ]);
        const match = replicas.filter((r) => r.fields["region"] === fields["region"]).pop();
        if (match) return match;
        throw new Error("The read replica is being set up; refresh in a minute to see it.");
      }
      case "supabase-sso-provider": {
        const provider = await sbFetch<SbSsoProvider>(
          this.ctx,
          "POST",
          `${base}/config/auth/sso/providers`,
          {
            type: "saml",
            ...(fields["metadataUrl"] ? { metadata_url: fields["metadataUrl"] } : {}),
            ...(fields["metadataXml"] ? { metadata_xml: fields["metadataXml"] } : {}),
            domains: splitList(fields["domains"]),
            ...(fields["nameIdFormat"] ? { name_id_format: fields["nameIdFormat"] } : {}),
          },
        );
        return toSsoProvider(provider, ref, accountId);
      }
      case "supabase-third-party-auth": {
        const url = required(fields["url"], "a URL");
        await sbFetch(
          this.ctx,
          "POST",
          `${base}/config/auth/third-party-auth`,
          fields["source"] === "jwks" ? { jwks_url: url } : { oidc_issuer_url: url },
        );
        const all = await listThirdPartyAuth(this.ctx, accountId, [
          await fetchProject(this.ctx, ref),
        ]);
        const match = all.find(
          (r) => r.fields["oidcIssuerUrl"] === url || r.fields["jwksUrl"] === url,
        );
        if (!match)
          throw new Error(
            "Supabase accepted the integration but did not list it yet; refresh shortly.",
          );
        return match;
      }
      case "supabase-signing-key": {
        const key = await sbFetch<SbSigningKey>(
          this.ctx,
          "POST",
          `${base}/config/auth/signing-keys`,
          {
            algorithm: fields["algorithm"] || "ES256",
            ...(fields["status"] ? { status: fields["status"] } : {}),
          },
        );
        return toSigningKey(key, ref, accountId);
      }
      default:
        throw new Error(`Supabase plugin: cannot create "${typeId}".`);
    }
  }

  private async createProject(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceCreateReturn> {
    const password = fields["dbPassword"] || randomPassword();
    const project = await sbFetch<SbProject>(this.ctx, "POST", "/v1/projects", {
      name: required(fields["name"], "a project name"),
      organization_slug: required(fields["organizationSlug"], "an organization"),
      db_pass: password,
      region_selection: { type: "specific", code: required(fields["region"], "a region") },
      ...(fields["computeSize"] ? { desired_instance_size: fields["computeSize"] } : {}),
    });
    const resource = await toProjectResource(this.ctx, project, accountId, undefined);
    const warnings = [];
    if (this.services?.secrets?.setPlaintext) {
      await this.services.secrets.setPlaintext(resource.id, DB_PASSWORD_FIELD, password);
    } else {
      warnings.push({
        code: "password-not-stored",
        message: `This host cannot store secrets, so save the database password now: ${password}`,
      });
    }
    return { resource, warnings };
  }

  private async deployFunction(
    ref: string,
    slug: string,
    code: string,
    meta: { name: string; verifyJwt: boolean },
  ): Promise<SbFunction> {
    if (!code.trim()) throw new Error("Supabase plugin: the function needs some code.");
    const { contentType, body } = buildMultipartBody([
      {
        kind: "field",
        name: "metadata",
        value: JSON.stringify({
          entrypoint_path: "index.ts",
          name: meta.name,
          verify_jwt: meta.verifyJwt,
        }),
      },
      {
        kind: "file",
        name: "file",
        fileName: "index.ts",
        contentType: "application/typescript",
        data: new TextEncoder().encode(code),
      },
    ]);
    return sbFetchRaw<SbFunction>(
      this.ctx,
      "POST",
      `/v1/projects/${enc(ref)}/functions/deploy`,
      contentType,
      body,
      { slug },
    );
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const { ref, rest } = splitScoped(externalIdOf(resourceId));
    const base = `/v1/projects/${enc(ref)}`;

    switch (typeId) {
      case "supabase-project":
        await this.updateProject(ref, fields);
        break;
      case "supabase-branch": {
        const body: Record<string, unknown> = {};
        if (fields["name"]) body["branch_name"] = fields["name"];
        if (fields["gitBranch"] !== undefined) body["git_branch"] = fields["gitBranch"];
        if (bool(fields["persistent"]) !== undefined)
          body["persistent"] = bool(fields["persistent"]);
        if (fields["notifyUrl"] !== undefined) body["notify_url"] = fields["notifyUrl"];
        await sbFetch(this.ctx, "PATCH", `/v1/branches/${enc(rest)}`, body);
        break;
      }
      case "supabase-function": {
        const body: Record<string, unknown> = {};
        if (fields["name"]) body["name"] = fields["name"];
        if (bool(fields["verifyJwt"]) !== undefined) body["verify_jwt"] = bool(fields["verifyJwt"]);
        await sbFetch(this.ctx, "PATCH", `${base}/functions/${enc(rest)}`, body);
        break;
      }
      case "supabase-secret":
        if (fields["value"]) {
          // Bulk create upserts: the same call replaces an existing value.
          await sbFetch(this.ctx, "POST", `${base}/secrets`, [
            { name: rest, value: fields["value"] },
          ]);
        }
        break;
      case "supabase-api-key":
        if (rest.startsWith("legacy-")) throw new Error("Legacy keys cannot be edited.");
        await sbFetch(this.ctx, "PATCH", `${base}/api-keys/${enc(rest)}`, {
          description: fields["description"] ?? "",
        });
        break;
      case "supabase-bucket":
        await updateBucket(this.ctx, ref, await this.secretKey(ref), rest, {
          ...(bool(fields["public"]) !== undefined ? { public: bool(fields["public"])! } : {}),
          ...(fields["fileSizeLimit"] !== undefined
            ? { fileSizeLimit: fields["fileSizeLimit"] ? Number(fields["fileSizeLimit"]) : null }
            : {}),
          ...(fields["allowedMimeTypes"] !== undefined
            ? { allowedMimeTypes: splitList(fields["allowedMimeTypes"]) }
            : {}),
        });
        break;
      case "supabase-sso-provider": {
        const body: Record<string, unknown> = {};
        if (fields["metadataUrl"]) body["metadata_url"] = fields["metadataUrl"];
        if (fields["domains"] !== undefined) body["domains"] = splitList(fields["domains"]);
        if (fields["nameIdFormat"]) body["name_id_format"] = fields["nameIdFormat"];
        await sbFetch(this.ctx, "PUT", `${base}/config/auth/sso/providers/${enc(rest)}`, body);
        break;
      }
      case "supabase-signing-key":
        if (fields["status"]) {
          await sbFetch(this.ctx, "PATCH", `${base}/config/auth/signing-keys/${enc(rest)}`, {
            status: fields["status"],
          });
        }
        break;
      default:
        throw new Error(`Supabase plugin: cannot update "${typeId}".`);
    }
    return this.getResource(typeId, resourceId, accountId);
  }

  private async updateProject(ref: string, fields: Record<string, string>): Promise<void> {
    const base = `/v1/projects/${enc(ref)}`;
    if (fields["name"]) await sbFetch(this.ctx, "PATCH", base, { name: fields["name"] });

    if (fields["computeSize"]) {
      await sbFetch(this.ctx, "PATCH", `${base}/billing/addons`, {
        addon_type: "compute_instance",
        addon_variant: `ci_${fields["computeSize"]}`,
      });
    }

    if (fields["pitrDays"] !== undefined && fields["pitrDays"] !== "") {
      if (fields["pitrDays"] === "0") {
        const addons = await sbFetch<SbAddons>(this.ctx, "GET", `${base}/billing/addons`);
        const current = addons?.selected_addons.find((a) => a.type === "pitr")?.variant.id;
        if (current) await sbFetch(this.ctx, "DELETE", `${base}/billing/addons/${enc(current)}`);
      } else {
        await sbFetch(this.ctx, "PATCH", `${base}/billing/addons`, {
          addon_type: "pitr",
          addon_variant: `pitr_${fields["pitrDays"]}`,
        });
      }
    }

    const ipv4 = bool(fields["ipv4"]);
    if (ipv4 === true) {
      await sbFetch(this.ctx, "PATCH", `${base}/billing/addons`, {
        addon_type: "ipv4",
        addon_variant: "ipv4_default",
      });
    } else if (ipv4 === false) {
      await sbFetch(this.ctx, "DELETE", `${base}/billing/addons/ipv4_default`);
    }

    if (["diskSizeGb", "diskType", "diskIops", "diskThroughputMbps"].some((k) => fields[k])) {
      const current = await sbFetch<{ attributes: Record<string, unknown> }>(
        this.ctx,
        "GET",
        `${base}/config/disk`,
      );
      const attrs: Record<string, unknown> = { ...(current?.attributes ?? {}) };
      if (fields["diskSizeGb"]) attrs["size_gb"] = Number(fields["diskSizeGb"]);
      if (fields["diskType"]) attrs["type"] = fields["diskType"];
      if (fields["diskIops"]) attrs["iops"] = Number(fields["diskIops"]);
      if (fields["diskThroughputMbps"])
        attrs["throughput_mibps"] = Number(fields["diskThroughputMbps"]);
      if (attrs["type"] === "io2") delete attrs["throughput_mibps"];
      await sbFetch(this.ctx, "POST", `${base}/config/disk`, { attributes: attrs });
    }

    const ssl = bool(fields["sslEnforced"]);
    if (ssl !== undefined) {
      await sbFetch(this.ctx, "PUT", `${base}/ssl-enforcement`, {
        requestedConfig: { database: ssl },
      });
    }

    if (fields["allowedCidrs"] !== undefined || fields["allowedCidrsV6"] !== undefined) {
      const current = await sbFetch<{
        config: { dbAllowedCidrs?: string[]; dbAllowedCidrsV6?: string[] };
      }>(this.ctx, "GET", `${base}/network-restrictions`);
      await sbFetch(this.ctx, "POST", `${base}/network-restrictions/apply`, {
        dbAllowedCidrs:
          fields["allowedCidrs"] !== undefined
            ? splitList(fields["allowedCidrs"])
            : (current?.config.dbAllowedCidrs ?? []),
        dbAllowedCidrsV6:
          fields["allowedCidrsV6"] !== undefined
            ? splitList(fields["allowedCidrsV6"])
            : (current?.config.dbAllowedCidrsV6 ?? []),
      });
    }

    const pooler: Record<string, unknown> = {};
    if (fields["poolMode"]) pooler["pool_mode"] = fields["poolMode"];
    if (fields["poolSize"]) pooler["default_pool_size"] = Number(fields["poolSize"]);
    if (Object.keys(pooler).length > 0) {
      await sbFetch(this.ctx, "PATCH", `${base}/config/database/pooler`, pooler);
    }

    const legacy = bool(fields["legacyApiKeysEnabled"]);
    if (legacy !== undefined) {
      await sbFetch(this.ctx, "PUT", `${base}/api-keys/legacy`, undefined, { enabled: legacy });
    }
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const { ref, rest } = splitScoped(externalIdOf(resourceId));
    const base = `/v1/projects/${enc(ref)}`;
    switch (typeId) {
      case "supabase-project":
        await sbFetch(this.ctx, "DELETE", base);
        return;
      case "supabase-branch":
        await sbFetch(this.ctx, "DELETE", `/v1/branches/${enc(rest)}`);
        return;
      case "supabase-function":
        await sbFetch(this.ctx, "DELETE", `${base}/functions/${enc(rest)}`);
        return;
      case "supabase-secret":
        await sbFetch(this.ctx, "DELETE", `${base}/secrets`, [rest]);
        return;
      case "supabase-api-key":
        if (rest.startsWith("legacy-")) {
          throw new Error("Legacy keys cannot be deleted; turn them off on the project instead.");
        }
        await sbFetch(this.ctx, "DELETE", `${base}/api-keys/${enc(rest)}`);
        return;
      case "supabase-bucket":
        await deleteBucket(this.ctx, ref, await this.secretKey(ref), rest);
        return;
      case "supabase-read-replica":
        await sbFetch(this.ctx, "POST", `${base}/read-replicas/remove`, {
          database_identifier: rest,
        });
        return;
      case "supabase-sso-provider":
        await sbFetch(this.ctx, "DELETE", `${base}/config/auth/sso/providers/${enc(rest)}`);
        return;
      case "supabase-third-party-auth":
        await sbFetch(this.ctx, "DELETE", `${base}/config/auth/third-party-auth/${enc(rest)}`);
        return;
      case "supabase-signing-key":
        await sbFetch(this.ctx, "DELETE", `${base}/config/auth/signing-keys/${enc(rest)}`);
        return;
      default:
        throw new Error(`Supabase plugin: "${typeId}" cannot be deleted.`);
    }
  }

  // ---- actions -----------------------------------------------------------------

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const { ref, rest } = splitScoped(externalIdOf(resourceId));
    const base = `/v1/projects/${enc(ref)}`;

    if (typeId === "supabase-project") {
      switch (actionId) {
        case "pause":
          await sbFetch(this.ctx, "POST", `${base}/pause`);
          return;
        case "restore":
          await sbFetch(this.ctx, "POST", `${base}/restore`);
          return;
        case "restart":
          await sbFetch(this.ctx, "POST", `${base}/restart`);
          return;
        case "reset-db-password":
          await this.resetDbPassword(resourceId);
          return;
        case "disable-readonly":
          await sbFetch(this.ctx, "POST", `${base}/readonly/temporary-disable`);
          return;
        case "reverify-custom-hostname":
          await sbFetch(this.ctx, "POST", `${base}/custom-hostname/reverify`);
          return;
        case "activate-custom-hostname":
          await sbFetch(this.ctx, "POST", `${base}/custom-hostname/activate`);
          return;
        case "unban-all": {
          const bans = await sbFetch<{ banned_ipv4_addresses?: string[] }>(
            this.ctx,
            "POST",
            `${base}/network-bans/retrieve`,
          );
          const ips = bans?.banned_ipv4_addresses ?? [];
          if (ips.length > 0) {
            await sbFetch(this.ctx, "DELETE", `${base}/network-bans`, { ipv4_addresses: ips });
          }
          return;
        }
        case "upgrade-postgres": {
          const eligibility = await sbFetch<SbUpgradeEligibility>(
            this.ctx,
            "GET",
            `${base}/upgrade/eligibility`,
          );
          const target = eligibility?.target_upgrade_versions.at(-1);
          if (!eligibility?.eligible || !target) {
            throw new Error(
              "Supabase reports this project is not eligible for an upgrade right now.",
            );
          }
          await sbFetch(this.ctx, "POST", `${base}/upgrade`, {
            target_version: target.postgres_version,
            release_channel: target.release_channel,
          });
          return;
        }
      }
    }

    if (typeId === "supabase-branch") {
      const path = `/v1/branches/${enc(rest)}`;
      switch (actionId) {
        case "push":
        case "merge":
        case "reset":
          await sbFetch(this.ctx, "POST", `${path}/${actionId}`, {});
          return;
        case "restore-branch":
          await sbFetch(this.ctx, "POST", `${path}/restore`);
          return;
      }
    }

    if (typeId === "supabase-bucket" && actionId === "empty") {
      await emptyBucket(this.ctx, ref, await this.secretKey(ref), rest);
      return;
    }

    if (typeId === "supabase-signing-key" && (actionId === "rotate-in" || actionId === "revoke")) {
      await sbFetch(this.ctx, "PATCH", `${base}/config/auth/signing-keys/${enc(rest)}`, {
        status: actionId === "rotate-in" ? "in_use" : "revoked",
      });
      return;
    }

    throw new Error(`Supabase plugin: unknown action "${actionId}" for "${typeId}".`);
  }

  // ---- storage browser ---------------------------------------------------------

  async listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    const { ref, bucket: id } = parseBucketHandle(bucket);
    return listObjects(this.ctx, ref, await this.secretKey(ref), id, prefix);
  }

  async uploadStorageObject(
    bucket: string,
    key: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    const { ref, bucket: id } = parseBucketHandle(bucket);
    const data = new Uint8Array(await file.arrayBuffer());
    await uploadObject(this.ctx, ref, await this.secretKey(ref), id, key, data, file.type);
    onProgress?.(100);
  }

  async makeStorageFolder(bucket: string, key: string): Promise<void> {
    const { ref, bucket: id } = parseBucketHandle(bucket);
    const folder = key.replace(/\/+$/, "");
    await uploadObject(
      this.ctx,
      ref,
      await this.secretKey(ref),
      id,
      `${folder}/.emptyFolderPlaceholder`,
      new Uint8Array(0),
      "application/octet-stream",
    );
  }

  async deleteStorageObject(bucket: string, key: string): Promise<void> {
    const { ref, bucket: id } = parseBucketHandle(bucket);
    await deleteObject(this.ctx, ref, await this.secretKey(ref), id, key);
  }

  // ---- observability -----------------------------------------------------------

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const { ref, rest } = splitScoped(externalIdOf(resourceId));
    if (resourceTypeId === "supabase-project") return fetchProjectMetrics(this.ctx, ref, timeRange);
    if (resourceTypeId === "supabase-function") {
      const fn = await sbFetch<SbFunction>(
        this.ctx,
        "GET",
        `/v1/projects/${enc(ref)}/functions/${enc(rest)}`,
      );
      return fn?.id ? fetchFunctionMetrics(this.ctx, ref, fn.id, timeRange) : [];
    }
    return [];
  }

  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    const { ref, rest } = splitScoped(externalIdOf(resourceId));
    if (typeId === "supabase-project") return fetchProjectLogs(this.ctx, ref, params);
    if (typeId === "supabase-function") {
      const fn = await sbFetch<SbFunction>(
        this.ctx,
        "GET",
        `/v1/projects/${enc(ref)}/functions/${enc(rest)}`,
      );
      return fetchFunctionLogs(this.ctx, ref, fn.id, params);
    }
    return { text: "", containers: [], activeContainer: "" };
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchSupabaseCostData(this.ctx, await fetchProjects(this.ctx), range);
  }

  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
    try {
      return await fetchDiskQuotas(this.ctx, await fetchProjects(this.ctx));
    } catch (err) {
      if (statusOf(err) === 403) {
        throw new QuotaAccessError(
          "The access token cannot read disk utilization. A scoped token needs project read access.",
          { label: "Access tokens", url: "https://supabase.com/dashboard/account/tokens" },
        );
      }
      throw err;
    }
  }
}

function required(value: string | undefined, what: string): string {
  const v = (value ?? "").trim();
  if (!v) throw new Error(`Supabase plugin: ${what} is required.`);
  return v;
}

/** A pooler URL with the stored password in place of Supabase's placeholder. */
export function poolerUrl(pooler: SbPooler, password: string, session: boolean): string {
  const template =
    pooler.connection_string ||
    `postgresql://${pooler.db_user}:${PASSWORD_PLACEHOLDER}@${pooler.db_host}:${pooler.db_port}/${pooler.db_name}`;
  let url = template.replace(PASSWORD_PLACEHOLDER, uriPassword(password));
  if (session) url = url.replace(/:6543\//, ":5432/");
  return url;
}
