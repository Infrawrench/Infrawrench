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
import { externalIdOf } from "@infrawrench/plugin-base";
import type {
  ConvexContext,
  CvAccessToken,
  CvCustomDomain,
  CvCustomRole,
  CvDefaultEnvVar,
  CvDeployKey,
  CvDeployment,
  CvInvite,
  CvLogStream,
  CvMember,
  CvProject,
  CvTokenDetails,
  CvUsage,
  CvUsageLimit,
  DeploymentType,
} from "./api.js";
import { ConvexApiError, deploymentApi, enc, mgmt, paged, statusOf } from "./api.js";
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
      const parsed = JSON.parse(trimmed) as unknown;
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

function isoToMs(value: string | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "") return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`Convex plugin: "${value}" is not a date.`);
  return ms;
}

export class ConvexClient implements PluginClient {
  private readonly ctx: ConvexContext;
  private teamIdPromise: Promise<number> | undefined;
  private readonly urls = new Map<string, Promise<string>>();

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const token = (credentials["accessToken"] ?? "").trim();
    if (!token) throw new Error("Convex plugin: missing accessToken credential");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      token,
      ...(services?.http ? { http: services.http } : {}),
      ...(caCert ? { caCert } : {}),
    };
  }

  verifyCredentials(): Promise<PreflightResult> {
    return verifyConvexCredentials(this.ctx, () => this.teamId());
  }

  /** The token's team, from `GET /token_details` (team tokens only). */
  teamId(): Promise<number> {
    if (!this.teamIdPromise) {
      this.teamIdPromise = mgmt<CvTokenDetails>(this.ctx, "GET", "/token_details").then((d) => {
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
    return paged<CvProject>(this.ctx, `/teams/${enc(await this.teamId())}/projects`);
  }

  private async deployments(): Promise<CvDeployment[]> {
    const all = await paged<CvDeployment>(
      this.ctx,
      `/teams/${enc(await this.teamId())}/list_deployments`,
    );
    return all.filter((d) => d.kind !== "local");
  }

  /** A deployment's own URL for Deployment API calls. */
  private deploymentUrl(name: string): Promise<string> {
    let pending = this.urls.get(name);
    if (!pending) {
      pending = mgmt<CvDeployment>(this.ctx, "GET", `/deployments/${enc(name)}`).then(
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

  private async dApi<T>(name: string, method: string, path: string, body?: unknown): Promise<T> {
    return deploymentApi<T>(this.ctx, await this.deploymentUrl(name), method, path, body);
  }

  /**
   * Run `fn` for every deployment, skipping ones the Deployment API cannot
   * reach right now (a 404 for a deleted preview, or a deployment that is
   * still provisioning). Other errors fail the listing.
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
          if ([404, 503].includes(statusOf(err))) return [];
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
          const res = await deploymentApi<{ environmentVariables?: Record<string, string> }>(
            this.ctx,
            d.deploymentUrl ?? `https://${d.name}.convex.cloud`,
            "GET",
            "/list_environment_variables",
          );
          return Object.keys(res?.environmentVariables ?? {})
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
            const vars = await paged<CvDefaultEnvVar>(
              this.ctx,
              `/projects/${enc(p.id)}/list_default_environment_variables`,
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
          (
            (await mgmt<CvDeployKey[]>(
              this.ctx,
              "GET",
              `/deployments/${enc(d.name)}/list_deploy_keys`,
            )) ?? []
          ).map((k) => toDeployKey(k, d.name, accountId)),
        );
      case "convex-preview-deploy-key": {
        const projects = await this.projects();
        const lists = await Promise.all(
          projects.map(async (p) => {
            const res = await mgmt<{ items?: CvDeployKey[] }>(
              this.ctx,
              "GET",
              `/projects/${enc(p.id)}/list_preview_deploy_keys`,
              undefined,
              { includeManaged: true },
            );
            return (res?.items ?? []).map((k) => toPreviewKey(k, p.id, accountId));
          }),
        );
        return lists.flat();
      }
      case "convex-custom-domain":
        return this.perDeployment(only, async (d) =>
          (
            (
              await mgmt<{ domains?: CvCustomDomain[] }>(
                this.ctx,
                "GET",
                `/deployments/${enc(d.name)}/custom_domains`,
              )
            )?.domains ?? []
          ).map((cd) => toCustomDomain(cd, accountId)),
        );
      case "convex-log-stream":
        return this.perDeployment(only, async (d) =>
          (
            (await deploymentApi<CvLogStream[]>(
              this.ctx,
              d.deploymentUrl ?? `https://${d.name}.convex.cloud`,
              "GET",
              "/list_log_streams",
            )) ?? []
          ).map((s) => toLogStream(s, d.name, accountId)),
        );
      case "convex-usage-limit":
        return this.perDeployment(only, async (d) => {
          const url = d.deploymentUrl ?? `https://${d.name}.convex.cloud`;
          const res = await deploymentApi<{ usageLimits?: CvUsageLimit[] }>(
            this.ctx,
            url,
            "GET",
            "/list_usage_limits",
          );
          const limits = res?.usageLimits ?? [];
          if (limits.length === 0) return [];
          const usage = await deploymentApi<CvUsage>(
            this.ctx,
            url,
            "GET",
            "/get_current_usage",
          ).catch(() => undefined);
          return limits.map((l) => toUsageLimit(l, d.name, accountId, usage));
        });
      case "convex-member": {
        const teamId = await this.teamId();
        const members = await paged<CvMember>(this.ctx, `/teams/${enc(teamId)}/list_members`);
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
              customRoles: (m.customRoles ?? []).join(", "),
            },
            { parentTypeId: "convex-team", parentExternalId: String(teamId) },
          ),
        );
      }
      case "convex-invite": {
        const teamId = await this.teamId();
        const invites = await paged<CvInvite>(
          this.ctx,
          `/teams/${enc(teamId)}/list_pending_invites`,
        );
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
        const roles = await paged<CvCustomRole>(
          this.ctx,
          `/teams/${enc(teamId)}/list_custom_roles`,
        );
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
        const tokens = await paged<CvAccessToken>(
          this.ctx,
          `/teams/${enc(teamId)}/list_access_tokens`,
        );
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
      paged<CvMember>(this.ctx, `/teams/${enc(teamId)}/list_members`).catch(() => undefined),
      paged<CvInvite>(this.ctx, `/teams/${enc(teamId)}/list_pending_invites`).catch(
        () => undefined,
      ),
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

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const externalId = externalIdOf(resourceId);
    if (typeId === "convex-project") {
      return toProject(
        await mgmt<CvProject>(this.ctx, "GET", `/projects/${enc(externalId)}`),
        accountId,
      );
    }
    if (typeId === "convex-deployment") {
      const d = await mgmt<CvDeployment>(this.ctx, "GET", `/deployments/${enc(externalId)}`);
      const project = await mgmt<CvProject>(this.ctx, "GET", `/projects/${enc(d.projectId)}`).catch(
        () => undefined,
      );
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
      const d = await mgmt<CvDeployment>(this.ctx, "GET", `/deployments/${enc(name)}`);
      all = await this.list(typeId, accountId, [d]);
    } else {
      all = await this.list(typeId, accountId);
    }
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new ConvexApiError(404, `Convex plugin: ${typeId}/${externalId} not found`);
    return found;
  }

  // ---- outputs ---------------------------------------------------------------------

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    _accountId: string,
  ): Promise<string> {
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
        return (await mgmt<CvProject>(this.ctx, "GET", `/projects/${enc(externalId)}`)).slug;
      case "convex-deployment.deploymentName":
        return externalId;
      case "convex-deployment.deploymentUrl":
        return this.deploymentUrl(externalId);
      case "convex-deployment.siteUrl": {
        const urls = await this.dApi<{ convexSiteUrl?: string }>(
          externalId,
          "GET",
          "/get_canonical_urls",
        ).catch(() => undefined);
        return urls?.convexSiteUrl || siteUrlOf(await this.deploymentUrl(externalId));
      }
      case "convex-env-var.value": {
        const res = await this.dApi<{ environmentVariables?: Record<string, string> }>(
          first,
          "GET",
          "/list_environment_variables",
        );
        const value = res?.environmentVariables?.[rest];
        if (value === undefined)
          throw new ConvexApiError(404, `Convex plugin: ${rest} is not set.`);
        return value;
      }
      case "convex-default-env-var.value": {
        const [type, name] = head(rest);
        const vars = await paged<CvDefaultEnvVar>(
          this.ctx,
          `/projects/${enc(first)}/list_default_environment_variables`,
          { name },
        );
        const match = vars.find(
          (v) => v.name === name && v.deploymentTypes.includes(type as DeploymentType),
        );
        if (!match) throw new ConvexApiError(404, `Convex plugin: ${name} is not set for ${type}.`);
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
        const stream = await this.dApi<CvLogStream>(first, "GET", `/get_log_stream/${enc(rest)}`);
        const secret = stream?.["hmacSecret"];
        if (typeof secret !== "string")
          throw new Error("Convex plugin: only webhook streams have a secret.");
        return secret;
      }
    }
    throw new Error(`Convex plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // ---- detail views ---------------------------------------------------------------

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    if (resource.resourceTypeId !== "convex-deployment") return resource;
    const name = String(resource.externalId ?? "");
    const [usage, urls] = await Promise.all([
      this.dApi<CvUsage>(name, "GET", "/get_current_usage").catch(() => undefined),
      this.dApi<{ convexCloudUrl?: string; convexSiteUrl?: string }>(
        name,
        "GET",
        "/get_canonical_urls",
      ).catch(() => undefined),
    ]);
    const fields = { ...resource.fields };
    if (usage) fields["_usage"] = JSON.stringify(usage);
    if (urls?.convexSiteUrl) fields["siteUrl"] = urls.convexSiteUrl;
    if (urls?.convexCloudUrl) fields["canonicalCloudUrl"] = urls.convexCloudUrl;
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
    if (resourceTypeId !== "convex-deployment") return [];
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
    return [
      { label: "Type", value: String(r.fields["deploymentType"] ?? "") },
      { label: "Region", value: String(r.fields["region"] ?? "") },
      {
        label: "Last deploy",
        value: String(r.fields["lastDeployAt"] ?? "").slice(0, 10) || "never",
      },
    ];
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== "convex-deployment") return [];
    const usage = await this.dApi<CvUsage>(externalIdOf(resourceId), "GET", "/get_current_usage");
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
  }

  /**
   * Each enabled usage limit against the deployment's current usage for that
   * metric and window. Both halves come from the Deployment API.
   */
  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
    const readings = await this.perDeployment(undefined, async (d) => {
      const url = d.deploymentUrl ?? `https://${d.name}.convex.cloud`;
      const limits =
        (
          await deploymentApi<{ usageLimits?: CvUsageLimit[] }>(
            this.ctx,
            url,
            "GET",
            "/list_usage_limits",
          )
        )?.usageLimits?.filter((l) => l.enabled) ?? [];
      if (limits.length === 0) return [];
      const usage = await deploymentApi<CvUsage>(this.ctx, url, "GET", "/get_current_usage");
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
  }

  // ---- create / update / delete ----------------------------------------------------

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    return getCreateConfig(
      {
        teamId: () => this.teamId(),
        projects: () => this.projects(),
        deployments: () => this.deployments(),
        ctx: this.ctx,
      },
      typeId,
      parentResourceId,
    );
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceCreateReturn> {
    const parent = parentResourceId ? externalIdOf(parentResourceId) : "";
    const deploymentName = () => required(parent || fields["deploymentName"], "a deployment");
    const projectId = () => required(parent || fields["projectId"], "a project");

    switch (typeId) {
      case "convex-project": {
        const created = await mgmt<{ projectId: number }>(
          this.ctx,
          "POST",
          `/teams/${enc(await this.teamId())}/create_project`,
          {
            projectName: required(fields["name"], "a project name"),
            ...(fields["deploymentType"] ? { deploymentType: fields["deploymentType"] } : {}),
            ...(fields["deploymentType"] && fields["region"]
              ? { deploymentRegion: fields["region"] }
              : {}),
            ...(fields["deploymentType"] && fields["class"]
              ? { deploymentClass: fields["class"] }
              : {}),
          },
        );
        return this.getResource(typeId, `${accountId}:${typeId}:${created.projectId}`, accountId);
      }
      case "convex-deployment": {
        const d = await mgmt<CvDeployment>(
          this.ctx,
          "POST",
          `/projects/${enc(projectId())}/create_deployment`,
          {
            type: fields["deploymentType"] || "dev",
            ...(fields["region"] ? { region: fields["region"] } : {}),
            ...(fields["class"] ? { class: fields["class"] } : {}),
            ...(fields["reference"] ? { reference: fields["reference"] } : {}),
            ...(bool(fields["isDefault"]) !== undefined
              ? { isDefault: bool(fields["isDefault"]) }
              : {}),
            ...(fields["expiresAt"] ? { expiresAt: isoToMs(fields["expiresAt"]) } : {}),
          },
        );
        this.remember([d]);
        return toDeployment(d, accountId);
      }
      case "convex-env-var": {
        const name = required(fields["name"], "a name");
        const dep = deploymentName();
        await this.dApi(dep, "POST", "/update_environment_variables", {
          changes: [{ name, value: required(fields["value"], "a value") }],
        });
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
        await mgmt(this.ctx, "POST", `/projects/${enc(pid)}/update_default_environment_variables`, {
          changes: types.map((t) => ({ name, deploymentType: t, value })),
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
        const res = await mgmt<{ deployKey: string }>(
          this.ctx,
          "POST",
          `/deployments/${enc(dep)}/create_deploy_key`,
          {
            name,
            ...(actions.length ? { allowedActions: actions } : {}),
            ...(fields["expiresAt"] ? { expiresAt: isoToMs(fields["expiresAt"]) } : {}),
          },
        );
        const keys =
          (await mgmt<CvDeployKey[]>(
            this.ctx,
            "GET",
            `/deployments/${enc(dep)}/list_deploy_keys`,
          )) ?? [];
        const key = keys
          .filter((k) => k.name === name)
          .sort((a, b) => b.creationTime - a.creationTime)[0];
        const resource = key
          ? toDeployKey(key, dep, accountId)
          : instance(accountId, typeId, `${dep}/${name}`, name, { name, deploymentName: dep });
        resource.resolvedOutputs["deployKey"] = res.deployKey;
        return resource;
      }
      case "convex-preview-deploy-key": {
        const pid = projectId();
        const name = required(fields["name"], "a name");
        const res = await mgmt<{ previewDeployKey: string }>(
          this.ctx,
          "POST",
          `/projects/${enc(pid)}/create_preview_deploy_key`,
          { name, ...(fields["expiresAt"] ? { expiresAt: isoToMs(fields["expiresAt"]) } : {}) },
        );
        const list = await mgmt<{ items?: CvDeployKey[] }>(
          this.ctx,
          "GET",
          `/projects/${enc(pid)}/list_preview_deploy_keys`,
        );
        const key = (list?.items ?? [])
          .filter((k) => k.name === name)
          .sort((a, b) => b.creationTime - a.creationTime)[0];
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
        await mgmt(this.ctx, "POST", `/deployments/${enc(dep)}/create_custom_domain`, {
          domain,
          requestDestination,
        });
        return toCustomDomain(
          { domain, deploymentName: dep, requestDestination, creationTime: Date.now() },
          accountId,
        );
      }
      case "convex-log-stream": {
        const dep = deploymentName();
        const body = logStreamBody(fields);
        const res = await this.dApi<{ id: string; hmacSecret?: string }>(
          dep,
          "POST",
          "/create_log_stream",
          body,
        );
        const created = await this.getResource(
          typeId,
          `${accountId}:${typeId}:${dep}/${res.id}`,
          accountId,
        ).catch(() =>
          instance(accountId, typeId, `${dep}/${res.id}`, String(body["logStreamType"]), {
            streamType: String(body["logStreamType"]),
            deploymentName: dep,
          }),
        );
        if (res.hmacSecret) created.resolvedOutputs["hmacSecret"] = res.hmacSecret;
        return created;
      }
      case "convex-usage-limit": {
        const dep = deploymentName();
        const res = await this.dApi<{ usageLimit: CvUsageLimit }>(
          dep,
          "POST",
          "/create_usage_limit",
          usageLimitBody(fields),
        );
        return toUsageLimit(res.usageLimit, dep, accountId);
      }
      case "convex-invite": {
        const teamId = await this.teamId();
        const email = required(fields["email"], "an email");
        await mgmt(this.ctx, "POST", `/teams/${enc(teamId)}/invite_team_member`, {
          email,
          role: fields["role"] === "admin" ? "admin" : "developer",
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
        const role = await mgmt<CvCustomRole>(
          this.ctx,
          "POST",
          `/teams/${enc(teamId)}/create_custom_role`,
          {
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
        );
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
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const externalId = externalIdOf(resourceId);
    const [first, rest] = head(externalId);
    switch (typeId) {
      case "convex-project": {
        const body: Record<string, unknown> = {};
        if (fields["name"]) body["name"] = fields["name"];
        if (fields["slug"]) body["slug"] = fields["slug"];
        return toProject(
          await mgmt<CvProject>(this.ctx, "PATCH", `/projects/${enc(externalId)}`, body),
          accountId,
        );
      }
      case "convex-deployment": {
        const body: Record<string, unknown> = {};
        if (fields["deploymentType"]) body["deploymentType"] = fields["deploymentType"];
        if (fields["class"]) body["class"] = fields["class"];
        if (fields["reference"]) body["reference"] = fields["reference"];
        for (const key of ["isDefault", "dashboardEditConfirmation", "sendLogsToClient"]) {
          const v = bool(fields[key]);
          if (v !== undefined) body[key] = v;
        }
        const expires = isoToMs(fields["expiresAt"]);
        if (expires !== undefined) body["expiresAt"] = expires;
        await mgmt(this.ctx, "PATCH", `/deployments/${enc(externalId)}`, body);
        break;
      }
      case "convex-env-var":
        if (fields["value"]) {
          await this.dApi(first, "POST", "/update_environment_variables", {
            changes: [{ name: rest, value: fields["value"] }],
          });
        }
        break;
      case "convex-default-env-var":
        if (fields["value"]) {
          const [type, name] = head(rest);
          await mgmt(
            this.ctx,
            "POST",
            `/projects/${enc(first)}/update_default_environment_variables`,
            {
              changes: [{ name, deploymentType: type, value: fields["value"] }],
            },
          );
        }
        break;
      case "convex-log-stream": {
        const current = await this.dApi<CvLogStream>(first, "GET", `/get_log_stream/${enc(rest)}`);
        const body: Record<string, unknown> = { logStreamType: current.logStreamType };
        if (fields["url"]) body["url"] = fields["url"];
        if (fields["format"]) body["format"] = fields["format"];
        if (fields["service"] !== undefined) body["service"] = fields["service"] || null;
        if (fields["datasetName"]) body["datasetName"] = fields["datasetName"];
        await this.dApi(first, "POST", `/update_log_stream/${enc(rest)}`, body);
        break;
      }
      case "convex-usage-limit": {
        const current = (
          await this.dApi<{ usageLimits?: CvUsageLimit[] }>(first, "GET", "/list_usage_limits")
        )?.usageLimits?.find((l) => l.id === rest);
        if (!current)
          throw new ConvexApiError(404, "Convex plugin: the usage limit no longer exists.");
        // Update replaces the whole config, so unchanged values are carried over.
        await this.dApi(
          first,
          "POST",
          `/update_usage_limit/${enc(rest)}`,
          usageLimitBody({
            metric: fields["metric"] || current.metric,
            window: fields["window"] || current.window,
            limitType: fields["limitType"] || current.limitType,
            limit: fields["limit"] || String(current.limit),
            enabled: fields["enabled"] || String(current.enabled),
          }),
        );
        break;
      }
      case "convex-member":
        if (fields["role"]) {
          await mgmt(this.ctx, "POST", `/teams/${enc(first)}/update_team_member_role`, {
            memberId: Number(rest),
            role: fields["role"],
          });
        }
        break;
      case "convex-custom-role": {
        const roles = await paged<CvCustomRole>(this.ctx, `/teams/${enc(first)}/list_custom_roles`);
        const current = roles.find((r) => String(r.id) === rest);
        if (!current) throw new ConvexApiError(404, "Convex plugin: the role no longer exists.");
        await mgmt(this.ctx, "POST", `/teams/${enc(first)}/update_custom_role`, {
          id: current.id,
          name: fields["name"] || current.name,
          description: fields["description"] ?? current.description ?? null,
          statements: current.statements,
        });
        break;
      }
      default:
        throw new Error(`Convex plugin: cannot update "${typeId}".`);
    }
    return this.getResource(typeId, resourceId, accountId);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = externalIdOf(resourceId);
    const [first, rest] = head(externalId);
    switch (typeId) {
      case "convex-project":
        await mgmt(this.ctx, "POST", `/projects/${enc(externalId)}/delete`);
        return;
      case "convex-deployment":
        await mgmt(this.ctx, "POST", `/deployments/${enc(externalId)}/delete`);
        return;
      case "convex-env-var":
        await this.dApi(first, "POST", "/update_environment_variables", {
          changes: [{ name: rest, value: null }],
        });
        return;
      case "convex-default-env-var": {
        const [type, name] = head(rest);
        await mgmt(
          this.ctx,
          "POST",
          `/projects/${enc(first)}/update_default_environment_variables`,
          {
            changes: [{ name, deploymentType: type, value: null }],
          },
        );
        return;
      }
      case "convex-deploy-key": {
        const key = await this.findKeyName(
          `/deployments/${enc(first)}/list_deploy_keys`,
          rest,
          false,
        );
        await mgmt(this.ctx, "POST", `/deployments/${enc(first)}/delete_deploy_key`, { id: key });
        return;
      }
      case "convex-preview-deploy-key": {
        const key = await this.findKeyName(
          `/projects/${enc(first)}/list_preview_deploy_keys`,
          rest,
          true,
        );
        await mgmt(this.ctx, "POST", `/projects/${enc(first)}/delete_preview_deploy_key`, {
          id: key,
        });
        return;
      }
      case "convex-custom-domain": {
        const [destination, domain] = head(rest);
        await mgmt(this.ctx, "POST", `/deployments/${enc(first)}/delete_custom_domain`, {
          domain,
          requestDestination: destination,
        });
        return;
      }
      case "convex-log-stream":
        await this.dApi(first, "POST", `/delete_log_stream/${enc(rest)}`);
        return;
      case "convex-usage-limit":
        await this.dApi(first, "POST", `/delete_usage_limit/${enc(rest)}`);
        return;
      case "convex-invite":
        await mgmt(this.ctx, "POST", `/teams/${enc(first)}/cancel_team_member_invite`, {
          email: rest,
        });
        return;
      case "convex-custom-role":
        await mgmt(this.ctx, "POST", `/teams/${enc(first)}/delete_custom_role`, {
          id: Number(rest),
        });
        return;
      case "convex-access-token": {
        const tokens = await paged<CvAccessToken>(
          this.ctx,
          `/teams/${enc(first)}/list_access_tokens`,
        );
        const token = tokens.find((t) => String(t.id) === rest);
        if (!token) throw new ConvexApiError(404, "Convex plugin: the token no longer exists.");
        await mgmt(this.ctx, "POST", `/teams/${enc(first)}/delete_access_token`, {
          id: token.name,
        });
        return;
      }
      default:
        throw new Error(`Convex plugin: "${typeId}" cannot be deleted.`);
    }
  }

  /** Deploy keys are deleted by name (or secret); our ids are numeric. */
  private async findKeyName(path: string, id: string, wrapped: boolean): Promise<string> {
    const res = await mgmt<CvDeployKey[] | { items?: CvDeployKey[] }>(
      this.ctx,
      "GET",
      path,
      undefined,
      wrapped ? { includeManaged: true } : undefined,
    );
    const keys = Array.isArray(res) ? res : (res?.items ?? []);
    const key = keys.find((k) => String(k.id) === id);
    if (!key) throw new ConvexApiError(404, "Convex plugin: the deploy key no longer exists.");
    return key.name;
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const externalId = externalIdOf(resourceId);
    if (typeId === "convex-deployment" && (actionId === "pause" || actionId === "unpause")) {
      await this.dApi(
        externalId,
        "POST",
        actionId === "pause" ? "/pause_deployment" : "/unpause_deployment",
      );
      return;
    }
    if (typeId === "convex-log-stream" && actionId === "rotate-secret") {
      const [dep, id] = head(externalId);
      await this.dApi(dep, "POST", `/rotate_webhook_secret/${enc(id)}`);
      return;
    }
    if (typeId === "convex-invite" && actionId === "resend") {
      const [teamId, email] = head(externalId);
      const invites = await paged<CvInvite>(this.ctx, `/teams/${enc(teamId)}/list_pending_invites`);
      const invite = invites.find((i) => i.email === email);
      await mgmt(this.ctx, "POST", `/teams/${enc(teamId)}/cancel_team_member_invite`, { email });
      await mgmt(this.ctx, "POST", `/teams/${enc(teamId)}/invite_team_member`, {
        email,
        role: invite?.role ?? "developer",
        ...(invite?.role === "custom" && invite.customRoles?.length
          ? { customRoles: invite.customRoles }
          : {}),
      });
      return;
    }
    throw new Error(`Convex plugin: unknown action "${actionId}" for "${typeId}".`);
  }
}

/** Create-form fields → a `create_log_stream` body for the chosen destination. */
export function logStreamBody(fields: Record<string, string>): Record<string, unknown> {
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

export function usageLimitBody(fields: Record<string, string>): Record<string, unknown> {
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
