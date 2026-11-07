import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
import type {
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  PreflightResult,
  QuotaUsage,
  ResourceCreateReturn,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf, pathEncode, rethrowIncompleteList } from "@infrawrench/plugin-base";
import type {
  ConvexContext,
  CreateLogStreamBody,
  CvCreatedLogStream,
  CvDeployKey,
  CvDeployment,
  CvLogStream,
  CvProject,
  DeploymentApi,
  ManagementApi,
  UpdateDeploymentBody,
  UpdateLogStreamBody,
  UpdateProjectBody,
  UsageLimitBody,
} from "./api.js";
import {
  ConvexApiError,
  deploymentApi,
  environmentVariablesOf,
  managementApi,
  paged,
  rowsOf,
  statusOf,
} from "./api.js";
import { getCreateConfig } from "./create-config.js";
import { verifyConvexCredentials } from "./preflight.js";
import {
  instance,
  siteUrlOf,
  toCustomDomain,
  toDeployKey,
  toDeployment,
  toLogStream,
  toPreviewKey,
  toProject,
  toUsageLimit,
} from "./mappers.js";
import { renderDetail, renderSidebarItem } from "./render.js";
import { USAGE_METRICS } from "./resource-types.js";

const METRIC_LABELS = new Map(USAGE_METRICS);

/** How long a new deployment's 503 reads as provisioning rather than an outage. */
const PROVISIONING_MS = 15 * 60 * 1000;

/** For a read a team row can do without, such as a count. Part of a list is still an error. */
function orNothing(err: unknown): undefined {
  rethrowIncompleteList(err);
  return undefined;
}

function bool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return value === "true";
}

function required(value: string | undefined, what: string): string {
  const v = (value ?? "").trim();
  if (!v) throw new Error(`Convex plugin: ${what} is required.`);
  return v;
}

/** `a/b/c` → ["a", "b/c"] split at the first slash. */
function head(externalId: string): [string, string] {
  const i = externalId.indexOf("/");
  return i < 0 ? [externalId, ""] : [externalId.slice(0, i), externalId.slice(i + 1)];
}

function listValue(value: string | undefined): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      /* fall through to comma splitting */
    }
  }
  return trimmed
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The document lists a custom role as `{id, name}`; a bare id is read too, and shown as itself. */
type ListedRole = { id: number; name?: string } | number;

function roleId(role: ListedRole): number {
  return typeof role === "number" ? role : role.id;
}

function roleLabel(role: ListedRole): string {
  return typeof role === "number" ? String(role) : role.name || String(role.id);
}

function isoToMs(value: string | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "") return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`Convex plugin: "${value}" is not a date.`);
  return ms;
}

export class ConvexClient implements PluginClient {
  private readonly ctx: ConvexContext;
  private readonly api: ManagementApi;
  private teamIdPromise: Promise<number> | undefined;
  private readonly urls = new Map<string, Promise<string>>();

