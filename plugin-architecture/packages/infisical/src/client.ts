import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
import type {
  CreateFieldConfig,
  CreateResourceConfig,
  CredentialExport,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  PreflightCapabilityCheck,
  PreflightResult,
  ResourceInstance,
  SelectOption,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import {
  externalIdOf,
  ListTruncatedError,
  pathEncode,
  reportUnreadListPart,
  requireListPage,
  type UnreadListPart,
} from "@infrawrench/plugin-base";
import { InfisicalApi, readCredentials } from "./api.js";
import { messageOf, statusOf } from "./http.js";
import type {
  AuditLogQuery,
  CertificateAltNames,
  InfAuditLog,
  InfCa,
  InfCertificate,
  InfCertificateProfile,
  InfClientSecret,
  InfDynamicSecret,
  InfEnvironment,
  InfFolder,
  InfIdentityMembership,
  InfIntegration,
  InfLease,
  InfProject,
  InfRole,
  InfSecret,
  InfSecretSync,
  InfSecretWrite,
  InfSyncOption,
  InfUniversalAuth,
  ProjectIdentity,
  UpdateDynamicSecretData,
  UpdateEnvironmentBody,
  UpdateIdentityBody,
  UpdateProjectBody,
  UpdateSecretBody,
  UpdateSecretSyncBody,
  UpdateUniversalAuthBody,
} from "./types.js";
import { renderDetail, renderSidebarItem } from "./render.js";

const PLUGIN_ID = "infisical";

const VENDOR = "Infisical";

/** What Infisical's source writes in `secretValue` for a value the identity may not read. */
const HIDDEN_VALUE_MASK = "<hidden-by-infisical>";

/** Cap on audit-log pages (1000 events each) read for one metrics window. */
const MAX_AUDIT_PAGES = 5;
const AUDIT_PAGE_SIZE = 1000;
/**
 * Infisical Cloud allows 200 reads and 120 secret reads a minute on its Free plan and 350 and
 * 300 on Pro, and a sync runs every 15 seconds. So one poll reads a type's children for at most
 * this many projects or environments, a request each, and a rotating run of them past that.
 */
const MAX_PARENT_READS = 50;
/** Folder paths one poll probes for dynamic secrets, across every environment, at a request each. */
const MAX_DYNAMIC_SECRET_PATHS = 40;
const IDENTITY_SEARCH_PAGE_SIZE = 100;
const MAX_IDENTITY_SEARCH_PAGES = 100;
const CERTIFICATE_PAGE_SIZE = 100;
/** 50,000 rows: certificates are short-lived, so a project can hold many. */
const MAX_CERTIFICATE_PAGES = 500;
/**
 * Only the single-environment route has a position, and Infisical writes an audit event for
 * every read of it, so one per environment on each 15-second sync would fill the customer's
 * audit log. An hour of staleness in a listing costs little: a single read is always fresh.
 * Module-level because hosts build a fresh client per call.
 */
const POSITION_TTL_MS = 60 * 60_000;
const POSITION_READERS = 4;
const positions = new Map<string, { at: number; position: number }>();
/** The Metrics tab's default window. */
export const METRICS_DEFAULT_RANGE_MS = 24 * 60 * 60 * 1000;
const METRIC_BUCKETS = 48;

/** Built-in organization roles every org has, ahead of custom roles. */
const BUILTIN_ORG_ROLES: SelectOption[] = [
  { id: "admin", label: "Admin" },
  { id: "member", label: "Member" },
  { id: "no-access", label: "No access" },
];

/** Built-in project roles. */
const BUILTIN_PROJECT_ROLES: SelectOption[] = [
  { id: "admin", label: "Admin" },
  { id: "member", label: "Developer" },
  { id: "viewer", label: "Viewer" },
  { id: "no-access", label: "No access" },
];

const PROJECT_FLAGS = ["hasDeleteProtection", "autoCapitalization", "secretSharing"] as const;
const UNIVERSAL_AUTH_LIMITS = [
  "accessTokenTTL",
  "accessTokenMaxTTL",
  "accessTokenNumUsesLimit",
] as const;

const READ_EVENTS = new Set(["get-secrets", "get-secret", "reveal-secret"]);
const WRITE_EVENTS = new Set([
  "create-secret",
  "create-secrets",
  "update-secret",
  "update-secrets",
  "delete-secret",
  "delete-secrets",
  "move-secrets",
  "duplicate-secret",
]);

function str(value: string | number | boolean | null | undefined): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function bool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return value === "true" || value === "1" || value === "yes";
}

function joinPath(parent: string, name: string): string {
  const base = parent && parent !== "/" ? parent.replace(/\/+$/, "") : "";
  return `${base}/${name}`;
}

/** The full path of a folder from a recursive listing rooted at "/". */
function folderPath(folder: InfFolder): string {
  if (folder.path) return folder.path;
  const name = str(folder.name);
  const rel = str(folder.relativePath);
  if (!rel || rel === "/") return joinPath("/", name);
  if (rel.endsWith(`/${name}`)) return rel.startsWith("/") ? rel : `/${rel}`;
  return joinPath(rel.startsWith("/") ? rel : `/${rel}`, name);
}

function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

function split(externalId: string, parts: number, what: string): string[] {
  const out = externalId.split("/");
  if (out.length !== parts || out.some((part) => !part)) {
    throw new Error(`Infisical plugin: malformed ${what} id "${externalId}"`);
  }
  return out;
}

/**
 * The answer that means an identity sees none of something: it has no access, or the
 * thing went away mid-sync. Anything else leaves the list unknown, and reading that as
 * empty would prune everything stored under it.
 */
function meansNone(error: unknown): boolean {
  const status = statusOf(error);
  return status === 403 || status === 404;
}

interface EnvPair {
  project: InfProject;
  env: InfEnvironment;
}

/**
 * How the id of every dynamic secret row in an environment begins, or in one folder of it:
 * `mapDynamicSecret` encodes the path, so no other folder's rows share the prefix.
 */
function dynamicSecretRowPrefix(
  accountId: string,
  project: InfProject,
  env: InfEnvironment,
  path?: string,
): string {
  const at = `${accountId}:dynamic-secret:${str(project.id)}/${str(env.slug)}/`;
  return path === undefined ? at : `${at}${encodeURIComponent(path)}/`;
}

/**
 * Up to `size` of `items` from a random start, wrapping, and the rest. A random start needs no
 * state between polls and still reaches every item over a few of them.
 */
function rotatingRun<I>(items: I[], size: number): { now: I[]; later: I[] } {
  if (items.length <= size) return { now: items, later: [] };
  const start = Math.floor(Math.random() * items.length);
  const turn = [...items.slice(start), ...items.slice(0, start)];
  return { now: turn.slice(0, size), later: turn.slice(size) };
}

function notFound(what: string, id: string): Error {
  return Object.assign(new Error(`Infisical plugin: ${what} "${id}" not found`), { status: 404 });
}

/** A create-form location: `{projectId}|{environment slug}|{folder path}`. */
function encodeLocation(projectId: string, env: string, path: string): string {
  return `${projectId}|${env}|${path}`;
}

function decodeLocation(value: string): { projectId: string; env: string; path: string } {
  const [projectId = "", env = "", path = "/"] = value.split("|");
  if (!projectId || !env) throw new Error("Infisical plugin: choose an environment and folder");
  return { projectId, env, path: path || "/" };
}

export class InfisicalClient implements PluginClient {
  readonly api: InfisicalApi;
  private projectsCache: { at: number; value: Promise<InfProject[]> } | null = null;
  private orgIdCache: Promise<string> | null = null;
  private syncOptionsCache: Promise<InfSyncOption[]> | null = null;

  constructor(credentials: Credentials, services?: HostServices) {
    this.api = new InfisicalApi(readCredentials(credentials), services);
  }

  // -------------------------------------------------------------------------
  // Shared lookups
  // -------------------------------------------------------------------------

  async projects(): Promise<InfProject[]> {
    if (!this.projectsCache || Date.now() - this.projectsCache.at > 60_000) {
      const path = "/api/v1/projects";
      const value = this.api.rest
        .get(path)
        .then((body) => requireListPage(body.projects, { vendor: VENDOR, path, key: "projects" }));
      value.catch(() => {
        this.projectsCache = null;
      });
      this.projectsCache = { at: Date.now(), value };
    }
    return this.projectsCache.value;
  }

  private async secretProjects(): Promise<InfProject[]> {
    return (await this.projects()).filter((p) => !p.type || p.type === "secret-manager");
  }

  private async certProjects(): Promise<InfProject[]> {
    return (await this.projects()).filter((p) => p.type === "cert-manager");
  }

  private async project(projectId: string): Promise<InfProject> {
    const cached = (await this.projects()).find((p) => p.id === projectId);
    if (cached) return cached;
    const body = await this.api.rest.get(`/api/v1/projects/${pathEncode(projectId)}`);
    if (!body.project) throw notFound("project", projectId);
    return body.project;
  }

  /** The organization the machine identity belongs to (needed for identity listings). */
  async orgId(): Promise<string> {
    this.orgIdCache ??= this.api.rest.get("/api/v1/identities/details").then((body) => {
      const id = str(body.identityDetails?.organization?.id);
      if (!id) throw new Error("Infisical plugin: could not determine the organization");
      return id;
    });
    this.orgIdCache.catch(() => {
      this.orgIdCache = null;
    });
    return this.orgIdCache;
  }

  private async syncOptions(): Promise<InfSyncOption[]> {
    this.syncOptionsCache ??= this.api.rest
      .get("/api/v1/secret-syncs/options")
      .then((body) => body.secretSyncOptions ?? [])
      .catch((): InfSyncOption[] => []);
    return this.syncOptionsCache;
  }

