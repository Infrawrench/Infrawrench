import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  CreateResourceConfig,
  ResourceStatus,
  DashboardStat,
} from "@infrawrench/plugin-base";

/* ---------- Vercel API response types ---------- */

interface VercelProject {
  id: string;
  name: string;
  framework?: string | null;
  nodeVersion?: string;
  serverlessFunctionRegion?: string;
  rootDirectory?: string | null;
  buildCommand?: string | null;
  outputDirectory?: string | null;
  createdAt: number;
  updatedAt?: number;
  live?: boolean;
  link?: {
    type?: string;
    repo?: string;
    repoId?: number;
    org?: string;
  };
  alias?: Array<{ domain: string }>;
  latestDeployments?: Array<{
    url?: string;
    readyState?: string;
  }>;
}

interface VercelDeployment {
  uid: string;
  name: string;
  url: string | null;
  state?: string;
  readyState?: string;
  target?: string | null;
  source?: string;
  projectId?: string;
  created: number;
  buildingAt?: number;
  ready?: number;
  inspectorUrl?: string | null;
  meta?: Record<string, string>;
  creator?: {
    uid: string;
    email?: string;
    username?: string;
  };
  projectSettings?: {
    framework?: string | null;
  };
}

interface VercelDomain {
  id: string;
  name: string;
  verified: boolean;
  serviceType: string;
  nameservers: string[];
  intendedNameservers: string[];
  renew?: boolean;
  expiresAt: number | null;
  boughtAt: number | null;
  createdAt: number;
}

interface VercelEnvVar {
  id?: string;
  key: string;
  value?: string;
  type: string;
  target?: string[] | string;
  gitBranch?: string;
  createdAt?: number;
  updatedAt?: number;
}

interface VercelTeam {
  id: string;
  name: string;
  slug: string;
  createdAt: number;
  updatedAt: number;
  membership?: { role: string };
}

/* ---------- Helpers ---------- */

function deploymentStatus(state?: string): ResourceStatus {
  switch (state) {
    case "READY":
      return "healthy";
    case "BUILDING":
    case "INITIALIZING":
    case "QUEUED":
      return "provisioning";
    case "ERROR":
      return "error";
    case "CANCELED":
    case "DELETED":
      return "error";
    default:
      return "unknown";
  }
}

function domainVerificationStatus(verified: boolean): ResourceStatus {
  return verified ? "healthy" : "degraded";
}

function formatTimestamp(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return new Date(ms).toISOString();
}

function targetLabel(target: string[] | string | undefined): string {
  if (!target) return "—";
  if (Array.isArray(target)) return target.join(", ");
  return target;
}

/** Build a fields record, omitting entries whose value is null or undefined */
function fields(
  entries: Record<string, string | number | boolean | null | undefined>,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(entries)) {
    if (v != null) result[k] = v;
  }
  return result;
}

/* ---------- Client ---------- */

/**
 * Vercel plugin client.
 * Manages Vercel projects, deployments, domains, env vars, and teams
 * via the Vercel REST API (https://api.vercel.com).
 */
export class VercelClient implements PluginClient {
  private readonly accessToken: string;
  private readonly teamId: string | null;
  private readonly baseUrl = "https://api.vercel.com";

  constructor(credentials: Record<string, string>) {
    const token = credentials["accessToken"];
    if (!token) throw new Error("Vercel plugin: missing accessToken credential");
    this.accessToken = token;
    this.teamId = credentials["teamId"] || null;
  }