  constructor(credentials: Credentials, services?: HostServices) {
    const token = (credentials["accessToken"] ?? "").trim();
    if (!token) throw new Error("Convex plugin: missing accessToken credential");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      token,
      ...(services?.http ? { http: services.http } : {}),
      ...(caCert ? { caCert } : {}),
    };
    this.api = managementApi(this.ctx);
  }

  verifyCredentials(): PluginEffect<PreflightResult> {
    return attempt(async () => {
      return verifyConvexCredentials(this.ctx, () => this.teamId());
    });
  }

  /** The token's team, from `GET /token_details` (team tokens only). */
  teamId(): Promise<number> {
    if (!this.teamIdPromise) {
      this.teamIdPromise = this.api.get("/token_details").then((d) => {
        if (d?.type !== "teamToken" || typeof d.teamId !== "number") {
          throw new ConvexApiError(
            400,
            "Convex plugin: this is not a team access token. Create one under Team Settings > Access Tokens.",
          );
        }
        return d.teamId;
      });
      this.teamIdPromise.catch(() => {
        this.teamIdPromise = undefined;
      });
    }
    return this.teamIdPromise;
  }

  private async projects(): Promise<CvProject[]> {
    const team = pathEncode(await this.teamId());
    return paged("/teams/{team_id}/projects", (query) =>
      this.api.get(`/teams/${team}/projects`, { query }),
    );
  }

  private async deployments(): Promise<CvDeployment[]> {
    const team = pathEncode(await this.teamId());
    const all = await paged("/teams/{team_id}/list_deployments", (query) =>
      this.api.get(`/teams/${team}/list_deployments`, { query }),
    );
    return all.filter((d) => d.kind !== "local");
  }

  /** A deployment's own URL for Deployment API calls. */
  private deploymentUrl(name: string): Promise<string> {
    let pending = this.urls.get(name);
    if (!pending) {
      pending = this.getDeployment(name).then(
        (d) => d?.deploymentUrl ?? `https://${name}.convex.cloud`,
      );
      pending.catch(() => this.urls.delete(name));
      this.urls.set(name, pending);
    }
    return pending;
  }

  private remember(deployments: CvDeployment[]): void {
    for (const d of deployments) {
      if (d.deploymentUrl && !this.urls.has(d.name))
        this.urls.set(d.name, Promise.resolve(d.deploymentUrl));
    }
  }

  private getDeployment(name: string): Promise<CvDeployment> {
    return this.api.get(`/deployments/${pathEncode(name)}`);
  }

  /** Make a Deployment API call on a deployment known by name; finding its URL can fail too. */
  private async onDeployment<T>(
    name: string,
    call: (api: DeploymentApi) => Promise<T>,
  ): Promise<T> {
    return call(deploymentApi(this.ctx, await this.deploymentUrl(name)));
  }

  private members(team: string | number) {
    return paged("/teams/{team_id}/list_members", (query) =>
      this.api.get(`/teams/${pathEncode(team)}/list_members`, { query }),
    );
  }

  private invites(team: string | number) {
    return paged("/teams/{team_id}/list_pending_invites", (query) =>
      this.api.get(`/teams/${pathEncode(team)}/list_pending_invites`, { query }),
    );
  }

  private customRoles(team: string | number) {
    return paged("/teams/{team_id}/list_custom_roles", (query) =>
      this.api.get(`/teams/${pathEncode(team)}/list_custom_roles`, { query }),
    );
  }

  private accessTokens(team: string | number) {
    return paged("/teams/{team_id}/list_access_tokens", (query) =>
      this.api.get(`/teams/${pathEncode(team)}/list_access_tokens`, { query }),
    );
  }

  /**
   * Run `fn` for every deployment, skipping one that was deleted (a 404) or has
   * only just been created and is still provisioning (a 503). Other errors fail the
   * listing, a 503 from an established deployment included: it has rows a sync would
   * prune, so an outage must leave them alone.
   */
  private async perDeployment<T>(
    only: CvDeployment[] | undefined,
    fn: (d: CvDeployment) => Promise<T[]>,
  ): Promise<T[]> {
    const deployments = only ?? (await this.deployments());
    this.remember(deployments);
    const lists = await Promise.all(
      deployments.map(async (d) => {
        try {
          return await fn(d);
        } catch (err) {
          const status = statusOf(err);
          if (status === 404) return [];
          if (status === 503 && Date.now() - d.createTime < PROVISIONING_MS) return [];
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

  /** `only` restricts deployment-scoped types to the given deployments. */
  private async list(
    typeId: string,
    accountId: string,
    only?: CvDeployment[],
  ): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "convex-team":
        return [await this.teamResource(accountId)];
      case "convex-project":
        return (await this.projects()).map((p) => toProject(p, accountId));
      case "convex-deployment": {
        const [deployments, projects] = await Promise.all([this.deployments(), this.projects()]);
        this.remember(deployments);
        const slugs = new Map(projects.map((p) => [p.id, p.slug]));
        return deployments.map((d) => toDeployment(d, accountId, slugs.get(d.projectId)));
      }
      case "convex-env-var":
        return this.perDeployment(only, async (d) => {
          const res = await deploymentApi(
            this.ctx,
            d.deploymentUrl ?? `https://${d.name}.convex.cloud`,
          ).get("/list_environment_variables");
          return Object.keys(environmentVariablesOf(res))
            .sort()
            .map((name) =>
              instance(
                accountId,
                typeId,
                `${d.name}/${name}`,
                name,
                { name, deploymentName: d.name },
                {
                  parentTypeId: "convex-deployment",
                  parentExternalId: d.name,
                },
              ),
            );
        });
      case "convex-default-env-var": {
        const projects = await this.projects();
        const lists = await Promise.all(
          projects.map(async (p) => {
            const vars = await paged(
              "/projects/{project_id}/list_default_environment_variables",
              (query) =>
                this.api.get(`/projects/${pathEncode(p.id)}/list_default_environment_variables`, {
                  query,
                }),
            );
            return vars.flatMap((v) =>
              v.deploymentTypes.map((t) =>
                instance(
                  accountId,
                  typeId,
                  `${p.id}/${t}/${v.name}`,
                  `${v.name} (${t})`,
                  { name: v.name, projectId: p.id, deploymentType: t },
                  { parentTypeId: "convex-project", parentExternalId: String(p.id) },
                ),
              ),
            );
          }),
        );
        return lists.flat();
      }
      case "convex-deploy-key":
        return this.perDeployment(only, async (d) =>
          rowsOf(
            await this.api.get(`/deployments/${pathEncode(d.name)}/list_deploy_keys`),
            "/deployments/{deployment_name}/list_deploy_keys",
            null,
          ).map((k) => toDeployKey(k, d.name, accountId)),
        );
      case "convex-preview-deploy-key": {
        const projects = await this.projects();
        const lists = await Promise.all(
          projects.map(async (p) => {
            const res = await this.api.get(
              `/projects/${pathEncode(p.id)}/list_preview_deploy_keys`,
              {
                query: { includeManaged: true },
              },
            );
            return rowsOf(
              res?.items,
              "/projects/{project_id}/list_preview_deploy_keys",
              "items",
              res,
            ).map((k) => toPreviewKey(k, p.id, accountId));
          }),
        );
        return lists.flat();
      }
      case "convex-custom-domain":
        return this.perDeployment(only, async (d) => {
          const res = await this.api.get(`/deployments/${pathEncode(d.name)}/custom_domains`);
          return rowsOf(
            res?.domains,
            "/deployments/{deployment_name}/custom_domains",
            "domains",
            res,
          ).map((cd) => toCustomDomain(cd, accountId));
        });
      case "convex-log-stream":
        return this.perDeployment(only, async (d) =>
          rowsOf(
            await deploymentApi(this.ctx, d.deploymentUrl ?? `https://${d.name}.convex.cloud`).get(
              "/list_log_streams",
            ),
            "/list_log_streams",
            null,
          ).map((s) => toLogStream(s, d.name, accountId)),
        );
      case "convex-usage-limit":
        return this.perDeployment(only, async (d) => {
          const api = deploymentApi(this.ctx, d.deploymentUrl ?? `https://${d.name}.convex.cloud`);
          const res = await api.get("/list_usage_limits");
          const limits = rowsOf(res?.usageLimits, "/list_usage_limits", "usageLimits", res);
          if (limits.length === 0) return [];
          const usage = await api.get("/get_current_usage").catch(() => undefined);
          return limits.map((l) => toUsageLimit(l, d.name, accountId, usage));
        });
      case "convex-member": {
        const teamId = await this.teamId();
        const members = await this.members(teamId);
        return members.map((m) =>
          instance(
            accountId,
            typeId,
            `${teamId}/${m.id}`,
            m.name || m.email,
            {
              email: m.email,
              name: m.name ?? "",
              role: m.role,
              customRoles: (m.customRoles ?? []).map(roleLabel).join(", "),
            },
            { parentTypeId: "convex-team", parentExternalId: String(teamId) },
          ),
        );
      }
      case "convex-invite": {
        const teamId = await this.teamId();
        const invites = await this.invites(teamId);
        return invites.map((i) =>
          instance(
            accountId,
            typeId,
            `${teamId}/${i.email}`,
            i.email,
            { email: i.email, role: i.role, expired: i.expired },
            { parentTypeId: "convex-team", parentExternalId: String(teamId) },
          ),
        );
      }
      case "convex-custom-role": {
        const teamId = await this.teamId();
        const roles = await this.customRoles(teamId);
        return roles.map((r) =>
          instance(
            accountId,
            typeId,
            `${teamId}/${r.id}`,
            r.name,
            {
              name: r.name,
              description: r.description ?? "",
              statementCount: r.statements.length,
              statements: JSON.stringify(r.statements),
              createdAt: new Date(r.createTime).toISOString(),
            },
            { parentTypeId: "convex-team", parentExternalId: String(teamId) },
          ),
        );
      }
      case "convex-access-token": {
        const teamId = await this.teamId();
        const tokens = await this.accessTokens(teamId);
        return tokens.map((t) =>
          instance(
            accountId,
            typeId,
            `${teamId}/${t.id}`,
            t.name,
            {
              name: t.name,
              createdAt: new Date(t.creationTime).toISOString(),
              lastUsedAt: t.lastUsedTime ? new Date(t.lastUsedTime).toISOString() : "",
              expiresAt: t.expiresAt ? new Date(t.expiresAt).toISOString() : "",
            },
            { parentTypeId: "convex-team", parentExternalId: String(teamId) },
          ),
        );
      }
      default:
        throw new Error(`Convex plugin: unknown resource type "${typeId}"`);
    }
  }

  private async teamResource(accountId: string): Promise<ResourceInstance> {
    const teamId = await this.teamId();
    const [projects, members, invites] = await Promise.all([
      this.projects(),
      this.members(teamId).catch(orNothing),
      this.invites(teamId).catch(orNothing),
    ]);
    const slug = projects[0]?.teamSlug ?? "";
    return instance(accountId, "convex-team", String(teamId), slug || `Team ${teamId}`, {
      teamId,
      slug,
      projectCount: projects.length,
      ...(members
        ? {
            memberCount: members.length,
            adminCount: members.filter((m) => m.role === "admin").length,
          }
        : {}),
      ...(invites ? { pendingInvites: invites.filter((i) => !i.expired).length } : {}),
    });
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const externalId = externalIdOf(resourceId);
      if (typeId === "convex-project") {
        return toProject(await this.api.get(`/projects/${pathEncode(externalId)}`), accountId);
      }
      if (typeId === "convex-deployment") {
        const d = await this.getDeployment(externalId);
        const project = await this.api
          .get(`/projects/${pathEncode(d.projectId)}`)
          .catch(() => undefined);
        this.remember([d]);
        return toDeployment(d, accountId, project?.slug);
      }
      // Deployment-scoped children: list just that deployment's.
      const deploymentScoped = new Set([
        "convex-env-var",
        "convex-deploy-key",
        "convex-custom-domain",
        "convex-log-stream",
        "convex-usage-limit",
      ]);
      let all: ResourceInstance[];
      if (deploymentScoped.has(typeId)) {
        const [name] = head(externalId);
        const d = await this.getDeployment(name);
        all = await this.list(typeId, accountId, [d]);
      } else {
        all = await this.list(typeId, accountId);
      }
      const found = all.find((r) => r.id === resourceId);
      if (!found) throw new ConvexApiError(404, `Convex plugin: ${typeId}/${externalId} not found`);
      return found;
    });
  }

  // ---- outputs ---------------------------------------------------------------------

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    _accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      const externalId = externalIdOf(resourceId);
      const [first, rest] = head(externalId);
      switch (`${typeId}.${outputKey}`) {
        case "convex-team.teamId":
          return externalId;
        case "convex-team.slug":
          return (await this.projects())[0]?.teamSlug ?? "";
        case "convex-project.projectId":
          return externalId;
        case "convex-project.slug":
          return (await this.api.get(`/projects/${pathEncode(externalId)}`)).slug;
        case "convex-deployment.deploymentName":
          return externalId;
        case "convex-deployment.deploymentUrl":
          return this.deploymentUrl(externalId);
        case "convex-deployment.siteUrl": {
          const urls = await this.onDeployment(externalId, (api) =>
            api.get("/get_canonical_urls"),
          ).catch(() => undefined);
          return urls?.convexSiteUrl || siteUrlOf(await this.deploymentUrl(externalId));
        }
        case "convex-env-var.value": {
          const res = await this.onDeployment(first, (api) =>
            api.get("/list_environment_variables"),
          );
          const value = res?.environmentVariables?.[rest];
          if (value === undefined)
            throw new ConvexApiError(404, `Convex plugin: ${rest} is not set.`);
          return value;
        }
        case "convex-default-env-var.value": {
          const [type, name] = head(rest);
          const vars = await paged(
            "/projects/{project_id}/list_default_environment_variables",
            (paging) =>
              this.api.get(`/projects/${pathEncode(first)}/list_default_environment_variables`, {
                query: { ...(name ? { name } : {}), ...paging },
              }),
          );
          const match = vars.find((v) => v.name === name && v.deploymentTypes.includes(type));
          if (!match)
            throw new ConvexApiError(404, `Convex plugin: ${name} is not set for ${type}.`);
          return match.value;
        }
        case "convex-custom-domain.url":
          return `https://${rest.split("/").slice(1).join("/")}`;
        case "convex-deploy-key.deployKey":
        case "convex-preview-deploy-key.previewDeployKey":
          throw new Error(
            "Convex shows a deploy key only when it is created. Create a new key to get a fresh value.",
          );
        case "convex-log-stream.hmacSecret": {
          const stream: CvLogStream = await this.onDeployment(first, (api) =>
            api.get(`/get_log_stream/${pathEncode(rest)}`),
          );
          const secret = stream?.hmacSecret;
          if (typeof secret !== "string")
            throw new Error("Convex plugin: only webhook streams have a secret.");
          return secret;
        }
      }
      throw new Error(`Convex plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
    });
  }

  // ---- detail views ---------------------------------------------------------------

  enrichDetail(resource: ResourceInstance): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      if (resource.resourceTypeId !== "convex-deployment") return resource;
      const name = String(resource.externalId ?? "");
      const [usage, urls] = await Promise.all([
        this.onDeployment(name, (api) => api.get("/get_current_usage")).catch(() => undefined),
        this.onDeployment(name, (api) => api.get("/get_canonical_urls")).catch(() => undefined),
      ]);
      const fields = { ...resource.fields };
      if (usage) fields["_usage"] = JSON.stringify(usage);
      if (urls?.convexSiteUrl) fields["siteUrl"] = urls.convexSiteUrl;
      if (urls?.convexCloudUrl) fields["canonicalCloudUrl"] = urls.convexCloudUrl;
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
      if (resourceTypeId !== "convex-deployment") return [];
      const r = await runPluginEffect(this.getResource(resourceTypeId, resourceId, accountId));
      return [
        { label: "Type", value: String(r.fields["deploymentType"] ?? "") },
        { label: "Region", value: String(r.fields["region"] ?? "") },
        {
          label: "Last deploy",
          value: String(r.fields["lastDeployAt"] ?? "").slice(0, 10) || "never",
        },
      ];
    });
  }

  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      if (resourceTypeId !== "convex-deployment") return [];
      const usage = await this.onDeployment(externalIdOf(resourceId), (api) =>
        api.get("/get_current_usage"),
      );
      const now = Date.now();
      const series: MetricSeries[] = [];
      for (const [metric, value] of Object.entries(usage?.metrics ?? {})) {
        const label = METRIC_LABELS.get(metric) ?? metric;
        series.push(
          {
            label: `${label}, today`,
            unit: value.unit,
            points: [{ timestamp: now, value: value.usage.current_day }],
          },
          {
            label: `${label}, month to date`,
            unit: value.unit,
            points: [{ timestamp: now, value: value.usage.current_month }],
          },
        );
      }
      return series;
    });
  }

  /**
   * Each enabled usage limit against the deployment's current usage for that
   * metric and window. Both halves come from the Deployment API.
   */
  fetchQuotas(_accountId: string): PluginEffect<QuotaUsage[]> {
    return attempt(async () => {
      const readings = await this.perDeployment(undefined, async (d) => {
        const api = deploymentApi(this.ctx, d.deploymentUrl ?? `https://${d.name}.convex.cloud`);
        const res = await api.get("/list_usage_limits");
        const limits = rowsOf(res?.usageLimits, "/list_usage_limits", "usageLimits", res).filter(
          (l) => l.enabled,
        );
        if (limits.length === 0) return [];
        const usage = await api.get("/get_current_usage");
        return limits.flatMap((l): QuotaUsage[] => {
          const m = usage?.metrics?.[l.metric];
          if (!m) return [];
          return [
            {
              id: `${d.name}/${l.id}`,
              service: "usage-limits",
              name: `${METRIC_LABELS.get(l.metric) ?? l.metric} per ${l.window} (${d.name}, ${l.limitType})`,
              ...(d.region ? { region: d.region } : {}),
              limit: l.limit,
              used: l.window === "day" ? m.usage.current_day : m.usage.current_month,
              unit: m.unit,
              adjustable: true,
              docsUrl: "https://docs.convex.dev/production/state/limits",
            },
          ];
        });
      });
      return readings;
    });
  }

  // ---- create / update / delete ----------------------------------------------------

  getCreateConfig(typeId: string, parentResourceId?: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      return getCreateConfig(
        {
          teamId: () => this.teamId(),
          projects: () => this.projects(),
          deployments: () => this.deployments(),
          api: this.api,
        },
        typeId,
        parentResourceId,
      );
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
      const deploymentName = () => required(parent || fields["deploymentName"], "a deployment");
      const projectId = () => required(parent || fields["projectId"], "a project");

      switch (typeId) {
        case "convex-project": {
          const created = await this.api.post(
            `/teams/${pathEncode(await this.teamId())}/create_project`,
            {
              body: {
                projectName: required(fields["name"], "a project name"),
                ...(fields["deploymentType"] ? { deploymentType: fields["deploymentType"] } : {}),
                ...(fields["deploymentType"] && fields["region"]
                  ? { deploymentRegion: fields["region"] }
                  : {}),
                ...(fields["deploymentType"] && fields["class"]
                  ? { deploymentClass: fields["class"] }
                  : {}),
              },
            },
          );
          return runPluginEffect(
            this.getResource(typeId, `${accountId}:${typeId}:${created.projectId}`, accountId),
          );
        }
        case "convex-deployment": {
          const d = await this.api.post(`/projects/${pathEncode(projectId())}/create_deployment`, {
            body: {
              type: fields["deploymentType"] || "dev",
              ...(fields["region"] ? { region: fields["region"] } : {}),
              ...(fields["class"] ? { class: fields["class"] } : {}),
              ...(fields["reference"] ? { reference: fields["reference"] } : {}),
              ...(bool(fields["isDefault"]) !== undefined
                ? { isDefault: bool(fields["isDefault"]) }
                : {}),
              ...(fields["expiresAt"] ? { expiresAt: isoToMs(fields["expiresAt"]) } : {}),
            },
          });
          this.remember([d]);
          return toDeployment(d, accountId);
        }
        case "convex-env-var": {
          const name = required(fields["name"], "a name");
          const dep = deploymentName();
          const changes = [{ name, value: required(fields["value"], "a value") }];
          await this.onDeployment(dep, (api) =>
            api.post("/update_environment_variables", { body: { changes } }),
          );
          return instance(
            accountId,
            typeId,
            `${dep}/${name}`,
            name,
            { name, deploymentName: dep },
            {
              parentTypeId: "convex-deployment",
              parentExternalId: dep,
            },
          );
        }
        case "convex-default-env-var": {
          const name = required(fields["name"], "a name");
          const pid = projectId();
          const types = listValue(fields["deploymentTypes"]);
          if (types.length === 0)
            throw new Error("Convex plugin: pick at least one deployment type.");
          const value = required(fields["value"], "a value");
          await this.api.post(`/projects/${pathEncode(pid)}/update_default_environment_variables`, {
            body: { changes: types.map((t) => ({ name, deploymentType: t, value })) },
          });
          return instance(
            accountId,
            typeId,
            `${pid}/${types[0]}/${name}`,
            `${name} (${types[0]})`,
            { name, projectId: Number(pid), deploymentType: types[0]! },
            { parentTypeId: "convex-project", parentExternalId: pid },
          );
        }
        case "convex-deploy-key": {
          const dep = deploymentName();
          const name = required(fields["name"], "a name");
          const actions = listValue(fields["allowedActions"]);
          const res = await this.api.post(`/deployments/${pathEncode(dep)}/create_deploy_key`, {
            body: {
              name,
              ...(actions.length ? { allowedActions: actions } : {}),
              ...(fields["expiresAt"] ? { expiresAt: isoToMs(fields["expiresAt"]) } : {}),
            },
          });
          // The create call holds the only copy of the secret, so a failed read can't lose it.
          const key = await this.api
            .get(`/deployments/${pathEncode(dep)}/list_deploy_keys`)
            .then((keys) =>
              newestNamed(
                rowsOf(keys, "/deployments/{deployment_name}/list_deploy_keys", null),
                name,
              ),
            )
            .catch(() => undefined);
          const resource = key
            ? toDeployKey(key, dep, accountId)
            : instance(accountId, typeId, `${dep}/${name}`, name, { name, deploymentName: dep });
          resource.resolvedOutputs["deployKey"] = res.deployKey;
          return resource;
        }
        case "convex-preview-deploy-key": {
          const pid = projectId();
          const name = required(fields["name"], "a name");
          const res = await this.api.post(
            `/projects/${pathEncode(pid)}/create_preview_deploy_key`,
            {
              body: {
                name,
                ...(fields["expiresAt"] ? { expiresAt: isoToMs(fields["expiresAt"]) } : {}),
              },
            },
          );
          // The create call holds the only copy of the secret, so a failed read can't lose it.
          const key = await this.api
            .get(`/projects/${pathEncode(pid)}/list_preview_deploy_keys`)
            .then((list) =>
              newestNamed(
                rowsOf(
                  list?.items,
                  "/projects/{project_id}/list_preview_deploy_keys",
                  "items",
                  list,
                ),
                name,
              ),
            )
            .catch(() => undefined);
          const resource = key
            ? toPreviewKey(key, Number(pid), accountId)
            : instance(accountId, typeId, `${pid}/${name}`, name, { name, projectId: Number(pid) });
          resource.resolvedOutputs["previewDeployKey"] = res.previewDeployKey;
          return resource;
        }
        case "convex-custom-domain": {
          const dep = deploymentName();
          const domain = required(fields["domain"], "a domain").toLowerCase();
          const requestDestination =
            fields["requestDestination"] === "convexSite" ? "convexSite" : "convexCloud";
          await this.api.post(`/deployments/${pathEncode(dep)}/create_custom_domain`, {
            body: { domain, requestDestination },
          });
          return toCustomDomain(
            { domain, deploymentName: dep, requestDestination, creationTime: Date.now() },
            accountId,
          );
        }
        case "convex-log-stream": {
          const dep = deploymentName();
          const body = logStreamBody(fields);
          const res: CvCreatedLogStream = await this.onDeployment(dep, (api) =>
            api.post("/create_log_stream", { body }),
          );
          const created = await runPluginEffect(
            this.getResource(typeId, `${accountId}:${typeId}:${dep}/${res.id}`, accountId),
          ).catch(() =>
            instance(accountId, typeId, `${dep}/${res.id}`, String(body.logStreamType), {
              streamType: String(body.logStreamType),
              deploymentName: dep,
            }),
          );
          if (res.hmacSecret) created.resolvedOutputs["hmacSecret"] = res.hmacSecret;
          return created;
        }
        case "convex-usage-limit": {
          const dep = deploymentName();
          const body = usageLimitBody(fields);
          const res = await this.onDeployment(dep, (api) =>
            api.post("/create_usage_limit", { body }),
          );
          return toUsageLimit(res.usageLimit, dep, accountId);
        }
        case "convex-invite": {
          const teamId = await this.teamId();
          const email = required(fields["email"], "an email");
          await this.api.post(`/teams/${pathEncode(teamId)}/invite_team_member`, {
            body: { email, role: fields["role"] === "admin" ? "admin" : "developer" },
          });
          return instance(
            accountId,
            typeId,
            `${teamId}/${email}`,
            email,
            {
              email,
              role: fields["role"] || "developer",
              expired: false,
            },
            { parentTypeId: "convex-team", parentExternalId: String(teamId) },
          );
        }
        case "convex-custom-role": {
          const teamId = await this.teamId();
          const actions = listValue(fields["actions"]);
          if (actions.length === 0) throw new Error("Convex plugin: pick at least one permission.");
          const role = await this.api.post(`/teams/${pathEncode(teamId)}/create_custom_role`, {
            body: {
              name: required(fields["name"], "a name"),
              ...(fields["description"] ? { description: fields["description"] } : {}),
              statements: [
                {
                  effect: fields["effect"] === "deny" ? "deny" : "allow",
                  actions,
                  resource: fields["resource"] || "project:*",
                },
              ],
            },
          });
          return instance(
            accountId,
            typeId,
            `${teamId}/${role.id}`,
            role.name,
            {
              name: role.name,
              description: role.description ?? "",
              statementCount: role.statements.length,
              statements: JSON.stringify(role.statements),
              createdAt: new Date(role.createTime).toISOString(),
            },
            { parentTypeId: "convex-team", parentExternalId: String(teamId) },
          );
        }
        default:
          throw new Error(`Convex plugin: cannot create "${typeId}".`);
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
      const [first, rest] = head(externalId);
      switch (typeId) {
        case "convex-project": {
          const body: UpdateProjectBody = {};
          if (fields["name"]) body["name"] = fields["name"];
          if (fields["slug"]) body["slug"] = fields["slug"];
          return toProject(
            await this.api.patch(`/projects/${pathEncode(externalId)}`, { body }),
            accountId,
          );
        }
        case "convex-deployment": {
          const body: UpdateDeploymentBody = {};
          if (fields["deploymentType"]) body["deploymentType"] = fields["deploymentType"];
          if (fields["class"]) body["class"] = fields["class"];
          if (fields["reference"]) body["reference"] = fields["reference"];
          for (const key of [
            "isDefault",
            "dashboardEditConfirmation",
            "sendLogsToClient",
          ] as const) {
            const v = bool(fields[key]);
            if (v !== undefined) body[key] = v;
          }
          const expires = isoToMs(fields["expiresAt"]);
          if (expires !== undefined) body["expiresAt"] = expires;
          await this.api.patch(`/deployments/${pathEncode(externalId)}`, { body });
          break;
        }
        case "convex-env-var":
          if (fields["value"]) {
            const changes = [{ name: rest, value: fields["value"] }];
            await this.onDeployment(first, (api) =>
              api.post("/update_environment_variables", { body: { changes } }),
            );
          }
          break;
        case "convex-default-env-var":
          if (fields["value"]) {
            const [type, name] = head(rest);
            await this.api.post(
              `/projects/${pathEncode(first)}/update_default_environment_variables`,
              { body: { changes: [{ name, deploymentType: type, value: fields["value"] }] } },
            );
          }
          break;
        case "convex-log-stream": {
          const current = await this.onDeployment(first, (api) =>
            api.get(`/get_log_stream/${pathEncode(rest)}`),
          );
          const body: UpdateLogStreamBody = { logStreamType: current.logStreamType };
          if (fields["url"]) body["url"] = fields["url"];
          if (fields["format"]) body["format"] = fields["format"];
          if (fields["service"] !== undefined) body["service"] = fields["service"] || null;
          if (fields["datasetName"]) body["datasetName"] = fields["datasetName"];
          await this.onDeployment(first, (api) =>
            api.post(`/update_log_stream/${pathEncode(rest)}`, { body }),
          );
          break;
        }
        case "convex-usage-limit": {
          const res = await this.onDeployment(first, (api) => api.get("/list_usage_limits"));
          const current = rowsOf(res?.usageLimits, "/list_usage_limits", "usageLimits", res).find(
            (l) => l.id === rest,
          );
          if (!current)
            throw new ConvexApiError(404, "Convex plugin: the usage limit no longer exists.");
          // Update replaces the whole config, so unchanged values are carried over.
          const body = usageLimitBody({
            metric: fields["metric"] || current.metric,
            window: fields["window"] || current.window,
            limitType: fields["limitType"] || current.limitType,
            limit: fields["limit"] || String(current.limit),
            enabled: fields["enabled"] || String(current.enabled),
          });
          await this.onDeployment(first, (api) =>
            api.post(`/update_usage_limit/${pathEncode(rest)}`, { body }),
          );
          break;
        }
        case "convex-member":
          if (fields["role"]) {
            await this.api.post(`/teams/${pathEncode(first)}/update_team_member_role`, {
              body: { memberId: Number(rest), role: fields["role"] },
            });
          }
          break;
        case "convex-custom-role": {
          const roles = await this.customRoles(first);
          const current = roles.find((r) => String(r.id) === rest);
          if (!current) throw new ConvexApiError(404, "Convex plugin: the role no longer exists.");
          await this.api.post(`/teams/${pathEncode(first)}/update_custom_role`, {
            body: {
              id: current.id,
              name: fields["name"] || current.name,
              description: fields["description"] ?? current.description ?? null,
              statements: current.statements,
            },
          });
          break;
        }
        default:
          throw new Error(`Convex plugin: cannot update "${typeId}".`);
      }
      return runPluginEffect(this.getResource(typeId, resourceId, accountId));
    });
  }

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const externalId = externalIdOf(resourceId);
      const [first, rest] = head(externalId);
      switch (typeId) {
        case "convex-project":
          await this.api.post(`/projects/${pathEncode(externalId)}/delete`);
          return;
        case "convex-deployment":
          await this.api.post(`/deployments/${pathEncode(externalId)}/delete`);
          return;
        case "convex-env-var":
          await this.onDeployment(first, (api) =>
            api.post("/update_environment_variables", {
              body: { changes: [{ name: rest, value: null }] },
            }),
          );
          return;
        case "convex-default-env-var": {
          const [type, name] = head(rest);
          await this.api.post(
            `/projects/${pathEncode(first)}/update_default_environment_variables`,
            { body: { changes: [{ name, deploymentType: type, value: null }] } },
          );
          return;
        }
        case "convex-deploy-key": {
          const key = findKeyName(
            rowsOf(
              await this.api.get(`/deployments/${pathEncode(first)}/list_deploy_keys`),
              "/deployments/{deployment_name}/list_deploy_keys",
              null,
            ),
            rest,
          );
          await this.api.post(`/deployments/${pathEncode(first)}/delete_deploy_key`, {
            body: { id: key },
          });
          return;
        }
        case "convex-preview-deploy-key": {
          const res = await this.api.get(
            `/projects/${pathEncode(first)}/list_preview_deploy_keys`,
            {
              query: { includeManaged: true },
            },
          );
          const key = findKeyName(
            rowsOf(res?.items, "/projects/{project_id}/list_preview_deploy_keys", "items", res),
            rest,
          );
          await this.api.post(`/projects/${pathEncode(first)}/delete_preview_deploy_key`, {
            body: { id: key },
          });
          return;
        }
        case "convex-custom-domain": {
          const [destination, domain] = head(rest);
          await this.api.post(`/deployments/${pathEncode(first)}/delete_custom_domain`, {
            body: { domain, requestDestination: destination },
          });
          return;
        }
        case "convex-log-stream":
          await this.onDeployment(first, (api) =>
            api.post(`/delete_log_stream/${pathEncode(rest)}`),
          );
          return;
        case "convex-usage-limit":
          await this.onDeployment(first, (api) =>
            api.post(`/delete_usage_limit/${pathEncode(rest)}`),
          );
          return;
        case "convex-invite":
          await this.api.post(`/teams/${pathEncode(first)}/cancel_team_member_invite`, {
            body: { email: rest },
          });
          return;
        case "convex-custom-role":
          await this.api.post(`/teams/${pathEncode(first)}/delete_custom_role`, {
            body: { id: Number(rest) },
          });
          return;
        case "convex-access-token": {
          const tokens = await this.accessTokens(first);
          const token = tokens.find((t) => String(t.id) === rest);
          if (!token) throw new ConvexApiError(404, "Convex plugin: the token no longer exists.");
          await this.api.post(`/teams/${pathEncode(first)}/delete_access_token`, {
            body: { id: token.name },
          });
          return;
        }
        default:
          throw new Error(`Convex plugin: "${typeId}" cannot be deleted.`);
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
      if (typeId === "convex-deployment" && (actionId === "pause" || actionId === "unpause")) {
        await this.onDeployment(externalId, (api) =>
          actionId === "pause" ? api.post("/pause_deployment") : api.post("/unpause_deployment"),
        );
        return;
      }
      if (typeId === "convex-log-stream" && actionId === "rotate-secret") {
        const [dep, id] = head(externalId);
        await this.onDeployment(dep, (api) => api.post(`/rotate_webhook_secret/${pathEncode(id)}`));
        return;
      }
      if (typeId === "convex-invite" && actionId === "resend") {
        const [teamId, email] = head(externalId);
        const invites = await this.invites(teamId);
        const invite = invites.find((i) => i.email === email);
        // Resending is a cancel and then a new invite, so everything the new one
        // needs is settled before the old one goes.
        if (!invite)
          throw new ConvexApiError(
            404,
            `Convex plugin: the invite to ${email} is no longer pending.`,
          );
        const customRoles = (invite.customRoles ?? []).map(roleId);
        if (invite.role === "custom" && customRoles.length === 0)
          throw new Error(
            `Convex plugin: the invite to ${email} has no custom roles to send again, so it was left as it is.`,
          );
        await this.api.post(`/teams/${pathEncode(teamId)}/cancel_team_member_invite`, {
          body: { email },
        });
        await this.api
          .post(`/teams/${pathEncode(teamId)}/invite_team_member`, {
            body: {
              email,
              role: invite.role,
              ...(invite.role === "custom" ? { customRoles } : {}),
            },
          })
          .catch((err: unknown) => {
            const why = err instanceof Error ? err.message : String(err);
            throw new ConvexApiError(
              statusOf(err),
              `Convex plugin: the invite to ${email} was cancelled but could not be sent again, so they need inviting again. ${why}`,
            );
          });
        return;
      }
      throw new Error(`Convex plugin: unknown action "${actionId}" for "${typeId}".`);
    });
  }
}

