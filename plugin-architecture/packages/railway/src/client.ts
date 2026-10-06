import type {
  CostFetchRange,
  CostRow,
  CreateFieldConfig,
  CreateResourceConfig,
  CreditBalance,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  QuotaUsage,
  ResourceInstance,
  ResourceTypeDefinition,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import {
  CreditAccessError,
  QuotaAccessError,
  withMetricsCapability,
} from "@infrawrench/plugin-base";
import { RailwayApi, nodes } from "./api.js";
import { fetchEstimatedBill, fetchRailwayCostData, type NameMaps } from "./cost-data.js";
import { cached, externalOf, isStatus, mapLimit, parseFormArg, str, type Cached } from "./kit.js";
import { fetchRailwayLogs } from "./logs.js";
import {
  mapDeployment,
  mapDomain,
  mapEnvironment,
  mapProject,
  mapServiceInstance,
  mapSharedVariable,
  mapTcpProxy,
  mapVariable,
  mapVolume,
  mapWorkspace,
} from "./mappers.js";
import { DEFAULT_METRICS_WINDOW_MS, fetchServiceMetrics, fetchVolumeMetrics } from "./metrics.js";
import {
  M,
  Q_DEPLOYMENT,
  Q_DEPLOYMENTS,
  Q_LIMITS,
  Q_PROJECTS,
  Q_PROJECT_TREE,
  Q_REGIONS,
  Q_TCP_PROXIES,
  Q_TOKEN_WORKSPACES,
  Q_VARIABLES,
  Q_VOLUME_BACKUPS,
  Q_WORKSPACE,
  Q_WORKSPACE_BILLING,
} from "./queries.js";
import { ENRICH, renderRailwayDetail, renderRailwaySidebarItem } from "./render.js";
import { REGIONS } from "./resource-types.js";
import type {
  Conn,
  RwCustomer,
  RwDeployment,
  RwEnvironment,
  RwProject,
  RwRegion,
  RwServiceInstance,
  RwTcpProxy,
  RwWorkspace,
  RwWorkspaceRef,
  Tree,
} from "./types.js";

const TREE_TTL_MS = 60_000;
const FAN_OUT = 4;
const DEPLOYMENTS_PER_SERVICE = 10;

interface Located {
  project: RwProject;
  env: RwEnvironment;
  si: RwServiceInstance;
}

/** Split `a/b/c` into exactly `n` parts; the last part keeps any extra slashes. */
export function splitId(external: string, n: number): string[] {
  const parts = external.split("/");
  if (parts.length < n || parts.slice(0, n).some((p) => !p)) {
    throw Object.assign(new Error(`Railway plugin: cannot parse resource id "${external}"`), {
      status: 400,
    });
  }
  return [...parts.slice(0, n - 1), parts.slice(n - 1).join("/")];
}

function notFound(what: string): Error {
  return Object.assign(new Error(`Railway plugin: ${what} not found`), { status: 404 });
}

/**
 * Railway plugin client. One per account (an account or workspace token,
 * optionally narrowed to one workspace). Everything except deployments,
 * variables and TCP proxies comes from one tree query per project, cached
 * for a minute so a sync pass over every type costs one walk.
 */
export class RailwayClient implements PluginClient {
  readonly api: RailwayApi;
  private readonly workspaceId: string;
  private readonly resourceTypes: ResourceTypeDefinition[];
  private treeCache: Cached<Tree> | undefined;

  constructor(
    credentials: Record<string, string>,
    resourceTypes: ResourceTypeDefinition[],
    services?: HostServices,
  ) {
    const token = str(credentials["apiToken"]);
    if (!token) throw new Error("Railway plugin: missing apiToken credential");
    this.workspaceId = str(credentials["workspaceId"]);
    this.api = new RailwayApi(token, credentials["caCert"] ?? "", services);
    this.resourceTypes = resourceTypes;
  }

  // ── Discovery ────────────────────────────────────────────────────────

  async workspaces(): Promise<RwWorkspaceRef[]> {
    const res = await this.api.gql<{ apiToken: { workspaces: RwWorkspaceRef[] } }>(
      Q_TOKEN_WORKSPACES,
    );
    const all = res.apiToken?.workspaces ?? [];
    if (!this.workspaceId) return all;
    return all.filter((w) => w.id === this.workspaceId).length
      ? all.filter((w) => w.id === this.workspaceId)
      : [{ id: this.workspaceId, name: this.workspaceId }];
  }

  private async projectIds(workspaceId: string): Promise<string[]> {
    const ids: string[] = [];
    let after: string | null | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await this.api.gql<{ projects: Conn<{ id: string }> }>(Q_PROJECTS, {
        workspaceId,
        after: after ?? null,
      });
      ids.push(...nodes(res.projects).map((p) => p.id));
      if (!res.projects.pageInfo?.hasNextPage || !res.projects.pageInfo.endCursor) break;
      after = res.projects.pageInfo.endCursor;
    }
    return ids;
  }

  tree(): Promise<Tree> {
    this.treeCache = cached(this.treeCache, TREE_TTL_MS, async () => {
      const workspaces = await this.workspaces();
      const out: Tree = { workspaces, projects: [] };
      for (const w of workspaces) {
        const ids = await this.projectIds(w.id);
        const projects = await mapLimit(ids, FAN_OUT, async (id) => {
          try {
            return (await this.api.gql<{ project: RwProject }>(Q_PROJECT_TREE, { id })).project;
          } catch (e) {
            if (isStatus(e, 403, 404)) return null;
            throw e;
          }
        });
        for (const p of projects) if (p) out.projects.push({ project: p, workspace: w });
      }
      return out;
    });
    return this.treeCache.value;
  }

  private invalidate(): void {
    this.treeCache = undefined;
  }

  private async instances(): Promise<Located[]> {
    const out: Located[] = [];
    for (const { project } of (await this.tree()).projects) {
      for (const env of nodes(project.environments)) {
        for (const si of nodes(env.serviceInstances)) out.push({ project, env, si });
      }
    }
    return out;
  }

  private async locate(environmentId: string, serviceId: string): Promise<Located> {
    const found = (await this.instances()).find(
      (l) => l.env.id === environmentId && l.si.serviceId === serviceId,
    );
    if (!found) throw notFound(`service ${serviceId} in environment ${environmentId}`);
    return found;
  }

  private async locateEnv(
    environmentId: string,
  ): Promise<{ project: RwProject; env: RwEnvironment }> {
    for (const { project } of (await this.tree()).projects) {
      const env = nodes(project.environments).find((e) => e.id === environmentId);
      if (env) return { project, env };
    }
    throw notFound(`environment ${environmentId}`);
  }

  private ctxOf(l: Located) {
    return {
      serviceId: l.si.serviceId,
      serviceName: l.si.serviceName,
      environmentId: l.env.id,
      projectId: l.project.id,
    };
  }

  private async perInstance(
    load: (l: Located) => Promise<ResourceInstance[]>,
  ): Promise<ResourceInstance[]> {
    const lists = await mapLimit(await this.instances(), FAN_OUT, async (l) => {
      try {
        return await load(l);
      } catch (e) {
        if (isStatus(e, 403, 404)) return [];
        throw e;
      }
    });
    return lists.flat();
  }

  // ── Listing ──────────────────────────────────────────────────────────

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "workspace": {
        const refs = await this.workspaces();
        return mapLimit(refs, FAN_OUT, async (w) => {
          const [full, customer] = await Promise.all([
            this.api
              .gql<{ workspace: RwWorkspace }>(Q_WORKSPACE, { id: w.id })
              .then((r) => r.workspace)
              .catch(() => w as RwWorkspace),
            this.customer(w.id).catch(() => null),
          ]);
          return mapWorkspace(full, customer, accountId);
        });
      }
      case "project":
        return (await this.tree()).projects.map(({ project, workspace }) =>
          mapProject(project, workspace, accountId),
        );
      case "environment":
        return (await this.tree()).projects.flatMap(({ project }) =>
          nodes(project.environments).map((e) => mapEnvironment(e, project, accountId)),
        );
      case "service":
        return (await this.instances()).map((l) =>
          mapServiceInstance(
            l.si,
            { projectId: l.project.id, projectName: l.project.name, environmentName: l.env.name },
            accountId,
          ),
        );
      case "deployment":
        return this.perInstance(async (l) => {
          const res = await this.api.gql<{ deployments: Conn<RwDeployment> }>(Q_DEPLOYMENTS, {
            input: { projectId: l.project.id, environmentId: l.env.id, serviceId: l.si.serviceId },
            first: DEPLOYMENTS_PER_SERVICE,
          });
          return nodes(res.deployments).map((d) => mapDeployment(d, this.ctxOf(l), accountId));
        });
      case "variable":
        return this.perInstance(async (l) => {
          const res = await this.api.gql<{ variables: Record<string, string> }>(Q_VARIABLES, {
            projectId: l.project.id,
            environmentId: l.env.id,
            serviceId: l.si.serviceId,
          });
          return Object.keys(res.variables ?? {}).map((k) =>
            mapVariable(k, this.ctxOf(l), accountId),
          );
        });
      case "shared-variable": {
        const envs = (await this.tree()).projects.flatMap(({ project }) =>
          nodes(project.environments).map((env) => ({ project, env })),
        );
        const lists = await mapLimit(envs, FAN_OUT, async ({ project, env }) => {
          try {
            const res = await this.api.gql<{ variables: Record<string, string> }>(Q_VARIABLES, {
              projectId: project.id,
              environmentId: env.id,
              serviceId: null,
            });
            return Object.keys(res.variables ?? {}).map((k) =>
              mapSharedVariable(
                k,
                { environmentId: env.id, environmentName: env.name, projectId: project.id },
                accountId,
              ),
            );
          } catch (e) {
            if (isStatus(e, 403, 404)) return [];
            throw e;
          }
        });
        return lists.flat();
      }
      case "volume": {
        const out: ResourceInstance[] = [];
        for (const { project } of (await this.tree()).projects) {
          const names = new Map(nodes(project.services).map((s) => [s.id, s.name]));
          for (const env of nodes(project.environments)) {
            for (const v of nodes(env.volumeInstances)) {
              out.push(
                mapVolume(
                  v,
                  {
                    projectId: project.id,
                    projectName: project.name,
                    environmentName: env.name,
                    serviceName: v.serviceId ? (names.get(v.serviceId) ?? "") : "",
                  },
                  accountId,
                ),
              );
            }
          }
        }
        return out;
      }
      case "domain":
        return (await this.instances()).flatMap((l) => [
          ...(l.si.domains?.serviceDomains ?? []).map((d) =>
            mapDomain({ kind: "railway", domain: d }, this.ctxOf(l), accountId),
          ),
          ...(l.si.domains?.customDomains ?? []).map((d) =>
            mapDomain({ kind: "custom", domain: d }, this.ctxOf(l), accountId),
          ),
        ]);
      case "tcp-proxy":
        return this.perInstance(async (l) => {
          const res = await this.api.gql<{ tcpProxies: RwTcpProxy[] }>(Q_TCP_PROXIES, {
            environmentId: l.env.id,
            serviceId: l.si.serviceId,
          });
          return (res.tcpProxies ?? []).map((t) => mapTcpProxy(t, l.project.id, accountId));
        });
      default:
        throw new Error(`Railway plugin: unknown resource type "${typeId}"`);
    }
  }

  private async customer(workspaceId: string): Promise<RwCustomer | null> {
    const res = await this.api.gql<{ workspace: { customer?: RwCustomer | null } }>(
      Q_WORKSPACE_BILLING,
      {
        id: workspaceId,
      },
    );
    return res.workspace?.customer ?? null;
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalOf(resourceId);
    if (typeId === "deployment") {
      const d = (await this.api.gql<{ deployment: RwDeployment }>(Q_DEPLOYMENT, { id })).deployment;
      const l = await this.locate(d.environmentId ?? "", d.serviceId ?? "").catch(() => null);
      return mapDeployment(
        d,
        {
          serviceId: d.serviceId ?? "",
          serviceName: l?.si.serviceName ?? "",
          environmentId: d.environmentId ?? "",
          projectId: d.projectId ?? "",
        },
        accountId,
      );
    }
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId || r.externalId === id);
    if (!found) throw notFound(`${typeId} ${id}`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const id = externalOf(resourceId);
    if (outputKey === "value" && (typeId === "variable" || typeId === "shared-variable")) {
      return this.variableValue(typeId, id);
    }
    const r = await this.getResource(typeId, resourceId, accountId);
    return r.resolvedOutputs[outputKey] ?? String(r.fields[outputKey] ?? "");
  }

  private async variableValue(typeId: string, external: string): Promise<string> {
    let environmentId: string;
    let serviceId: string | null = null;
    let key: string;
    if (typeId === "variable")
      [environmentId, serviceId, key] = splitId(external, 3) as [string, string, string];
    else [environmentId, key] = splitId(external, 2) as [string, string];
    const { project } = await this.locateEnv(environmentId);
    const res = await this.api.gql<{ variables: Record<string, string> }>(Q_VARIABLES, {
      projectId: project.id,
      environmentId,
      serviceId,
    });
    return res.variables?.[key] ?? "";
  }

  // ── Detail ───────────────────────────────────────────────────────────

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const f = resource.fields;
    const extra: Record<string, string> = {};
    const stash = async (key: string, load: () => Promise<unknown>) => {
      try {
        const v = await load();
        if (v !== undefined && v !== null)
          extra[key] = typeof v === "string" ? v : JSON.stringify(v);
      } catch {
        /* optional panel */
      }
    };
    switch (resource.resourceTypeId) {
      case "service":
        await stash(
          ENRICH.limits,
          async () =>
            (
              await this.api.gql<{ serviceInstanceLimits: unknown }>(Q_LIMITS, {
                environmentId: String(f["environmentId"]),
                serviceId: String(f["serviceId"]),
              })
            ).serviceInstanceLimits,
        );
        break;
      case "volume":
        await stash("__both", async () => {
          const r = await this.api.gql<{
            volumeInstanceBackupList: unknown[];
            volumeInstanceBackupScheduleList: unknown[];
          }>(Q_VOLUME_BACKUPS, { id: String(f["volumeInstanceId"]) });
          extra[ENRICH.backups] = JSON.stringify(r.volumeInstanceBackupList ?? []);
          extra[ENRICH.schedules] = JSON.stringify(r.volumeInstanceBackupScheduleList ?? []);
          return null;
        });
        break;
      case "workspace": {
        const id = resource.externalId ?? externalOf(resource.id);
        await Promise.all([
          stash(
            ENRICH.members,
            async () =>
              (await this.api.gql<{ workspace: RwWorkspace }>(Q_WORKSPACE, { id })).workspace
                .members ?? [],
          ),
          stash(ENRICH.estimatedBill, async () =>
            (await fetchEstimatedBill(this.api, id)).toFixed(2),
          ),
        ]);
        break;
      }
      default:
        return resource;
    }
    return { ...resource, fields: { ...resource.fields, ...extra } };
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return withMetricsCapability(
      renderRailwayDetail(resource, this.resourceTypes),
      this.resourceTypes,
      resource.resourceTypeId,
      DEFAULT_METRICS_WINDOW_MS,
    );
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderRailwaySidebarItem(resource);
  }

  // ── Create ───────────────────────────────────────────────────────────

  private async regionOptions(projectId?: string) {
    try {
      const res = await this.api.gql<{ regions: RwRegion[] }>(Q_REGIONS, {
        projectId: projectId ?? null,
      });
      const live = (res.regions ?? [])
        .filter((r) => r.name && !r.deploymentConstraints?.deprecationInfo?.isDeprecated)
        .map((r) => {
          const known = REGIONS.find((k) => k.id === r.name);
          return {
            id: r.name,
            label: known?.label ?? r.region ?? r.name,
            location: r.location ?? known?.location ?? "",
            ...(known ? { flag: known.flag } : {}),
          };
        });
      return live.length ? live : REGIONS;
    } catch {
      return REGIONS;
    }
  }

  private async servicePicker(parentResourceId: string | undefined): Promise<CreateFieldConfig[]> {
    if (parentResourceId?.includes(":service:")) return [];
    const options = (await this.instances().catch(() => [] as Located[])).map((l) => ({
      id: `${l.env.id}/${l.si.serviceId}`,
      label: l.si.serviceName,
      description: `${l.project.name} / ${l.env.name}`,
    }));
    return [
      {
        key: "service",
        label: "Service",
        kind: "select",
        required: true,
        options,
        ...(options[0] ? { defaultValue: options[0].id } : {}),
      },
    ];
  }

  private async environmentPicker(
    parentResourceId: string | undefined,
  ): Promise<CreateFieldConfig[]> {
    if (parentResourceId?.includes(":environment:")) return [];
    const options = (
      await this.tree().catch(() => ({ projects: [] }) as unknown as Tree)
    ).projects.flatMap(({ project }) =>
      nodes(project.environments).map((e) => ({ id: e.id, label: `${project.name} / ${e.name}` })),
    );
    return [
      {
        key: "environmentId",
        label: "Environment",
        kind: "select",
        required: true,
        options,
        ...(options[0] ? { defaultValue: options[0].id } : {}),
      },
    ];
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "project": {
        const ws = this.workspaceId
          ? []
          : await this.workspaces().catch(() => [] as RwWorkspaceRef[]);
        return {
          fields: [
            ...(ws.length > 1
              ? [
                  {
                    key: "workspaceId",
                    label: "Workspace",
                    kind: "select" as const,
                    required: true,
                    defaultValue: ws[0]!.id,
                    options: ws.map((w) => ({ id: w.id, label: w.name })),
                  },
                ]
              : []),
            { key: "name", label: "Name", kind: "text", required: true },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "defaultEnvironmentName",
              label: "First Environment",
              kind: "text",
              required: false,
              defaultValue: "production",
            },
          ],
        };
      }
      case "environment": {
        const projects = (await this.tree().catch(() => ({ projects: [] }) as unknown as Tree))
          .projects;
        const parentProject = parentResourceId?.includes(":project:")
          ? externalOf(parentResourceId)
          : "";
        const sources = projects
          .filter(({ project }) => !parentProject || project.id === parentProject)
          .flatMap(({ project }) =>
            nodes(project.environments).map((e) => ({
              id: e.id,
              label: `${project.name} / ${e.name}`,
            })),
          );
        return {
          fields: [
            ...(parentProject
              ? []
              : [
                  {
                    key: "projectId",
                    label: "Project",
                    kind: "select" as const,
                    required: true,
                    options: projects.map(({ project }) => ({
                      id: project.id,
                      label: project.name,
                    })),
                    ...(projects[0] ? { defaultValue: projects[0].project.id } : {}),
                  },
                ]),
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "staging" },
            {
              key: "sourceEnvironmentId",
              label: "Copy From",
              kind: "select",
              required: false,
              defaultValue: "",
              description:
                "Duplicate another environment's services and variables, or start empty.",
              options: [{ id: "", label: "Start empty" }, ...sources],
            },
          ],
        };
      }
      case "service":
        return {
          fields: [
            ...(await this.environmentPicker(parentResourceId)),
            { key: "name", label: "Name", kind: "text", required: false },
            {
              key: "sourceKind",
              label: "Source",
              kind: "select",
              required: true,
              defaultValue: "repo",
              options: [
                { id: "repo", label: "GitHub repository" },
                { id: "image", label: "Docker image" },
                { id: "empty", label: "Empty service" },
              ],
            },
            {
              key: "repo",
              label: "Repository",
              kind: "text",
              required: false,
              placeholder: "acme/api",
              description: "owner/name of a repository the Railway GitHub app can read.",
              showWhen: { fieldKey: "sourceKind", fieldValue: "repo" },
            },
            {
              key: "branch",
              label: "Branch",
              kind: "text",
              required: false,
              placeholder: "main",
              showWhen: { fieldKey: "sourceKind", fieldValue: "repo" },
            },
            {
              key: "image",
              label: "Image",
              kind: "text",
              required: false,
              placeholder: "postgres:17",
              showWhen: { fieldKey: "sourceKind", fieldValue: "image" },
            },
            {
              key: "region",
              label: "Region",
              kind: "region-picker",
              required: false,
              regions: await this.regionOptions(),
            },
          ],
        };
      case "variable":
        return {
          fields: [
            ...(await this.servicePicker(parentResourceId)),
            {
              key: "key",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "DATABASE_URL",
            },
            {
              key: "value",
              label: "Value",
              kind: "password",
              required: true,
              description: "Reference other variables with ${{ Postgres.DATABASE_URL }}.",
            },
          ],
        };
      case "shared-variable":
        return {
          fields: [
            ...(await this.environmentPicker(parentResourceId)),
            { key: "key", label: "Name", kind: "text", required: true },
            { key: "value", label: "Value", kind: "password", required: true },
          ],
        };
      case "volume":
        return {
          fields: [
            ...(await this.servicePicker(undefined)),
            { key: "name", label: "Name", kind: "text", required: false },
            {
              key: "mountPath",
              label: "Mount Path",
              kind: "text",
              required: true,
              placeholder: "/data",
            },
          ],
        };
      case "domain":
        return {
          fields: [
            ...(await this.servicePicker(parentResourceId)),
            {
              key: "kind",
              label: "Domain",
              kind: "select",
              required: true,
              defaultValue: "railway",
              options: [
                { id: "railway", label: "Generate a Railway domain (*.up.railway.app)" },
                { id: "custom", label: "Custom domain" },
              ],
            },
            {
              key: "domain",
              label: "Custom Domain",
              kind: "text",
              required: false,
              placeholder: "api.example.com",
              description: "Add the CNAME and TXT records shown afterwards at your DNS provider.",
              showWhen: { fieldKey: "kind", fieldValue: "custom" },
            },
            {
              key: "targetPort",
              label: "Target Port",
              kind: "number",
              required: false,
              minValue: 1,
              maxValue: 65535,
              description: "Port inside the service. Blank uses the PORT variable.",
            },
          ],
        };
      case "tcp-proxy":
        return {
          fields: [
            ...(await this.servicePicker(parentResourceId)),
            {
              key: "applicationPort",
              label: "Service Port",
              kind: "number",
              required: true,
              minValue: 1,
              maxValue: 65535,
              placeholder: "5432",
              description: "The service is redeployed so the proxy takes effect.",
            },
          ],
        };
      default:
        throw new Error(`Railway plugin: cannot create "${typeId}"`);
    }
  }

  private serviceRef(fields: Record<string, string>, parentResourceId?: string): [string, string] {
    const raw =
      str(fields["service"]) ||
      (parentResourceId?.includes(":service:") ? externalOf(parentResourceId) : "");
    if (!raw) throw new Error("Railway plugin: choose a service");
    return splitId(raw, 2) as [string, string];
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const find = async (t: string, external: string) => {
      this.invalidate();
      return this.getResource(t, `${accountId}:${t}:${external}`, accountId);
    };
    switch (typeId) {
      case "project": {
        const workspaceId =
          str(fields["workspaceId"]) || this.workspaceId || (await this.workspaces())[0]?.id || "";
        const p = await this.api.gql<{ projectCreate: { id: string } }>(M.projectCreate, {
          input: {
            name: str(fields["name"]),
            ...(str(fields["description"]) ? { description: str(fields["description"]) } : {}),
            ...(workspaceId ? { workspaceId } : {}),
            ...(str(fields["defaultEnvironmentName"])
              ? { defaultEnvironmentName: str(fields["defaultEnvironmentName"]) }
              : {}),
          },
        });
        return find("project", p.projectCreate.id);
      }
      case "environment": {
        const projectId =
          str(fields["projectId"]) ||
          (parentResourceId?.includes(":project:") ? externalOf(parentResourceId) : "");
        if (!projectId) throw new Error("Railway plugin: choose a project");
        const e = await this.api.gql<{ environmentCreate: { id: string } }>(M.environmentCreate, {
          input: {
            name: str(fields["name"]),
            projectId,
            ...(str(fields["sourceEnvironmentId"])
              ? { sourceEnvironmentId: str(fields["sourceEnvironmentId"]) }
              : {}),
          },
        });
        return find("environment", e.environmentCreate.id);
      }
      case "service": {
        const environmentId =
          str(fields["environmentId"]) ||
          (parentResourceId?.includes(":environment:") ? externalOf(parentResourceId) : "");
        if (!environmentId) throw new Error("Railway plugin: choose an environment");
        const { project } = await this.locateEnv(environmentId);
        const kind = str(fields["sourceKind"]) || "repo";
        const source =
          kind === "repo" && str(fields["repo"])
            ? { repo: str(fields["repo"]) }
            : kind === "image" && str(fields["image"])
              ? { image: str(fields["image"]) }
              : undefined;
        if (kind !== "empty" && !source)
          throw new Error("Railway plugin: enter the repository or image");
        const s = await this.api.gql<{ serviceCreate: { id: string } }>(M.serviceCreate, {
          input: {
            projectId: project.id,
            environmentId,
            ...(str(fields["name"]) ? { name: str(fields["name"]) } : {}),
            ...(source ? { source } : {}),
            ...(kind === "repo" && str(fields["branch"]) ? { branch: str(fields["branch"]) } : {}),
          },
        });
        if (str(fields["region"])) {
          await this.api.gql(M.serviceInstanceUpdate, {
            serviceId: s.serviceCreate.id,
            environmentId,
            input: { region: str(fields["region"]) },
          });
        }
        return find("service", `${environmentId}/${s.serviceCreate.id}`);
      }
      case "variable": {
        const [environmentId, serviceId] = this.serviceRef(fields, parentResourceId);
        const l = await this.locate(environmentId, serviceId);
        const key = str(fields["key"]);
        await this.api.gql(M.variableUpsert, {
          input: {
            projectId: l.project.id,
            environmentId,
            serviceId,
            name: key,
            value: fields["value"] ?? "",
          },
        });
        return mapVariable(key, this.ctxOf(l), accountId);
      }
      case "shared-variable": {
        const environmentId =
          str(fields["environmentId"]) ||
          (parentResourceId?.includes(":environment:") ? externalOf(parentResourceId) : "");
        const { project, env } = await this.locateEnv(environmentId);
        const key = str(fields["key"]);
        await this.api.gql(M.variableUpsert, {
          input: { projectId: project.id, environmentId, name: key, value: fields["value"] ?? "" },
        });
        return mapSharedVariable(
          key,
          { environmentId, environmentName: env.name, projectId: project.id },
          accountId,
        );
      }
      case "volume": {
        const [environmentId, serviceId] = this.serviceRef(fields, undefined);
        const l = await this.locate(environmentId, serviceId);
        const v = await this.api.gql<{ volumeCreate: { id: string } }>(M.volumeCreate, {
          input: {
            projectId: l.project.id,
            environmentId,
            serviceId,
            mountPath: str(fields["mountPath"]),
          },
        });
        if (str(fields["name"])) {
          await this.api.gql(M.volumeUpdate, {
            volumeId: v.volumeCreate.id,
            input: { name: str(fields["name"]) },
          });
        }
        return find("volume", `${environmentId}/${v.volumeCreate.id}`);
      }
      case "domain": {
        const [environmentId, serviceId] = this.serviceRef(fields, parentResourceId);
        const l = await this.locate(environmentId, serviceId);
        const port = str(fields["targetPort"]) ? Number(fields["targetPort"]) : undefined;
        if (str(fields["kind"]) === "custom") {
          const domain = str(fields["domain"]);
          if (!domain) throw new Error("Railway plugin: enter the custom domain");
          const d = await this.api.gql<{ customDomainCreate: { id: string } }>(
            M.customDomainCreate,
            {
              input: {
                domain,
                environmentId,
                projectId: l.project.id,
                serviceId,
                ...(port ? { targetPort: port } : {}),
              },
            },
          );
          return find("domain", `custom/${d.customDomainCreate.id}`);
        }
        const d = await this.api.gql<{ serviceDomainCreate: { id: string } }>(
          M.serviceDomainCreate,
          {
            input: { environmentId, serviceId, ...(port ? { targetPort: port } : {}) },
          },
        );
        return find("domain", `railway/${d.serviceDomainCreate.id}`);
      }
      case "tcp-proxy": {
        const [environmentId, serviceId] = this.serviceRef(fields, parentResourceId);
        const l = await this.locate(environmentId, serviceId);
        const t = await this.addTcpProxy(
          environmentId,
          serviceId,
          Number(fields["applicationPort"]),
        );
        return mapTcpProxy(t, l.project.id, accountId);
      }
      default:
        throw new Error(`Railway plugin: cannot create "${typeId}"`);
    }
  }

  /**
   * `tcpProxyCreate` still works but is deprecated in favour of staged
   * environment changes; per its deprecation note the proxy only goes live
   * after a redeploy, so one is triggered.
   */
  private async addTcpProxy(
    environmentId: string,
    serviceId: string,
    applicationPort: number,
  ): Promise<RwTcpProxy> {
    if (!Number.isInteger(applicationPort) || applicationPort < 1 || applicationPort > 65535) {
      throw new Error("Railway plugin: enter a port between 1 and 65535");
    }
    const t = await this.api.gql<{ tcpProxyCreate: RwTcpProxy }>(M.tcpProxyCreate, {
      input: { environmentId, serviceId, applicationPort },
    });
    await this.api.gql(M.serviceInstanceRedeploy, { environmentId, serviceId });
    return { ...t.tcpProxyCreate, applicationPort, environmentId, serviceId };
  }

  // ── Update ───────────────────────────────────────────────────────────

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalOf(resourceId);
    const has = (k: string) => fields[k] !== undefined;
    switch (typeId) {
      case "workspace": {
        const current = await this.getResource(typeId, resourceId, accountId);
        const customerId = String(current.fields["customerId"] ?? "");
        if (!customerId)
          throw new Error("Railway plugin: this token cannot read the workspace's billing");
        if (has("softLimit") || has("hardLimit")) {
          const soft = has("softLimit")
            ? str(fields["softLimit"])
            : String(current.fields["softLimit"] ?? "");
          const hard = has("hardLimit")
            ? str(fields["hardLimit"])
            : String(current.fields["hardLimit"] ?? "");
          if (!soft && !hard) {
            await this.api.gql(M.usageLimitRemove, { input: { customerId } });
          } else {
            if (!soft)
              throw new Error("Set a usage alert amount; Railway requires one with a hard limit.");
            await this.api.gql(M.usageLimitSet, {
              input: {
                customerId,
                softLimitDollars: Math.round(Number(soft)),
                ...(hard ? { hardLimitDollars: Math.round(Number(hard)) } : {}),
              },
            });
          }
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "project": {
        const input: Record<string, unknown> = {};
        if (str(fields["name"])) input["name"] = str(fields["name"]);
        if (has("description")) input["description"] = str(fields["description"]);
        if (has("prDeploys")) input["prDeploys"] = fields["prDeploys"] === "true";
        if (has("isPublic")) input["isPublic"] = fields["isPublic"] === "true";
        if (Object.keys(input).length) await this.api.gql(M.projectUpdate, { id, input });
        this.invalidate();
        return this.getResource(typeId, resourceId, accountId);
      }
      case "environment":
        if (str(fields["name"])) {
          await this.api.gql(M.environmentRename, { id, input: { name: str(fields["name"]) } });
        }
        this.invalidate();
        return this.getResource(typeId, resourceId, accountId);
      case "service": {
        const [environmentId, serviceId] = splitId(id, 2) as [string, string];
        if (str(fields["name"])) {
          await this.api.gql(M.serviceUpdate, {
            id: serviceId,
            input: { name: str(fields["name"]) },
          });
        }
        const input = buildInstanceUpdate(fields);
        if (Object.keys(input).length) {
          await this.api.gql(M.serviceInstanceUpdate, { serviceId, environmentId, input });
        }
        if (str(fields["vcpuLimit"]) || str(fields["memoryLimitGb"])) {
          await this.api.gql(M.serviceInstanceLimitsUpdate, {
            input: {
              environmentId,
              serviceId,
              ...(str(fields["vcpuLimit"]) ? { vCPUs: Number(fields["vcpuLimit"]) } : {}),
              ...(str(fields["memoryLimitGb"])
                ? { memoryGB: Number(fields["memoryLimitGb"]) }
                : {}),
            },
          });
        }
        this.invalidate();
        return this.getResource(typeId, resourceId, accountId);
      }
      case "variable":
      case "shared-variable": {
        if (fields["value"]) {
          let environmentId: string;
          let serviceId: string | undefined;
          let key: string;
          if (typeId === "variable")
            [environmentId, serviceId, key] = splitId(id, 3) as [string, string, string];
          else [environmentId, key] = splitId(id, 2) as [string, string];
          const { project } = await this.locateEnv(environmentId);
          await this.api.gql(M.variableUpsert, {
            input: {
              projectId: project.id,
              environmentId,
              ...(serviceId ? { serviceId } : {}),
              name: key,
              value: fields["value"],
            },
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "volume": {
        const [environmentId, volumeId] = splitId(id, 2) as [string, string];
        if (str(fields["name"])) {
          await this.api.gql(M.volumeUpdate, { volumeId, input: { name: str(fields["name"]) } });
        }
        if (str(fields["mountPath"])) {
          await this.api.gql(M.volumeInstanceUpdate, {
            volumeId,
            environmentId,
            input: { mountPath: str(fields["mountPath"]) },
          });
        }
        this.invalidate();
        return this.getResource(typeId, resourceId, accountId);
      }
      case "domain": {
        if (has("targetPort")) {
          const current = await this.getResource(typeId, resourceId, accountId);
          const [kind, domainId] = splitId(id, 2) as [string, string];
          const port = str(fields["targetPort"]) ? Number(fields["targetPort"]) : null;
          const environmentId = String(current.fields["environmentId"]);
          if (kind === "custom") {
            await this.api.gql(M.customDomainUpdate, {
              id: domainId,
              environmentId,
              targetPort: port,
            });
          } else {
            await this.api.gql(M.serviceDomainUpdate, {
              input: {
                domain: String(current.fields["domain"]),
                environmentId,
                serviceDomainId: domainId,
                serviceId: String(current.fields["serviceId"]),
                targetPort: port,
              },
            });
          }
        }
        this.invalidate();
        return this.getResource(typeId, resourceId, accountId);
      }
      default:
        throw new Error(`Railway plugin: cannot update "${typeId}"`);
    }
  }

  // ── Delete ───────────────────────────────────────────────────────────

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const id = externalOf(resourceId);
    switch (typeId) {
      case "project":
        await this.api.gql(M.projectDelete, { id });
        break;
      case "environment":
        await this.api.gql(M.environmentDelete, { id });
        break;
      case "service": {
        const [environmentId, serviceId] = splitId(id, 2) as [string, string];
        await this.api.gql(M.serviceDelete, { id: serviceId, environmentId });
        break;
      }
      case "deployment":
        await this.api.gql(M.deploymentRemove, { id });
        break;
      case "variable":
      case "shared-variable": {
        let environmentId: string;
        let serviceId: string | undefined;
        let key: string;
        if (typeId === "variable")
          [environmentId, serviceId, key] = splitId(id, 3) as [string, string, string];
        else [environmentId, key] = splitId(id, 2) as [string, string];
        const { project } = await this.locateEnv(environmentId);
        await this.api.gql(M.variableDelete, {
          input: {
            projectId: project.id,
            environmentId,
            ...(serviceId ? { serviceId } : {}),
            name: key,
          },
        });
        break;
      }
      case "volume":
        await this.api.gql(M.volumeDelete, { volumeId: splitId(id, 2)[1] });
        break;
      case "domain": {
        const [kind, domainId] = splitId(id, 2) as [string, string];
        await this.api.gql(kind === "custom" ? M.customDomainDelete : M.serviceDomainDelete, {
          id: domainId,
        });
        break;
      }
      case "tcp-proxy":
        await this.api.gql(M.tcpProxyDelete, { id });
        break;
      default:
        throw new Error(`Railway plugin: cannot delete "${typeId}"`);
    }
    this.invalidate();
  }

  // ── Actions ──────────────────────────────────────────────────────────

  private async latestDeploymentId(environmentId: string, serviceId: string): Promise<string> {
    this.invalidate();
    const l = await this.locate(environmentId, serviceId);
    const id = l.si.latestDeployment?.id;
    if (!id) throw new Error("Railway plugin: this service has no deployment yet");
    return id;
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const id = externalOf(resourceId);
    if (typeId === "service") {
      const [environmentId, serviceId] = splitId(id, 2) as [string, string];
      switch (actionId) {
        case "deploy-latest":
          await this.api.gql(M.serviceInstanceDeploy, {
            serviceId,
            environmentId,
            latestCommit: true,
          });
          break;
        case "redeploy":
          await this.api.gql(M.serviceInstanceRedeploy, { serviceId, environmentId });
          break;
        case "restart":
          await this.api.gql(M.deploymentRestart, {
            id: await this.latestDeploymentId(environmentId, serviceId),
          });
          break;
        case "stop":
          await this.api.gql(M.deploymentStop, {
            id: await this.latestDeploymentId(environmentId, serviceId),
          });
          break;
        default:
          throw new Error(`Railway plugin: action "${actionId}" is not supported for "${typeId}"`);
      }
      this.invalidate();
      return;
    }
    if (typeId === "deployment") {
      const mutations: Record<string, string> = {
        redeploy: M.deploymentRedeploy,
        rollback: M.deploymentRollback,
        restart: M.deploymentRestart,
        stop: M.deploymentStop,
        cancel: M.deploymentCancel,
        approve: M.deploymentApprove,
      };
      const m = mutations[actionId];
      if (m) {
        await this.api.gql(m, { id });
        this.invalidate();
        return;
      }
    }
    if (typeId === "domain" && actionId === "issue-certificate") {
      await this.api.gql(M.customDomainIssueCertificate, { id: splitId(id, 2)[1] });
      return;
    }
    if (typeId === "volume" && actionId === "backup") {
      const v = await this.getResource(typeId, resourceId, _accountId);
      await this.api.gql(M.backupCreate, { id: String(v.fields["volumeInstanceId"]), name: null });
      return;
    }
    throw new Error(`Railway plugin: action "${actionId}" is not supported for "${typeId}"`);
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const id = externalOf(resourceId);
    const v = parseFormArg(args[0]);
    switch (`${typeId}:${command}`) {
      case "service:deployCommit": {
        const [environmentId, serviceId] = splitId(id, 2) as [string, string];
        const sha = str(v["commitSha"]);
        if (!/^[0-9a-f]{7,40}$/i.test(sha))
          throw new Error("Enter a commit SHA (7 to 40 hex characters).");
        await this.api.gql(M.serviceInstanceDeploy, { serviceId, environmentId, commitSha: sha });
        break;
      }
      case "service:scale": {
        const [environmentId, serviceId] = splitId(id, 2) as [string, string];
        if (str(v["numReplicas"])) {
          const n = Number(v["numReplicas"]);
          if (!Number.isInteger(n) || n < 1) throw new Error("Enter a whole number of replicas.");
          await this.api.gql(M.serviceInstanceUpdate, {
            serviceId,
            environmentId,
            input: { numReplicas: n },
          });
        }
        if (str(v["vcpus"]) || str(v["memoryGB"])) {
          await this.api.gql(M.serviceInstanceLimitsUpdate, {
            input: {
              environmentId,
              serviceId,
              ...(str(v["vcpus"]) ? { vCPUs: Number(v["vcpus"]) } : {}),
              ...(str(v["memoryGB"]) ? { memoryGB: Number(v["memoryGB"]) } : {}),
            },
          });
        }
        break;
      }
      case "service:addTcpProxy": {
        const [environmentId, serviceId] = splitId(id, 2) as [string, string];
        await this.addTcpProxy(environmentId, serviceId, Number(v["applicationPort"]));
        break;
      }
      case "volume:backupSchedule": {
        const res = await this.getResource(typeId, resourceId, accountId);
        let kinds: string[] = [];
        try {
          const parsed = JSON.parse(v["kinds"] || "[]") as unknown;
          if (Array.isArray(parsed)) kinds = parsed.map(String);
        } catch {
          kinds = (v["kinds"] ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        }
        await this.api.gql(M.backupSchedule, { id: String(res.fields["volumeInstanceId"]), kinds });
        break;
      }
      case "volume:restoreBackup": {
        const res = await this.getResource(typeId, resourceId, accountId);
        await this.api.gql(M.backupRestore, {
          id: String(res.fields["volumeInstanceId"]),
          backupId: str(v["backupId"]),
        });
        break;
      }
      default:
        throw new Error(`Railway plugin: unknown command "${command}" for "${typeId}"`);
    }
    this.invalidate();
    return null;
  }

  /** Drag a volume onto a service (same environment) to mount it there. */
  async attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    _accountId: string,
  ): Promise<void> {
    if (sourceTypeId !== "volume" || targetTypeId !== "service") {
      throw new Error(`Railway plugin: cannot attach ${sourceTypeId} to ${targetTypeId}`);
    }
    const [volEnv, volumeId] = splitId(externalOf(sourceResourceId), 2) as [string, string];
    const [svcEnv, serviceId] = splitId(externalOf(targetResourceId), 2) as [string, string];
    if (volEnv !== svcEnv)
      throw new Error("A volume can only be mounted by a service in its own environment.");
    await this.api.gql(M.volumeInstanceUpdate, {
      volumeId,
      environmentId: volEnv,
      input: { serviceId },
    });
    this.invalidate();
  }

  // ── Logs and metrics ─────────────────────────────────────────────────

  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    const id = externalOf(resourceId);
    let deploymentId = id;
    if (typeId === "service") {
      const [environmentId, serviceId] = splitId(id, 2) as [string, string];
      deploymentId = await this.latestDeploymentId(environmentId, serviceId);
    } else if (typeId !== "deployment") {
      throw new Error(`Railway plugin: no logs for "${typeId}"`);
    }
    return fetchRailwayLogs(this.api, deploymentId, params.tailLines, params.container);
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const id = externalOf(resourceId);
    if (resourceTypeId === "service") {
      const [environmentId, serviceId] = splitId(id, 2) as [string, string];
      const l = await this.locate(environmentId, serviceId).catch(() => null);
      const hasDomain =
        (l?.si.domains?.serviceDomains?.length ?? 0) + (l?.si.domains?.customDomains?.length ?? 0) >
        0;
      return fetchServiceMetrics(this.api, environmentId, serviceId, hasDomain, timeRange);
    }
    if (resourceTypeId === "volume") {
      const [environmentId, volumeId] = splitId(id, 2) as [string, string];
      return fetchVolumeMetrics(this.api, environmentId, volumeId, timeRange);
    }
    return [];
  }

  // ── Costs, credits and quotas ────────────────────────────────────────

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    const names: NameMaps = { projects: new Map(), environments: new Map(), services: new Map() };
    const tree = await this.tree();
    for (const { project } of tree.projects) {
      names.projects.set(project.id, project.name);
      for (const e of nodes(project.environments)) names.environments.set(e.id, e.name);
      for (const s of nodes(project.services)) names.services.set(s.id, s.name);
    }
    return fetchRailwayCostData(
      this.api,
      tree.workspaces.map((w) => w.id),
      range,
      names,
    );
  }

  async fetchCreditBalance(_accountId: string): Promise<CreditBalance[]> {
    const out: CreditBalance[] = [];
    for (const w of await this.workspaces()) {
      let c: RwCustomer | null;
      try {
        c = await this.customer(w.id);
      } catch (e) {
        if (isStatus(e, 401, 403)) {
          throw new CreditAccessError(
            "Railway refused the workspace's billing details. Use a token from a workspace admin.",
          );
        }
        throw e;
      }
      if (!c || typeof c.creditBalance !== "number") continue;
      out.push({
        key: w.id,
        label: `${w.name} credits`,
        remaining: c.creditBalance,
        currency: "USD",
      });
    }
    return out;
  }

  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
    const out: QuotaUsage[] = [];
    for (const w of await this.workspaces()) {
      let c: RwCustomer | null;
      try {
        c = await this.customer(w.id);
      } catch (e) {
        if (isStatus(e, 401, 403)) {
          throw new QuotaAccessError(
            "Railway refused the workspace's billing details for this token.",
          );
        }
        throw e;
      }
      const hard = c?.usageLimit?.hardLimit;
      if (typeof hard !== "number" || hard <= 0 || typeof c?.currentUsage !== "number") continue;
      out.push({
        id: `usage-limit/${w.id}`,
        service: "Billing",
        name: `${w.name} hard usage limit`,
        limit: hard,
        used: Math.round(c.currentUsage * 100) / 100,
        unit: "USD",
        adjustable: true,
      });
    }
    return out;
  }
}

