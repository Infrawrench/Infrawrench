import type {
  PluginClient,
  HostServices,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  CreateResourceConfig,
  ResourceStatus,
  DashboardStat,
  SectionNode,
} from "@infrawrench/plugin-base";
import { renderDnsRecordDetail, renderDnsRecordSidebar } from "@infrawrench/plugin-base";

// ---------------------------------------------------------------------------
// Netlify API response types
// ---------------------------------------------------------------------------

interface NetlifySite {
  id: string;
  state: string;
  plan: string;
  name: string;
  custom_domain: string | null;
  domain_aliases: string[];
  url: string;
  ssl_url: string;
  admin_url: string;
  screenshot_url: string | null;
  created_at: string;
  updated_at: string;
  ssl: boolean;
  force_ssl: boolean;
  managed_dns: boolean;
  deploy_url: string;
  deploy_hook: string;
  account_id: string;
  account_name: string;
  account_slug: string;
  git_provider: string;
  build_image: string;
  functions_region: string;
  id_domain: string;
  build_settings: NetlifyRepoInfo | null;
  published_deploy: NetlifyDeploy | null;
}

interface NetlifyRepoInfo {
  provider: string;
  repo_path: string;
  repo_branch: string;
  dir: string;
  functions_dir: string;
  cmd: string;
  repo_url: string;
  public_repo: boolean;
  stop_builds: boolean;
}

interface NetlifyDeploy {
  id: string;
  site_id: string;
  build_id: string;
  state: string;
  name: string;
  url: string;
  ssl_url: string;
  admin_url: string;
  deploy_url: string;
  deploy_ssl_url: string;
  error_message: string;
  branch: string;
  commit_ref: string;
  commit_url: string;
  skipped: boolean;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  title: string;
  context: string;
  locked: boolean;
  review_url: string;
  framework: string;
  draft: boolean;
}

interface NetlifyForm {
  id: string;
  site_id: string;
  name: string;
  paths: string[];
  submission_count: number;
  fields: unknown[];
  created_at: string;
}

interface NetlifyDnsZone {
  id: string;
  name: string;
  errors: string[];
  supported_record_types: string[];
  user_id: string;
  created_at: string;
  updated_at: string;
  dns_servers: string[];
  account_id: string;
  site_id: string;
  account_slug: string;
  account_name: string;
  domain: string;
  ipv6_enabled: boolean;
  dedicated: boolean;
}

interface NetlifyDnsRecord {
  id: string;
  hostname: string;
  type: string;
  value: string;
  ttl: number;
  priority: number;
  dns_zone_id: string;
  site_id: string;
  flag: number;
  tag: string;
  managed: boolean;
}

interface NetlifyBuildHook {
  id: string;
  title: string;
  branch: string;
  url: string;
  site_id: string;
  created_at: string;
}

interface NetlifyEnvVar {
  key: string;
  scopes: string[];
  values: Array<{
    value: string;
    context: string;
  }>;
  is_secret: boolean;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapSiteState(state: string): ResourceStatus {
  switch (state) {
    case "current":
      return "healthy";
    case "building":
    case "enqueued":
      return "provisioning";
    case "error":
      return "error";
    default:
      return "unknown";
  }
}

function mapDeployState(state: string): ResourceStatus {
  switch (state) {
    case "ready":
      return "healthy";
    case "building":
    case "enqueued":
    case "uploading":
    case "uploaded":
    case "preparing":
    case "prepared":
    case "processing":
      return "provisioning";
    case "error":
      return "error";
    case "skipped":
      return "degraded";
    default:
      return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Netlify plugin client.
 * Manages Netlify sites, deploys, forms, DNS zones, DNS records, build hooks,
 * and environment variables via the Netlify REST API (https://api.netlify.com/api/v1).
 */
export class NetlifyClient implements PluginClient {
  private readonly token: string;
  private readonly baseUrl = "https://api.netlify.com/api/v1";

  constructor(credentials: Record<string, string>, _services?: HostServices) {
    const token = credentials["accessToken"];
    if (!token) throw new Error("Netlify plugin: missing accessToken credential");
    this.token = token;
  }

  // ---- API helpers --------------------------------------------------------

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "Infrawrench/0.1.0",
      },
      ...options,
    });
    if (!res.ok) {
      throw new Error(`Netlify API error ${res.status} for ${path}: ${await res.text()}`);
    }
    if (res.status === 204) return undefined as unknown as T;
    return res.json() as Promise<T>;
  }