/** The key just created: names can repeat, so the most recent one with that name. */
function newestNamed(keys: CvDeployKey[], name: string): CvDeployKey | undefined {
  return keys.filter((k) => k.name === name).sort((a, b) => b.creationTime - a.creationTime)[0];
}

/** Deploy keys are deleted by name (or secret); our ids are numeric. */
function findKeyName(keys: CvDeployKey[], id: string): string {
  const key = keys.find((k) => String(k.id) === id);
  if (!key) throw new ConvexApiError(404, "Convex plugin: the deploy key no longer exists.");
  return key.name;
}

/** Create-form fields → a `create_log_stream` body for the chosen destination. */
export function logStreamBody(fields: Record<string, string>): CreateLogStreamBody {
  const type = fields["streamType"] || "webhook";
  const topics = listValue(fields["topics"]);
  const withTopics = topics.length ? { topics } : {};
  switch (type) {
    case "webhook":
      return {
        logStreamType: type,
        url: required(fields["url"], "a URL"),
        format: fields["format"] || "jsonl",
        ...withTopics,
      };
    case "datadog":
      return {
        logStreamType: type,
        siteLocation: fields["siteLocation"] || "US1",
        ddApiKey: required(fields["apiKey"], "a Datadog API key"),
        ddTags: listValue(fields["tags"]),
        ...(fields["service"] ? { service: fields["service"] } : {}),
        ...withTopics,
      };
    case "axiom":
      return {
        logStreamType: type,
        apiKey: required(fields["apiKey"], "an Axiom API key"),
        datasetName: required(fields["datasetName"], "a dataset"),
        attributes: [],
        ...(fields["ingestUrl"] ? { ingestUrl: fields["ingestUrl"] } : {}),
        ...withTopics,
      };
    case "sentry":
      return { logStreamType: type, dsn: required(fields["dsn"], "a Sentry DSN") };
    case "postHogLogs":
      return {
        logStreamType: type,
        apiKey: required(fields["apiKey"], "a PostHog project token"),
        ...(fields["host"] ? { host: fields["host"] } : {}),
        ...withTopics,
      };
    case "postHogErrorTracking":
      return {
        logStreamType: type,
        apiKey: required(fields["apiKey"], "a PostHog project token"),
        ...(fields["host"] ? { host: fields["host"] } : {}),
      };
    default:
      throw new Error(`Convex plugin: unsupported log stream type "${type}".`);
  }
}

export function usageLimitBody(fields: Record<string, string>): UsageLimitBody {
  const limit = Number(required(fields["limit"], "a limit"));
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error("Convex plugin: the limit must be a whole number of at least 1.");
  return {
    metric: required(fields["metric"], "a metric"),
    window: fields["window"] === "day" ? "day" : "month",
    limitType: fields["limitType"] === "disable" ? "disable" : "warning",
    limit,
    enabled: fields["enabled"] !== "false",
  };
}
