import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
import type {
  ActionNode,
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
import {
  dnsContentField,
  joinSubtitle,
  pathEncode,
  renderDnsRecordDetail,
  renderDnsRecordSidebar,
  withinListCap,
} from "@infrawrench/plugin-base";
import {
  createNetlifyApi,
  isRefusal,
  type NetlifyApi,
  type NetlifyBuildHook,
  type NetlifyDbBranch,
  type NetlifyDbSnapshot,
  type NetlifyDeploy,
  type NetlifyDnsRecord,
  type NetlifyDnsZone,
  type NetlifyEnvVar,
  type NetlifyForm,
  type NetlifyHook,
  type NetlifySite,
  type NetlifySiteUpdate,
  type NetlifySniCertificate,
  type NetlifySnippet,
  type NetlifySubmission,
} from "./api.js";

/** A field of a stored resource, which may not be there. */
type FieldValue = ResourceInstance["fields"][string] | undefined;

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
      return "info";
  }
}

/**
 * A site's `state` is its published deploy's when it has one (`mapSite`), and its own,
 * which reads `current`, when it does not.
 */
function mapSiteState(state: string): ResourceStatus {
  return state === "current" ? "healthy" : mapDeployState(state);
}

export class NetlifyClient implements PluginClient {
  private readonly api: NetlifyApi["pages"];
  private readonly links: NetlifyApi["links"];

  constructor(credentials: Credentials, services?: HostServices) {
    const accessToken = credentials["accessToken"];
    if (!accessToken) throw new Error("Netlify plugin: missing accessToken credential");
    const { pages, links } = createNetlifyApi({
      accessToken,
      caCert: credentials["caCert"] ?? "",
      http: services?.http,
    });
    this.api = pages;
    this.links = links;
  }

  private allSites(): Promise<NetlifySite[]> {
    return this.api.getAll("/sites", null);
  }