  /** Append teamId query param if configured */
  private teamQuery(path: string): string {
    if (!this.teamId) return path;
    const sep = path.includes("?") ? "&" : "?";
    return `${path}${sep}teamId=${encodeURIComponent(this.teamId)}`;
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${this.teamQuery(path)}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      ...options,
    });
    if (!res.ok) {
      throw new Error(`Vercel API error ${res.status} for ${path}: ${await res.text()}`);
    }
    if (res.status === 204) return undefined as unknown as T;
    return res.json() as Promise<T>;
  }

  /** Paginate Vercel's timestamp-cursor endpoints */
  private async paginate<T>(path: string, dataKey: string, limit = 100): Promise<T[]> {
    const results: T[] = [];
    let cursor: number | null = null;

    for (;;) {
      const sep = path.includes("?") ? "&" : "?";
      let url = `${path}${sep}limit=${limit}`;
      if (cursor != null) url += `&until=${cursor}`;

      const res = await this.fetch<Record<string, unknown>>(url);
      const items = res[dataKey];
      if (!Array.isArray(items) || items.length === 0) break;
      results.push(...(items as T[]));

      const pagination = res["pagination"] as { next: number | null } | undefined;
      if (!pagination?.next) break;
      cursor = pagination.next;
    }

    return results;
  }

  /* ================================================================
   *  Core PluginClient methods
   * ================================================================ */

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "vercel-project":
        return this.listProjects(accountId);
      case "vercel-deployment":
        return this.listDeployments(accountId);
      case "vercel-domain":
        return this.listDomains(accountId);
      case "vercel-env-var":
        return this.listAllEnvVars(accountId);
      case "vercel-team":
        return this.listTeams(accountId);
      default:
        throw new Error(`Vercel plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const externalId = resourceId.split(":").slice(2).join(":");

    if (typeId === "vercel-project") {
      const project = await this.fetch<VercelProject>(`/v9/projects/${externalId}`);
      return this.mapProject(project, accountId);
    }

    // Fallback: list all and find
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`Vercel plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource(typeId, resourceId, accountId);

    if (typeId === "vercel-project") {
      if (outputKey === "projectId") return resource.externalId ?? "";
      if (outputKey === "projectName") return String(resource.fields["name"] ?? "");
      if (outputKey === "productionUrl") return String(resource.fields["productionUrl"] ?? "");
    }

    if (typeId === "vercel-deployment") {
      if (outputKey === "deploymentId") return resource.externalId ?? "";
      if (outputKey === "url") return String(resource.fields["url"] ?? "");
      if (outputKey === "inspectorUrl") return String(resource.fields["inspectorUrl"] ?? "");
    }

    if (typeId === "vercel-domain") {
      if (outputKey === "domainName") return String(resource.fields["name"] ?? "");
      if (outputKey === "nameservers") return String(resource.fields["nameservers"] ?? "");
    }

    if (typeId === "vercel-env-var") {
      if (outputKey === "envKey") return String(resource.fields["key"] ?? "");
      if (outputKey === "envValue") return String(resource.fields["value"] ?? "");
    }

    if (typeId === "vercel-team") {
      if (outputKey === "teamId") return resource.externalId ?? "";
      if (outputKey === "teamSlug") return String(resource.fields["slug"] ?? "");
    }

    throw new Error(`Vercel plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = resource.fields;

    switch (resourceTypeId) {
      case "vercel-project": {
        const stats: DashboardStat[] = [];
        if (f["framework"]) stats.push({ label: "Framework", value: String(f["framework"]) });
        if (f["serverlessFunctionRegion"])
          stats.push({ label: "Region", value: String(f["serverlessFunctionRegion"]) });
        if (f["nodeVersion"]) stats.push({ label: "Node.js", value: String(f["nodeVersion"]) });
        const liveStr = f["live"] === true || f["live"] === "true" ? "Yes" : "No";
        stats.push({
          label: "Live",
          value: liveStr,
          variant: liveStr === "Yes" ? "status-healthy" : "status-degraded",
        });
        return stats;
      }
      case "vercel-deployment": {
        const state = String(f["state"] ?? "unknown");
        const variant =
          state === "READY"
            ? "status-healthy"
            : state === "BUILDING" || state === "QUEUED"
              ? "status-degraded"
              : state === "ERROR" || state === "CANCELED"
                ? "status-error"
                : "default";
        const stats: DashboardStat[] = [{ label: "State", value: state, variant }];
        if (f["target"]) stats.push({ label: "Target", value: String(f["target"]) });
        return stats;
      }
      case "vercel-domain": {
        const verified = f["verified"] === "true" || f["verified"] === true;
        return [
          {
            label: "Verified",
            value: verified ? "Yes" : "No",
            variant: verified ? "status-healthy" : "status-error",
          },
          { label: "Service", value: String(f["serviceType"] ?? "—") },
        ];
      }
      default:
        return [];
    }
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "vercel-project":
        return this.renderProjectDetail(resource);
      case "vercel-deployment":
        return this.renderDeploymentDetail(resource);
      case "vercel-domain":
        return this.renderDomainDetail(resource);
      case "vercel-env-var":
        return this.renderEnvVarDetail(resource);
      case "vercel-team":
        return this.renderTeamDetail(resource);
      default:
        return this.renderGenericDetail(resource);
    }
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    let status: ResourceStatus = "unknown";

    if (resource.resourceTypeId === "vercel-deployment") {
      status = deploymentStatus(resource.fields["state"] as string | undefined);
    } else if (resource.resourceTypeId === "vercel-domain") {
      const verified =
        resource.fields["verified"] === "true" || resource.fields["verified"] === true;
      status = domainVerificationStatus(verified);
    } else if (resource.resourceTypeId === "vercel-project") {
      const live = resource.fields["live"] === true || resource.fields["live"] === "true";
      status = live ? "healthy" : "degraded";
    } else if (resource.resourceTypeId === "vercel-team") {
      status = "healthy";
    } else if (resource.resourceTypeId === "vercel-env-var") {
      status = "healthy";
    }

    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status },
    };
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === "vercel-project") {
      return {
        fields: [
          { key: "name", label: "Project Name", kind: "text", required: true },
          {
            key: "framework",
            label: "Framework",
            kind: "select",
            required: false,
            options: [
              { id: "nextjs", label: "Next.js" },
              { id: "remix", label: "Remix" },
              { id: "astro", label: "Astro" },
              { id: "sveltekit", label: "SvelteKit" },
              { id: "nuxtjs", label: "Nuxt.js" },
              { id: "gatsby", label: "Gatsby" },
              { id: "vue", label: "Vue" },
              { id: "svelte", label: "Svelte" },
              { id: "vite", label: "Vite" },
              { id: "create-react-app", label: "Create React App" },
              { id: "hugo", label: "Hugo" },
              { id: "eleventy", label: "Eleventy" },
            ],
          },
          { key: "buildCommand", label: "Build Command", kind: "text", required: false },
          { key: "outputDirectory", label: "Output Directory", kind: "text", required: false },
          { key: "rootDirectory", label: "Root Directory", kind: "text", required: false },
        ],
      };
    }

    if (typeId === "vercel-domain") {
      return {
        fields: [
          {
            key: "name",
            label: "Domain Name",
            kind: "text",
            required: true,
            description: "e.g. example.com or sub.example.com",
          },
        ],
      };
    }

    throw new Error(`Vercel plugin: no create config for type "${typeId}"`);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId === "vercel-project") {
      const body: Record<string, unknown> = { name: fields["name"] };
      if (fields["framework"]) body["framework"] = fields["framework"];
      if (fields["buildCommand"]) body["buildCommand"] = fields["buildCommand"];
      if (fields["outputDirectory"]) body["outputDirectory"] = fields["outputDirectory"];
      if (fields["rootDirectory"]) body["rootDirectory"] = fields["rootDirectory"];

      const project = await this.fetch<VercelProject>("/v11/projects", {
        method: "POST",
        body: JSON.stringify(body),
      });

      return this.mapProject(project, accountId);
    }

    if (typeId === "vercel-domain") {
      const data = await this.fetch<Record<string, unknown>>("/v5/domains", {
        method: "POST",
        body: JSON.stringify({ name: fields["name"] }),
      });
      const domain = (data["domain"] ?? data) as Record<string, unknown>;
      const name = String(domain["name"] ?? fields["name"]);
      const now = new Date().toISOString();
      return {
        id: `${accountId}:vercel-domain:${name}`,
        pluginId: "vercel",
        resourceTypeId: "vercel-domain",
        accountId,
        displayName: name,
        fields: {
          name,
          verified: String(domain["verified"] ?? false),
          serviceType: String(domain["serviceType"] ?? ""),
          nameservers: "",
          intendedNameservers: "",
          renew: String(domain["renew"] ?? false),
          expiresAt: String(domain["expiresAt"] ?? ""),
          boughtAt: String(domain["boughtAt"] ?? ""),
          createdAt: String(domain["createdAt"] ?? now),
        },
        resolvedOutputs: { domainName: name, nameservers: "" },
        secretStates: [],
        externalId: name,
        createdAt: String(domain["createdAt"] ?? now),
        updatedAt: now,
      };
    }

    throw new Error(`Vercel plugin: createResource not supported for type "${typeId}"`);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = resourceId.split(":").slice(2).join(":");

    if (typeId === "vercel-project") {
      await this.fetch<unknown>(`/v9/projects/${externalId}`, { method: "DELETE" });
      return;
    }

    if (typeId === "vercel-deployment") {
      await this.fetch<unknown>(`/v13/deployments/${externalId}`, { method: "DELETE" });
      return;
    }

    throw new Error(`Vercel plugin: deleteResource not supported for type "${typeId}"`);
  }

  /* ================================================================
   *  Private list methods
   * ================================================================ */

  private async listProjects(accountId: string): Promise<ResourceInstance[]> {
    const projects = await this.paginate<VercelProject>("/v10/projects", "projects");
    return projects.map((p) => this.mapProject(p, accountId));
  }

  private async listDeployments(accountId: string): Promise<ResourceInstance[]> {
    const deployments = await this.paginate<VercelDeployment>("/v6/deployments", "deployments", 50);
    return deployments.map((d) => this.mapDeployment(d, accountId));
  }

  private async listDomains(accountId: string): Promise<ResourceInstance[]> {
    const domains = await this.paginate<VercelDomain>("/v5/domains", "domains");
    return domains.map((d) => this.mapDomain(d, accountId));
  }

  private async listAllEnvVars(accountId: string): Promise<ResourceInstance[]> {
    // Env vars are per-project; list projects first, then fetch envs for each
    const projects = await this.paginate<VercelProject>("/v10/projects", "projects");
    const results: ResourceInstance[] = [];

    for (const project of projects) {
      try {
        const data = await this.fetch<{ envs: VercelEnvVar[] }>(`/v10/projects/${project.id}/env`);
        const envs = data.envs ?? [];
        for (const env of envs) {
          results.push(this.mapEnvVar(env, project, accountId));
        }
      } catch {
        /* skip projects where we lack env read permissions */
      }
    }

    return results;
  }

  private async listTeams(accountId: string): Promise<ResourceInstance[]> {
    try {
      const data = await this.fetch<{ teams: VercelTeam[] }>("/v2/teams");
      const teams = data.teams ?? [];
      return teams.map((t) => this.mapTeam(t, accountId));
    } catch {
      // Personal accounts may not have team access
      return [];
    }
  }

  /* ================================================================
   *  Mappers
   * ================================================================ */

  private mapProject(p: VercelProject, accountId: string): ResourceInstance {
    const gitRepo = p.link
      ? `${p.link.org ?? ""}/${p.link.repo ?? ""}`.replace(/^\//, "")
      : undefined;
    const productionAlias = p.alias?.find((a) => a.domain)?.domain;
    const productionUrl = productionAlias
      ? `https://${productionAlias}`
      : p.latestDeployments?.[0]?.url
        ? `https://${p.latestDeployments[0].url}`
        : undefined;

    return {
      id: `${accountId}:vercel-project:${p.id}`,
      pluginId: "vercel",
      resourceTypeId: "vercel-project",
      accountId,
      displayName: p.name,
      fields: fields({
        name: p.name,
        framework: p.framework,
        nodeVersion: p.nodeVersion,
        serverlessFunctionRegion: p.serverlessFunctionRegion,
        rootDirectory: p.rootDirectory,
        buildCommand: p.buildCommand,
        outputDirectory: p.outputDirectory,
        productionUrl: productionUrl,
        gitRepo: gitRepo || null,
        createdAt: formatTimestamp(p.createdAt),
        updatedAt: formatTimestamp(p.updatedAt),
        live: p.live ?? null,
      }),
      resolvedOutputs: {},
      secretStates: [],
      externalId: p.id,
      createdAt: formatTimestamp(p.createdAt),
      updatedAt: formatTimestamp(p.updatedAt),
    };
  }

  private mapDeployment(d: VercelDeployment, accountId: string): ResourceInstance {
    const meta = d.meta ?? {};
    const state = d.readyState ?? d.state ?? "UNKNOWN";

    return {
      id: `${accountId}:vercel-deployment:${d.uid}`,
      pluginId: "vercel",
      resourceTypeId: "vercel-deployment",
      accountId,
      displayName: d.url ?? d.name ?? d.uid,
      fields: fields({
        name: d.name,
        url: d.url ? `https://${d.url}` : null,
        state,
        target: d.target,
        source: d.source,
        projectId: d.projectId,
        creatorEmail: d.creator?.email ?? d.creator?.username,
        gitBranch: meta["githubCommitRef"] ?? meta["gitlabCommitRef"],
        gitCommitSha: meta["githubCommitSha"] ?? meta["gitlabCommitSha"],
        gitCommitMessage: meta["githubCommitMessage"] ?? meta["gitlabCommitMessage"],
        inspectorUrl: d.inspectorUrl,
        createdAt: formatTimestamp(d.created),
        readyAt: formatTimestamp(d.ready),
        framework: d.projectSettings?.framework,
      }),
      resolvedOutputs: {},
      secretStates: [],
      externalId: d.uid,
      createdAt: formatTimestamp(d.created),
      updatedAt: formatTimestamp(d.ready ?? d.created),
    };
  }

  private mapDomain(d: VercelDomain, accountId: string): ResourceInstance {
    return {
      id: `${accountId}:vercel-domain:${d.id}`,
      pluginId: "vercel",
      resourceTypeId: "vercel-domain",
      accountId,
      displayName: d.name,
      fields: fields({
        name: d.name,
        verified: String(d.verified),
        serviceType: d.serviceType,
        nameservers: d.nameservers.join(", "),
        intendedNameservers: d.intendedNameservers.join(", "),
        renew: d.renew != null ? String(d.renew) : null,
        expiresAt: formatTimestamp(d.expiresAt),
        boughtAt: formatTimestamp(d.boughtAt),
        createdAt: formatTimestamp(d.createdAt),
      }),
      resolvedOutputs: {},
      secretStates: [],
      externalId: d.id,
      createdAt: formatTimestamp(d.createdAt),
      updatedAt: formatTimestamp(d.createdAt),
    };
  }

  private mapEnvVar(
    env: VercelEnvVar,
    project: VercelProject,
    accountId: string,
  ): ResourceInstance {
    const envId = env.id ?? `${project.id}/${env.key}`;
    return {
      id: `${accountId}:vercel-env-var:${project.id}/${envId}`,
      pluginId: "vercel",
      resourceTypeId: "vercel-env-var",
      accountId,
      displayName: `${env.key} (${project.name})`,
      fields: fields({
        key: env.key,
        value: env.value,
        type: env.type,
        target: targetLabel(env.target),
        projectName: project.name,
        gitBranch: env.gitBranch,
        createdAt: formatTimestamp(env.createdAt),
        updatedAt: formatTimestamp(env.updatedAt),
      }),
      resolvedOutputs: {},
      secretStates: [],
      externalId: envId,
      parentResourceId: `${accountId}:vercel-project:${project.id}`,
      createdAt: formatTimestamp(env.createdAt),
      updatedAt: formatTimestamp(env.updatedAt),
    };
  }

  private mapTeam(t: VercelTeam, accountId: string): ResourceInstance {
    return {
      id: `${accountId}:vercel-team:${t.id}`,
      pluginId: "vercel",
      resourceTypeId: "vercel-team",
      accountId,
      displayName: t.name,
      fields: {
        name: t.name,
        slug: t.slug,
        createdAt: formatTimestamp(t.createdAt),
        updatedAt: formatTimestamp(t.updatedAt),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: t.id,
      createdAt: formatTimestamp(t.createdAt),
      updatedAt: formatTimestamp(t.updatedAt),
    };
  }

  /* ================================================================
   *  Detail renderers
   * ================================================================ */

  private renderProjectDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const framework = String(f["framework"] ?? "—");
    const productionUrl = String(f["productionUrl"] ?? "");

    return {
      title: resource.displayName,
      subtitle: `Vercel Project${framework !== "—" ? ` · ${framework}` : ""}`,
      status: {
        kind: "status-dot",
        status: f["live"] === true || f["live"] === "true" ? "healthy" : "degraded",
      },
      sections: [
        {
          kind: "section",
          title: "Project Info",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Project ID", value: String(resource.externalId ?? "—"), copyable: true },
                { key: "Name", value: String(f["name"] ?? "—") },
                { key: "Framework", value: framework },
                { key: "Node.js", value: String(f["nodeVersion"] ?? "—") },
                {
                  key: "Region",
                  value: String(f["serverlessFunctionRegion"] ?? "—"),
                },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Build Configuration",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Build Command", value: String(f["buildCommand"] ?? "—") },
                { key: "Output Directory", value: String(f["outputDirectory"] ?? "—") },
                { key: "Root Directory", value: String(f["rootDirectory"] ?? "—") },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Git & URLs",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Git Repository", value: String(f["gitRepo"] ?? "—") },
                {
                  key: "Production URL",
                  value: productionUrl || "—",
                  copyable: productionUrl !== "",
                },
                { key: "Created", value: String(f["createdAt"] ?? "—") },
                { key: "Updated", value: String(f["updatedAt"] ?? "—") },
              ],
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        {
          kind: "action",
          label: "Open in Vercel",
          action: {
            type: "open-url",
            url: `https://vercel.com/${this.teamId ? `${this.teamId}/` : ""}${String(f["name"] ?? "")}`,
          },
        },
        ...(productionUrl
          ? [
              {
                kind: "action" as const,
                label: "Visit Site",
                action: { type: "open-url" as const, url: productionUrl },
              },
            ]
          : []),
      ],
    };
  }

  private renderDeploymentDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const state = String(f["state"] ?? "UNKNOWN");
    const url = String(f["url"] ?? "");
    const inspectorUrl = String(f["inspectorUrl"] ?? "");

    return {
      title: resource.displayName,
      subtitle: `Deployment · ${state}${f["target"] ? ` · ${String(f["target"])}` : ""}`,
      status: { kind: "status-dot", status: deploymentStatus(state) },
      sections: [
        {
          kind: "section",
          title: "Deployment Info",
          children: [
            {
              kind: "key-value-list",
              items: [
                {
                  key: "Deployment ID",
                  value: String(resource.externalId ?? "—"),
                  copyable: true,
                },
                { key: "State", value: state },
                { key: "Target", value: String(f["target"] ?? "—") },
                { key: "Source", value: String(f["source"] ?? "—") },
                { key: "URL", value: url || "—", copyable: url !== "" },
                { key: "Creator", value: String(f["creatorEmail"] ?? "—") },
                { key: "Framework", value: String(f["framework"] ?? "—") },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Git Info",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Branch", value: String(f["gitBranch"] ?? "—") },
                {
                  key: "Commit SHA",
                  value: String(f["gitCommitSha"] ?? "—"),
                  copyable: f["gitCommitSha"] != null,
                },
                { key: "Commit Message", value: String(f["gitCommitMessage"] ?? "—") },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Timing",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Created", value: String(f["createdAt"] ?? "—") },
                { key: "Ready", value: String(f["readyAt"] ?? "—") },
              ],
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        ...(inspectorUrl
          ? [
              {
                kind: "action" as const,
                label: "Open Inspector",
                action: { type: "open-url" as const, url: inspectorUrl },
              },
            ]
          : []),
        ...(url
          ? [
              {
                kind: "action" as const,
                label: "Visit Deployment",
                action: { type: "open-url" as const, url },
              },
            ]
          : []),
      ],
    };
  }

  private renderDomainDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const verified = f["verified"] === "true" || f["verified"] === true;

    return {
      title: resource.displayName,
      subtitle: `Domain · ${verified ? "Verified" : "Unverified"}`,
      status: {
        kind: "status-dot",
        status: domainVerificationStatus(verified),
      },
      sections: [
        {
          kind: "section",
          title: "Domain Info",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Domain", value: String(f["name"] ?? "—"), copyable: true },
                {
                  key: "Verified",
                  value: verified ? "Yes" : "No",
                },
                { key: "Service Type", value: String(f["serviceType"] ?? "—") },
                { key: "Auto-Renew", value: String(f["renew"] ?? "—") },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "DNS",
          children: [
            {
              kind: "key-value-list",
              items: [
                {
                  key: "Nameservers",
                  value: String(f["nameservers"] ?? "—"),
                  copyable: true,
                },
                {
                  key: "Intended Nameservers",
                  value: String(f["intendedNameservers"] ?? "—"),
                },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Dates",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Created", value: String(f["createdAt"] ?? "—") },
                { key: "Expires", value: String(f["expiresAt"] ?? "—") },
                { key: "Bought", value: String(f["boughtAt"] ?? "—") },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderEnvVarDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;

    return {
      title: resource.displayName,
      subtitle: `Env Variable · ${String(f["type"] ?? "")}`,
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        {
          kind: "section",
          title: "Variable Info",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Key", value: String(f["key"] ?? "—"), copyable: true },
                { key: "Type", value: String(f["type"] ?? "—") },
                { key: "Target", value: String(f["target"] ?? "—") },
                { key: "Project", value: String(f["projectName"] ?? "—") },
                { key: "Git Branch", value: String(f["gitBranch"] ?? "—") },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Value",
          children: [
            {
              kind: "key-value-list",
              items: [
                {
                  key: "Value",
                  value: String(f["value"] ?? "(encrypted)"),
                  sensitive: true,
                },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Dates",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Created", value: String(f["createdAt"] ?? "—") },
                { key: "Updated", value: String(f["updatedAt"] ?? "—") },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderTeamDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;

    return {
      title: resource.displayName,
      subtitle: `Team · ${String(f["slug"] ?? "")}`,
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        {
          kind: "section",
          title: "Team Info",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Team ID", value: String(resource.externalId ?? "—"), copyable: true },
                { key: "Name", value: String(f["name"] ?? "—") },
                { key: "Slug", value: String(f["slug"] ?? "—"), copyable: true },
                { key: "Created", value: String(f["createdAt"] ?? "—") },
                { key: "Updated", value: String(f["updatedAt"] ?? "—") },
              ],
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        {
          kind: "action",
          label: "Open in Vercel",
          action: {
            type: "open-url",
            url: `https://vercel.com/${String(f["slug"] ?? "")}`,
          },
        },
      ],
    };
  }

  private renderGenericDetail(resource: ResourceInstance): DetailViewSchema {
    return {
      title: resource.displayName,
      subtitle: resource.resourceTypeId,
      status: { kind: "status-dot", status: "unknown" },
      sections: [
        {
          kind: "section",
          title: "Details",
          children: [
            {
              kind: "key-value-list",
              items: Object.entries(resource.fields).map(([key, value]) => ({
                key,
                value: String(value),
              })),
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }
}
