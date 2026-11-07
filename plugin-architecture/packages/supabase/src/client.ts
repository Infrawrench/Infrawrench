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
  SidebarItemSchema,
  SqlTableMeta,
  StorageObject,
} from "@infrawrench/plugin-base";
import {
  buildMultipartBody,
  externalIdOf,
  pathEncode,
  QuotaAccessError,
  type ApiBody,
} from "@infrawrench/plugin-base";
import type { operations } from "./api-types.management.gen.js";
import type { SupabaseApi, SupabaseContext } from "./api.js";
import {
  deployFunctionBundle,
  projectUrl,
  statusOf,
  supabaseApi,
  SupabaseApiError,
} from "./api.js";
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
import { COMPUTE_ADDON_SIZES } from "./resource-types.js";
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
import type { SbApiKey, SbDiskAttributes, SbFunction, SbPooler, SbProject } from "./types.js";

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
  private readonly api: SupabaseApi;
  private readonly services: HostServices | undefined;
  private readonly secretKeys = new Map<string, Promise<string>>();

  constructor(credentials: Credentials, services?: HostServices) {
    const token = (credentials["accessToken"] ?? "").trim();
    if (!token) throw new Error("Supabase plugin: missing accessToken credential");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      token,
      ...(services?.http ? { http: services.http } : {}),
      ...(caCert ? { caCert } : {}),
    };
    this.api = supabaseApi(this.ctx);
    this.services = services;
  }

  verifyCredentials(): PluginEffect<PreflightResult> {
    return attempt(async () => {
      return verifySupabaseCredentials(this.ctx);
    });
  }

  // ---- listing ---------------------------------------------------------------

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      if (typeId === "supabase-organization") return listOrganizations(this.ctx, accountId);
      return this.listFor(typeId, accountId, await fetchProjects(this.ctx));
    });
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

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const externalId = externalIdOf(resourceId);
      let found: ResourceInstance | undefined;
      if (typeId === "supabase-organization") {
        found = (await listOrganizations(this.ctx, accountId)).find((r) => r.id === resourceId);
      } else if (typeId === "supabase-project") {
        const project = await fetchProject(this.ctx, externalId);
        // One project's detail can do without its compute size and disk.
        const index = await fetchOrgProjectIndex(this.ctx, [project.organization_slug]).catch(
          () => undefined,
        );
        found = await toProjectResource(this.ctx, project, accountId, index?.get(project.ref));
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
    });
  }

  // ---- outputs ---------------------------------------------------------------

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
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
          const cfg = await this.api.get(`/v1/branches/${pathEncode(rest)}`);
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
        const key = await this.api.get(
          `/v1/projects/${pathEncode(ref)}/api-keys/${pathEncode(rest)}`,
          { query: { reveal: "true" } },
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
          resourceId
            .replace(":supabase-read-replica:", ":supabase-project:")
            .replace(/\/[^/]*$/, ""),
        );
        const pooler = (await this.poolers(ref)).find((p) => p.identifier === rest);
        if (!pooler) throw new Error("Supabase plugin: no pooler endpoint for this replica yet.");
        return poolerUrl(pooler, password, false);
      }

      if (typeId === "supabase-auth" && outputKey === "siteUrl") {
        const cfg = await this.api.get(`/v1/projects/${pathEncode(ref)}/config/auth`);
        return typeof cfg?.["site_url"] === "string" ? cfg["site_url"] : "";
      }

      if (typeId === "supabase-signing-key" && outputKey === "publicJwk") {
        const key = await this.api.get(
          `/v1/projects/${pathEncode(ref)}/config/auth/signing-keys/${pathEncode(rest)}`,
        );
        return key?.public_jwk ? JSON.stringify(key.public_jwk) : "";
      }

      void accountId;
      throw new Error(`Supabase plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
    });
  }

  rerollOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    _accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
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
    });
  }

  private async poolers(ref: string): Promise<SbPooler[]> {
    return (await this.api.get(`/v1/projects/${pathEncode(ref)}/config/database/pooler`)) ?? [];
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
    await this.api.patch(`/v1/projects/${pathEncode(ref)}/database/password`, {
      body: { password },
    });
    if (!this.services?.secrets?.setPlaintext) {
      throw new Error(
        `The password was changed but this host cannot store it. The new postgres password is: ${password}`,
      );
    }
    await this.services.secrets.setPlaintext(projectResourceId, DB_PASSWORD_FIELD, password);
  }

  private revealedKeys(ref: string): Promise<SbApiKey[]> {
    return this.api
      .get(`/v1/projects/${pathEncode(ref)}/api-keys`, { query: { reveal: "true" } })
      .then((keys) => keys ?? []);
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

  enrichDetail(resource: ResourceInstance): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const fields = { ...resource.fields };
      const put = (key: string, value: unknown) => {
        if (value !== undefined && value !== null) fields[key] = JSON.stringify(value);
      };
      const quiet = <T>(p: Promise<T>) => p.catch(() => undefined);

      if (resource.resourceTypeId === "supabase-project") {
        const ref = String(resource.fields["ref"] ?? resource.externalId ?? "");
        const base = `/v1/projects/${pathEncode(ref)}` as const;
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
                this.api.get(`${base}/health`, {
                  query: { services: "auth,db,pooler,realtime,rest,storage" },
                }),
              )
            : undefined,
          running ? quiet(this.api.get(`${base}/advisors/security`)) : undefined,
          running ? quiet(this.api.get(`${base}/advisors/performance`)) : undefined,
          quiet(this.api.get(`${base}/config/disk`)),
          running ? quiet(this.api.get(`${base}/config/disk/util`)) : undefined,
          quiet(this.api.get(`${base}/config/disk/autoscale`)),
          quiet(this.api.get(`${base}/billing/addons`)),
          running ? quiet(this.api.get(`${base}/upgrade/eligibility`)) : undefined,
          quiet(this.api.get(`${base}/custom-hostname`)),
          quiet(this.api.get(`${base}/vanity-subdomain`)),
          running ? quiet(this.api.get(`${base}/readonly`)) : undefined,
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
          await quiet(this.api.get(`/v1/organizations/${pathEncode(slug)}/members`)),
        );
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
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      const r = await runPluginEffect(this.getResource(resourceTypeId, resourceId, accountId));
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
    });
  }

  // ---- settings editor (project Configuration tab, Auth Settings tab) --------

  getManifest(resourceId: string, _accountId: string): PluginEffect<string> {
    return attempt(async () => {
      const typeId = resourceId.split(":")[1];
      const ref = splitScoped(externalIdOf(resourceId)).ref;
      const base = `/v1/projects/${pathEncode(ref)}` as const;
      if (typeId === "supabase-auth") {
        const cfg = await this.api.get(`${base}/config/auth`);
        return JSON.stringify({ settings: descriptors(AUTH_SETTINGS, cfg ?? {}, "") });
      }
      if (typeId === "supabase-project") {
        const [postgres, poolers, postgrest, storage, realtime] = await Promise.all([
          this.api.get(`${base}/config/database/postgres`).catch(() => undefined),
          this.poolers(ref).catch((): SbPooler[] => []),
          this.api.get(`${base}/postgrest`).catch(() => undefined),
          this.api.get(`${base}/config/storage`).catch(() => undefined),
          this.api.get(`${base}/config/realtime`).catch(() => undefined),
        ]);
        const settings = [
          ...(postgres ? descriptors(PROJECT_SECTIONS["postgres"]!, postgres, "postgres.") : []),
          ...(poolers.length
            ? descriptors(PROJECT_SECTIONS["pooler"]!, primaryPooler(poolers), "pooler.")
            : []),
          ...(postgrest
            ? descriptors(PROJECT_SECTIONS["postgrest"]!, postgrest, "postgrest.")
            : []),
          ...(storage ? descriptors(PROJECT_SECTIONS["storage"]!, storage, "storage.") : []),
          ...(realtime ? descriptors(PROJECT_SECTIONS["realtime"]!, realtime, "realtime.") : []),
        ];
        return JSON.stringify({ settings });
      }
      throw new Error(`Supabase plugin: no settings for "${typeId}".`);
    });
  }

  applyManifest(resourceId: string, _accountId: string, manifest: string): PluginEffect<void> {
    return attempt(async () => {
      const typeId = resourceId.split(":")[1];
      const ref = splitScoped(externalIdOf(resourceId)).ref;
      const base = `/v1/projects/${pathEncode(ref)}` as const;
      const changes: Array<{ id: string; value: string }> = JSON.parse(manifest);
      if (!Array.isArray(changes)) throw new Error("Settings must be a list of {id, value} pairs.");
      if (typeId === "supabase-auth") {
        await this.api.patch(`${base}/config/auth`, { body: authChangesBody(changes) });
        return;
      }
      if (typeId !== "supabase-project")
        throw new Error(`Supabase plugin: no settings for "${typeId}".`);
      const bodies = groupProjectChanges(changes);
      for (const [sectionId, body] of bodies) {
        switch (sectionId) {
          case "postgres":
            await this.api.put(`${base}/config/database/postgres`, { body });
            break;
          case "pooler":
            await this.api.patch(`${base}/config/database/pooler`, { body });
            break;
          case "postgrest":
            await this.api.patch(`${base}/postgrest`, { body });
            break;
          case "storage":
            await this.api.patch(`${base}/config/storage`, { body });
            break;
          case "realtime":
            await this.api.patch(`${base}/config/realtime`, { body });
            break;
        }
      }
    });
  }

  // ---- SQL (Management API query endpoint) -----------------------------------

  executeQuery(
    resourceId: string,
    _accountId: string,
    sql: string,
  ): PluginEffect<{ rows: Record<string, unknown>[]; durationMs: number }> {
    return attempt(async () => {
      const ref = splitScoped(externalIdOf(resourceId)).ref;
      const start = Date.now();
      const rows = await this.api.post(`/v1/projects/${pathEncode(ref)}/database/query`, {
        body: { query: sql },
      });
      return { rows: Array.isArray(rows) ? rows : [], durationMs: Date.now() - start };
    });
  }

  introspectResource(resourceId: string, accountId: string): PluginEffect<SqlTableMeta[]> {
    return attempt(async () => {
      const { rows } = await runPluginEffect(
        this.executeQuery(
          resourceId,
          accountId,
          `select c.table_schema, c.table_name, c.column_name, c.data_type
         from information_schema.columns c
        where c.table_schema not in ('pg_catalog', 'information_schema', 'pg_toast')
          and c.table_schema not like 'pg_temp%'
        order by c.table_schema, c.table_name, c.ordinal_position
        limit 5000`,
        ),
      );
      const tables = new Map<string, SqlTableMeta>();
      for (const row of rows) {
        const schema = String(row["table_schema"] ?? "");
        const name =
          schema === "public"
            ? String(row["table_name"])
            : `${schema}.${String(row["table_name"])}`;
        const table = tables.get(name) ?? { name, columns: [] };
        table.columns.push({ name: String(row["column_name"]), type: String(row["data_type"]) });
        tables.set(name, table);
      }
      return [...tables.values()];
    });
  }

  executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): PluginEffect<unknown> {
    return attempt(async () => {
      if (typeId === "supabase-project" && command === "reset-db-password") {
        let chosen = "";
        try {
          const parsed: { password?: string } = JSON.parse(String(args[0] ?? "{}"));
          chosen = parsed.password ?? "";
        } catch {
          chosen = "";
        }
        await this.resetDbPassword(resourceId, chosen);
        return { ok: true };
      }
      throw new Error(`Supabase plugin: unknown command "${command}".`);
    });
  }

  // ---- create / update / delete ----------------------------------------------

  getCreateConfig(typeId: string, parentResourceId?: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      return getCreateConfig(this.ctx, typeId, parentResourceId);
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): PluginEffect<ResourceCreateReturn> {
    return attempt(async () => {
      if (typeId === "supabase-project") return this.createProject(accountId, fields);
      const ref = targetProjectRef(fields, parentResourceId);
      const base = `/v1/projects/${pathEncode(ref)}` as const;

      switch (typeId) {
        case "supabase-branch": {
          const branch = await this.api.post(`${base}/branches`, {
            body: {
              branch_name: required(fields["name"], "a branch name"),
              ...(fields["gitBranch"] ? { git_branch: fields["gitBranch"] } : {}),
              ...(bool(fields["persistent"]) !== undefined
                ? { persistent: bool(fields["persistent"]) }
                : {}),
              ...(bool(fields["withData"]) !== undefined
                ? { with_data: bool(fields["withData"]) }
                : {}),
              ...(fields["computeSize"] ? { desired_instance_size: fields["computeSize"] } : {}),
            },
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
          await this.api.post(`${base}/secrets`, {
            body: [{ name, value: required(fields["value"], "a value") }],
          });
          return runPluginEffect(
            this.getResource(typeId, `${accountId}:${typeId}:${ref}/${name}`, accountId),
          );
        }
        case "supabase-api-key": {
          const key = await this.api.post(`${base}/api-keys`, {
            body: {
              type: fields["type"] === "publishable" ? "publishable" : "secret",
              name: required(fields["name"], "a name"),
              ...(fields["description"] ? { description: fields["description"] } : {}),
            },
            query: { reveal: "true" },
          });
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
          return runPluginEffect(
            this.getResource(typeId, `${accountId}:${typeId}:${ref}/${name}`, accountId),
          );
        }
        case "supabase-read-replica": {
          await this.api.post(`${base}/read-replicas/setup`, {
            body: { read_replica_region: required(fields["region"], "a region") },
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
          const provider = await this.api.post(`${base}/config/auth/sso/providers`, {
            body: {
              type: "saml",
              ...(fields["metadataUrl"] ? { metadata_url: fields["metadataUrl"] } : {}),
              ...(fields["metadataXml"] ? { metadata_xml: fields["metadataXml"] } : {}),
              domains: splitList(fields["domains"]),
              ...(fields["nameIdFormat"] ? { name_id_format: fields["nameIdFormat"] } : {}),
            },
          });
          return toSsoProvider(provider, ref, accountId);
        }
        case "supabase-third-party-auth": {
          const url = required(fields["url"], "a URL");
          await this.api.post(`${base}/config/auth/third-party-auth`, {
            body: fields["source"] === "jwks" ? { jwks_url: url } : { oidc_issuer_url: url },
          });
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
          const key = await this.api.post(`${base}/config/auth/signing-keys`, {
            body: {
              algorithm: fields["algorithm"] || "ES256",
              ...(fields["status"] ? { status: fields["status"] } : {}),
            },
          });
          return toSigningKey(key, ref, accountId);
        }
        default:
          throw new Error(`Supabase plugin: cannot create "${typeId}".`);
      }
    });
  }

  private async createProject(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceCreateReturn> {
    const password = fields["dbPassword"] || randomPassword();
    const project = await this.api.post("/v1/projects", {
      body: {
        name: required(fields["name"], "a project name"),
        organization_slug: required(fields["organizationSlug"], "an organization"),
        db_pass: password,
        region_selection: { type: "specific", code: required(fields["region"], "a region") },
        ...(fields["computeSize"] ? { desired_instance_size: fields["computeSize"] } : {}),
      },
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
    return deployFunctionBundle(
      this.ctx,
      `/v1/projects/${pathEncode(ref)}/functions/deploy`,
      slug,
      contentType,
      body,
    );
  }

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const { ref, rest } = splitScoped(externalIdOf(resourceId));
      const base = `/v1/projects/${pathEncode(ref)}` as const;

      switch (typeId) {
        case "supabase-project":
          await this.updateProject(ref, fields);
          break;
        case "supabase-branch": {
          const body: ApiBody<operations["v1-update-a-branch-config"]> = {};
          if (fields["name"]) body["branch_name"] = fields["name"];
          if (fields["gitBranch"] !== undefined) body["git_branch"] = fields["gitBranch"];
          if (bool(fields["persistent"]) !== undefined)
            body["persistent"] = bool(fields["persistent"]);
          if (fields["notifyUrl"] !== undefined) body["notify_url"] = fields["notifyUrl"];
          await this.api.patch(`/v1/branches/${pathEncode(rest)}`, { body });
          break;
        }
        case "supabase-function": {
          const body: ApiBody<operations["v1-update-a-function"]> = {};
          if (fields["name"]) body["name"] = fields["name"];
          if (bool(fields["verifyJwt"]) !== undefined)
            body["verify_jwt"] = bool(fields["verifyJwt"]);
          await this.api.patch(`${base}/functions/${pathEncode(rest)}`, { body });
          break;
        }
        case "supabase-secret":
          if (fields["value"]) {
            // Bulk create upserts: the same call replaces an existing value.
            await this.api.post(`${base}/secrets`, {
              body: [{ name: rest, value: fields["value"] }],
            });
          }
          break;
        case "supabase-api-key":
          if (rest.startsWith("legacy-")) throw new Error("Legacy keys cannot be edited.");
          await this.api.patch(`${base}/api-keys/${pathEncode(rest)}`, {
            body: { description: fields["description"] ?? "" },
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
          const body: ApiBody<operations["v1-update-a-sso-provider"]> = {};
          if (fields["metadataUrl"]) body["metadata_url"] = fields["metadataUrl"];
          if (fields["domains"] !== undefined) body["domains"] = splitList(fields["domains"]);
          if (fields["nameIdFormat"]) body["name_id_format"] = fields["nameIdFormat"];
          await this.api.put(`${base}/config/auth/sso/providers/${pathEncode(rest)}`, { body });
          break;
        }
        case "supabase-signing-key":
          if (fields["status"]) {
            await this.api.patch(`${base}/config/auth/signing-keys/${pathEncode(rest)}`, {
              body: { status: fields["status"] },
            });
          }
          break;
        default:
          throw new Error(`Supabase plugin: cannot update "${typeId}".`);
      }
      return runPluginEffect(this.getResource(typeId, resourceId, accountId));
    });
  }

  /**
   * A size outside the documented add-on variants still reaches here from a change
   * revert or a workflow (a project that was on Nano), so it goes only if Supabase
   * lists that variant for this project.
   */
  private async computeAddonVariant(ref: string, size: string): Promise<string> {
    const variant = `ci_${size}`;
    if (COMPUTE_ADDON_SIZES.includes(size)) return variant;
    const addons = await this.api.get(`/v1/projects/${pathEncode(ref)}/billing/addons`);
    const offered = addons?.available_addons
      .filter((addon) => addon.type === "compute_instance")
      .flatMap((addon) => addon.variants)
      .some((option) => {
        const id: string = option.id;
        return id === variant;
      });
    if (offered) return variant;
    throw new Error(
      `Supabase does not offer ${size} compute for this project. Choose Micro or larger.`,
    );
  }

  private async updateProject(ref: string, fields: Record<string, string>): Promise<void> {
    const base = `/v1/projects/${pathEncode(ref)}` as const;
    // Before the first write, so a refused size leaves the rest of the edit unapplied too.
    const computeVariant = fields["computeSize"]
      ? await this.computeAddonVariant(ref, fields["computeSize"])
      : undefined;

    if (fields["name"]) await this.api.patch(base, { body: { name: fields["name"] } });

    if (computeVariant) {
      await this.api.patch(`${base}/billing/addons`, {
        body: { addon_type: "compute_instance", addon_variant: computeVariant },
      });
    }

    if (fields["pitrDays"] !== undefined && fields["pitrDays"] !== "") {
      if (fields["pitrDays"] === "0") {
        const addons = await this.api.get(`${base}/billing/addons`);
        const current = addons?.selected_addons.find((a) => a.type === "pitr")?.variant.id;
        if (current) await this.api.delete(`${base}/billing/addons/${pathEncode(current)}`);
      } else {
        await this.api.patch(`${base}/billing/addons`, {
          body: { addon_type: "pitr", addon_variant: `pitr_${fields["pitrDays"]}` },
        });
      }
    }

    const ipv4 = bool(fields["ipv4"]);
    if (ipv4 === true) {
      await this.api.patch(`${base}/billing/addons`, {
        body: { addon_type: "ipv4", addon_variant: "ipv4_default" },
      });
    } else if (ipv4 === false) {
      await this.api.delete(`${base}/billing/addons/${pathEncode("ipv4_default")}`);
    }

    if (["diskSizeGb", "diskType", "diskIops", "diskThroughputMbps"].some((k) => fields[k])) {
      const current = await this.api.get(`${base}/config/disk`);
      const attrs: SbDiskAttributes = { ...(current?.attributes ?? {}) };
      if (fields["diskSizeGb"]) attrs["size_gb"] = Number(fields["diskSizeGb"]);
      if (fields["diskType"]) attrs["type"] = fields["diskType"];
      if (fields["diskIops"]) attrs["iops"] = Number(fields["diskIops"]);
      if (fields["diskThroughputMbps"])
        attrs["throughput_mibps"] = Number(fields["diskThroughputMbps"]);
      if (attrs["type"] === "io2") delete attrs["throughput_mibps"];
      await this.api.post(`${base}/config/disk`, { body: { attributes: attrs } });
    }

    const ssl = bool(fields["sslEnforced"]);
    if (ssl !== undefined) {
      await this.api.put(`${base}/ssl-enforcement`, {
        body: { requestedConfig: { database: ssl } },
      });
    }

    if (fields["allowedCidrs"] !== undefined || fields["allowedCidrsV6"] !== undefined) {
      const current = await this.api.get(`${base}/network-restrictions`);
      await this.api.post(`${base}/network-restrictions/apply`, {
        body: {
          dbAllowedCidrs:
            fields["allowedCidrs"] !== undefined
              ? splitList(fields["allowedCidrs"])
              : (current?.config.dbAllowedCidrs ?? []),
          dbAllowedCidrsV6:
            fields["allowedCidrsV6"] !== undefined
              ? splitList(fields["allowedCidrsV6"])
              : (current?.config.dbAllowedCidrsV6 ?? []),
        },
      });
    }

    const pooler: ApiBody<operations["v1-update-pooler-config"]> = {};
    if (fields["poolMode"]) pooler["pool_mode"] = fields["poolMode"];
    if (fields["poolSize"]) pooler["default_pool_size"] = Number(fields["poolSize"]);
    if (Object.keys(pooler).length > 0) {
      await this.api.patch(`${base}/config/database/pooler`, { body: pooler });
    }

    const legacy = bool(fields["legacyApiKeysEnabled"]);
    if (legacy !== undefined) {
      await this.api.put(`${base}/api-keys/legacy`, { query: { enabled: String(legacy) } });
    }
  }

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const { ref, rest } = splitScoped(externalIdOf(resourceId));
      const base = `/v1/projects/${pathEncode(ref)}` as const;
      switch (typeId) {
        case "supabase-project":
          await this.api.delete(base);
          return;
        case "supabase-branch":
          await this.api.delete(`/v1/branches/${pathEncode(rest)}`);
          return;
        case "supabase-function":
          await this.api.delete(`${base}/functions/${pathEncode(rest)}`);
          return;
        case "supabase-secret":
          await this.api.delete(`${base}/secrets`, { body: [rest] });
          return;
        case "supabase-api-key":
          if (rest.startsWith("legacy-")) {
            throw new Error("Legacy keys cannot be deleted; turn them off on the project instead.");
          }
          await this.api.delete(`${base}/api-keys/${pathEncode(rest)}`);
          return;
        case "supabase-bucket":
          await deleteBucket(this.ctx, ref, await this.secretKey(ref), rest);
          return;
        case "supabase-read-replica":
          await this.api.post(`${base}/read-replicas/remove`, {
            body: { database_identifier: rest },
          });
          return;
        case "supabase-sso-provider":
          await this.api.delete(`${base}/config/auth/sso/providers/${pathEncode(rest)}`);
          return;
        case "supabase-third-party-auth":
          await this.api.delete(`${base}/config/auth/third-party-auth/${pathEncode(rest)}`);
          return;
        case "supabase-signing-key":
          await this.api.delete(`${base}/config/auth/signing-keys/${pathEncode(rest)}`);
          return;
        default:
          throw new Error(`Supabase plugin: "${typeId}" cannot be deleted.`);
      }
    });
  }

  // ---- actions -----------------------------------------------------------------

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const { ref, rest } = splitScoped(externalIdOf(resourceId));
      const base = `/v1/projects/${pathEncode(ref)}` as const;

      if (typeId === "supabase-project") {
        switch (actionId) {
          case "pause":
            await this.api.post(`${base}/pause`);
            return;
          case "restore":
            await this.api.post(`${base}/restore`);
            return;
          case "restart":
            await this.api.post(`${base}/restart`);
            return;
          case "reset-db-password":
            await this.resetDbPassword(resourceId);
            return;
          case "disable-readonly":
            await this.api.post(`${base}/readonly/temporary-disable`);
            return;
          case "reverify-custom-hostname":
            await this.api.post(`${base}/custom-hostname/reverify`);
            return;
          case "activate-custom-hostname":
            await this.api.post(`${base}/custom-hostname/activate`);
            return;
          case "unban-all": {
            const bans = await this.api.post(`${base}/network-bans/retrieve`);
            const ips = bans?.banned_ipv4_addresses ?? [];
            if (ips.length > 0) {
              await this.api.delete(`${base}/network-bans`, { body: { ipv4_addresses: ips } });
            }
            return;
          }
          case "upgrade-postgres": {
            const eligibility = await this.api.get(`${base}/upgrade/eligibility`);
            const target = eligibility?.target_upgrade_versions.at(-1);
            if (!eligibility?.eligible || !target) {
              throw new Error(
                "Supabase reports this project is not eligible for an upgrade right now.",
              );
            }
            await this.api.post(`${base}/upgrade`, {
              body: {
                target_version: target.postgres_version,
                release_channel: target.release_channel,
              },
            });
            return;
          }
        }
      }

      if (typeId === "supabase-branch") {
        const path = `/v1/branches/${pathEncode(rest)}` as const;
        switch (actionId) {
          case "push":
            await this.api.post(`${path}/push`, { body: {} });
            return;
          case "merge":
            await this.api.post(`${path}/merge`, { body: {} });
            return;
          case "reset":
            await this.api.post(`${path}/reset`, { body: {} });
            return;
          case "restore-branch":
            await this.api.post(`${path}/restore`);
            return;
        }
      }

      if (typeId === "supabase-bucket" && actionId === "empty") {
        await emptyBucket(this.ctx, ref, await this.secretKey(ref), rest);
        return;
      }

      if (
        typeId === "supabase-signing-key" &&
        (actionId === "rotate-in" || actionId === "revoke")
      ) {
        await this.api.patch(`${base}/config/auth/signing-keys/${pathEncode(rest)}`, {
          body: { status: actionId === "rotate-in" ? "in_use" : "revoked" },
        });
        return;
      }

      throw new Error(`Supabase plugin: unknown action "${actionId}" for "${typeId}".`);
    });
  }

  // ---- storage browser ---------------------------------------------------------

  listStorageObjects(bucket: string, prefix: string): PluginEffect<StorageObject[]> {
    return attempt(async () => {
      const { ref, bucket: id } = parseBucketHandle(bucket);
      return listObjects(this.ctx, ref, await this.secretKey(ref), id, prefix);
    });
  }

  uploadStorageObject(
    bucket: string,
    key: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): PluginEffect<void> {
    return attempt(async () => {
      const { ref, bucket: id } = parseBucketHandle(bucket);
      const data = new Uint8Array(await file.arrayBuffer());
      await uploadObject(this.ctx, ref, await this.secretKey(ref), id, key, data, file.type);
      onProgress?.(100);
    });
  }

  makeStorageFolder(bucket: string, key: string): PluginEffect<void> {
    return attempt(async () => {
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
    });
  }

  deleteStorageObject(bucket: string, key: string): PluginEffect<void> {
    return attempt(async () => {
      const { ref, bucket: id } = parseBucketHandle(bucket);
      await deleteObject(this.ctx, ref, await this.secretKey(ref), id, key);
    });
  }

  // ---- observability -----------------------------------------------------------

  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      const { ref, rest } = splitScoped(externalIdOf(resourceId));
      if (resourceTypeId === "supabase-project")
        return fetchProjectMetrics(this.ctx, ref, timeRange);
      if (resourceTypeId === "supabase-function") {
        const fn = await this.api.get(
          `/v1/projects/${pathEncode(ref)}/functions/${pathEncode(rest)}`,
        );
        return fn?.id ? fetchFunctionMetrics(this.ctx, ref, fn.id, timeRange) : [];
      }
      return [];
    });
  }

  getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): PluginEffect<LogsFetchResult> {
    return attempt(async () => {
      const { ref, rest } = splitScoped(externalIdOf(resourceId));
      if (typeId === "supabase-project") return fetchProjectLogs(this.ctx, ref, params);
      if (typeId === "supabase-function") {
        const fn = await this.api.get(
          `/v1/projects/${pathEncode(ref)}/functions/${pathEncode(rest)}`,
        );
        return fetchFunctionLogs(this.ctx, ref, fn.id, params);
      }
      return { text: "", containers: [], activeContainer: "" };
    });
  }

  fetchCostData(_accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      return fetchSupabaseCostData(this.ctx, await fetchProjects(this.ctx), range);
    });
  }

  fetchQuotas(_accountId: string): PluginEffect<QuotaUsage[]> {
    return attempt(async () => {
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
    });
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