/** Only the changed instance settings, in `ServiceInstanceUpdateInput` shape. */
export function buildInstanceUpdate(fields: Record<string, string>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const has = (k: string) => fields[k] !== undefined;
  for (const k of [
    "buildCommand",
    "startCommand",
    "rootDirectory",
    "dockerfilePath",
    "railwayConfigFile",
    "healthcheckPath",
    "cronSchedule",
  ]) {
    if (has(k)) input[k] = str(fields[k]) || null;
  }
  if (has("region") && str(fields["region"])) input["region"] = str(fields["region"]);
  if (has("builder") && str(fields["builder"])) input["builder"] = str(fields["builder"]);
  if (has("restartPolicyType") && str(fields["restartPolicyType"])) {
    input["restartPolicyType"] = str(fields["restartPolicyType"]);
  }
  for (const k of ["numReplicas", "healthcheckTimeout", "restartPolicyMaxRetries"]) {
    if (has(k) && str(fields[k])) input[k] = Number(fields[k]);
  }
  if (has("sleepApplication")) input["sleepApplication"] = fields["sleepApplication"] === "true";
  if (has("preDeployCommand")) {
    const cmd = str(fields["preDeployCommand"]);
    input["preDeployCommand"] = cmd ? [cmd] : [];
  }
  if (has("repo") && str(fields["repo"])) input["source"] = { repo: str(fields["repo"]) };
  else if (has("image") && str(fields["image"])) input["source"] = { image: str(fields["image"]) };
  return input;
}
