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
import { externalIdOf } from "@infrawrench/plugin-base";
import { InfisicalApi, readCredentials } from "./api.js";
import type {
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
  InfSyncOption,
  InfUniversalAuth,
} from "./types.js";
import { renderDetail, renderSidebarItem } from "./render.js";

const PLUGIN_ID = "infisical";

/** Cap on audit-log pages (1000 events each) read for one metrics window. */
const MAX_AUDIT_PAGES = 5;
const AUDIT_PAGE_SIZE = 1000;
/** Cap on folder paths probed for dynamic secrets per environment. */
const MAX_DYNAMIC_SECRET_PATHS = 40;
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

function str(value: unknown): string {
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

  constructor(credentials: Record<string, string>, services?: HostServices) {
    this.api = new InfisicalApi(readCredentials(credentials), services);
  }

  // -------------------------------------------------------------------------
  // Shared lookups
  // -------------------------------------------------------------------------

  async projects(): Promise<InfProject[]> {
    if (!this.projectsCache || Date.now() - this.projectsCache.at > 60_000) {
      const value = this.api
        .request<{ projects?: InfProject[] }>("/api/v1/projects")
        .then((body) => body.projects ?? []);
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
    const body = await this.api.request<{ project?: InfProject }>(
      `/api/v1/projects/${encodeURIComponent(projectId)}`,
    );
    if (!body.project) throw notFound("project", projectId);
    return body.project;
  }

  /** The organization the machine identity belongs to (needed for identity listings). */
  async orgId(): Promise<string> {
    this.orgIdCache ??= this.api
      .request<{ identityDetails?: { organization?: { id?: string } } }>(
        "/api/v1/identities/details",
      )
      .then((body) => {
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
    this.syncOptionsCache ??= this.api
      .request<{ secretSyncOptions?: InfSyncOption[] }>("/api/v1/secret-syncs/options")
      .then((body) => body.secretSyncOptions ?? [])
      .catch(() => [] as InfSyncOption[]);
    return this.syncOptionsCache;
  }

  /** Run `load` per item, tolerating per-item failures (one unreadable project must not empty a listing). */
  private async each<I, T>(
    items: I[],
    label: (item: I) => string,
    load: (item: I) => Promise<T[]>,
  ) {
    const settled = await Promise.allSettled(items.map((item) => load(item)));
    const out: T[] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") out.push(...result.value);
      else
        console.warn(
          `Infisical plugin: skipping ${label(items[index]!)}: ${String(result.reason)}`,
        );
    });
    return out;
  }

  private envPairs(projects: InfProject[]): Array<{ project: InfProject; env: InfEnvironment }> {
    return projects.flatMap((project) =>
      (project.environments ?? []).map((env) => ({ project, env })),
    );
  }

  private async foldersIn(projectId: string, env: string): Promise<InfFolder[]> {
    const body = await this.api.request<{ folders?: InfFolder[] }>("/api/v2/folders", {
      query: { projectId, environment: env, path: "/", recursive: true },
    });
    return body.folders ?? [];
  }

  private async secretsIn(projectId: string, env: string, path = "/", recursive = true) {
    const body = await this.api.request<{ secrets?: InfSecret[] }>("/api/v4/secrets", {
      query: {
        projectId,
        environment: env,
        secretPath: path,
        recursive,
        viewSecretValue: false,
        expandSecretReferences: false,
        includeImports: false,
      },
    });
    return body.secrets ?? [];
  }

  private async dynamicSecretsAt(projectSlug: string, env: string, path: string) {
    const body = await this.api.request<{ dynamicSecrets?: InfDynamicSecret[] }>(
      "/api/v1/dynamic-secrets",
      { query: { projectSlug, environmentSlug: env, path } },
    );
    return body.dynamicSecrets ?? [];
  }

  private async syncsIn(projectId: string): Promise<InfSecretSync[]> {
    const body = await this.api.request<{ secretSyncs?: InfSecretSync[] }>("/api/v1/secret-syncs", {
      query: { projectId },
    });
    return body.secretSyncs ?? [];
  }

  private async identities(): Promise<InfIdentityMembership[]> {
    const orgId = await this.orgId();
    const body = await this.api.request<{ identities?: InfIdentityMembership[] }>(
      "/api/v1/identities",
      { query: { orgId } },
    );
    return body.identities ?? [];
  }

  private async casIn(projectId: string): Promise<InfCa[]> {
    const out: InfCa[] = [];
    for (let offset = 0; offset < 1000; offset += 100) {
      const body = await this.api.request<{ cas?: InfCa[] }>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/cas`,
        { query: { offset, limit: 100 } },
      );
      const page = body.cas ?? [];
      out.push(...page);
      if (page.length < 100) break;
    }
    return out;
  }

  private async certificatesIn(projectId: string): Promise<InfCertificate[]> {
    const out: InfCertificate[] = [];
    for (let offset = 0; offset < 2000; offset += 100) {
      const body = await this.api.request<{ certificates?: InfCertificate[]; totalCount?: number }>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/certificates/search`,
        { method: "POST", body: { offset, limit: 100 } },
      );
      const page = body.certificates ?? [];
      out.push(...page);
      if (page.length < 100 || (body.totalCount !== undefined && out.length >= body.totalCount))
        break;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "project":
        return (await this.projects()).map((p) => this.mapProject(accountId, p));
      case "environment":
        return this.envPairs(await this.projects()).map(({ project, env }) =>
          this.mapEnvironment(accountId, project, env),
        );
      case "folder":
        return this.each(
          this.envPairs(await this.secretProjects()),
          ({ project, env }) => `${str(project.slug)}/${str(env.slug)}`,
          async ({ project, env }) =>
            (await this.foldersIn(str(project.id), str(env.slug))).map((folder) =>
              this.mapFolder(accountId, str(project.id), env, folder),
            ),
        );
      case "secret":
        return this.each(
          this.envPairs(await this.secretProjects()),
          ({ project, env }) => `${str(project.slug)}/${str(env.slug)}`,
          async ({ project, env }) =>
            (await this.secretsIn(str(project.id), str(env.slug)))
              .filter((secret) => !secret.type || secret.type === "shared")
              .map((secret) => this.mapSecret(accountId, project, secret)),
        );
      case "dynamic-secret":
        return this.each(
          this.envPairs(await this.secretProjects()),
          ({ project, env }) => `${str(project.slug)}/${str(env.slug)}`,
          async ({ project, env }) => {
            const folders = await this.foldersIn(str(project.id), str(env.slug)).catch(
              () => [] as InfFolder[],
            );
            const paths = ["/", ...folders.map(folderPath)].slice(0, MAX_DYNAMIC_SECRET_PATHS);
            const found = await Promise.all(
              paths.map(async (path) =>
                (await this.dynamicSecretsAt(str(project.slug), str(env.slug), path)).map((ds) =>
                  this.mapDynamicSecret(accountId, project, env, path, ds),
                ),
              ),
            );
            return found.flat();
          },
        );
      case "secret-sync": {
        const options = await this.syncOptions();
        return this.each(
          await this.secretProjects(),
          (p) => str(p.slug),
          async (p) =>
            (await this.syncsIn(str(p.id))).map((sync) => this.mapSync(accountId, sync, options)),
        );
      }
      case "integration":
        return this.each(
          await this.secretProjects(),
          (p) => str(p.slug),
          async (p) => {
            const body = await this.api.request<{ integrations?: InfIntegration[] }>(
              `/api/v1/projects/${encodeURIComponent(str(p.id))}/integrations`,
            );
            return (body.integrations ?? []).map((i) =>
              this.mapIntegration(accountId, str(p.id), i),
            );
          },
        );
      case "machine-identity":
        return (await this.identities()).map((m) => this.mapIdentity(accountId, m));
      case "certificate-authority":
        return this.each(
          await this.certProjects(),
          (p) => str(p.slug),
          async (p) =>
            (await this.casIn(str(p.id))).map((ca) => this.mapCa(accountId, ca, str(p.id))),
        );
      case "certificate":
        return this.each(
          await this.certProjects(),
          (p) => str(p.slug),
          async (p) =>
            (await this.certificatesIn(str(p.id))).map((c) =>
              this.mapCertificate(accountId, c, str(p.id)),
            ),
        );
      default:
        throw new Error(`Infisical plugin: unknown resource type "${typeId}"`);
    }
  }

  // -------------------------------------------------------------------------
  // Single reads
  // -------------------------------------------------------------------------

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "project": {
        const body = await this.api.request<{ project?: InfProject }>(
          `/api/v1/projects/${encodeURIComponent(id)}`,
        );
        if (!body.project) throw notFound("project", id);
        return this.mapProject(accountId, body.project);
      }
      case "environment": {
        const [projectId, envId] = split(id, 2, "environment") as [string, string];
        const project = await this.project(projectId);
        const env = (project.environments ?? []).find((e) => e.id === envId);
        if (!env) throw notFound("environment", id);
        return this.mapEnvironment(accountId, project, env);
      }
      case "folder": {
        const [projectId, envSlug, folderId] = split(id, 3, "folder") as [string, string, string];
        const body = await this.api.request<{ folder?: InfFolder }>(
          `/api/v2/folders/${encodeURIComponent(folderId)}`,
        );
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
        const body = await this.api.request<{ dynamicSecret?: InfDynamicSecret }>(
          `/api/v1/dynamic-secrets/${encodeURIComponent(ref.name)}`,
          { query: { projectSlug: str(project.slug), environmentSlug: ref.env, path: ref.path } },
        );
        if (!body.dynamicSecret) throw notFound("dynamic secret", id);
        const env = (project.environments ?? []).find((e) => e.slug === ref.env) ?? {
          slug: ref.env,
        };
        return this.mapDynamicSecret(accountId, project, env, ref.path, body.dynamicSecret);
      }
      case "secret-sync": {
        const [destination, syncId] = split(id, 2, "secret sync") as [string, string];
        const body = await this.api.request<{ secretSync?: InfSecretSync }>(
          `/api/v1/secret-syncs/${encodeURIComponent(destination)}/${encodeURIComponent(syncId)}`,
        );
        if (!body.secretSync) throw notFound("secret sync", id);
        return this.mapSync(accountId, body.secretSync, await this.syncOptions());
      }
      case "integration": {
        const body = await this.api.request<{
          integration?: InfIntegration & { projectId?: string };
        }>(`/api/v1/integration/${encodeURIComponent(id)}`);
        if (!body.integration) throw notFound("integration", id);
        return this.mapIntegration(accountId, str(body.integration.projectId), body.integration);
      }
      case "machine-identity": {
        const body = await this.api.request<{ identity?: InfIdentityMembership }>(
          `/api/v1/identities/${encodeURIComponent(id)}`,
        );
        if (!body.identity) throw notFound("machine identity", id);
        return this.mapIdentity(accountId, body.identity);
      }
      case "certificate-authority": {
        const body = await this.api.request<{ ca?: InfCa }>(
          `/api/v1/pki/ca/${encodeURIComponent(id)}`,
        );
        if (!body.ca) throw notFound("certificate authority", id);
        return this.mapCa(accountId, body.ca, str(body.ca.projectId));
      }
      case "certificate": {
        const body = await this.api.request<{ certificate?: InfCertificate }>(
          `/api/v1/cert-manager/certificates/${encodeURIComponent(id)}`,
        );
        if (!body.certificate) throw notFound("certificate", id);
        return this.mapCertificate(accountId, body.certificate, str(body.certificate.projectId));
      }
      default:
        throw new Error(`Infisical plugin: unknown resource type "${typeId}"`);
    }
  }

  private async fetchSecret(secretId: string): Promise<InfSecret> {
    const body = await this.api.request<{ secret?: InfSecret }>(
      `/api/v4/secrets/id/${encodeURIComponent(secretId)}`,
    );
    if (!body.secret) throw notFound("secret", secretId);
    return body.secret;
  }

  /** `{projectId}/{env}/{encoded path}/{name}` → parts. */
  private dynamicRef(externalId: string) {
    const [projectId, env, encodedPath, name] = split(externalId, 4, "dynamic secret") as [
      string,
      string,
      string,
      string,
    ];
    return { projectId, env, path: decodeURIComponent(encodedPath), name };
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const id = externalIdOf(resourceId);
    if (typeId === "secret" && outputKey === "value") {
      const secret = await this.fetchSecret(id);
      if (secret.secretValueHidden) {
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
      const body = await this.api.request<{ certificate?: string; certificateChain?: string }>(
        `/api/v1/pki/ca/${encodeURIComponent(id)}/certificate`,
      );
      return [str(body.certificate), str(body.certificateChain)].filter(Boolean).join("\n");
    }
    if (typeId === "certificate" && outputKey === "certificate") {
      const body = await this.api.request<{
        certificate?: string;
        certificateChain?: string | null;
      }>(`/api/v1/cert-manager/certificates/${encodeURIComponent(id)}/certificate`);
      return [str(body.certificate), str(body.certificateChain)].filter(Boolean).join("\n");
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.resolvedOutputs[outputKey];
    if (value !== undefined) return value;
    throw new Error(`Infisical plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  private async universalAuth(identityId: string): Promise<InfUniversalAuth | null> {
    try {
      const body = await this.api.request<{ identityUniversalAuth?: InfUniversalAuth }>(
        `/api/v1/auth/universal-auth/identities/${encodeURIComponent(identityId)}`,
      );
      return body.identityUniversalAuth ?? null;
    } catch (error) {
      const status = (error as { status?: number }).status;
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

  async verifyCredentials(): Promise<PreflightResult> {
    const checks: PreflightCapabilityCheck[] = [];
    const probe = async (capabilityId: string, run: () => Promise<unknown>, permission: string) => {
      try {
        await run();
        checks.push({ capabilityId, status: "ok" });
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 401 || status === 403) {
          checks.push({
            capabilityId,
            status: "missing",
            missingPermissions: [{ id: permission, label: permission }],
            message: (error as Error).message,
          });
        } else {
          checks.push({ capabilityId, status: "unknown", message: (error as Error).message });
        }
      }
    };
    let organization = "";
    await probe(
      "login",
      async () => {
        const body = await this.api.request<{
          identityDetails?: { organization?: { name?: string; slug?: string } };
        }>("/api/v1/identities/details");
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
      () => this.api.request("/api/v1/organization/audit-logs", { query: { limit: 1 } }),
      "Organization role with Audit Logs read access",
    );
    return { checks, ...(organization ? { identity: organization } : {}) };
  }

  // -------------------------------------------------------------------------
  // Metrics, stats and logs
  // -------------------------------------------------------------------------

  private async auditLogs(
    query: Record<string, string | number>,
    maxPages: number,
  ): Promise<InfAuditLog[]> {
    const out: InfAuditLog[] = [];
    for (let page = 0; page < maxPages; page++) {
      const body = await this.api.request<{ auditLogs?: InfAuditLog[] }>(
        "/api/v1/organization/audit-logs",
        { query: { ...query, offset: page * Number(query["limit"] ?? AUDIT_PAGE_SIZE) } },
      );
      const items = body.auditLogs ?? [];
      out.push(...items);
      if (items.length < Number(query["limit"] ?? AUDIT_PAGE_SIZE)) break;
    }
    return out;
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
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
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
  ): Promise<DashboardStat[]> {
    const id = externalIdOf(resourceId);
    if (resourceTypeId === "project") {
      const project = await this.project(id);
      if (project.type && project.type !== "secret-manager") {
        return [{ label: "Product", value: str(project.type) }];
      }
      const syncs = await this.syncsIn(id).catch(() => [] as InfSecretSync[]);
      const failing = syncs.filter((s) => s.syncStatus === "failed").length;
      return [
        { label: "Environments", value: String(project.environments?.length ?? 0) },
        { label: "Secret Syncs", value: String(syncs.length) },
        { label: "Failing Syncs", value: String(failing) },
      ];
    }
    if (resourceTypeId === "environment") {
      const [projectId] = split(id, 2, "environment") as [string, string];
      const project = await this.project(projectId);
      const envId = id.split("/")[1];
      const env = (project.environments ?? []).find((e) => e.id === envId);
      if (!env) return [];
      const [secrets, folders] = await Promise.all([
        this.secretsIn(projectId, str(env.slug)).catch(() => [] as InfSecret[]),
        this.foldersIn(projectId, str(env.slug)).catch(() => [] as InfFolder[]),
      ]);
      return [
        { label: "Secrets", value: String(secrets.length) },
        { label: "Folders", value: String(folders.length) },
      ];
    }
    return [];
  }

  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    const id = externalIdOf(resourceId);
    const limit = Math.min(Math.max(params.tailLines ?? 100, 1), 1000);
    const query: Record<string, string | number> = { limit };
    if (typeId === "project") query["projectId"] = id;
    else if (typeId === "environment") {
      const [projectId] = split(id, 2, "environment") as [string, string];
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
        const meta = (log.event?.metadata ?? {}) as Record<string, unknown>;
        const subject =
          str(meta["secretKey"]) ||
          str(meta["secretPath"]) ||
          str(meta["name"]) ||
          str(meta["environment"]);
        const actorMeta = (log.actor?.metadata ?? {}) as Record<string, unknown>;
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
          () => [] as InfFolder[],
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
    const body = await this.api
      .request<{ roles?: InfRole[] }>("/api/v1/organization/roles")
      .catch(() => ({ roles: [] as InfRole[] }));
    const custom = (body.roles ?? [])
      .filter((r) => r.slug && !BUILTIN_ORG_ROLES.some((b) => b.id === r.slug))
      .map((r) => ({ id: str(r.slug), label: str(r.name) || str(r.slug) }));
    return [...BUILTIN_ORG_ROLES, ...custom];
  }

  async projectRoleOptions(projectId: string): Promise<SelectOption[]> {
    const body = await this.api
      .request<{ roles?: InfRole[] }>(`/api/v1/projects/${encodeURIComponent(projectId)}/roles`)
      .catch(() => ({ roles: [] as InfRole[] }));
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

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
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
            { key: "key", label: "Key", kind: "text", required: true, placeholder: "DATABASE_URL" },
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
        const profiles = await this.api
          .request<{ certificateProfiles?: InfCertificateProfile[] }>(
            "/api/v1/cert-manager/certificate-profiles",
            { query: { limit: 100, enrollmentType: "api" } },
          )
          .then((b) => b.certificateProfiles ?? [])
          .catch(() => [] as InfCertificateProfile[]);
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
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    this.projectsCache = null;
    switch (typeId) {
      case "project": {
        const type = fields["type"] || "secret-manager";
        const body = await this.api.request<{ project?: InfProject }>("/api/v1/projects", {
          method: "POST",
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
        const body = await this.api.request<{ environment?: InfEnvironment }>(
          `/api/v1/projects/${encodeURIComponent(projectId)}/environments`,
          { method: "POST", body: { name: fields["name"], slug: fields["slug"] } },
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
        const body = await this.api.request<{ folder?: InfFolder }>("/api/v2/folders", {
          method: "POST",
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
        const body = await this.api.request<{ secret?: InfSecret; approval?: unknown }>(
          `/api/v4/secrets/${encodeURIComponent(key)}`,
          {
            method: "POST",
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
        const body = await this.api.request<{
          identity?: { id?: string; name?: string; createdAt?: string };
        }>("/api/v1/identities", {
          method: "POST",
          body: {
            name: fields["name"],
            organizationId: orgId,
            role: fields["role"] || "no-access",
          },
        });
        const identityId = str(body.identity?.id);
        if (!identityId) throw new Error("Infisical plugin: identity creation returned no id");
        if (fields["enableUniversalAuth"] !== "false") {
          await this.api.request(
            `/api/v1/auth/universal-auth/identities/${encodeURIComponent(identityId)}`,
            {
              method: "POST",
              body: {},
            },
          );
        }
        return this.getResource(
          "machine-identity",
          `${accountId}:machine-identity:${identityId}`,
          accountId,
        );
      }
      case "certificate": {
        const projectId = parentResourceId ? externalIdOf(parentResourceId) : fields["projectId"];
        const altNames = (fields["altNames"] ?? "")
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean)
          .map((value) => ({ type: "dns_name", value }));
        const body = await this.api.request<{
          certificate?: { certificateId?: string } | null;
          status?: string;
          message?: string;
        }>("/api/v1/cert-manager/certificates", {
          method: "POST",
          body: {
            profileId: fields["profileId"],
            attributes: {
              commonName: fields["commonName"],
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
        const resource = await this.getResource(
          "certificate",
          `${accountId}:certificate:${certId}`,
          accountId,
        );
        if (projectId && !resource.fields["projectId"]) resource.fields["projectId"] = projectId;
        return resource;
      }
      default:
        throw new Error(`Infisical plugin: cannot create resource type "${typeId}"`);
    }
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "project": {
        const body: Record<string, unknown> = {};
        if (fields["name"] !== undefined) body["name"] = fields["name"];
        if (fields["description"] !== undefined) body["description"] = fields["description"];
        if (fields["slug"] !== undefined) body["slug"] = fields["slug"];
        for (const key of ["hasDeleteProtection", "autoCapitalization", "secretSharing"]) {
          const value = bool(fields[key]);
          if (value !== undefined) body[key] = value;
        }
        if (fields["pitVersionLimit"]) body["pitVersionLimit"] = Number(fields["pitVersionLimit"]);
        const res = await this.api.request<{ project?: InfProject }>(
          `/api/v1/projects/${encodeURIComponent(id)}`,
          { method: "PATCH", body },
        );
        this.projectsCache = null;
        return res.project
          ? this.mapProject(accountId, { ...(await this.project(id)), ...res.project })
          : this.getResource(typeId, resourceId, accountId);
      }
      case "environment": {
        const [projectId, envId] = split(id, 2, "environment") as [string, string];
        const body: Record<string, unknown> = {};
        if (fields["name"] !== undefined) body["name"] = fields["name"];
        if (fields["slug"] !== undefined) body["slug"] = fields["slug"];
        if (fields["position"]) body["position"] = Number(fields["position"]);
        await this.api.request(
          `/api/v1/projects/${encodeURIComponent(projectId)}/environments/${encodeURIComponent(envId)}`,
          { method: "PATCH", body },
        );
        this.projectsCache = null;
        return this.getResource(typeId, resourceId, accountId);
      }
      case "folder": {
        const current = await this.getResource(typeId, resourceId, accountId);
        const [projectId, envSlug, folderId] = split(id, 3, "folder") as [string, string, string];
        const path = str(current.fields["path"]);
        await this.api.request(`/api/v2/folders/${encodeURIComponent(folderId)}`, {
          method: "PATCH",
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
        return this.getResource(typeId, resourceId, accountId);
      }
      case "secret": {
        const secret = await this.fetchSecret(id);
        const days = fields["reminderRepeatDays"];
        const body: Record<string, unknown> = {
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
        const res = await this.api.request<{ secret?: InfSecret; approval?: unknown }>(
          `/api/v4/secrets/${encodeURIComponent(str(secret.secretKey))}`,
          { method: "PATCH", body },
        );
        if (!res.secret) {
          throw Object.assign(
            new Error(
              "Infisical requires approval for changes in this environment. A change request was opened.",
            ),
            { status: 202 },
          );
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "dynamic-secret": {
        const ref = this.dynamicRef(id);
        const project = await this.project(ref.projectId);
        const data: Record<string, unknown> = {};
        if (fields["defaultTTL"]) data["defaultTTL"] = fields["defaultTTL"];
        if (fields["maxTTL"] !== undefined) data["maxTTL"] = fields["maxTTL"] || null;
        if (fields["name"] && fields["name"] !== ref.name) data["newName"] = fields["name"];
        await this.api.request(`/api/v1/dynamic-secrets/${encodeURIComponent(ref.name)}`, {
          method: "PATCH",
          body: { projectSlug: str(project.slug), environmentSlug: ref.env, path: ref.path, data },
        });
        const name = str(data["newName"]) || ref.name;
        return this.getResource(
          typeId,
          `${accountId}:dynamic-secret:${ref.projectId}/${ref.env}/${encodeURIComponent(ref.path)}/${name}`,
          accountId,
        );
      }
      case "secret-sync": {
        const [destination, syncId] = split(id, 2, "secret sync") as [string, string];
        const body: Record<string, unknown> = {};
        if (fields["name"] !== undefined) body["name"] = fields["name"];
        if (fields["description"] !== undefined)
          body["description"] = fields["description"] || null;
        const auto = bool(fields["isAutoSyncEnabled"]);
        if (auto !== undefined) body["isAutoSyncEnabled"] = auto;
        if (fields["environment"]) body["environment"] = fields["environment"];
        if (fields["secretPath"]) body["secretPath"] = fields["secretPath"];
        await this.api.request(
          `/api/v1/secret-syncs/${encodeURIComponent(destination)}/${encodeURIComponent(syncId)}`,
          { method: "PATCH", body },
        );
        return this.getResource(typeId, resourceId, accountId);
      }
      case "machine-identity": {
        const body: Record<string, unknown> = {};
        if (fields["name"] !== undefined) body["name"] = fields["name"];
        if (fields["role"]) body["role"] = fields["role"];
        const protect = bool(fields["hasDeleteProtection"]);
        if (protect !== undefined) body["hasDeleteProtection"] = protect;
        await this.api.request(`/api/v1/identities/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body,
        });
        return this.getResource(typeId, resourceId, accountId);
      }
      default:
        throw new Error(`Infisical plugin: cannot update resource type "${typeId}"`);
    }
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    const id = externalIdOf(resourceId);
    this.projectsCache = null;
    switch (typeId) {
      case "project":
        await this.api.request(`/api/v1/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
        return;
      case "environment": {
        const [projectId, envId] = split(id, 2, "environment") as [string, string];
        await this.api.request(
          `/api/v1/projects/${encodeURIComponent(projectId)}/environments/${encodeURIComponent(envId)}`,
          { method: "DELETE" },
        );
        return;
      }
      case "folder": {
        const current = await this.getResource(typeId, resourceId, accountId);
        const [projectId, envSlug, folderId] = split(id, 3, "folder") as [string, string, string];
        await this.api.request(`/api/v2/folders/${encodeURIComponent(folderId)}`, {
          method: "DELETE",
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
        await this.api.request(`/api/v4/secrets/${encodeURIComponent(str(secret.secretKey))}`, {
          method: "DELETE",
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
        await this.api.request(`/api/v1/dynamic-secrets/${encodeURIComponent(ref.name)}`, {
          method: "DELETE",
          body: { projectSlug: str(project.slug), environmentSlug: ref.env, path: ref.path },
        });
        return;
      }
      case "secret-sync": {
        const [destination, syncId] = split(id, 2, "secret sync") as [string, string];
        await this.api.request(
          `/api/v1/secret-syncs/${encodeURIComponent(destination)}/${encodeURIComponent(syncId)}`,
          { method: "DELETE", query: { removeSecrets: false } },
        );
        return;
      }
      case "integration":
        await this.api.request(`/api/v1/integration/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        return;
      case "machine-identity":
        await this.api.request(`/api/v1/identities/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        return;
      case "certificate-authority":
        await this.api.request(`/api/v1/pki/ca/${encodeURIComponent(id)}`, { method: "DELETE" });
        return;
      case "certificate":
        await this.api.request(`/api/v1/cert-manager/certificates/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        return;
      default:
        throw new Error(`Infisical plugin: cannot delete resource type "${typeId}"`);
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const id = externalIdOf(resourceId);
    if (typeId === "secret-sync") {
      const [destination, syncId] = split(id, 2, "secret sync") as [string, string];
      const base = `/api/v1/secret-syncs/${encodeURIComponent(destination)}/${encodeURIComponent(syncId)}`;
      // Both queue a job; the sync's status fields report how it went.
      const verbs: Record<string, string> = { sync: "sync-secrets", remove: "remove-secrets" };
      const verb = verbs[actionId];
      if (verb) {
        await this.api.request(`${base}/${verb}`, { method: "POST" });
        return;
      }
    }
    if (typeId === "integration" && actionId === "sync") {
      await this.api.request(`/api/v1/integration/${encodeURIComponent(id)}/sync`, {
        method: "POST",
      });
      return;
    }
    if (typeId === "machine-identity") {
      if (actionId === "enable-universal-auth") {
        await this.api.request(`/api/v1/auth/universal-auth/identities/${encodeURIComponent(id)}`, {
          method: "POST",
          body: {},
        });
        return;
      }
      if (actionId === "clear-lockouts") {
        await this.api.request(
          `/api/v1/auth/universal-auth/identities/${encodeURIComponent(id)}/clear-lockouts`,
          { method: "POST" },
        );
        return;
      }
    }
    if (typeId === "certificate" && actionId === "renew") {
      await this.api.request(`/api/v1/cert-manager/certificates/${encodeURIComponent(id)}/renew`, {
        method: "POST",
        body: {},
      });
      return;
    }
    throw new Error(`Infisical plugin: unknown action "${actionId}" for type "${typeId}"`);
  }

  /** Form-driven actions. Form values arrive JSON-encoded in `args[0]`. */
  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const values = JSON.parse(String(args[0] ?? "{}")) as Record<string, string>;
    const id = externalIdOf(resourceId);

    if (typeId === "machine-identity" && command === "add-to-project") {
      const projectId = values["projectId"];
      if (!projectId) throw new Error("Infisical plugin: choose a project");
      return this.api.request(
        `/api/v1/projects/${encodeURIComponent(projectId)}/identity-memberships/${encodeURIComponent(id)}`,
        {
          method: "POST",
          body: { roles: [{ role: values["role"] || "viewer", isTemporary: false }] },
        },
      );
    }
    if (typeId === "machine-identity" && command === "remove-from-project") {
      const projectId = values["projectId"];
      if (!projectId) throw new Error("Infisical plugin: choose a project");
      return this.api.request(
        `/api/v1/projects/${encodeURIComponent(projectId)}/identity-memberships/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
    }
    if (typeId === "machine-identity" && command === "revoke-client-secret") {
      const secretId = values["clientSecretId"];
      if (!secretId) throw new Error("Infisical plugin: choose a client secret");
      return this.api.request(
        `/api/v1/auth/universal-auth/identities/${encodeURIComponent(id)}/client-secrets/${encodeURIComponent(secretId)}/revoke`,
        { method: "POST" },
      );
    }
    if (typeId === "machine-identity" && command === "configure-universal-auth") {
      const body: Record<string, unknown> = {};
      for (const key of ["accessTokenTTL", "accessTokenMaxTTL", "accessTokenNumUsesLimit"]) {
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
      return this.api.request(`/api/v1/auth/universal-auth/identities/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body,
      });
    }
    if (typeId === "secret-sync" && command === "import") {
      const [destination, syncId] = split(id, 2, "secret sync") as [string, string];
      return this.api.request(
        `/api/v1/secret-syncs/${encodeURIComponent(destination)}/${encodeURIComponent(syncId)}/import-secrets`,
        {
          method: "POST",
          query: { importBehavior: values["importBehavior"] || "prioritize-source" },
        },
      );
    }
    if (typeId === "dynamic-secret" && command === "revoke-lease") {
      const ref = this.dynamicRef(id);
      const project = await this.project(ref.projectId);
      const leaseId = values["leaseId"];
      if (!leaseId) throw new Error("Infisical plugin: choose a lease");
      return this.api.request(`/api/v1/dynamic-secrets/leases/${encodeURIComponent(leaseId)}`, {
        method: "DELETE",
        body: { projectSlug: str(project.slug), environmentSlug: ref.env, path: ref.path },
      });
    }
    if (typeId === "certificate" && command === "revoke") {
      return this.api.request(
        `/api/v1/cert-manager/certificates/${encodeURIComponent(id)}/revoke`,
        {
          method: "POST",
          body: { revocationReason: values["reason"] || "UNSPECIFIED" },
        },
      );
    }
    throw new Error(`Infisical plugin: unknown command "${command}" for type "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Credential export
  // -------------------------------------------------------------------------

  async exportCredential(
    typeId: string,
    resourceId: string,
    _accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    const id = externalIdOf(resourceId);
    if (typeId === "machine-identity" && formatId === "universal-auth-client-secret") {
      const ua = await this.universalAuth(id);
      if (!ua?.clientId) {
        throw new Error("Infisical plugin: enable Universal Auth on this identity first");
      }
      const body = await this.api.request<{ clientSecret?: string }>(
        `/api/v1/auth/universal-auth/identities/${encodeURIComponent(id)}/client-secrets`,
        { method: "POST", body: { description: "Created from Infrawrench" } },
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
      const body = await this.api.request<{ lease?: InfLease; data?: unknown }>(
        "/api/v1/dynamic-secrets/leases",
        {
          method: "POST",
          body: {
            dynamicSecretName: ref.name,
            projectSlug: str(project.slug),
            environmentSlug: ref.env,
            path: ref.path,
          },
        },
      );
      const data = (body.data ?? {}) as Record<string, unknown>;
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
      const pem = await this.resolveOutput(typeId, resourceId, "certificate", _accountId);
      return { content: pem, filename: `${id}-ca.pem`, mimeType: "application/x-pem-file" };
    }
    if (typeId === "certificate" && formatId === "certificate") {
      const pem = await this.resolveOutput(typeId, resourceId, "certificate", _accountId);
      return { content: pem, filename: `${id}.pem`, mimeType: "application/x-pem-file" };
    }
    if (typeId === "certificate" && formatId === "bundle") {
      const body = await this.api.request<{
        certificate?: string;
        certificateChain?: string | null;
        privateKey?: string | null;
      }>(`/api/v1/cert-manager/certificates/${encodeURIComponent(id)}/bundle`);
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
  }

  // -------------------------------------------------------------------------
  // Detail enrichment + rendering
  // -------------------------------------------------------------------------

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const id = externalIdOf(resource.id);
    const extra: Record<string, string> = {};
    switch (resource.resourceTypeId) {
      case "machine-identity": {
        const [ua, secrets, projects] = await Promise.all([
          this.universalAuth(id).catch(() => null),
          this.api
            .request<{ clientSecretData?: InfClientSecret[] }>(
              `/api/v1/auth/universal-auth/identities/${encodeURIComponent(id)}/client-secrets`,
            )
            .then((b) => b.clientSecretData ?? [])
            .catch(() => [] as InfClientSecret[]),
          this.projects().catch(() => [] as InfProject[]),
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
        const leases = await this.api
          .request<{ leases?: InfLease[] }>(
            `/api/v1/dynamic-secrets/${encodeURIComponent(ref.name)}/leases`,
            {
              query: { projectSlug: str(project.slug), environmentSlug: ref.env, path: ref.path },
            },
          )
          .then((b) => b.leases ?? [])
          .catch(() => [] as InfLease[]);
        extra["__leases__"] = JSON.stringify(leases);
        break;
      }
      case "project": {
        const projectId = id;
        const type = String(resource.fields["type"] ?? "");
        if (type === "secret-manager" || !type) {
          const members = await this.api
            .request<{
              identityMemberships?: Array<{
                identity?: { name?: string };
                roles?: Array<{ role?: string; customRoleSlug?: string | null }>;
              }>;
            }>(`/api/v1/projects/${encodeURIComponent(projectId)}/identity-memberships`)
            .then((b) => b.identityMemberships ?? [])
            .catch(() => []);
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
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderDetail(resource, this.api.siteUrl);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderSidebarItem(resource);
  }
}
