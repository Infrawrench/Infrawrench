import type {
  ArtifactEntry,
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
  PreflightResult,
  QuotaUsage,
  ResourceCreateReturn,
  ResourceInstance,
  SelectOption,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type { GitLabContext } from "./api.js";
import {
  enc,
  glCount,
  glFetch,
  glGraphql,
  glPaged,
  isAbsent,
  isPermissionError,
  resolveBaseUrl,
  splitScoped,
  statusOf,
} from "./api.js";
import {
  commaList,
  hookEventFlags,
  optionalDate,
  optionalInt,
  parseVariableLines,
  truthy,
  validateCron,
  validateVariableKey,
} from "./inputs.js";
import type { Scope } from "./mappers.js";
import {
  BRANCH_LEVELS,
  MEMBER_LEVELS,
  accessOf,
  branchLevelValue,
  mapContainerRepository,
  mapDeployKey,
  mapDeployToken,
  mapEnvironment,
  mapGroup,
  mapHook,
  mapMember,
  mapPackage,
  mapPipeline,
  mapProject,
  mapProtectedBranch,
  mapRelease,
  mapRunner,
  mapSchedule,
  mapVariable,
  memberLevelValue,
} from "./mappers.js";
import {
  environmentSeries,
  groupSeries,
  projectSeries,
  rangeOrDefault,
  runnerSeries,
} from "./metrics.js";
import { DETAIL_KEYS, renderGitLabDetail, renderGitLabSidebar } from "./render.js";
import type {
  GlDeployKey,
  GlDeployToken,
  GlDeployment,
  GlEnvironment,
  GlGroup,
  GlHook,
  GlJob,
  GlMember,
  GlNamespace,
  GlPackage,
  GlPackageFile,
  GlPipeline,
  GlProject,
  GlProtectedBranch,
  GlRegistryRepository,
  GlRegistryTag,
  GlRelease,
  GlRunner,
  GlSchedule,
  GlUser,
  GlVariable,
} from "./types.js";

/** Project pages read for the inventory (100 each, most recently active first). */
const PROJECT_PAGES = 5;
/**
 * Projects whose children (pipelines, variables, environments, ...) are
 * listed: the most recently active non-archived ones. Each child type costs
 * one request per project, so this bounds a sync on a large instance.
 */
export const FANOUT_LIMIT = 100;
/** Pipelines listed per project, and in total. */
const PIPELINES_PER_PROJECT = 10;
const PIPELINE_LIMIT = 300;
/** Runners read in full (the list omits tags, version and last contact). */
const RUNNER_DETAIL_LIMIT = 100;
const MAINTAINER = 40;

/** One project or group, the way child listers and mappers need it. */
const scopeOfProject = (p: GlProject): Scope => ({
  kind: "project",
  id: p.id,
  path: p.path_with_namespace,
  ...(p.web_url ? { webUrl: p.web_url } : {}),
});
const scopeOfGroup = (g: GlGroup): Scope => ({
  kind: "group",
  id: g.id,
  path: g.full_path,
  ...(g.web_url ? { webUrl: g.web_url } : {}),
});

const enabled = (level: string | undefined) => level !== "disabled";

/** Attach detail-only data to a resource for the renderer. */
export function stash(r: ResourceInstance, data: Record<string, unknown>): ResourceInstance {
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) if (v !== undefined) extra[k] = JSON.stringify(v);
  return { ...r, resolvedOutputs: { ...r.resolvedOutputs, ...extra } };
}

function fail(message: string, status = 400): never {
  const err = new Error(`GitLab plugin: ${message}`) as Error & { status: number };
  err.status = status;
  throw err;
}

export class GitLabClient implements PluginClient {
  readonly ctx: GitLabContext;
  private readonly groupValue: string;
  private readonly services: HostServices | undefined;
  private projectsCache: Promise<GlProject[]> | undefined;
  private groupsCache: Promise<GlGroup[]> | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const token = (credentials["token"] ?? "").trim();
    if (!token) throw new Error("GitLab plugin: missing token credential");
    const caCert = (credentials["caCert"] ?? "").trim();
    this.ctx = {
      baseUrl: resolveBaseUrl(credentials["url"]),
      token,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
    this.groupValue = (credentials["group"] ?? "").trim();
    this.services = services;
  }

  // -------------------------------------------------------------------------
  // Shared lookups
  // -------------------------------------------------------------------------

  /** The scoped group id, as GitLab accepts it in a path (id or URL-encoded full path). */
  private get groupRef(): string | undefined {
    return this.groupValue ? enc(this.groupValue) : undefined;
  }

  private cached<T>(key: "projectsCache" | "groupsCache", load: () => Promise<T>): Promise<T> {
    const self = this as unknown as Record<string, Promise<T> | undefined>;
    self[key] ??= load().catch((err: unknown) => {
      self[key] = undefined;
      throw err;
    });
    return self[key]!;
  }

  private projects(): Promise<GlProject[]> {
    return this.cached("projectsCache", async () => {
      const query = { order_by: "last_activity_at", sort: "desc", statistics: true };
      const list = this.groupRef
        ? await glPaged<GlProject>(
            this.ctx,
            `/groups/${this.groupRef}/projects`,
            { ...query, include_subgroups: true, with_shared: false },
            PROJECT_PAGES,
          )
        : await glPaged<GlProject>(
            this.ctx,
            "/projects",
            { ...query, membership: true },
            PROJECT_PAGES,
          );
      return list;
    });
  }

  /** The projects whose children are listed. */
  private async fanout(filter: (p: GlProject) => boolean = () => true): Promise<GlProject[]> {
    const all = await this.projects();
    return all
      .filter((p) => !p.archived && !p.marked_for_deletion_on)
      .slice(0, FANOUT_LIMIT)
      .filter(filter);
  }

  private groups(): Promise<GlGroup[]> {
    return this.cached("groupsCache", async () => {
      if (this.groupRef) {
        const [root, descendants] = await Promise.all([
          glFetch<GlGroup>(this.ctx, `/groups/${this.groupRef}`, {
            query: { with_projects: false },
          }),
          glPaged<GlGroup>(this.ctx, `/groups/${this.groupRef}/descendant_groups`, {}, 5).catch(
            () => [] as GlGroup[],
          ),
        ]);
        return [root, ...descendants];
      }
      return glPaged<GlGroup>(this.ctx, "/groups", { min_access_level: 10, order_by: "name" }, 5);
    });
  }

  private async projectScope(projectId: string): Promise<Scope> {
    const known = (await this.projects().catch(() => [] as GlProject[])).find(
      (p) => String(p.id) === projectId,
    );
    if (known) return scopeOfProject(known);
    return scopeOfProject(await glFetch<GlProject>(this.ctx, `/projects/${enc(projectId)}`));
  }

  private async groupScope(groupId: string): Promise<Scope> {
    const known = (await this.groups().catch(() => [] as GlGroup[])).find(
      (g) => String(g.id) === groupId,
    );
    if (known) return scopeOfGroup(known);
    return scopeOfGroup(await glFetch<GlGroup>(this.ctx, `/groups/${enc(groupId)}`));
  }

  /** Every project-scoped list, one project at a time, skipping projects that refuse. */
  private async perProject(
    filter: (p: GlProject) => boolean,
    fn: (scope: Scope, p: GlProject) => Promise<ResourceInstance[]>,
  ): Promise<ResourceInstance[]> {
    const out: ResourceInstance[] = [];
    for (const p of await this.fanout(filter)) {
      try {
        out.push(...(await fn(scopeOfProject(p), p)));
      } catch (err) {
        if (!isAbsent(err)) throw err;
      }
    }
    return out;
  }

  /** Every group-scoped list, one group at a time, skipping groups that refuse. */
  private async perGroup(
    fn: (scope: Scope) => Promise<ResourceInstance[]>,
  ): Promise<ResourceInstance[]> {
    const out: ResourceInstance[] = [];
    for (const g of await this.groups()) {
      try {
        out.push(...(await fn(scopeOfGroup(g))));
      } catch (err) {
        if (!isAbsent(err)) throw err;
      }
    }
    return out;
  }

  /** Maintainer-only endpoints are only asked of projects where the token's user is one. */
  private static maintainer(p: GlProject): boolean {
    const level = accessOf(p);
    return level === undefined || level >= MAINTAINER;
  }

