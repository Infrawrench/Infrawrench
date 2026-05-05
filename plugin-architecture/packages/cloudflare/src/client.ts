import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  ResourceTypeDefinition,
  CreateResourceConfig,
  StorageObject,
  SqlTableMeta,
  DashboardStat,
  CredentialExport,
} from "@infrawrench/plugin-base";
import {
  dnsRecordBadgeColor,
  dnsZoneStatus,
  renderDnsRecordDetail,
  renderDnsRecordSidebar,
} from "@infrawrench/plugin-base";
import {
  tunnelStatus,
  deploymentStatus,
  sslStatus,
  renderZoneDetail,
  renderWorkerDetail,
  renderR2BucketDetail,
  renderPagesProjectDetail,
  renderPagesDeploymentDetail,
  renderKVNamespaceDetail,
  renderD1DatabaseDetail,
  renderQueueDetail,
  renderTunnelDetail,
  renderSSLCertificateDetail,
  renderPageRuleDetail,
  renderFirewallRuleDetail,
  renderAccessApplicationDetail,
  renderLoadBalancerDetail,
  renderWorkerRouteDetail,
  renderGenericDetail,
  renderCustomHostnameDetail,
  renderHyperdriveDetail,
  renderEmailRoutingRuleDetail,
  renderWaitingRoomDetail,
  renderAccessPolicyDetail,
  renderSpectrumApplicationDetail,
  renderLogpushJobDetail,
} from "./detail-renderers.js";

export class CloudflareClient implements PluginClient {
  private readonly apiToken: string;
  private readonly resourceTypes: ResourceTypeDefinition[];
  private readonly baseUrl = "https://api.cloudflare.com/client/v4";
  private cfAccountId: string | null = null;

