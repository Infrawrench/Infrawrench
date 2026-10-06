import type {
  CreateFieldConfig,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  ResourceCreateReturn,
  ResourceInstance,
  SelectOption,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type { BitbucketContext } from "./api.js";
import {
  bbFetch,
  bbPaged,
  bbRequest,
  enc,
  encUuid,
  isAbsent,
  splitScoped,
  statusOf,
} from "./api.js";
import type { VariableOwner } from "./mappers.js";
import {
  RESTRICTION_KINDS,
  mapBranchRestriction,
  mapCache,
  mapDeployKey,
  mapEnvironment,
  mapPipeline,
  mapProject,
  mapProjectDeployKey,
  mapRepository,
  mapRunner,
  mapSchedule,
  mapVariable,
  mapWebhook,
  mapWorkspace,
  parseRunnerId,
  slugOf,
} from "./mappers.js";
import { deploymentSeries, pipelineSeries, rangeOrDefault } from "./metrics.js";
import { DETAIL_KEYS, renderBitbucketDetail, renderBitbucketSidebar } from "./render.js";
import type {
  BbBranchRestriction,
  BbCache,
  BbDeployKey,
  BbDeployment,
  BbEnvironment,
  BbPipeline,
  BbProject,
  BbRepository,
  BbRunner,
  BbSchedule,
  BbStep,
  BbVariable,
  BbWebhook,
  BbWorkspace,
} from "./types.js";

/** Repositories read for the inventory (100 a page, most recently updated first). */
const REPO_PAGES = 5;
/**
 * Repositories whose children are listed. Bitbucket meters repository data
 * at about 1,000 requests an hour per user (more on paid plans), and every
 * child type costs one request per repository, so this is kept small.
 */
export const FANOUT_LIMIT = 30;
const PIPELINES_PER_REPO = 10;
const PIPELINE_LIMIT = 200;
/** Pages of pipelines (100 each) read for a repository's metrics. */
const METRIC_PAGES = 5;
/** Bytes of a step log fetched with a Range request. */
const LOG_TAIL_BYTES = 256 * 1024;

export const WEBHOOK_EVENTS = [
  "repo:push",
  "repo:fork",
  "repo:updated",
  "repo:commit_comment_created",
  "repo:commit_status_created",
  "repo:commit_status_updated",
  "repo:imported",
  "repo:transfer",
  "repo:created",
  "repo:deleted",
  "pullrequest:created",
  "pullrequest:updated",
  "pullrequest:approved",
  "pullrequest:unapproved",
  "pullrequest:fulfilled",
  "pullrequest:rejected",
  "pullrequest:changes_request_created",
  "pullrequest:changes_request_removed",
  "pullrequest:comment_created",
  "pullrequest:comment_updated",
  "pullrequest:comment_deleted",
  "pullrequest:comment_resolved",
  "pullrequest:comment_reopened",
  "pullrequest:push",
  "issue:created",
  "issue:updated",
  "issue:comment_created",
  "project:updated",
  "pipeline:span_created",
] as const;

export const RUNNER_PLATFORMS = ["linux", "linux.arm64", "linux.shell", "windows", "macos"];

export function stash(r: ResourceInstance, data: Record<string, unknown>): ResourceInstance {
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) if (v !== undefined) extra[k] = JSON.stringify(v);
  return { ...r, resolvedOutputs: { ...r.resolvedOutputs, ...extra } };
}

function fail(message: string, status = 400): never {
  const err = new Error(`Bitbucket plugin: ${message}`) as Error & { status: number };
  err.status = status;
  throw err;
}

export const truthy = (v: string | undefined): boolean =>
  ["true", "1", "yes", "on"].includes((v ?? "").trim().toLowerCase());

/** A policy-picker or string-list value: a JSON array, or a comma list. */
export function parseListish(raw: string | undefined): string[] {
  const v = (raw ?? "").trim();
  if (v.startsWith("[")) {
    try {
      const parsed = JSON.parse(v) as unknown;
      if (Array.isArray(parsed)) return parsed.map((x) => String(x).trim()).filter(Boolean);
    } catch {
      // fall through
    }
  }
  return v
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `KEY=value` lines for a pipeline run. */
export function parseVariableLines(
  raw: string | undefined,
): Array<{ key: string; value: string; secured: false }> {
  const out: Array<{ key: string; value: string; secured: false }> = [];
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) fail(`pipeline variables are KEY=value, one per line (got "${t}")`);
    const key = t.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail(`"${key}" is not a valid variable name`);
    out.push({ key, value: t.slice(eq + 1), secured: false });
  }
  return out;
}

/**
 * Runner labels: `self.hosted` plus exactly one platform label are required,
 * so they are added or checked here rather than left to a 400.
 */
export function runnerLabels(platform: string | undefined, extra: string[]): string[] {
  const labels = new Set(extra.map((l) => l.trim()).filter(Boolean));
  labels.add("self.hosted");
  if (platform) {
    for (const p of RUNNER_PLATFORMS) labels.delete(p);
    labels.add(platform);
  }
  const platforms = [...labels].filter((l) => RUNNER_PLATFORMS.includes(l));
  if (platforms.length !== 1) {
    fail(`a runner needs exactly one platform label: ${RUNNER_PLATFORMS.join(", ")}`);
  }
  return [...labels];
}

/** Strip ANSI escapes from a step log. */
export function cleanLog(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\r(?!\n)/g, "\n");
}