  private async namespace(groupId: number | string): Promise<GlNamespace | undefined> {
    return glFetch<GlNamespace>(this.ctx, `/namespaces/${enc(String(groupId))}`).catch(
      () => undefined,
    );
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "group": {
        this.groupsCache = undefined;
        const groups = await this.groups();
        const out: ResourceInstance[] = [];
        for (const g of groups) {
          // Plan, seats and compute minutes belong to the root namespace.
          const ns = g.parent_id ? undefined : await this.namespace(g.id);
          out.push(mapGroup(accountId, g, ns));
        }
        return out;
      }
      case "project": {
        this.projectsCache = undefined;
        const projects = await this.projects();
        const counted = new Set((await this.fanout()).map((p) => p.id));
        const out: ResourceInstance[] = [];
        for (const p of projects) {
          const mrs = counted.has(p.id)
            ? await glCount(this.ctx, `/projects/${p.id}/merge_requests`, {
                state: "opened",
              }).catch(() => undefined)
            : undefined;
          out.push(mapProject(accountId, p, mrs === undefined ? {} : { openMergeRequests: mrs }));
        }
        return out;
      }
      case "pipeline": {
        const out = await this.perProject(
          (p) => enabled(p.builds_access_level) && p.jobs_enabled !== false && !p.empty_repo,
          async (s) =>
            (
              await glFetch<GlPipeline[]>(this.ctx, `/projects/${s.id}/pipelines`, {
                query: { per_page: PIPELINES_PER_PROJECT, order_by: "id", sort: "desc" },
              })
            ).map((p) => mapPipeline(accountId, s, p)),
        );
        return out
          .sort((a, b) =>
            String(b.fields["createdAt"] ?? "").localeCompare(String(a.fields["createdAt"] ?? "")),
          )
          .slice(0, PIPELINE_LIMIT);
      }
      case "environment":
        return this.perProject(
          (p) => enabled(p.environments_access_level),
          async (s) =>
            (await glPaged<GlEnvironment>(this.ctx, `/projects/${s.id}/environments`, {}, 2)).map(
              (e) => mapEnvironment(accountId, s, e),
            ),
        );
      case "protected-branch":
        return this.perProject(
          (p) => !p.empty_repo,
          async (s) =>
            (
              await glPaged<GlProtectedBranch>(
                this.ctx,
                `/projects/${s.id}/protected_branches`,
                {},
                2,
              )
            ).map((b) => mapProtectedBranch(accountId, s, b)),
        );
      case "project-variable":
        return this.perProject(GitLabClient.maintainer, async (s) =>
          (await glPaged<GlVariable>(this.ctx, `/projects/${s.id}/variables`, {}, 3)).map((v) =>
            mapVariable(accountId, s, v),
          ),
        );
      case "group-variable":
        return this.perGroup(async (s) =>
          (await glPaged<GlVariable>(this.ctx, `/groups/${s.id}/variables`, {}, 3)).map((v) =>
            mapVariable(accountId, s, v),
          ),
        );
      case "pipeline-schedule":
        return this.perProject(
          (p) => enabled(p.builds_access_level) && p.jobs_enabled !== false,
          async (s) =>
            (
              await glPaged<GlSchedule>(this.ctx, `/projects/${s.id}/pipeline_schedules`, {}, 2)
            ).map((x) => mapSchedule(accountId, s, x)),
        );
      case "container-repository":
        return this.perProject(
          (p) =>
            enabled(p.container_registry_access_level) && p.container_registry_enabled !== false,
          async (s) =>
            (
              await glPaged<GlRegistryRepository>(
                this.ctx,
                `/projects/${s.id}/registry/repositories`,
                { tags_count: true },
                3,
              )
            ).map((r) => mapContainerRepository(accountId, s, r)),
        );
      case "package": {
        if (this.groupRef) {
          // One call for the whole group; each package names its project.
          const projects = new Map((await this.projects()).map((p) => [p.id, p]));
          const packages = await glPaged<GlPackage>(
            this.ctx,
            `/groups/${this.groupRef}/packages`,
            { order_by: "created_at", sort: "desc" },
            5,
          ).catch((err: unknown) => {
            if (isAbsent(err)) return [] as GlPackage[];
            throw err;
          });
          return packages.map((pkg) => {
            const p = pkg.project_id ? projects.get(pkg.project_id) : undefined;
            const scope: Scope = p
              ? scopeOfProject(p)
              : {
                  kind: "project",
                  id: pkg.project_id ?? 0,
                  path: pkg.project_path ?? String(pkg.project_id ?? ""),
                };
            return mapPackage(accountId, scope, pkg);
          });
        }
        return this.perProject(
          (p) => p.packages_enabled !== false,
          async (s) =>
            (
              await glPaged<GlPackage>(
                this.ctx,
                `/projects/${s.id}/packages`,
                { order_by: "created_at", sort: "desc" },
                2,
              )
            ).map((pkg) => mapPackage(accountId, s, pkg)),
        );
      }
      case "deploy-key":
        return this.perProject(GitLabClient.maintainer, async (s) =>
          (await glPaged<GlDeployKey>(this.ctx, `/projects/${s.id}/deploy_keys`, {}, 2)).map((k) =>
            mapDeployKey(accountId, s, k),
          ),
        );
      case "deploy-token":
        return this.perProject(GitLabClient.maintainer, async (s) =>
          (await glPaged<GlDeployToken>(this.ctx, `/projects/${s.id}/deploy_tokens`, {}, 2)).map(
            (t) => mapDeployToken(accountId, s, t),
          ),
        );
      case "group-deploy-token":
        return this.perGroup(async (s) =>
          (await glPaged<GlDeployToken>(this.ctx, `/groups/${s.id}/deploy_tokens`, {}, 2)).map(
            (t) => mapDeployToken(accountId, s, t),
          ),
        );
      case "project-webhook":
        return this.perProject(GitLabClient.maintainer, async (s) =>
          (await glPaged<GlHook>(this.ctx, `/projects/${s.id}/hooks`, {}, 2)).map((h) =>
            mapHook(accountId, s, h),
          ),
        );
      case "group-webhook":
        return this.perGroup(async (s) =>
          (await glPaged<GlHook>(this.ctx, `/groups/${s.id}/hooks`, {}, 2)).map((h) =>
            mapHook(accountId, s, h),
          ),
        );
      case "release":
        return this.perProject(
          (p) => enabled(p.releases_access_level) && !p.empty_repo,
          async (s) =>
            (
              await glFetch<GlRelease[]>(this.ctx, `/projects/${s.id}/releases`, {
                query: { per_page: 20 },
              })
            ).map((r) => mapRelease(accountId, s, r)),
        );
      case "project-member":
        return this.perProject(
          () => true,
          async (s) =>
            (await glPaged<GlMember>(this.ctx, `/projects/${s.id}/members`, {}, 3)).map((m) =>
              mapMember(accountId, s, m),
            ),
        );
      case "group-member":
        return this.perGroup(async (s) =>
          (await glPaged<GlMember>(this.ctx, `/groups/${s.id}/members`, {}, 5)).map((m) =>
            mapMember(accountId, s, m),
          ),
        );
      case "runner":
        return (await this.runners()).map((r) => mapRunner(accountId, r));
      default:
        throw new Error(`GitLab plugin: unknown resource type "${typeId}"`);
    }
  }

  /**
   * Runners registered to the scoped group (and its subgroups) and to the
   * fan-out projects; without a group, every runner the token's user can
   * manage (`GET /runners`). Instance runners shared by everyone are left
   * out on purpose: on GitLab.com they are GitLab's fleet, not yours. The
   * list omits tags, version and last contact, so each runner is read once.
   */
  private async runners(): Promise<GlRunner[]> {
    const byId = new Map<number, GlRunner>();
    const add = (list: GlRunner[]) => {
      for (const r of list)
        if (r.runner_type !== "instance_type" || !this.groupRef) byId.set(r.id, r);
    };
    if (this.groupRef) {
      for (const g of await this.groups()) {
        add(
          await glPaged<GlRunner>(
            this.ctx,
            `/groups/${g.id}/runners`,
            { type: "group_type" },
            2,
          ).catch((err: unknown) => {
            if (isAbsent(err)) return [] as GlRunner[];
            throw err;
          }),
        );
      }
      for (const p of await this.fanout(GitLabClient.maintainer)) {
        add(
          await glPaged<GlRunner>(
            this.ctx,
            `/projects/${p.id}/runners`,
            { type: "project_type" },
            1,
          ).catch((err: unknown) => {
            if (isAbsent(err)) return [] as GlRunner[];
            throw err;
          }),
        );
      }
    } else {
      add(await glPaged<GlRunner>(this.ctx, "/runners", {}, 5));
    }
    const out: GlRunner[] = [];
    let read = 0;
    for (const r of byId.values()) {
      if (read++ < RUNNER_DETAIL_LIMIT) {
        out.push(await glFetch<GlRunner>(this.ctx, `/runners/${r.id}`).catch(() => r));
      } else out.push(r);
    }
    return out;
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
    const { scope: ownerId, rest } = splitScoped(id);
    switch (typeId) {
      case "group": {
        const g = await glFetch<GlGroup>(this.ctx, `/groups/${enc(id)}`, {
          query: { with_projects: false },
        });
        const rootId = g.parent_id ? undefined : g.id;
        const [ns, storage, subgroups] = await Promise.all([
          rootId ? this.namespace(rootId) : Promise.resolve(undefined),
          rootId ? this.groupStorage(g.full_path) : Promise.resolve(undefined),
          glFetch<GlGroup[]>(this.ctx, `/groups/${g.id}/subgroups`, {
            query: { per_page: 50 },
          }).catch(() => undefined),
        ]);
        return stash(mapGroup(accountId, g, ns), {
          [DETAIL_KEYS.storage]: storage,
          [DETAIL_KEYS.subgroups]: subgroups?.map((s) => ({
            name: s.name,
            path: s.full_path,
            url: s.web_url,
          })),
        });
      }
      case "project": {
        const p = await glFetch<GlProject>(this.ctx, `/projects/${enc(id)}`, {
          query: { statistics: true },
        });
        const [mrs, pipelines] = await Promise.all([
          glCount(this.ctx, `/projects/${p.id}/merge_requests`, { state: "opened" }).catch(
            () => undefined,
          ),
          glFetch<GlPipeline[]>(this.ctx, `/projects/${p.id}/pipelines`, {
            query: { per_page: 10, order_by: "id", sort: "desc" },
          }).catch(() => undefined),
        ]);
        return stash(
          mapProject(accountId, p, mrs === undefined ? {} : { openMergeRequests: mrs }),
          {
            [DETAIL_KEYS.pipelines]: pipelines,
            [DETAIL_KEYS.statistics]: p.statistics,
          },
        );
      }
      case "pipeline": {
        const s = await this.projectScope(ownerId);
        const [p, jobs] = await Promise.all([
          glFetch<GlPipeline>(this.ctx, `/projects/${s.id}/pipelines/${enc(rest)}`),
          glPaged<GlJob>(this.ctx, `/projects/${s.id}/pipelines/${enc(rest)}/jobs`, {}, 3).catch(
            () => undefined,
          ),
        ]);
        return stash(mapPipeline(accountId, s, p), { [DETAIL_KEYS.jobs]: jobs?.map(slimJob) });
      }
      case "environment": {
        const s = await this.projectScope(ownerId);
        const e = await glFetch<GlEnvironment>(
          this.ctx,
          `/projects/${s.id}/environments/${enc(rest)}`,
        );
        const deployments = await glFetch<GlDeployment[]>(
          this.ctx,
          `/projects/${s.id}/deployments`,
          {
            query: { environment: e.name, order_by: "id", sort: "desc", per_page: 15 },
          },
        ).catch(() => undefined);
        return stash(mapEnvironment(accountId, s, e), { [DETAIL_KEYS.deployments]: deployments });
      }
      case "protected-branch": {
        const s = await this.projectScope(ownerId);
        const b = await glFetch<GlProtectedBranch>(
          this.ctx,
          `/projects/${s.id}/protected_branches/${enc(rest)}`,
        );
        return mapProtectedBranch(accountId, s, b);
      }
      case "project-variable":
      case "group-variable": {
        const kind = typeId === "project-variable" ? "project" : "group";
        const s =
          kind === "project" ? await this.projectScope(ownerId) : await this.groupScope(ownerId);
        const { key, envScope } = splitVariable(rest);
        const v = await glFetch<GlVariable>(this.ctx, `/${kind}s/${s.id}/variables/${enc(key)}`, {
          query: { "filter[environment_scope]": envScope },
        });
        return mapVariable(accountId, s, v);
      }
      case "pipeline-schedule": {
        const s = await this.projectScope(ownerId);
        const x = await glFetch<GlSchedule>(
          this.ctx,
          `/projects/${s.id}/pipeline_schedules/${enc(rest)}`,
        );
        return mapSchedule(accountId, s, x);
      }
      case "container-repository": {
        const s = await this.projectScope(ownerId);
        const r = await glFetch<GlRegistryRepository>(
          this.ctx,
          `/registry/repositories/${enc(rest)}`,
          {
            query: { tags_count: true, size: true },
          },
        );
        return mapContainerRepository(accountId, s, r);
      }
      case "package": {
        const s = await this.projectScope(ownerId);
        const [pkg, files] = await Promise.all([
          glFetch<GlPackage>(this.ctx, `/projects/${s.id}/packages/${enc(rest)}`),
          glPaged<GlPackageFile>(
            this.ctx,
            `/projects/${s.id}/packages/${enc(rest)}/package_files`,
            {},
            2,
          ).catch(() => undefined),
        ]);
        return stash(mapPackage(accountId, s, pkg), { [DETAIL_KEYS.files]: files });
      }
      case "deploy-key": {
        const s = await this.projectScope(ownerId);
        return mapDeployKey(
          accountId,
          s,
          await glFetch<GlDeployKey>(this.ctx, `/projects/${s.id}/deploy_keys/${enc(rest)}`),
        );
      }
      case "deploy-token":
      case "group-deploy-token": {
        const kind = typeId === "deploy-token" ? "project" : "group";
        const s =
          kind === "project" ? await this.projectScope(ownerId) : await this.groupScope(ownerId);
        return mapDeployToken(
          accountId,
          s,
          await glFetch<GlDeployToken>(this.ctx, `/${kind}s/${s.id}/deploy_tokens/${enc(rest)}`),
        );
      }
      case "project-webhook":
      case "group-webhook": {
        const kind = typeId === "project-webhook" ? "project" : "group";
        const s =
          kind === "project" ? await this.projectScope(ownerId) : await this.groupScope(ownerId);
        const [h, events] = await Promise.all([
          glFetch<GlHook>(this.ctx, `/${kind}s/${s.id}/hooks/${enc(rest)}`),
          glFetch<HookEvent[]>(this.ctx, `/${kind}s/${s.id}/hooks/${enc(rest)}/events`, {
            query: { per_page: 15 },
          }).catch(() => undefined),
        ]);
        return stash(mapHook(accountId, s, h), {
          [DETAIL_KEYS.hookEvents]: events?.map((e) => ({
            id: e.id,
            trigger: e.trigger,
            status: e.response_status,
            executionDuration: e.execution_duration,
            at: e.created_at ?? e.request_data?.created_at,
          })),
        });
      }
      case "release": {
        const s = await this.projectScope(ownerId);
        return mapRelease(
          accountId,
          s,
          await glFetch<GlRelease>(this.ctx, `/projects/${s.id}/releases/${enc(rest)}`),
        );
      }
      case "project-member":
      case "group-member": {
        const kind = typeId === "project-member" ? "project" : "group";
        const s =
          kind === "project" ? await this.projectScope(ownerId) : await this.groupScope(ownerId);
        return mapMember(
          accountId,
          s,
          await glFetch<GlMember>(this.ctx, `/${kind}s/${s.id}/members/${enc(rest)}`),
        );
      }
      case "runner": {
        const [r, jobs] = await Promise.all([
          glFetch<GlRunner>(this.ctx, `/runners/${enc(id)}`),
          glFetch<GlJob[]>(this.ctx, `/runners/${enc(id)}/jobs`, {
            query: { order_by: "id", sort: "desc", per_page: 15 },
          }).catch(() => undefined),
        ]);
        return stash(mapRunner(accountId, r), { [DETAIL_KEYS.jobs]: jobs?.map(slimJob) });
      }
      default:
        throw new Error(`GitLab plugin: unknown resource type "${typeId}"`);
    }
  }

  private async groupStorage(fullPath: string): Promise<GroupStorage | undefined> {
    try {
      const res = await glGraphql<{ group?: GroupStorage }>(
        this.ctx,
        `query($path: ID!) { group(fullPath: $path) { storageSizeLimit additionalPurchasedStorageSize rootStorageStatistics { storageSize repositorySize lfsObjectsSize buildArtifactsSize pipelineArtifactsSize packagesSize containerRegistrySize wikiSize snippetsSize uploadsSize } } }`,
        { path: fullPath },
      );
      return res.data?.group ?? undefined;
    } catch {
      return undefined;
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (
      outputKey === "token" &&
      ["deploy-token", "group-deploy-token", "runner"].includes(typeId)
    ) {
      const value = await this.services?.secrets?.getPlaintext(resourceId, "token");
      if (!value) {
        throw new Error(
          "GitLab plugin: GitLab only shows a token once, and this one was not created from Infrawrench. Create a new one here to have it kept.",
        );
      }
      return value;
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    const resolved = resource.resolvedOutputs[outputKey];
    if (resolved !== undefined) return resolved;
    const field = resource.fields[outputKey];
    if (field !== undefined) return String(field);
    throw new Error(`GitLab plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Stats, metrics, quotas, preflight
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = r.fields;
    const n = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : "—");
    switch (resourceTypeId) {
      case "project":
        return [
          { label: "Open MRs", value: n(f["openMergeRequests"]) },
          { label: "Open issues", value: n(f["openIssues"]) },
        ];
      case "group":
        return [
          { label: "Plan", value: String(f["plan"] ?? "—") },
          { label: "Compute min", value: n(f["computeMinutesUsed"]) },
        ];
      case "pipeline":
        return [
          {
            label: "Status",
            value: String(f["status"] ?? "—"),
            variant:
              f["status"] === "success"
                ? "status-healthy"
                : f["status"] === "failed"
                  ? "status-error"
                  : "default",
          },
        ];
      case "runner":
        return [
          {
            label: "Status",
            value: String(f["status"] ?? "—"),
            variant: f["status"] === "online" ? "status-healthy" : "status-degraded",
          },
        ];
      default:
        return [];
    }
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const id = externalIdOf(resourceId);
    const range = rangeOrDefault(timeRange);
    switch (resourceTypeId) {
      case "project":
        return projectSeries(this.ctx, enc(id), range);
      case "runner":
        return runnerSeries(this.ctx, enc(id), range);
      case "group":
        return groupSeries(this.ctx, id, range);
      case "environment": {
        const { scope, rest } = splitScoped(id);
        const e = await glFetch<GlEnvironment>(
          this.ctx,
          `/projects/${enc(scope)}/environments/${enc(rest)}`,
        );
        return environmentSeries(this.ctx, enc(scope), e.name, range);
      }
      default:
        return [];
    }
  }

  /**
   * Compute minutes and storage against the root group's limits. Both halves
   * come from GitLab: the minutes quota is only returned to instance
   * administrators (`shared_runners_minutes_limit`), and the storage limit
   * only applies under namespace storage enforcement (`storageSizeLimit`
   * above zero). Whatever GitLab does not state is not reported.
   */
  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
    if (!this.groupRef) return [];
    const groups = await this.groups();
    const out: QuotaUsage[] = [];
    for (const g of groups.filter((x) => !x.parent_id)) {
      const ns = await this.namespace(g.id);
      const base = ns?.shared_runners_minutes_limit;
      const used = ns?.ci_minutes_usage?.total_minutes_used;
      if (typeof base === "number" && base > 0 && typeof used === "number") {
        out.push({
          id: `compute-minutes/${g.id}`,
          service: "CI/CD",
          name: `Compute minutes (${g.full_path})`,
          limit: base + (ns?.extra_shared_runners_minutes_limit ?? 0),
          used,
          unit: "minutes",
          adjustable: true,
          docsUrl: "https://docs.gitlab.com/ci/pipelines/compute_minutes/",
        });
      }
      const storage = await this.groupStorage(g.full_path);
      const limit =
        (storage?.storageSizeLimit ?? 0) + (storage?.additionalPurchasedStorageSize ?? 0);
      const size = storage?.rootStorageStatistics?.storageSize;
      if ((storage?.storageSizeLimit ?? 0) > 0 && typeof size === "number") {
        out.push({
          id: `storage/${g.id}`,
          service: "Storage",
          name: `Namespace storage (${g.full_path})`,
          limit,
          used: size,
          unit: "bytes",
          adjustable: true,
          docsUrl: "https://docs.gitlab.com/user/storage_usage_quotas/",
        });
      }
    }
    return out;
  }

  async verifyCredentials(): Promise<PreflightResult> {
    let scopes: string[] | undefined;
    let identity: string | undefined;
    try {
      const self = await glFetch<{ scopes?: string[]; name?: string; expires_at?: string | null }>(
        this.ctx,
        "/personal_access_tokens/self",
      );
      scopes = self.scopes;
      identity = self.name
        ? `${self.name}${self.expires_at ? ` (expires ${self.expires_at})` : ""}`
        : undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        checks: ["inventory", "manage", "runners"].map((capabilityId) => ({
          capabilityId,
          status: "unknown" as const,
          message: isPermissionError(err) ? "GitLab rejected the token." : message,
        })),
      };
    }
    const has = (s: string) => scopes?.includes(s) ?? false;
    const missing = (capabilityId: string, perms: Array<{ id: string; label: string }>) => ({
      capabilityId,
      status: "missing" as const,
      missingPermissions: perms,
      helpLink: {
        label: "Access token scopes",
        url: "https://docs.gitlab.com/security/tokens/access_token_scopes/",
      },
    });
    const ok = (capabilityId: string) => ({ capabilityId, status: "ok" as const });
    return {
      ...(identity ? { identity } : {}),
      checks: [
        has("api") || has("read_api") ? ok("inventory") : missing("inventory", [SCOPE_READ_API]),
        has("api") ? ok("manage") : missing("manage", [SCOPE_API]),
        has("create_runner")
          ? ok("runners")
          : has("api")
            ? {
                capabilityId: "runners",
                status: "unknown" as const,
                message:
                  "GitLab documents create_runner for creating runners; api may not be enough.",
              }
            : missing("runners", [SCOPE_CREATE_RUNNER]),
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Create forms
  // -------------------------------------------------------------------------

  private async projectOptions(
    filter: (p: GlProject) => boolean = () => true,
  ): Promise<SelectOption[]> {
    const projects = await this.projects().catch(() => [] as GlProject[]);
    return projects
      .filter((p) => !p.archived)
      .filter(filter)
      .map((p) => ({ id: String(p.id), label: p.path_with_namespace }));
  }

  private async groupOptions(): Promise<SelectOption[]> {
    const groups = await this.groups().catch(() => [] as GlGroup[]);
    return groups.map((g) => ({ id: String(g.id), label: g.full_path }));
  }

  private async ownerField(
    kind: "project" | "group",
    parentResourceId: string | undefined,
    filter?: (p: GlProject) => boolean,
  ): Promise<CreateFieldConfig[]> {
    if (parentResourceId) return [];
    const options =
      kind === "project" ? await this.projectOptions(filter) : await this.groupOptions();
    return [
      {
        key: kind,
        label: kind === "project" ? "Project" : "Group",
        kind: "select",
        required: true,
        ...(options[0] ? { defaultValue: options[0].id } : {}),
        options,
      },
    ];
  }

  /** Branches (and optionally tags) of a project, for ref pickers. */
  private async refField(
    projectId: string | undefined,
    key: string,
    label: string,
    opts: { tags?: boolean; required?: boolean; description?: string } = {},
  ): Promise<CreateFieldConfig> {
    const base = {
      key,
      label,
      required: opts.required ?? true,
      ...(opts.description ? { description: opts.description } : {}),
    };
    if (!projectId) {
      return { ...base, kind: "text", placeholder: "main" };
    }
    const [project, branches, tags] = await Promise.all([
      glFetch<GlProject>(this.ctx, `/projects/${enc(projectId)}`).catch(() => undefined),
      glFetch<Array<{ name: string }>>(
        this.ctx,
        `/projects/${enc(projectId)}/repository/branches`,
        {
          query: { per_page: 100 },
        },
      ).catch(() => [] as Array<{ name: string }>),
      opts.tags
        ? glFetch<Array<{ name: string }>>(
            this.ctx,
            `/projects/${enc(projectId)}/repository/tags`,
            {
              query: { per_page: 50, order_by: "updated", sort: "desc" },
            },
          ).catch(() => [] as Array<{ name: string }>)
        : Promise.resolve([] as Array<{ name: string }>),
    ]);
    const options: SelectOption[] = [
      ...branches.map((b) => ({ id: b.name, label: b.name, description: "Branch" })),
      ...tags.map((t) => ({ id: t.name, label: t.name, description: "Tag" })),
    ];
    if (options.length === 0) return { ...base, kind: "text", placeholder: "main" };
    const def = project?.default_branch ?? options[0]?.id;
    return { ...base, kind: "select", options, ...(def ? { defaultValue: def } : {}) };
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    const parent = parentResourceId ? externalIdOf(parentResourceId) : undefined;
    const accessOptions = (levels: Record<number, string>, skip: number[] = []) =>
      Object.entries(levels)
        .filter(([v]) => !skip.includes(Number(v)))
        .map(([, label]) => ({ id: label, label }));
    switch (typeId) {
      case "pipeline":
        return {
          fields: [
            ...(await this.ownerField("project", parentResourceId, (p) =>
              enabled(p.builds_access_level),
            )),
            await this.refField(parent, "ref", "Branch or tag", { tags: true }),
            {
              key: "variables",
              label: "Variables",
              kind: "text",
              multiline: true,
              required: false,
              placeholder: "DEPLOY_ENV=staging\nDRY_RUN=true",
              description: "One KEY=value per line, passed to every job in the pipeline.",
            },
          ],
        };
      case "environment":
        return {
          fields: [
            ...(await this.ownerField("project", parentResourceId)),
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "staging" },
            {
              key: "externalUrl",
              label: "External URL",
              kind: "text",
              required: false,
              placeholder: "https://staging.example.com",
            },
            {
              key: "tier",
              label: "Tier",
              kind: "select",
              required: false,
              defaultValue: "staging",
              options: ["production", "staging", "testing", "development", "other"].map((t) => ({
                id: t,
                label: t,
              })),
            },
            { key: "description", label: "Description", kind: "text", required: false },
          ],
        };
      case "protected-branch":
        return {
          fields: [
            ...(await this.ownerField("project", parentResourceId)),
            {
              ...(await this.refField(parent, "name", "Branch", {
                description: "A branch, or a wildcard such as release/*.",
              })),
              ...(parent ? {} : { placeholder: "main or release/*" }),
            },
            {
              key: "pushAccess",
              label: "Allowed to push",
              kind: "select",
              required: true,
              defaultValue: "Maintainers",
              options: accessOptions(BRANCH_LEVELS, [60]),
            },
            {
              key: "mergeAccess",
              label: "Allowed to merge",
              kind: "select",
              required: true,
              defaultValue: "Maintainers",
              options: accessOptions(BRANCH_LEVELS, [60]),
            },
            {
              key: "allowForcePush",
              label: "Allow force push",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "No" },
                { id: "true", label: "Yes" },
              ],
            },
          ],
        };
      case "project-variable":
      case "group-variable":
        return {
          fields: [
            ...(await this.ownerField(
              typeId === "project-variable" ? "project" : "group",
              parentResourceId,
            )),
            {
              key: "key",
              label: "Key",
              kind: "text",
              required: true,
              placeholder: "AWS_ACCESS_KEY_ID",
            },
            { key: "value", label: "Value", kind: "password", required: true, multiline: true },
            {
              key: "variableType",
              label: "Type",
              kind: "select",
              required: true,
              defaultValue: "env_var",
              options: [
                {
                  id: "env_var",
                  label: "Variable",
                  description: "Set as an environment variable.",
                },
                {
                  id: "file",
                  label: "File",
                  description: "Written to a file; the variable holds its path.",
                },
              ],
            },
            {
              key: "environmentScope",
              label: "Environment scope",
              kind: "text",
              required: false,
              defaultValue: "*",
              description:
                "* for all environments, or a name or wildcard such as production or review/*.",
            },
            {
              key: "visibility",
              label: "Visibility",
              kind: "select",
              required: true,
              defaultValue: "masked",
              options: [
                { id: "visible", label: "Visible", description: "Shown in job logs if printed." },
                {
                  id: "masked",
                  label: "Masked",
                  description: "Replaced with [MASKED] in job logs.",
                },
                {
                  id: "hidden",
                  label: "Masked and hidden",
                  description: "Also never shown again in GitLab. Cannot be undone.",
                },
              ],
            },
            {
              key: "protected",
              label: "Protect variable",
              kind: "select",
              required: false,
              defaultValue: "true",
              options: [
                {
                  id: "true",
                  label: "Protected",
                  description: "Only pipelines on protected branches and tags.",
                },
                { id: "false", label: "Not protected", description: "Every pipeline." },
              ],
            },
            {
              key: "raw",
              label: "Expand variable references",
              kind: "select",
              required: false,
              defaultValue: "true",
              options: [
                { id: "true", label: "No (raw)", description: "$ is kept literally." },
                { id: "false", label: "Yes", description: "$OTHER_VAR in the value is expanded." },
              ],
            },
            { key: "description", label: "Description", kind: "text", required: false },
          ],
        };
      case "pipeline-schedule":
        return {
          fields: [
            ...(await this.ownerField("project", parentResourceId, (p) =>
              enabled(p.builds_access_level),
            )),
            {
              key: "description",
              label: "Description",
              kind: "text",
              required: true,
              placeholder: "Nightly build",
            },
            await this.refField(parent, "ref", "Branch or tag", { tags: true }),
            {
              key: "cron",
              label: "Cron schedule",
              kind: "text",
              required: true,
              placeholder: "0 3 * * 1-5",
              description: "Five fields: minute, hour, day of month, month, day of week.",
            },
            {
              key: "cronTimezone",
              label: "Time zone",
              kind: "text",
              required: false,
              defaultValue: "UTC",
              // i18n-free: IANA zone names are identifiers.
              placeholder: "Europe/Berlin",
            },
            {
              key: "active",
              label: "Active",
              kind: "select",
              required: false,
              defaultValue: "true",
              options: [
                { id: "true", label: "Active" },
                { id: "false", label: "Inactive" },
              ],
            },
          ],
        };
      case "deploy-key":
        return {
          fields: [
            ...(await this.ownerField("project", parentResourceId, GitLabClient.maintainer)),
            {
              key: "title",
              label: "Title",
              kind: "text",
              required: true,
              placeholder: "ci-deployer",
            },
            {
              key: "key",
              label: "Public key",
              kind: "ssh-key-picker",
              required: true,
              description: "The SSH public key, e.g. ssh-ed25519 AAAA...",
            },
            {
              key: "canPush",
              label: "Write access",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "Read only" },
                { id: "true", label: "Read and write" },
              ],
            },
            {
              key: "expiresAt",
              label: "Expires",
              kind: "datetime",
              datetimeMode: "datetime",
              required: false,
            },
          ],
        };
      case "deploy-token":
      case "group-deploy-token":
        return {
          fields: [
            ...(await this.ownerField(
              typeId === "deploy-token" ? "project" : "group",
              parentResourceId,
              GitLabClient.maintainer,
            )),
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "kubernetes-pull",
            },
            {
              key: "scopes",
              label: "Scopes",
              kind: "policy-picker",
              required: true,
              policies: [
                {
                  id: "read_repository",
                  label: "read_repository",
                  description: "Clone the repository",
                },
                {
                  id: "read_registry",
                  label: "read_registry",
                  description: "Pull container images",
                },
                {
                  id: "write_registry",
                  label: "write_registry",
                  description: "Push container images",
                },
                {
                  id: "read_package_registry",
                  label: "read_package_registry",
                  description: "Download packages",
                },
                {
                  id: "write_package_registry",
                  label: "write_package_registry",
                  description: "Publish packages",
                },
              ],
            },
            {
              key: "username",
              label: "Username",
              kind: "text",
              required: false,
              placeholder: "gitlab+deploy-token-1",
              description: "Leave empty for GitLab's default.",
            },
            {
              key: "expiresAt",
              label: "Expires",
              kind: "datetime",
              datetimeMode: "datetime",
              required: false,
            },
          ],
        };
      case "project-webhook":
      case "group-webhook": {
        const kind = typeId === "project-webhook" ? "project" : "group";
        return {
          fields: [
            ...(await this.ownerField(kind, parentResourceId, GitLabClient.maintainer)),
            {
              key: "url",
              label: "URL",
              kind: "text",
              required: true,
              placeholder: "https://hooks.example.com/gitlab",
            },
            { key: "name", label: "Name", kind: "text", required: false },
            {
              key: "events",
              label: "Events",
              kind: "policy-picker",
              required: true,
              policies: hookEventOptions(kind),
            },
            {
              key: "pushEventsBranchFilter",
              label: "Push branch filter",
              kind: "text",
              required: false,
              placeholder: "main",
              description: "Only send push events for matching branches (wildcards allowed).",
            },
            { key: "secretToken", label: "Secret token", kind: "password", required: false },
            {
              key: "enableSslVerification",
              label: "Verify TLS certificate",
              kind: "select",
              required: false,
              defaultValue: "true",
              options: [
                { id: "true", label: "Yes" },
                { id: "false", label: "No" },
              ],
            },
          ],
        };
      }
      case "release":
        return {
          fields: [
            ...(await this.ownerField("project", parentResourceId)),
            { key: "tagName", label: "Tag", kind: "text", required: true, placeholder: "v1.4.0" },
            await this.refField(parent, "ref", "Create tag from", {
              required: false,
              description: "Only used when the tag does not exist yet.",
            }),
            { key: "name", label: "Release title", kind: "text", required: false },
            {
              key: "description",
              label: "Release notes",
              kind: "text",
              multiline: true,
              required: false,
            },
          ],
        };
      case "project-member":
      case "group-member":
        return {
          fields: [
            ...(await this.ownerField(
              typeId === "project-member" ? "project" : "group",
              parentResourceId,
            )),
            {
              key: "username",
              label: "Username",
              kind: "text",
              required: true,
              placeholder: "jane.doe",
              description: "The GitLab username to add.",
            },
            {
              key: "accessLevel",
              label: "Role",
              kind: "select",
              required: true,
              defaultValue: "Developer",
              options: accessOptions(MEMBER_LEVELS, [0, 5, 25]),
            },
            {
              key: "expiresAt",
              label: "Access expires",
              kind: "datetime",
              datetimeMode: "date",
              required: false,
            },
          ],
        };
      case "runner": {
        const groups = this.groupRef ? await this.groupOptions() : [];
        const projects = await this.projectOptions(GitLabClient.maintainer);
        const scopeOptions: SelectOption[] = [
          ...groups.map((g) => ({
            id: `group:${g.id}`,
            label: g.label,
            description: "Group runner",
          })),
          ...projects.map((p) => ({
            id: `project:${p.id}`,
            label: p.label,
            description: "Project runner",
          })),
        ];
        return {
          fields: [
            {
              key: "scope",
              label: "Register to",
              kind: "select",
              required: true,
              ...(scopeOptions[0] ? { defaultValue: scopeOptions[0].id } : {}),
              options: scopeOptions,
            },
            {
              key: "description",
              label: "Description",
              kind: "text",
              required: false,
              placeholder: "build-01",
            },
            {
              key: "tagList",
              label: "Tags",
              kind: "string-list",
              required: false,
              description: "Jobs with these tags run on this runner.",
            },
            {
              key: "runUntagged",
              label: "Run untagged jobs",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "No" },
                { id: "true", label: "Yes" },
              ],
            },
            {
              key: "accessLevel",
              label: "Protected refs only",
              kind: "select",
              required: false,
              defaultValue: "not_protected",
              options: [
                { id: "not_protected", label: "Any ref" },
                { id: "ref_protected", label: "Protected branches and tags only" },
              ],
            },
            {
              key: "maximumTimeout",
              label: "Maximum job timeout (seconds)",
              kind: "number",
              required: false,
              minValue: 600,
            },
          ],
        };
      }
      default:
        throw new Error(`GitLab plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceCreateReturn> {
    const parent = parentResourceId ? externalIdOf(parentResourceId) : undefined;
    const need = (key: string, label: string) => {
      const v = (fields[key] ?? "").trim();
      if (!v) fail(`"${label}" is required`);
      return v;
    };
    const ownerId = (kind: "project" | "group") => {
      const v = (fields[kind] ?? "").trim() || parent || "";
      if (!v) fail(`pick a ${kind}`);
      return v;
    };
    switch (typeId) {
      case "pipeline": {
        const s = await this.projectScope(ownerId("project"));
        const variables = parseVariableLines(fields["variables"]);
        const p = await glFetch<GlPipeline>(this.ctx, `/projects/${s.id}/pipeline`, {
          method: "POST",
          body: {
            ref: need("ref", "Branch or tag"),
            ...(variables.length > 0 ? { variables } : {}),
          },
        });
        return mapPipeline(accountId, s, p);
      }
      case "environment": {
        const s = await this.projectScope(ownerId("project"));
        const e = await glFetch<GlEnvironment>(this.ctx, `/projects/${s.id}/environments`, {
          method: "POST",
          body: compact({
            name: need("name", "Name"),
            external_url: fields["externalUrl"],
            tier: fields["tier"],
            description: fields["description"],
          }),
        });
        return mapEnvironment(accountId, s, e);
      }
      case "protected-branch": {
        const s = await this.projectScope(ownerId("project"));
        const b = await this.protectBranch(s.id, need("name", "Branch"), {
          push: branchLevelValue(fields["pushAccess"]) ?? 40,
          merge: branchLevelValue(fields["mergeAccess"]) ?? 40,
          force: truthy(fields["allowForcePush"]),
          codeOwners: truthy(fields["codeOwnerApprovalRequired"]),
        });
        return mapProtectedBranch(accountId, s, b);
      }
      case "project-variable":
      case "group-variable": {
        const kind = typeId === "project-variable" ? "project" : "group";
        const s =
          kind === "project"
            ? await this.projectScope(ownerId(kind))
            : await this.groupScope(ownerId(kind));
        const value = fields["value"] ?? "";
        if (!value) fail('"Value" is required');
        const visibility =
          fields["visibility"] ?? (truthy(fields["masked"]) ? "masked" : "visible");
        const v = await glFetch<GlVariable>(this.ctx, `/${kind}s/${s.id}/variables`, {
          method: "POST",
          body: compact({
            key: validateVariableKey(need("key", "Key")),
            value,
            variable_type: fields["variableType"] || "env_var",
            environment_scope: (fields["environmentScope"] ?? "").trim() || "*",
            protected: fields["protected"] === undefined ? undefined : truthy(fields["protected"]),
            ...(visibility === "hidden"
              ? { masked_and_hidden: true }
              : { masked: visibility === "masked" }),
            raw: fields["raw"] === undefined ? undefined : truthy(fields["raw"]),
            description: fields["description"],
          }),
        });
        return mapVariable(accountId, s, v);
      }
      case "pipeline-schedule": {
        const s = await this.projectScope(ownerId("project"));
        const x = await glFetch<GlSchedule>(this.ctx, `/projects/${s.id}/pipeline_schedules`, {
          method: "POST",
          body: compact({
            description: need("description", "Description"),
            ref: need("ref", "Branch or tag"),
            cron: validateCron(fields["cron"]),
            cron_timezone: (fields["cronTimezone"] ?? "").trim() || "UTC",
            active: fields["active"] === undefined ? undefined : truthy(fields["active"]),
          }),
        });
        return mapSchedule(accountId, s, x);
      }
      case "deploy-key": {
        const s = await this.projectScope(ownerId("project"));
        const k = await glFetch<GlDeployKey>(this.ctx, `/projects/${s.id}/deploy_keys`, {
          method: "POST",
          body: compact({
            title: need("title", "Title"),
            key: need("key", "Public key"),
            can_push: truthy(fields["canPush"]),
            expires_at: optionalDate(fields["expiresAt"], "Expires"),
          }),
        });
        return mapDeployKey(accountId, s, k);
      }
      case "deploy-token":
      case "group-deploy-token": {
        const kind = typeId === "deploy-token" ? "project" : "group";
        const s =
          kind === "project"
            ? await this.projectScope(ownerId(kind))
            : await this.groupScope(ownerId(kind));
        const scopes = parseScopes(fields["scopes"]);
        if (scopes.length === 0) fail("pick at least one scope");
        const t = await glFetch<GlDeployToken>(this.ctx, `/${kind}s/${s.id}/deploy_tokens`, {
          method: "POST",
          body: compact({
            name: need("name", "Name"),
            scopes,
            username: fields["username"],
            expires_at: optionalDate(fields["expiresAt"], "Expires"),
          }),
        });
        const resource = mapDeployToken(accountId, s, t);
        return this.keepToken(resource, t.token);
      }
      case "project-webhook":
      case "group-webhook": {
        const kind = typeId === "project-webhook" ? "project" : "group";
        const s =
          kind === "project"
            ? await this.projectScope(ownerId(kind))
            : await this.groupScope(ownerId(kind));
        const h = await glFetch<GlHook>(this.ctx, `/${kind}s/${s.id}/hooks`, {
          method: "POST",
          body: compact({
            url: need("url", "URL"),
            name: fields["name"],
            description: fields["description"],
            ...hookEventFlags(parseListish(fields["events"]).join(","), kind),
            push_events_branch_filter: fields["pushEventsBranchFilter"],
            token: fields["secretToken"],
            enable_ssl_verification:
              fields["enableSslVerification"] === undefined
                ? undefined
                : truthy(fields["enableSslVerification"]),
          }),
        });
        return mapHook(accountId, s, h);
      }
      case "release": {
        const s = await this.projectScope(ownerId("project"));
        const r = await glFetch<GlRelease>(this.ctx, `/projects/${s.id}/releases`, {
          method: "POST",
          body: compact({
            tag_name: need("tagName", "Tag"),
            ref: fields["ref"],
            name: fields["name"],
            description: fields["description"],
          }),
        });
        return mapRelease(accountId, s, r);
      }
      case "project-member":
      case "group-member": {
        const kind = typeId === "project-member" ? "project" : "group";
        const s =
          kind === "project"
            ? await this.projectScope(ownerId(kind))
            : await this.groupScope(ownerId(kind));
        const username = need("username", "Username").replace(/^@/, "");
        const users = await glFetch<GlUser[]>(this.ctx, "/users", { query: { username } });
        const user = users?.[0];
        if (!user) fail(`no GitLab user is called "${username}"`, 404);
        const m = await glFetch<GlMember>(this.ctx, `/${kind}s/${s.id}/members`, {
          method: "POST",
          body: compact({
            user_id: user.id,
            access_level: memberLevelValue(fields["accessLevel"] || "Developer"),
            expires_at: optionalDate(fields["expiresAt"], "Access expires")?.slice(0, 10),
          }),
        });
        return mapMember(accountId, s, m);
      }
      case "runner": {
        const [kind, id] = (fields["scope"] ?? "").split(":");
        if ((kind !== "group" && kind !== "project") || !id)
          fail("pick where to register the runner");
        const created = await glFetch<{ id: number; token?: string }>(this.ctx, "/user/runners", {
          method: "POST",
          body: compact({
            runner_type: kind === "group" ? "group_type" : "project_type",
            ...(kind === "group" ? { group_id: Number(id) } : { project_id: Number(id) }),
            description: fields["description"],
            tag_list: parseListish(fields["tagList"]).join(","),
            run_untagged:
              fields["runUntagged"] === undefined ? undefined : truthy(fields["runUntagged"]),
            access_level: fields["accessLevel"],
            maximum_timeout: optionalInt(fields["maximumTimeout"], "Maximum job timeout", 600),
          }),
        });
        const r = await glFetch<GlRunner>(this.ctx, `/runners/${created.id}`).catch(
          () => ({ id: created.id }) as GlRunner,
        );
        return this.keepToken(mapRunner(accountId, r), created.token);
      }
      default:
        throw new Error(`GitLab plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  /**
   * GitLab returns a deploy or runner token exactly once. Keep it encrypted
   * by the host so the `token` output can resolve; without a secret store,
   * say plainly that it was not kept.
   */
  private async keepToken(
    resource: ResourceInstance,
    token: string | undefined,
  ): Promise<ResourceCreateReturn> {
    if (!token) return resource;
    const secrets = this.services?.secrets;
    if (secrets?.setPlaintext) {
      await secrets.setPlaintext(resource.id, "token", token);
      return resource;
    }
    return {
      resource,
      warnings: [
        {
          code: "token-not-kept",
          message:
            "Created, but this host cannot store secrets, so the token GitLab returned was not kept. Create another token from a host that can, or from GitLab.",
        },
      ],
    };
  }

  private async protectBranch(
    projectId: number | string,
    name: string,
    o: { push: number; merge: number; force: boolean; codeOwners: boolean },
  ): Promise<GlProtectedBranch> {
    return glFetch<GlProtectedBranch>(this.ctx, `/projects/${projectId}/protected_branches`, {
      method: "POST",
      body: {
        name,
        push_access_level: o.push,
        merge_access_level: o.merge,
        allow_force_push: o.force,
        ...(o.codeOwners ? { code_owner_approval_required: true } : {}),
      },
    });
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    const { scope: ownerId, rest } = splitScoped(id);
    const has = (k: string) => k in fields;
    const bool = (k: string) => (has(k) ? truthy(fields[k]) : undefined);
    const text = (k: string) => (has(k) ? (fields[k] ?? "").trim() : undefined);
    switch (typeId) {
      case "group": {
        const body = compactKeepEmpty({
          name: text("name"),
          description: text("description"),
          visibility: text("visibility"),
        });
        if (Object.keys(body).length > 0) {
          await glFetch(this.ctx, `/groups/${enc(id)}`, { method: "PUT", body });
        }
        break;
      }
      case "project": {
        const body = compactKeepEmpty({
          name: text("name"),
          description: text("description"),
          visibility: text("visibility"),
          default_branch: text("defaultBranch"),
          ci_config_path: text("ciConfigPath"),
        });
        if (Object.keys(body).length > 0) {
          await glFetch(this.ctx, `/projects/${enc(id)}`, { method: "PUT", body });
        }
        break;
      }
      case "environment": {
        const body = compactKeepEmpty({
          external_url: text("externalUrl"),
          tier: text("tier"),
          description: text("description"),
        });
        if (Object.keys(body).length > 0) {
          await glFetch(this.ctx, `/projects/${enc(ownerId)}/environments/${enc(rest)}`, {
            method: "PUT",
            body,
          });
        }
        break;
      }
      case "protected-branch": {
        const current = await glFetch<GlProtectedBranch>(
          this.ctx,
          `/projects/${enc(ownerId)}/protected_branches/${enc(rest)}`,
        );
        if (has("pushAccess") || has("mergeAccess")) {
          // Changing role levels through PATCH is Premium-only, so the rule is
          // re-created with the new levels and every other setting kept.
          const level = (entries: GlProtectedBranch["push_access_levels"]) =>
            entries?.find((e) => typeof e.access_level === "number")?.access_level ?? 40;
          await glFetch(this.ctx, `/projects/${enc(ownerId)}/protected_branches/${enc(rest)}`, {
            method: "DELETE",
          });
          await this.protectBranch(ownerId, rest, {
            push: branchLevelValue(fields["pushAccess"]) ?? level(current.push_access_levels),
            merge: branchLevelValue(fields["mergeAccess"]) ?? level(current.merge_access_levels),
            force: bool("allowForcePush") ?? current.allow_force_push ?? false,
            codeOwners:
              bool("codeOwnerApprovalRequired") ?? current.code_owner_approval_required ?? false,
          });
        } else {
          const body = compact({
            allow_force_push: bool("allowForcePush"),
            code_owner_approval_required: bool("codeOwnerApprovalRequired"),
          });
          if (Object.keys(body).length > 0) {
            await glFetch(this.ctx, `/projects/${enc(ownerId)}/protected_branches/${enc(rest)}`, {
              method: "PATCH",
              body,
            });
          }
        }
        break;
      }
      case "project-variable":
      case "group-variable": {
        const kind = typeId === "project-variable" ? "projects" : "groups";
        const { key, envScope } = splitVariable(rest);
        const path = `/${kind}/${enc(ownerId)}/variables/${enc(key)}`;
        const filter = { "filter[environment_scope]": envScope };
        // PUT requires the value; keep the current one unless a new one was typed.
        let value = fields["value"] ?? "";
        if (!value) {
          const current = await glFetch<GlVariable>(this.ctx, path, { query: filter });
          if (current.value === null || current.value === undefined) {
            fail(
              "this variable is hidden, so GitLab will not return its value. Type the value to change its settings.",
            );
          }
          value = current.value;
        }
        await glFetch(this.ctx, path, {
          method: "PUT",
          query: filter,
          body: compactKeepEmpty({
            value,
            variable_type: text("variableType"),
            environment_scope: text("environmentScope") || undefined,
            protected: bool("protected"),
            masked: bool("masked"),
            raw: bool("raw"),
            description: text("description"),
          }),
        });
        const newScope = text("environmentScope") || envScope;
        return this.getResource(
          typeId,
          `${accountId}:${typeId}:${ownerId}/${key}/${newScope}`,
          accountId,
        );
      }
      case "pipeline-schedule": {
        const body = compact({
          description: text("description") || undefined,
          cron: has("cron") ? validateCron(fields["cron"]) : undefined,
          cron_timezone: text("cronTimezone") || undefined,
          ref: text("ref") || undefined,
          active: bool("active"),
        });
        if (Object.keys(body).length > 0) {
          await glFetch(this.ctx, `/projects/${enc(ownerId)}/pipeline_schedules/${enc(rest)}`, {
            method: "PUT",
            body,
          });
        }
        break;
      }
      case "deploy-key": {
        const body = compact({ title: text("title") || undefined, can_push: bool("canPush") });
        if (Object.keys(body).length > 0) {
          await glFetch(this.ctx, `/projects/${enc(ownerId)}/deploy_keys/${enc(rest)}`, {
            method: "PUT",
            body,
          });
        }
        break;
      }
      case "project-webhook":
      case "group-webhook": {
        const kind = typeId === "project-webhook" ? "project" : "group";
        const path = `/${kind}s/${enc(ownerId)}/hooks/${enc(rest)}`;
        // PUT requires the URL even when it is unchanged.
        const url = text("url") || (await glFetch<GlHook>(this.ctx, path)).url;
        await glFetch(this.ctx, path, {
          method: "PUT",
          body: compactKeepEmpty({
            url,
            name: text("name"),
            description: text("description"),
            ...(has("events") ? hookEventFlags(fields["events"], kind) : {}),
            push_events_branch_filter: text("pushEventsBranchFilter"),
            enable_ssl_verification: bool("enableSslVerification"),
            ...(fields["secretToken"] ? { token: fields["secretToken"] } : {}),
          }),
        });
        break;
      }
      case "release": {
        const body = compactKeepEmpty({
          name: text("name"),
          description: text("description"),
          released_at: has("releasedAt")
            ? optionalDate(fields["releasedAt"], "Released")
            : undefined,
        });
        if (Object.keys(body).length > 0) {
          await glFetch(this.ctx, `/projects/${enc(ownerId)}/releases/${enc(rest)}`, {
            method: "PUT",
            body,
          });
        }
        break;
      }
      case "project-member":
      case "group-member": {
        const kind = typeId === "project-member" ? "projects" : "groups";
        const path = `/${kind}/${enc(ownerId)}/members/${enc(rest)}`;
        const current = await glFetch<GlMember>(this.ctx, path);
        await glFetch(this.ctx, path, {
          method: "PUT",
          body: {
            access_level: has("accessLevel")
              ? memberLevelValue(fields["accessLevel"] ?? "")
              : current.access_level,
            expires_at: has("expiresAt")
              ? (optionalDate(fields["expiresAt"], "Access expires")?.slice(0, 10) ?? "")
              : (current.expires_at ?? ""),
          },
        });
        break;
      }
      case "runner": {
        const body = compactKeepEmpty({
          description: text("description"),
          tag_list: has("tagList") ? commaList(fields["tagList"]) : undefined,
          paused: bool("paused"),
          run_untagged: bool("runUntagged"),
          locked: bool("locked"),
          access_level: text("accessLevel") || undefined,
          maximum_timeout: has("maximumTimeout")
            ? optionalInt(fields["maximumTimeout"], "Maximum job timeout", 600)
            : undefined,
          maintenance_note: text("maintenanceNote"),
        });
        if (Object.keys(body).length > 0) {
          await glFetch(this.ctx, `/runners/${enc(id)}`, { method: "PUT", body });
        }
        break;
      }
      default:
        throw new Error(`GitLab plugin: cannot edit "${typeId}" from Infrawrench`);
    }
    return this.getResource(typeId, resourceId, accountId);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const id = externalIdOf(resourceId);
    const { scope: o, rest } = splitScoped(id);
    const del = (path: string, query?: Record<string, string>) =>
      glFetch(this.ctx, path, { method: "DELETE", ...(query ? { query } : {}) });
    switch (typeId) {
      case "pipeline":
        await del(`/projects/${enc(o)}/pipelines/${enc(rest)}`);
        return;
      case "environment":
        try {
          await del(`/projects/${enc(o)}/environments/${enc(rest)}`);
        } catch (err) {
          if (statusOf(err) === 403 || statusOf(err) === 400) {
            fail(
              "GitLab only deletes stopped environments. Stop it first, then delete it.",
              statusOf(err),
            );
          }
          throw err;
        }
        return;
      case "protected-branch":
        await del(`/projects/${enc(o)}/protected_branches/${enc(rest)}`);
        return;
      case "project-variable":
      case "group-variable": {
        const { key, envScope } = splitVariable(rest);
        await del(
          `/${typeId === "project-variable" ? "projects" : "groups"}/${enc(o)}/variables/${enc(key)}`,
          {
            "filter[environment_scope]": envScope,
          },
        );
        return;
      }
      case "pipeline-schedule":
        await del(`/projects/${enc(o)}/pipeline_schedules/${enc(rest)}`);
        return;
      case "container-repository":
        await del(`/projects/${enc(o)}/registry/repositories/${enc(rest)}`);
        return;
      case "package":
        await del(`/projects/${enc(o)}/packages/${enc(rest)}`);
        return;
      case "deploy-key":
        await del(`/projects/${enc(o)}/deploy_keys/${enc(rest)}`);
        return;
      case "deploy-token":
        await del(`/projects/${enc(o)}/deploy_tokens/${enc(rest)}`);
        return;
      case "group-deploy-token":
        await del(`/groups/${enc(o)}/deploy_tokens/${enc(rest)}`);
        return;
      case "project-webhook":
        await del(`/projects/${enc(o)}/hooks/${enc(rest)}`);
        return;
      case "group-webhook":
        await del(`/groups/${enc(o)}/hooks/${enc(rest)}`);
        return;
      case "release":
        await del(`/projects/${enc(o)}/releases/${enc(rest)}`);
        return;
      case "project-member":
        await del(`/projects/${enc(o)}/members/${enc(rest)}`);
        return;
      case "group-member":
        await del(`/groups/${enc(o)}/members/${enc(rest)}`);
        return;
      case "runner":
        await del(`/runners/${enc(id)}`);
        return;
      default:
        throw new Error(`GitLab plugin: cannot delete "${typeId}" from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Actions, logs, artifacts, credentials
  // -------------------------------------------------------------------------

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const id = externalIdOf(resourceId);
    const { scope: o, rest } = splitScoped(id);
    const post = (path: string, body?: unknown) =>
      glFetch(this.ctx, path, { method: "POST", ...(body !== undefined ? { body } : {}) });
    const [verb, arg] = actionId.split(":");
    switch (typeId) {
      case "project":
        if (actionId === "archive" || actionId === "unarchive") {
          await post(`/projects/${enc(id)}/${actionId}`);
          return;
        }
        break;
      case "pipeline":
        if (actionId === "retry" || actionId === "cancel") {
          await post(`/projects/${enc(o)}/pipelines/${enc(rest)}/${actionId}`);
          return;
        }
        if ((verb === "retry-job" || verb === "cancel-job" || verb === "play-job") && arg) {
          await post(`/projects/${enc(o)}/jobs/${enc(arg)}/${verb.replace("-job", "")}`);
          return;
        }
        break;
      case "environment":
        if (actionId === "stop") {
          await post(`/projects/${enc(o)}/environments/${enc(rest)}/stop`);
          return;
        }
        if ((verb === "approve-deployment" || verb === "reject-deployment") && arg) {
          await post(`/projects/${enc(o)}/deployments/${enc(arg)}/approval`, {
            status: verb === "approve-deployment" ? "approved" : "rejected",
          });
          return;
        }
        break;
      case "pipeline-schedule":
        if (actionId === "play" || actionId === "take-ownership") {
          await post(
            `/projects/${enc(o)}/pipeline_schedules/${enc(rest)}/${actionId.replace("-", "_")}`,
          );
          return;
        }
        if (actionId === "activate" || actionId === "deactivate") {
          await glFetch(this.ctx, `/projects/${enc(o)}/pipeline_schedules/${enc(rest)}`, {
            method: "PUT",
            body: { active: actionId === "activate" },
          });
          return;
        }
        break;
      case "container-repository":
        if (actionId === "cleanup") {
          // Bulk tag deletion runs asynchronously on GitLab's side (202).
          await glFetch(this.ctx, `/projects/${enc(o)}/registry/repositories/${enc(rest)}/tags`, {
            method: "DELETE",
            query: { name_regex_delete: ".*", keep_n: 10, older_than: "30d" },
          });
          return;
        }
        break;
      case "project-webhook":
      case "group-webhook":
        if (actionId === "test") {
          await post(
            `/${typeId === "project-webhook" ? "projects" : "groups"}/${enc(o)}/hooks/${enc(rest)}/test/push_events`,
          );
          return;
        }
        break;
      case "runner":
        if (actionId === "pause" || actionId === "resume") {
          await glFetch(this.ctx, `/runners/${enc(id)}`, {
            method: "PUT",
            body: { paused: actionId === "pause" },
          });
          return;
        }
        break;
    }
    throw new Error(`GitLab plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  /**
   * Job logs for a pipeline: each job is a "container" in the Logs tab, and
   * the tail of its trace is returned (GitLab sends the whole log; ANSI
   * colour codes and section markers are stripped).
   */
  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    if (typeId !== "pipeline") throw new Error(`GitLab plugin: "${typeId}" has no logs`);
    const { scope: o, rest } = splitScoped(externalIdOf(resourceId));
    const jobs = await glPaged<GlJob>(
      this.ctx,
      `/projects/${enc(o)}/pipelines/${enc(rest)}/jobs`,
      {},
      3,
    );
    const label = (j: GlJob) => `${j.stage ? `${j.stage} / ` : ""}${j.name} #${j.id}`;
    const ordered = [...jobs].sort((a, b) => a.id - b.id);
    const containers = ordered.map(label);
    const pick =
      ordered.find((j) => label(j) === params.container) ??
      ordered.find((j) => j.status === "failed") ??
      ordered.find((j) => j.status === "running") ??
      ordered[ordered.length - 1];
    if (!pick) return { text: "This pipeline has no jobs.\n", containers: [], activeContainer: "" };
    let text: string;
    try {
      text = await glFetch<string>(this.ctx, `/projects/${enc(o)}/jobs/${pick.id}/trace`, {
        as: "text",
      });
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
      text = `No log for ${pick.name} (${pick.status}).\n`;
    }
    const lines = cleanTrace(text).split("\n");
    const tail = params.tailLines && params.tailLines > 0 ? lines.slice(-params.tailLines) : lines;
    return { text: `${tail.join("\n")}\n`, containers, activeContainer: label(pick) };
  }

  async listArtifacts(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params?: { pageToken?: string; prefix?: string },
  ): Promise<{ items: ArtifactEntry[]; nextPageToken?: string }> {
    const { scope: o, rest } = splitScoped(externalIdOf(resourceId));
    const page = Number(params?.pageToken ?? "1") || 1;
    if (typeId === "container-repository") {
      const tags = await glFetch<GlRegistryTag[]>(
        this.ctx,
        `/projects/${enc(o)}/registry/repositories/${enc(rest)}/tags`,
        { query: { per_page: 50, page } },
      );
      const wanted = (tags ?? []).filter(
        (t) => !params?.prefix || t.name.startsWith(params.prefix),
      );
      // The list has names only; digest, size and date come from each tag.
      const detailed = await Promise.all(
        wanted.map((t) =>
          glFetch<GlRegistryTag>(
            this.ctx,
            `/projects/${enc(o)}/registry/repositories/${enc(rest)}/tags/${enc(t.name)}`,
          ).catch(() => t),
        ),
      );
      return {
        items: detailed.map((t) => ({
          name: t.path ?? t.name,
          version: t.name,
          ...(t.digest ? { digest: t.digest } : {}),
          ...(typeof t.total_size === "number" ? { sizeBytes: t.total_size } : {}),
          ...(t.created_at ? { updatedAt: t.created_at } : {}),
          tags: [t.name],
        })),
        ...((tags ?? []).length === 50 ? { nextPageToken: String(page + 1) } : {}),
      };
    }
    if (typeId === "package") {
      const files = await glFetch<GlPackageFile[]>(
        this.ctx,
        `/projects/${enc(o)}/packages/${enc(rest)}/package_files`,
        {
          query: { per_page: 100, page },
        },
      );
      return {
        items: (files ?? [])
          .filter((f) => !params?.prefix || f.file_name.startsWith(params.prefix))
          .map((f) => ({
            name: f.file_name,
            ...(f.file_sha256 ? { digest: `sha256:${f.file_sha256}` } : {}),
            ...(typeof f.size === "number" ? { sizeBytes: f.size } : {}),
            ...(f.created_at ? { updatedAt: f.created_at } : {}),
          })),
        ...((files ?? []).length === 100 ? { nextPageToken: String(page + 1) } : {}),
      };
    }
    throw new Error(`GitLab plugin: "${typeId}" has no artifacts`);
  }

  async exportCredential(
    typeId: string,
    resourceId: string,
    _accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    if (typeId !== "runner" || formatId !== "runner-token") {
      throw new Error(`GitLab plugin: cannot export "${formatId}" for "${typeId}"`);
    }
    const id = externalIdOf(resourceId);
    const res = await glFetch<{ token?: string; token_expires_at?: string | null }>(
      this.ctx,
      `/runners/${enc(id)}/reset_authentication_token`,
      { method: "POST" },
    );
    const token = res?.token;
    if (!token) throw new Error("GitLab did not return a new runner token");
    await this.services?.secrets?.setPlaintext?.(resourceId, "token", token).catch(() => undefined);
    return {
      content: token,
      filename: "gitlab-runner-token.txt",
      mimeType: "text/plain",
      fields: [
        { label: "Token", value: token, sensitive: true, hint: "Only shown once" },
        ...(res.token_expires_at ? [{ label: "Expires", value: res.token_expires_at }] : []),
      ],
      warning:
        "The previous token stopped working. Put this one in the runner's config.toml (token = ...) or run gitlab-runner register --token with it.",
    };
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderGitLabDetail(resource, this.ctx.baseUrl);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderGitLabSidebar(resource);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface HookEvent {
  id: number;
  trigger?: string;
  response_status?: string | number;
  execution_duration?: number;
  created_at?: string;
  request_data?: { created_at?: string };
}

export interface GroupStorage {
  storageSizeLimit?: number | null;
  additionalPurchasedStorageSize?: number | null;
  rootStorageStatistics?: Record<string, number> | null;
}

const SCOPE_API = { id: "api", label: "Read and write the API (create, edit, delete, actions)" };
const SCOPE_READ_API = { id: "read_api", label: "Read the API (inventory, metrics, logs)" };
const SCOPE_CREATE_RUNNER = { id: "create_runner", label: "Create runners" };

/** The job fields the detail tables show, so stashed data stays small. */
function slimJob(j: GlJob) {
  return {
    id: j.id,
    name: j.name,
    stage: j.stage,
    status: j.status,
    duration: j.duration,
    queued: j.queued_duration,
    allowFailure: j.allow_failure,
    failureReason: j.failure_reason,
    url: j.web_url,
    ref: j.ref,
    createdAt: j.created_at,
    project: j.project?.path_with_namespace,
    pipelineId: j.pipeline?.id,
  };
}
export type SlimJob = ReturnType<typeof slimJob>;

/** `KEY/scope` from a variable external id's tail. */
export function splitVariable(rest: string): { key: string; envScope: string } {
  const i = rest.indexOf("/");
  return i < 0
    ? { key: rest, envScope: "*" }
    : { key: rest.slice(0, i), envScope: rest.slice(i + 1) || "*" };
}

/** Drop undefined and empty strings. */
function compact(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    out[k] = typeof v === "string" ? v.trim() : v;
  }
  return out;
}

/** Drop undefined only: an empty string clears a field on edit. */
function compactKeepEmpty(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (v !== undefined) out[k] = v;
  return out;
}

/** A policy-picker or string-list value: a JSON array, or a comma list. */
export function parseListish(raw: string | undefined): string[] {
  const v = (raw ?? "").trim();
  if (v.startsWith("[")) {
    try {
      const parsed = JSON.parse(v) as unknown;
      if (Array.isArray(parsed))
        return parsed
          .map(String)
          .map((s) => s.trim())
          .filter(Boolean);
    } catch {
      // Fall through to the comma list.
    }
  }
  return commaList(v);
}

const DEPLOY_TOKEN_SCOPES = new Set([
  "read_repository",
  "read_registry",
  "write_registry",
  "read_package_registry",
  "write_package_registry",
  "read_virtual_registry",
  "write_virtual_registry",
]);

function parseScopes(raw: string | undefined): string[] {
  const scopes = parseListish(raw);
  for (const s of scopes) {
    if (!DEPLOY_TOKEN_SCOPES.has(s)) fail(`"${s}" is not a deploy token scope`);
  }
  return scopes;
}

function hookEventOptions(kind: "project" | "group") {
  const labels: Record<string, string> = {
    push: "Push",
    tag_push: "Tag push",
    merge_requests: "Merge requests",
    issues: "Issues",
    confidential_issues: "Confidential issues",
    note: "Comments",
    confidential_note: "Confidential comments",
    job: "Jobs",
    pipeline: "Pipelines",
    deployment: "Deployments",
    releases: "Releases",
    wiki_page: "Wiki pages",
    milestone: "Milestones",
    feature_flag: "Feature flags",
    subgroup: "Subgroups",
    member: "Members",
    project: "Projects",
  };
  return Object.entries(labels)
    .filter(([id]) => kind === "group" || !["subgroup", "member", "project"].includes(id))
    .map(([id, label]) => ({ id, label }));
}

/** Strip ANSI escapes and GitLab's collapsible-section markers from a job trace. */
export function cleanTrace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/section_(start|end):\d+:[A-Za-z0-9_.-]+(\[[^\]]*\])?\r?(\u001b\[0K)?/g, "")
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\r(?!\n)/g, "\n");
}