  constructor(credentials: Record<string, string>, resourceTypes: ResourceTypeDefinition[] = []) {
    const token = credentials["apiToken"];
    if (!token) throw new Error("Cloudflare plugin: missing apiToken credential");
    this.apiToken = token;
    this.resourceTypes = resourceTypes;
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      ...options,
    });
    if (!res.ok) {
      throw new Error(`Cloudflare API error ${res.status} for ${path}: ${await res.text()}`);
    }
    if (res.status === 204) return undefined as unknown as T;
    const json = (await res.json()) as {
      success: boolean;
      result: T;
      errors?: Array<{ message: string }>;
    };
    if (!json.success) {
      const msgs = json.errors?.map((e) => e.message).join(", ") ?? "unknown error";
      throw new Error(`Cloudflare API error for ${path}: ${msgs}`);
    }
    return json.result;
  }

  /** Paginate through Cloudflare's v4 API (page-based) */
  private async paginate<T>(path: string, perPage = 50): Promise<T[]> {
    const results: T[] = [];
    let page = 1;
    for (;;) {
      const sep = path.includes("?") ? "&" : "?";
      const res = await fetch(`${this.baseUrl}${path}${sep}page=${page}&per_page=${perPage}`, {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
      });
      if (!res.ok) throw new Error(`Cloudflare API error ${res.status}: ${await res.text()}`);
      const json = (await res.json()) as {
        success: boolean;
        result: T[];
        result_info?: { total_pages: number; page: number };
      };
      if (!json.success || !Array.isArray(json.result)) break;
      results.push(...json.result);
      const totalPages = json.result_info?.total_pages ?? 1;
      if (page >= totalPages) break;
      page++;
    }
    return results;
  }

  /** Resolve the Cloudflare account ID from the first zone */
  private async getAccountId(): Promise<string> {
    if (this.cfAccountId) return this.cfAccountId;
    const zones = await this.paginate<Record<string, unknown>>("/zones?per_page=1");
    const firstZone = zones[0];
    if (!firstZone)
      throw new Error("Cloudflare plugin: no zones found — cannot determine account ID");
    const account = firstZone["account"] as Record<string, unknown> | undefined;
    this.cfAccountId = String(account?.["id"] ?? "");
    if (!this.cfAccountId)
      throw new Error("Cloudflare plugin: could not determine account ID from zone");
    return this.cfAccountId;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "zone":
        return this.listZones(accountId);
      case "dns-record":
        return this.listAllDnsRecords(accountId);
      case "worker":
        return this.listWorkers(accountId);
      case "r2-bucket":
        return this.listR2Buckets(accountId);
      case "pages-project":
        return this.listPagesProjects(accountId);
      case "pages-deployment":
        return this.listAllPagesDeployments(accountId);
      case "kv-namespace":
        return this.listKVNamespaces(accountId);
      case "d1-database":
        return this.listD1Databases(accountId);
      case "queue":
        return this.listQueues(accountId);
      case "tunnel":
        return this.listTunnels(accountId);
      case "ssl-certificate":
        return this.listAllSSLCertificates(accountId);
      case "page-rule":
        return this.listAllPageRules(accountId);
      case "firewall-rule":
        return this.listAllFirewallRules(accountId);
      case "access-application":
        return this.listAccessApplications(accountId);
      case "load-balancer":
        return this.listAllLoadBalancers(accountId);
      case "worker-route":
        return this.listAllWorkerRoutes(accountId);
      case "custom-hostname":
        return this.listAllCustomHostnames(accountId);
      case "hyperdrive":
        return this.listHyperdrives(accountId);
      case "email-routing-rule":
        return this.listAllEmailRoutingRules(accountId);
      case "waiting-room":
        return this.listAllWaitingRooms(accountId);
      case "access-policy":
        return this.listAllAccessPolicies(accountId);
      case "spectrum-application":
        return this.listAllSpectrumApplications(accountId);
      case "logpush-job":
        return this.listAllLogpushJobs(accountId);
      default:
        throw new Error(`Cloudflare plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const externalId = resourceId.split(":").slice(2).join(":");

    if (typeId === "zone") {
      const zone = await this.fetch<Record<string, unknown>>(`/zones/${externalId}`);
      return this.mapZone(zone, accountId);
    }
    if (typeId === "dns-record") {
      const [zoneId, recordId] = externalId.split("/");
      if (!zoneId || !recordId) throw new Error("Invalid DNS record ID");
      const record = await this.fetch<Record<string, unknown>>(
        `/zones/${zoneId}/dns_records/${recordId}`,
      );
      return this.mapDnsRecord(record, accountId, zoneId);
    }
    if (typeId === "r2-bucket") {
      const cfAccountId = await this.getAccountId();
      const bucket = await this.fetch<Record<string, unknown>>(
        `/accounts/${cfAccountId}/r2/buckets/${externalId}`,
      );
      return this.mapR2Bucket(bucket, accountId, cfAccountId);
    }
    if (typeId === "d1-database") {
      const cfAccountId = await this.getAccountId();
      const db = await this.fetch<Record<string, unknown>>(
        `/accounts/${cfAccountId}/d1/database/${externalId}`,
      );
      return this.mapD1Database(db, accountId);
    }

    // Fallback: list all and find
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`Cloudflare plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    if (typeId === "zone") {
      if (outputKey === "zoneId") return resource.externalId ?? "";
      if (outputKey === "nameservers") return String(resource.fields["nameservers"] ?? "");
    }
    if (typeId === "r2-bucket") {
      if (outputKey === "bucketName") return String(resource.fields["name"] ?? "");
      if (outputKey === "s3Endpoint") {
        const cfAccountId = await this.getAccountId();
        return `https://${cfAccountId}.r2.cloudflarestorage.com`;
      }
    }
    if (typeId === "kv-namespace") {
      if (outputKey === "namespaceId") return resource.externalId ?? "";
    }
    if (typeId === "d1-database") {
      if (outputKey === "databaseId") return resource.externalId ?? "";
    }
    if (typeId === "queue") {
      if (outputKey === "queueId") return resource.externalId ?? "";
      if (outputKey === "queueName") return String(resource.fields["name"] ?? "");
    }
    if (typeId === "tunnel") {
      if (outputKey === "tunnelId") return resource.externalId ?? "";
      if (outputKey === "tunnelToken") {
        const cfAccountId = await this.getAccountId();
        // /cfd_tunnel/{id}/token returns result as a plain base64 string, not an object.
        return await this.fetch<string>(
          `/accounts/${cfAccountId}/cfd_tunnel/${resource.externalId}/token`,
        );
      }
    }
    if (typeId === "pages-project") {
      if (outputKey === "subdomain") return String(resource.fields["subdomain"] ?? "");
      if (outputKey === "projectName") return String(resource.fields["name"] ?? "");
    }
    if (typeId === "access-application") {
      if (outputKey === "aud") return String(resource.resolvedOutputs["aud"] ?? "");
    }
    if (typeId === "hyperdrive") {
      if (outputKey === "hyperdriveId") return resource.externalId ?? "";
    }
    throw new Error(`Cloudflare plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "zone":
        return renderZoneDetail(resource);
      case "dns-record": {
        const opts = Boolean(resource.fields["proxied"])
          ? {
              extraSections: [
                {
                  kind: "section" as const,
                  title: "Cloudflare Proxy",
                  children: [
                    {
                      kind: "text" as const,
                      content:
                        "Traffic to this record is routed through Cloudflare's network, providing DDoS protection, SSL, and caching.",
                      variant: "muted" as const,
                    },
                  ],
                },
              ],
            }
          : {};
        return renderDnsRecordDetail(resource, opts);
      }
      case "worker":
        return renderWorkerDetail(resource);
      case "r2-bucket":
        return renderR2BucketDetail(resource);
      case "pages-project":
        return renderPagesProjectDetail(resource);
      case "pages-deployment":
        return renderPagesDeploymentDetail(resource);
      case "kv-namespace":
        return renderKVNamespaceDetail(resource);
      case "d1-database":
        return renderD1DatabaseDetail(resource);
      case "queue":
        return renderQueueDetail(resource);
      case "tunnel":
        return renderTunnelDetail(resource);
      case "ssl-certificate":
        return renderSSLCertificateDetail(resource);
      case "page-rule":
        return renderPageRuleDetail(resource);
      case "firewall-rule":
        return renderFirewallRuleDetail(resource);
      case "access-application":
        return renderAccessApplicationDetail(resource);
      case "load-balancer":
        return renderLoadBalancerDetail(resource);
      case "worker-route":
        return renderWorkerRouteDetail(resource);
      case "custom-hostname":
        return renderCustomHostnameDetail(resource);
      case "hyperdrive":
        return renderHyperdriveDetail(resource);
      case "email-routing-rule":
        return renderEmailRoutingRuleDetail(resource);
      case "waiting-room":
        return renderWaitingRoomDetail(resource);
      case "access-policy":
        return renderAccessPolicyDetail(resource);
      case "spectrum-application":
        return renderSpectrumApplicationDetail(resource);
      case "logpush-job":
        return renderLogpushJobDetail(resource);
      default:
        return renderGenericDetail(resource, this.resourceTypes);
    }
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    if (resource.resourceTypeId === "dns-record") {
      return renderDnsRecordSidebar(resource);
    }
    if (resource.resourceTypeId === "zone") {
      const status = String(resource.fields["status"] ?? "");
      return {
        id: resource.id,
        label: resource.displayName,
        status: { kind: "status-dot", status: dnsZoneStatus(status), label: status },
      };
    }
    if (resource.resourceTypeId === "tunnel") {
      const status = String(resource.fields["status"] ?? "");
      return {
        id: resource.id,
        label: resource.displayName,
        status: { kind: "status-dot", status: tunnelStatus(status), label: status },
      };
    }
    if (resource.resourceTypeId === "pages-deployment") {
      const status = String(resource.fields["status"] ?? "");
      const env = String(resource.fields["environment"] ?? "");
      return {
        id: resource.id,
        label: `${env} · ${String(resource.fields["branch"] ?? "").slice(0, 20)}`,
        status: { kind: "status-dot", status: deploymentStatus(status), label: status },
      };
    }
    if (resource.resourceTypeId === "ssl-certificate") {
      const status = String(resource.fields["status"] ?? "");
      return {
        id: resource.id,
        label: resource.displayName,
        status: { kind: "status-dot", status: sslStatus(status), label: status },
      };
    }
    if (resource.resourceTypeId === "pages-project") {
      const latestStatus = String(resource.fields["latestDeploymentStatus"] ?? "");
      if (latestStatus) {
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: deploymentStatus(latestStatus),
            label: latestStatus,
          },
        };
      }
      return {
        id: resource.id,
        label: resource.displayName,
      };
    }
    if (resource.resourceTypeId === "load-balancer") {
      const enabled = Boolean(resource.fields["enabled"]);
      return {
        id: resource.id,
        label: resource.displayName,
        status: {
          kind: "status-dot",
          status: enabled ? "healthy" : "error",
          label: enabled ? "Enabled" : "Disabled",
        },
      };
    }
    if (resource.resourceTypeId === "firewall-rule") {
      const enabled = Boolean(resource.fields["enabled"]);
      return {
        id: resource.id,
        label: String(resource.fields["description"] || resource.displayName),
        status: {
          kind: "status-dot",
          status: enabled ? "healthy" : "info",
          label: enabled ? "Active" : "Disabled",
        },
      };
    }
    if (resource.resourceTypeId === "custom-hostname") {
      const status = String(resource.fields["status"] ?? "");
      return {
        id: resource.id,
        label: String(resource.fields["hostname"] ?? resource.displayName),
        status: {
          kind: "status-dot",
          status: status === "active" ? "healthy" : status === "pending" ? "provisioning" : "info",
          label: status,
        },
      };
    }
    if (resource.resourceTypeId === "waiting-room") {
      const suspended = Boolean(resource.fields["suspended"]);
      return {
        id: resource.id,
        label: resource.displayName,
        status: {
          kind: "status-dot",
          status: suspended ? "error" : "healthy",
          label: suspended ? "Suspended" : "Active",
        },
      };
    }
    if (resource.resourceTypeId === "access-policy") {
      const decision = String(resource.fields["decision"] ?? "");
      return {
        id: resource.id,
        label: resource.displayName,
        status: {
          kind: "status-dot",
          status: decision === "allow" ? "healthy" : decision === "deny" ? "error" : "info",
          label: decision,
        },
      };
    }
    if (resource.resourceTypeId === "logpush-job") {
      const enabled = Boolean(resource.fields["enabled"]);
      const lastError = String(resource.fields["lastError"] ?? "");
      return {
        id: resource.id,
        label: String(resource.fields["dataset"] ?? resource.displayName),
        status: {
          kind: "status-dot",
          status: !enabled ? "info" : lastError ? "error" : "healthy",
          label: !enabled ? "Disabled" : lastError ? "Error" : "Active",
        },
      };
    }
    if (resource.resourceTypeId === "spectrum-application") {
      return {
        id: resource.id,
        label: String(resource.fields["dns"] ?? resource.displayName),
        status: {
          kind: "status-dot",
          status: "healthy",
          label: String(resource.fields["protocol"] ?? ""),
        },
      };
    }
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: "info" },
    };
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    if (typeId === "zone") {
      return {
        fields: [
          {
            key: "name",
            label: "Domain Name",
            kind: "text",
            required: true,
            description: "The domain name to add to Cloudflare (e.g. example.com)",
          },
        ],
      };
    }
    if (typeId === "dns-record") {
      const fields: CreateResourceConfig["fields"] = [];
      if (!parentResourceId) {
        fields.push({
          key: "zoneId",
          label: "Zone",
          kind: "select",
          required: true,
          options: await this.getZoneOptions(),
        });
      }
      fields.push(
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
          ],
        },
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: true,
          description: 'Record name (e.g. "@" for root, "www" for subdomain)',
        },
        {
          key: "content",
          label: "Content",
          kind: "text",
          required: true,
          description: "Record value (e.g. IP address, hostname)",
        },
        {
          key: "ttl",
          label: "TTL",
          kind: "select",
          required: false,
          defaultValue: "1",
          options: [
            { id: "1", label: "Auto" },
            { id: "60", label: "1 minute" },
            { id: "300", label: "5 minutes" },
            { id: "600", label: "10 minutes" },
            { id: "3600", label: "1 hour" },
            { id: "86400", label: "1 day" },
          ],
        },
        {
          key: "proxied",
          label: "Proxied",
          kind: "select",
          required: false,
          defaultValue: "false",
          options: [
            { id: "true", label: "Proxied (orange cloud)" },
            { id: "false", label: "DNS Only (gray cloud)" },
          ],
        },
        {
          key: "priority",
          label: "Priority",
          kind: "number",
          required: false,
          description: "Required for MX and SRV records",
          showWhen: { fieldKey: "type", fieldValue: "MX" },
          minValue: 0,
          maxValue: 65535,
        },
      );
      return { fields };
    }
    if (typeId === "r2-bucket") {
      return {
        fields: [
          {
            key: "name",
            label: "Bucket Name",
            kind: "text",
            required: true,
            description: "Globally unique bucket name (lowercase, hyphens, 3-63 chars)",
          },
          {
            key: "locationHint",
            label: "Location Hint",
            kind: "select",
            required: false,
            options: [
              { id: "", label: "Automatic" },
              { id: "wnam", label: "Western North America" },
              { id: "enam", label: "Eastern North America" },
              { id: "weur", label: "Western Europe" },
              { id: "eeur", label: "Eastern Europe" },
              { id: "apac", label: "Asia-Pacific" },
            ],
          },
        ],
      };
    }
    if (typeId === "kv-namespace") {
      return {
        fields: [{ key: "title", label: "Namespace Title", kind: "text", required: true }],
      };
    }
    if (typeId === "d1-database") {
      return {
        fields: [{ key: "name", label: "Database Name", kind: "text", required: true }],
      };
    }
    if (typeId === "queue") {
      return {
        fields: [{ key: "queue_name", label: "Queue Name", kind: "text", required: true }],
      };
    }
    if (typeId === "hyperdrive") {
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "host",
            label: "Origin Host",
            kind: "text",
            required: true,
            description: "Hostname of the database server",
          },
          {
            key: "port",
            label: "Origin Port",
            kind: "number",
            required: true,
            defaultValue: "5432",
            minValue: 1,
            maxValue: 65535,
          },
          {
            key: "scheme",
            label: "Protocol",
            kind: "select",
            required: true,
            defaultValue: "postgres",
            options: [
              { id: "postgres", label: "PostgreSQL" },
              { id: "mysql", label: "MySQL" },
            ],
          },
          { key: "database", label: "Database Name", kind: "text", required: true },
          { key: "user", label: "Username", kind: "text", required: true },
          { key: "password", label: "Password", kind: "text", required: true },
        ],
      };
    }
    if (typeId === "pages-project") {
      return {
        fields: [
          {
            key: "name",
            label: "Project Name",
            kind: "text",
            required: true,
            description: "Name for the Pages project",
          },
          {
            key: "productionBranch",
            label: "Production Branch",
            kind: "text",
            required: true,
            defaultValue: "main",
            description: "Git branch to use for production deployments",
          },
        ],
      };
    }
    if (typeId === "tunnel") {
      return {
        fields: [
          {
            key: "name",
            label: "Tunnel Name",
            kind: "text",
            required: true,
            description: "A descriptive name for the tunnel",
          },
        ],
      };
    }
    if (typeId === "worker-route") {
      const fields: CreateResourceConfig["fields"] = [];
      if (!parentResourceId) {
        fields.push({
          key: "zoneId",
          label: "Zone",
          kind: "select",
          required: true,
          options: await this.getZoneOptions(),
        });
      }
      fields.push(
        {
          key: "pattern",
          label: "Route Pattern",
          kind: "text",
          required: true,
          description: "URL pattern (e.g. example.com/path/*)",
        },
        {
          key: "scriptName",
          label: "Worker Script",
          kind: "text",
          required: true,
          description: "Name of the Worker script to route to",
        },
      );
      return { fields };
    }
    if (typeId === "page-rule") {
      const fields: CreateResourceConfig["fields"] = [];
      if (!parentResourceId) {
        fields.push({
          key: "zoneId",
          label: "Zone",
          kind: "select",
          required: true,
          options: await this.getZoneOptions(),
        });
      }
      fields.push(
        {
          key: "urlPattern",
          label: "URL Pattern",
          kind: "text",
          required: true,
          description: "URL pattern to match (e.g. *example.com/images/*)",
        },
        {
          key: "action",
          label: "Action",
          kind: "select",
          required: true,
          options: [
            { id: "forwarding_url", label: "Forwarding URL" },
            { id: "always_use_https", label: "Always Use HTTPS" },
            { id: "cache_level", label: "Cache Level" },
            { id: "ssl", label: "SSL" },
            { id: "browser_cache_ttl", label: "Browser Cache TTL" },
            { id: "security_level", label: "Security Level" },
          ],
        },
        {
          key: "actionValue",
          label: "Action Value",
          kind: "text",
          required: false,
          description: "Value for the action (e.g. URL for forwarding, cache level)",
        },
      );
      return { fields };
    }
    if (typeId === "firewall-rule") {
      const fields: CreateResourceConfig["fields"] = [];
      if (!parentResourceId) {
        fields.push({
          key: "zoneId",
          label: "Zone",
          kind: "select",
          required: true,
          options: await this.getZoneOptions(),
        });
      }
      fields.push(
        {
          key: "description",
          label: "Description",
          kind: "text",
          required: false,
          description: "A human-readable description for this rule",
        },
        {
          key: "expression",
          label: "Expression",
          kind: "text",
          required: true,
          description: "Firewall expression (e.g. ip.src eq 1.2.3.4)",
        },
        {
          key: "action",
          label: "Action",
          kind: "select",
          required: true,
          options: [
            { id: "block", label: "Block" },
            { id: "challenge", label: "Challenge" },
            { id: "js_challenge", label: "JS Challenge" },
            { id: "managed_challenge", label: "Managed Challenge" },
            { id: "allow", label: "Allow" },
            { id: "log", label: "Log" },
            { id: "skip", label: "Skip" },
          ],
        },
      );
      return { fields };
    }
    if (typeId === "custom-hostname") {
      const fields: CreateResourceConfig["fields"] = [];
      if (!parentResourceId) {
        fields.push({
          key: "zoneId",
          label: "Zone",
          kind: "select",
          required: true,
          options: await this.getZoneOptions(),
        });
      }
      fields.push(
        {
          key: "hostname",
          label: "Hostname",
          kind: "text",
          required: true,
          description: "The custom hostname to add (e.g. app.customer.com)",
        },
        {
          key: "sslMethod",
          label: "SSL Validation Method",
          kind: "select",
          required: true,
          defaultValue: "http",
          options: [
            { id: "http", label: "HTTP" },
            { id: "txt", label: "TXT (DNS)" },
            { id: "email", label: "Email" },
          ],
        },
      );
      return { fields };
    }
    if (typeId === "email-routing-rule") {
      const fields: CreateResourceConfig["fields"] = [];
      if (!parentResourceId) {
        fields.push({
          key: "zoneId",
          label: "Zone",
          kind: "select",
          required: true,
          options: await this.getZoneOptions(),
        });
      }
      fields.push(
        {
          key: "name",
          label: "Rule Name",
          kind: "text",
          required: false,
          description: "A descriptive name for the rule",
        },
        {
          key: "matcherField",
          label: "Match Field",
          kind: "select",
          required: true,
          options: [
            { id: "to", label: "Recipient (To)" },
            { id: "from", label: "Sender (From)" },
          ],
        },
        {
          key: "matcherValue",
          label: "Match Value",
          kind: "text",
          required: true,
          description: "Email address to match",
        },
        {
          key: "actionType",
          label: "Action",
          kind: "select",
          required: true,
          options: [
            { id: "forward", label: "Forward to" },
            { id: "worker", label: "Send to Worker" },
            { id: "drop", label: "Drop" },
          ],
        },
        {
          key: "actionValue",
          label: "Action Value",
          kind: "text",
          required: false,
          description: "Destination email address (for forward) or Worker name",
        },
      );
      return { fields };
    }
    if (typeId === "waiting-room") {
      const fields: CreateResourceConfig["fields"] = [];
      if (!parentResourceId) {
        fields.push({
          key: "zoneId",
          label: "Zone",
          kind: "select",
          required: true,
          options: await this.getZoneOptions(),
        });
      }
      fields.push(
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: true,
          description: "Unique name for the waiting room",
        },
        {
          key: "host",
          label: "Host",
          kind: "text",
          required: true,
          description: "Hostname to apply the waiting room to",
        },
        {
          key: "totalActiveUsers",
          label: "Total Active Users",
          kind: "number",
          required: true,
          description: "Maximum number of active users allowed",
          minValue: 200,
          maxValue: 2147483647,
        },
        {
          key: "newUsersPerMinute",
          label: "New Users Per Minute",
          kind: "number",
          required: true,
          description: "Rate of new users admitted per minute",
          minValue: 200,
          maxValue: 2147483647,
        },
      );
      return { fields };
    }
    if (typeId === "ssl-certificate") {
      const fields: CreateResourceConfig["fields"] = [];
      if (!parentResourceId) {
        fields.push({
          key: "zoneId",
          label: "Zone",
          kind: "select",
          required: true,
          options: await this.getZoneOptions(),
        });
      }
      fields.push(
        {
          key: "certificate",
          label: "Certificate (PEM)",
          kind: "text",
          required: true,
          description: "The PEM-encoded SSL certificate",
        },
        {
          key: "privateKey",
          label: "Private Key (PEM)",
          kind: "text",
          required: true,
          description: "The PEM-encoded private key",
        },
      );
      return { fields };
    }
    if (typeId === "logpush-job") {
      const fields: CreateResourceConfig["fields"] = [];
      if (!parentResourceId) {
        fields.push({
          key: "zoneId",
          label: "Zone",
          kind: "select",
          required: true,
          options: await this.getZoneOptions(),
        });
      }
      fields.push(
        {
          key: "destinationConf",
          label: "Destination",
          kind: "text",
          required: true,
          description: "Destination URL (e.g. s3://bucket/path?region=us-east-1)",
        },
        {
          key: "dataset",
          label: "Dataset",
          kind: "select",
          required: true,
          options: [
            { id: "http_requests", label: "HTTP Requests" },
            { id: "firewall_events", label: "Firewall Events" },
            { id: "spectrum_events", label: "Spectrum Events" },
            { id: "nel_reports", label: "NEL Reports" },
            { id: "dns_logs", label: "DNS Logs" },
          ],
        },
        {
          key: "name",
          label: "Job Name",
          kind: "text",
          required: false,
          description: "Optional name for the logpush job",
        },
      );
      return { fields };
    }
    if (typeId === "access-application") {
      return {
        fields: [
          {
            key: "name",
            label: "Application Name",
            kind: "text",
            required: true,
            description: "Name for the Access application",
          },
          {
            key: "domain",
            label: "Application Domain",
            kind: "text",
            required: true,
            description: "Domain the application is available on (e.g. app.example.com)",
          },
          {
            key: "type",
            label: "Application Type",
            kind: "select",
            required: true,
            defaultValue: "self_hosted",
            options: [
              { id: "self_hosted", label: "Self-Hosted" },
              { id: "saas", label: "SaaS" },
              { id: "ssh", label: "SSH" },
              { id: "vnc", label: "VNC" },
              { id: "bookmark", label: "Bookmark" },
            ],
          },
        ],
      };
    }
    if (typeId === "access-policy") {
      const fields: CreateResourceConfig["fields"] = [];
      if (!parentResourceId) {
        fields.push({
          key: "appId",
          label: "Access Application",
          kind: "select",
          required: true,
          options: await this.getAccessAppOptions(),
        });
      }
      fields.push(
        {
          key: "name",
          label: "Policy Name",
          kind: "text",
          required: true,
          description: "Name for the policy",
        },
        {
          key: "decision",
          label: "Decision",
          kind: "select",
          required: true,
          options: [
            { id: "allow", label: "Allow" },
            { id: "deny", label: "Deny" },
            { id: "non_identity", label: "Non-Identity" },
            { id: "bypass", label: "Bypass" },
          ],
        },
        {
          key: "includeEmail",
          label: "Include Email",
          kind: "text",
          required: true,
          description: "Email address or domain to include (e.g. user@example.com or @example.com)",
        },
      );
      return { fields };
    }
    if (typeId === "load-balancer") {
      const fields: CreateResourceConfig["fields"] = [];
      if (!parentResourceId) {
        fields.push({
          key: "zoneId",
          label: "Zone",
          kind: "select",
          required: true,
          options: await this.getZoneOptions(),
        });
      }
      fields.push(
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: true,
          description: "DNS name for the load balancer (e.g. lb.example.com)",
        },
        {
          key: "fallbackPool",
          label: "Fallback Pool ID",
          kind: "text",
          required: true,
          description: "Pool ID to use when all other pools are unhealthy",
        },
        {
          key: "defaultPools",
          label: "Default Pool IDs",
          kind: "text",
          required: true,
          description: "Comma-separated list of pool IDs for default traffic",
        },
      );
      return { fields };
    }
    if (typeId === "spectrum-application") {
      const fields: CreateResourceConfig["fields"] = [];
      if (!parentResourceId) {
        fields.push({
          key: "zoneId",
          label: "Zone",
          kind: "select",
          required: true,
          options: await this.getZoneOptions(),
        });
      }
      fields.push(
        {
          key: "protocol",
          label: "Protocol",
          kind: "select",
          required: true,
          options: [
            { id: "tcp/22", label: "TCP/22 (SSH)" },
            { id: "tcp/80", label: "TCP/80 (HTTP)" },
            { id: "tcp/443", label: "TCP/443 (HTTPS)" },
            { id: "tcp/3389", label: "TCP/3389 (RDP)" },
            { id: "tcp/8080", label: "TCP/8080" },
            { id: "udp/53", label: "UDP/53 (DNS)" },
          ],
        },
        {
          key: "dns",
          label: "DNS Name",
          kind: "text",
          required: true,
          description: "Subdomain for the Spectrum app (e.g. ssh.example.com)",
        },
        {
          key: "originDirect",
          label: "Origin Direct",
          kind: "text",
          required: true,
          description: "Origin address in IP:port format (e.g. 203.0.113.1:22)",
        },
        {
          key: "ipFirewall",
          label: "IP Firewall",
          kind: "select",
          required: false,
          options: [
            { id: "true", label: "Enabled" },
            { id: "false", label: "Disabled" },
          ],
          defaultValue: "false",
        },
      );
      return { fields };
    }
    if (typeId === "worker") {
      return {
        fields: [
          {
            key: "name",
            label: "Worker Name",
            kind: "text",
            required: true,
            description: "Script name for the worker",
          },
          {
            key: "script",
            label: "Script Content",
            kind: "text",
            required: true,
            defaultValue:
              'export default {\n  async fetch(request) {\n    return new Response("Hello World!");\n  }\n};',
            description: "Worker script (ES module format)",
          },
          {
            key: "compatibilityDate",
            label: "Compatibility Date",
            kind: "datetime",
            datetimeMode: "date",
            required: false,
            defaultValue: new Date().toISOString().split("T")[0] ?? "",
          },
        ],
      };
    }
    throw new Error(`Cloudflare plugin: getCreateConfig not supported for type "${typeId}"`);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const parentExternalId = parentResourceId ? parentResourceId.split(":").slice(2).join(":") : "";
    if (typeId === "zone") {
      const zone = await this.fetch<Record<string, unknown>>("/zones", {
        method: "POST",
        body: JSON.stringify({ name: fields["name"], type: "full" }),
      });
      return this.mapZone(zone, accountId);
    }
    if (typeId === "dns-record") {
      const zoneId = fields["zoneId"] || parentExternalId;
      if (!zoneId) throw new Error("Cloudflare plugin: zoneId is required to create a DNS record");
      const body: Record<string, unknown> = {
        type: fields["type"],
        name: fields["name"],
        content: fields["content"],
        ttl: Number(fields["ttl"] ?? 1),
        proxied: fields["proxied"] === "true",
      };
      if (fields["priority"]) {
        body["priority"] = Number(fields["priority"]);
      }
      const record = await this.fetch<Record<string, unknown>>(`/zones/${zoneId}/dns_records`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return this.mapDnsRecord(record, accountId, zoneId);
    }
    if (typeId === "r2-bucket") {
      const cfAccountId = await this.getAccountId();
      const body: Record<string, unknown> = { name: fields["name"] };
      if (fields["locationHint"]) body["locationHint"] = fields["locationHint"];
      const bucket = await this.fetch<Record<string, unknown>>(
        `/accounts/${cfAccountId}/r2/buckets`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );
      return this.mapR2Bucket(bucket, accountId, cfAccountId);
    }
    if (typeId === "kv-namespace") {
      const cfAccountId = await this.getAccountId();
      const ns = await this.fetch<Record<string, unknown>>(
        `/accounts/${cfAccountId}/storage/kv/namespaces`,
        {
          method: "POST",
          body: JSON.stringify({ title: fields["title"] }),
        },
      );
      return this.mapKVNamespace(ns, accountId);
    }
    if (typeId === "d1-database") {
      const cfAccountId = await this.getAccountId();
      const db = await this.fetch<Record<string, unknown>>(`/accounts/${cfAccountId}/d1/database`, {
        method: "POST",
        body: JSON.stringify({ name: fields["name"] }),
      });
      return this.mapD1Database(db, accountId);
    }
    if (typeId === "queue") {
      const cfAccountId = await this.getAccountId();
      const q = await this.fetch<Record<string, unknown>>(`/accounts/${cfAccountId}/queues`, {
        method: "POST",
        body: JSON.stringify({ queue_name: fields["queue_name"] }),
      });
      return this.mapQueue(q, accountId);
    }
    if (typeId === "hyperdrive") {
      const cfAccountId = await this.getAccountId();
      const hd = await this.fetch<Record<string, unknown>>(
        `/accounts/${cfAccountId}/hyperdrive/configs`,
        {
          method: "POST",
          body: JSON.stringify({
            name: fields["name"],
            origin: {
              scheme: fields["scheme"] ?? "postgres",
              host: fields["host"],
              port: Number(fields["port"] ?? 5432),
              database: fields["database"],
              user: fields["user"],
              password: fields["password"],
            },
          }),
        },
      );
      return this.mapHyperdrive(hd, accountId);
    }
    if (typeId === "pages-project") {
      const cfAccountId = await this.getAccountId();
      const project = await this.fetch<Record<string, unknown>>(
        `/accounts/${cfAccountId}/pages/projects`,
        {
          method: "POST",
          body: JSON.stringify({
            name: fields["name"] ?? "",
            production_branch: fields["productionBranch"] ?? "main",
          }),
        },
      );
      return this.mapPagesProject(project, accountId);
    }
    if (typeId === "tunnel") {
      const cfAccountId = await this.getAccountId();
      const tunnel = await this.fetch<Record<string, unknown>>(
        `/accounts/${cfAccountId}/cfd_tunnel`,
        {
          method: "POST",
          body: JSON.stringify({
            name: fields["name"] ?? "",
            tunnel_secret: btoa(crypto.randomUUID()),
          }),
        },
      );
      return this.mapTunnel(tunnel, accountId);
    }
    if (typeId === "worker-route") {
      const zoneId = fields["zoneId"] || parentExternalId;
      if (!zoneId)
        throw new Error("Cloudflare plugin: zoneId is required to create a worker route");
      const route = await this.fetch<Record<string, unknown>>(`/zones/${zoneId}/workers/routes`, {
        method: "POST",
        body: JSON.stringify({
          pattern: fields["pattern"] ?? "",
          script: fields["scriptName"] ?? "",
        }),
      });
      return this.mapWorkerRoute(route, accountId, zoneId);
    }
    if (typeId === "page-rule") {
      const zoneId = fields["zoneId"] || parentExternalId;
      if (!zoneId) throw new Error("Cloudflare plugin: zoneId is required to create a page rule");
      const body: Record<string, unknown> = {
        targets: [
          {
            target: "url",
            constraint: { operator: "matches", value: fields["urlPattern"] ?? "" },
          },
        ],
        actions: [
          {
            id: fields["action"] ?? "",
            ...(fields["actionValue"] ? { value: fields["actionValue"] } : {}),
          },
        ],
        status: "active",
      };
      const rule = await this.fetch<Record<string, unknown>>(`/zones/${zoneId}/pagerules`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return this.mapPageRule(rule, accountId, zoneId);
    }
    if (typeId === "firewall-rule") {
      const zoneId = fields["zoneId"] || parentExternalId;
      if (!zoneId)
        throw new Error("Cloudflare plugin: zoneId is required to create a firewall rule");
      // Get or create the http_request_firewall_custom phase ruleset
      let rulesetId = "";
      try {
        const rulesets = await this.fetch<Array<Record<string, unknown>>>(
          `/zones/${zoneId}/rulesets`,
        );
        const customRuleset = (rulesets ?? []).find(
          (rs: Record<string, unknown>) => rs["phase"] === "http_request_firewall_custom",
        );
        if (customRuleset) {
          rulesetId = String(customRuleset["id"]);
        }
      } catch {
        // Ignore - we'll create via the phase entrypoint
      }
      const ruleBody = {
        description: fields["description"] ?? "",
        expression: fields["expression"] ?? "",
        action: fields["action"] ?? "",
        enabled: true,
      };
      let result: Record<string, unknown>;
      if (rulesetId) {
        const ruleset = await this.fetch<Record<string, unknown>>(
          `/zones/${zoneId}/rulesets/${rulesetId}/rules`,
          {
            method: "POST",
            body: JSON.stringify(ruleBody),
          },
        );
        const rules = (ruleset["rules"] as Array<Record<string, unknown>>) ?? [];
        result = rules[rules.length - 1] ?? ruleset;
      } else {
        const ruleset = await this.fetch<Record<string, unknown>>(`/zones/${zoneId}/rulesets`, {
          method: "POST",
          body: JSON.stringify({
            name: "Custom Firewall Rules",
            kind: "zone",
            phase: "http_request_firewall_custom",
            rules: [ruleBody],
          }),
        });
        rulesetId = String(ruleset["id"] ?? "");
        const rules = (ruleset["rules"] as Array<Record<string, unknown>>) ?? [];
        result = rules[0] ?? ruleset;
      }
      return this.mapFirewallRule(result, accountId, zoneId, rulesetId);
    }
    if (typeId === "custom-hostname") {
      const zoneId = fields["zoneId"] || parentExternalId;
      if (!zoneId)
        throw new Error("Cloudflare plugin: zoneId is required to create a custom hostname");
      const ch = await this.fetch<Record<string, unknown>>(`/zones/${zoneId}/custom_hostnames`, {
        method: "POST",
        body: JSON.stringify({
          hostname: fields["hostname"] ?? "",
          ssl: {
            method: fields["sslMethod"] ?? "http",
            type: "dv",
          },
        }),
      });
      return this.mapCustomHostname(ch, accountId, zoneId);
    }
    if (typeId === "email-routing-rule") {
      const zoneId = fields["zoneId"] || parentExternalId;
      if (!zoneId)
        throw new Error("Cloudflare plugin: zoneId is required to create an email routing rule");
      const matcherField = fields["matcherField"] ?? "to";
      const matcherValue = fields["matcherValue"] ?? "";
      const actionType = fields["actionType"] ?? "forward";
      const actionValue = fields["actionValue"] ?? "";
      const body: Record<string, unknown> = {
        name: fields["name"] ?? "",
        enabled: true,
        matchers: [{ type: "literal", field: matcherField, value: matcherValue }],
        actions: [
          {
            type: actionType,
            ...(actionType !== "drop" && actionValue ? { value: [actionValue] } : {}),
          },
        ],
      };
      const rule = await this.fetch<Record<string, unknown>>(
        `/zones/${zoneId}/email/routing/rules`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );
      return this.mapEmailRoutingRule(rule, accountId, zoneId);
    }
    if (typeId === "waiting-room") {
      const zoneId = fields["zoneId"] || parentExternalId;
      if (!zoneId)
        throw new Error("Cloudflare plugin: zoneId is required to create a waiting room");
      const room = await this.fetch<Record<string, unknown>>(`/zones/${zoneId}/waiting_rooms`, {
        method: "POST",
        body: JSON.stringify({
          name: fields["name"] ?? "",
          host: fields["host"] ?? "",
          total_active_users: Number(fields["totalActiveUsers"] ?? 200),
          new_users_per_minute: Number(fields["newUsersPerMinute"] ?? 200),
        }),
      });
      return this.mapWaitingRoom(room, accountId, zoneId);
    }
    if (typeId === "ssl-certificate") {
      const zoneId = fields["zoneId"] || parentExternalId;
      if (!zoneId)
        throw new Error("Cloudflare plugin: zoneId is required to create an SSL certificate");
      const cert = await this.fetch<Record<string, unknown>>(
        `/zones/${zoneId}/custom_certificates`,
        {
          method: "POST",
          body: JSON.stringify({
            certificate: fields["certificate"] ?? "",
            private_key: fields["privateKey"] ?? "",
          }),
        },
      );
      // Map using the zone name from the zone lookup
      const zones = await this.paginate<Record<string, unknown>>("/zones");
      const zone = zones.find((z) => String(z["id"]) === zoneId);
      const zoneName = zone ? String(zone["name"]) : "";
      return this.mapSSLCertificate(cert, accountId, zoneId, zoneName);
    }
    if (typeId === "logpush-job") {
      const zoneId = fields["zoneId"] || parentExternalId;
      if (!zoneId) throw new Error("Cloudflare plugin: zoneId is required to create a logpush job");
      const body: Record<string, unknown> = {
        destination_conf: fields["destinationConf"] ?? "",
        dataset: fields["dataset"] ?? "",
        enabled: true,
      };
      if (fields["name"]) body["name"] = fields["name"];
      const job = await this.fetch<Record<string, unknown>>(`/zones/${zoneId}/logpush/jobs`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return this.mapLogpushJob(job, accountId, zoneId);
    }
    if (typeId === "access-application") {
      const cfAccountId = await this.getAccountId();
      const app = await this.fetch<Record<string, unknown>>(
        `/accounts/${cfAccountId}/access/apps`,
        {
          method: "POST",
          body: JSON.stringify({
            name: fields["name"] ?? "",
            domain: fields["domain"] ?? "",
            type: fields["type"] ?? "self_hosted",
          }),
        },
      );
      return this.mapAccessApplication(app, accountId);
    }
    if (typeId === "access-policy") {
      const cfAccountId = await this.getAccountId();
      const appId = fields["appId"] || parentExternalId;
      if (!appId)
        throw new Error("Cloudflare plugin: appId is required to create an access policy");
      const includeEmail = fields["includeEmail"] ?? "";
      const includeRule: Record<string, unknown> = includeEmail.startsWith("@")
        ? { email_domain: { domain: includeEmail.slice(1) } }
        : { email: { email: includeEmail } };
      const policy = await this.fetch<Record<string, unknown>>(
        `/accounts/${cfAccountId}/access/apps/${appId}/policies`,
        {
          method: "POST",
          body: JSON.stringify({
            name: fields["name"] ?? "",
            decision: fields["decision"] ?? "allow",
            include: [includeRule],
          }),
        },
      );
      return this.mapAccessPolicy(policy, accountId, appId);
    }
    if (typeId === "load-balancer") {
      const zoneId = fields["zoneId"] || parentExternalId;
      if (!zoneId)
        throw new Error("Cloudflare plugin: zoneId is required to create a load balancer");
      const defaultPoolIds = (fields["defaultPools"] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const lb = await this.fetch<Record<string, unknown>>(`/zones/${zoneId}/load_balancers`, {
        method: "POST",
        body: JSON.stringify({
          name: fields["name"] ?? "",
          fallback_pool: fields["fallbackPool"] ?? "",
          default_pools: defaultPoolIds,
        }),
      });
      return this.mapLoadBalancer(lb, accountId, zoneId);
    }
    if (typeId === "spectrum-application") {
      const zoneId = fields["zoneId"] || parentExternalId;
      if (!zoneId)
        throw new Error("Cloudflare plugin: zoneId is required to create a spectrum application");
      const protocol = fields["protocol"] ?? "tcp/22";
      const dns = fields["dns"] ?? "";
      const originDirect = fields["originDirect"] ?? "";
      const app = await this.fetch<Record<string, unknown>>(`/zones/${zoneId}/spectrum/apps`, {
        method: "POST",
        body: JSON.stringify({
          protocol,
          dns: { type: "CNAME", name: dns },
          origin_direct: [originDirect],
          ip_firewall: fields["ipFirewall"] === "true",
        }),
      });
      return this.mapSpectrumApplication(app, accountId, zoneId);
    }
    if (typeId === "worker") {
      const cfAccountId = await this.getAccountId();
      const name = fields["name"] ?? "";
      const script =
        fields["script"] ?? 'export default { async fetch() { return new Response("Hello"); } };';
      const compatibilityDate =
        fields["compatibilityDate"] ?? new Date().toISOString().split("T")[0] ?? "";
      // Workers API requires multipart form data for module workers
      const formData = new FormData();
      formData.append(
        "metadata",
        JSON.stringify({
          main_module: "worker.js",
          compatibility_date: compatibilityDate,
        }),
      );
      formData.append(
        "worker.js",
        new Blob([script], { type: "application/javascript+module" }),
        "worker.js",
      );
      const res = await fetch(`${this.baseUrl}/accounts/${cfAccountId}/workers/scripts/${name}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${this.apiToken}` },
        body: formData,
      });
      if (!res.ok) throw new Error(`Worker create failed: ${res.status}: ${await res.text()}`);
      const now = new Date().toISOString();
      return {
        id: `${accountId}:worker:${name}`,
        pluginId: "cloudflare",
        resourceTypeId: "worker",
        accountId,
        displayName: name,
        fields: {
          name,
          createdOn: now,
          modifiedOn: now,
          compatibilityDate,
          routes: "",
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: name,
        createdAt: now,
        updatedAt: now,
      };
    }
    throw new Error(`Cloudflare plugin: createResource not supported for type "${typeId}"`);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = resourceId.split(":").slice(2).join(":");

    if (typeId === "zone") {
      await this.fetch(`/zones/${externalId}`, { method: "DELETE" });
      return;
    }
    if (typeId === "dns-record") {
      const [zoneId, recordId] = externalId.split("/");
      if (!zoneId || !recordId) throw new Error("Invalid DNS record ID");
      await this.fetch(`/zones/${zoneId}/dns_records/${recordId}`, { method: "DELETE" });
      return;
    }
    if (typeId === "r2-bucket") {
      const cfAccountId = await this.getAccountId();
      await this.fetch(`/accounts/${cfAccountId}/r2/buckets/${externalId}`, { method: "DELETE" });
      return;
    }
    if (typeId === "kv-namespace") {
      const cfAccountId = await this.getAccountId();
      await this.fetch(`/accounts/${cfAccountId}/storage/kv/namespaces/${externalId}`, {
        method: "DELETE",
      });
      return;
    }
    if (typeId === "d1-database") {
      const cfAccountId = await this.getAccountId();
      await this.fetch(`/accounts/${cfAccountId}/d1/database/${externalId}`, { method: "DELETE" });
      return;
    }
    if (typeId === "queue") {
      const cfAccountId = await this.getAccountId();
      await this.fetch(`/accounts/${cfAccountId}/queues/${externalId}`, { method: "DELETE" });
      return;
    }
    if (typeId === "hyperdrive") {
      const cfAccountId = await this.getAccountId();
      await this.fetch(`/accounts/${cfAccountId}/hyperdrive/configs/${externalId}`, {
        method: "DELETE",
      });
      return;
    }
    if (typeId === "worker") {
      const cfAccountId = await this.getAccountId();
      await this.fetch(`/accounts/${cfAccountId}/workers/scripts/${externalId}`, {
        method: "DELETE",
      });
      return;
    }
    if (typeId === "pages-project") {
      const cfAccountId = await this.getAccountId();
      await this.fetch(`/accounts/${cfAccountId}/pages/projects/${externalId}`, {
        method: "DELETE",
      });
      return;
    }
    if (typeId === "pages-deployment") {
      const cfAccountId = await this.getAccountId();
      const [project, deploymentId] = externalId.split("/");
      if (!project || !deploymentId) throw new Error("Invalid pages deployment ID");
      await this.fetch(
        `/accounts/${cfAccountId}/pages/projects/${project}/deployments/${deploymentId}`,
        { method: "DELETE" },
      );
      return;
    }
    if (typeId === "tunnel") {
      const cfAccountId = await this.getAccountId();
      await this.fetch(`/accounts/${cfAccountId}/cfd_tunnel/${externalId}`, { method: "DELETE" });
      return;
    }
    if (typeId === "ssl-certificate") {
      const [zoneId, certId] = externalId.split("/");
      if (!zoneId || !certId) throw new Error("Invalid SSL certificate ID");
      await this.fetch(`/zones/${zoneId}/custom_certificates/${certId}`, { method: "DELETE" });
      return;
    }
    if (typeId === "page-rule") {
      const [zoneId, ruleId] = externalId.split("/");
      if (!zoneId || !ruleId) throw new Error("Invalid page rule ID");
      await this.fetch(`/zones/${zoneId}/pagerules/${ruleId}`, { method: "DELETE" });
      return;
    }
    if (typeId === "firewall-rule") {
      const [zoneId, rulesetId, ruleId] = externalId.split("/");
      if (!zoneId || !rulesetId || !ruleId) throw new Error("Invalid firewall rule ID");
      await this.fetch(`/zones/${zoneId}/rulesets/${rulesetId}/rules/${ruleId}`, {
        method: "DELETE",
      });
      return;
    }
    if (typeId === "access-application") {
      const cfAccountId = await this.getAccountId();
      await this.fetch(`/accounts/${cfAccountId}/access/apps/${externalId}`, {
        method: "DELETE",
      });
      return;
    }
    if (typeId === "load-balancer") {
      const [zoneId, lbId] = externalId.split("/");
      if (!zoneId || !lbId) throw new Error("Invalid load balancer ID");
      await this.fetch(`/zones/${zoneId}/load_balancers/${lbId}`, { method: "DELETE" });
      return;
    }
    if (typeId === "worker-route") {
      const [zoneId, routeId] = externalId.split("/");
      if (!zoneId || !routeId) throw new Error("Invalid worker route ID");
      await this.fetch(`/zones/${zoneId}/workers/routes/${routeId}`, { method: "DELETE" });
      return;
    }
    if (typeId === "custom-hostname") {
      const [zoneId, hostnameId] = externalId.split("/");
      if (!zoneId || !hostnameId) throw new Error("Invalid custom hostname ID");
      await this.fetch(`/zones/${zoneId}/custom_hostnames/${hostnameId}`, { method: "DELETE" });
      return;
    }
    if (typeId === "waiting-room") {
      const [zoneId, roomId] = externalId.split("/");
      if (!zoneId || !roomId) throw new Error("Invalid waiting room ID");
      await this.fetch(`/zones/${zoneId}/waiting_rooms/${roomId}`, { method: "DELETE" });
      return;
    }
    if (typeId === "spectrum-application") {
      const [zoneId, appId] = externalId.split("/");
      if (!zoneId || !appId) throw new Error("Invalid spectrum application ID");
      await this.fetch(`/zones/${zoneId}/spectrum/apps/${appId}`, { method: "DELETE" });
      return;
    }
    if (typeId === "logpush-job") {
      const [zoneId, jobId] = externalId.split("/");
      if (!zoneId || !jobId) throw new Error("Invalid logpush job ID");
      await this.fetch(`/zones/${zoneId}/logpush/jobs/${jobId}`, { method: "DELETE" });
      return;
    }
    throw new Error(`Cloudflare plugin: deleteResource not supported for type "${typeId}"`);
  }

  async executeQuery(
    resourceId: string,
    _accountId: string,
    sql: string,
  ): Promise<{ rows: Record<string, unknown>[]; durationMs: number }> {
    const externalId = resourceId.split(":").slice(2).join(":");
    const cfAccountId = await this.getAccountId();
    const start = Date.now();

    const result = await this.fetch<
      Array<{
        results?: Array<Record<string, unknown>>;
        success?: boolean;
        meta?: { duration?: number; changes?: number; rows_read?: number; rows_written?: number };
      }>
    >(`/accounts/${cfAccountId}/d1/database/${externalId}/query`, {
      method: "POST",
      body: JSON.stringify({ sql }),
    });

    const durationMs = Date.now() - start;
    const first = Array.isArray(result) ? result[0] : result;
    const rows = (first as { results?: Array<Record<string, unknown>> })?.results ?? [];
    return { rows, durationMs };
  }

  async introspectResource(resourceId: string, _accountId: string): Promise<SqlTableMeta[]> {
    const externalId = resourceId.split(":").slice(2).join(":");
    const cfAccountId = await this.getAccountId();

    // Query sqlite_master for tables
    const tablesResult = await this.fetch<
      Array<{
        results?: Array<Record<string, unknown>>;
      }>
    >(`/accounts/${cfAccountId}/d1/database/${externalId}/query`, {
      method: "POST",
      body: JSON.stringify({
        sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
      }),
    });

    const first = Array.isArray(tablesResult) ? tablesResult[0] : tablesResult;
    const tables = (first as { results?: Array<Record<string, unknown>> })?.results ?? [];
    const result: SqlTableMeta[] = [];

    for (const table of tables) {
      const tableName = String(table["name"] ?? "");
      if (!tableName) continue;

      const columnsResult = await this.fetch<
        Array<{
          results?: Array<Record<string, unknown>>;
        }>
      >(`/accounts/${cfAccountId}/d1/database/${externalId}/query`, {
        method: "POST",
        body: JSON.stringify({ sql: `PRAGMA table_info('${tableName.replace(/'/g, "''")}')` }),
      });

      const firstCol = Array.isArray(columnsResult) ? columnsResult[0] : columnsResult;
      const cols = (firstCol as { results?: Array<Record<string, unknown>> })?.results ?? [];
      const pkColumns: string[] = [];

      const meta: SqlTableMeta = {
        name: tableName,
        columns: cols.map((c) => {
          const name = String(c["name"] ?? "");
          if (Number(c["pk"]) > 0) pkColumns.push(name);
          return {
            name,
            type: String(c["type"] ?? "TEXT"),
          };
        }),
      };
      if (pkColumns.length > 0) meta.pkColumns = pkColumns;
      result.push(meta);
    }

    return result;
  }

  async exportCredential(
    typeId: string,
    resourceId: string,
    accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    if (typeId === "tunnel" && formatId === "tunnel-token") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const cfAccountId = await this.getAccountId();
      const token = await this.fetch<string>(
        `/accounts/${cfAccountId}/cfd_tunnel/${resource.externalId}/token`,
      );
      const name = String(resource.fields["name"] ?? resource.externalId ?? "tunnel");
      return {
        content: token,
        filename: `${name}.token`,
        mimeType: "text/plain",
        fields: [
          { label: "Tunnel ID", value: String(resource.externalId ?? "") },
          { label: "Run Token", value: token, sensitive: true, hint: "Paste into cloudflared" },
        ],
        warning:
          "Run with: cloudflared tunnel run --token <token>. Anyone with this token can impersonate the tunnel. Rotate via the Cloudflare dashboard if exposed.",
      };
    }
    throw new Error(
      `Cloudflare plugin: exportCredential not supported for type "${typeId}" / format "${formatId}"`,
    );
  }

  async getManifest(resourceId: string, _accountId: string): Promise<string> {
    const parts = resourceId.split(":");
    const typeId = parts[1];
    const externalId = parts.slice(2).join(":");

    if (typeId === "worker") {
      const cfAccountId = await this.getAccountId();
      const settings = await this.fetch<Record<string, unknown>>(
        `/accounts/${cfAccountId}/workers/scripts/${externalId}/settings`,
      );
      return JSON.stringify(settings, null, 2);
    }
    if (typeId === "zone") {
      const settings = await this.fetch<Record<string, unknown>>(`/zones/${externalId}/settings`);
      return JSON.stringify(settings, null, 2);
    }
    throw new Error(`Cloudflare plugin: getManifest not supported for type "${typeId}"`);
  }

  async applyManifest(resourceId: string, _accountId: string, manifest: string): Promise<void> {
    const parts = resourceId.split(":");
    const typeId = parts[1];
    const externalId = parts.slice(2).join(":");

    if (typeId === "zone") {
      // Zone settings are applied per-setting via PATCH
      const settings = JSON.parse(manifest) as Array<{ id: string; value: unknown }>;
      if (!Array.isArray(settings))
        throw new Error("Zone settings must be an array of {id, value} objects");
      for (const setting of settings) {
        await this.fetch(`/zones/${externalId}/settings/${setting.id}`, {
          method: "PATCH",
          body: JSON.stringify({ value: setting.value }),
        });
      }
      return;
    }
    throw new Error(`Cloudflare plugin: applyManifest not supported for type "${typeId}"`);
  }

  async listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    const cfAccountId = await this.getAccountId();
    const params = new URLSearchParams({ prefix, delimiter: "/" });
    const res = await this.fetch<Record<string, unknown>>(
      `/accounts/${cfAccountId}/r2/buckets/${bucket}/objects?${params.toString()}`,
    );

    const objects: StorageObject[] = [];

    // Directories (common prefixes)
    const prefixes =
      (res as unknown as { delimited_prefixes?: string[] })?.delimited_prefixes ?? [];
    for (const p of prefixes) {
      const name = p.endsWith("/") ? p.slice(prefix.length, -1) : p.slice(prefix.length);
      objects.push({
        key: p,
        name: name || p,
        size: 0,
        lastModified: "",
        isDirectory: true,
      });
    }

    // Files
    const items = (res as unknown as { objects?: Array<Record<string, unknown>> })?.objects ?? [];
    for (const item of items) {
      const key = String(item["key"] ?? "");
      if (key === prefix) continue; // skip the prefix itself
      const name = key.slice(prefix.length);
      if (!name) continue;
      objects.push({
        key,
        name,
        size: Number(item["size"] ?? 0),
        lastModified: String(item["uploaded"] ?? ""),
        isDirectory: false,
        contentType: String(item["httpMetadata"]?.toString() ?? ""),
      });
    }

    return objects;
  }

  async deleteStorageObject(bucket: string, key: string): Promise<void> {
    const cfAccountId = await this.getAccountId();
    if (key.endsWith("/")) {
      // Delete all objects under this prefix
      const objects = await this.listStorageObjects(bucket, key);
      for (const obj of objects) {
        await this.deleteStorageObject(bucket, obj.key);
      }
    }
    await this.fetch(
      `/accounts/${cfAccountId}/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`,
      {
        method: "DELETE",
      },
    );
  }

  async uploadStorageObject(bucket: string, key: string, file: File): Promise<void> {
    const cfAccountId = await this.getAccountId();
    const arrayBuffer = await file.arrayBuffer();
    const res = await fetch(
      `${this.baseUrl}/accounts/${cfAccountId}/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": file.type || "application/octet-stream",
        },
        body: arrayBuffer,
      },
    );
    if (!res.ok) {
      throw new Error(`R2 upload error ${res.status}: ${await res.text()}`);
    }
  }

  async makeStorageFolder(bucket: string, key: string): Promise<void> {
    const cfAccountId = await this.getAccountId();
    const folderKey = key.endsWith("/") ? key : `${key}/`;
    const res = await fetch(
      `${this.baseUrl}/accounts/${cfAccountId}/r2/buckets/${bucket}/objects/${encodeURIComponent(folderKey)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/x-directory",
          "Content-Length": "0",
        },
        body: null,
      },
    );
    if (!res.ok) {
      throw new Error(`R2 mkdir error ${res.status}: ${await res.text()}`);
    }
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    if (resourceTypeId === "zone") {
      const resource = await this.getResource(resourceTypeId, resourceId, accountId);
      const status = String(resource.fields["status"] ?? "");
      const plan = String(resource.fields["plan"] ?? "");
      const variant: DashboardStat["variant"] =
        status === "active"
          ? "status-healthy"
          : status === "pending"
            ? "status-degraded"
            : "default";
      return [
        { label: "Status", value: status, variant },
        { label: "Plan", value: plan },
      ];
    }

    if (resourceTypeId === "r2-bucket") {
      const bucketName = resourceId.split(":").slice(2).join(":");
      // R2 doesn't have a direct stats API, so list objects and sum
      const objects = await this.listStorageObjects(bucketName, "");
      let totalSize = 0;
      let count = 0;
      for (const obj of objects) {
        if (!obj.isDirectory) {
          count++;
          totalSize += obj.size;
        }
      }
      // Format size
      const units = ["B", "KB", "MB", "GB", "TB"];
      let size = totalSize;
      let unitIdx = 0;
      while (size >= 1024 && unitIdx < units.length - 1) {
        size /= 1024;
        unitIdx++;
      }
      return [
        { label: "Objects", value: String(count) },
        { label: "Size", value: `${size.toFixed(1)} ${units[unitIdx]}` },
      ];
    }

    if (resourceTypeId === "pages-project") {
      const resource = await this.getResource(resourceTypeId, resourceId, accountId);
      const subdomain = String(resource.fields["subdomain"] ?? "");
      if (subdomain) {
        return [{ label: "URL", value: subdomain }];
      }
      return [];
    }

    if (resourceTypeId === "worker") {
      const resource = await this.getResource(resourceTypeId, resourceId, accountId);
      const f = resource.fields;
      const stats: DashboardStat[] = [{ label: "Name", value: String(f["name"] ?? "") }];
      if (f["compatibilityDate"])
        stats.push({ label: "Compat Date", value: String(f["compatibilityDate"]) });
      if (f["routes"]) stats.push({ label: "Routes", value: String(f["routes"]) });
      return stats;
    }

    if (resourceTypeId === "kv-namespace") {
      const resource = await this.getResource(resourceTypeId, resourceId, accountId);
      return [{ label: "Title", value: String(resource.fields["title"] ?? "") }];
    }

    if (resourceTypeId === "d1-database") {
      const resource = await this.getResource(resourceTypeId, resourceId, accountId);
      const f = resource.fields;
      const stats: DashboardStat[] = [{ label: "Name", value: String(f["name"] ?? "") }];
      if (f["version"]) stats.push({ label: "Version", value: String(f["version"]) });
      if (f["numTables"] != null) stats.push({ label: "Tables", value: String(f["numTables"]) });
      if (f["fileSize"]) stats.push({ label: "Size", value: String(f["fileSize"]) });
      return stats;
    }

    if (resourceTypeId === "tunnel") {
      const resource = await this.getResource(resourceTypeId, resourceId, accountId);
      const f = resource.fields;
      const status = String(f["status"] ?? "unknown");
      const variant: DashboardStat["variant"] =
        status === "healthy" || status === "active"
          ? "status-healthy"
          : status === "inactive" || status === "down"
            ? "status-error"
            : "status-degraded";
      return [
        { label: "Status", value: status, variant },
        { label: "Type", value: String(f["tunnelType"] ?? "") },
        ...(f["connectionsCount"] != null
          ? [{ label: "Connections", value: String(f["connectionsCount"]) }]
          : []),
      ];
    }

    if (resourceTypeId === "hyperdrive") {
      const resource = await this.getResource(resourceTypeId, resourceId, accountId);
      const f = resource.fields;
      const stats: DashboardStat[] = [{ label: "Name", value: String(f["name"] ?? "") }];
      if (f["originHost"]) stats.push({ label: "Origin", value: String(f["originHost"]) });
      if (f["database"]) stats.push({ label: "Database", value: String(f["database"]) });
      return stats;
    }

    if (resourceTypeId === "queue") {
      const resource = await this.getResource(resourceTypeId, resourceId, accountId);
      const f = resource.fields;
      return [
        { label: "Name", value: String(f["name"] ?? "") },
        { label: "Producers", value: String(f["producersTotal"] ?? 0) },
        { label: "Consumers", value: String(f["consumersTotal"] ?? 0) },
      ];
    }

    if (resourceTypeId === "access-application") {
      const resource = await this.getResource(resourceTypeId, resourceId, accountId);
      const f = resource.fields;
      const stats: DashboardStat[] = [{ label: "Domain", value: String(f["domain"] ?? "") }];
      if (f["type"]) stats.push({ label: "Type", value: String(f["type"]) });
      if (f["sessionDuration"])
        stats.push({ label: "Session", value: String(f["sessionDuration"]) });
      return stats;
    }

    // Generic fallback for any other resource type
    {
      const resource = await this.getResource(resourceTypeId, resourceId, accountId);
      const f = resource.fields;
      const stats: DashboardStat[] = [];
      const statusVal = f["status"] ?? f["state"];
      if (statusVal != null) {
        const s = String(statusVal).toLowerCase();
        stats.push({
          label: "Status",
          value: String(statusVal),
          variant: ["active", "healthy", "enabled", "ready"].some((v) => s.includes(v))
            ? "status-healthy"
            : ["error", "failed", "deleted", "inactive"].some((v) => s.includes(v))
              ? "status-error"
              : ["pending", "creating", "updating", "degraded"].some((v) => s.includes(v))
                ? "status-degraded"
                : "default",
        });
      }
      const typeVal = f["type"] ?? f["kind"];
      if (typeVal != null) stats.push({ label: "Type", value: String(typeVal) });
      return stats;
    }
  }

  private async getAccessAppOptions(): Promise<Array<{ id: string; label: string }>> {
    const cfAccountId = await this.getAccountId();
    const apps = await this.paginate<Record<string, unknown>>(
      `/accounts/${cfAccountId}/access/apps`,
    );
    return apps.map((a) => ({
      id: String(a["id"]),
      label: String(a["name"] ?? a["domain"] ?? a["id"]),
    }));
  }

  private async getZoneOptions(): Promise<Array<{ id: string; label: string }>> {
    const zones = await this.paginate<Record<string, unknown>>("/zones");
    return zones.map((z) => ({
      id: String(z["id"]),
      label: String(z["name"]),
    }));
  }

  private async listZones(accountId: string): Promise<ResourceInstance[]> {
    const zones = await this.paginate<Record<string, unknown>>("/zones");
    return zones.map((z) => this.mapZone(z, accountId));
  }

  private mapZone(z: Record<string, unknown>, accountId: string): ResourceInstance {
    const nameservers = Array.isArray(z["name_servers"])
      ? (z["name_servers"] as string[]).join(", ")
      : "";
    const plan = z["plan"] as Record<string, unknown> | undefined;
    // Cache account ID from zone data
    const account = z["account"] as Record<string, unknown> | undefined;
    if (account?.["id"] && !this.cfAccountId) {
      this.cfAccountId = String(account["id"]);
    }
    return {
      id: `${accountId}:zone:${String(z["id"])}`,
      pluginId: "cloudflare",
      resourceTypeId: "zone",
      accountId,
      displayName: String(z["name"]),
      fields: {
        name: String(z["name"]),
        status: String(z["status"] ?? ""),
        plan: String(plan?.["name"] ?? "Free"),
        nameservers,
        type: String(z["type"] ?? "full"),
        paused: Boolean(z["paused"]),
      },
      resolvedOutputs: {
        zoneId: String(z["id"]),
        nameservers,
      },
      secretStates: [],
      externalId: String(z["id"]),
      createdAt: String(z["created_on"] ?? new Date().toISOString()),
      updatedAt: String(z["modified_on"] ?? new Date().toISOString()),
    };
  }

  private async listAllDnsRecords(accountId: string): Promise<ResourceInstance[]> {
    const zones = await this.paginate<Record<string, unknown>>("/zones");
    const results: ResourceInstance[] = [];
    for (const zone of zones) {
      const zoneId = String(zone["id"]);
      const records = await this.paginate<Record<string, unknown>>(`/zones/${zoneId}/dns_records`);
      for (const r of records) {
        results.push(this.mapDnsRecord(r, accountId, zoneId));
      }
    }
    return results;
  }

  /** List DNS records for a specific zone */
  async listDnsRecordsForZone(zoneId: string, accountId: string): Promise<ResourceInstance[]> {
    const records = await this.paginate<Record<string, unknown>>(`/zones/${zoneId}/dns_records`);
    return records.map((r) => this.mapDnsRecord(r, accountId, zoneId));
  }

  private mapDnsRecord(
    r: Record<string, unknown>,
    accountId: string,
    zoneId: string,
  ): ResourceInstance {
    const type = String(r["type"] ?? "");
    const name = String(r["name"] ?? "");
    const content = String(r["content"] ?? "");
    return {
      id: `${accountId}:dns-record:${zoneId}/${String(r["id"])}`,
      pluginId: "cloudflare",
      resourceTypeId: "dns-record",
      accountId,
      displayName: `${type} ${name}`,
      fields: {
        type,
        name,
        content,
        ttl: Number(r["ttl"] ?? 1),
        proxied: Boolean(r["proxied"]),
        ...(r["priority"] !== undefined ? { priority: Number(r["priority"]) } : {}),
        zoneName: String(r["zone_name"] ?? ""),
        ...(r["comment"] ? { comment: String(r["comment"]) } : {}),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${zoneId}/${String(r["id"])}`,
      parentResourceId: `${accountId}:zone:${zoneId}`,
      createdAt: String(r["created_on"] ?? new Date().toISOString()),
      updatedAt: String(r["modified_on"] ?? new Date().toISOString()),
    };
  }

  private async listWorkers(accountId: string): Promise<ResourceInstance[]> {
    const cfAccountId = await this.getAccountId();
    const scripts = await this.fetch<Array<Record<string, unknown>>>(
      `/accounts/${cfAccountId}/workers/scripts`,
    );
    return (scripts ?? []).map((s) => ({
      id: `${accountId}:worker:${String(s["id"] ?? s["script_name"] ?? "")}`,
      pluginId: "cloudflare",
      resourceTypeId: "worker",
      accountId,
      displayName: String(s["id"] ?? s["script_name"] ?? ""),
      fields: {
        name: String(s["id"] ?? s["script_name"] ?? ""),
        createdOn: String(s["created_on"] ?? ""),
        modifiedOn: String(s["modified_on"] ?? ""),
        compatibilityDate: String(s["compatibility_date"] ?? ""),
        routes: "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: String(s["id"] ?? s["script_name"] ?? ""),
      createdAt: String(s["created_on"] ?? new Date().toISOString()),
      updatedAt: String(s["modified_on"] ?? new Date().toISOString()),
    }));
  }

  private async listR2Buckets(accountId: string): Promise<ResourceInstance[]> {
    const cfAccountId = await this.getAccountId();
    const response = await this.fetch<{ buckets: Array<Record<string, unknown>> }>(
      `/accounts/${cfAccountId}/r2/buckets`,
    );
    const buckets = response?.buckets ?? (Array.isArray(response) ? response : []);
    return (buckets as Array<Record<string, unknown>>).map((b) =>
      this.mapR2Bucket(b, accountId, cfAccountId),
    );
  }

  private mapR2Bucket(
    b: Record<string, unknown>,
    accountId: string,
    cfAccountId: string,
  ): ResourceInstance {
    const name = String(b["name"] ?? "");
    return {
      id: `${accountId}:r2-bucket:${name}`,
      pluginId: "cloudflare",
      resourceTypeId: "r2-bucket",
      accountId,
      displayName: name,
      fields: {
        name,
        location: String(b["location"] ?? ""),
        createdOn: String(b["creation_date"] ?? b["created"] ?? ""),
      },
      resolvedOutputs: {
        bucketName: name,
        s3Endpoint: `https://${cfAccountId}.r2.cloudflarestorage.com`,
      },
      secretStates: [],
      externalId: name,
      createdAt: String(b["creation_date"] ?? b["created"] ?? new Date().toISOString()),
      updatedAt: new Date().toISOString(),
    };
  }

  private async listPagesProjects(accountId: string): Promise<ResourceInstance[]> {
    const cfAccountId = await this.getAccountId();
    const projects = await this.paginate<Record<string, unknown>>(
      `/accounts/${cfAccountId}/pages/projects`,
    );
    return projects.map((p) => this.mapPagesProject(p, accountId));
  }

  private mapPagesProject(p: Record<string, unknown>, accountId: string): ResourceInstance {
    const name = String(p["name"] ?? "");
    const subdomain = String(p["subdomain"] ?? `${name}.pages.dev`);
    const latestDeploy = p["latest_deployment"] as Record<string, unknown> | undefined;
    const source = p["source"] as Record<string, unknown> | undefined;
    const buildConfig = p["build_config"] as Record<string, unknown> | undefined;
    const customDomains = Array.isArray(p["domains"]) ? (p["domains"] as string[]).join(", ") : "";
    return {
      id: `${accountId}:pages-project:${name}`,
      pluginId: "cloudflare",
      resourceTypeId: "pages-project",
      accountId,
      displayName: name,
      fields: {
        name,
        subdomain,
        productionBranch: String(p["production_branch"] ?? source?.["config"]?.toString() ?? ""),
        latestDeploymentStatus: String(
          latestDeploy?.["latest_stage"]?.toString() ?? latestDeploy?.["environment"] ?? "",
        ),
        latestDeploymentUrl: String(latestDeploy?.["url"] ?? ""),
        framework: String(buildConfig?.["framework"] ?? ""),
        domains: customDomains,
      },
      resolvedOutputs: {
        subdomain,
        projectName: name,
      },
      secretStates: [],
      externalId: name,
      createdAt: String(p["created_on"] ?? new Date().toISOString()),
      updatedAt: String(p["modified_on"] ?? new Date().toISOString()),
    };
  }

  private async listAllPagesDeployments(accountId: string): Promise<ResourceInstance[]> {
    const cfAccountId = await this.getAccountId();
    const projects = await this.paginate<Record<string, unknown>>(
      `/accounts/${cfAccountId}/pages/projects`,
    );
    const results: ResourceInstance[] = [];
    for (const project of projects) {
      const projectName = String(project["name"] ?? "");
      try {
        const deployments = await this.paginate<Record<string, unknown>>(
          `/accounts/${cfAccountId}/pages/projects/${projectName}/deployments`,
        );
        // Only include the latest 5 deployments per project
        for (const d of deployments.slice(0, 5)) {
          results.push(this.mapPagesDeployment(d, accountId, projectName));
        }
      } catch {
        // Skip projects we can't read deployments for
      }
    }
    return results;
  }

  private mapPagesDeployment(
    d: Record<string, unknown>,
    accountId: string,
    projectName: string,
  ): ResourceInstance {
    const id = String(d["id"] ?? "");
    const env = String(d["environment"] ?? "production");
    const latestStage = d["latest_stage"] as Record<string, unknown> | undefined;
    const status = String(latestStage?.["status"] ?? d["status"] ?? "");
    const source = d["source"] as Record<string, unknown> | undefined;
    return {
      id: `${accountId}:pages-deployment:${projectName}/${id}`,
      pluginId: "cloudflare",
      resourceTypeId: "pages-deployment",
      accountId,
      displayName: `${env} · ${String(d["deployment_trigger"]?.toString() ?? "").slice(0, 20) || id.slice(0, 8)}`,
      fields: {
        environment: env,
        url: String(d["url"] ?? ""),
        branch: String(source?.["branch"] ?? d["branch"] ?? ""),
        commitHash: String(source?.["commit_hash"] ?? d["commit_hash"] ?? ""),
        commitMessage: String(source?.["commit_message"] ?? d["commit_message"] ?? ""),
        status,
        createdOn: String(d["created_on"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${projectName}/${id}`,
      parentResourceId: `${accountId}:pages-project:${projectName}`,
      createdAt: String(d["created_on"] ?? new Date().toISOString()),
      updatedAt: String(d["modified_on"] ?? new Date().toISOString()),
    };
  }

  private async listKVNamespaces(accountId: string): Promise<ResourceInstance[]> {
    const cfAccountId = await this.getAccountId();
    const namespaces = await this.paginate<Record<string, unknown>>(
      `/accounts/${cfAccountId}/storage/kv/namespaces`,
    );
    return namespaces.map((ns) => this.mapKVNamespace(ns, accountId));
  }

  private mapKVNamespace(ns: Record<string, unknown>, accountId: string): ResourceInstance {
    const id = String(ns["id"] ?? "");
    const title = String(ns["title"] ?? "");
    return {
      id: `${accountId}:kv-namespace:${id}`,
      pluginId: "cloudflare",
      resourceTypeId: "kv-namespace",
      accountId,
      displayName: title || id,
      fields: {
        title,
        supportsUrlEncoding: Boolean(ns["supports_url_encoding"]),
      },
      resolvedOutputs: { namespaceId: id },
      secretStates: [],
      externalId: id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  private async listD1Databases(accountId: string): Promise<ResourceInstance[]> {
    const cfAccountId = await this.getAccountId();
    const dbs = await this.paginate<Record<string, unknown>>(
      `/accounts/${cfAccountId}/d1/database`,
    );
    return dbs.map((db) => this.mapD1Database(db, accountId));
  }

  private mapD1Database(db: Record<string, unknown>, accountId: string): ResourceInstance {
    const uuid = String(db["uuid"] ?? db["id"] ?? "");
    const name = String(db["name"] ?? "");
    return {
      id: `${accountId}:d1-database:${uuid}`,
      pluginId: "cloudflare",
      resourceTypeId: "d1-database",
      accountId,
      displayName: name || uuid,
      fields: {
        name,
        version: String(db["version"] ?? ""),
        numTables: Number(db["num_tables"] ?? 0),
        fileSize: String(db["file_size"] ?? ""),
        createdAt: String(db["created_at"] ?? ""),
      },
      resolvedOutputs: { databaseId: uuid },
      secretStates: [],
      externalId: uuid,
      createdAt: String(db["created_at"] ?? new Date().toISOString()),
      updatedAt: new Date().toISOString(),
    };
  }

  private async listQueues(accountId: string): Promise<ResourceInstance[]> {
    const cfAccountId = await this.getAccountId();
    const queues = await this.paginate<Record<string, unknown>>(`/accounts/${cfAccountId}/queues`);
    return queues.map((q) => this.mapQueue(q, accountId));
  }

  private mapQueue(q: Record<string, unknown>, accountId: string): ResourceInstance {
    const id = String(q["queue_id"] ?? q["id"] ?? "");
    const name = String(q["queue_name"] ?? q["name"] ?? "");
    const producers = q["producers"] as Array<unknown> | undefined;
    const consumers = q["consumers"] as Array<unknown> | undefined;
    return {
      id: `${accountId}:queue:${id}`,
      pluginId: "cloudflare",
      resourceTypeId: "queue",
      accountId,
      displayName: name || id,
      fields: {
        name,
        producersTotal: producers?.length ?? 0,
        consumersTotal: consumers?.length ?? 0,
        createdOn: String(q["created_on"] ?? ""),
        modifiedOn: String(q["modified_on"] ?? ""),
      },
      resolvedOutputs: { queueId: id, queueName: name },
      secretStates: [],
      externalId: id,
      createdAt: String(q["created_on"] ?? new Date().toISOString()),
      updatedAt: String(q["modified_on"] ?? new Date().toISOString()),
    };
  }

  private async listTunnels(accountId: string): Promise<ResourceInstance[]> {
    const cfAccountId = await this.getAccountId();
    const tunnels = await this.paginate<Record<string, unknown>>(
      `/accounts/${cfAccountId}/cfd_tunnel`,
    );
    return tunnels
      .filter((t) => !t["deleted_at"]) // exclude soft-deleted tunnels
      .map((t) => this.mapTunnel(t, accountId));
  }

  private mapTunnel(t: Record<string, unknown>, accountId: string): ResourceInstance {
    const id = String(t["id"] ?? "");
    const name = String(t["name"] ?? "");
    const connections = Array.isArray(t["connections"]) ? (t["connections"] as Array<unknown>) : [];
    const status = String(t["status"] ?? (connections.length > 0 ? "active" : "inactive"));
    return {
      id: `${accountId}:tunnel:${id}`,
      pluginId: "cloudflare",
      resourceTypeId: "tunnel",
      accountId,
      displayName: name || id,
      fields: {
        name,
        status,
        tunnelType: String(t["tun_type"] ?? ""),
        remoteConfig: Boolean(t["remote_config"]),
        connectionsCount: connections.length,
        createdAt: String(t["created_at"] ?? ""),
      },
      resolvedOutputs: { tunnelId: id },
      secretStates: [],
      externalId: id,
      createdAt: String(t["created_at"] ?? new Date().toISOString()),
      updatedAt: new Date().toISOString(),
    };
  }

  private async listAllSSLCertificates(accountId: string): Promise<ResourceInstance[]> {
    const zones = await this.paginate<Record<string, unknown>>("/zones");
    const results: ResourceInstance[] = [];
    for (const zone of zones) {
      const zoneId = String(zone["id"]);
      const zoneName = String(zone["name"]);
      try {
        const certs = await this.paginate<Record<string, unknown>>(
          `/zones/${zoneId}/custom_certificates`,
        );
        for (const cert of certs) {
          results.push(this.mapSSLCertificate(cert, accountId, zoneId, zoneName));
        }
      } catch {
        // Skip zones where we can't read certificates
      }
    }
    return results;
  }

  private mapSSLCertificate(
    cert: Record<string, unknown>,
    accountId: string,
    zoneId: string,
    zoneName: string,
  ): ResourceInstance {
    const id = String(cert["id"] ?? "");
    const hosts = Array.isArray(cert["hosts"])
      ? (cert["hosts"] as string[]).join(", ")
      : String(cert["hosts"] ?? "");
    const status = String(cert["status"] ?? "");
    const certificates = cert["certificates"] as Array<Record<string, unknown>> | undefined;
    const firstCert = certificates?.[0];
    return {
      id: `${accountId}:ssl-certificate:${zoneId}/${id}`,
      pluginId: "cloudflare",
      resourceTypeId: "ssl-certificate",
      accountId,
      displayName: hosts || `Certificate ${id.slice(0, 8)}`,
      fields: {
        hosts,
        issuer: String(firstCert?.["issuer"] ?? cert["certificate_authority"] ?? ""),
        status,
        type: String(cert["type"] ?? ""),
        expiresOn: String(firstCert?.["expires_on"] ?? ""),
        zoneName,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${zoneId}/${id}`,
      parentResourceId: `${accountId}:zone:${zoneId}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  private async listAllPageRules(accountId: string): Promise<ResourceInstance[]> {
    const zones = await this.paginate<Record<string, unknown>>("/zones");
    const results: ResourceInstance[] = [];
    for (const zone of zones) {
      const zoneId = String(zone["id"]);
      try {
        const rules = await this.paginate<Record<string, unknown>>(`/zones/${zoneId}/pagerules`);
        for (const rule of rules) {
          results.push(this.mapPageRule(rule, accountId, zoneId));
        }
      } catch {
        // Skip zones where we can't read page rules
      }
    }
    return results;
  }

  private mapPageRule(
    rule: Record<string, unknown>,
    accountId: string,
    zoneId: string,
  ): ResourceInstance {
    const id = String(rule["id"] ?? "");
    const targets = Array.isArray(rule["targets"])
      ? (rule["targets"] as Array<Record<string, unknown>>)
          .map((t) => {
            const constraint = t["constraint"] as Record<string, unknown> | undefined;
            return String(constraint?.["value"] ?? "");
          })
          .join(", ")
      : "";
    const actions = Array.isArray(rule["actions"])
      ? (rule["actions"] as Array<Record<string, unknown>>)
          .map((a) => String(a["id"] ?? ""))
          .join(", ")
      : "";
    return {
      id: `${accountId}:page-rule:${zoneId}/${id}`,
      pluginId: "cloudflare",
      resourceTypeId: "page-rule",
      accountId,
      displayName: targets || `Rule ${id.slice(0, 8)}`,
      fields: {
        targets,
        actions,
        status: String(rule["status"] ?? ""),
        priority: Number(rule["priority"] ?? 0),
        createdOn: String(rule["created_on"] ?? ""),
        modifiedOn: String(rule["modified_on"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${zoneId}/${id}`,
      parentResourceId: `${accountId}:zone:${zoneId}`,
      createdAt: String(rule["created_on"] ?? new Date().toISOString()),
      updatedAt: String(rule["modified_on"] ?? new Date().toISOString()),
    };
  }

  private async listAllFirewallRules(accountId: string): Promise<ResourceInstance[]> {
    const zones = await this.paginate<Record<string, unknown>>("/zones");
    const results: ResourceInstance[] = [];
    for (const zone of zones) {
      const zoneId = String(zone["id"]);
      try {
        // Use the WAF custom rules endpoint (rulesets)
        const rulesets = await this.fetch<{ rulesets?: Array<Record<string, unknown>> }>(
          `/zones/${zoneId}/rulesets`,
        );
        const customRuleset = ((rulesets as unknown as Array<Record<string, unknown>>) ?? []).find(
          (rs: Record<string, unknown>) => rs["phase"] === "http_request_firewall_custom",
        );
        if (customRuleset) {
          const rsId = String(customRuleset["id"]);
          const fullRuleset = await this.fetch<Record<string, unknown>>(
            `/zones/${zoneId}/rulesets/${rsId}`,
          );
          const rules = (fullRuleset["rules"] as Array<Record<string, unknown>>) ?? [];
          for (const rule of rules) {
            results.push(this.mapFirewallRule(rule, accountId, zoneId, rsId));
          }
        }
      } catch {
        // Skip zones where we can't read firewall rules
      }
    }
    return results;
  }

  private mapFirewallRule(
    rule: Record<string, unknown>,
    accountId: string,
    zoneId: string,
    rulesetId?: string,
  ): ResourceInstance {
    const id = String(rule["id"] ?? "");
    const description = String(rule["description"] ?? "");
    const externalIdSuffix = rulesetId ? `${zoneId}/${rulesetId}/${id}` : `${zoneId}/${id}`;
    return {
      id: `${accountId}:firewall-rule:${externalIdSuffix}`,
      pluginId: "cloudflare",
      resourceTypeId: "firewall-rule",
      accountId,
      displayName: description || `Rule ${id.slice(0, 8)}`,
      fields: {
        description,
        expression: String(rule["expression"] ?? ""),
        action: String(rule["action"] ?? ""),
        enabled: Boolean(rule["enabled"] ?? true),
        ...(rule["priority"] !== undefined ? { priority: Number(rule["priority"]) } : {}),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: externalIdSuffix,
      parentResourceId: `${accountId}:zone:${zoneId}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  private async listAccessApplications(accountId: string): Promise<ResourceInstance[]> {
    const cfAccountId = await this.getAccountId();
    const apps = await this.paginate<Record<string, unknown>>(
      `/accounts/${cfAccountId}/access/apps`,
    );
    return apps.map((app) => this.mapAccessApplication(app, accountId));
  }

  private mapAccessApplication(app: Record<string, unknown>, accountId: string): ResourceInstance {
    const id = String(app["id"] ?? "");
    const name = String(app["name"] ?? "");
    const domain = String(app["domain"] ?? "");
    return {
      id: `${accountId}:access-application:${id}`,
      pluginId: "cloudflare",
      resourceTypeId: "access-application",
      accountId,
      displayName: name || domain || id,
      fields: {
        name,
        domain,
        type: String(app["type"] ?? ""),
        sessionDuration: String(app["session_duration"] ?? ""),
        createdAt: String(app["created_at"] ?? ""),
        updatedAt: String(app["updated_at"] ?? ""),
      },
      resolvedOutputs: {
        aud: String(app["aud"] ?? ""),
      },
      secretStates: [],
      externalId: id,
      createdAt: String(app["created_at"] ?? new Date().toISOString()),
      updatedAt: String(app["updated_at"] ?? new Date().toISOString()),
    };
  }

  private async listAllLoadBalancers(accountId: string): Promise<ResourceInstance[]> {
    const zones = await this.paginate<Record<string, unknown>>("/zones");
    const results: ResourceInstance[] = [];
    for (const zone of zones) {
      const zoneId = String(zone["id"]);
      try {
        const lbs = await this.paginate<Record<string, unknown>>(`/zones/${zoneId}/load_balancers`);
        for (const lb of lbs) {
          results.push(this.mapLoadBalancer(lb, accountId, zoneId));
        }
      } catch {
        // Skip zones where we can't read load balancers
      }
    }
    return results;
  }

  private mapLoadBalancer(
    lb: Record<string, unknown>,
    accountId: string,
    zoneId: string,
  ): ResourceInstance {
    const id = String(lb["id"] ?? "");
    const name = String(lb["name"] ?? "");
    const defaultPools = Array.isArray(lb["default_pools"])
      ? (lb["default_pools"] as string[]).join(", ")
      : "";
    return {
      id: `${accountId}:load-balancer:${zoneId}/${id}`,
      pluginId: "cloudflare",
      resourceTypeId: "load-balancer",
      accountId,
      displayName: name || id,
      fields: {
        name,
        fallbackPool: String(lb["fallback_pool"] ?? ""),
        defaultPools,
        enabled: Boolean(lb["enabled"] ?? true),
        proxied: Boolean(lb["proxied"]),
        ttl: Number(lb["ttl"] ?? 0),
        steeringPolicy: String(lb["steering_policy"] ?? ""),
        createdOn: String(lb["created_on"] ?? ""),
        modifiedOn: String(lb["modified_on"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${zoneId}/${id}`,
      parentResourceId: `${accountId}:zone:${zoneId}`,
      createdAt: String(lb["created_on"] ?? new Date().toISOString()),
      updatedAt: String(lb["modified_on"] ?? new Date().toISOString()),
    };
  }

  private async listAllWorkerRoutes(accountId: string): Promise<ResourceInstance[]> {
    const zones = await this.paginate<Record<string, unknown>>("/zones");
    const results: ResourceInstance[] = [];
    for (const zone of zones) {
      const zoneId = String(zone["id"]);
      try {
        const routes = await this.fetch<Array<Record<string, unknown>>>(
          `/zones/${zoneId}/workers/routes`,
        );
        for (const route of routes ?? []) {
          results.push(this.mapWorkerRoute(route, accountId, zoneId));
        }
      } catch {
        // Skip zones where we can't read worker routes
      }
    }
    return results;
  }

  private mapWorkerRoute(
    route: Record<string, unknown>,
    accountId: string,
    zoneId: string,
  ): ResourceInstance {
    const id = String(route["id"] ?? "");
    const pattern = String(route["pattern"] ?? "");
    const script = String(route["script"] ?? route["script_name"] ?? "");
    return {
      id: `${accountId}:worker-route:${zoneId}/${id}`,
      pluginId: "cloudflare",
      resourceTypeId: "worker-route",
      accountId,
      displayName: pattern || `Route ${id.slice(0, 8)}`,
      fields: {
        pattern,
        script,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${zoneId}/${id}`,
      parentResourceId: `${accountId}:zone:${zoneId}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  private async listAllCustomHostnames(accountId: string): Promise<ResourceInstance[]> {
    const zones = await this.paginate<Record<string, unknown>>("/zones");
    const results: ResourceInstance[] = [];
    for (const zone of zones) {
      const zoneId = String(zone["id"]);
      try {
        const hostnames = await this.paginate<Record<string, unknown>>(
          `/zones/${zoneId}/custom_hostnames`,
        );
        for (const h of hostnames) {
          results.push(this.mapCustomHostname(h, accountId, zoneId));
        }
      } catch {
        // Skip zones where we can't read custom hostnames
      }
    }
    return results;
  }

  private mapCustomHostname(
    h: Record<string, unknown>,
    accountId: string,
    zoneId: string,
  ): ResourceInstance {
    const id = String(h["id"] ?? "");
    const hostname = String(h["hostname"] ?? "");
    const ssl = h["ssl"] as Record<string, unknown> | undefined;
    return {
      id: `${accountId}:custom-hostname:${zoneId}/${id}`,
      pluginId: "cloudflare",
      resourceTypeId: "custom-hostname",
      accountId,
      displayName: hostname || id,
      fields: {
        hostname,
        status: String(h["status"] ?? ""),
        sslStatus: String(ssl?.["status"] ?? ""),
        sslMethod: String(ssl?.["method"] ?? ""),
        sslType: String(ssl?.["type"] ?? ""),
        createdAt: String(h["created_at"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${zoneId}/${id}`,
      parentResourceId: `${accountId}:zone:${zoneId}`,
      createdAt: String(h["created_at"] ?? new Date().toISOString()),
      updatedAt: new Date().toISOString(),
    };
  }

  private async listHyperdrives(accountId: string): Promise<ResourceInstance[]> {
    const cfAccountId = await this.getAccountId();
    const configs = await this.paginate<Record<string, unknown>>(
      `/accounts/${cfAccountId}/hyperdrive/configs`,
    );
    return configs.map((c) => this.mapHyperdrive(c, accountId));
  }

  private mapHyperdrive(c: Record<string, unknown>, accountId: string): ResourceInstance {
    const id = String(c["id"] ?? "");
    const name = String(c["name"] ?? "");
    const origin = c["origin"] as Record<string, unknown> | undefined;
    const caching = c["caching"] as Record<string, unknown> | undefined;
    return {
      id: `${accountId}:hyperdrive:${id}`,
      pluginId: "cloudflare",
      resourceTypeId: "hyperdrive",
      accountId,
      displayName: name || id,
      fields: {
        name,
        originHost: String(origin?.["host"] ?? ""),
        originPort: Number(origin?.["port"] ?? 0),
        originScheme: String(origin?.["scheme"] ?? ""),
        database: String(origin?.["database"] ?? ""),
        user: String(origin?.["user"] ?? ""),
        cachingDisabled: Boolean(caching?.["disabled"]),
      },
      resolvedOutputs: { hyperdriveId: id },
      secretStates: [],
      externalId: id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  private async listAllEmailRoutingRules(accountId: string): Promise<ResourceInstance[]> {
    const zones = await this.paginate<Record<string, unknown>>("/zones");
    const results: ResourceInstance[] = [];
    for (const zone of zones) {
      const zoneId = String(zone["id"]);
      try {
        const rules = await this.paginate<Record<string, unknown>>(
          `/zones/${zoneId}/email/routing/rules`,
        );
        for (const rule of rules) {
          results.push(this.mapEmailRoutingRule(rule, accountId, zoneId));
        }
      } catch {
        // Skip zones where email routing is not enabled
      }
    }
    return results;
  }

  private mapEmailRoutingRule(
    rule: Record<string, unknown>,
    accountId: string,
    zoneId: string,
  ): ResourceInstance {
    const tag = String(rule["tag"] ?? rule["id"] ?? "");
    const name = String(rule["name"] ?? "");
    const matchers = Array.isArray(rule["matchers"])
      ? (rule["matchers"] as Array<Record<string, unknown>>)
          .map(
            (m) =>
              `${String(m["type"] ?? "")}:${String(m["field"] ?? "")}=${String(m["value"] ?? "")}`,
          )
          .join(", ")
      : "";
    const actions = Array.isArray(rule["actions"])
      ? (rule["actions"] as Array<Record<string, unknown>>)
          .map((a) => {
            const vals = Array.isArray(a["value"])
              ? (a["value"] as string[]).join(", ")
              : String(a["value"] ?? "");
            return `${String(a["type"] ?? "")}: ${vals}`;
          })
          .join("; ")
      : "";
    return {
      id: `${accountId}:email-routing-rule:${zoneId}/${tag}`,
      pluginId: "cloudflare",
      resourceTypeId: "email-routing-rule",
      accountId,
      displayName: name || `Rule ${tag.slice(0, 8)}`,
      fields: {
        name,
        enabled: Boolean(rule["enabled"] ?? true),
        matchers,
        actions,
        priority: Number(rule["priority"] ?? 0),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${zoneId}/${tag}`,
      parentResourceId: `${accountId}:zone:${zoneId}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  private async listAllWaitingRooms(accountId: string): Promise<ResourceInstance[]> {
    const zones = await this.paginate<Record<string, unknown>>("/zones");
    const results: ResourceInstance[] = [];
    for (const zone of zones) {
      const zoneId = String(zone["id"]);
      try {
        const rooms = await this.fetch<Array<Record<string, unknown>>>(
          `/zones/${zoneId}/waiting_rooms`,
        );
        for (const room of rooms ?? []) {
          results.push(this.mapWaitingRoom(room, accountId, zoneId));
        }
      } catch {
        // Skip zones where waiting rooms aren't enabled
      }
    }
    return results;
  }

  private mapWaitingRoom(
    room: Record<string, unknown>,
    accountId: string,
    zoneId: string,
  ): ResourceInstance {
    const id = String(room["id"] ?? "");
    const name = String(room["name"] ?? "");
    return {
      id: `${accountId}:waiting-room:${zoneId}/${id}`,
      pluginId: "cloudflare",
      resourceTypeId: "waiting-room",
      accountId,
      displayName: name || id,
      fields: {
        name,
        host: String(room["host"] ?? ""),
        path: String(room["path"] ?? ""),
        totalActiveUsers: Number(room["total_active_users"] ?? 0),
        newUsersPerMinute: Number(room["new_users_per_minute"] ?? 0),
        queueingMethod: String(room["queueing_method"] ?? ""),
        sessionDuration: Number(room["session_duration"] ?? 0),
        suspended: Boolean(room["suspended"]),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${zoneId}/${id}`,
      parentResourceId: `${accountId}:zone:${zoneId}`,
      createdAt: String(room["created_on"] ?? new Date().toISOString()),
      updatedAt: String(room["modified_on"] ?? new Date().toISOString()),
    };
  }

  private async listAllAccessPolicies(accountId: string): Promise<ResourceInstance[]> {
    const cfAccountId = await this.getAccountId();
    const apps = await this.paginate<Record<string, unknown>>(
      `/accounts/${cfAccountId}/access/apps`,
    );
    const results: ResourceInstance[] = [];
    for (const app of apps) {
      const appId = String(app["id"] ?? "");
      try {
        const policies = await this.paginate<Record<string, unknown>>(
          `/accounts/${cfAccountId}/access/apps/${appId}/policies`,
        );
        for (const policy of policies) {
          results.push(this.mapAccessPolicy(policy, accountId, appId));
        }
      } catch {
        // Skip apps where we can't read policies
      }
    }
    return results;
  }

  private mapAccessPolicy(
    policy: Record<string, unknown>,
    accountId: string,
    appId: string,
  ): ResourceInstance {
    const id = String(policy["id"] ?? "");
    const name = String(policy["name"] ?? "");
    const decision = String(policy["decision"] ?? "");
    const formatRules = (rules: unknown): string => {
      if (!Array.isArray(rules)) return "";
      return (rules as Array<Record<string, unknown>>)
        .map((r) => {
          const entries = Object.entries(r).map(([k, v]) => {
            if (typeof v === "object" && v !== null) {
              const inner = v as Record<string, unknown>;
              return `${k}:${Object.values(inner).join(",")}`;
            }
            return `${k}:${String(v)}`;
          });
          return entries.join("+");
        })
        .join("; ");
    };
    return {
      id: `${accountId}:access-policy:${appId}/${id}`,
      pluginId: "cloudflare",
      resourceTypeId: "access-policy",
      accountId,
      displayName: name || `Policy ${id.slice(0, 8)}`,
      fields: {
        name,
        decision,
        precedence: Number(policy["precedence"] ?? 0),
        includeRules: formatRules(policy["include"]),
        excludeRules: formatRules(policy["exclude"]),
        requireRules: formatRules(policy["require"]),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${appId}/${id}`,
      parentResourceId: `${accountId}:access-application:${appId}`,
      createdAt: String(policy["created_at"] ?? new Date().toISOString()),
      updatedAt: String(policy["updated_at"] ?? new Date().toISOString()),
    };
  }

  private async listAllSpectrumApplications(accountId: string): Promise<ResourceInstance[]> {
    const zones = await this.paginate<Record<string, unknown>>("/zones");
    const results: ResourceInstance[] = [];
    for (const zone of zones) {
      const zoneId = String(zone["id"]);
      try {
        const apps = await this.paginate<Record<string, unknown>>(`/zones/${zoneId}/spectrum/apps`);
        for (const app of apps) {
          results.push(this.mapSpectrumApplication(app, accountId, zoneId));
        }
      } catch {
        // Skip zones where Spectrum is not enabled
      }
    }
    return results;
  }

  private mapSpectrumApplication(
    app: Record<string, unknown>,
    accountId: string,
    zoneId: string,
  ): ResourceInstance {
    const id = String(app["id"] ?? "");
    const protocol = String(app["protocol"] ?? "");
    const dns = app["dns"] as Record<string, unknown> | undefined;
    const dnsName = String(dns?.["name"] ?? "");
    const originDirect = Array.isArray(app["origin_direct"])
      ? (app["origin_direct"] as string[]).join(", ")
      : "";
    const originDns = app["origin_dns"] as Record<string, unknown> | undefined;
    return {
      id: `${accountId}:spectrum-application:${zoneId}/${id}`,
      pluginId: "cloudflare",
      resourceTypeId: "spectrum-application",
      accountId,
      displayName: dnsName || `${protocol} ${id.slice(0, 8)}`,
      fields: {
        protocol,
        dns: dnsName,
        originDirect,
        originDns: String(originDns?.["name"] ?? ""),
        originPort: String(app["origin_port"] ?? ""),
        ipFirewall: Boolean(app["ip_firewall"]),
        proxyProtocol: String(app["proxy_protocol"] ?? "off"),
        tls: String(app["tls"] ?? ""),
        createdOn: String(app["created_on"] ?? ""),
        modifiedOn: String(app["modified_on"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${zoneId}/${id}`,
      parentResourceId: `${accountId}:zone:${zoneId}`,
      createdAt: String(app["created_on"] ?? new Date().toISOString()),
      updatedAt: String(app["modified_on"] ?? new Date().toISOString()),
    };
  }

  private async listAllLogpushJobs(accountId: string): Promise<ResourceInstance[]> {
    const zones = await this.paginate<Record<string, unknown>>("/zones");
    const results: ResourceInstance[] = [];
    for (const zone of zones) {
      const zoneId = String(zone["id"]);
      try {
        const jobs = await this.fetch<Array<Record<string, unknown>>>(
          `/zones/${zoneId}/logpush/jobs`,
        );
        for (const job of jobs ?? []) {
          results.push(this.mapLogpushJob(job, accountId, zoneId));
        }
      } catch {
        // Skip zones where logpush is not available
      }
    }
    return results;
  }

  private mapLogpushJob(
    job: Record<string, unknown>,
    accountId: string,
    zoneId: string,
  ): ResourceInstance {
    const id = String(job["id"] ?? "");
    const name = String(job["name"] ?? "");
    const dataset = String(job["dataset"] ?? "");
    const destinationConf = String(job["destination_conf"] ?? "");
    // Extract destination type from the destination_conf URL scheme
    const destType = destinationConf.split("://")[0] ?? "";
    return {
      id: `${accountId}:logpush-job:${zoneId}/${id}`,
      pluginId: "cloudflare",
      resourceTypeId: "logpush-job",
      accountId,
      displayName: name || `${dataset} → ${destType}`,
      fields: {
        name,
        enabled: Boolean(job["enabled"]),
        dataset,
        destinationType: destType,
        frequency: String(job["frequency"] ?? ""),
        logpullOptions: String(job["logpull_options"] ?? ""),
        lastComplete: String(job["last_complete"] ?? ""),
        lastError: String(job["last_error"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${zoneId}/${id}`,
      parentResourceId: `${accountId}:zone:${zoneId}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
}