  /**
   * Paginate through all pages of a list endpoint.
   * Netlify uses `page` + `per_page` query params and a Link header.
   */
  private async paginate<T>(path: string, maxPages = 10): Promise<T[]> {
    const results: T[] = [];
    const separator = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= maxPages; page++) {
      const items = await this.fetch<T[]>(`${path}${separator}page=${page}&per_page=100`);
      results.push(...items);
      if (items.length < 100) break;
    }
    return results;
  }

  // ---- PluginClient interface ---------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "netlify-site":
        return this.listSites(accountId);
      case "netlify-deploy":
        return this.listAllDeploys(accountId);
      case "netlify-form":
        return this.listAllForms(accountId);
      case "netlify-dns-zone":
        return this.listDnsZones(accountId);
      case "netlify-dns-record":
        return this.listAllDnsRecords(accountId);
      case "netlify-build-hook":
        return this.listAllBuildHooks(accountId);
      case "netlify-env-var":
        return this.listAllEnvVars(accountId);
      default:
        throw new Error(`Netlify plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    // For sites we can fetch directly for freshness
    if (typeId === "netlify-site") {
      const siteId = resourceId.split(":").pop() ?? "";
      const site = await this.fetch<NetlifySite>(`/sites/${siteId}`);
      return this.mapSite(site, accountId);
    }
    // For others, look up in the full list
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`Netlify plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "netlify-site") {
      const siteId = resourceId.split(":").pop() ?? "";
      const site = await this.fetch<NetlifySite>(`/sites/${siteId}`);
      if (outputKey === "siteId") return site.id;
      if (outputKey === "siteName") return site.name;
      if (outputKey === "url") return site.url;
      if (outputKey === "sslUrl") return site.ssl_url;
      if (outputKey === "deployHook") return site.deploy_hook ?? "";
    }

    if (typeId === "netlify-deploy") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "deployId") return String(resource.externalId ?? "");
      if (outputKey === "deployUrl") return String(resource.fields["url"] ?? "");
    }

    if (typeId === "netlify-form") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "formId") return String(resource.externalId ?? "");
      if (outputKey === "formName") return String(resource.fields["name"] ?? "");
    }

    if (typeId === "netlify-dns-zone") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "zoneId") return String(resource.externalId ?? "");
      if (outputKey === "domain") return String(resource.fields["domain"] ?? "");
    }

    if (typeId === "netlify-dns-record") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "recordId") return String(resource.externalId ?? "");
      if (outputKey === "hostname") return String(resource.fields["name"] ?? "");
    }

    if (typeId === "netlify-build-hook") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "hookId") return String(resource.externalId ?? "");
      if (outputKey === "hookUrl") return String(resource.fields["url"] ?? "");
    }

    if (typeId === "netlify-env-var") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "envKey") return String(resource.fields["key"] ?? "");
    }

    throw new Error(`Netlify plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = resource.fields;

    switch (resourceTypeId) {
      case "netlify-site": {
        const state = String(f["state"] ?? "unknown");
        const variant =
          state === "current" ? "status-healthy" : state === "error" ? "status-error" : "default";
        return [
          { label: "State", value: state, variant },
          ...(f["customDomain"] ? [{ label: "Domain", value: String(f["customDomain"]) }] : []),
          ...(f["framework"] ? [{ label: "Framework", value: String(f["framework"]) }] : []),
        ];
      }
      case "netlify-dns-zone": {
        return [{ label: "Domain", value: String(f["domain"] ?? f["name"] ?? "") }];
      }
      default:
        return [];
    }
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "netlify-site":
        return this.renderSiteDetail(resource);
      case "netlify-deploy":
        return this.renderDeployDetail(resource);
      case "netlify-form":
        return this.renderFormDetail(resource);
      case "netlify-dns-zone":
        return this.renderDnsZoneDetail(resource);
      case "netlify-dns-record":
        return this.renderDnsRecordDetailView(resource);
      case "netlify-build-hook":
        return this.renderBuildHookDetail(resource);
      case "netlify-env-var":
        return this.renderEnvVarDetail(resource);
      default:
        return {
          title: resource.displayName,
          subtitle: resource.resourceTypeId,
          sections: [],
          headerActions: [
            { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
          ],
        };
    }
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    if (resource.resourceTypeId === "netlify-dns-record") {
      return renderDnsRecordSidebar(resource);
    }

    if (resource.resourceTypeId === "netlify-deploy") {
      const state = String(resource.fields["state"] ?? "unknown");
      const context = String(resource.fields["context"] ?? "");
      return {
        id: resource.id,
        label: `${context || "deploy"} · ${resource.displayName}`,
        status: { kind: "status-dot", status: mapDeployState(state) },
      };
    }

    if (resource.resourceTypeId === "netlify-env-var") {
      const isSecret = resource.fields["isSecret"] === true;
      return {
        id: resource.id,
        label: `${String(resource.fields["key"] ?? resource.displayName)}${isSecret ? " (secret)" : ""}`,
        status: { kind: "status-dot", status: "healthy" as const },
      };
    }

    const stateField = resource.fields["state"];
    const status = typeof stateField === "string" ? mapSiteState(stateField) : ("unknown" as const);

    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status },
    };
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === "netlify-site") {
      return {
        fields: [
          {
            key: "name",
            label: "Site Name",
            kind: "text",
            required: true,
            description: "A unique subdomain name (e.g. my-app → my-app.netlify.app)",
          },
        ],
      };
    }

    if (typeId === "netlify-dns-zone") {
      return {
        fields: [
          {
            key: "name",
            label: "Domain Name",
            kind: "text",
            required: true,
            description: "The domain name for the DNS zone (e.g. example.com)",
          },
        ],
      };
    }

    if (typeId === "netlify-dns-record") {
      // List DNS zones so user can pick which zone
      const zones = await this.fetch<NetlifyDnsZone[]>("/dns_zones");
      const zoneOptions = zones.map((z) => ({
        id: z.id,
        label: z.name || z.domain,
      }));

      return {
        fields: [
          {
            key: "zoneId",
            label: "DNS Zone",
            kind: "select",
            required: true,
            options: zoneOptions,
            ...(zoneOptions[0] ? { defaultValue: zoneOptions[0].id } : {}),
          },
          {
            key: "type",
            label: "Record Type",
            kind: "select",
            required: true,
            options: [
              { id: "A", label: "A" },
              { id: "AAAA", label: "AAAA" },
              { id: "CNAME", label: "CNAME" },
              { id: "MX", label: "MX" },
              { id: "TXT", label: "TXT" },
              { id: "NS", label: "NS" },
              { id: "SRV", label: "SRV" },
              { id: "CAA", label: "CAA" },
              { id: "ALIAS", label: "ALIAS" },
            ],
            defaultValue: "A",
          },
          {
            key: "hostname",
            label: "Hostname",
            kind: "text",
            required: true,
            description: "e.g. www or @ for the root",
          },
          {
            key: "value",
            label: "Value",
            kind: "text",
            required: true,
            description: "e.g. 192.168.1.1 for A records",
          },
          {
            key: "ttl",
            label: "TTL (seconds)",
            kind: "text",
            required: false,
            description: "Time to live — leave blank for default (3600)",
          },
        ],
      };
    }

    if (typeId === "netlify-build-hook") {
      const sites = await this.paginate<NetlifySite>("/sites");
      const siteOptions = sites.map((s) => ({
        id: s.id,
        label: s.name || s.id,
      }));

      return {
        fields: [
          {
            key: "siteId",
            label: "Site",
            kind: "select",
            required: true,
            options: siteOptions,
            ...(siteOptions[0] ? { defaultValue: siteOptions[0].id } : {}),
          },
          {
            key: "title",
            label: "Hook Name",
            kind: "text",
            required: true,
            description: "A descriptive name for this build hook (e.g. CMS publish)",
          },
          {
            key: "branch",
            label: "Branch",
            kind: "text",
            required: false,
            description: "Git branch to build — defaults to the production branch",
          },
        ],
      };
    }

    if (typeId === "netlify-env-var") {
      // Fetch sites for site selector
      const sites = await this.paginate<NetlifySite>("/sites");
      const siteOptions = sites.map((s) => ({
        id: String(s.id),
        label: s.name || String(s.id),
      }));

      return {
        fields: [
          {
            key: "siteId",
            label: "Site",
            kind: "select",
            required: true,
            options: siteOptions,
            ...(siteOptions[0] ? { defaultValue: siteOptions[0].id } : {}),
          },
          {
            key: "key",
            label: "Variable Key",
            kind: "text",
            required: true,
            description: "e.g. DATABASE_URL or API_KEY",
          },
          {
            key: "value",
            label: "Value",
            kind: "text",
            required: true,
          },
          {
            key: "context",
            label: "Context",
            kind: "select",
            required: true,
            options: [
              { id: "all", label: "All contexts" },
              { id: "production", label: "Production only" },
              { id: "deploy-preview", label: "Deploy previews only" },
              { id: "branch-deploy", label: "Branch deploys only" },
              { id: "dev", label: "Local development only" },
            ],
            defaultValue: "all",
          },
        ],
      };
    }

    throw new Error(`Netlify plugin: no create config for type "${typeId}"`);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId === "netlify-site") {
      const site = await this.fetch<NetlifySite>("/sites", {
        method: "POST",
        body: JSON.stringify({
          name: fields["name"],
        }),
      });
      return this.mapSite(site, accountId);
    }

    if (typeId === "netlify-dns-zone") {
      const zone = await this.fetch<NetlifyDnsZone>("/dns_zones", {
        method: "POST",
        body: JSON.stringify({
          name: fields["name"],
        }),
      });
      return this.mapDnsZone(zone, accountId);
    }

    if (typeId === "netlify-dns-record") {
      const zoneId = fields["zoneId"];
      if (!zoneId) throw new Error("Netlify plugin: zoneId is required to create a DNS record");
      const record = await this.fetch<NetlifyDnsRecord>(`/dns_zones/${zoneId}/dns_records`, {
        method: "POST",
        body: JSON.stringify({
          type: fields["type"],
          hostname: fields["hostname"],
          value: fields["value"],
          ...(fields["ttl"] ? { ttl: Number(fields["ttl"]) } : {}),
        }),
      });
      return this.mapDnsRecord(record, accountId, zoneId);
    }

    if (typeId === "netlify-build-hook") {
      const siteId = fields["siteId"];
      if (!siteId) throw new Error("Netlify plugin: siteId is required to create a build hook");
      const hook = await this.fetch<NetlifyBuildHook>(`/sites/${siteId}/build_hooks`, {
        method: "POST",
        body: JSON.stringify({
          title: fields["title"],
          ...(fields["branch"] ? { branch: fields["branch"] } : {}),
        }),
      });
      return this.mapBuildHook(hook, accountId, siteId);
    }

    if (typeId === "netlify-env-var") {
      const siteId = fields["siteId"];
      if (!siteId) throw new Error("Netlify plugin: siteId is required to create an env var");
      const context = fields["context"] || "all";
      const values = [{ context, value: fields["value"] }];

      await this.fetch<NetlifyEnvVar[]>(`/sites/${siteId}/env`, {
        method: "POST",
        body: JSON.stringify([
          {
            key: fields["key"],
            scopes: ["builds", "functions", "runtime", "post-processing"],
            values,
          },
        ]),
      });

      const now = new Date().toISOString();
      return {
        id: `${accountId}:netlify-env-var:${siteId}/${fields["key"]}`,
        pluginId: "netlify",
        resourceTypeId: "netlify-env-var",
        accountId,
        displayName: fields["key"] ?? "",
        fields: {
          key: fields["key"] ?? "",
          scopes: "builds, functions, runtime, post-processing",
          contexts: context,
          isSecret: false,
          updatedAt: now,
        },
        resolvedOutputs: { envKey: fields["key"] ?? "" },
        secretStates: [],
        parentResourceId: `${accountId}:netlify-site:${siteId}`,
        createdAt: now,
        updatedAt: now,
      };
    }

    throw new Error(`Netlify plugin: createResource not supported for type "${typeId}"`);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    if (typeId === "netlify-site") {
      const siteId = resourceId.split(":").pop();
      if (!siteId) throw new Error("Netlify plugin: cannot parse site ID");
      await this.fetch<unknown>(`/sites/${siteId}`, { method: "DELETE" });
      return;
    }

    if (typeId === "netlify-deploy") {
      const deployId = resourceId.split(":").pop();
      if (!deployId) throw new Error("Netlify plugin: cannot parse deploy ID");
      await this.fetch<unknown>(`/deploys/${deployId}`, { method: "DELETE" });
      return;
    }

    if (typeId === "netlify-form") {
      // resource ID format: {accountId}:netlify-form:{siteId}/{formId}
      const compound = resourceId.split(":").pop();
      if (!compound) throw new Error("Netlify plugin: cannot parse form ID");
      const [siteId, formId] = compound.split("/");
      if (!siteId || !formId) throw new Error("Netlify plugin: cannot parse form ID");
      await this.fetch<unknown>(`/sites/${siteId}/forms/${formId}`, { method: "DELETE" });
      return;
    }

    if (typeId === "netlify-dns-zone") {
      const zoneId = resourceId.split(":").pop();
      if (!zoneId) throw new Error("Netlify plugin: cannot parse DNS zone ID");
      await this.fetch<unknown>(`/dns_zones/${zoneId}`, { method: "DELETE" });
      return;
    }

    if (typeId === "netlify-dns-record") {
      // resource ID format: {accountId}:netlify-dns-record:{zoneId}/{recordId}
      const compound = resourceId.split(":").pop();
      if (!compound) throw new Error("Netlify plugin: cannot parse DNS record ID");
      const [zoneId, recordId] = compound.split("/");
      if (!zoneId || !recordId) throw new Error("Netlify plugin: cannot parse DNS record ID");
      await this.fetch<unknown>(`/dns_zones/${zoneId}/dns_records/${recordId}`, {
        method: "DELETE",
      });
      return;
    }

    if (typeId === "netlify-build-hook") {
      // resource ID format: {accountId}:netlify-build-hook:{siteId}/{hookId}
      const compound = resourceId.split(":").pop();
      if (!compound) throw new Error("Netlify plugin: cannot parse build hook ID");
      const [siteId, hookId] = compound.split("/");
      if (!siteId || !hookId) throw new Error("Netlify plugin: cannot parse build hook ID");
      await this.fetch<unknown>(`/sites/${siteId}/build_hooks/${hookId}`, { method: "DELETE" });
      return;
    }

    if (typeId === "netlify-env-var") {
      // resource ID format: {accountId}:netlify-env-var:{siteId}/{key}
      const compound = resourceId.split(":").pop();
      if (!compound) throw new Error("Netlify plugin: cannot parse env var");
      const slashIdx = compound.indexOf("/");
      if (slashIdx < 0) throw new Error("Netlify plugin: cannot parse env var");
      const siteId = compound.slice(0, slashIdx);
      const key = compound.slice(slashIdx + 1);
      await this.fetch<unknown>(`/sites/${siteId}/env/${encodeURIComponent(key)}`, {
        method: "DELETE",
      });
      return;
    }

    throw new Error(`Netlify plugin: deleteResource not supported for type "${typeId}"`);
  }

  // ---- List helpers -------------------------------------------------------

  private async listSites(accountId: string): Promise<ResourceInstance[]> {
    try {
      const sites = await this.paginate<NetlifySite>("/sites");
      return sites.map((s) => this.mapSite(s, accountId));
    } catch {
      return [];
    }
  }

  private mapSite(s: NetlifySite, accountId: string): ResourceInstance {
    const pubDeploy = s.published_deploy;
    const framework = pubDeploy?.framework ?? "";
    return {
      id: `${accountId}:netlify-site:${s.id}`,
      pluginId: "netlify",
      resourceTypeId: "netlify-site",
      accountId,
      displayName: s.name || s.id,
      fields: {
        name: s.name,
        url: s.url,
        sslUrl: s.ssl_url,
        customDomain: s.custom_domain ?? "",
        state: pubDeploy?.state ?? s.state ?? "",
        plan: s.plan ?? "",
        repoUrl: s.build_settings?.repo_url ?? "",
        repoBranch: s.build_settings?.repo_branch ?? "",
        buildCommand: s.build_settings?.cmd ?? "",
        publishDir: s.build_settings?.dir ?? "",
        framework,
        functionsRegion: s.functions_region ?? "",
        ssl: s.ssl ?? false,
        forceSsl: s.force_ssl ?? false,
        managedDns: s.managed_dns ?? false,
        accountName: s.account_name ?? "",
        createdAt: s.created_at,
        updatedAt: s.updated_at,
      },
      resolvedOutputs: {
        siteId: s.id,
        siteName: s.name,
        url: s.url,
        sslUrl: s.ssl_url,
      },
      secretStates: [],
      externalId: s.id,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
    };
  }

  private async listAllDeploys(accountId: string): Promise<ResourceInstance[]> {
    try {
      const sites = await this.paginate<NetlifySite>("/sites");
      const results: ResourceInstance[] = [];
      for (const site of sites) {
        try {
          const deploys = await this.fetch<NetlifyDeploy[]>(`/sites/${site.id}/deploys?per_page=5`);
          for (const d of deploys) {
            results.push(this.mapDeploy(d, accountId, site.id));
          }
        } catch {
          // Skip sites we can't read deploys for
        }
      }
      return results;
    } catch {
      return [];
    }
  }

  private mapDeploy(d: NetlifyDeploy, accountId: string, siteId: string): ResourceInstance {
    const shortRef = d.commit_ref ? d.commit_ref.slice(0, 8) : "";
    const label = d.title || shortRef || d.id.slice(0, 8);
    return {
      id: `${accountId}:netlify-deploy:${d.id}`,
      pluginId: "netlify",
      resourceTypeId: "netlify-deploy",
      accountId,
      displayName: label,
      fields: {
        state: d.state,
        context: d.context ?? "",
        branch: d.branch ?? "",
        commitRef: d.commit_ref ?? "",
        commitUrl: d.commit_url ?? "",
        title: d.title ?? "",
        url: d.deploy_ssl_url || d.deploy_url || d.url || "",
        sslUrl: d.ssl_url ?? "",
        errorMessage: d.error_message ?? "",
        framework: d.framework ?? "",
        draft: d.draft ?? false,
        locked: d.locked ?? false,
        skipped: d.skipped ?? false,
        createdAt: d.created_at,
        publishedAt: d.published_at ?? "",
      },
      resolvedOutputs: {
        deployId: d.id,
        deployUrl: d.deploy_ssl_url || d.deploy_url || "",
      },
      secretStates: [],
      externalId: d.id,
      parentResourceId: `${accountId}:netlify-site:${siteId}`,
      createdAt: d.created_at,
      updatedAt: d.updated_at,
    };
  }

  private async listAllForms(accountId: string): Promise<ResourceInstance[]> {
    try {
      const sites = await this.paginate<NetlifySite>("/sites");
      const results: ResourceInstance[] = [];
      for (const site of sites) {
        try {
          const forms = await this.fetch<NetlifyForm[]>(`/sites/${site.id}/forms`);
          for (const f of forms) {
            results.push(this.mapForm(f, accountId, site.id));
          }
        } catch {
          // Skip sites we can't read forms for
        }
      }
      return results;
    } catch {
      return [];
    }
  }

  private mapForm(f: NetlifyForm, accountId: string, siteId: string): ResourceInstance {
    return {
      id: `${accountId}:netlify-form:${siteId}/${f.id}`,
      pluginId: "netlify",
      resourceTypeId: "netlify-form",
      accountId,
      displayName: f.name || f.id,
      fields: {
        name: f.name,
        submissionCount: f.submission_count ?? 0,
        paths: Array.isArray(f.paths) ? f.paths.join(", ") : "",
        createdAt: f.created_at,
      },
      resolvedOutputs: {
        formId: f.id,
        formName: f.name,
      },
      secretStates: [],
      externalId: f.id,
      parentResourceId: `${accountId}:netlify-site:${siteId}`,
      createdAt: f.created_at,
      updatedAt: f.created_at,
    };
  }

  private async listDnsZones(accountId: string): Promise<ResourceInstance[]> {
    try {
      const zones = await this.fetch<NetlifyDnsZone[]>("/dns_zones");
      return zones.map((z) => this.mapDnsZone(z, accountId));
    } catch {
      return [];
    }
  }

  private mapDnsZone(z: NetlifyDnsZone, accountId: string): ResourceInstance {
    return {
      id: `${accountId}:netlify-dns-zone:${z.id}`,
      pluginId: "netlify",
      resourceTypeId: "netlify-dns-zone",
      accountId,
      displayName: z.name || z.domain,
      fields: {
        name: z.name,
        domain: z.domain ?? "",
        dnsServers: Array.isArray(z.dns_servers) ? z.dns_servers.join(", ") : "",
        supportedRecordTypes: Array.isArray(z.supported_record_types)
          ? z.supported_record_types.join(", ")
          : "",
        ipv6Enabled: z.ipv6_enabled ?? false,
        dedicated: z.dedicated ?? false,
        accountName: z.account_name ?? "",
        createdAt: z.created_at,
        updatedAt: z.updated_at,
      },
      resolvedOutputs: {
        zoneId: z.id,
        domain: z.domain ?? z.name,
      },
      secretStates: [],
      externalId: z.id,
      createdAt: z.created_at,
      updatedAt: z.updated_at,
    };
  }

  private async listAllDnsRecords(accountId: string): Promise<ResourceInstance[]> {
    try {
      const zones = await this.fetch<NetlifyDnsZone[]>("/dns_zones");
      const results: ResourceInstance[] = [];
      for (const zone of zones) {
        try {
          const records = await this.fetch<NetlifyDnsRecord[]>(`/dns_zones/${zone.id}/dns_records`);
          for (const r of records) {
            results.push(this.mapDnsRecord(r, accountId, zone.id));
          }
        } catch {
          // Skip zones we can't read records for
        }
      }
      return results;
    } catch {
      return [];
    }
  }

  private mapDnsRecord(r: NetlifyDnsRecord, accountId: string, zoneId: string): ResourceInstance {
    return {
      id: `${accountId}:netlify-dns-record:${zoneId}/${r.id}`,
      pluginId: "netlify",
      resourceTypeId: "netlify-dns-record",
      accountId,
      displayName: `${r.type} ${r.hostname}`,
      fields: {
        name: r.hostname ?? "",
        type: r.type ?? "",
        content: r.value ?? "",
        ttl: r.ttl ?? 0,
        priority: r.priority ?? 0,
        managed: r.managed ?? false,
        tag: r.tag ?? "",
        flag: r.flag ?? 0,
      },
      resolvedOutputs: {
        recordId: r.id,
        hostname: r.hostname ?? "",
      },
      secretStates: [],
      externalId: r.id,
      parentResourceId: `${accountId}:netlify-dns-zone:${zoneId}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  private async listAllBuildHooks(accountId: string): Promise<ResourceInstance[]> {
    try {
      const sites = await this.paginate<NetlifySite>("/sites");
      const results: ResourceInstance[] = [];
      for (const site of sites) {
        try {
          const hooks = await this.fetch<NetlifyBuildHook[]>(`/sites/${site.id}/build_hooks`);
          for (const h of hooks) {
            results.push(this.mapBuildHook(h, accountId, site.id));
          }
        } catch {
          // Skip sites we can't read build hooks for
        }
      }
      return results;
    } catch {
      return [];
    }
  }

  private mapBuildHook(h: NetlifyBuildHook, accountId: string, siteId: string): ResourceInstance {
    return {
      id: `${accountId}:netlify-build-hook:${siteId}/${h.id}`,
      pluginId: "netlify",
      resourceTypeId: "netlify-build-hook",
      accountId,
      displayName: h.title || h.id,
      fields: {
        title: h.title ?? "",
        branch: h.branch ?? "",
        url: h.url ?? "",
        createdAt: h.created_at ?? "",
      },
      resolvedOutputs: {
        hookId: h.id,
        hookUrl: h.url ?? "",
      },
      secretStates: [],
      externalId: h.id,
      parentResourceId: `${accountId}:netlify-site:${siteId}`,
      createdAt: h.created_at ?? new Date().toISOString(),
      updatedAt: h.created_at ?? new Date().toISOString(),
    };
  }

  private async listAllEnvVars(accountId: string): Promise<ResourceInstance[]> {
    try {
      const sites = await this.paginate<NetlifySite>("/sites");
      const results: ResourceInstance[] = [];
      for (const site of sites) {
        try {
          const envVars = await this.fetch<NetlifyEnvVar[]>(`/sites/${site.id}/env`);
          for (const ev of envVars) {
            results.push(this.mapEnvVar(ev, accountId, site.id));
          }
        } catch {
          // Skip sites we can't read env vars for
        }
      }
      return results;
    } catch {
      return [];
    }
  }

  private mapEnvVar(ev: NetlifyEnvVar, accountId: string, siteId: string): ResourceInstance {
    const contexts = Array.isArray(ev.values)
      ? [...new Set(ev.values.map((v) => v.context))].join(", ")
      : "";
    return {
      id: `${accountId}:netlify-env-var:${siteId}/${ev.key}`,
      pluginId: "netlify",
      resourceTypeId: "netlify-env-var",
      accountId,
      displayName: ev.key,
      fields: {
        key: ev.key,
        scopes: Array.isArray(ev.scopes) ? ev.scopes.join(", ") : "",
        contexts,
        isSecret: ev.is_secret ?? false,
        updatedAt: ev.updated_at ?? "",
      },
      resolvedOutputs: {
        envKey: ev.key,
      },
      secretStates: [],
      externalId: ev.key,
      parentResourceId: `${accountId}:netlify-site:${siteId}`,
      createdAt: ev.updated_at ?? new Date().toISOString(),
      updatedAt: ev.updated_at ?? new Date().toISOString(),
    };
  }

  // ---- Render helpers -----------------------------------------------------

  private renderSiteDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const state = String(f["state"] ?? "unknown");

    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Site Info",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Name", value: String(f["name"] ?? ""), copyable: true },
              ...(f["customDomain"]
                ? [{ key: "Custom Domain", value: String(f["customDomain"]), copyable: true }]
                : []),
              { key: "URL", value: String(f["sslUrl"] || f["url"] || ""), copyable: true },
              { key: "State", value: state },
              ...(f["plan"] ? [{ key: "Plan", value: String(f["plan"]) }] : []),
              ...(f["accountName"] ? [{ key: "Team", value: String(f["accountName"]) }] : []),
              ...(f["functionsRegion"]
                ? [{ key: "Functions Region", value: String(f["functionsRegion"]) }]
                : []),
            ],
          },
        ],
      },
    ];

    // Build settings section
    if (f["repoUrl"] || f["buildCommand"]) {
      sections.push({
        kind: "section",
        title: "Build Settings",
        children: [
          {
            kind: "key-value-list",
            items: [
              ...(f["repoUrl"]
                ? [{ key: "Repository", value: String(f["repoUrl"]), copyable: true }]
                : []),
              ...(f["repoBranch"]
                ? [{ key: "Production Branch", value: String(f["repoBranch"]) }]
                : []),
              ...(f["buildCommand"]
                ? [{ key: "Build Command", value: String(f["buildCommand"]) }]
                : []),
              ...(f["publishDir"]
                ? [{ key: "Publish Directory", value: String(f["publishDir"]) }]
                : []),
              ...(f["framework"] ? [{ key: "Framework", value: String(f["framework"]) }] : []),
            ],
          },
        ],
      });
    }

    // SSL section
    sections.push({
      kind: "section",
      title: "Security",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "SSL", value: f["ssl"] ? "Enabled" : "Disabled" },
            { key: "Force SSL", value: f["forceSsl"] ? "Yes" : "No" },
            { key: "Managed DNS", value: f["managedDns"] ? "Yes" : "No" },
          ],
        },
      ],
    });

    // Timestamps
    sections.push({
      kind: "section",
      title: "Timestamps",
      children: [
        {
          kind: "key-value-list",
          items: [
            ...(f["createdAt"] ? [{ key: "Created", value: String(f["createdAt"]) }] : []),
            ...(f["updatedAt"] ? [{ key: "Updated", value: String(f["updatedAt"]) }] : []),
          ],
        },
      ],
    });

    return {
      title: resource.displayName,
      subtitle: "Netlify Site",
      status: { kind: "status-dot", status: mapSiteState(state), label: state },
      sections,
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        ...(f["sslUrl"] || f["url"]
          ? [
              {
                kind: "action" as const,
                label: "Open Site",
                action: {
                  type: "open-url" as const,
                  url: String(f["sslUrl"] || f["url"]),
                },
              },
            ]
          : []),
      ],
    };
  }

  private renderDeployDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const state = String(f["state"] ?? "unknown");
    return {
      title: resource.displayName,
      subtitle: `${String(f["context"] ?? "deploy")} · ${String(f["branch"] ?? "")}`,
      status: { kind: "status-dot", status: mapDeployState(state), label: state },
      sections: [
        {
          kind: "section",
          title: "Deploy Info",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "State", value: state },
                ...(f["context"] ? [{ key: "Context", value: String(f["context"]) }] : []),
                ...(f["branch"] ? [{ key: "Branch", value: String(f["branch"]) }] : []),
                ...(f["commitRef"]
                  ? [
                      {
                        key: "Commit",
                        value: String(f["commitRef"]).slice(0, 8),
                        copyable: true,
                      },
                    ]
                  : []),
                ...(f["title"] ? [{ key: "Title", value: String(f["title"]) }] : []),
                ...(f["framework"] ? [{ key: "Framework", value: String(f["framework"]) }] : []),
                ...(f["errorMessage"] ? [{ key: "Error", value: String(f["errorMessage"]) }] : []),
                ...(f["url"]
                  ? [{ key: "Deploy URL", value: String(f["url"]), copyable: true }]
                  : []),
                { key: "Draft", value: f["draft"] ? "Yes" : "No" },
                { key: "Locked", value: f["locked"] ? "Yes" : "No" },
                ...(f["createdAt"] ? [{ key: "Created", value: String(f["createdAt"]) }] : []),
                ...(f["publishedAt"]
                  ? [{ key: "Published", value: String(f["publishedAt"]) }]
                  : []),
              ],
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        ...(f["url"]
          ? [
              {
                kind: "action" as const,
                label: "Open",
                action: { type: "open-url" as const, url: String(f["url"]) },
              },
            ]
          : []),
      ],
    };
  }

  private renderFormDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    return {
      title: resource.displayName,
      subtitle: "Netlify Form",
      sections: [
        {
          kind: "section",
          title: "Form Info",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Name", value: String(f["name"] ?? ""), copyable: true },
                { key: "Submissions", value: String(f["submissionCount"] ?? 0) },
                ...(f["paths"] ? [{ key: "Paths", value: String(f["paths"]) }] : []),
                ...(f["createdAt"] ? [{ key: "Created", value: String(f["createdAt"]) }] : []),
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderDnsZoneDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    return {
      title: resource.displayName,
      subtitle: "Netlify DNS Zone",
      status: { kind: "status-dot", status: "healthy" as ResourceStatus, label: "Active" },
      sections: [
        {
          kind: "section",
          title: "Zone Info",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Name", value: String(f["name"] ?? ""), copyable: true },
                ...(f["domain"]
                  ? [{ key: "Domain", value: String(f["domain"]), copyable: true }]
                  : []),
                ...(f["dnsServers"]
                  ? [{ key: "DNS Servers", value: String(f["dnsServers"]) }]
                  : []),
                ...(f["supportedRecordTypes"]
                  ? [{ key: "Supported Records", value: String(f["supportedRecordTypes"]) }]
                  : []),
                { key: "IPv6", value: f["ipv6Enabled"] ? "Enabled" : "Disabled" },
                { key: "Dedicated", value: f["dedicated"] ? "Yes" : "No" },
                ...(f["accountName"] ? [{ key: "Team", value: String(f["accountName"]) }] : []),
                ...(f["createdAt"] ? [{ key: "Created", value: String(f["createdAt"]) }] : []),
                ...(f["updatedAt"] ? [{ key: "Updated", value: String(f["updatedAt"]) }] : []),
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderDnsRecordDetailView(resource: ResourceInstance): DetailViewSchema {
    return renderDnsRecordDetail(resource);
  }

  private renderBuildHookDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    return {
      title: resource.displayName,
      subtitle: "Build Hook",
      sections: [
        {
          kind: "section",
          title: "Hook Info",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Title", value: String(f["title"] ?? ""), copyable: true },
                ...(f["branch"] ? [{ key: "Branch", value: String(f["branch"]) }] : []),
                ...(f["url"] ? [{ key: "URL", value: String(f["url"]), copyable: true }] : []),
                ...(f["createdAt"] ? [{ key: "Created", value: String(f["createdAt"]) }] : []),
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
    const isSecret = f["isSecret"] === true;
    return {
      title: String(f["key"] ?? resource.displayName),
      subtitle: `Environment Variable${isSecret ? " (secret)" : ""}`,
      status: {
        kind: "status-dot",
        status: "healthy" as ResourceStatus,
        label: isSecret ? "Secret" : "Visible",
      },
      sections: [
        {
          kind: "section",
          title: "Variable Info",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Key", value: String(f["key"] ?? ""), copyable: true },
                ...(f["scopes"] ? [{ key: "Scopes", value: String(f["scopes"]) }] : []),
                ...(f["contexts"] ? [{ key: "Contexts", value: String(f["contexts"]) }] : []),
                { key: "Secret", value: isSecret ? "Yes" : "No" },
                ...(f["updatedAt"] ? [{ key: "Updated", value: String(f["updatedAt"]) }] : []),
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }
}