  /**
   * Run `load` per item. An item the identity may not read must not fail a listing, and its
   * stored rows stay, since a refusal says nothing about what is there. Any other failure fails
   * the listing: its rows would be read as deleted. `unread` names what some items hold.
   *
   * Past `maxReads` items it reads a rotating run of them and names the rest, whose rows go
   * stale until a later poll reaches them rather than being pruned.
   */
  private async each<I, T>(
    items: I[],
    label: (item: I) => string,
    unread: (items: I[]) => UnreadListPart,
    load: (item: I) => Promise<T[]>,
    maxReads = MAX_PARENT_READS,
  ) {
    const { now, later } = rotatingRun(items, maxReads);
    if (later.length > 0) reportUnreadListPart(unread(later));
    const settled = await Promise.allSettled(now.map((item) => load(item)));
    const out: T[] = [];
    const refused: I[] = [];
    let refusal: unknown;
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") out.push(...result.value);
      else if (meansNone(result.reason)) {
        const item = now[index]!;
        console.warn(`Infisical plugin: skipping ${label(item)}: ${String(result.reason)}`);
        if (statusOf(result.reason) === 403) {
          refused.push(item);
          refusal = result.reason;
        }
      } else throw result.reason;
    });
    // A host that keeps no track keeps nothing, so a refusal of everything shows there.
    if (
      refused.length > 0 &&
      !reportUnreadListPart(unread(refused)) &&
      refused.length === now.length
    ) {
      throw refusal;
    }
    return out;
  }

  private envPairs(projects: InfProject[]): EnvPair[] {
    return projects.flatMap((project) =>
      (project.environments ?? []).map((env) => ({ project, env })),
    );
  }

  private positionKey(envId: string | undefined): string {
    return `${this.api.siteUrl}/${str(envId)}`;
  }

  private async readPosition(projectId: string, envId: string): Promise<void> {
    const body = await this.api.rest.get(
      `/api/v1/projects/${pathEncode(projectId)}/environments/${pathEncode(envId)}`,
    );
    const position = body.environment?.position;
    if (typeof position === "number") {
      positions.set(this.positionKey(envId), { at: Date.now(), position });
    }
  }

  /** The row, with the position it has or the last one read. */
  private positioned(env: InfEnvironment): InfEnvironment {
    if (typeof env.position === "number") return env;
    const known = positions.get(this.positionKey(env.id));
    return known ? { ...env, position: known.position } : env;
  }

  /**
   * Never fails a listing. A failed read keeps the last position, so a blip does not read as
   * a change to the environment, and a 429 leaves the rest for the next sync.
   */
  private async refreshPositions(
    pairs: Array<{ project: InfProject; env: InfEnvironment }>,
  ): Promise<void> {
    const due = pairs.filter(({ env }) => {
      if (typeof env.position === "number") return false;
      const known = positions.get(this.positionKey(env.id));
      return !known || Date.now() - known.at > POSITION_TTL_MS;
    });
    let next = 0;
    let limited = false;
    const reader = async () => {
      while (!limited && next < due.length) {
        const { project, env } = due[next++]!;
        await this.readPosition(str(project.id), str(env.id)).catch((error: unknown) => {
          if (statusOf(error) === 429) limited = true;
        });
      }
    };
    await Promise.all(Array.from({ length: POSITION_READERS }, reader));
  }

  private async foldersIn(projectId: string, env: string): Promise<InfFolder[]> {
    const path = "/api/v2/folders";
    const body = await this.api.rest.get(path, {
      query: { projectId, environment: env, path: "/", recursive: true },
    });
    return requireListPage(body.folders, { vendor: VENDOR, path, key: "folders" });
  }

  private async secretsIn(projectId: string, env: string, path = "/", recursive = true) {
    const route = "/api/v4/secrets";
    const body = await this.api.rest.get(route, {
      query: {
        projectId,
        environment: env,
        secretPath: path,
        recursive: recursive ? "true" : "false",
        viewSecretValue: "false",
        expandSecretReferences: "false",
        includeImports: "false",
      },
    });
    return requireListPage(body.secrets, { vendor: VENDOR, path: route, key: "secrets" });
  }

  private async dynamicSecretsAt(projectSlug: string, env: string, path: string) {
    const route = "/api/v1/dynamic-secrets";
    const body = await this.api.rest.get(route, {
      query: { projectSlug, environmentSlug: env, path },
    });
    return requireListPage(body.dynamicSecrets, {
      vendor: VENDOR,
      path: route,
      key: "dynamicSecrets",
    });
  }

  private async syncsIn(projectId: string): Promise<InfSecretSync[]> {
    const path = "/api/v1/secret-syncs";
    const body = await this.api.rest.get(path, { query: { projectId } });
    return requireListPage(body.secretSyncs, { vendor: VENDOR, path, key: "secretSyncs" });
  }

  private async identities(): Promise<InfIdentityMembership[]> {
    const orgId = await this.orgId();
    const path = "/api/v1/identities";
    const body = await this.api.rest.get(path, { query: { orgId } });
    return requireListPage(body.identities, { vendor: VENDOR, path, key: "identities" });
  }

  /**
   * The rows of `GET /identities` have no lockouts; the search's do. The listing stays the word
   * on which identities exist, so a search that fails costs this sync the status, not the rows.
   */
  private async identityLockouts(): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    try {
      for (let page = 0; page < MAX_IDENTITY_SEARCH_PAGES; page++) {
        const body = await this.api.rest.post("/api/v1/identities/search", {
          body: { limit: IDENTITY_SEARCH_PAGE_SIZE, offset: page * IDENTITY_SEARCH_PAGE_SIZE },
        });
        const rows = body.identities ?? [];
        for (const row of rows) {
          out.set(str(row.identity?.id), row.identity?.activeLockoutAuthMethods ?? []);
        }
        if (rows.length < IDENTITY_SEARCH_PAGE_SIZE || out.size >= body.totalCount) break;
      }
    } catch (error) {
      console.warn(`Infisical plugin: could not read identity lockouts: ${String(error)}`);
    }
    return out;
  }

  /**
   * Infisical's source refuses an offset past 100 on this route, so a project with more than
   * 200 certificate authorities fails with its 400 here rather than reading short.
   */
  private async casIn(projectId: string): Promise<InfCa[]> {
    return this.api.lists.getAll(`/api/v1/projects/${pathEncode(projectId)}/cas`, "cas");
  }

  private async certificatesIn(projectId: string): Promise<InfCertificate[]> {
    const path = `/api/v1/projects/${pathEncode(projectId)}/certificates/search` as const;
    const out: InfCertificate[] = [];
    for (let page = 0; page < MAX_CERTIFICATE_PAGES; page++) {
      const body = await this.api.rest.post(path, {
        body: { offset: page * CERTIFICATE_PAGE_SIZE, limit: CERTIFICATE_PAGE_SIZE },
      });
      const rows = requireListPage(body.certificates, {
        vendor: VENDOR,
        path,
        key: "certificates",
      });
      out.push(...rows);
      if (
        rows.length < CERTIFICATE_PAGE_SIZE ||
        (body.totalCount !== undefined && out.length >= body.totalCount)
      ) {
        return out;
      }
    }
    throw new ListTruncatedError({
      vendor: VENDOR,
      path,
      items: out.length,
      maxPages: MAX_CERTIFICATE_PAGES,
    });
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      const underProjects = (projects: InfProject[]): UnreadListPart => ({
        parentResourceIds: projects.map((p) => `${accountId}:project:${str(p.id)}`),
      });
      const underEnvironments = (pairs: EnvPair[]): UnreadListPart => ({
        parentResourceIds: pairs.map(
          ({ project, env }) => `${accountId}:environment:${str(project.id)}/${str(env.id)}`,
        ),
      });
      switch (typeId) {
        case "project":
          return (await this.projects()).map((p) => this.mapProject(accountId, p));
        case "environment": {
          const pairs = this.envPairs(await this.projects());
          await this.refreshPositions(pairs);
          return pairs.map(({ project, env }) =>
            this.mapEnvironment(accountId, project, this.positioned(env)),
          );
        }
        case "folder":
          return this.each(
            this.envPairs(await this.secretProjects()),
            ({ project, env }) => `${str(project.slug)}/${str(env.slug)}`,
            underEnvironments,
            async ({ project, env }) =>
              (await this.foldersIn(str(project.id), str(env.slug))).map((folder) =>
                this.mapFolder(accountId, str(project.id), env, folder),
              ),
          );
        case "secret":
          return this.each(
            this.envPairs(await this.secretProjects()),
            ({ project, env }) => `${str(project.slug)}/${str(env.slug)}`,
            underEnvironments,
            async ({ project, env }) =>
              (await this.secretsIn(str(project.id), str(env.slug)))
                .filter((secret) => !secret.type || secret.type === "shared")
                .map((secret) => this.mapSecret(accountId, project, secret)),
          );
        case "dynamic-secret": {
          // The route takes one folder and is not recursive, so each path is its own read.
          const located = await this.each(
            this.envPairs(await this.secretProjects()),
            ({ project, env }) => `${str(project.slug)}/${str(env.slug)}`,
            underEnvironments,
            async ({ project, env }) => {
              const folders = await this.foldersIn(str(project.id), str(env.slug)).catch(
                (error: unknown): InfFolder[] => {
                  // Which folders there are is unknown, so the environment's rows stay.
                  if (statusOf(error) === 403) {
                    reportUnreadListPart({
                      idPrefixes: [dynamicSecretRowPrefix(accountId, project, env)],
                    });
                  }
                  if (meansNone(error)) return [];
                  throw error;
                },
              );
              return ["/", ...folders.map(folderPath)].map((path) => ({ project, env, path }));
            },
          );
          return this.each(
            located,
            ({ project, env, path }) => `${str(project.slug)}/${str(env.slug)}:${path}`,
            (refused) => ({
              idPrefixes: refused.map(({ project, env, path }) =>
                dynamicSecretRowPrefix(accountId, project, env, path),
              ),
            }),
            async ({ project, env, path }) =>
              (await this.dynamicSecretsAt(str(project.slug), str(env.slug), path)).map((ds) =>
                this.mapDynamicSecret(accountId, project, env, path, ds),
              ),
            MAX_DYNAMIC_SECRET_PATHS,
          );
        }
        case "secret-sync": {
          const options = await this.syncOptions();
          return this.each(
            await this.secretProjects(),
            (p) => str(p.slug),
            underProjects,
            async (p) =>
              (await this.syncsIn(str(p.id))).map((sync) => this.mapSync(accountId, sync, options)),
          );
        }
        case "integration":
          return this.each(
            await this.secretProjects(),
            (p) => str(p.slug),
            underProjects,
            async (p) => {
              const path = `/api/v1/projects/${pathEncode(str(p.id))}/integrations` as const;
              const body = await this.api.rest.get(path);
              return requireListPage(body.integrations, {
                vendor: VENDOR,
                path,
                key: "integrations",
              }).map((i) => this.mapIntegration(accountId, str(p.id), i));
            },
          );
        case "machine-identity": {
          const identities = await this.identities();
          const lockouts = await this.identityLockouts();
          return identities.map((m) =>
            this.mapIdentity(accountId, {
              ...m,
              identity: {
                ...m.identity,
                activeLockoutAuthMethods:
                  lockouts.get(str(m.identity?.id)) ?? m.identity?.activeLockoutAuthMethods ?? [],
              },
            }),
          );
        }
        case "certificate-authority":
          return this.each(
            await this.certProjects(),
            (p) => str(p.slug),
            underProjects,
            async (p) =>
              (await this.casIn(str(p.id))).map((ca) => this.mapCa(accountId, ca, str(p.id))),
          );
        case "certificate":
          return this.each(
            await this.certProjects(),
            (p) => str(p.slug),
            underProjects,
            async (p) =>
              (await this.certificatesIn(str(p.id))).map((c) =>
                this.mapCertificate(accountId, c, str(p.id)),
              ),
          );
        default:
          throw new Error(`Infisical plugin: unknown resource type "${typeId}"`);
      }
    });
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
      const id = externalIdOf(resourceId);
      switch (typeId) {
        case "project": {
          const body = await this.api.rest.get(`/api/v1/projects/${pathEncode(id)}`);
          if (!body.project) throw notFound("project", id);
          return this.mapProject(accountId, body.project);
        }
        case "environment": {
          const [projectId = "", envId = ""] = split(id, 2, "environment");
          const project = await this.project(projectId);
          const env = (project.environments ?? []).find((e) => e.id === envId);
          if (!env) throw notFound("environment", id);
          // The position is a detail of a read that works without it.
          await this.readPosition(projectId, envId).catch(() => undefined);
          return this.mapEnvironment(accountId, project, this.positioned(env));
        }
        case "folder": {
          const [projectId = "", envSlug = "", folderId = ""] = split(id, 3, "folder");
          const body = await this.api.rest.get(`/api/v2/folders/${pathEncode(folderId)}`);
          if (!body.folder) throw notFound("folder", id);
          const project = await this.project(projectId);
          const env = (project.environments ?? []).find((e) => e.slug === envSlug) ?? {
            slug: envSlug,
          };
          return this.mapFolder(accountId, projectId, env, body.folder);
        }
        case "secret": {
          const secret = await this.fetchSecret(id);
          const project = await this.project(str(secret.workspace));
          return this.mapSecret(accountId, project, secret);
        }
        case "dynamic-secret": {
          const ref = this.dynamicRef(id);
          const project = await this.project(ref.projectId);
          const body = await this.api.rest.get(`/api/v1/dynamic-secrets/${pathEncode(ref.name)}`, {
            query: { projectSlug: str(project.slug), environmentSlug: ref.env, path: ref.path },
          });
          if (!body.dynamicSecret) throw notFound("dynamic secret", id);
          const env = (project.environments ?? []).find((e) => e.slug === ref.env) ?? {
            slug: ref.env,
          };
          return this.mapDynamicSecret(accountId, project, env, ref.path, body.dynamicSecret);
        }
        case "secret-sync": {
          const [destination = "", syncId = ""] = split(id, 2, "secret sync");
          const body = await this.api.rest.get(
            `/api/v1/secret-syncs/${pathEncode(destination)}/${pathEncode(syncId)}`,
          );
          if (!body.secretSync) throw notFound("secret sync", id);
          return this.mapSync(accountId, body.secretSync, await this.syncOptions());
        }
        case "integration": {
          const body = await this.api.rest.get(`/api/v1/integration/${pathEncode(id)}`);
          if (!body.integration) throw notFound("integration", id);
          const integration: InfIntegration = body.integration;
          return this.mapIntegration(
            accountId,
            str(integration.projectId) || (await this.projectOfEnvironment(integration)),
            integration,
          );
        }
        case "machine-identity": {
          const body = await this.api.rest.get(`/api/v1/identities/${pathEncode(id)}`);
          if (!body.identity) throw notFound("machine identity", id);
          return this.mapIdentity(accountId, body.identity);
        }
        case "certificate-authority": {
          const body = await this.api.rest.get(`/api/v1/pki/ca/${pathEncode(id)}`);
          if (!body.ca) throw notFound("certificate authority", id);
          return this.mapCa(accountId, body.ca, str(body.ca.projectId));
        }
        case "certificate":
          return this.readCertificate(accountId, id);
        default:
          throw new Error(`Infisical plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  private async readCertificate(
    accountId: string,
    id: string,
    knownProjectId?: string,
  ): Promise<ResourceInstance> {
    const body = await this.api.rest.get(`/api/v1/cert-manager/certificates/${pathEncode(id)}`);
    if (!body.certificate) throw notFound("certificate", id);
    const certificate: InfCertificate = body.certificate;
    const projectId =
      str(certificate.projectId) || knownProjectId || (await this.certificateProject(certificate));
    return this.mapCertificate(accountId, certificate, projectId);
  }

  /**
   * The document gives a certificate read by id no project; only the search row has one. The
   * search takes a serial number, so this finds the row in whichever project holds it. Finding
   * nothing costs the certificate its parent, never the read.
   */
  private async certificateProject(certificate: InfCertificate): Promise<string> {
    const search = str(certificate.serialNumber);
    if (!search) return "";
    for (const project of await this.certProjects().catch((): InfProject[] => [])) {
      const body = await this.api.rest
        .post(`/api/v1/projects/${pathEncode(str(project.id))}/certificates/search`, {
          body: { search, limit: CERTIFICATE_PAGE_SIZE },
        })
        .catch((): { certificates?: InfCertificate[] } => ({}));
      const row = (body.certificates ?? []).find((c) => c.id === certificate.id);
      if (row) return str(row.projectId) || str(project.id);
    }
    return "";
  }

  /** The document gives an integration no project, only its environment, which names one. */
  private async projectOfEnvironment(integration: InfIntegration): Promise<string> {
    const envId = str(integration.envId) || str(integration.environment?.id);
    if (!envId) return "";
    const projects = await this.projects().catch((): InfProject[] => []);
    const project = projects.find((p) => (p.environments ?? []).some((e) => e.id === envId));
    return str(project?.id);
  }

  private async fetchSecret(secretId: string): Promise<InfSecret> {
    const body = await this.api.rest.get(`/api/v4/secrets/id/${pathEncode(secretId)}`);
    if (!body.secret) throw notFound("secret", secretId);
    return body.secret;
  }

  /** `{projectId}/{env}/{encoded path}/{name}` → parts. */
  private dynamicRef(externalId: string) {
    const [projectId = "", env = "", encodedPath = "", name = ""] = split(
      externalId,
      4,
      "dynamic secret",
    );
    return { projectId, env, path: decodeURIComponent(encodedPath), name };
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      if (typeId === "secret" && outputKey === "value") {
        const secret = await this.fetchSecret(id);
        // The document has `secretValueHidden` only on the listing, so the mask counts too.
        if (secret.secretValueHidden || secret.secretValue === HIDDEN_VALUE_MASK) {
          throw Object.assign(
            new Error("Infisical plugin: the machine identity may not read this secret's value"),
            { status: 403 },
          );
        }
        return str(secret.secretValue);
      }
      if (typeId === "machine-identity" && outputKey === "clientId") {
        const ua = await this.universalAuth(id);
        if (!ua?.clientId)
          throw new Error("Infisical plugin: Universal Auth is not enabled on this identity");
        return ua.clientId;
      }
      if (typeId === "certificate-authority" && outputKey === "certificate") {
        const body = await this.api.rest.get(`/api/v1/pki/ca/${pathEncode(id)}/certificate`);
        return [str(body.certificate), str(body.certificateChain)].filter(Boolean).join("\n");
      }
      if (typeId === "certificate" && outputKey === "certificate") {
        const body = await this.api.rest.get(
          `/api/v1/cert-manager/certificates/${pathEncode(id)}/certificate`,
        );
        return [str(body.certificate), str(body.certificateChain)].filter(Boolean).join("\n");
      }
      const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const value = resource.resolvedOutputs[outputKey];
      if (value !== undefined) return value;
      throw new Error(
        `Infisical plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
      );
    });
  }

  private async universalAuth(identityId: string): Promise<InfUniversalAuth | null> {
    try {
      const body = await this.api.rest.get(
        `/api/v1/auth/universal-auth/identities/${pathEncode(identityId)}`,
      );
      return body.identityUniversalAuth ?? null;
    } catch (error) {
      const status = statusOf(error);
      if (status === 404 || status === 400) return null;
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  private instance(
    accountId: string,
    typeId: string,
    externalId: string,
    displayName: string,
    fields: ResourceInstance["fields"],
    extra: Partial<ResourceInstance> & { createdAt?: string; updatedAt?: string } = {},
  ): ResourceInstance {
    const createdAt = extra.createdAt || new Date(0).toISOString();
    return {
      id: `${accountId}:${typeId}:${externalId}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: typeId,
      accountId,
      displayName: displayName || externalId,
      externalId,
      fields,
      resolvedOutputs: extra.resolvedOutputs ?? {},
      secretStates: [],
      ...(extra.parentResourceId ? { parentResourceId: extra.parentResourceId } : {}),
      createdAt,
      updatedAt: extra.updatedAt || createdAt,
    };
  }

  mapProject(accountId: string, p: InfProject): ResourceInstance {
    const id = str(p.id);
    return this.instance(
      accountId,
      "project",
      id,
      str(p.name),
      {
        name: str(p.name),
        slug: str(p.slug),
        description: str(p.description),
        type: str(p.type) || "secret-manager",
        projectId: id,
        environments: (p.environments ?? []).map((e) => str(e.slug)).join(", "),
        hasDeleteProtection: p.hasDeleteProtection === true,
        autoCapitalization: p.autoCapitalization === true,
        secretSharing: p.secretSharing !== false,
        ...(typeof p.pitVersionLimit === "number" ? { pitVersionLimit: p.pitVersionLimit } : {}),
        createdAt: str(p.createdAt),
      },
      {
        resolvedOutputs: {
          projectId: id,
          slug: str(p.slug),
          __environments__: JSON.stringify(p.environments ?? []),
        },
        ...(p.createdAt ? { createdAt: p.createdAt } : {}),
        ...(p.updatedAt ? { updatedAt: p.updatedAt } : {}),
      },
    );
  }

  mapEnvironment(accountId: string, project: InfProject, env: InfEnvironment): ResourceInstance {
    const projectId = str(project.id);
    return this.instance(
      accountId,
      "environment",
      `${projectId}/${str(env.id)}`,
      `${str(project.name)} / ${str(env.name) || str(env.slug)}`,
      {
        name: str(env.name),
        slug: str(env.slug),
        ...(typeof env.position === "number" ? { position: env.position } : {}),
        projectId,
        projectName: str(project.name),
        projectSlug: str(project.slug),
      },
      {
        parentResourceId: `${accountId}:project:${projectId}`,
        resolvedOutputs: { environmentSlug: str(env.slug), environmentId: str(env.id) },
        ...(project.createdAt ? { createdAt: project.createdAt } : {}),
      },
    );
  }

  mapFolder(
    accountId: string,
    projectId: string,
    env: InfEnvironment,
    folder: InfFolder,
  ): ResourceInstance {
    const path = folderPath(folder);
    const envSlug = str(env.slug) || str(folder.environment?.slug);
    const envId = str(env.id) || str(folder.envId) || str(folder.environment?.id);
    return this.instance(
      accountId,
      "folder",
      `${projectId}/${envSlug}/${str(folder.id)}`,
      `${envSlug}:${path}`,
      {
        name: str(folder.name),
        path,
        description: str(folder.description),
        environment: envSlug,
        projectId,
        lastSecretModified: str(folder.lastSecretModified),
        createdAt: str(folder.createdAt),
      },
      {
        ...(envId ? { parentResourceId: `${accountId}:environment:${projectId}/${envId}` } : {}),
        resolvedOutputs: { path },
        ...(folder.createdAt ? { createdAt: folder.createdAt } : {}),
        ...(folder.updatedAt ? { updatedAt: folder.updatedAt } : {}),
      },
    );
  }

  mapSecret(accountId: string, project: InfProject, secret: InfSecret): ResourceInstance {
    const projectId = str(secret.workspace) || str(project.id);
    const envSlug = str(secret.environment);
    const env = (project.environments ?? []).find((e) => e.slug === envSlug);
    const path = str(secret.secretPath) || "/";
    const key = str(secret.secretKey);
    return this.instance(
      accountId,
      "secret",
      str(secret.id),
      `${key} (${envSlug}${path === "/" ? "" : `:${path}`})`,
      {
        key,
        comment: str(secret.secretComment),
        path,
        environment: envSlug,
        projectId,
        version: typeof secret.version === "number" ? secret.version : 0,
        tags: (secret.tags ?? []).map((t) => str(t.slug) || str(t.name)).join(", "),
        ...(typeof secret.secretReminderRepeatDays === "number"
          ? { reminderRepeatDays: secret.secretReminderRepeatDays }
          : {}),
        reminderNote: str(secret.secretReminderNote),
        isRotatedSecret: secret.isRotatedSecret === true,
        updatedAt: str(secret.updatedAt),
      },
      {
        ...(env?.id ? { parentResourceId: `${accountId}:environment:${projectId}/${env.id}` } : {}),
        resolvedOutputs: { key },
        ...(secret.createdAt ? { createdAt: secret.createdAt } : {}),
        ...(secret.updatedAt ? { updatedAt: secret.updatedAt } : {}),
      },
    );
  }

  mapDynamicSecret(
    accountId: string,
    project: InfProject,
    env: InfEnvironment,
    path: string,
    ds: InfDynamicSecret,
  ): ResourceInstance {
    const projectId = str(project.id);
    const envSlug = str(env.slug);
    return this.instance(
      accountId,
      "dynamic-secret",
      `${projectId}/${envSlug}/${encodeURIComponent(path)}/${str(ds.name)}`,
      str(ds.name),
      {
        name: str(ds.name),
        type: str(ds.type),
        defaultTTL: str(ds.defaultTTL),
        maxTTL: str(ds.maxTTL),
        status: str(ds.status),
        statusDetails: str(ds.statusDetails),
        path,
        environment: envSlug,
        projectId,
        projectSlug: str(project.slug),
        createdAt: str(ds.createdAt),
      },
      {
        ...(env.id ? { parentResourceId: `${accountId}:environment:${projectId}/${env.id}` } : {}),
        ...(ds.createdAt ? { createdAt: ds.createdAt } : {}),
        ...(ds.updatedAt ? { updatedAt: ds.updatedAt } : {}),
      },
    );
  }

  mapSync(accountId: string, sync: InfSecretSync, options: InfSyncOption[]): ResourceInstance {
    const destination = str(sync.destination);
    const option = options.find((o) => o.destination === destination);
    const config = sync.destinationConfig ?? {};
    const summary = Object.entries(config)
      .filter(([, value]) => typeof value === "string" || typeof value === "number")
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(", ");
    return this.instance(
      accountId,
      "secret-sync",
      `${destination}/${str(sync.id)}`,
      str(sync.name),
      {
        name: str(sync.name),
        description: str(sync.description),
        destination: str(option?.name) || destination,
        connectionName: str(sync.connection?.name),
        environment: str(sync.environment?.slug),
        secretPath: str(sync.folder?.path) || "/",
        isAutoSyncEnabled: sync.isAutoSyncEnabled !== false,
        syncStatus: str(sync.syncStatus),
        lastSyncMessage: str(sync.lastSyncMessage),
        lastSyncedAt: str(sync.lastSyncedAt),
        projectId: str(sync.projectId),
        destinationSummary: summary,
        canImport: option?.canImportSecrets === true,
      },
      {
        ...(sync.projectId ? { parentResourceId: `${accountId}:project:${sync.projectId}` } : {}),
        ...(sync.createdAt ? { createdAt: sync.createdAt } : {}),
        ...(sync.updatedAt ? { updatedAt: sync.updatedAt } : {}),
      },
    );
  }

  mapIntegration(accountId: string, projectId: string, i: InfIntegration): ResourceInstance {
    const target = [str(i.app), str(i.owner), str(i.targetEnvironment)].filter(Boolean).join(" / ");
    return this.instance(
      accountId,
      "integration",
      str(i.id),
      `${str(i.integration)}${target ? `: ${target}` : ""}`,
      {
        integration: str(i.integration),
        app: target,
        environment: str(i.environment?.slug),
        secretPath: str(i.secretPath) || "/",
        isActive: i.isActive === true,
        isSynced: i.isSynced === true,
        syncMessage: str(i.syncMessage),
        lastUsed: str(i.lastUsed),
      },
      {
        ...(projectId ? { parentResourceId: `${accountId}:project:${projectId}` } : {}),
        ...(i.createdAt ? { createdAt: i.createdAt } : {}),
        ...(i.updatedAt ? { updatedAt: i.updatedAt } : {}),
      },
    );
  }

  mapIdentity(accountId: string, m: InfIdentityMembership): ResourceInstance {
    const identityId = str(m.identity?.id) || str(m.identityId);
    const role = str(m.customRole?.slug) || str(m.role);
    return this.instance(
      accountId,
      "machine-identity",
      identityId,
      str(m.identity?.name),
      {
        name: str(m.identity?.name),
        role,
        identityId,
        authMethods: (m.identity?.authMethods ?? []).join(", "),
        lastLoginTime: str(m.lastLoginTime),
        lastLoginAuthMethod: str(m.lastLoginAuthMethod),
        hasDeleteProtection: m.identity?.hasDeleteProtection === true,
        lockedOut: (m.identity?.activeLockoutAuthMethods ?? []).join(", "),
        createdAt: str(m.createdAt),
      },
      {
        resolvedOutputs: { identityId },
        ...(m.createdAt ? { createdAt: m.createdAt } : {}),
        ...(m.updatedAt ? { updatedAt: m.updatedAt } : {}),
      },
    );
  }

  mapCa(accountId: string, ca: InfCa, projectId: string): ResourceInstance {
    return this.instance(
      accountId,
      "certificate-authority",
      str(ca.id),
      str(ca.friendlyName) || str(ca.name) || str(ca.commonName),
      {
        name: str(ca.name),
        friendlyName: str(ca.friendlyName),
        caType: str(ca.type),
        status: str(ca.status),
        commonName: str(ca.commonName),
        keyAlgorithm: str(ca.keyAlgorithm),
        serialNumber: str(ca.serialNumber),
        notBefore: str(ca.notBefore),
        notAfter: str(ca.notAfter),
        projectId,
      },
      {
        ...(projectId ? { parentResourceId: `${accountId}:project:${projectId}` } : {}),
        resolvedOutputs: { caId: str(ca.id) },
        ...(ca.createdAt ? { createdAt: ca.createdAt } : {}),
        ...(ca.updatedAt ? { updatedAt: ca.updatedAt } : {}),
      },
    );
  }

  mapCertificate(accountId: string, c: InfCertificate, projectId: string): ResourceInstance {
    return this.instance(
      accountId,
      "certificate",
      str(c.id),
      str(c.commonName) || str(c.friendlyName) || str(c.serialNumber),
      {
        commonName: str(c.commonName),
        friendlyName: str(c.friendlyName),
        altNames: str(c.altNames),
        status: str(c.status),
        serialNumber: str(c.serialNumber),
        notBefore: str(c.notBefore),
        notAfter: str(c.notAfter),
        revokedAt: str(c.revokedAt),
        caId: str(c.caId),
        profileId: str(c.profileId),
        projectId,
      },
      {
        ...(projectId ? { parentResourceId: `${accountId}:project:${projectId}` } : {}),
        ...(c.createdAt ? { createdAt: c.createdAt } : {}),
        ...(c.updatedAt ? { updatedAt: c.updatedAt } : {}),
      },
    );
  }

  // -------------------------------------------------------------------------
  // Preflight
  // -------------------------------------------------------------------------

  verifyCredentials(): PluginEffect<PreflightResult> {
    return attempt(async () => {
      const checks: PreflightCapabilityCheck[] = [];
      const probe = async (
        capabilityId: string,
        run: () => Promise<unknown>,
        permission: string,
      ) => {
        try {
          await run();
          checks.push({ capabilityId, status: "ok" });
        } catch (error) {
          const status = statusOf(error);
          const message = messageOf(error);
          if (status === 401 || status === 403) {
            checks.push({
              capabilityId,
              status: "missing",
              missingPermissions: [{ id: permission, label: permission }],
              ...(message !== undefined ? { message } : {}),
            });
          } else {
            checks.push({
              capabilityId,
              status: "unknown",
              ...(message !== undefined ? { message } : {}),
            });
          }
        }
      };
      let organization = "";
      await probe(
        "login",
        async () => {
          const body = await this.api.rest.get("/api/v1/identities/details");
          organization = str(body.identityDetails?.organization?.name);
        },
        "Universal Auth client ID and secret",
      );
      await probe("projects", () => this.projects(), "Project membership for the identity");
      await probe(
        "identities",
        () => this.identities(),
        "Organization role with Identity read access",
      );
      await probe(
        "audit-logs",
        () => this.api.rest.get("/api/v1/organization/audit-logs", { query: { limit: 1 } }),
        "Organization role with Audit Logs read access",
      );
      return { checks, ...(organization ? { identity: organization } : {}) };
    });
  }

  // -------------------------------------------------------------------------
  // Metrics, stats and logs
  // -------------------------------------------------------------------------

  private async auditLogs(query: AuditLogQuery, maxPages: number): Promise<InfAuditLog[]> {
    const out: InfAuditLog[] = [];
    for (let page = 0; page < maxPages; page++) {
      const body = await this.api.rest.get("/api/v1/organization/audit-logs", {
        query: { ...query, offset: page * Number(query["limit"] ?? AUDIT_PAGE_SIZE) },
      });
      const items = requireListPage(body.auditLogs, {
        vendor: VENDOR,
        path: "/api/v1/organization/audit-logs",
        key: "auditLogs",
      });
      out.push(...items);
      if (items.length < Number(query["limit"] ?? AUDIT_PAGE_SIZE)) break;
    }
    return out;
  }

  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      if (resourceTypeId !== "project") return [];
      const endMs = timeRange?.endMs ?? Date.now();
      const startMs = timeRange?.startMs ?? endMs - METRICS_DEFAULT_RANGE_MS;
      const logs = await this.auditLogs(
        {
          projectId: externalIdOf(resourceId),
          startDate: new Date(startMs).toISOString(),
          endDate: new Date(endMs).toISOString(),
          limit: AUDIT_PAGE_SIZE,
        },
        MAX_AUDIT_PAGES,
      );
      const bucketMs = Math.max(
        60_000,
        Math.ceil((endMs - startMs) / METRIC_BUCKETS / 60_000) * 60_000,
      );
      const series: Array<{ label: string; match: (type: string) => boolean }> = [
        { label: "Secret reads", match: (t) => READ_EVENTS.has(t) },
        { label: "Secret changes", match: (t) => WRITE_EVENTS.has(t) },
        {
          label: "Identity logins",
          match: (t) => t.startsWith("login-identity-") && !t.endsWith("-failed"),
        },
        {
          label: "Failed identity logins",
          match: (t) => t.startsWith("login-identity-") && t.endsWith("-failed"),
        },
      ];
      const buckets: number[] = [];
      for (let at = startMs; at < endMs; at += bucketMs) buckets.push(at);
      return series.map(({ label, match }) => {
        const counts = new Map<number, number>(buckets.map((at) => [at, 0]));
        for (const log of logs) {
          const at = Date.parse(str(log.createdAt));
          if (!Number.isFinite(at) || !match(str(log.event?.type))) continue;
          const bucket = startMs + Math.floor((at - startMs) / bucketMs) * bucketMs;
          const current = counts.get(bucket);
          if (current !== undefined) counts.set(bucket, current + 1);
        }
        return {
          label,
          unit: "count",
          points: buckets.map((timestamp) => ({ timestamp, value: counts.get(timestamp) ?? 0 })),
        };
      });
    });
  }

  fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      if (resourceTypeId === "project") {
        const project = await this.project(id);
        if (project.type && project.type !== "secret-manager") {
          return [{ label: "Product", value: str(project.type) }];
        }
        const syncs = await this.syncsIn(id).catch((): InfSecretSync[] => []);
        const failing = syncs.filter((s) => s.syncStatus === "failed").length;
        return [
          { label: "Environments", value: String(project.environments?.length ?? 0) },
          { label: "Secret Syncs", value: String(syncs.length) },
          { label: "Failing Syncs", value: String(failing) },
        ];
      }
      if (resourceTypeId === "environment") {
        const [projectId = ""] = split(id, 2, "environment");
        const project = await this.project(projectId);
        const envId = id.split("/")[1];
        const env = (project.environments ?? []).find((e) => e.id === envId);
        if (!env) return [];
        const [secrets, folders] = await Promise.all([
          this.secretsIn(projectId, str(env.slug)).catch((): InfSecret[] => []),
          this.foldersIn(projectId, str(env.slug)).catch((): InfFolder[] => []),
        ]);
        return [
          { label: "Secrets", value: String(secrets.length) },
          { label: "Folders", value: String(folders.length) },
        ];
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
      const id = externalIdOf(resourceId);
      const limit = Math.min(Math.max(params.tailLines ?? 100, 1), 1000);
      const query: AuditLogQuery = { limit };
      if (typeId === "project") query["projectId"] = id;
      else if (typeId === "environment") {
        const [projectId = ""] = split(id, 2, "environment");
        const project = await this.project(projectId);
        const env = (project.environments ?? []).find((e) => e.id === id.split("/")[1]);
        query["projectId"] = projectId;
        if (env?.slug) query["environment"] = env.slug;
      } else if (typeId === "machine-identity") {
        query["actor"] = id;
        query["actorType"] = "identity";
      } else if (typeId === "secret") {
        const secret = await this.fetchSecret(id);
        query["projectId"] = str(secret.workspace);
        query["environment"] = str(secret.environment);
        query["secretPath"] = str(secret.secretPath) || "/";
        query["secretKey"] = str(secret.secretKey);
      } else {
        throw new Error(
          "Infisical plugin: audit logs are available for projects, environments, secrets and identities",
        );
      }
      const logs = await this.auditLogs(query, 1);
      const lines = logs
        .slice()
        .reverse()
        .map((log) => {
          const meta: NonNullable<InfAuditLog["event"]["metadata"]> = log.event?.metadata ?? {};
          const subject =
            str(meta["secretKey"]) ||
            str(meta["secretPath"]) ||
            str(meta["name"]) ||
            str(meta["environment"]);
          const actorMeta: NonNullable<InfAuditLog["actor"]["metadata"]> =
            log.actor?.metadata ?? {};
          const actor =
            str(actorMeta["email"]) || str(actorMeta["name"]) || str(actorMeta["identityId"]);
          const parts = [
            str(log.createdAt),
            str(log.event?.type),
            subject,
            actor ? `by ${str(log.actor?.type)}:${actor}` : "",
            log.ipAddress ? `from ${log.ipAddress}` : "",
          ].filter(Boolean);
          return parts.join(" ");
        });
      return {
        text: lines.map((line) => `${line}\n`).join(""),
        containers: ["audit"],
        activeContainer: "audit",
      };
    });
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  private async locationOptions(parentResourceId?: string): Promise<SelectOption[]> {
    let pairs = this.envPairs(await this.secretProjects());
    if (parentResourceId) {
      const parentType = parentResourceId.split(":")[1];
      const parentId = externalIdOf(parentResourceId);
      if (parentType === "environment") {
        const [projectId, envId] = parentId.split("/");
        pairs = pairs.filter(({ project, env }) => project.id === projectId && env.id === envId);
      } else if (parentType === "project") {
        pairs = pairs.filter(({ project }) => project.id === parentId);
      }
    }
    const perEnv = await Promise.all(
      pairs.slice(0, 60).map(async ({ project, env }) => {
        const folders = await this.foldersIn(str(project.id), str(env.slug)).catch(
          (): InfFolder[] => [],
        );
        const paths = ["/", ...folders.map(folderPath).sort()];
        return paths.map((path) => ({
          id: encodeLocation(str(project.id), str(env.slug), path),
          label: `${str(project.name)} / ${str(env.name) || str(env.slug)} : ${path}`,
        }));
      }),
    );
    return perEnv.flat().slice(0, 500);
  }

  private async projectOptions(type: "secret-manager" | "cert-manager"): Promise<SelectOption[]> {
    const projects =
      type === "cert-manager" ? await this.certProjects() : await this.secretProjects();
    return projects.map((p) => ({ id: str(p.id), label: str(p.name), description: str(p.slug) }));
  }

  private async orgRoleOptions(): Promise<SelectOption[]> {
    const body = await this.api.rest
      .get("/api/v1/organization/roles")
      .catch((): { roles?: InfRole[] } => ({ roles: [] }));
    const custom = (body.roles ?? [])
      .filter((r) => r.slug && !BUILTIN_ORG_ROLES.some((b) => b.id === r.slug))
      .map((r) => ({ id: str(r.slug), label: str(r.name) || str(r.slug) }));
    return [...BUILTIN_ORG_ROLES, ...custom];
  }

  async projectRoleOptions(projectId: string): Promise<SelectOption[]> {
    const body = await this.api.rest
      .get(`/api/v1/projects/${pathEncode(projectId)}/roles`)
      .catch((): { roles?: InfRole[] } => ({ roles: [] }));
    const roles = (body.roles ?? []).filter((r) => r.slug);
    if (roles.length === 0) return BUILTIN_PROJECT_ROLES;
    return roles.map((r) => ({ id: str(r.slug), label: str(r.name) || str(r.slug) }));
  }

  private selectField(
    key: string,
    label: string,
    options: SelectOption[],
    description?: string,
  ): CreateFieldConfig {
    return {
      key,
      label,
      kind: "select",
      required: true,
      options,
      ...(options[0] ? { defaultValue: options[0].id } : {}),
      ...(description ? { description } : {}),
    };
  }

  getCreateConfig(typeId: string, parentResourceId?: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      switch (typeId) {
        case "project":
          return {
            fields: [
              { key: "name", label: "Name", kind: "text", required: true },
              {
                key: "slug",
                label: "Slug",
                kind: "text",
                required: false,
                description: "Optional. Generated from the name when blank.",
              },
              { key: "description", label: "Description", kind: "text", required: false },
              this.selectField("type", "Product", [
                { id: "secret-manager", label: "Secrets Management" },
                { id: "cert-manager", label: "Certificate Management (PKI)" },
                { id: "kms", label: "Key Management (KMS)" },
                { id: "secret-scanning", label: "Secret Scanning" },
              ]),
              {
                key: "shouldCreateDefaultEnvs",
                label: "Default environments",
                kind: "select",
                required: false,
                defaultValue: "true",
                options: [
                  { id: "true", label: "Create Development, Staging and Production" },
                  { id: "false", label: "Start with no environments" },
                ],
                showWhen: { fieldKey: "type", fieldValue: "secret-manager" },
              },
            ],
          };
        case "environment":
          return {
            fields: [
              ...(parentResourceId
                ? []
                : [
                    this.selectField(
                      "projectId",
                      "Project",
                      await this.projectOptions("secret-manager"),
                    ),
                  ]),
              { key: "name", label: "Name", kind: "text", required: true, placeholder: "QA" },
              {
                key: "slug",
                label: "Slug",
                kind: "text",
                required: true,
                placeholder: "qa",
                description: "Used by the CLI and SDKs, e.g. `infisical run --env=qa`.",
              },
            ],
          };
        case "folder":
          return {
            fields: [
              this.selectField(
                "location",
                "Parent folder",
                await this.locationOptions(parentResourceId),
                "Project, environment and the folder the new folder goes in.",
              ),
              { key: "name", label: "Name", kind: "text", required: true, placeholder: "backend" },
              { key: "description", label: "Description", kind: "text", required: false },
            ],
          };
        case "secret":
          return {
            fields: [
              this.selectField(
                "location",
                "Location",
                await this.locationOptions(parentResourceId),
                "Project, environment and folder for the secret.",
              ),
              {
                key: "key",
                label: "Key",
                kind: "text",
                required: true,
                placeholder: "DATABASE_URL",
              },
              { key: "value", label: "Value", kind: "password", required: true },
              { key: "comment", label: "Comment", kind: "text", required: false },
              {
                key: "reminderRepeatDays",
                label: "Rotation reminder (days)",
                kind: "number",
                required: false,
                minValue: 1,
                maxValue: 365,
                description: "Optional. Emails project members every N days to rotate it.",
              },
            ],
          };
        case "machine-identity":
          return {
            fields: [
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: true,
                placeholder: "ci-deployer",
              },
              this.selectField("role", "Organization role", await this.orgRoleOptions()),
              {
                key: "enableUniversalAuth",
                label: "Universal Auth",
                kind: "select",
                required: false,
                defaultValue: "true",
                options: [
                  { id: "true", label: "Enable (client ID and secret)" },
                  { id: "false", label: "Configure auth later in Infisical" },
                ],
              },
            ],
          };
        case "certificate": {
          const profiles = await this.api.lists
            .getAll("/api/v1/cert-manager/certificate-profiles", "certificateProfiles", {
              query: { enrollmentType: "api" },
              partial: true,
            })
            .catch((): InfCertificateProfile[] => []);
          return {
            fields: [
              ...(parentResourceId
                ? []
                : [
                    this.selectField(
                      "projectId",
                      "Project",
                      await this.projectOptions("cert-manager"),
                    ),
                  ]),
              this.selectField(
                "profileId",
                "Certificate profile",
                profiles.map((p) => ({
                  id: str(p.id),
                  label: str(p.slug),
                  ...(p.description ? { description: p.description } : {}),
                })),
                "Profiles bind an issuing CA to a certificate policy. Create them in Infisical.",
              ),
              {
                key: "commonName",
                label: "Common name",
                kind: "text",
                required: true,
                placeholder: "api.example.com",
              },
              {
                key: "altNames",
                label: "DNS names",
                kind: "string-list",
                required: false,
                addLabel: "+ Add DNS name",
              },
              {
                key: "ttl",
                label: "Validity",
                kind: "text",
                required: false,
                defaultValue: "90d",
                placeholder: "90d",
              },
              this.selectField("keyAlgorithm", "Key algorithm", [
                { id: "RSA_2048", label: "RSA 2048" },
                { id: "RSA_3072", label: "RSA 3072" },
                { id: "RSA_4096", label: "RSA 4096" },
                { id: "EC_prime256v1", label: "ECDSA P-256" },
                { id: "EC_secp384r1", label: "ECDSA P-384" },
              ]),
            ],
          };
        }
        default:
          throw new Error(`Infisical plugin: cannot create resource type "${typeId}"`);
      }
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      this.projectsCache = null;
      switch (typeId) {
        case "project": {
          const type = fields["type"] || "secret-manager";
          const body = await this.api.rest.post("/api/v1/projects", {
            body: {
              projectName: fields["name"],
              ...(fields["slug"] ? { slug: fields["slug"] } : {}),
              ...(fields["description"] ? { projectDescription: fields["description"] } : {}),
              type,
              ...(type === "secret-manager"
                ? { shouldCreateDefaultEnvs: fields["shouldCreateDefaultEnvs"] !== "false" }
                : {}),
            },
          });
          if (!body.project)
            throw new Error("Infisical plugin: project creation returned no project");
          return this.mapProject(accountId, body.project);
        }
        case "environment": {
          const projectId = parentResourceId ? externalIdOf(parentResourceId) : fields["projectId"];
          if (!projectId) throw new Error("Infisical plugin: choose a project");
          const body = await this.api.rest.post(
            `/api/v1/projects/${pathEncode(projectId)}/environments`,
            { body: { name: fields["name"], slug: fields["slug"] } },
          );
          this.projectsCache = null;
          return this.mapEnvironment(
            accountId,
            await this.project(projectId),
            body.environment ?? {},
          );
        }
        case "folder": {
          const loc = decodeLocation(fields["location"] ?? "");
          const body = await this.api.rest.post("/api/v2/folders", {
            body: {
              projectId: loc.projectId,
              environment: loc.env,
              name: fields["name"],
              path: loc.path,
              ...(fields["description"] ? { description: fields["description"] } : {}),
            },
          });
          const folder = { ...(body.folder ?? {}), path: joinPath(loc.path, str(fields["name"])) };
          const project = await this.project(loc.projectId);
          const env = (project.environments ?? []).find((e) => e.slug === loc.env) ?? {
            slug: loc.env,
          };
          return this.mapFolder(accountId, loc.projectId, env, folder);
        }
        case "secret": {
          const loc = decodeLocation(fields["location"] ?? "");
          const key = (fields["key"] ?? "").trim();
          if (!key) throw new Error("Infisical plugin: a secret key is required");
          const days = Number(fields["reminderRepeatDays"]);
          const body: InfSecretWrite = await this.api.rest.post(
            `/api/v4/secrets/${pathEncode(key)}`,
            {
              body: {
                projectId: loc.projectId,
                environment: loc.env,
                secretPath: loc.path,
                secretValue: fields["value"] ?? "",
                ...(fields["comment"] ? { secretComment: fields["comment"] } : {}),
                ...(Number.isFinite(days) && days > 0 ? { secretReminderRepeatDays: days } : {}),
                type: "shared",
              },
            },
          );
          if (!body.secret) {
            throw Object.assign(
              new Error(
                "Infisical requires approval for changes in this environment. A change request was opened; the secret appears once it is approved.",
              ),
              { status: 202 },
            );
          }
          return this.mapSecret(accountId, await this.project(loc.projectId), {
            ...body.secret,
            secretPath: body.secret.secretPath ?? loc.path,
          });
        }
        case "machine-identity": {
          const orgId = await this.orgId();
          const body = await this.api.rest.post("/api/v1/identities", {
            body: {
              name: fields["name"],
              organizationId: orgId,
              role: fields["role"] || "no-access",
            },
          });
          const identityId = str(body.identity?.id);
          if (!identityId) throw new Error("Infisical plugin: identity creation returned no id");
          if (fields["enableUniversalAuth"] !== "false") {
            await this.api.rest.post(
              `/api/v1/auth/universal-auth/identities/${pathEncode(identityId)}`,
              { body: {} },
            );
          }
          return runPluginEffect(
            this.getResource(
              "machine-identity",
              `${accountId}:machine-identity:${identityId}`,
              accountId,
            ),
          );
        }
        case "certificate": {
          const projectId = parentResourceId ? externalIdOf(parentResourceId) : fields["projectId"];
          const altNames: CertificateAltNames = (fields["altNames"] ?? "")
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean)
            .map((value) => ({ type: "dns_name", value }));
          const body = await this.api.rest.post("/api/v1/cert-manager/certificates", {
            body: {
              profileId: fields["profileId"],
              attributes: {
                ...(fields["commonName"] !== undefined ? { commonName: fields["commonName"] } : {}),
                ...(altNames.length > 0 ? { altNames } : {}),
                ttl: fields["ttl"] || "90d",
                ...(fields["keyAlgorithm"] ? { keyAlgorithm: fields["keyAlgorithm"] } : {}),
              },
            },
          });
          const certId = str(body.certificate?.certificateId);
          if (!certId) {
            throw Object.assign(
              new Error(
                `Infisical accepted the certificate request (${str(body.status) || "pending"}). ${str(body.message)} It appears in the inventory once issued.`.trim(),
              ),
              { status: 202 },
            );
          }
          return this.readCertificate(accountId, certId, projectId);
        }
        default:
          throw new Error(`Infisical plugin: cannot create resource type "${typeId}"`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      switch (typeId) {
        case "project": {
          const body: UpdateProjectBody = {};
          if (fields["name"] !== undefined) body["name"] = fields["name"];
          if (fields["description"] !== undefined) body["description"] = fields["description"];
          if (fields["slug"] !== undefined) body["slug"] = fields["slug"];
          for (const key of PROJECT_FLAGS) {
            const value = bool(fields[key]);
            if (value !== undefined) body[key] = value;
          }
          if (fields["pitVersionLimit"])
            body["pitVersionLimit"] = Number(fields["pitVersionLimit"]);
          const res = await this.api.rest.patch(`/api/v1/projects/${pathEncode(id)}`, { body });
          this.projectsCache = null;
          return res.project
            ? this.mapProject(accountId, { ...(await this.project(id)), ...res.project })
            : runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "environment": {
          const [projectId = "", envId = ""] = split(id, 2, "environment");
          const body: UpdateEnvironmentBody = {};
          if (fields["name"] !== undefined) body["name"] = fields["name"];
          if (fields["slug"] !== undefined) body["slug"] = fields["slug"];
          if (fields["position"]) body["position"] = Number(fields["position"]);
          await this.api.rest.patch(
            `/api/v1/projects/${pathEncode(projectId)}/environments/${pathEncode(envId)}`,
            { body },
          );
          this.projectsCache = null;
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "folder": {
          const current = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
          const [projectId = "", envSlug = "", folderId = ""] = split(id, 3, "folder");
          const path = str(current.fields["path"]);
          await this.api.rest.patch(`/api/v2/folders/${pathEncode(folderId)}`, {
            body: {
              projectId,
              environment: envSlug,
              name: fields["name"] ?? str(current.fields["name"]),
              path: parentPath(path),
              ...(fields["description"] !== undefined
                ? { description: fields["description"] || null }
                : {}),
            },
          });
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "secret": {
          const secret = await this.fetchSecret(id);
          const days = fields["reminderRepeatDays"];
          const body: UpdateSecretBody = {
            projectId: str(secret.workspace),
            environment: str(secret.environment),
            secretPath: str(secret.secretPath) || "/",
            type: "shared",
          };
          if (fields["value"]) body["secretValue"] = fields["value"];
          if (fields["comment"] !== undefined) body["secretComment"] = fields["comment"];
          if (fields["key"] && fields["key"] !== secret.secretKey)
            body["newSecretName"] = fields["key"];
          if (days !== undefined) body["secretReminderRepeatDays"] = days ? Number(days) : null;
          if (fields["reminderNote"] !== undefined)
            body["secretReminderNote"] = fields["reminderNote"] || null;
          const res: InfSecretWrite = await this.api.rest.patch(
            `/api/v4/secrets/${pathEncode(str(secret.secretKey))}`,
            { body },
          );
          if (!res.secret) {
            throw Object.assign(
              new Error(
                "Infisical requires approval for changes in this environment. A change request was opened.",
              ),
              { status: 202 },
            );
          }
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "dynamic-secret": {
          const ref = this.dynamicRef(id);
          const project = await this.project(ref.projectId);
          const data: UpdateDynamicSecretData = {};
          if (fields["defaultTTL"]) data["defaultTTL"] = fields["defaultTTL"];
          if (fields["maxTTL"] !== undefined) data["maxTTL"] = fields["maxTTL"] || null;
          if (fields["name"] && fields["name"] !== ref.name) data["newName"] = fields["name"];
          await this.api.rest.patch(`/api/v1/dynamic-secrets/${pathEncode(ref.name)}`, {
            body: {
              projectSlug: str(project.slug),
              environmentSlug: ref.env,
              path: ref.path,
              data,
            },
          });
          const name = str(data["newName"]) || ref.name;
          return runPluginEffect(
            this.getResource(
              typeId,
              `${accountId}:dynamic-secret:${ref.projectId}/${ref.env}/${encodeURIComponent(ref.path)}/${name}`,
              accountId,
            ),
          );
        }
        case "secret-sync": {
          const [destination = "", syncId = ""] = split(id, 2, "secret sync");
          const body: UpdateSecretSyncBody = {};
          if (fields["name"] !== undefined) body["name"] = fields["name"];
          if (fields["description"] !== undefined)
            body["description"] = fields["description"] || null;
          const auto = bool(fields["isAutoSyncEnabled"]);
          if (auto !== undefined) body["isAutoSyncEnabled"] = auto;
          if (fields["environment"]) body["environment"] = fields["environment"];
          if (fields["secretPath"]) body["secretPath"] = fields["secretPath"];
          await this.api.rest.patch(
            `/api/v1/secret-syncs/${pathEncode(destination)}/${pathEncode(syncId)}`,
            { body },
          );
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "machine-identity": {
          const body: UpdateIdentityBody = {};
          if (fields["name"] !== undefined) body["name"] = fields["name"];
          if (fields["role"]) body["role"] = fields["role"];
          const protect = bool(fields["hasDeleteProtection"]);
          if (protect !== undefined) body["hasDeleteProtection"] = protect;
          await this.api.rest.patch(`/api/v1/identities/${pathEncode(id)}`, { body });
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        default:
          throw new Error(`Infisical plugin: cannot update resource type "${typeId}"`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  deleteResource(typeId: string, resourceId: string, accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      this.projectsCache = null;
      switch (typeId) {
        case "project":
          await this.api.rest.delete(`/api/v1/projects/${pathEncode(id)}`);
          return;
        case "environment": {
          const [projectId = "", envId = ""] = split(id, 2, "environment");
          await this.api.rest.delete(
            `/api/v1/projects/${pathEncode(projectId)}/environments/${pathEncode(envId)}`,
          );
          return;
        }
        case "folder": {
          const current = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
          const [projectId = "", envSlug = "", folderId = ""] = split(id, 3, "folder");
          await this.api.rest.delete(`/api/v2/folders/${pathEncode(folderId)}`, {
            body: {
              projectId,
              environment: envSlug,
              path: parentPath(str(current.fields["path"])),
              forceDelete: true,
            },
          });
          return;
        }
        case "secret": {
          const secret = await this.fetchSecret(id);
          await this.api.rest.delete(`/api/v4/secrets/${pathEncode(str(secret.secretKey))}`, {
            body: {
              projectId: str(secret.workspace),
              environment: str(secret.environment),
              secretPath: str(secret.secretPath) || "/",
              type: "shared",
            },
          });
          return;
        }
        case "dynamic-secret": {
          const ref = this.dynamicRef(id);
          const project = await this.project(ref.projectId);
          await this.api.rest.delete(`/api/v1/dynamic-secrets/${pathEncode(ref.name)}`, {
            body: { projectSlug: str(project.slug), environmentSlug: ref.env, path: ref.path },
          });
          return;
        }
        case "secret-sync": {
          const [destination = "", syncId = ""] = split(id, 2, "secret sync");
          await this.api.rest.delete(
            `/api/v1/secret-syncs/${pathEncode(destination)}/${pathEncode(syncId)}`,
            { query: { removeSecrets: "false" } },
          );
          return;
        }
        case "integration":
          await this.api.rest.delete(`/api/v1/integration/${pathEncode(id)}`);
          return;
        case "machine-identity":
          await this.api.rest.delete(`/api/v1/identities/${pathEncode(id)}`);
          return;
        case "certificate-authority":
          await this.api.rest.delete(`/api/v1/pki/ca/${pathEncode(id)}`);
          return;
        case "certificate":
          await this.api.rest.delete(`/api/v1/cert-manager/certificates/${pathEncode(id)}`);
          return;
        default:
          throw new Error(`Infisical plugin: cannot delete resource type "${typeId}"`);
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
      const id = externalIdOf(resourceId);
      if (typeId === "secret-sync") {
        const [destination = "", syncId = ""] = split(id, 2, "secret sync");
        // Both queue a job; the sync's status fields report how it went.
        if (actionId === "sync") {
          await this.api.rest.post(
            `/api/v1/secret-syncs/${pathEncode(destination)}/${pathEncode(syncId)}/sync-secrets`,
          );
          return;
        }
        if (actionId === "remove") {
          await this.api.rest.post(
            `/api/v1/secret-syncs/${pathEncode(destination)}/${pathEncode(syncId)}/remove-secrets`,
          );
          return;
        }
      }
      if (typeId === "integration" && actionId === "sync") {
        await this.api.rest.post(`/api/v1/integration/${pathEncode(id)}/sync`);
        return;
      }
      if (typeId === "machine-identity") {
        if (actionId === "enable-universal-auth") {
          await this.api.rest.post(`/api/v1/auth/universal-auth/identities/${pathEncode(id)}`, {
            body: {},
          });
          return;
        }
        if (actionId === "clear-lockouts") {
          await this.api.rest.post(
            `/api/v1/auth/universal-auth/identities/${pathEncode(id)}/clear-lockouts`,
          );
          return;
        }
      }
      if (typeId === "certificate" && actionId === "renew") {
        await this.api.rest.post(`/api/v1/cert-manager/certificates/${pathEncode(id)}/renew`, {
          body: {},
        });
        return;
      }
      throw new Error(`Infisical plugin: unknown action "${actionId}" for type "${typeId}"`);
    });
  }

  /** Form-driven actions. Form values arrive JSON-encoded in `args[0]`. */
  executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): PluginEffect<unknown> {
    return attempt(async () => {
      const values: Record<string, string> = JSON.parse(String(args[0] ?? "{}"));
      const id = externalIdOf(resourceId);

      if (typeId === "machine-identity" && command === "add-to-project") {
        const projectId = values["projectId"];
        if (!projectId) throw new Error("Infisical plugin: choose a project");
        return this.api.rest.post(
          `/api/v1/projects/${pathEncode(projectId)}/identity-memberships/${pathEncode(id)}`,
          { body: { roles: [{ role: values["role"] || "viewer", isTemporary: false }] } },
        );
      }
      if (typeId === "machine-identity" && command === "remove-from-project") {
        const projectId = values["projectId"];
        if (!projectId) throw new Error("Infisical plugin: choose a project");
        return this.api.rest.delete(
          `/api/v1/projects/${pathEncode(projectId)}/identity-memberships/${pathEncode(id)}`,
        );
      }
      if (typeId === "machine-identity" && command === "revoke-client-secret") {
        const secretId = values["clientSecretId"];
        if (!secretId) throw new Error("Infisical plugin: choose a client secret");
        return this.api.rest.post(
          `/api/v1/auth/universal-auth/identities/${pathEncode(id)}/client-secrets/${pathEncode(secretId)}/revoke`,
        );
      }
      if (typeId === "machine-identity" && command === "configure-universal-auth") {
        const body: UpdateUniversalAuthBody = {};
        for (const key of UNIVERSAL_AUTH_LIMITS) {
          if (values[key] !== undefined && values[key] !== "") body[key] = Number(values[key]);
        }
        const ips = (values["trustedIps"] ?? "")
          .split(",")
          .map((ip) => ip.trim())
          .filter(Boolean)
          .map((ipAddress) => ({ ipAddress }));
        if (ips.length > 0) {
          body["clientSecretTrustedIps"] = ips;
          body["accessTokenTrustedIps"] = ips;
        }
        return this.api.rest.patch(`/api/v1/auth/universal-auth/identities/${pathEncode(id)}`, {
          body,
        });
      }
      if (typeId === "secret-sync" && command === "import") {
        const [destination = "", syncId = ""] = split(id, 2, "secret sync");
        return this.api.rest.post(
          `/api/v1/secret-syncs/${pathEncode(destination)}/${pathEncode(syncId)}/import-secrets`,
          { query: { importBehavior: values["importBehavior"] || "prioritize-source" } },
        );
      }
      if (typeId === "dynamic-secret" && command === "revoke-lease") {
        const ref = this.dynamicRef(id);
        const project = await this.project(ref.projectId);
        const leaseId = values["leaseId"];
        if (!leaseId) throw new Error("Infisical plugin: choose a lease");
        return this.api.rest.delete(`/api/v1/dynamic-secrets/leases/${pathEncode(leaseId)}`, {
          body: { projectSlug: str(project.slug), environmentSlug: ref.env, path: ref.path },
        });
      }
      if (typeId === "certificate" && command === "revoke") {
        return this.api.rest.post(`/api/v1/cert-manager/certificates/${pathEncode(id)}/revoke`, {
          body: { revocationReason: values["reason"] || "UNSPECIFIED" },
        });
      }
      throw new Error(`Infisical plugin: unknown command "${command}" for type "${typeId}"`);
    });
  }

  // -------------------------------------------------------------------------
  // Credential export
  // -------------------------------------------------------------------------

  exportCredential(
    typeId: string,
    resourceId: string,
    _accountId: string,
    formatId: string,
  ): PluginEffect<CredentialExport> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      if (typeId === "machine-identity" && formatId === "universal-auth-client-secret") {
        const ua = await this.universalAuth(id);
        if (!ua?.clientId) {
          throw new Error("Infisical plugin: enable Universal Auth on this identity first");
        }
        const body = await this.api.rest.post(
          `/api/v1/auth/universal-auth/identities/${pathEncode(id)}/client-secrets`,
          { body: { description: "Created from Infrawrench" } },
        );
        const secret = str(body.clientSecret);
        if (!secret) throw new Error("Infisical plugin: Infisical returned no client secret");
        const env = `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID=${ua.clientId}\nINFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET=${secret}\n`;
        return {
          content: env,
          filename: "infisical-machine-identity.env",
          mimeType: "text/plain",
          fields: [
            { label: "Client ID", value: ua.clientId },
            { label: "Client secret", value: secret, sensitive: true, hint: "Only shown once" },
          ],
          warning:
            "Save the client secret now: Infisical never shows it again. Revoke it from the identity page.",
        };
      }
      if (typeId === "dynamic-secret" && formatId === "lease") {
        const ref = this.dynamicRef(id);
        const project = await this.project(ref.projectId);
        const body = await this.api.rest.post("/api/v1/dynamic-secrets/leases", {
          body: {
            dynamicSecretName: ref.name,
            projectSlug: str(project.slug),
            environmentSlug: ref.env,
            path: ref.path,
          },
        });
        const data = body.data ?? {};
        return {
          content: JSON.stringify(data, null, 2),
          filename: `${ref.name}-lease.json`,
          mimeType: "application/json",
          fields: Object.entries(data).map(([label, value]) => ({
            label,
            value: typeof value === "string" ? value : JSON.stringify(value),
            sensitive: /pass|secret|key|token/i.test(label),
          })),
          warning: `Lease ${str(body.lease?.id)} expires ${str(body.lease?.expireAt) || "at the default TTL"}. Revoke it from the dynamic secret page when done.`,
        };
      }
      if (typeId === "certificate-authority" && formatId === "ca-certificate") {
        const pem = await runPluginEffect(
          this.resolveOutput(typeId, resourceId, "certificate", _accountId),
        );
        return { content: pem, filename: `${id}-ca.pem`, mimeType: "application/x-pem-file" };
      }
      if (typeId === "certificate" && formatId === "certificate") {
        const pem = await runPluginEffect(
          this.resolveOutput(typeId, resourceId, "certificate", _accountId),
        );
        return { content: pem, filename: `${id}.pem`, mimeType: "application/x-pem-file" };
      }
      if (typeId === "certificate" && formatId === "bundle") {
        const body = await this.api.rest.get(
          `/api/v1/cert-manager/certificates/${pathEncode(id)}/bundle`,
        );
        if (!body.privateKey) {
          throw new Error(
            "Infisical plugin: Infisical holds no private key for this certificate (it was issued from a CSR or imported without one)",
          );
        }
        return {
          content: [str(body.certificate), str(body.certificateChain), str(body.privateKey)]
            .filter(Boolean)
            .join("\n"),
          filename: `${id}-bundle.pem`,
          mimeType: "application/x-pem-file",
          warning: "This file contains the private key. Store it securely.",
        };
      }
      throw new Error(
        `Infisical plugin: unknown credential format "${formatId}" for type "${typeId}"`,
      );
    });
  }

  // -------------------------------------------------------------------------
  // Detail enrichment + rendering
  // -------------------------------------------------------------------------

  enrichDetail(resource: ResourceInstance): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resource.id);
      const extra: Record<string, string> = {};
      switch (resource.resourceTypeId) {
        case "machine-identity": {
          const [ua, secrets, projects] = await Promise.all([
            this.universalAuth(id).catch(() => null),
            this.api.rest
              .get(`/api/v1/auth/universal-auth/identities/${pathEncode(id)}/client-secrets`)
              .then((b) => b.clientSecretData ?? [])
              .catch((): InfClientSecret[] => []),
            this.projects().catch((): InfProject[] => []),
          ]);
          extra["__universalAuth__"] = JSON.stringify(ua);
          extra["__clientSecrets__"] = JSON.stringify(
            secrets.filter((s) => !s.isClientSecretRevoked),
          );
          extra["__projects__"] = JSON.stringify(
            projects.map((p) => ({ id: str(p.id), label: str(p.name) })),
          );
          if (ua?.clientId) extra["clientId"] = ua.clientId;
          break;
        }
        case "dynamic-secret": {
          const ref = this.dynamicRef(id);
          const project = await this.project(ref.projectId);
          const leases = await this.api.rest
            .get(`/api/v1/dynamic-secrets/${pathEncode(ref.name)}/leases`, {
              query: { projectSlug: str(project.slug), environmentSlug: ref.env, path: ref.path },
            })
            .then((b) => b.leases ?? [])
            .catch((): InfLease[] => []);
          extra["__leases__"] = JSON.stringify(leases);
          break;
        }
        case "project": {
          const projectId = id;
          const type = String(resource.fields["type"] ?? "");
          if (type === "secret-manager" || !type) {
            const members = await this.api.lists
              .getAll(
                `/api/v1/projects/${pathEncode(projectId)}/identity-memberships`,
                "identityMemberships",
                { partial: true },
              )
              .catch((): ProjectIdentity[] => []);
            extra["__identities__"] = JSON.stringify(
              members.map((m) => ({
                name: str(m.identity?.name),
                roles: (m.roles ?? []).map((r) => str(r.customRoleSlug) || str(r.role)).join(", "),
              })),
            );
          }
          break;
        }
        default:
          return resource;
      }
      return { ...resource, resolvedOutputs: { ...resource.resolvedOutputs, ...extra } };
    });
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderDetail(resource, this.api.siteUrl);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderSidebarItem(resource);
  }
}