export class BitbucketClient implements PluginClient {
  readonly ctx: BitbucketContext;
  private readonly services: HostServices | undefined;
  private reposCache: Promise<BbRepository[]> | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const token = (credentials["token"] ?? "").trim();
    if (!token) throw new Error("Bitbucket plugin: missing token credential");
    const workspace = (credentials["workspace"] ?? "").trim();
    if (!workspace) throw new Error("Bitbucket plugin: pick a workspace");
    const email = (credentials["email"] ?? "").trim();
    this.ctx = {
      token,
      workspace,
      ...(email ? { email } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
    this.services = services;
  }

  private get ws(): string {
    return enc(this.ctx.workspace);
  }

  private repo(slug: string): string {
    return `/repositories/${this.ws}/${enc(slug)}`;
  }

  private repos(): Promise<BbRepository[]> {
    this.reposCache ??= bbPaged<BbRepository>(
      this.ctx,
      `/repositories/${this.ws}`,
      { sort: "-updated_on" },
      REPO_PAGES,
    ).catch((err: unknown) => {
      this.reposCache = undefined;
      throw err;
    });
    return this.reposCache;
  }

  private async fanout(): Promise<string[]> {
    return (await this.repos()).slice(0, FANOUT_LIMIT).map(slugOf);
  }

  /** Every repository-scoped list, skipping repositories that refuse (no admin, Pipelines off). */
  private async perRepo(
    fn: (slug: string) => Promise<ResourceInstance[]>,
  ): Promise<ResourceInstance[]> {
    const out: ResourceInstance[] = [];
    for (const slug of await this.fanout()) {
      try {
        out.push(...(await fn(slug)));
      } catch (err) {
        if (!isAbsent(err)) throw err;
      }
    }
    return out;
  }

  private async optional<T>(p: Promise<T>): Promise<T | undefined> {
    try {
      return await p;
    } catch (err) {
      if (isAbsent(err)) return undefined;
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    const id = accountId;
    switch (typeId) {
      case "workspace":
        return [await this.workspace(id)];
      case "project":
        return (await bbPaged<BbProject>(this.ctx, `/workspaces/${this.ws}/projects`, {}, 5)).map(
          (p) => mapProject(id, this.ctx.workspace, p),
        );
      case "repository":
        this.reposCache = undefined;
        return (await this.repos()).map((r) => mapRepository(id, r));
      case "pipeline": {
        const out = await this.perRepo(
          async (slug) =>
            (
              await bbFetch<{ values?: BbPipeline[] }>(this.ctx, `${this.repo(slug)}/pipelines`, {
                query: { sort: "-created_on", pagelen: PIPELINES_PER_REPO },
              })
            ).values?.map((p) => mapPipeline(id, this.ctx.workspace, slug, p)) ?? [],
        );
        return out
          .sort((a, b) =>
            String(b.fields["createdAt"] ?? "").localeCompare(String(a.fields["createdAt"] ?? "")),
          )
          .slice(0, PIPELINE_LIMIT);
      }
      case "repository-variable":
        return this.perRepo(async (slug) =>
          (
            await bbPaged<BbVariable>(
              this.ctx,
              `${this.repo(slug)}/pipelines_config/variables`,
              {},
              3,
            )
          ).map((v) => mapVariable(id, { kind: "repository", slug }, v)),
        );
      case "workspace-variable":
        return (
          await bbPaged<BbVariable>(
            this.ctx,
            `/workspaces/${this.ws}/pipelines-config/variables`,
            {},
            3,
          )
        ).map((v) => mapVariable(id, { kind: "workspace" }, v));
      case "environment":
        return this.perRepo(async (slug) =>
          (await bbPaged<BbEnvironment>(this.ctx, `${this.repo(slug)}/environments`, {}, 2)).map(
            (e) => mapEnvironment(id, slug, e),
          ),
        );
      case "deployment-variable":
        return this.perRepo(async (slug) => {
          const out: ResourceInstance[] = [];
          for (const e of await bbPaged<BbEnvironment>(
            this.ctx,
            `${this.repo(slug)}/environments`,
            {},
            2,
          )) {
            const vars = await this.optional(
              bbPaged<BbVariable>(
                this.ctx,
                `${this.repo(slug)}/deployments_config/environments/${encUuid(e.uuid)}/variables`,
                {},
                2,
              ),
            );
            for (const v of vars ?? []) {
              out.push(
                mapVariable(id, { kind: "deployment", slug, envUuid: e.uuid, envName: e.name }, v),
              );
            }
          }
          return out;
        });
      case "branch-restriction":
        return this.perRepo(async (slug) =>
          (
            await bbPaged<BbBranchRestriction>(
              this.ctx,
              `${this.repo(slug)}/branch-restrictions`,
              {},
              2,
            )
          ).map((b) => mapBranchRestriction(id, slug, b)),
        );
      case "repository-webhook":
        return this.perRepo(async (slug) =>
          (await bbPaged<BbWebhook>(this.ctx, `${this.repo(slug)}/hooks`, {}, 2)).map((h) =>
            mapWebhook(id, slug, h),
          ),
        );
      case "workspace-webhook":
        return (await bbPaged<BbWebhook>(this.ctx, `/workspaces/${this.ws}/hooks`, {}, 2)).map(
          (h) => mapWebhook(id, undefined, h),
        );
      case "deploy-key":
        return this.perRepo(async (slug) =>
          (await bbPaged<BbDeployKey>(this.ctx, `${this.repo(slug)}/deploy-keys`, {}, 2)).map((k) =>
            mapDeployKey(id, slug, k),
          ),
        );
      case "project-deploy-key": {
        const out: ResourceInstance[] = [];
        for (const p of await bbPaged<BbProject>(
          this.ctx,
          `/workspaces/${this.ws}/projects`,
          {},
          5,
        )) {
          const keys = await this.optional(
            bbPaged<BbDeployKey>(
              this.ctx,
              `/workspaces/${this.ws}/projects/${enc(p.key)}/deploy-keys`,
              {},
              2,
            ),
          );
          out.push(...(keys ?? []).map((k) => mapProjectDeployKey(id, p.key, k)));
        }
        return out;
      }
      case "runner": {
        const out: ResourceInstance[] = [];
        const workspaceRunners = await this.optional(
          bbPaged<BbRunner>(this.ctx, `/workspaces/${this.ws}/pipelines-config/runners`, {}, 3),
        );
        out.push(...(workspaceRunners ?? []).map((r) => mapRunner(id, undefined, r)));
        out.push(
          ...(await this.perRepo(async (slug) =>
            (
              await bbPaged<BbRunner>(
                this.ctx,
                `${this.repo(slug)}/pipelines-config/runners`,
                {},
                2,
              )
            ).map((r) => mapRunner(id, slug, r)),
          )),
        );
        return out;
      }
      case "pipeline-schedule":
        return this.perRepo(async (slug) =>
          (
            await bbPaged<BbSchedule>(
              this.ctx,
              `${this.repo(slug)}/pipelines_config/schedules`,
              {},
              2,
            )
          ).map((s) => mapSchedule(id, slug, s)),
        );
      case "pipeline-cache":
        return this.perRepo(async (slug) =>
          (
            await bbPaged<BbCache>(this.ctx, `${this.repo(slug)}/pipelines-config/caches`, {}, 2)
          ).map((c) => mapCache(id, slug, c)),
        );
      default:
        throw new Error(`Bitbucket plugin: unknown resource type "${typeId}"`);
    }
  }

  private async workspace(accountId: string): Promise<ResourceInstance> {
    const [w, members] = await Promise.all([
      bbFetch<BbWorkspace>(this.ctx, `/workspaces/${this.ws}`),
      this.optional(bbPaged<unknown>(this.ctx, `/workspaces/${this.ws}/members`, {}, 5)),
    ]);
    return mapWorkspace(accountId, w, members ? { members: members.length } : {});
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
    const { scope: slug, rest } = splitScoped(id);
    switch (typeId) {
      case "workspace":
        return this.workspace(accountId);
      case "project":
        return mapProject(
          accountId,
          this.ctx.workspace,
          await bbFetch<BbProject>(this.ctx, `/workspaces/${this.ws}/projects/${enc(id)}`),
        );
      case "repository": {
        const [r, config, pipelines] = await Promise.all([
          bbFetch<BbRepository>(this.ctx, this.repo(id)),
          this.optional(
            bbFetch<{ enabled?: boolean }>(this.ctx, `${this.repo(id)}/pipelines_config`),
          ),
          this.optional(
            bbFetch<{ values?: BbPipeline[] }>(this.ctx, `${this.repo(id)}/pipelines`, {
              query: { sort: "-created_on", pagelen: 10 },
            }),
          ),
        ]);
        return stash(
          mapRepository(
            accountId,
            r,
            config?.enabled === undefined ? {} : { pipelinesEnabled: config.enabled },
          ),
          { [DETAIL_KEYS.pipelines]: pipelines?.values },
        );
      }
      case "pipeline": {
        const [p, steps] = await Promise.all([
          bbFetch<BbPipeline>(this.ctx, `${this.repo(slug)}/pipelines/${encUuid(rest)}`),
          this.optional(
            bbPaged<BbStep>(this.ctx, `${this.repo(slug)}/pipelines/${encUuid(rest)}/steps`, {}, 2),
          ),
        ]);
        return stash(mapPipeline(accountId, this.ctx.workspace, slug, p), {
          [DETAIL_KEYS.steps]: steps,
        });
      }
      case "repository-variable":
        return mapVariable(
          accountId,
          { kind: "repository", slug },
          await bbFetch<BbVariable>(
            this.ctx,
            `${this.repo(slug)}/pipelines_config/variables/${encUuid(rest)}`,
          ),
        );
      case "workspace-variable":
        return mapVariable(
          accountId,
          { kind: "workspace" },
          await bbFetch<BbVariable>(
            this.ctx,
            `/workspaces/${this.ws}/pipelines-config/variables/${encUuid(id)}`,
          ),
        );
      case "deployment-variable": {
        const { scope: envUuid, rest: varUuid } = splitScoped(rest);
        const [env, vars] = await Promise.all([
          this.optional(
            bbFetch<BbEnvironment>(this.ctx, `${this.repo(slug)}/environments/${encUuid(envUuid)}`),
          ),
          bbPaged<BbVariable>(
            this.ctx,
            `${this.repo(slug)}/deployments_config/environments/${encUuid(envUuid)}/variables`,
            {},
            3,
          ),
        ]);
        const v = vars.find((x) => x.uuid === varUuid);
        if (!v) fail("deployment variable not found", 404);
        return mapVariable(
          accountId,
          { kind: "deployment", slug, envUuid, ...(env ? { envName: env.name } : {}) },
          v,
        );
      }
      case "environment": {
        const [e, deployments] = await Promise.all([
          bbFetch<BbEnvironment>(this.ctx, `${this.repo(slug)}/environments/${encUuid(rest)}`),
          this.deploymentsFor(slug, rest, 3),
        ]);
        return stash(mapEnvironment(accountId, slug, e, deployments[0]), {
          [DETAIL_KEYS.deployments]: deployments.slice(0, 15),
        });
      }
      case "branch-restriction":
        return mapBranchRestriction(
          accountId,
          slug,
          await bbFetch<BbBranchRestriction>(
            this.ctx,
            `${this.repo(slug)}/branch-restrictions/${enc(rest)}`,
          ),
        );
      case "repository-webhook":
        return mapWebhook(
          accountId,
          slug,
          await bbFetch<BbWebhook>(this.ctx, `${this.repo(slug)}/hooks/${encUuid(rest)}`),
        );
      case "workspace-webhook":
        return mapWebhook(
          accountId,
          undefined,
          await bbFetch<BbWebhook>(this.ctx, `/workspaces/${this.ws}/hooks/${encUuid(id)}`),
        );
      case "deploy-key":
        return mapDeployKey(
          accountId,
          slug,
          await bbFetch<BbDeployKey>(this.ctx, `${this.repo(slug)}/deploy-keys/${enc(rest)}`),
        );
      case "project-deploy-key":
        return mapProjectDeployKey(
          accountId,
          slug,
          await bbFetch<BbDeployKey>(
            this.ctx,
            `/workspaces/${this.ws}/projects/${enc(slug)}/deploy-keys/${enc(rest)}`,
          ),
        );
      case "runner": {
        const { slug: repoSlug, uuid } = parseRunnerId(id);
        return mapRunner(
          accountId,
          repoSlug,
          await bbFetch<BbRunner>(this.ctx, this.runnerPath(repoSlug, uuid)),
        );
      }
      case "pipeline-schedule": {
        const [s, runs] = await Promise.all([
          bbFetch<BbSchedule>(
            this.ctx,
            `${this.repo(slug)}/pipelines_config/schedules/${encUuid(rest)}`,
          ),
          this.optional(
            bbFetch<{ values?: BbPipeline[] }>(
              this.ctx,
              `${this.repo(slug)}/pipelines_config/schedules/${encUuid(rest)}/executions`,
              { query: { pagelen: 10 } },
            ),
          ),
        ]);
        return stash(mapSchedule(accountId, slug, s), { [DETAIL_KEYS.pipelines]: runs?.values });
      }
      case "pipeline-cache": {
        const caches = await bbPaged<BbCache>(
          this.ctx,
          `${this.repo(slug)}/pipelines-config/caches`,
          {},
          3,
        );
        const c = caches.find((x) => x.uuid === rest);
        if (!c) fail("cache not found (Bitbucket expires caches after a week)", 404);
        return mapCache(accountId, slug, c);
      }
      default:
        throw new Error(`Bitbucket plugin: unknown resource type "${typeId}"`);
    }
  }

  private runnerPath(slug: string | undefined, uuid: string): string {
    return slug
      ? `${this.repo(slug)}/pipelines-config/runners/${encUuid(uuid)}`
      : `/workspaces/${this.ws}/pipelines-config/runners/${encUuid(uuid)}`;
  }

  /** A repository's deployments to one environment, newest first. */
  private async deploymentsFor(
    slug: string,
    envUuid: string,
    pages: number,
  ): Promise<BbDeployment[]> {
    const all = await this.optional(
      bbPaged<BbDeployment>(this.ctx, `${this.repo(slug)}/deployments`, {}, pages),
    );
    const when = (d: BbDeployment) =>
      Date.parse(d.state?.completion_date ?? d.state?.start_date ?? d.last_update_time ?? "") || 0;
    return (all ?? [])
      .filter((d) => d.environment?.uuid === envUuid)
      .sort((a, b) => when(b) - when(a));
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (
      typeId === "runner" &&
      (outputKey === "oauthClientId" || outputKey === "oauthClientSecret")
    ) {
      const value = await this.services?.secrets?.getPlaintext(resourceId, outputKey);
      if (!value) {
        fail(
          "Bitbucket shows a runner's OAuth credentials once, and this runner was not created from Infrawrench. Create a new runner here to have them kept.",
          404,
        );
      }
      return value;
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    const resolved = resource.resolvedOutputs[outputKey];
    if (resolved !== undefined) return resolved;
    const field = resource.fields[outputKey];
    if (field !== undefined) return String(field);
    throw new Error(`Bitbucket plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Stats and metrics
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = r.fields;
    switch (resourceTypeId) {
      case "pipeline":
        return [
          {
            label: "Result",
            value: String(f["result"] ?? "—"),
            variant:
              f["result"] === "SUCCESSFUL"
                ? "status-healthy"
                : f["result"] === "FAILED"
                  ? "status-error"
                  : "default",
          },
        ];
      case "runner":
        return [
          {
            label: "Status",
            value: String(f["status"] ?? "—"),
            variant: f["status"] === "ONLINE" ? "status-healthy" : "status-degraded",
          },
        ];
      case "environment":
        return [{ label: "Last deployment", value: String(f["lastDeploymentStatus"] ?? "—") }];
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
    if (resourceTypeId === "repository") {
      const pipelines: BbPipeline[] = [];
      let next: string | undefined = `${this.repo(id)}/pipelines`;
      for (let i = 0; i < METRIC_PAGES && next; i++) {
        const page: { values?: BbPipeline[]; next?: string } = await bbFetch(
          this.ctx,
          next,
          i === 0 ? { query: { sort: "-created_on", pagelen: 100 } } : {},
        );
        const values = page.values ?? [];
        pipelines.push(...values);
        const oldest = values[values.length - 1]?.created_on;
        if (!oldest || Date.parse(oldest) < range.startMs) break;
        next = page.next;
      }
      return pipelineSeries(pipelines, range);
    }
    if (resourceTypeId === "environment") {
      const { scope: slug, rest } = splitScoped(id);
      return deploymentSeries(await this.deploymentsFor(slug, rest, METRIC_PAGES), range);
    }
    return [];
  }

  // -------------------------------------------------------------------------
  // Create forms
  // -------------------------------------------------------------------------

  private async repoField(parentResourceId: string | undefined): Promise<CreateFieldConfig[]> {
    if (parentResourceId) return [];
    const repos = await this.repos().catch(() => [] as BbRepository[]);
    const options = repos.map((r) => ({ id: slugOf(r), label: r.name, description: r.full_name }));
    return [
      {
        key: "repository",
        label: "Repository",
        kind: "select",
        required: true,
        ...(options[0] ? { defaultValue: options[0].id } : {}),
        options,
      },
    ];
  }

  private async projectOptions(): Promise<SelectOption[]> {
    const projects = await bbPaged<BbProject>(
      this.ctx,
      `/workspaces/${this.ws}/projects`,
      {},
      5,
    ).catch(() => [] as BbProject[]);
    return projects.map((p) => ({ id: p.key, label: p.name ?? p.key, description: p.key }));
  }

  /** Branch picker for a known repository, or free text when the repository is picked in the same form. */
  private async branchField(
    slug: string | undefined,
    key: string,
    label: string,
  ): Promise<CreateFieldConfig> {
    if (!slug) return { key, label, kind: "text", required: true, placeholder: "main" };
    const [repo, branches] = await Promise.all([
      this.optional(bbFetch<BbRepository>(this.ctx, this.repo(slug))),
      this.optional(
        bbFetch<{ values?: Array<{ name: string }> }>(
          this.ctx,
          `${this.repo(slug)}/refs/branches`,
          {
            query: { pagelen: 100, sort: "-target.date" },
          },
        ),
      ),
    ]);
    const options = (branches?.values ?? []).map((b) => ({ id: b.name, label: b.name }));
    if (options.length === 0)
      return { key, label, kind: "text", required: true, placeholder: "main" };
    const def = repo?.mainbranch?.name ?? options[0]?.id;
    return {
      key,
      label,
      kind: "select",
      required: true,
      options,
      ...(def ? { defaultValue: def } : {}),
    };
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    const parent = parentResourceId ? externalIdOf(parentResourceId) : undefined;
    const parentRepo = parent && parentResourceId?.includes(":repository:") ? parent : undefined;
    const yesNo = (
      key: string,
      label: string,
      def: boolean,
      yes = "Yes",
      no = "No",
    ): CreateFieldConfig => ({
      key,
      label,
      kind: "select",
      required: false,
      defaultValue: String(def),
      options: [
        { id: "true", label: yes },
        { id: "false", label: no },
      ],
    });
    const variableFields: CreateFieldConfig[] = [
      { key: "key", label: "Name", kind: "text", required: true, placeholder: "AWS_ACCESS_KEY_ID" },
      { key: "value", label: "Value", kind: "password", required: true },
      yesNo("secured", "Secured", true, "Secured (hidden, cannot be read back)", "Visible"),
    ];
    switch (typeId) {
      case "project":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "Platform" },
            {
              key: "key",
              label: "Key",
              kind: "text",
              required: true,
              placeholder: "PLAT",
              description: "Short uppercase identifier, unique in the workspace.",
            },
            { key: "description", label: "Description", kind: "text", required: false },
            yesNo("private", "Visibility", true, "Private", "Public"),
          ],
        };
      case "repository":
        return {
          fields: [
            {
              key: "slug",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "my-service",
              description: "Lowercase letters, digits, dashes, dots and underscores.",
            },
            {
              key: "project",
              label: "Project",
              kind: "select",
              required: true,
              options: await this.projectOptions(),
            },
            { key: "description", label: "Description", kind: "text", required: false },
            yesNo("private", "Visibility", true, "Private", "Public"),
          ],
        };
      case "pipeline":
        return {
          fields: [
            ...(await this.repoField(parentResourceId)),
            await this.branchField(parentRepo, "branch", "Branch"),
            {
              key: "pipeline",
              label: "Custom pipeline",
              kind: "text",
              required: false,
              placeholder: "deploy-to-production",
              description:
                "Name of a pipeline under custom: in bitbucket-pipelines.yml. Leave empty to run the branch's default pipeline.",
            },
            {
              key: "variables",
              label: "Variables",
              kind: "text",
              multiline: true,
              required: false,
              placeholder: "ENVIRONMENT=staging",
              description: "One KEY=value per line, for custom pipelines that declare variables.",
            },
          ],
        };
      case "repository-variable":
        return { fields: [...(await this.repoField(parentResourceId)), ...variableFields] };
      case "workspace-variable":
        return { fields: variableFields };
      case "deployment-variable": {
        if (parentResourceId) return { fields: variableFields };
        const envs = await this.listResources("environment", "x").catch(
          () => [] as ResourceInstance[],
        );
        return {
          fields: [
            {
              key: "environment",
              label: "Environment",
              kind: "select",
              required: true,
              options: envs.map((e) => ({
                id: e.externalId ?? "",
                label: String(e.fields["name"] ?? e.displayName),
                description: String(e.fields["repository"] ?? ""),
              })),
            },
            ...variableFields,
          ],
        };
      }
      case "environment":
        return {
          fields: [
            ...(await this.repoField(parentResourceId)),
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "Staging" },
            {
              key: "environmentType",
              label: "Type",
              kind: "select",
              required: true,
              defaultValue: "Staging",
              options: ["Test", "Staging", "Production"].map((t) => ({ id: t, label: t })),
            },
          ],
        };
      case "branch-restriction":
        return {
          fields: [
            ...(await this.repoField(parentResourceId)),
            {
              key: "kind",
              label: "Rule",
              kind: "select",
              required: true,
              defaultValue: "require_approvals_to_merge",
              options: Object.entries(RESTRICTION_KINDS).map(([id, k]) => ({
                id,
                label: k.label,
                description: id,
              })),
            },
            {
              key: "matchKind",
              label: "Applies to",
              kind: "select",
              required: true,
              defaultValue: "glob",
              options: [
                { id: "glob", label: "Branch name or pattern" },
                { id: "branching_model", label: "Branch type (branching model)" },
              ],
            },
            {
              key: "pattern",
              label: "Branch pattern",
              kind: "text",
              required: false,
              placeholder: "main or release/*",
              showWhen: { fieldKey: "matchKind", fieldValue: "glob" },
            },
            {
              key: "branchType",
              label: "Branch type",
              kind: "select",
              required: false,
              defaultValue: "production",
              options: ["production", "development", "release", "feature", "bugfix", "hotfix"].map(
                (t) => ({
                  id: t,
                  label: t,
                }),
              ),
              showWhen: { fieldKey: "matchKind", fieldValue: "branching_model" },
            },
            {
              key: "value",
              label: "Required count",
              kind: "number",
              required: false,
              minValue: 1,
              defaultValue: "1",
              showWhen: {
                fieldKey: "kind",
                fieldValues: Object.entries(RESTRICTION_KINDS)
                  .filter(([, k]) => k.takesValue)
                  .map(([id]) => id),
              },
            },
          ],
        };
      case "repository-webhook":
      case "workspace-webhook":
        return {
          fields: [
            ...(typeId === "repository-webhook" ? await this.repoField(parentResourceId) : []),
            {
              key: "url",
              label: "URL",
              kind: "text",
              required: true,
              placeholder: "https://hooks.example.com/bitbucket",
            },
            {
              key: "description",
              label: "Description",
              kind: "text",
              required: true,
              placeholder: "Deploy bot",
            },
            {
              key: "events",
              label: "Events",
              kind: "policy-picker",
              required: true,
              policies: WEBHOOK_EVENTS.map((e) => ({
                id: e,
                label: e,
                category: e.split(":")[0] ?? e,
              })),
            },
            { key: "secret", label: "Secret", kind: "password", required: false },
            yesNo("active", "Active", true),
          ],
        };
      case "deploy-key":
      case "project-deploy-key":
        return {
          fields: [
            ...(typeId === "deploy-key"
              ? await this.repoField(parentResourceId)
              : parentResourceId
                ? []
                : [
                    {
                      key: "project",
                      label: "Project",
                      kind: "select" as const,
                      required: true,
                      options: await this.projectOptions(),
                    },
                  ]),
            {
              key: "label",
              label: "Label",
              kind: "text",
              required: true,
              placeholder: "ci-deployer",
            },
            { key: "key", label: "Public key", kind: "ssh-key-picker", required: true },
          ],
        };
      case "runner": {
        const repos = await this.repos().catch(() => [] as BbRepository[]);
        return {
          fields: [
            {
              key: "scope",
              label: "Register to",
              kind: "select",
              required: true,
              defaultValue: "workspace",
              options: [
                { id: "workspace", label: "Workspace", description: "Any repository can use it." },
                ...repos.map((r) => ({
                  id: `repo:${slugOf(r)}`,
                  label: r.name,
                  description: "Repository runner",
                })),
              ],
            },
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "build-01" },
            {
              key: "platform",
              label: "Platform",
              kind: "select",
              required: true,
              defaultValue: "linux",
              options: [
                { id: "linux", label: "Linux Docker (x86)" },
                { id: "linux.arm64", label: "Linux Docker (ARM)" },
                { id: "linux.shell", label: "Linux Shell" },
                { id: "windows", label: "Windows" },
                { id: "macos", label: "macOS" },
              ],
            },
            {
              key: "labels",
              label: "Extra labels",
              kind: "string-list",
              required: false,
              description:
                "Steps with runs-on these labels run here. self.hosted is added for you.",
            },
          ],
        };
      }
      case "pipeline-schedule":
        return {
          fields: [
            ...(await this.repoField(parentResourceId)),
            await this.branchField(parentRepo, "branch", "Branch"),
            {
              key: "selectorType",
              label: "Pipeline to run",
              kind: "select",
              required: true,
              defaultValue: "branches",
              options: [
                {
                  id: "branches",
                  label: "The branch's pipeline",
                  description: "Under branches: for this branch.",
                },
                { id: "default", label: "The default pipeline", description: "Under default:." },
                {
                  id: "custom",
                  label: "A custom pipeline",
                  description: "Under custom:, by name.",
                },
              ],
            },
            {
              key: "pipeline",
              label: "Custom pipeline name",
              kind: "text",
              required: false,
              placeholder: "nightly",
              showWhen: { fieldKey: "selectorType", fieldValue: "custom" },
            },
            {
              key: "cron",
              label: "Cron schedule (UTC)",
              kind: "text",
              required: true,
              placeholder: "0 0 3 ? * MON-FRI *",
              description:
                "Seven-field Quartz cron with seconds: second, minute, hour, day of month, month, day of week, year. 0 0 12 * * ? * runs at noon UTC daily.",
            },
          ],
        };
      default:
        throw new Error(`Bitbucket plugin: cannot create "${typeId}" from Infrawrench`);
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
    const repoSlug = () => {
      const v = (fields["repository"] ?? "").trim() || parent || "";
      if (!v) fail("pick a repository");
      return v;
    };
    const post = <T>(path: string, body: unknown) =>
      bbFetch<T>(this.ctx, path, { method: "POST", body });
    switch (typeId) {
      case "project": {
        const p = await post<BbProject>(`/workspaces/${this.ws}/projects`, {
          name: need("name", "Name"),
          key: need("key", "Key").toUpperCase(),
          ...(fields["description"] ? { description: fields["description"] } : {}),
          is_private: fields["private"] === undefined ? true : truthy(fields["private"]),
        });
        return mapProject(accountId, this.ctx.workspace, p);
      }
      case "repository": {
        const slug = need("slug", "Name").toLowerCase();
        if (!/^[a-z0-9._-]+$/.test(slug))
          fail("a repository name may only use lowercase letters, digits, . _ and -");
        const r = await post<BbRepository>(this.repo(slug), {
          scm: "git",
          is_private: fields["private"] === undefined ? true : truthy(fields["private"]),
          ...(fields["description"] ? { description: fields["description"] } : {}),
          ...(fields["project"] ? { project: { key: fields["project"] } } : {}),
        });
        return mapRepository(accountId, r);
      }
      case "pipeline": {
        const slug = repoSlug();
        const custom = (fields["pipeline"] ?? "").trim();
        const variables = parseVariableLines(fields["variables"]);
        const p = await post<BbPipeline>(`${this.repo(slug)}/pipelines`, {
          target: {
            type: "pipeline_ref_target",
            ref_type: "branch",
            ref_name: need("branch", "Branch"),
            ...(custom ? { selector: { type: "custom", pattern: custom } } : {}),
          },
          ...(variables.length > 0 ? { variables } : {}),
        });
        return mapPipeline(accountId, this.ctx.workspace, slug, p);
      }
      case "repository-variable":
      case "workspace-variable":
      case "deployment-variable": {
        const body = {
          key: need("key", "Name"),
          value: fields["value"] ?? "",
          secured: fields["secured"] === undefined ? true : truthy(fields["secured"]),
        };
        if (!body.value) fail('"Value" is required');
        if (typeId === "repository-variable") {
          const slug = repoSlug();
          const v = await post<BbVariable>(`${this.repo(slug)}/pipelines_config/variables`, body);
          return mapVariable(accountId, { kind: "repository", slug }, v);
        }
        if (typeId === "workspace-variable") {
          const v = await post<BbVariable>(
            `/workspaces/${this.ws}/pipelines-config/variables`,
            body,
          );
          return mapVariable(accountId, { kind: "workspace" }, v);
        }
        const envId = (fields["environment"] ?? "").trim() || parent || "";
        const { scope: slug, rest: envUuid } = splitScoped(envId);
        if (!slug || !envUuid) fail("pick an environment");
        const v = await post<BbVariable>(
          `${this.repo(slug)}/deployments_config/environments/${encUuid(envUuid)}/variables`,
          body,
        );
        return mapVariable(accountId, { kind: "deployment", slug, envUuid }, v);
      }
      case "environment": {
        const slug = repoSlug();
        const e = await post<BbEnvironment>(`${this.repo(slug)}/environments`, {
          name: need("name", "Name"),
          environment_type: { name: fields["environmentType"] || "Staging" },
        });
        return mapEnvironment(accountId, slug, e);
      }
      case "branch-restriction": {
        const slug = repoSlug();
        const kind = need("kind", "Rule");
        if (!RESTRICTION_KINDS[kind]) fail(`"${kind}" is not a branch restriction`);
        const b = await post<BbBranchRestriction>(
          `${this.repo(slug)}/branch-restrictions`,
          this.restrictionBody(kind, fields),
        );
        return mapBranchRestriction(accountId, slug, b);
      }
      case "repository-webhook":
      case "workspace-webhook": {
        const events = parseListish(fields["events"]);
        if (events.length === 0) fail("pick at least one event");
        const body = {
          url: need("url", "URL"),
          description: need("description", "Description"),
          active: fields["active"] === undefined ? true : truthy(fields["active"]),
          events,
          ...(fields["secret"] ? { secret: fields["secret"] } : {}),
        };
        if (typeId === "workspace-webhook") {
          return mapWebhook(
            accountId,
            undefined,
            await post<BbWebhook>(`/workspaces/${this.ws}/hooks`, body),
          );
        }
        const slug = repoSlug();
        return mapWebhook(accountId, slug, await post<BbWebhook>(`${this.repo(slug)}/hooks`, body));
      }
      case "deploy-key": {
        const slug = repoSlug();
        const k = await post<BbDeployKey>(`${this.repo(slug)}/deploy-keys`, {
          key: need("key", "Public key"),
          label: need("label", "Label"),
        });
        return mapDeployKey(accountId, slug, k);
      }
      case "project-deploy-key": {
        const key = (fields["project"] ?? "").trim() || parent || "";
        if (!key) fail("pick a project");
        const k = await post<BbDeployKey>(
          `/workspaces/${this.ws}/projects/${enc(key)}/deploy-keys`,
          {
            key: need("key", "Public key"),
            label: need("label", "Label"),
          },
        );
        return mapProjectDeployKey(accountId, key, k);
      }
      case "runner": {
        const scope = fields["scope"] || "workspace";
        const slug = scope.startsWith("repo:") ? scope.slice(5) : undefined;
        const r = await post<BbRunner>(
          slug
            ? `${this.repo(slug)}/pipelines-config/runners`
            : `/workspaces/${this.ws}/pipelines-config/runners`,
          {
            name: need("name", "Name"),
            labels: runnerLabels(fields["platform"] || "linux", parseListish(fields["labels"])),
          },
        );
        const resource = mapRunner(accountId, slug, r);
        const secrets = this.services?.secrets;
        const id = r.oauth_client?.id;
        const secret = r.oauth_client?.secret;
        if (id && secret) {
          if (secrets?.setPlaintext) {
            await secrets.setPlaintext(resource.id, "oauthClientId", id);
            await secrets.setPlaintext(resource.id, "oauthClientSecret", secret);
          } else {
            return {
              resource,
              warnings: [
                {
                  code: "runner-credentials-not-kept",
                  message:
                    "Runner created, but this host cannot store secrets, so its OAuth client credentials were not kept. Delete it and create it from a host that can, or from Bitbucket.",
                },
              ],
            };
          }
        }
        return resource;
      }
      case "pipeline-schedule": {
        const slug = repoSlug();
        const cron = need("cron", "Cron schedule");
        if (cron.split(/\s+/).length !== 7) {
          fail(
            'Bitbucket schedules use seven-field Quartz cron with seconds first, e.g. "0 0 12 * * ? *"',
          );
        }
        const branch = need("branch", "Branch");
        const selectorType = fields["selectorType"] || "branches";
        const selector =
          selectorType === "custom"
            ? { type: "custom", pattern: need("pipeline", "Custom pipeline name") }
            : selectorType === "default"
              ? { type: "default" }
              : { type: "branches", pattern: branch };
        const s = await post<BbSchedule>(`${this.repo(slug)}/pipelines_config/schedules`, {
          type: "pipeline_schedule",
          enabled: true,
          cron_pattern: cron,
          target: { type: "pipeline_ref_target", ref_type: "branch", ref_name: branch, selector },
        });
        return mapSchedule(accountId, slug, s);
      }
      default:
        throw new Error(`Bitbucket plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  private restrictionBody(
    kind: string,
    fields: Record<string, string>,
    current?: BbBranchRestriction,
  ) {
    const matchKind = fields["matchKind"] || current?.branch_match_kind || "glob";
    const spec = RESTRICTION_KINDS[kind];
    const value = (fields["value"] ?? "").trim();
    return {
      kind,
      branch_match_kind: matchKind,
      ...(matchKind === "branching_model"
        ? { branch_type: fields["branchType"] || current?.branch_type || "production" }
        : {
            pattern:
              (fields["pattern"] ?? "").trim() ||
              current?.pattern ||
              fail('"Branch pattern" is required'),
          }),
      ...(spec?.takesValue ? { value: value ? Number(value) : (current?.value ?? 1) } : {}),
      ...(spec?.takesExemptions
        ? {
            users: (current?.users ?? []).map((u) => ({ uuid: u.uuid })),
            groups: (current?.groups ?? []).map((g) => ({ slug: g.slug })),
          }
        : {}),
    };
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    const { scope: slug, rest } = splitScoped(id);
    const has = (k: string) => k in fields;
    const put = (path: string, body: unknown) => bbFetch(this.ctx, path, { method: "PUT", body });
    switch (typeId) {
      case "project": {
        const path = `/workspaces/${this.ws}/projects/${enc(id)}`;
        const current = await bbFetch<BbProject>(this.ctx, path);
        await put(path, {
          key: current.key,
          name: has("name") ? fields["name"] : current.name,
          description: has("description") ? fields["description"] : (current.description ?? ""),
          is_private: has("private") ? truthy(fields["private"]) : current.is_private,
        });
        break;
      }
      case "repository": {
        const body: Record<string, unknown> = {};
        if (has("description")) body["description"] = fields["description"] ?? "";
        if (has("private")) body["is_private"] = truthy(fields["private"]);
        if (has("forkPolicy")) body["fork_policy"] = fields["forkPolicy"];
        if (has("project") && fields["project"]) body["project"] = { key: fields["project"] };
        if (Object.keys(body).length > 0) await put(this.repo(id), body);
        break;
      }
      case "repository-variable":
      case "workspace-variable":
      case "deployment-variable": {
        let path: string;
        let current: BbVariable | undefined;
        if (typeId === "repository-variable") {
          path = `${this.repo(slug)}/pipelines_config/variables/${encUuid(rest)}`;
          current = await bbFetch<BbVariable>(this.ctx, path);
        } else if (typeId === "workspace-variable") {
          path = `/workspaces/${this.ws}/pipelines-config/variables/${encUuid(id)}`;
          current = await bbFetch<BbVariable>(this.ctx, path);
        } else {
          const { scope: envUuid, rest: varUuid } = splitScoped(rest);
          const base = `${this.repo(slug)}/deployments_config/environments/${encUuid(envUuid)}/variables`;
          path = `${base}/${encUuid(varUuid)}`;
          current = (await bbPaged<BbVariable>(this.ctx, base, {}, 3)).find(
            (v) => v.uuid === varUuid,
          );
          if (!current) fail("deployment variable not found", 404);
        }
        const value = fields["value"] || current.value;
        if (value === undefined) {
          fail(
            "this variable is secured, so Bitbucket will not return its value. Type the value to change it.",
          );
        }
        await put(path, {
          key: current.key,
          value,
          secured: has("secured") ? truthy(fields["secured"]) : (current.secured ?? false),
        });
        break;
      }
      case "environment": {
        const change: Record<string, unknown> = {};
        if (has("name") && fields["name"]) change["name"] = fields["name"];
        if (has("adminOnly")) change["restrictions"] = { admin_only: truthy(fields["adminOnly"]) };
        if (Object.keys(change).length > 0) {
          const body = { change };
          try {
            await bbRequest(this.ctx, `${this.repo(slug)}/environments/${encUuid(rest)}/changes`, {
              method: "POST",
              body,
            });
          } catch (err) {
            // The published path 404s on some repositories; the older
            // deployments_config path is the one the community reports working.
            if (statusOf(err) !== 404) throw err;
            await bbRequest(
              this.ctx,
              `${this.repo(slug)}/deployments_config/environments/${encUuid(rest)}/changes`,
              {
                method: "POST",
                body,
              },
            );
          }
        }
        break;
      }
      case "branch-restriction": {
        const path = `${this.repo(slug)}/branch-restrictions/${enc(rest)}`;
        const current = await bbFetch<BbBranchRestriction>(this.ctx, path);
        await put(path, this.restrictionBody(current.kind, fields, current));
        break;
      }
      case "repository-webhook":
      case "workspace-webhook": {
        const path =
          typeId === "repository-webhook"
            ? `${this.repo(slug)}/hooks/${encUuid(rest)}`
            : `/workspaces/${this.ws}/hooks/${encUuid(id)}`;
        const current = await bbFetch<BbWebhook>(this.ctx, path);
        await put(path, {
          url: has("url") && fields["url"] ? fields["url"] : current.url,
          description: has("description") ? fields["description"] : current.description,
          active: has("active") ? truthy(fields["active"]) : current.active,
          events: has("events") ? parseListish(fields["events"]) : current.events,
          ...(fields["secret"] ? { secret: fields["secret"] } : {}),
        });
        break;
      }
      case "deploy-key": {
        const path = `${this.repo(slug)}/deploy-keys/${enc(rest)}`;
        const current = await bbFetch<BbDeployKey>(this.ctx, path);
        await put(path, {
          key: current.key,
          label: has("label") ? fields["label"] : current.label,
        });
        break;
      }
      case "runner": {
        const { slug: repoSlug, uuid } = parseRunnerId(id);
        const path = this.runnerPath(repoSlug, uuid);
        const current = await bbFetch<BbRunner>(this.ctx, path);
        await put(path, {
          name: has("name") && fields["name"] ? fields["name"] : current.name,
          labels: has("labels")
            ? runnerLabels(undefined, parseListish(fields["labels"]))
            : current.labels,
        });
        break;
      }
      case "pipeline-schedule":
        if (has("enabled")) {
          await put(`${this.repo(slug)}/pipelines_config/schedules/${encUuid(rest)}`, {
            enabled: truthy(fields["enabled"]),
          });
        }
        break;
      default:
        throw new Error(`Bitbucket plugin: cannot edit "${typeId}" from Infrawrench`);
    }
    return this.getResource(typeId, resourceId, accountId);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const id = externalIdOf(resourceId);
    const { scope: slug, rest } = splitScoped(id);
    const del = (path: string) => bbFetch(this.ctx, path, { method: "DELETE" });
    switch (typeId) {
      case "project":
        await del(`/workspaces/${this.ws}/projects/${enc(id)}`);
        return;
      case "repository-variable":
        await del(`${this.repo(slug)}/pipelines_config/variables/${encUuid(rest)}`);
        return;
      case "workspace-variable":
        await del(`/workspaces/${this.ws}/pipelines-config/variables/${encUuid(id)}`);
        return;
      case "deployment-variable": {
        const { scope: envUuid, rest: varUuid } = splitScoped(rest);
        await del(
          `${this.repo(slug)}/deployments_config/environments/${encUuid(envUuid)}/variables/${encUuid(varUuid)}`,
        );
        return;
      }
      case "environment":
        await del(`${this.repo(slug)}/environments/${encUuid(rest)}`);
        return;
      case "branch-restriction":
        await del(`${this.repo(slug)}/branch-restrictions/${enc(rest)}`);
        return;
      case "repository-webhook":
        await del(`${this.repo(slug)}/hooks/${encUuid(rest)}`);
        return;
      case "workspace-webhook":
        await del(`/workspaces/${this.ws}/hooks/${encUuid(id)}`);
        return;
      case "deploy-key":
        await del(`${this.repo(slug)}/deploy-keys/${enc(rest)}`);
        return;
      case "project-deploy-key":
        await del(`/workspaces/${this.ws}/projects/${enc(slug)}/deploy-keys/${enc(rest)}`);
        return;
      case "runner": {
        const { slug: repoSlug, uuid } = parseRunnerId(id);
        await del(this.runnerPath(repoSlug, uuid));
        return;
      }
      case "pipeline-schedule":
        await del(`${this.repo(slug)}/pipelines_config/schedules/${encUuid(rest)}`);
        return;
      case "pipeline-cache":
        await del(`${this.repo(slug)}/pipelines-config/caches/${encUuid(rest)}`);
        return;
      default:
        throw new Error(`Bitbucket plugin: cannot delete "${typeId}" from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Actions and logs
  // -------------------------------------------------------------------------

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const id = externalIdOf(resourceId);
    const { scope: slug, rest } = splitScoped(id);
    if (typeId === "pipeline" && actionId === "stop") {
      await bbRequest(this.ctx, `${this.repo(slug)}/pipelines/${encUuid(rest)}/stopPipeline`, {
        method: "POST",
      });
      return;
    }
    if (
      typeId === "repository" &&
      (actionId === "enable-pipelines" || actionId === "disable-pipelines")
    ) {
      await bbFetch(this.ctx, `${this.repo(id)}/pipelines_config`, {
        method: "PUT",
        body: { enabled: actionId === "enable-pipelines" },
      });
      return;
    }
    if (typeId === "repository" && actionId === "clear-caches") {
      const caches = await bbPaged<BbCache>(
        this.ctx,
        `${this.repo(id)}/pipelines-config/caches`,
        {},
        3,
      );
      for (const c of caches) {
        await bbFetch(this.ctx, `${this.repo(id)}/pipelines-config/caches/${encUuid(c.uuid)}`, {
          method: "DELETE",
        });
      }
      return;
    }
    if (
      (typeId === "repository-webhook" || typeId === "workspace-webhook") &&
      (actionId === "activate" || actionId === "deactivate")
    ) {
      await this.updateResource(typeId, resourceId, _accountId, {
        active: String(actionId === "activate"),
      });
      return;
    }
    if (typeId === "pipeline-schedule" && (actionId === "enable" || actionId === "disable")) {
      await bbFetch(this.ctx, `${this.repo(slug)}/pipelines_config/schedules/${encUuid(rest)}`, {
        method: "PUT",
        body: { enabled: actionId === "enable" },
      });
      return;
    }
    if (typeId === "runner" && (actionId === "enable" || actionId === "disable")) {
      const { slug: repoSlug, uuid } = parseRunnerId(id);
      const path = this.runnerPath(repoSlug, uuid);
      const current = await bbFetch<BbRunner>(this.ctx, path);
      await bbFetch(this.ctx, path, {
        method: "PUT",
        body: {
          name: current.name,
          labels: current.labels,
          state: { status: actionId === "enable" ? "ENABLED" : "DISABLED" },
        },
      });
      return;
    }
    throw new Error(`Bitbucket plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  /**
   * Step logs: each step is a "container" in the Logs tab. The tail is read
   * with a Range request (the endpoint encourages it); finished steps answer
   * with a redirect to long-term storage, which the host follows.
   */
  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    if (typeId !== "pipeline") throw new Error(`Bitbucket plugin: "${typeId}" has no logs`);
    const { scope: slug, rest } = splitScoped(externalIdOf(resourceId));
    const steps = await bbPaged<BbStep>(
      this.ctx,
      `${this.repo(slug)}/pipelines/${encUuid(rest)}/steps`,
      {},
      2,
    );
    const label = (s: BbStep, i: number) => `${i + 1}. ${s.name ?? "Step"}`;
    const labelled = steps.map((s, i) => ({ s, name: label(s, i) }));
    const word = (s: BbStep) => s.state?.result?.name ?? s.state?.name;
    const pick =
      labelled.find((x) => x.name === params.container) ??
      labelled.find((x) => word(x.s) === "FAILED" || word(x.s) === "ERROR") ??
      labelled.find((x) => word(x.s) === "IN_PROGRESS") ??
      labelled[labelled.length - 1];
    if (!pick)
      return { text: "This pipeline has no steps yet.\n", containers: [], activeContainer: "" };
    const path = `${this.repo(slug)}/pipelines/${encUuid(rest)}/steps/${encUuid(pick.s.uuid)}/log`;
    let text: string;
    try {
      text = await bbFetch<string>(this.ctx, path, {
        as: "text",
        headers: { Range: `bytes=-${LOG_TAIL_BYTES}` },
      });
    } catch (err) {
      const status = statusOf(err);
      if (status === 416) text = await bbFetch<string>(this.ctx, path, { as: "text" });
      else if (status === 404) text = `No log for ${pick.s.name ?? "this step"} yet.\n`;
      else throw err;
    }
    const lines = cleanLog(text).split("\n");
    const tail = params.tailLines && params.tailLines > 0 ? lines.slice(-params.tailLines) : lines;
    return {
      text: `${tail.join("\n")}\n`,
      containers: labelled.map((x) => x.name),
      activeContainer: pick.name,
    };
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderBitbucketDetail(resource, this.ctx.workspace);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderBitbucketSidebar(resource);
  }
}

export type { VariableOwner };