  /** For a create form, which can offer the sites it read when there are too many to read. */
  private pickableSites(): Promise<NetlifySite[]> {
    return this.api.getAll("/sites", null, { partial: true });
  }

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
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
        case "netlify-notification-hook":
          return eachParent(await this.allSites(), async (site) =>
            (await this.links.getAll("/hooks", null, { query: { site_id: site.id } })).map((h) =>
              this.mapHook(h, accountId, site.id),
            ),
          );
        case "netlify-snippet":
          return eachParent(await this.allSites(), async (site) =>
            (await this.links.getAll(`/sites/${pathEncode(site.id)}/snippets`, null)).map((sn) =>
              this.mapSnippet(sn, accountId, site.id),
            ),
          );
        case "netlify-database":
          // Sites without a database answer 404, which eachParent reads as none.
          return eachParent(await this.allSites(), async (site) => [
            this.mapDatabase(
              site,
              (await this.api.get(`/sites/${pathEncode(site.id)}/database/branches`)).branches ??
                [],
              accountId,
            ),
          ]);
        default:
          throw new Error(`Netlify plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      // For sites we can fetch directly for freshness
      if (typeId === "netlify-site") {
        const siteId = resourceId.split(":").pop() ?? "";
        const site = await this.api.get(`/sites/${pathEncode(siteId)}`);
        return this.mapSite(site, accountId);
      }
      if (typeId === "netlify-deploy") {
        const deploy = await this.api.get(
          `/deploys/${pathEncode(resourceId.split(":").pop() ?? "")}`,
        );
        return this.mapDeploy(deploy, accountId, deploy.site_id ?? "");
      }
      if (typeId === "netlify-database") {
        const siteId = resourceId.split(":").pop() ?? "";
        const [site, branches] = await Promise.all([
          this.api.get(`/sites/${pathEncode(siteId)}`),
          this.api.get(`/sites/${pathEncode(siteId)}/database/branches`),
        ]);
        return this.mapDatabase(site, branches.branches ?? [], accountId);
      }
      // For others, look up in the full list
      const all = await runPluginEffect(this.listResources(typeId, accountId));
      const found = all.find((r) => r.id === resourceId);
      if (!found) throw new Error(`Netlify plugin: resource ${typeId}/${resourceId} not found`);
      return found;
    });
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      if (typeId === "netlify-site") {
        const siteId = resourceId.split(":").pop() ?? "";
        const site = await this.api.get(`/sites/${pathEncode(siteId)}`);
        if (outputKey === "siteId") return site.id;
        if (outputKey === "siteName") return site.name;
        if (outputKey === "url") return site.url ?? "";
        if (outputKey === "sslUrl") return site.ssl_url ?? "";
        if (outputKey === "deployHook") return site.deploy_hook ?? "";
      }

      if (typeId === "netlify-deploy") {
        const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
        if (outputKey === "deployId") return String(resource.externalId ?? "");
        if (outputKey === "deployUrl") return String(resource.fields["url"] ?? "");
      }

      if (typeId === "netlify-form") {
        const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
        if (outputKey === "formId") return String(resource.externalId ?? "");
        if (outputKey === "formName") return String(resource.fields["name"] ?? "");
      }

      if (typeId === "netlify-dns-zone") {
        const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
        if (outputKey === "zoneId") return String(resource.externalId ?? "");
        if (outputKey === "domain") return String(resource.fields["domain"] ?? "");
      }

      if (typeId === "netlify-dns-record") {
        const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
        if (outputKey === "recordId") return String(resource.externalId ?? "");
        if (outputKey === "hostname") return String(resource.fields["name"] ?? "");
      }

      if (typeId === "netlify-build-hook") {
        const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
        if (outputKey === "hookId") return String(resource.externalId ?? "");
        if (outputKey === "hookUrl") return String(resource.fields["url"] ?? "");
      }

      if (typeId === "netlify-env-var") {
        const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
        if (outputKey === "envKey") return String(resource.fields["key"] ?? "");
      }

      if (typeId === "netlify-notification-hook" && outputKey === "hookId") {
        return splitSiteChild(resourceId).childId;
      }

      if (typeId === "netlify-snippet" && outputKey === "snippetId") {
        return splitSiteChild(resourceId).childId;
      }

      if (typeId === "netlify-database" && outputKey === "connectionString") {
        const siteId = resourceId.split(":").pop() ?? "";
        return (
          (await this.api.get(`/sites/${pathEncode(siteId)}/database`)).connection_string ?? ""
        );
      }

      throw new Error(`Netlify plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
    });
  }

  fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      const resource = await runPluginEffect(
        this.getResource(resourceTypeId, resourceId, accountId),
      );
      const f = resource.fields;

      switch (resourceTypeId) {
        case "netlify-site": {
          const state = String(f["state"] ?? "unknown");
          const status = mapSiteState(state);
          const variant =
            status === "healthy"
              ? "status-healthy"
              : status === "error"
                ? "status-error"
                : "default";
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
    });
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
      case "netlify-notification-hook":
        return this.renderHookDetail(resource);
      case "netlify-snippet":
        return this.renderSnippetDetail(resource);
      case "netlify-database":
        return this.renderDatabaseDetail(resource);
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

    if (resource.resourceTypeId === "netlify-notification-hook") {
      return {
        id: resource.id,
        label: resource.displayName,
        status: {
          kind: "status-dot",
          status: resource.fields["disabled"] === true ? "degraded" : "healthy",
        },
      };
    }

    if (resource.resourceTypeId === "netlify-snippet") {
      return {
        id: resource.id,
        label: resource.displayName,
        status: { kind: "status-dot", status: "healthy" },
      };
    }

    if (resource.resourceTypeId === "netlify-database") {
      return {
        id: resource.id,
        label: resource.displayName,
        status: { kind: "status-dot", status: mapDbState(String(resource.fields["state"] ?? "")) },
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
    const status = typeof stateField === "string" ? mapSiteState(stateField) : ("info" as const);

    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status },
    };
  }

  getCreateConfig(typeId: string, parentResourceId?: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
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
        const zoneField = !parentResourceId
          ? await (async () => {
              const zones = await this.links.getAll("/dns_zones", null, { partial: true });
              const zoneOptions = zones.map((z) => ({
                id: z.id,
                label: z.name || z.domain || z.id,
              }));
              return [
                {
                  key: "zoneId",
                  label: "DNS Zone",
                  kind: "select" as const,
                  required: true,
                  options: zoneOptions,
                  ...(zoneOptions[0] ? { defaultValue: zoneOptions[0].id } : {}),
                },
              ];
            })()
          : [];

        return {
          fields: [
            ...zoneField,
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
            ...dnsContentField({
              key: "value",
              label: "Value",
              placeholder: "e.g. 192.168.1.1 for A records",
            }),
            {
              key: "ttl",
              label: "TTL (seconds)",
              kind: "text",
              required: false,
              description: "Time to live; leave blank for default (3600)",
            },
            {
              key: "priority",
              label: "Priority",
              kind: "number",
              required: true,
              defaultValue: "10",
              description: "Lower numbers are tried first",
              showWhen: { fieldKey: "type", fieldValues: ["MX", "SRV"] },
            },
            {
              key: "weight",
              label: "Weight",
              kind: "number",
              required: true,
              defaultValue: "0",
              description: "How to share traffic between records of the same priority",
              showWhen: { fieldKey: "type", fieldValue: "SRV" },
            },
            {
              key: "port",
              label: "Port",
              kind: "number",
              required: true,
              description: "The port the service listens on",
              showWhen: { fieldKey: "type", fieldValue: "SRV" },
            },
            {
              key: "flag",
              label: "Flag",
              kind: "number",
              required: true,
              defaultValue: "0",
              description: "128 tells a certificate authority not to skip a tag it does not know",
              showWhen: { fieldKey: "type", fieldValue: "CAA" },
            },
            {
              key: "tag",
              label: "Tag",
              kind: "select",
              required: true,
              defaultValue: "issue",
              options: [
                { id: "issue", label: "issue: may issue certificates" },
                { id: "issuewild", label: "issuewild: may issue wildcard certificates" },
                { id: "iodef", label: "iodef: where to report a violation" },
              ],
              showWhen: { fieldKey: "type", fieldValue: "CAA" },
            },
          ],
        };
      }

      if (typeId === "netlify-build-hook") {
        const siteField = !parentResourceId
          ? await (async () => {
              const sites = await this.pickableSites();
              const siteOptions = sites.map((s) => ({
                id: s.id,
                label: s.name || s.id,
              }));
              return [
                {
                  key: "siteId",
                  label: "Site",
                  kind: "select" as const,
                  required: true,
                  options: siteOptions,
                  ...(siteOptions[0] ? { defaultValue: siteOptions[0].id } : {}),
                },
              ];
            })()
          : [];

        return {
          fields: [
            ...siteField,
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
              description: "Git branch to build; defaults to the production branch",
            },
          ],
        };
      }

      if (typeId === "netlify-env-var") {
        const siteField = !parentResourceId
          ? await (async () => {
              const sites = await this.pickableSites();
              const siteOptions = sites.map((s) => ({
                id: String(s.id),
                label: s.name || String(s.id),
              }));
              return [
                {
                  key: "siteId",
                  label: "Site",
                  kind: "select" as const,
                  required: true,
                  options: siteOptions,
                  ...(siteOptions[0] ? { defaultValue: siteOptions[0].id } : {}),
                },
              ];
            })()
          : [];

        return {
          fields: [
            ...siteField,
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
            {
              key: "isSecret",
              label: "Contains Secret Values",
              kind: "select",
              required: false,
              defaultValue: "false",
              description:
                "Secret values are write-only and masked outside Netlify. They need an explicit context (not All contexts) and cannot use local development.",
              options: [
                { id: "false", label: "No" },
                { id: "true", label: "Yes" },
              ],
            },
            {
              key: "scopes",
              label: "Scopes",
              kind: "policy-picker",
              required: false,
              description: "Where the variable is available. Leave empty for all scopes.",
              policies: [
                { id: "builds", label: "Builds" },
                { id: "functions", label: "Functions" },
                { id: "runtime", label: "Runtime" },
                { id: "post-processing", label: "Post-processing" },
              ],
            },
          ],
        };
      }

      const sitePicker = async (): Promise<CreateResourceConfig["fields"]> => {
        if (parentResourceId) return [];
        const sites = await this.pickableSites();
        const options = sites.map((site) => ({ id: site.id, label: site.name || site.id }));
        return [
          {
            key: "siteId",
            label: "Site",
            kind: "select",
            required: true,
            options,
            ...(options[0] ? { defaultValue: options[0].id } : {}),
          },
        ];
      };

      if (typeId === "netlify-notification-hook") {
        let events = DEFAULT_HOOK_EVENTS;
        try {
          const types = (await this.api.get("/hooks/types")) ?? [];
          const fromApi = [...new Set(types.flatMap((t) => t.events ?? []))];
          if (fromApi.length > 0) events = fromApi;
        } catch {
          /* keep the documented defaults */
        }
        return {
          fields: [
            ...(await sitePicker()),
            {
              key: "type",
              label: "Notify By",
              kind: "select",
              required: true,
              defaultValue: "url",
              options: [
                { id: "url", label: "HTTP POST request" },
                { id: "email", label: "Email" },
                { id: "slack", label: "Slack incoming webhook" },
              ],
            },
            {
              key: "event",
              label: "Event",
              kind: "select",
              required: true,
              defaultValue: events[0] ?? "deploy_created",
              options: events.map((e) => ({ id: e, label: hookEventLabel(e) })),
            },
            {
              key: "target",
              label: "Destination",
              kind: "text",
              required: true,
              description: "The email address, or the URL to call",
            },
          ],
        };
      }

      if (typeId === "netlify-snippet") {
        return {
          fields: [
            ...(await sitePicker()),
            { key: "title", label: "Title", kind: "text", required: true },
            {
              key: "position",
              label: "Position",
              kind: "select",
              required: true,
              defaultValue: "head",
              options: [
                { id: "head", label: "Before </head>" },
                { id: "footer", label: "Before </body>" },
              ],
            },
            { key: "code", label: "HTML", kind: "code", required: true },
          ],
        };
      }

      if (typeId === "netlify-database") {
        // The database is created in the site's functions region.
        return { fields: await sitePicker() };
      }

      throw new Error(`Netlify plugin: no create config for type "${typeId}"`);
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const parentExternalId = parentResourceId
        ? parentResourceId.split(":").slice(2).join(":")
        : "";
      if (typeId === "netlify-site") {
        const site = await this.api.post("/sites", { body: { name: fields["name"] ?? "" } });
        return this.mapSite(site, accountId);
      }

      if (typeId === "netlify-dns-zone") {
        const zone = await this.api.post("/dns_zones", { body: { name: fields["name"] ?? "" } });
        return this.mapDnsZone(zone, accountId);
      }

      if (typeId === "netlify-dns-record") {
        const zoneId = fields["zoneId"] || parentExternalId;
        if (!zoneId) throw new Error("Netlify plugin: zoneId is required to create a DNS record");
        const ttl = wholeNumber(fields, "ttl");
        const priority = wholeNumber(fields, "priority");
        const weight = wholeNumber(fields, "weight");
        const port = wholeNumber(fields, "port");
        const flag = wholeNumber(fields, "flag");
        const record = await this.api.post(`/dns_zones/${pathEncode(zoneId)}/dns_records`, {
          body: {
            type: fields["type"] ?? "",
            hostname: fields["hostname"] ?? "",
            value: fields["value"] ?? "",
            ...(ttl !== undefined ? { ttl } : {}),
            ...(priority !== undefined ? { priority } : {}),
            ...(weight !== undefined ? { weight } : {}),
            ...(port !== undefined ? { port } : {}),
            ...(flag !== undefined ? { flag } : {}),
            ...(fields["tag"] ? { tag: fields["tag"] } : {}),
          },
        });
        return this.mapDnsRecord(record, accountId, zoneId);
      }

      if (typeId === "netlify-build-hook") {
        const siteId = fields["siteId"] || parentExternalId;
        if (!siteId) throw new Error("Netlify plugin: siteId is required to create a build hook");
        const hook = await this.api.post(`/sites/${pathEncode(siteId)}/build_hooks`, {
          body: {
            title: fields["title"] ?? "",
            ...(fields["branch"] ? { branch: fields["branch"] } : {}),
          },
        });
        return this.mapBuildHook(hook, accountId, siteId);
      }

      if (typeId === "netlify-env-var") {
        const siteId = fields["siteId"] || parentExternalId;
        if (!siteId) throw new Error("Netlify plugin: siteId is required to create an env var");
        const context = fields["context"] || "all";
        const isSecret = fields["isSecret"] === "true";
        const scopes = parseJsonIds(fields["scopes"]);
        const effectiveScopes =
          scopes.length > 0 ? scopes : ["builds", "functions", "runtime", "post-processing"];
        const account = await this.siteAccountId(siteId);
        await this.api.post(`/accounts/${pathEncode(account)}/env`, {
          query: { site_id: siteId },
          body: [
            {
              key: fields["key"] ?? "",
              scopes: effectiveScopes,
              values: [{ context, value: fields["value"] ?? "" }],
              ...(isSecret ? { is_secret: true } : {}),
            },
          ],
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
            scopes: effectiveScopes.join(", "),
            contexts: context,
            isSecret,
            updatedAt: now,
          },
          resolvedOutputs: { envKey: fields["key"] ?? "" },
          secretStates: [],
          parentResourceId: `${accountId}:netlify-site:${siteId}`,
          createdAt: now,
          updatedAt: now,
        };
      }

      if (typeId === "netlify-notification-hook") {
        const siteId = fields["siteId"] || parentExternalId;
        if (!siteId) throw new Error("Netlify plugin: siteId is required to create a notification");
        const type = fields["type"] || "url";
        const hook = await this.api.post("/hooks", {
          query: { site_id: siteId },
          body: {
            type,
            event: fields["event"] ?? "",
            data: { [type === "email" ? "email" : "url"]: fields["target"] ?? "" },
          },
        });
        return this.mapHook(hook, accountId, siteId);
      }

      if (typeId === "netlify-snippet") {
        const siteId = fields["siteId"] || parentExternalId;
        if (!siteId) throw new Error("Netlify plugin: siteId is required to create a snippet");
        const snippet = await this.api.post(`/sites/${pathEncode(siteId)}/snippets`, {
          body: {
            title: fields["title"] ?? "",
            general: fields["code"] ?? "",
            general_position: fields["position"] || "head",
          },
        });
        return this.mapSnippet(snippet, accountId, siteId);
      }

      if (typeId === "netlify-database") {
        const siteId = fields["siteId"] || parentExternalId;
        if (!siteId) throw new Error("Netlify plugin: siteId is required to create a database");
        await this.api.post(`/sites/${pathEncode(siteId)}/database`, { body: {} });
        return runPluginEffect(
          this.getResource(typeId, `${accountId}:netlify-database:${siteId}`, accountId),
        );
      }

      throw new Error(`Netlify plugin: createResource not supported for type "${typeId}"`);
    });
  }

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      if (typeId === "netlify-site") {
        const siteId = resourceId.split(":").pop() ?? "";
        const body: NetlifySiteUpdate = {};
        if (fields["name"]) body.name = fields["name"];
        if (fields["forceSsl"] !== undefined) body.force_ssl = fields["forceSsl"] === "true";
        const build: NonNullable<NetlifySiteUpdate["build_settings"]> = {};
        if (fields["buildCommand"] !== undefined) build.cmd = fields["buildCommand"];
        if (fields["publishDir"] !== undefined) build.dir = fields["publishDir"];
        if (fields["functionsDir"] !== undefined) build.functions_dir = fields["functionsDir"];
        if (fields["repoBranch"]) build.repo_branch = fields["repoBranch"];
        if (fields["stopBuilds"] !== undefined) build.stop_builds = fields["stopBuilds"] === "true";
        if (Object.keys(build).length > 0) body.build_settings = build;
        const site = await this.api.patch(`/sites/${pathEncode(siteId)}`, { body });
        return this.mapSite(site, accountId);
      }

      const { siteId, childId } = splitSiteChild(resourceId);

      if (typeId === "netlify-env-var") {
        if (fields["newValue"]) {
          const account = await this.siteAccountId(siteId);
          await this.api.patch(`/accounts/${pathEncode(account)}/env/${pathEncode(childId)}`, {
            query: { site_id: siteId },
            body: { context: fields["valueContext"] || "all", value: fields["newValue"] },
          });
        }
        return runPluginEffect(this.getResource(typeId, resourceId, accountId));
      }

      if (typeId === "netlify-build-hook") {
        await this.api.put(`/sites/${pathEncode(siteId)}/build_hooks/${pathEncode(childId)}`, {
          body: {
            ...(fields["title"] !== undefined ? { title: fields["title"] } : {}),
            ...(fields["branch"] !== undefined ? { branch: fields["branch"] } : {}),
          },
        });
        return runPluginEffect(this.getResource(typeId, resourceId, accountId));
      }

      if (typeId === "netlify-notification-hook") {
        const current = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
        const type = String(current.fields["type"] ?? "url");
        const hook = await this.api.put(`/hooks/${pathEncode(childId)}`, {
          body: {
            type,
            event: fields["event"] ?? String(current.fields["event"] ?? ""),
            data: {
              [type === "email" ? "email" : "url"]:
                fields["target"] ?? String(current.fields["target"] ?? ""),
            },
          },
        });
        return this.mapHook(hook, accountId, siteId);
      }

      if (typeId === "netlify-snippet") {
        const current = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
        await this.api.put(`/sites/${pathEncode(siteId)}/snippets/${pathEncode(childId)}`, {
          body: {
            title: fields["title"] ?? String(current.fields["title"] ?? ""),
            general: fields["code"] ?? String(current.fields["code"] ?? ""),
            general_position: fields["position"] ?? String(current.fields["position"] ?? "head"),
          },
        });
        return runPluginEffect(this.getResource(typeId, resourceId, accountId));
      }

      throw new Error(`Netlify plugin: updateResource not supported for type "${typeId}"`);
    });
  }

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const last = resourceId.split(":").pop() ?? "";
      if (typeId === "netlify-site") {
        switch (actionId) {
          case "build":
            await this.api.post(`/sites/${pathEncode(last)}/builds`);
            return;
          case "build-clear-cache":
            await this.api.post(`/sites/${pathEncode(last)}/builds`, {
              query: { clear_cache: true },
            });
            return;
          case "rollback":
            await this.api.put(`/sites/${pathEncode(last)}/rollback`);
            return;
          case "provision-ssl":
            await this.api.post(`/sites/${pathEncode(last)}/ssl`);
            return;
          case "purge-cache":
            await this.api.post("/purge", { body: { site_id: last } });
            return;
        }
      }
      if (typeId === "netlify-deploy") {
        switch (actionId) {
          case "cancel":
            await this.api.post(`/deploys/${pathEncode(last)}/cancel`);
            return;
          case "lock":
            await this.api.post(`/deploys/${pathEncode(last)}/lock`);
            return;
          case "unlock":
            await this.api.post(`/deploys/${pathEncode(last)}/unlock`);
            return;
          case "publish": {
            const deploy = await this.api.get(`/deploys/${pathEncode(last)}`);
            if (!deploy.site_id) throw new Error("Netlify plugin: deploy has no site");
            await this.api.post(
              `/sites/${pathEncode(deploy.site_id)}/deploys/${pathEncode(last)}/restore`,
            );
            return;
          }
        }
      }
      if (typeId === "netlify-notification-hook" && actionId === "enable") {
        await this.api.post(`/hooks/${pathEncode(splitSiteChild(resourceId).childId)}/enable`);
        return;
      }
      if (typeId === "netlify-database" && actionId === "snapshot") {
        await this.api.post(`/sites/${pathEncode(last)}/database/snapshot`, { body: {} });
        return;
      }
      throw new Error(`Netlify plugin: invokeAction "${actionId}" not supported for "${typeId}"`);
    });
  }

  /**
   * Site: TLS certificate state. Form: the latest submissions. Database:
   * branches and snapshots. Each is stashed as JSON under a `__…__` field
   * for the synchronous renderer and skipped when its call fails.
   */
  enrichDetail(resource: ResourceInstance): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const extra: Record<string, string> = {};
      const stash = async (key: string, load: () => Promise<object | null | undefined>) => {
        try {
          const value = await load();
          if (value != null) extra[key] = JSON.stringify(value);
        } catch {
          /* optional panel */
        }
      };
      const last = resource.id.split(":").pop() ?? "";
      switch (resource.resourceTypeId) {
        case "netlify-site":
          await stash("__tls__", () => this.api.get(`/sites/${pathEncode(last)}/ssl`));
          break;
        case "netlify-form":
          await stash("__submissions__", () =>
            this.api.get(`/forms/${pathEncode(resource.externalId ?? "")}/submissions`, {
              query: { per_page: 20 },
            }),
          );
          break;
        case "netlify-database":
          await Promise.all([
            stash(
              "__branches__",
              async () =>
                (await this.api.get(`/sites/${pathEncode(last)}/database/branches`)).branches,
            ),
            stash(
              "__snapshots__",
              async () =>
                (await this.api.get(`/sites/${pathEncode(last)}/database/snapshots`)).snapshots,
            ),
          ]);
          break;
        default:
          return resource;
      }
      return { ...resource, fields: { ...resource.fields, ...extra } };
    });
  }

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      if (typeId === "netlify-site") {
        const siteId = resourceId.split(":").pop();
        if (!siteId) throw new Error("Netlify plugin: cannot parse site ID");
        await this.api.delete(`/sites/${pathEncode(siteId)}`);
        return;
      }

      if (typeId === "netlify-deploy") {
        const deployId = resourceId.split(":").pop();
        if (!deployId) throw new Error("Netlify plugin: cannot parse deploy ID");
        await this.api.delete(`/deploys/${pathEncode(deployId)}`);
        return;
      }

      if (typeId === "netlify-form") {
        // resource ID format: {accountId}:netlify-form:{siteId}/{formId}
        const compound = resourceId.split(":").pop();
        if (!compound) throw new Error("Netlify plugin: cannot parse form ID");
        const [siteId, formId] = compound.split("/");
        if (!siteId || !formId) throw new Error("Netlify plugin: cannot parse form ID");
        await this.api.delete(`/sites/${pathEncode(siteId)}/forms/${pathEncode(formId)}`);
        return;
      }

      if (typeId === "netlify-dns-zone") {
        const zoneId = resourceId.split(":").pop();
        if (!zoneId) throw new Error("Netlify plugin: cannot parse DNS zone ID");
        await this.api.delete(`/dns_zones/${pathEncode(zoneId)}`);
        return;
      }

      if (typeId === "netlify-dns-record") {
        // resource ID format: {accountId}:netlify-dns-record:{zoneId}/{recordId}
        const compound = resourceId.split(":").pop();
        if (!compound) throw new Error("Netlify plugin: cannot parse DNS record ID");
        const [zoneId, recordId] = compound.split("/");
        if (!zoneId || !recordId) throw new Error("Netlify plugin: cannot parse DNS record ID");
        await this.api.delete(
          `/dns_zones/${pathEncode(zoneId)}/dns_records/${pathEncode(recordId)}`,
        );
        return;
      }

      if (typeId === "netlify-build-hook") {
        // resource ID format: {accountId}:netlify-build-hook:{siteId}/{hookId}
        const compound = resourceId.split(":").pop();
        if (!compound) throw new Error("Netlify plugin: cannot parse build hook ID");
        const [siteId, hookId] = compound.split("/");
        if (!siteId || !hookId) throw new Error("Netlify plugin: cannot parse build hook ID");
        await this.api.delete(`/sites/${pathEncode(siteId)}/build_hooks/${pathEncode(hookId)}`);
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
        const account = await this.siteAccountId(siteId);
        await this.api.delete(`/accounts/${pathEncode(account)}/env/${pathEncode(key)}`, {
          query: { site_id: siteId },
        });
        return;
      }

      if (typeId === "netlify-notification-hook") {
        await this.api.delete(`/hooks/${pathEncode(splitSiteChild(resourceId).childId)}`);
        return;
      }

      if (typeId === "netlify-snippet") {
        const { siteId, childId } = splitSiteChild(resourceId);
        await this.api.delete(`/sites/${pathEncode(siteId)}/snippets/${pathEncode(childId)}`);
        return;
      }

      if (typeId === "netlify-database") {
        await this.api.delete(`/sites/${pathEncode(resourceId.split(":").pop() ?? "")}/database`);
        return;
      }

      throw new Error(`Netlify plugin: deleteResource not supported for type "${typeId}"`);
    });
  }

  attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      if (sourceTypeId === "netlify-dns-zone" && targetTypeId === "netlify-site") {
        const [zone, site] = await Promise.all([
          runPluginEffect(this.getResource(sourceTypeId, sourceResourceId, accountId)),
          runPluginEffect(this.getResource(targetTypeId, targetResourceId, accountId)),
        ]);
        const domain = String(zone.fields["domain"] ?? zone.fields["name"] ?? "");
        const siteId = String(site.externalId ?? targetResourceId.split(":").pop() ?? "");
        if (!domain || !siteId) {
          throw new Error("Cannot determine Netlify DNS zone or site identity for attachment");
        }

        const currentSite = await this.api.get(`/sites/${pathEncode(siteId)}`);
        const customDomain = currentSite.custom_domain ?? "";
        const domainAliases = currentSite.domain_aliases ?? [];
        if (customDomain === domain || domainAliases.includes(domain)) return;

        if (!customDomain) {
          await this.api.patch(`/sites/${pathEncode(siteId)}`, { body: { custom_domain: domain } });
          return;
        }

        await this.api.patch(`/sites/${pathEncode(siteId)}`, {
          body: { domain_aliases: [...domainAliases, domain] },
        });
        return;
      }

      if (sourceTypeId === "netlify-deploy" && targetTypeId === "netlify-site") {
        const [deploy, site] = await Promise.all([
          runPluginEffect(this.getResource(sourceTypeId, sourceResourceId, accountId)),
          runPluginEffect(this.getResource(targetTypeId, targetResourceId, accountId)),
        ]);
        const deployId = String(deploy.externalId ?? sourceResourceId.split(":").pop() ?? "");
        const siteId = String(site.externalId ?? targetResourceId.split(":").pop() ?? "");
        if (!deployId || !siteId) {
          throw new Error("Cannot determine Netlify deploy or site identity for publishing");
        }
        await this.api.post(`/sites/${pathEncode(siteId)}/deploys/${pathEncode(deployId)}/restore`);
        return;
      }

      if (sourceTypeId === "netlify-build-hook" && targetTypeId === "netlify-site") {
        const [hook, site] = await Promise.all([
          runPluginEffect(this.getResource(sourceTypeId, sourceResourceId, accountId)),
          runPluginEffect(this.getResource(targetTypeId, targetResourceId, accountId)),
        ]);
        const hookUrl = String(hook.fields["url"] ?? "");
        const siteId = String(site.externalId ?? targetResourceId.split(":").pop() ?? "");
        if (!hookUrl || !siteId) {
          throw new Error(
            "Cannot determine Netlify build hook URL or site identity for env import",
          );
        }
        const account = await this.siteAccountId(siteId);
        await this.api.post(`/accounts/${pathEncode(account)}/env`, {
          query: { site_id: siteId },
          body: [
            {
              key: "NETLIFY_BUILD_HOOK_URL",
              scopes: ["builds", "functions", "runtime", "post-processing"],
              values: [{ context: "all", value: hookUrl }],
            },
          ],
        });
        return;
      }

      throw new Error(
        `Netlify plugin: attachResource not supported for ${sourceTypeId} → ${targetTypeId}`,
      );
    });
  }

  /**
   * The Netlify account (team) that owns a site. Env vars live on the
   * account-level API, scoped to one site with `site_id`.
   */
  private async siteAccountId(siteId: string): Promise<string> {
    const site = await this.api.get(`/sites/${pathEncode(siteId)}`);
    if (!site.account_id) throw new Error(`Netlify plugin: site ${siteId} has no account`);
    return site.account_id;
  }

  private mapHook(h: NetlifyHook, accountId: string, siteId: string): ResourceInstance {
    const data = h.data ?? {};
    const target = String(data["email"] ?? data["url"] ?? "");
    const created = h.created_at ?? new Date().toISOString();
    return {
      id: `${accountId}:netlify-notification-hook:${siteId}/${h.id}`,
      pluginId: "netlify",
      resourceTypeId: "netlify-notification-hook",
      accountId,
      displayName: `${hookEventLabel(h.event ?? "")} → ${target || h.type || "hook"}`,
      fields: {
        type: h.type ?? "",
        event: h.event ?? "",
        target,
        disabled: h.disabled ?? false,
        siteId,
        createdAt: created,
        updatedAt: h.updated_at ?? created,
      },
      resolvedOutputs: { hookId: h.id },
      secretStates: [],
      externalId: `${siteId}/${h.id}`,
      parentResourceId: `${accountId}:netlify-site:${siteId}`,
      createdAt: created,
      updatedAt: h.updated_at ?? created,
    };
  }

  private mapSnippet(sn: NetlifySnippet, accountId: string, siteId: string): ResourceInstance {
    const id = String(sn.id);
    const now = new Date().toISOString();
    return {
      id: `${accountId}:netlify-snippet:${siteId}/${id}`,
      pluginId: "netlify",
      resourceTypeId: "netlify-snippet",
      accountId,
      displayName: sn.title || `Snippet ${id}`,
      fields: {
        title: sn.title ?? "",
        position: sn.general_position || "head",
        code: sn.general ?? "",
        siteId,
      },
      resolvedOutputs: { snippetId: id },
      secretStates: [],
      externalId: `${siteId}/${id}`,
      parentResourceId: `${accountId}:netlify-site:${siteId}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * One database per site; the production branch (named "production", else
   * the oldest) stands for the database's state, size, and compute.
   */
  private mapDatabase(
    site: NetlifySite,
    branches: NetlifyDbBranch[],
    accountId: string,
  ): ResourceInstance {
    const sorted = [...branches].sort((a, b) =>
      String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")),
    );
    const prod = branches.find((b) => b.name === "production") ?? sorted[0];
    const fields: Record<string, string | number | boolean> = {
      siteName: site.name,
      siteId: site.id,
      branchCount: branches.length,
    };
    if (prod?.state) fields["state"] = prod.state;
    if (prod?.logical_size_bytes != null) fields["sizeBytes"] = prod.logical_size_bytes;
    if (prod?.compute?.current_state) fields["computeState"] = prod.compute.current_state;
    if (prod?.compute?.autoscaling_limit_min_cu != null) {
      fields["minCu"] = prod.compute.autoscaling_limit_min_cu;
    }
    if (prod?.compute?.autoscaling_limit_max_cu != null) {
      fields["maxCu"] = prod.compute.autoscaling_limit_max_cu;
    }
    if (prod?.compute?.suspend_timeout_seconds != null) {
      fields["suspendTimeoutSeconds"] = prod.compute.suspend_timeout_seconds;
    }
    if (prod?.last_active_at) fields["lastActiveAt"] = prod.last_active_at;
    if (prod?.created_at) fields["createdAt"] = prod.created_at;
    const created = prod?.created_at ?? site.created_at;
    return {
      id: `${accountId}:netlify-database:${site.id}`,
      pluginId: "netlify",
      resourceTypeId: "netlify-database",
      accountId,
      displayName: `${site.name} database`,
      fields,
      resolvedOutputs: {},
      secretStates: [],
      externalId: site.id,
      parentResourceId: `${accountId}:netlify-site:${site.id}`,
      createdAt: created,
      updatedAt: prod?.updated_at ?? created,
    };
  }

  private async listSites(accountId: string): Promise<ResourceInstance[]> {
    const sites = await this.allSites();
    return sites.map((s) => this.mapSite(s, accountId));
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
        url: s.url ?? "",
        sslUrl: s.ssl_url ?? "",
        customDomain: s.custom_domain ?? "",
        domainAliases: (s.domain_aliases ?? []).join(", "),
        state: pubDeploy?.state ?? s.state ?? "",
        plan: s.plan ?? "",
        repoUrl: s.build_settings?.repo_url ?? "",
        repoBranch: s.build_settings?.repo_branch ?? "",
        buildCommand: s.build_settings?.cmd ?? "",
        publishDir: s.build_settings?.dir ?? "",
        functionsDir: s.build_settings?.functions_dir ?? "",
        stopBuilds: s.build_settings?.stop_builds ?? false,
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
        url: s.url ?? "",
        sslUrl: s.ssl_url ?? "",
      },
      secretStates: [],
      externalId: s.id,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
    };
  }

  private async listAllDeploys(accountId: string): Promise<ResourceInstance[]> {
    const deploys = await eachParent(await this.allSites(), async (site) =>
      (await this.api.getAll(`/sites/${pathEncode(site.id)}/deploys`, null)).map((d) =>
        this.mapDeploy(d, accountId, site.id),
      ),
    );
    // Each site is capped, but they add up, and past about 65,000 rows the sync's prune fails
    // for the whole account (#572). This fails only the deploys.
    return withinListCap(deploys, MAX_DEPLOYS, {
      vendor: "Netlify",
      path: "/sites/{site_id}/deploys",
    });
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
        state: d.state ?? "",
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
        siteId,
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
    return eachParent(await this.allSites(), async (site) =>
      (await this.links.getAll(`/sites/${pathEncode(site.id)}/forms`, null)).map((f) =>
        this.mapForm(f, accountId, site.id),
      ),
    );
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
        siteId,
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
    const zones = await this.links.getAll("/dns_zones", null);
    return zones.map((z) => this.mapDnsZone(z, accountId));
  }

  private mapDnsZone(z: NetlifyDnsZone, accountId: string): ResourceInstance {
    return {
      id: `${accountId}:netlify-dns-zone:${z.id}`,
      pluginId: "netlify",
      resourceTypeId: "netlify-dns-zone",
      accountId,
      displayName: z.name || z.domain || z.id,
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
        siteId: z.site_id ?? "",
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
    return eachParent(await this.links.getAll("/dns_zones", null), async (zone) =>
      (await this.links.getAll(`/dns_zones/${pathEncode(zone.id)}/dns_records`, null)).map((r) =>
        this.mapDnsRecord(r, accountId, zone.id),
      ),
    );
  }

  private mapDnsRecord(r: NetlifyDnsRecord, accountId: string, zoneId: string): ResourceInstance {
    return {
      id: `${accountId}:netlify-dns-record:${zoneId}/${r.id}`,
      pluginId: "netlify",
      resourceTypeId: "netlify-dns-record",
      accountId,
      displayName: `${r.type ?? ""} ${r.hostname ?? ""}`.trim() || r.id,
      fields: {
        name: r.hostname ?? "",
        type: r.type ?? "",
        content: r.value ?? "",
        ttl: r.ttl ?? 0,
        priority: r.priority ?? 0,
        managed: r.managed ?? false,
        tag: r.tag ?? "",
        flag: r.flag ?? 0,
        zoneId,
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
    return eachParent(await this.allSites(), async (site) =>
      (await this.links.getAll(`/sites/${pathEncode(site.id)}/build_hooks`, null)).map((h) =>
        this.mapBuildHook(h, accountId, site.id),
      ),
    );
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
        siteId,
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
    return eachParent(await this.allSites(), async (site) => {
      if (!site.account_id) return [];
      const envVars = await this.links.getAll(
        `/accounts/${pathEncode(site.account_id)}/env`,
        null,
        {
          query: { site_id: site.id },
        },
      );
      return envVars.map((ev) => this.mapEnvVar(ev, accountId, site.id));
    });
  }

  private mapEnvVar(ev: NetlifyEnvVar, accountId: string, siteId: string): ResourceInstance {
    const contexts = Array.isArray(ev.values)
      ? [...new Set(ev.values.map((v) => v.context ?? ""))].join(", ")
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
        siteId,
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
              ...(f["functionsDir"]
                ? [{ key: "Functions Directory", value: String(f["functionsDir"]) }]
                : []),
              ...(f["stopBuilds"] === true ? [{ key: "Automatic Builds", value: "Stopped" }] : []),
              ...(f["framework"] ? [{ key: "Framework", value: String(f["framework"]) }] : []),
            ],
          },
        ],
      });
    }

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
            ...tlsItems(f["__tls__"]),
          ],
        },
      ],
    });

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
        {
          kind: "action",
          label: "Trigger Deploy",
          action: {
            type: "plugin-action",
            actionId: "build",
            successMessage: "Build started from the production branch.",
          },
        },
        {
          kind: "action",
          label: "Clear Cache and Deploy",
          action: {
            type: "plugin-action",
            actionId: "build-clear-cache",
            successMessage: "Build started with a cleared cache.",
          },
        },
        {
          kind: "action",
          label: "Roll Back",
          action: {
            type: "plugin-action",
            actionId: "rollback",
            confirmMessage: "Publish the previous production deploy again?",
            successMessage: "Rolled back to the previous deploy.",
          },
        },
        {
          kind: "action",
          label: "Purge CDN Cache",
          action: {
            type: "plugin-action",
            actionId: "purge-cache",
            confirmMessage: "Purge every cached response for this site from Netlify's CDN?",
            successMessage: "Cache purge requested.",
          },
        },
        {
          kind: "action",
          label: "Renew Certificate",
          action: {
            type: "plugin-action",
            actionId: "provision-ssl",
            successMessage: "Certificate provisioning requested.",
          },
        },
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
    const inProgress = mapDeployState(state) === "provisioning";
    const actions: ActionNode[] = [];
    if (inProgress) {
      actions.push({
        kind: "action",
        label: "Cancel",
        variant: "danger",
        action: {
          type: "plugin-action",
          actionId: "cancel",
          confirmMessage: "Cancel this deploy?",
          successMessage: "Deploy canceled.",
        },
      });
    }
    if (state === "ready") {
      actions.push({
        kind: "action",
        label: "Publish",
        action: {
          type: "plugin-action",
          actionId: "publish",
          confirmMessage: "Make this deploy the live production deploy?",
          successMessage: "Deploy published.",
        },
      });
    }
    actions.push(
      f["locked"] === true
        ? {
            kind: "action",
            label: "Unlock Publishing",
            action: {
              type: "plugin-action",
              actionId: "unlock",
              successMessage: "Auto publishing resumed.",
            },
          }
        : {
            kind: "action",
            label: "Lock Publishing",
            action: {
              type: "plugin-action",
              actionId: "lock",
              confirmMessage:
                "Lock this deploy? New builds keep running but are not published until you unlock.",
              successMessage: "Publishing locked to this deploy.",
            },
          },
    );
    return {
      title: resource.displayName,
      subtitle: joinSubtitle(String(f["context"] ?? "deploy"), f["branch"]),
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
        ...actions,
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
    const submissions = parseJsonList<NetlifySubmission>(f["__submissions__"]);
    const submissionSection: SectionNode[] =
      submissions.length > 0
        ? [
            {
              kind: "section",
              title: "Recent Submissions",
              children: [
                {
                  kind: "table",
                  columns: [
                    { key: "number", label: "#", width: "narrow" },
                    { key: "name", label: "Name" },
                    { key: "email", label: "Email" },
                    { key: "summary", label: "Summary", width: "wide" },
                    { key: "created", label: "Received" },
                  ],
                  rows: submissions.map((sub) => ({
                    cells: {
                      number: sub.number != null ? String(sub.number) : "",
                      name: sub.name ?? "",
                      email: sub.email ?? "",
                      summary: sub.summary ?? "",
                      created: sub.created_at ?? "",
                    },
                  })),
                },
              ],
            },
          ]
        : [];
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
        ...submissionSection,
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderDnsZoneDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    return {
      title: resource.displayName,
      subtitle: "Netlify DNS Zone",
      status: { kind: "status-dot", status: "healthy", label: "Active" },
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
        status: "healthy",
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

  private renderHookDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const disabled = f["disabled"] === true;
    return {
      title: resource.displayName,
      subtitle: joinSubtitle("Deploy notification", f["type"]),
      status: { kind: "status-dot", status: disabled ? "degraded" : "healthy" },
      sections: [
        {
          kind: "section",
          title: "Notification",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Event", value: hookEventLabel(String(f["event"] ?? "")) },
                { key: "Type", value: String(f["type"] ?? "") },
                { key: "Destination", value: String(f["target"] ?? ""), copyable: true },
                { key: "Status", value: disabled ? "Disabled after repeated failures" : "Active" },
              ],
            },
          ],
        },
      ],
      headerActions: [
        ...(disabled
          ? [
              {
                kind: "action" as const,
                label: "Re-enable",
                action: {
                  type: "plugin-action" as const,
                  actionId: "enable",
                  successMessage: "Notification re-enabled.",
                },
              },
            ]
          : []),
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  private renderSnippetDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    return {
      title: resource.displayName,
      subtitle: joinSubtitle(
        "Snippet",
        f["position"] === "footer" ? "before </body>" : "before </head>",
      ),
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        {
          kind: "section",
          title: "Snippet",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Title", value: String(f["title"] ?? "") },
                { key: "HTML", value: String(f["code"] ?? ""), copyable: true },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderDatabaseDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const state = String(f["state"] ?? "");
    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Production Branch",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Site", value: String(f["siteName"] ?? "") },
              { key: "State", value: state || "unknown" },
              { key: "Size", value: formatBytes(f["sizeBytes"]) },
              { key: "Compute", value: String(f["computeState"] ?? "unknown") },
              ...(f["minCu"] !== undefined || f["maxCu"] !== undefined
                ? [
                    {
                      key: "Autoscaling",
                      value: `${String(f["minCu"] ?? "?")} to ${String(f["maxCu"] ?? "?")} CU`,
                    },
                  ]
                : []),
              ...(f["suspendTimeoutSeconds"] !== undefined
                ? [{ key: "Suspends After", value: `${String(f["suspendTimeoutSeconds"])} s idle` }]
                : []),
              ...(f["lastActiveAt"]
                ? [{ key: "Last Active", value: String(f["lastActiveAt"]) }]
                : []),
              { key: "Branches", value: String(f["branchCount"] ?? 0) },
            ],
          },
        ],
      },
    ];
    const branches = parseJsonList<NetlifyDbBranch>(f["__branches__"]);
    if (branches.length > 0) {
      sections.push({
        kind: "section",
        title: "Branches",
        children: [
          {
            kind: "table",
            columns: [
              { key: "name", label: "Branch" },
              { key: "state", label: "State" },
              { key: "compute", label: "Compute" },
              { key: "size", label: "Size" },
              { key: "lastActive", label: "Last Active" },
            ],
            rows: branches.map((b) => ({
              cells: {
                name: b.name ?? b.branch_id ?? "",
                state: b.state ?? "",
                compute: b.compute?.current_state ?? "",
                size: formatBytes(b.logical_size_bytes),
                lastActive: b.last_active_at ?? "",
              },
            })),
          },
        ],
      });
    }
    const snapshots = parseJsonList<NetlifyDbSnapshot>(f["__snapshots__"]);
    if (snapshots.length > 0) {
      sections.push({
        kind: "section",
        title: "Snapshots",
        children: [
          {
            kind: "table",
            columns: [
              { key: "id", label: "Snapshot", mono: true },
              { key: "kind", label: "Kind" },
              { key: "created", label: "Created" },
              { key: "expires", label: "Expires" },
            ],
            rows: snapshots.map((snap) => ({
              cells: {
                id: snap.id ?? "",
                kind: snap.manual ? "Manual" : "Automatic",
                created: snap.created_at ?? "",
                expires: snap.expires_at ?? "",
              },
            })),
          },
        ],
      });
    }
    return {
      title: resource.displayName,
      subtitle: "Netlify DB",
      status: { kind: "status-dot", status: mapDbState(state) },
      sections,
      headerActions: [
        {
          kind: "action",
          label: "Snapshot Now",
          action: {
            type: "plugin-action",
            actionId: "snapshot",
            successMessage: "Snapshot of the production branch requested.",
          },
        },
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }
}

/** Documented deploy-notification events, used when `/hooks/types` is unavailable. */
const DEFAULT_HOOK_EVENTS = [
  "deploy_building",
  "deploy_created",
  "deploy_failed",
  "deploy_locked",
  "deploy_unlocked",
  "deploy_request_pending",
  "deploy_request_accepted",
  "deploy_request_rejected",
  "submission_created",
];

const HOOK_EVENT_LABELS: Record<string, string> = {
  deploy_building: "Deploy started",
  deploy_created: "Deploy succeeded",
  deploy_failed: "Deploy failed",
  deploy_locked: "Deploy locked",
  deploy_unlocked: "Deploy unlocked",
  deploy_request_pending: "Deploy request pending",
  deploy_request_accepted: "Deploy request accepted",
  deploy_request_rejected: "Deploy request rejected",
  submission_created: "Form submission",
};

function hookEventLabel(event: string): string {
  return HOOK_EVENT_LABELS[event] ?? event;
}

function mapDbState(state: string): ResourceStatus {
  switch (state) {
    case "ready":
      return "healthy";
    case "init":
    case "creating":
    case "resetting":
      return "provisioning";
    case "archived":
      return "degraded";
    default:
      return "info";
  }
}

/** The most deploys one account may list. See `listAllDeploys`. */
const MAX_DEPLOYS = 50_000;

/**
 * `load` for each parent. One at a time, because Netlify allows 500 requests a minute and
 * a 429 fails the list. A parent refusing the read has no rows; any other failure fails
 * the list, because a sync prunes what it stops seeing.
 */
async function eachParent<Parent>(
  parents: Parent[],
  load: (parent: Parent) => Promise<ResourceInstance[]>,
): Promise<ResourceInstance[]> {
  const rows: ResourceInstance[] = [];
  for (const parent of parents) {
    try {
      rows.push(...(await load(parent)));
    } catch (err) {
      if (!isRefusal(err)) throw err;
    }
  }
  return rows;
}

/** A form's number, undefined when blank. `Number()` alone would send junk as `null`. */
function wholeNumber(fields: Record<string, string>, key: string): number | undefined {
  const raw = fields[key]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`Netlify plugin: ${key} must be a whole number, got "${raw}"`);
  }
  return value;
}

/** `{accountId}:{typeId}:{siteId}/{childId}` → its site and child ids. */
function splitSiteChild(resourceId: string): { siteId: string; childId: string } {
  const compound = resourceId.split(":").slice(2).join(":");
  const slash = compound.indexOf("/");
  if (slash <= 0) throw new Error(`Netlify plugin: cannot parse resource id "${resourceId}"`);
  return { siteId: compound.slice(0, slash), childId: compound.slice(slash + 1) };
}

/** A `policy-picker` value: a JSON array of ids (tolerates a comma list). */
function parseJsonIds(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: string[] = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    /* fall through to comma-separated */
  }
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseJsonList<T>(raw: FieldValue): T[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed: T[] = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatBytes(raw: FieldValue): string {
  const n = Number(raw);
  if (raw == null || raw === "" || !Number.isFinite(n)) return "unknown";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** Key/value rows for the site's TLS certificate (`GET /sites/{id}/ssl`). */
function tlsItems(raw: FieldValue): Array<{ key: string; value: string }> {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const cert: NetlifySniCertificate = JSON.parse(raw);
    return [
      ...(cert.state ? [{ key: "Certificate", value: cert.state }] : []),
      ...(cert.domains?.length ? [{ key: "Covers", value: cert.domains.join(", ") }] : []),
      ...(cert.expires_at ? [{ key: "Certificate Expires", value: cert.expires_at }] : []),
    ];
  } catch {
    return [];
  }
}
