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
  MetricSeries,
  ChatMessage,
  ChatStreamEvent,
  KvListResult,
  PublishMessagePayload,
  PublishMessageResult,
} from "@infrawrench/plugin-base";
import {
  dnsContentField,
  dnsRecordBadgeColor,
  dnsZoneStatus,
  renderDnsRecordDetail,
  renderDnsRecordSidebar,
} from "@infrawrench/plugin-base";
import {
  tunnelStatus,
  sslStatus,
  renderZoneDetail,
  renderWorkerDetail,
  renderR2BucketDetail,
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
  renderWorkersAiModelDetail,
  renderRateLimitRuleDetail,
  renderRedirectRuleDetail,
  renderCacheRuleDetail,
  renderIpAccessRuleDetail,
  renderDurableObjectNamespaceDetail,
  renderTurnstileWidgetDetail,
  renderAiGatewayDetail,
} from "./detail-renderers.js";
import { CloudflareApi, withCloudflareErrors } from "./clients/shared.js";
import * as zoneApi from "./clients/zone-client.js";
import * as dnsRecordApi from "./clients/dns-record-client.js";
import * as workerApi from "./clients/worker-client.js";
import * as r2Api from "./clients/r2-client.js";
import * as kvApi from "./clients/kv-client.js";
import * as d1Api from "./clients/d1-client.js";
import * as queueApi from "./clients/queue-client.js";
import * as tunnelApi from "./clients/tunnel-client.js";
import * as sslApi from "./clients/ssl-certificate-client.js";
import * as pageRuleApi from "./clients/page-rule-client.js";
import * as firewallApi from "./clients/firewall-rule-client.js";
import * as accessAppApi from "./clients/access-application-client.js";
import * as accessPolicyApi from "./clients/access-policy-client.js";
import * as loadBalancerApi from "./clients/load-balancer-client.js";
import * as workerRouteApi from "./clients/worker-route-client.js";
import * as customHostnameApi from "./clients/custom-hostname-client.js";
import * as hyperdriveApi from "./clients/hyperdrive-client.js";
import * as emailRoutingApi from "./clients/email-routing-client.js";
import * as waitingRoomApi from "./clients/waiting-room-client.js";
import * as spectrumApi from "./clients/spectrum-client.js";
import * as logpushApi from "./clients/logpush-client.js";
import * as workersAiApi from "./clients/workers-ai-client.js";
import {
  listAllPhaseRules,
  createPhaseRule,
  editPhaseRule,
  deletePhaseRule,
  RATE_LIMIT_SPEC,
  REDIRECT_SPEC,
  CACHE_SPEC,
  type RulePhaseSpec,
} from "./clients/rules-engine-client.js";
import * as ipAccessApi from "./clients/ip-access-rule-client.js";
import * as turnstileApi from "./clients/turnstile-client.js";
import * as healthcheckApi from "./clients/healthcheck-client.js";
import * as notificationApi from "./clients/notification-policy-client.js";
import * as vectorizeApi from "./clients/vectorize-client.js";
import * as durableObjectApi from "./clients/durable-object-namespace-client.js";
import * as aiGatewayApi from "./clients/ai-gateway-client.js";
import * as aiSearchApi from "./clients/ai-search-client.js";

/** Map each rules-engine resource type id to its phase spec. */
const RULE_SPECS: Record<string, RulePhaseSpec> = {
  "rate-limit-rule": RATE_LIMIT_SPEC,
  "redirect-rule": REDIRECT_SPEC,
  "cache-rule": CACHE_SPEC,
};

export class CloudflareClient implements PluginClient {
  private readonly api: CloudflareApi;
  private readonly resourceTypes: ResourceTypeDefinition[];

  constructor(credentials: Record<string, string>, resourceTypes: ResourceTypeDefinition[] = []) {
    const token = credentials["apiToken"];
    if (!token) throw new Error("Cloudflare plugin: missing apiToken credential");
    this.api = new CloudflareApi(token);
    this.resourceTypes = resourceTypes;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    return withCloudflareErrors(() => this.listResourcesImpl(typeId, accountId));
  }

  private async listResourcesImpl(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "zone":
        return zoneApi.listZones(this.api, accountId);
      case "dns-record":
        return dnsRecordApi.listAllDnsRecords(this.api, accountId);
      case "worker":
        return workerApi.listWorkers(this.api, accountId);
      case "r2-bucket":
        return r2Api.listR2Buckets(this.api, accountId);
      case "kv-namespace":
        return kvApi.listKVNamespaces(this.api, accountId);
      case "d1-database":
        return d1Api.listD1Databases(this.api, accountId);
      case "queue":
        return queueApi.listQueues(this.api, accountId);
      case "tunnel":
        return tunnelApi.listTunnels(this.api, accountId);
      case "ssl-certificate":
        return sslApi.listAllSSLCertificates(this.api, accountId);
      case "page-rule":
        return pageRuleApi.listAllPageRules(this.api, accountId);
      case "firewall-rule":
        return firewallApi.listAllFirewallRules(this.api, accountId);
      case "access-application":
        return accessAppApi.listAccessApplications(this.api, accountId);
      case "load-balancer":
        return loadBalancerApi.listAllLoadBalancers(this.api, accountId);
      case "worker-route":
        return workerRouteApi.listAllWorkerRoutes(this.api, accountId);
      case "custom-hostname":
        return customHostnameApi.listAllCustomHostnames(this.api, accountId);
      case "hyperdrive":
        return hyperdriveApi.listHyperdrives(this.api, accountId);
      case "email-routing-rule":
        return emailRoutingApi.listAllEmailRoutingRules(this.api, accountId);
      case "waiting-room":
        return waitingRoomApi.listAllWaitingRooms(this.api, accountId);
      case "access-policy":
        return accessPolicyApi.listAllAccessPolicies(this.api, accountId);
      case "spectrum-application":
        return spectrumApi.listAllSpectrumApplications(this.api, accountId);
      case "logpush-job":
        return logpushApi.listAllLogpushJobs(this.api, accountId);
      case "workers-ai-model":
        return workersAiApi.listWorkersAiModels(this.api, accountId);
      case "rate-limit-rule":
      case "redirect-rule":
      case "cache-rule":
        return listAllPhaseRules(this.api, accountId, RULE_SPECS[typeId]!);
      case "ip-access-rule":
        return ipAccessApi.listAllIpAccessRules(this.api, accountId);
      case "turnstile-widget":
        return turnstileApi.listTurnstileWidgets(this.api, accountId);
      case "healthcheck":
        return healthcheckApi.listAllHealthchecks(this.api, accountId);
      case "notification-policy":
        return notificationApi.listNotificationPolicies(this.api, accountId);
      case "vectorize-index":
        return vectorizeApi.listVectorizeIndexes(this.api, accountId);
      case "ai-gateway":
        return aiGatewayApi.listAiGateways(this.api, accountId);
      case "ai-search":
        return aiSearchApi.listAiSearchInstances(this.api, accountId);
      case "durable-object-namespace":
        return durableObjectApi.listDurableObjectNamespaces(this.api, accountId);
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
      return zoneApi.getZone(this.api, externalId, accountId);
    }
    if (typeId === "dns-record") {
      return dnsRecordApi.getDnsRecord(this.api, externalId, accountId);
    }
    if (typeId === "r2-bucket") {
      return r2Api.getR2Bucket(this.api, externalId, accountId);
    }
    if (typeId === "d1-database") {
      return d1Api.getD1Database(this.api, externalId, accountId);
    }
    if (typeId === "queue") {
      // Fetch the full queue payload (producers/consumers/settings) and
      // pre-bake the consumer list into resolvedOutputs so the detail
      // renderer can populate the Consumers tab without an async hop.
      const queue = await queueApi.getQueue(this.api, accountId, externalId);
      let consumers: queueApi.QueueConsumer[] = [];
      try {
        consumers = await queueApi.listConsumers(this.api, externalId);
      } catch {
        // Treat as empty — consumer-list failures shouldn't block the page.
      }
      queue.resolvedOutputs = {
        ...queue.resolvedOutputs,
        __consumers__: JSON.stringify(consumers),
      };
      return queue;
    }

    if (typeId === "ai-gateway") {
      return aiGatewayApi.getAiGateway(this.api, externalId, accountId);
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
    if (typeId === "worker") {
      if (outputKey === "workerName")
        return resource.externalId ?? String(resource.fields["name"] ?? "");
    }
    if (typeId === "r2-bucket") {
      if (outputKey === "bucketName") return String(resource.fields["name"] ?? "");
      if (outputKey === "s3Endpoint") {
        const cfAccountId = await this.api.getAccountId();
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
        return await tunnelApi.getTunnelToken(this.api, String(resource.externalId ?? ""));
      }
    }
    if (typeId === "access-application") {
      if (outputKey === "aud") return String(resource.resolvedOutputs["aud"] ?? "");
    }
    if (typeId === "hyperdrive") {
      if (outputKey === "hyperdriveId") return resource.externalId ?? "";
    }
    if (typeId === "turnstile-widget") {
      if (outputKey === "siteKey") return resource.externalId ?? "";
      if (outputKey === "secretKey") {
        return turnstileApi.getWidgetSecret(this.api, String(resource.externalId ?? ""));
      }
    }
    if (typeId === "vectorize-index") {
      if (outputKey === "indexName") return resource.externalId ?? "";
    }
    if (typeId === "ai-gateway") {
      if (outputKey === "gatewayId") return resource.externalId ?? "";
    }
    if (typeId === "ai-search") {
      if (outputKey === "instanceId") return resource.externalId ?? "";
    }
    if (typeId === "durable-object-namespace") {
      if (outputKey === "namespaceId") return resource.externalId ?? "";
    }
    throw new Error(`Cloudflare plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  /**
   * Detail-view enrichment. For Durable Object namespaces we page in the live
   * instance list (the only public per-instance surface Cloudflare exposes) and
   * stash it on resolvedOutputs for the renderer. Failures degrade gracefully —
   * we return the un-enriched resource so the page still renders namespace
   * details and metrics.
   */
  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    if (resource.resourceTypeId === "ai-gateway") {
      // The gateway endpoint URL and the Workers AI playground both need data
      // that isn't on the listed resource: the Cloudflare account id (for the
      // gateway URL) and the text-generation model catalog (for the model
      // picker). Fetch both for the synchronous renderer; degrade gracefully.
      const enriched: Record<string, string> = { ...resource.resolvedOutputs };
      try {
        enriched["__cfAccountId__"] = await this.api.getAccountId();
      } catch {
        /* no account id — renderer omits the endpoint URL */
      }
      try {
        const models = await workersAiApi.listTextGenerationModelNames(this.api);
        if (models.length > 0) enriched["__models__"] = JSON.stringify(models);
      } catch {
        /* no catalog — renderer falls back to a default model */
      }
      return { ...resource, resolvedOutputs: enriched };
    }
    if (resource.resourceTypeId === "durable-object-namespace") {
      const namespaceId = resource.externalId ?? "";
      if (!namespaceId) return resource;
      try {
        const { instances, truncated } = await durableObjectApi.listDurableObjectInstances(
          this.api,
          namespaceId,
        );
        return {
          ...resource,
          resolvedOutputs: {
            ...resource.resolvedOutputs,
            __instances__: JSON.stringify(instances),
            __instancesTruncated__: truncated ? "true" : "false",
          },
        };
      } catch {
        return resource;
      }
    }
    return resource;
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
      case "workers-ai-model":
        return renderWorkersAiModelDetail(resource);
      case "rate-limit-rule":
        return renderRateLimitRuleDetail(resource);
      case "redirect-rule":
        return renderRedirectRuleDetail(resource);
      case "cache-rule":
        return renderCacheRuleDetail(resource);
      case "ip-access-rule":
        return renderIpAccessRuleDetail(resource);
      case "durable-object-namespace":
        return renderDurableObjectNamespaceDetail(resource);
      case "turnstile-widget":
        return renderTurnstileWidgetDetail(resource, this.resourceTypes);
      case "ai-gateway":
        return renderAiGatewayDetail(resource, this.resourceTypes);
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
    if (resource.resourceTypeId === "ssl-certificate") {
      const status = String(resource.fields["status"] ?? "");
      return {
        id: resource.id,
        label: resource.displayName,
        status: { kind: "status-dot", status: sslStatus(status), label: status },
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

  /**
   * Resolve the zone's domain name (e.g. "example.com") from a parent zone
   * resource id, so hostname fields can show a `.<domain>` suffix. Returns
   * undefined when there's no parent (top-level create with a zone picker) or
   * the lookup fails.
   */
  private async resolveZoneSuffix(parentResourceId?: string): Promise<string | undefined> {
    if (!parentResourceId) return undefined;
    const zoneId = parentResourceId.split(":").slice(2).join(":");
    if (!zoneId) return undefined;
    try {
      const zones = await this.api.getZoneOptions();
      return zones.find((z) => z.id === zoneId)?.label;
    } catch {
      return undefined;
    }
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
      const zoneSuffix = await this.resolveZoneSuffix(parentResourceId);
      if (!parentResourceId) {
        fields.push({
          key: "zoneId",
          label: "Zone",
          kind: "select",
          required: true,
          options: await this.api.getZoneOptions(),
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
          required: true,
          ...(zoneSuffix
            ? {
                kind: "hostname" as const,
                hostnameSuffix: zoneSuffix,
                description: "Subdomain — leave blank for the root domain.",
              }
            : {
                kind: "text" as const,
                description: 'Record name (e.g. "@" for root, "www" for subdomain)',
              }),
        },
        ...dnsContentField({
          key: "content",
          label: "Content",
          placeholder: "IP address, hostname, or text value",
        }),
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
          { key: "password", label: "Password", kind: "password", required: true },
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
          options: await this.api.getZoneOptions(),
        });
      }
      const zoneSuffix = await this.resolveZoneSuffix(parentResourceId);
      fields.push(
        {
          key: "pattern",
          label: "Route Pattern",
          required: true,
          description: "URL pattern (e.g. example.com/path/*)",
          ...(zoneSuffix
            ? { kind: "hostname" as const, hostnameSuffix: zoneSuffix, hostnamePath: true }
            : { kind: "text" as const }),
        },
        {
          key: "scriptName",
          label: "Worker Script",
          kind: "resource-picker",
          required: true,
          description: "Worker script to route to",
          associationSources: [
            { pluginId: "cloudflare", resourceTypeId: "worker", outputKey: "workerName" },
          ],
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
          options: await this.api.getZoneOptions(),
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
          options: await this.api.getZoneOptions(),
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
          options: await this.api.getZoneOptions(),
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
          options: await this.api.getZoneOptions(),
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
      const zoneSuffix = await this.resolveZoneSuffix(parentResourceId);
      if (!parentResourceId) {
        fields.push({
          key: "zoneId",
          label: "Zone",
          kind: "select",
          required: true,
          options: await this.api.getZoneOptions(),
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
          required: true,
          description: "Hostname to apply the waiting room to",
          ...(zoneSuffix
            ? { kind: "hostname" as const, hostnameSuffix: zoneSuffix }
            : { kind: "text" as const }),
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
          options: await this.api.getZoneOptions(),
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
          options: await this.api.getZoneOptions(),
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
          options: await this.api.getAccessAppOptions(),
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
          label: "Include Emails",
          kind: "string-list",
          required: true,
          placeholder: "user@example.com or @example.com",
          addLabel: "+ Add email or domain",
          description:
            "A bare address (user@example.com) matches that user; a leading @ (@example.com) matches everyone at that domain.",
        },
      );
      return { fields };
    }
    if (typeId === "load-balancer") {
      const fields: CreateResourceConfig["fields"] = [];
      const zoneSuffix = await this.resolveZoneSuffix(parentResourceId);
      if (!parentResourceId) {
        fields.push({
          key: "zoneId",
          label: "Zone",
          kind: "select",
          required: true,
          options: await this.api.getZoneOptions(),
        });
      }
      fields.push(
        {
          key: "name",
          label: "Name",
          required: true,
          description: "DNS name for the load balancer",
          ...(zoneSuffix
            ? { kind: "hostname" as const, hostnameSuffix: zoneSuffix }
            : { kind: "text" as const }),
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
          kind: "string-list",
          required: true,
          placeholder: "pool ID",
          addLabel: "+ Add pool",
          description: "Pool IDs to use for default traffic",
        },
      );
      return { fields };
    }
    if (typeId === "spectrum-application") {
      const fields: CreateResourceConfig["fields"] = [];
      const zoneSuffix = await this.resolveZoneSuffix(parentResourceId);
      if (!parentResourceId) {
        fields.push({
          key: "zoneId",
          label: "Zone",
          kind: "select",
          required: true,
          options: await this.api.getZoneOptions(),
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
          required: true,
          description: "Subdomain for the Spectrum app",
          ...(zoneSuffix
            ? { kind: "hostname" as const, hostnameSuffix: zoneSuffix }
            : { kind: "text" as const }),
        },
        {
          key: "originDirect",
          label: "Origin Direct",
          kind: "string-list",
          required: true,
          placeholder: "203.0.113.1:22",
          addLabel: "+ Add origin",
          description: "Origin addresses in IP:port format (e.g. 203.0.113.1:22)",
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
    if (typeId === "ip-access-rule") {
      const fields: CreateResourceConfig["fields"] = [];
      if (!parentResourceId) {
        fields.push({
          key: "zoneId",
          label: "Zone",
          kind: "select",
          required: true,
          options: await this.api.getZoneOptions(),
        });
      }
      fields.push(
        {
          key: "mode",
          label: "Action",
          kind: "select",
          required: true,
          defaultValue: "block",
          options: [
            { id: "block", label: "Block" },
            { id: "challenge", label: "Interactive Challenge" },
            { id: "js_challenge", label: "JS Challenge" },
            { id: "managed_challenge", label: "Managed Challenge" },
            { id: "whitelist", label: "Allow (whitelist)" },
          ],
        },
        {
          key: "target",
          label: "Match Type",
          kind: "select",
          required: true,
          defaultValue: "ip",
          options: [
            { id: "ip", label: "IP address" },
            { id: "ip_range", label: "IP range (CIDR)" },
            { id: "asn", label: "ASN" },
            { id: "country", label: "Country" },
          ],
        },
        {
          key: "value",
          label: "Value",
          kind: "text",
          required: true,
          description: "e.g. 203.0.113.1, 203.0.113.0/24, AS13335, or a 2-letter country code",
        },
        {
          key: "notes",
          label: "Notes",
          kind: "text",
          required: false,
          description: "Optional description for this rule",
        },
      );
      return { fields };
    }
    if (typeId === "rate-limit-rule" || typeId === "redirect-rule" || typeId === "cache-rule") {
      const fields: CreateResourceConfig["fields"] = [];
      if (!parentResourceId) {
        fields.push({
          key: "zoneId",
          label: "Zone",
          kind: "select",
          required: true,
          options: await this.api.getZoneOptions(),
        });
      }
      fields.push({
        key: "description",
        label: "Description",
        kind: "text",
        required: false,
        description: "A human-readable name for this rule",
      });
      fields.push({
        key: "expression",
        label: "Expression",
        kind: "text",
        required: true,
        description: 'Rules-language match expression (e.g. http.request.uri.path eq "/old")',
      });
      if (typeId === "rate-limit-rule") {
        fields.push(
          {
            key: "requestsPerPeriod",
            label: "Requests",
            kind: "number",
            required: true,
            defaultValue: "100",
            minValue: 1,
            description: "Max requests allowed per period before the action fires",
          },
          {
            key: "period",
            label: "Period",
            kind: "select",
            required: true,
            defaultValue: "60",
            options: [
              { id: "10", label: "10 seconds" },
              { id: "60", label: "1 minute" },
              { id: "120", label: "2 minutes" },
              { id: "300", label: "5 minutes" },
              { id: "600", label: "10 minutes" },
              { id: "3600", label: "1 hour" },
            ],
          },
          {
            key: "characteristics",
            label: "Counting characteristics",
            kind: "string-list",
            required: false,
            defaultValue: "ip.src",
            placeholder: "ip.src",
            addLabel: "+ Add characteristic",
            description: "Counting keys (e.g. ip.src, http.request.headers)",
          },
          {
            key: "action",
            label: "Action",
            kind: "select",
            required: true,
            defaultValue: "block",
            options: [
              { id: "block", label: "Block" },
              { id: "managed_challenge", label: "Managed Challenge" },
              { id: "js_challenge", label: "JS Challenge" },
              { id: "challenge", label: "Interactive Challenge" },
              { id: "log", label: "Log" },
            ],
          },
        );
      } else if (typeId === "redirect-rule") {
        fields.push(
          {
            key: "target",
            label: "Target URL",
            kind: "text",
            required: true,
            description: "Destination URL to redirect to (e.g. https://example.com/new)",
          },
          {
            key: "statusCode",
            label: "Status Code",
            kind: "select",
            required: true,
            defaultValue: "301",
            options: [
              { id: "301", label: "301 Moved Permanently" },
              { id: "302", label: "302 Found" },
              { id: "307", label: "307 Temporary Redirect" },
              { id: "308", label: "308 Permanent Redirect" },
            ],
          },
          {
            key: "preserveQuery",
            label: "Preserve Query String",
            kind: "select",
            required: false,
            defaultValue: "true",
            options: [
              { id: "true", label: "Yes" },
              { id: "false", label: "No" },
            ],
          },
        );
      } else {
        // cache-rule
        fields.push(
          {
            key: "cache",
            label: "Cache Eligibility",
            kind: "select",
            required: true,
            defaultValue: "true",
            options: [
              { id: "true", label: "Eligible for cache" },
              { id: "false", label: "Bypass cache" },
            ],
          },
          {
            key: "edgeTtl",
            label: "Edge TTL (seconds)",
            kind: "number",
            required: false,
            minValue: 0,
            description: "Override edge cache TTL (leave blank to respect origin headers)",
            showWhen: { fieldKey: "cache", fieldValue: "true" },
          },
        );
      }
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
    if (typeId === "turnstile-widget") {
      return {
        fields: [
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            description: "A human-readable label for this widget",
          },
          {
            key: "domains",
            label: "Domains",
            kind: "string-list",
            required: false,
            placeholder: "example.com",
            addLabel: "+ Add domain",
            description: "Hostnames allowed to use this widget",
          },
          {
            key: "mode",
            label: "Widget Mode",
            kind: "select",
            required: false,
            defaultValue: "managed",
            options: [
              { id: "managed", label: "Managed (recommended)" },
              { id: "non-interactive", label: "Non-interactive" },
              { id: "invisible", label: "Invisible" },
            ],
          },
        ],
      };
    }
    if (typeId === "healthcheck") {
      const fields: CreateResourceConfig["fields"] = [];
      if (!parentResourceId) {
        fields.push({
          key: "zoneId",
          label: "Zone",
          kind: "select",
          required: true,
          options: await this.api.getZoneOptions(),
        });
      }
      fields.push(
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: true,
          description: "A name for this health check",
        },
        {
          key: "address",
          label: "Address",
          kind: "text",
          required: true,
          description: "Hostname or IP address to monitor (e.g. origin.example.com)",
        },
        {
          key: "type",
          label: "Protocol",
          kind: "select",
          required: false,
          defaultValue: "HTTPS",
          options: [
            { id: "HTTPS", label: "HTTPS" },
            { id: "HTTP", label: "HTTP" },
            { id: "TCP", label: "TCP" },
          ],
        },
        {
          key: "path",
          label: "Path",
          kind: "text",
          required: false,
          defaultValue: "/",
          description: "Request path (HTTP/HTTPS only)",
          showWhen: { fieldKey: "type", fieldValue: "HTTPS" },
        },
        {
          key: "description",
          label: "Description",
          kind: "text",
          required: false,
        },
      );
      return { fields };
    }
    if (typeId === "notification-policy") {
      return {
        fields: [
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            description: "A name for this notification policy",
          },
          {
            key: "alertType",
            label: "Alert Type",
            kind: "select",
            required: true,
            defaultValue: "universal_ssl_event_type",
            options: [
              { id: "universal_ssl_event_type", label: "Universal SSL event" },
              { id: "dedicated_ssl_certificate_event_type", label: "Advanced certificate event" },
              { id: "health_check_status_notification", label: "Health check status change" },
              { id: "load_balancing_health_alert", label: "Load balancing health alert" },
              { id: "http_alert_origin_error", label: "Origin error rate alert" },
              { id: "http_alert_edge_error", label: "Edge error rate alert" },
              { id: "dos_attack_l7", label: "HTTP DDoS attack" },
              { id: "billing_usage_alert", label: "Billing usage alert" },
              { id: "expiring_service_token_alert", label: "Expiring service token" },
              {
                id: "failing_logpush_job_disabled_alert",
                label: "Failing Logpush job disabled",
              },
            ],
          },
          {
            key: "email",
            label: "Notify Emails",
            kind: "string-list",
            required: true,
            placeholder: "ops@example.com",
            addLabel: "+ Add email",
            description: "Email addresses to notify",
          },
          {
            key: "description",
            label: "Description",
            kind: "text",
            required: false,
          },
        ],
      };
    }
    if (typeId === "vectorize-index") {
      return {
        fields: [
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            description: "Index name (lowercase letters, numbers, hyphens)",
          },
          {
            key: "dimensions",
            label: "Dimensions",
            kind: "number",
            required: true,
            defaultValue: "768",
            description: "Vector dimensionality (must match your embedding model)",
            minValue: 1,
            maxValue: 1536,
          },
          {
            key: "metric",
            label: "Distance Metric",
            kind: "select",
            required: false,
            defaultValue: "cosine",
            options: [
              { id: "cosine", label: "Cosine" },
              { id: "euclidean", label: "Euclidean" },
              { id: "dot-product", label: "Dot product" },
            ],
          },
          {
            key: "description",
            label: "Description",
            kind: "text",
            required: false,
          },
        ],
      };
    }
    if (typeId === "ai-gateway") {
      return {
        fields: [
          {
            key: "id",
            label: "Gateway ID",
            kind: "text",
            required: true,
            description:
              "Gateway slug (lowercase letters, numbers, hyphens) — used in the gateway URL",
          },
          {
            key: "collectLogs",
            label: "Collect Logs",
            kind: "select",
            required: false,
            defaultValue: "true",
            description: "Store request/response logs for analytics and debugging",
            options: [
              { id: "true", label: "Enabled" },
              { id: "false", label: "Disabled" },
            ],
          },
          {
            key: "cacheTtl",
            label: "Cache TTL (seconds)",
            kind: "number",
            required: false,
            description: "How long to cache identical requests. Leave blank to disable caching.",
            minValue: 0,
          },
          {
            key: "cacheInvalidateOnUpdate",
            label: "Invalidate Cache on Update",
            kind: "select",
            required: false,
            defaultValue: "false",
            options: [
              { id: "true", label: "Enabled" },
              { id: "false", label: "Disabled" },
            ],
          },
          {
            key: "rateLimitingLimit",
            label: "Rate Limit (requests)",
            kind: "number",
            required: false,
            description: "Max requests per window. Leave blank for no rate limit.",
            minValue: 0,
          },
          {
            key: "rateLimitingInterval",
            label: "Rate Limit Window (seconds)",
            kind: "number",
            required: false,
            minValue: 0,
          },
          {
            key: "rateLimitingTechnique",
            label: "Rate Limit Technique",
            kind: "select",
            required: false,
            defaultValue: "fixed",
            showWhen: { fieldKey: "rateLimitingLimit", fieldValuesNot: [""] },
            options: [
              { id: "fixed", label: "Fixed window" },
              { id: "sliding", label: "Sliding window" },
            ],
          },
          {
            key: "authentication",
            label: "Authenticated Gateway",
            kind: "select",
            required: false,
            defaultValue: "false",
            description: "Require a Cloudflare token on every request to the gateway",
            options: [
              { id: "true", label: "Enabled" },
              { id: "false", label: "Disabled" },
            ],
          },
          {
            key: "logpush",
            label: "Logpush",
            kind: "select",
            required: false,
            defaultValue: "false",
            description: "Forward gateway logs to a Logpush destination",
            options: [
              { id: "true", label: "Enabled" },
              { id: "false", label: "Disabled" },
            ],
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
    return withCloudflareErrors(() =>
      this.createResourceImpl(typeId, accountId, fields, parentResourceId),
    );
  }

  private async createResourceImpl(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const parentExternalId = parentResourceId ? parentResourceId.split(":").slice(2).join(":") : "";
    switch (typeId) {
      case "zone":
        return zoneApi.createZone(this.api, accountId, fields);
      case "dns-record":
        return dnsRecordApi.createDnsRecord(this.api, accountId, fields, parentExternalId);
      case "r2-bucket":
        return r2Api.createR2Bucket(this.api, accountId, fields);
      case "kv-namespace":
        return kvApi.createKVNamespace(this.api, accountId, fields);
      case "d1-database":
        return d1Api.createD1Database(this.api, accountId, fields);
      case "queue":
        return queueApi.createQueue(this.api, accountId, fields);
      case "hyperdrive":
        return hyperdriveApi.createHyperdrive(this.api, accountId, fields);
      case "tunnel":
        return tunnelApi.createTunnel(this.api, accountId, fields);
      case "worker-route":
        return workerRouteApi.createWorkerRoute(this.api, accountId, fields, parentExternalId);
      case "page-rule":
        return pageRuleApi.createPageRule(this.api, accountId, fields, parentExternalId);
      case "firewall-rule":
        return firewallApi.createFirewallRule(this.api, accountId, fields, parentExternalId);
      case "custom-hostname":
        return customHostnameApi.createCustomHostname(
          this.api,
          accountId,
          fields,
          parentExternalId,
        );
      case "email-routing-rule":
        return emailRoutingApi.createEmailRoutingRule(
          this.api,
          accountId,
          fields,
          parentExternalId,
        );
      case "waiting-room":
        return waitingRoomApi.createWaitingRoom(this.api, accountId, fields, parentExternalId);
      case "ssl-certificate":
        return sslApi.createSSLCertificate(this.api, accountId, fields, parentExternalId);
      case "logpush-job":
        return logpushApi.createLogpushJob(this.api, accountId, fields, parentExternalId);
      case "access-application":
        return accessAppApi.createAccessApplication(this.api, accountId, fields);
      case "access-policy":
        return accessPolicyApi.createAccessPolicy(this.api, accountId, fields, parentExternalId);
      case "load-balancer":
        return loadBalancerApi.createLoadBalancer(this.api, accountId, fields, parentExternalId);
      case "spectrum-application":
        return spectrumApi.createSpectrumApplication(this.api, accountId, fields, parentExternalId);
      case "worker":
        return workerApi.createWorker(this.api, accountId, fields);
      case "rate-limit-rule":
      case "redirect-rule":
      case "cache-rule":
        return createPhaseRule(this.api, accountId, RULE_SPECS[typeId]!, fields, parentExternalId);
      case "ip-access-rule":
        return ipAccessApi.createIpAccessRule(this.api, accountId, fields, parentExternalId);
      case "turnstile-widget":
        return turnstileApi.createTurnstileWidget(this.api, accountId, fields);
      case "healthcheck":
        return healthcheckApi.createHealthcheck(this.api, accountId, fields, parentExternalId);
      case "notification-policy":
        return notificationApi.createNotificationPolicy(this.api, accountId, fields);
      case "vectorize-index":
        return vectorizeApi.createVectorizeIndex(this.api, accountId, fields);
      case "ai-gateway":
        return aiGatewayApi.createAiGateway(this.api, accountId, fields);
      default:
        throw new Error(`Cloudflare plugin: createResource not supported for type "${typeId}"`);
    }
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    return withCloudflareErrors(() =>
      this.updateResourceImpl(typeId, resourceId, accountId, fields),
    );
  }

  private async updateResourceImpl(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const externalId = resourceId.split(":").slice(2).join(":");
    if (typeId === "dns-record") {
      return dnsRecordApi.updateDnsRecord(this.api, externalId, accountId, fields);
    }
    if (typeId === "tunnel") {
      // The tunnel-attach orchestrator points this tunnel's ingress at a local
      // service (`ingressService`, e.g. ssh://localhost:22 or http://localhost:8080)
      // for `ingressHostname`.
      if (fields["ingressHostname"] && fields["ingressService"]) {
        await tunnelApi.setTunnelIngress(
          this.api,
          externalId,
          fields["ingressHostname"],
          fields["ingressService"],
        );
      }
      return this.getResource(typeId, resourceId, accountId);
    }

    // Most Cloudflare writes (PUT or required-field PATCH) need the full
    // resource state, but the host only hands us the changed keys. Merge the
    // current field values underneath so each builder sees a complete set.
    const merged = await this.mergeCurrentFields(typeId, resourceId, accountId, fields);

    if (typeId === "rate-limit-rule" || typeId === "redirect-rule" || typeId === "cache-rule") {
      return editPhaseRule(this.api, accountId, RULE_SPECS[typeId]!, externalId, merged);
    }
    if (typeId === "firewall-rule") {
      return firewallApi.editFirewallRule(this.api, accountId, externalId, merged);
    }
    if (typeId === "ip-access-rule") {
      return ipAccessApi.editIpAccessRule(this.api, accountId, externalId, merged);
    }
    if (typeId === "waiting-room") {
      return waitingRoomApi.editWaitingRoom(this.api, accountId, externalId, merged);
    }
    if (typeId === "load-balancer") {
      return loadBalancerApi.editLoadBalancer(this.api, accountId, externalId, merged);
    }
    if (typeId === "hyperdrive") {
      // `fields` is the changed-only set; `merged` carries the full current
      // origin so editHyperdrive can build a complete patch.
      return hyperdriveApi.editHyperdrive(
        this.api,
        accountId,
        externalId,
        merged,
        Object.keys(fields),
      );
    }
    if (typeId === "custom-hostname") {
      return customHostnameApi.editCustomHostname(this.api, accountId, externalId, merged);
    }
    if (typeId === "email-routing-rule") {
      return emailRoutingApi.editEmailRoutingRule(this.api, accountId, externalId, merged);
    }
    if (typeId === "spectrum-application") {
      return spectrumApi.editSpectrumApplication(this.api, accountId, externalId, merged);
    }
    if (typeId === "logpush-job") {
      return logpushApi.editLogpushJob(this.api, accountId, externalId, merged);
    }
    if (typeId === "access-application") {
      return accessAppApi.editAccessApplication(this.api, accountId, externalId, merged);
    }
    if (typeId === "access-policy") {
      return accessPolicyApi.editAccessPolicy(this.api, accountId, externalId, merged);
    }
    if (typeId === "page-rule") {
      return pageRuleApi.editPageRule(this.api, accountId, externalId, merged);
    }
    if (typeId === "turnstile-widget") {
      return turnstileApi.editTurnstileWidget(this.api, accountId, externalId, merged);
    }
    if (typeId === "healthcheck") {
      return healthcheckApi.editHealthcheck(this.api, accountId, externalId, merged);
    }
    if (typeId === "notification-policy") {
      return notificationApi.editNotificationPolicy(this.api, accountId, externalId, merged);
    }
    if (typeId === "ai-gateway") {
      return aiGatewayApi.editAiGateway(this.api, accountId, externalId, merged);
    }
    throw new Error(`Cloudflare plugin: updateResource not supported for type "${typeId}"`);
  }

  /**
   * Fetch a resource's current fields and merge the changed keys on top,
   * coercing every value to a string (the create/update builders all work in
   * string space). Falls back to the changed keys alone if the fetch fails.
   */
  private async mergeCurrentFields(
    typeId: string,
    resourceId: string,
    accountId: string,
    changed: Record<string, string>,
  ): Promise<Record<string, string>> {
    let current: Record<string, string> = {};
    try {
      const resource = await this.getResource(typeId, resourceId, accountId);
      for (const [k, v] of Object.entries(resource.fields)) {
        if (v !== undefined && v !== null) current[k] = String(v);
      }
    } catch {
      current = {};
    }
    return { ...current, ...changed };
  }

  async publishMessage(
    typeId: string,
    resourceId: string,
    _accountId: string,
    payload: PublishMessagePayload,
  ): Promise<PublishMessageResult> {
    const externalId = resourceId.split(":").slice(2).join(":");
    if (typeId === "queue") {
      return withCloudflareErrors(() => queueApi.publishMessage(this.api, externalId, payload));
    }
    throw new Error(`Cloudflare plugin: publishMessage not supported for type "${typeId}"`);
  }

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    return withCloudflareErrors(() => this.deleteResourceImpl(typeId, resourceId, accountId));
  }

  private async deleteResourceImpl(
    typeId: string,
    resourceId: string,
    _accountId: string,
  ): Promise<void> {
    const externalId = resourceId.split(":").slice(2).join(":");

    switch (typeId) {
      case "zone":
        return zoneApi.deleteZone(this.api, externalId);
      case "dns-record":
        return dnsRecordApi.deleteDnsRecord(this.api, externalId);
      case "r2-bucket":
        return r2Api.deleteR2Bucket(this.api, externalId);
      case "kv-namespace":
        return kvApi.deleteKVNamespace(this.api, externalId);
      case "d1-database":
        return d1Api.deleteD1Database(this.api, externalId);
      case "queue":
        return queueApi.deleteQueue(this.api, externalId);
      case "hyperdrive":
        return hyperdriveApi.deleteHyperdrive(this.api, externalId);
      case "worker":
        return workerApi.deleteWorker(this.api, externalId);
      case "tunnel":
        return tunnelApi.deleteTunnel(this.api, externalId);
      case "ssl-certificate":
        return sslApi.deleteSSLCertificate(this.api, externalId);
      case "page-rule":
        return pageRuleApi.deletePageRule(this.api, externalId);
      case "firewall-rule":
        return firewallApi.deleteFirewallRule(this.api, externalId);
      case "access-application":
        return accessAppApi.deleteAccessApplication(this.api, externalId);
      case "load-balancer":
        return loadBalancerApi.deleteLoadBalancer(this.api, externalId);
      case "worker-route":
        return workerRouteApi.deleteWorkerRoute(this.api, externalId);
      case "custom-hostname":
        return customHostnameApi.deleteCustomHostname(this.api, externalId);
      case "waiting-room":
        return waitingRoomApi.deleteWaitingRoom(this.api, externalId);
      case "spectrum-application":
        return spectrumApi.deleteSpectrumApplication(this.api, externalId);
      case "logpush-job":
        return logpushApi.deleteLogpushJob(this.api, externalId);
      case "rate-limit-rule":
      case "redirect-rule":
      case "cache-rule":
        return deletePhaseRule(this.api, externalId);
      case "ip-access-rule":
        return ipAccessApi.deleteIpAccessRule(this.api, externalId);
      case "turnstile-widget":
        return turnstileApi.deleteTurnstileWidget(this.api, externalId);
      case "healthcheck":
        return healthcheckApi.deleteHealthcheck(this.api, externalId);
      case "notification-policy":
        return notificationApi.deleteNotificationPolicy(this.api, externalId);
      case "vectorize-index":
        return vectorizeApi.deleteVectorizeIndex(this.api, externalId);
      case "ai-gateway":
        return aiGatewayApi.deleteAiGateway(this.api, externalId);
      case "ai-search":
        return aiSearchApi.deleteAiSearchInstance(this.api, externalId);
      default:
        throw new Error(`Cloudflare plugin: deleteResource not supported for type "${typeId}"`);
    }
  }

  async executeQuery(
    resourceId: string,
    _accountId: string,
    sql: string,
  ): Promise<{ rows: Record<string, unknown>[]; durationMs: number }> {
    return d1Api.executeD1Query(this.api, resourceId, sql);
  }

  async introspectResource(resourceId: string, _accountId: string): Promise<SqlTableMeta[]> {
    return d1Api.introspectD1Database(this.api, resourceId);
  }

  async exportCredential(
    typeId: string,
    resourceId: string,
    accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    if (typeId === "tunnel" && formatId === "tunnel-token") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      return tunnelApi.exportTunnelCredential(this.api, resource);
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
      return workerApi.getWorkerManifest(this.api, externalId);
    }
    if (typeId === "zone") {
      return zoneApi.getZoneManifest(this.api, externalId);
    }
    throw new Error(`Cloudflare plugin: getManifest not supported for type "${typeId}"`);
  }

  async applyManifest(resourceId: string, _accountId: string, manifest: string): Promise<void> {
    const parts = resourceId.split(":");
    const typeId = parts[1];
    const externalId = parts.slice(2).join(":");

    if (typeId === "zone") {
      return zoneApi.applyZoneManifest(this.api, externalId, manifest);
    }
    if (typeId === "worker") {
      return workerApi.applyWorkerManifest(this.api, externalId, manifest);
    }
    throw new Error(`Cloudflare plugin: applyManifest not supported for type "${typeId}"`);
  }

  /**
   * Invoke a plugin-defined action against a resource (host calls this for an
   * `ActionNode` whose action is `{ type: "plugin-action" }`). Currently powers
   * the zone "Purge Everything" cache action.
   */
  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const externalId = resourceId.split(":").slice(2).join(":");
    if (typeId === "zone" && actionId === "purge-cache-all") {
      return withCloudflareErrors(() => zoneApi.purgeCacheEverything(this.api, externalId));
    }
    throw new Error(`Cloudflare plugin: unknown action "${actionId}" for type "${typeId}"`);
  }

  async listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    return r2Api.listR2StorageObjects(this.api, bucket, prefix);
  }

  async listKvKeys(
    _resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    params?: { prefix?: string; cursor?: string; limit?: number },
  ): Promise<KvListResult> {
    const namespaceId = resourceId.split(":").pop() ?? "";
    return kvApi.listKVKeys(this.api, namespaceId, params ?? {});
  }

  async getKvValue(
    _resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    key: string,
  ): Promise<string> {
    const namespaceId = resourceId.split(":").pop() ?? "";
    return kvApi.getKVValue(this.api, namespaceId, key);
  }

  async putKvValue(
    _resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    key: string,
    value: string,
  ): Promise<void> {
    const namespaceId = resourceId.split(":").pop() ?? "";
    return kvApi.putKVValue(this.api, namespaceId, key, value);
  }

  async deleteKvKey(
    _resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    key: string,
  ): Promise<void> {
    const namespaceId = resourceId.split(":").pop() ?? "";
    return kvApi.deleteKVKey(this.api, namespaceId, key);
  }

  async deleteStorageObject(bucket: string, key: string): Promise<void> {
    return r2Api.deleteR2StorageObject(this.api, bucket, key);
  }

  async uploadStorageObject(bucket: string, key: string, file: File): Promise<void> {
    return r2Api.uploadR2StorageObject(this.api, bucket, key, file);
  }

  async makeStorageFolder(bucket: string, key: string): Promise<void> {
    return r2Api.makeR2StorageFolder(this.api, bucket, key);
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

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (resourceTypeId === "worker") {
      return this.fetchWorkerMetricSeries(resourceId, timeRange);
    }
    if (resourceTypeId === "r2-bucket") {
      return this.fetchR2MetricSeries(resourceId, timeRange);
    }
    if (resourceTypeId === "spectrum-application") {
      return this.fetchSpectrumMetricSeries(resourceId, timeRange);
    }
    if (resourceTypeId === "d1-database") {
      return this.fetchD1MetricSeries(resourceId, timeRange);
    }
    if (resourceTypeId === "kv-namespace") {
      return this.fetchKVMetricSeries(resourceId, timeRange);
    }
    if (resourceTypeId === "queue") {
      return this.fetchQueueMetricSeries(resourceId, timeRange);
    }
    if (resourceTypeId === "hyperdrive") {
      return this.fetchHyperdriveMetricSeries(resourceId, timeRange);
    }
    if (resourceTypeId === "load-balancer") {
      return this.fetchLoadBalancerMetricSeries(resourceId, timeRange);
    }
    if (resourceTypeId === "waiting-room") {
      return this.fetchWaitingRoomMetricSeries(resourceId, timeRange);
    }
    if (resourceTypeId === "durable-object-namespace") {
      return this.fetchDurableObjectMetricSeries(resourceId, timeRange);
    }
    if (resourceTypeId === "turnstile-widget") {
      return this.fetchTurnstileMetricSeries(resourceId, timeRange);
    }
    if (resourceTypeId === "ai-gateway") {
      return this.fetchAiGatewayMetricSeries(resourceId, timeRange);
    }
    if (resourceTypeId !== "zone") return [];

    const zoneId = resourceId.split(":").pop();
    if (!zoneId) return [];

    const now = Date.now();
    const from = new Date(timeRange?.startMs ?? now - 24 * 3_600_000).toISOString();
    const to = new Date(timeRange?.endMs ?? now).toISOString();

    // Pick aggregation granularity: hour buckets for windows ≥6h, minute for shorter.
    const windowMs = (timeRange?.endMs ?? now) - (timeRange?.startMs ?? now - 24 * 3_600_000);
    const useHourly = windowMs >= 6 * 3_600_000;
    const groupName = useHourly ? "httpRequests1hGroups" : "httpRequests1mGroups";
    const dimKey = useHourly ? "datetime" : "datetimeMinute";

    const query = `query Z($zone: String!, $from: Time!, $to: Time!) {
      viewer {
        zones(filter: { zoneTag: $zone }) {
          ${groupName}(
            limit: 1000
            filter: { datetime_geq: $from, datetime_lt: $to }
            orderBy: [${dimKey}_ASC]
          ) {
            dimensions { ${dimKey} }
            sum { requests bytes cachedRequests cachedBytes threats }
            uniq { uniques }
          }
        }
      }
    }`;

    interface GraphResp {
      data?: {
        viewer?: {
          zones?: Array<{
            httpRequests1mGroups?: GraphGroup[];
            httpRequests1hGroups?: GraphGroup[];
          }>;
        };
      };
    }
    interface GraphGroup {
      dimensions: { datetimeMinute?: string; datetime?: string };
      sum: {
        requests?: number;
        bytes?: number;
        cachedRequests?: number;
        cachedBytes?: number;
        threats?: number;
      };
      uniq: { uniques?: number };
    }

    let groups: GraphGroup[] = [];
    try {
      const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.api.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          variables: { zone: zoneId, from, to },
        }),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as GraphResp;
      const zoneGroups = json.data?.viewer?.zones?.[0];
      groups =
        (useHourly ? zoneGroups?.httpRequests1hGroups : zoneGroups?.httpRequests1mGroups) ?? [];
    } catch {
      return [];
    }

    if (groups.length === 0) return [];

    const tsOf = (g: GraphGroup): number =>
      new Date(String(g.dimensions[dimKey as "datetime"] ?? "")).getTime();

    const requests: MetricSeries = {
      label: "Requests",
      unit: "requests",
      points: groups.map((g) => ({ timestamp: tsOf(g), value: Number(g.sum.requests ?? 0) })),
    };
    const bytes: MetricSeries = {
      label: "Bandwidth",
      unit: "bytes",
      points: groups.map((g) => ({ timestamp: tsOf(g), value: Number(g.sum.bytes ?? 0) })),
    };
    const cached: MetricSeries = {
      label: "Cached Requests",
      unit: "requests",
      points: groups.map((g) => ({
        timestamp: tsOf(g),
        value: Number(g.sum.cachedRequests ?? 0),
      })),
    };
    const threats: MetricSeries = {
      label: "Threats",
      unit: "events",
      points: groups.map((g) => ({ timestamp: tsOf(g), value: Number(g.sum.threats ?? 0) })),
    };
    const uniques: MetricSeries = {
      label: "Unique Visitors",
      unit: "visitors",
      points: groups.map((g) => ({ timestamp: tsOf(g), value: Number(g.uniq.uniques ?? 0) })),
    };

    return [requests, bytes, cached, threats, uniques].filter((s) =>
      s.points.some((p) => p.value > 0),
    );
  }

  /**
   * Worker metrics via GraphQL `workersInvocationsAdaptive`. Worker scripts
   * are account-scoped (not zone-scoped) so this resolves the CF account ID
   * via the shared client before issuing the query. Resource id encoding:
   * `${infrawrenchAccountId}:worker:${scriptName}` — we take the last segment.
   */
  private async fetchWorkerMetricSeries(
    resourceId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const scriptName = resourceId.split(":").pop();
    if (!scriptName) return [];

    let cfAccountId: string;
    try {
      cfAccountId = await this.api.getAccountId();
    } catch {
      return [];
    }

    const now = Date.now();
    const from = new Date(timeRange?.startMs ?? now - 24 * 3_600_000).toISOString();
    const to = new Date(timeRange?.endMs ?? now).toISOString();
    const windowMs = (timeRange?.endMs ?? now) - (timeRange?.startMs ?? now - 24 * 3_600_000);
    // Workers GraphQL exposes 15-minute and 1-hour buckets; the 1m schema is
    // gated behind paid plans, so always pick 15m for short windows and 1h
    // for windows ≥6h.
    const useHourly = windowMs >= 6 * 3_600_000;
    const groupName = useHourly
      ? "workersInvocationsAdaptiveGroups"
      : "workersInvocationsAdaptiveGroups";
    const orderBy = "datetime_ASC";

    // workersInvocationsAdaptive sum-able fields are requests / subrequests /
    // errors only — duration is exposed via the `quantiles` block (cpuTimeP50/
    // cpuTimeP99, durationP50/durationP99). See:
    // https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/
    const query = `query W($account: String!, $script: String!, $from: Time!, $to: Time!) {
      viewer {
        accounts(filter: { accountTag: $account }) {
          ${groupName}(
            limit: 1000
            filter: { scriptName: $script, datetime_geq: $from, datetime_lt: $to }
            orderBy: [${orderBy}]
          ) {
            dimensions { datetime }
            sum { requests subrequests errors }
            quantiles { cpuTimeP50 cpuTimeP99 }
          }
        }
      }
    }`;

    interface Group {
      dimensions: { datetime: string };
      sum: { requests?: number; subrequests?: number; errors?: number };
      quantiles: { cpuTimeP50?: number; cpuTimeP99?: number };
    }
    interface Resp {
      data?: { viewer?: { accounts?: Array<{ workersInvocationsAdaptiveGroups?: Group[] }> } };
    }

    let groups: Group[] = [];
    try {
      const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.api.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          variables: { account: cfAccountId, script: scriptName, from, to },
        }),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as Resp;
      groups = json.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptiveGroups ?? [];
    } catch {
      return [];
    }
    if (groups.length === 0) return [];

    const tsOf = (g: Group): number => new Date(g.dimensions.datetime).getTime();
    const series: MetricSeries[] = [
      {
        label: "Requests",
        unit: "requests",
        points: groups.map((g) => ({ timestamp: tsOf(g), value: Number(g.sum.requests ?? 0) })),
      },
      {
        label: "Errors",
        unit: "errors",
        points: groups.map((g) => ({ timestamp: tsOf(g), value: Number(g.sum.errors ?? 0) })),
      },
      {
        label: "Subrequests",
        unit: "subrequests",
        points: groups.map((g) => ({ timestamp: tsOf(g), value: Number(g.sum.subrequests ?? 0) })),
      },
      {
        label: "CPU Time p50",
        unit: "μs",
        points: groups.map((g) => ({
          timestamp: tsOf(g),
          value: Number(g.quantiles.cpuTimeP50 ?? 0),
        })),
      },
      {
        label: "CPU Time p99",
        unit: "μs",
        points: groups.map((g) => ({
          timestamp: tsOf(g),
          value: Number(g.quantiles.cpuTimeP99 ?? 0),
        })),
      },
    ];
    return series.filter((s) => s.points.some((p) => p.value > 0));
  }

  /**
   * R2 bucket metrics via GraphQL `r2OperationsAdaptiveGroups` (Class A/B
   * operation counts) and `r2StorageAdaptiveGroups` (object/byte counts).
   * Both are account-scoped and filter by `bucketName`.
   */
  private async fetchR2MetricSeries(
    resourceId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const bucketName = resourceId.split(":").pop();
    if (!bucketName) return [];

    let cfAccountId: string;
    try {
      cfAccountId = await this.api.getAccountId();
    } catch {
      return [];
    }

    const now = Date.now();
    const from = new Date(timeRange?.startMs ?? now - 24 * 3_600_000).toISOString();
    const to = new Date(timeRange?.endMs ?? now).toISOString();

    const query = `query R($account: String!, $bucket: String!, $from: Time!, $to: Time!) {
      viewer {
        accounts(filter: { accountTag: $account }) {
          r2OperationsAdaptiveGroups(
            limit: 1000
            filter: { bucketName: $bucket, datetime_geq: $from, datetime_lt: $to }
            orderBy: [datetime_ASC]
          ) {
            dimensions { datetime actionType }
            sum { requests responseObjectSize }
          }
          r2StorageAdaptiveGroups(
            limit: 1000
            filter: { bucketName: $bucket, datetime_geq: $from, datetime_lt: $to }
            orderBy: [datetime_ASC]
          ) {
            dimensions { datetime }
            max { metadataSize payloadSize objectCount uploadCount }
          }
        }
      }
    }`;

    interface OpsGroup {
      dimensions: { datetime: string; actionType: string };
      sum: { requests?: number; responseObjectSize?: number };
    }
    interface StorageGroup {
      dimensions: { datetime: string };
      max: {
        metadataSize?: number;
        payloadSize?: number;
        objectCount?: number;
        uploadCount?: number;
      };
    }
    interface Resp {
      data?: {
        viewer?: {
          accounts?: Array<{
            r2OperationsAdaptiveGroups?: OpsGroup[];
            r2StorageAdaptiveGroups?: StorageGroup[];
          }>;
        };
      };
    }

    let ops: OpsGroup[] = [];
    let storage: StorageGroup[] = [];
    try {
      const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.api.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          variables: { account: cfAccountId, bucket: bucketName, from, to },
        }),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as Resp;
      const acc = json.data?.viewer?.accounts?.[0];
      ops = acc?.r2OperationsAdaptiveGroups ?? [];
      storage = acc?.r2StorageAdaptiveGroups ?? [];
    } catch {
      return [];
    }

    // R2 splits requests into Class A (writes/lists, $$$) and Class B (reads, $).
    // Bucket the ops counts so the user sees both lines clearly.
    const tsOf = (s: { dimensions: { datetime: string } }): number =>
      new Date(s.dimensions.datetime).getTime();
    const classA = new Map<number, number>();
    const classB = new Map<number, number>();
    const CLASS_A_ACTIONS = new Set([
      "ListBuckets",
      "PutBucket",
      "ListObjects",
      "PutObject",
      "CopyObject",
      "CompleteMultipartUpload",
      "CreateMultipartUpload",
      "UploadPart",
      "UploadPartCopy",
      "PutBucketEncryption",
      "ListMultipartUploads",
      "PutBucketCors",
      "PutBucketLifecycleConfiguration",
    ]);
    for (const g of ops) {
      const t = tsOf(g);
      const v = Number(g.sum.requests ?? 0);
      const target = CLASS_A_ACTIONS.has(g.dimensions.actionType) ? classA : classB;
      target.set(t, (target.get(t) ?? 0) + v);
    }

    const toSeries = (m: Map<number, number>, label: string, unit: string): MetricSeries => ({
      label,
      unit,
      points: [...m.entries()]
        .sort(([a], [b]) => a - b)
        .map(([timestamp, value]) => ({ timestamp, value })),
    });

    const series: MetricSeries[] = [
      toSeries(classA, "Class A Operations", "requests"),
      toSeries(classB, "Class B Operations", "requests"),
    ];

    if (storage.length > 0) {
      series.push({
        label: "Object Count",
        unit: "objects",
        points: storage.map((g) => ({ timestamp: tsOf(g), value: Number(g.max.objectCount ?? 0) })),
      });
      series.push({
        label: "Stored Bytes",
        unit: "bytes",
        points: storage.map((g) => ({
          timestamp: tsOf(g),
          value: Number(g.max.payloadSize ?? 0) + Number(g.max.metadataSize ?? 0),
        })),
      });
    }

    return series.filter((s) => s.points.some((p) => p.value > 0));
  }

  /**
   * Durable Object namespace metrics via GraphQL
   * `durableObjectsInvocationsAdaptiveGroups` (account-scoped, filter by
   * `namespaceId`). Resource id:
   * `${infrawrenchAccountId}:durable-object-namespace:${namespaceId}`.
   */
  private async fetchDurableObjectMetricSeries(
    resourceId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const namespaceId = resourceId.split(":").pop();
    if (!namespaceId) return [];

    let cfAccountId: string;
    try {
      cfAccountId = await this.api.getAccountId();
    } catch {
      return [];
    }

    const now = Date.now();
    const from = new Date(timeRange?.startMs ?? now - 24 * 3_600_000).toISOString();
    const to = new Date(timeRange?.endMs ?? now).toISOString();

    // Pull from three DO datasets in one query: invocations (requests +
    // response bytes), periodic (CPU time), and storage (stored bytes — the
    // actual on-disk size, the headline number the dashboard shows). Field
    // names below are the ones Cloudflare documents explicitly; other fields
    // (errors, wallTime, websocket counts) exist but need schema introspection
    // to confirm exact spelling, so they're left out to keep the query valid.
    const query = `query D($account: String!, $ns: String!, $from: Time!, $to: Time!) {
      viewer {
        accounts(filter: { accountTag: $account }) {
          durableObjectsInvocationsAdaptiveGroups(
            limit: 1000
            filter: { namespaceId: $ns, datetime_geq: $from, datetime_lt: $to }
            orderBy: [datetime_ASC]
          ) {
            dimensions { datetime }
            sum { requests responseBodySize }
          }
          durableObjectsPeriodicGroups(
            limit: 1000
            filter: { namespaceId: $ns, datetime_geq: $from, datetime_lt: $to }
            orderBy: [datetime_ASC]
          ) {
            dimensions { datetime }
            sum { cpuTime }
          }
          durableObjectsStorageGroups(
            limit: 1000
            filter: { namespaceId: $ns, datetime_geq: $from, datetime_lt: $to }
            orderBy: [datetime_ASC]
          ) {
            dimensions { datetime }
            max { storedBytes }
          }
        }
      }
    }`;

    interface InvGroup {
      dimensions: { datetime: string };
      sum: { requests?: number; responseBodySize?: number };
    }
    interface PeriodicGroup {
      dimensions: { datetime: string };
      sum: { cpuTime?: number };
    }
    interface StorageGroup {
      dimensions: { datetime: string };
      max: { storedBytes?: number };
    }
    interface Resp {
      data?: {
        viewer?: {
          accounts?: Array<{
            durableObjectsInvocationsAdaptiveGroups?: InvGroup[];
            durableObjectsPeriodicGroups?: PeriodicGroup[];
            durableObjectsStorageGroups?: StorageGroup[];
          }>;
        };
      };
    }

    let inv: InvGroup[] = [];
    let periodic: PeriodicGroup[] = [];
    let storage: StorageGroup[] = [];
    try {
      const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.api.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          variables: { account: cfAccountId, ns: namespaceId, from, to },
        }),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as Resp;
      const acc = json.data?.viewer?.accounts?.[0];
      inv = acc?.durableObjectsInvocationsAdaptiveGroups ?? [];
      periodic = acc?.durableObjectsPeriodicGroups ?? [];
      storage = acc?.durableObjectsStorageGroups ?? [];
    } catch {
      return [];
    }

    const tsOf = (g: { dimensions: { datetime: string } }): number =>
      new Date(g.dimensions.datetime).getTime();
    const series: MetricSeries[] = [
      {
        label: "Requests",
        unit: "requests",
        points: inv.map((g) => ({ timestamp: tsOf(g), value: Number(g.sum.requests ?? 0) })),
      },
      {
        label: "Response Body Size",
        unit: "bytes",
        points: inv.map((g) => ({
          timestamp: tsOf(g),
          value: Number(g.sum.responseBodySize ?? 0),
        })),
      },
      {
        label: "CPU Time",
        unit: "μs",
        points: periodic.map((g) => ({ timestamp: tsOf(g), value: Number(g.sum.cpuTime ?? 0) })),
      },
      {
        label: "Stored Bytes",
        unit: "bytes",
        points: storage.map((g) => ({ timestamp: tsOf(g), value: Number(g.max.storedBytes ?? 0) })),
      },
    ];
    return series.filter((s) => s.points.some((p) => p.value > 0));
  }

  /**
   * Turnstile widget metrics via GraphQL `turnstileAdaptiveGroups` (account-
   * scoped, filter by `siteKey`). Returns the challenge volume in fifteen-minute
   * buckets. Resource id:
   * `${infrawrenchAccountId}:turnstile-widget:${siteKey}`.
   */
  private async fetchTurnstileMetricSeries(
    resourceId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const siteKey = resourceId.split(":").pop();
    if (!siteKey) return [];

    let cfAccountId: string;
    try {
      cfAccountId = await this.api.getAccountId();
    } catch {
      return [];
    }

    const now = Date.now();
    const from = new Date(timeRange?.startMs ?? now - 24 * 3_600_000).toISOString();
    const to = new Date(timeRange?.endMs ?? now).toISOString();

    const query = `query T($account: String!, $site: String!, $from: Time!, $to: Time!) {
      viewer {
        accounts(filter: { accountTag: $account }) {
          turnstileAdaptiveGroups(
            limit: 1000
            filter: { siteKey: $site, datetimeFifteenMinutes_geq: $from, datetimeFifteenMinutes_lt: $to }
            orderBy: [datetimeFifteenMinutes_ASC]
          ) {
            count
            dimensions { datetimeFifteenMinutes }
          }
        }
      }
    }`;

    interface Group {
      count?: number;
      dimensions: { datetimeFifteenMinutes: string };
    }
    interface Resp {
      data?: { viewer?: { accounts?: Array<{ turnstileAdaptiveGroups?: Group[] }> } };
    }

    let groups: Group[] = [];
    try {
      const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.api.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          variables: { account: cfAccountId, site: siteKey, from, to },
        }),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as Resp;
      groups = json.data?.viewer?.accounts?.[0]?.turnstileAdaptiveGroups ?? [];
    } catch {
      return [];
    }
    if (groups.length === 0) return [];

    const series: MetricSeries[] = [
      {
        label: "Challenges",
        unit: "challenges",
        points: groups.map((g) => ({
          timestamp: new Date(g.dimensions.datetimeFifteenMinutes).getTime(),
          value: Number(g.count ?? 0),
        })),
      },
    ];
    return series.filter((s) => s.points.some((p) => p.value > 0));
  }

  /**
   * Spectrum application metrics via GraphQL
   * `spectrumNetworkAnalyticsAdaptiveGroups` (zone-scoped, filter by `appID`).
   * Resource id: `${infrawrenchAccountId}:spectrum-application:${zoneId}/${appId}`.
   */
  private async fetchSpectrumMetricSeries(
    resourceId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    // Last colon-segment is "${zoneId}/${appId}"
    const lastSegment = resourceId.split(":").pop();
    if (!lastSegment) return [];
    const slashIdx = lastSegment.indexOf("/");
    if (slashIdx === -1) return [];
    const zoneId = lastSegment.slice(0, slashIdx);
    const appId = lastSegment.slice(slashIdx + 1);
    if (!zoneId || !appId) return [];

    const now = Date.now();
    const from = new Date(timeRange?.startMs ?? now - 24 * 3_600_000).toISOString();
    const to = new Date(timeRange?.endMs ?? now).toISOString();

    const query = `query S($zone: String!, $app: String!, $from: Time!, $to: Time!) {
      viewer {
        zones(filter: { zoneTag: $zone }) {
          spectrumNetworkAnalyticsAdaptiveGroups(
            limit: 1000
            filter: { appID: $app, datetime_geq: $from, datetime_lt: $to }
            orderBy: [datetime_ASC]
          ) {
            dimensions { datetime }
            sum { events bytesIngress bytesEgress connections }
          }
        }
      }
    }`;

    interface Group {
      dimensions: { datetime: string };
      sum: { events?: number; bytesIngress?: number; bytesEgress?: number; connections?: number };
    }
    interface Resp {
      data?: {
        viewer?: { zones?: Array<{ spectrumNetworkAnalyticsAdaptiveGroups?: Group[] }> };
      };
    }

    let groups: Group[] = [];
    try {
      const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.api.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          variables: { zone: zoneId, app: appId, from, to },
        }),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as Resp;
      groups = json.data?.viewer?.zones?.[0]?.spectrumNetworkAnalyticsAdaptiveGroups ?? [];
    } catch {
      return [];
    }
    if (groups.length === 0) return [];

    const tsOf = (g: Group): number => new Date(g.dimensions.datetime).getTime();
    const series: MetricSeries[] = [
      {
        label: "Events",
        unit: "events",
        points: groups.map((g) => ({ timestamp: tsOf(g), value: Number(g.sum.events ?? 0) })),
      },
      {
        label: "Bytes Ingress",
        unit: "bytes",
        points: groups.map((g) => ({
          timestamp: tsOf(g),
          value: Number(g.sum.bytesIngress ?? 0),
        })),
      },
      {
        label: "Bytes Egress",
        unit: "bytes",
        points: groups.map((g) => ({
          timestamp: tsOf(g),
          value: Number(g.sum.bytesEgress ?? 0),
        })),
      },
      {
        label: "Connections",
        unit: "connections",
        points: groups.map((g) => ({
          timestamp: tsOf(g),
          value: Number(g.sum.connections ?? 0),
        })),
      },
    ];
    return series.filter((s) => s.points.some((p) => p.value > 0));
  }

  /**
   * D1 database metrics via GraphQL `d1AnalyticsAdaptiveGroups`. Account-scoped,
   * filter by `databaseId`. Note that D1 analytics is daily-bucketed only — the
   * `date` dimension is the finest granularity, so even short windows roll up
   * to per-day points. Resource id: `${accountId}:d1-database:${uuid}` — the
   * trailing segment is the CF databaseId.
   */
  private async fetchD1MetricSeries(
    resourceId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const databaseId = resourceId.split(":").pop();
    if (!databaseId) return [];

    let cfAccountId: string;
    try {
      cfAccountId = await this.api.getAccountId();
    } catch {
      return [];
    }

    const now = Date.now();
    // D1 uses `date_geq` / `date_leq` with `Date` type (yyyy-mm-dd).
    const toDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
    const start = toDate(timeRange?.startMs ?? now - 7 * 24 * 3_600_000);
    const end = toDate(timeRange?.endMs ?? now);

    const query = `query D($account: String!, $db: string, $start: Date, $end: Date) {
      viewer {
        accounts(filter: { accountTag: $account }) {
          d1AnalyticsAdaptiveGroups(
            limit: 10000
            filter: { databaseId: $db, date_geq: $start, date_leq: $end }
            orderBy: [date_ASC]
          ) {
            dimensions { date }
            sum { readQueries writeQueries rowsRead rowsWritten queryBatchResponseBytes }
            quantiles { queryBatchTimeMsP90 }
          }
        }
      }
    }`;

    interface Group {
      dimensions: { date: string };
      sum: {
        readQueries?: number;
        writeQueries?: number;
        rowsRead?: number;
        rowsWritten?: number;
        queryBatchResponseBytes?: number;
      };
      quantiles: { queryBatchTimeMsP90?: number };
    }
    interface Resp {
      data?: { viewer?: { accounts?: Array<{ d1AnalyticsAdaptiveGroups?: Group[] }> } };
    }

    let groups: Group[] = [];
    try {
      const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.api.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          variables: { account: cfAccountId, db: databaseId, start, end },
        }),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as Resp;
      groups = json.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];
    } catch {
      return [];
    }
    if (groups.length === 0) return [];

    const tsOf = (g: Group): number => new Date(`${g.dimensions.date}T00:00:00Z`).getTime();
    const series: MetricSeries[] = [
      {
        label: "Read Queries",
        unit: "queries",
        points: groups.map((g) => ({ timestamp: tsOf(g), value: Number(g.sum.readQueries ?? 0) })),
      },
      {
        label: "Write Queries",
        unit: "queries",
        points: groups.map((g) => ({ timestamp: tsOf(g), value: Number(g.sum.writeQueries ?? 0) })),
      },
      {
        label: "Rows Read",
        unit: "rows",
        points: groups.map((g) => ({ timestamp: tsOf(g), value: Number(g.sum.rowsRead ?? 0) })),
      },
      {
        label: "Rows Written",
        unit: "rows",
        points: groups.map((g) => ({ timestamp: tsOf(g), value: Number(g.sum.rowsWritten ?? 0) })),
      },
      {
        label: "Response Bytes",
        unit: "bytes",
        points: groups.map((g) => ({
          timestamp: tsOf(g),
          value: Number(g.sum.queryBatchResponseBytes ?? 0),
        })),
      },
      {
        label: "Query Batch Time p90",
        unit: "ms",
        points: groups.map((g) => ({
          timestamp: tsOf(g),
          value: Number(g.quantiles.queryBatchTimeMsP90 ?? 0),
        })),
      },
    ];
    return series.filter((s) => s.points.some((p) => p.value > 0));
  }

  /**
   * KV namespace metrics via GraphQL `kvOperationsAdaptiveGroups` (operation
   * counts per action type) and `kvStorageAdaptiveGroups` (key/byte counts).
   * Account-scoped, filter by `namespaceId`. Daily granularity only.
   * Resource id: `${accountId}:kv-namespace:${namespaceId}`.
   */
  private async fetchKVMetricSeries(
    resourceId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const namespaceId = resourceId.split(":").pop();
    if (!namespaceId) return [];

    let cfAccountId: string;
    try {
      cfAccountId = await this.api.getAccountId();
    } catch {
      return [];
    }

    const now = Date.now();
    const toDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
    const start = toDate(timeRange?.startMs ?? now - 7 * 24 * 3_600_000);
    const end = toDate(timeRange?.endMs ?? now);

    const query = `query K($account: String!, $ns: string, $start: Date, $end: Date) {
      viewer {
        accounts(filter: { accountTag: $account }) {
          kvOperationsAdaptiveGroups(
            limit: 10000
            filter: { namespaceId: $ns, date_geq: $start, date_leq: $end }
            orderBy: [date_ASC]
          ) {
            dimensions { date actionType }
            sum { requests }
          }
          kvStorageAdaptiveGroups(
            limit: 10000
            filter: { namespaceId: $ns, date_geq: $start, date_leq: $end }
            orderBy: [date_ASC]
          ) {
            dimensions { date }
            max { keyCount byteCount }
          }
        }
      }
    }`;

    interface OpsGroup {
      dimensions: { date: string; actionType: string };
      sum: { requests?: number };
    }
    interface StorageGroup {
      dimensions: { date: string };
      max: { keyCount?: number; byteCount?: number };
    }
    interface Resp {
      data?: {
        viewer?: {
          accounts?: Array<{
            kvOperationsAdaptiveGroups?: OpsGroup[];
            kvStorageAdaptiveGroups?: StorageGroup[];
          }>;
        };
      };
    }

    let ops: OpsGroup[] = [];
    let storage: StorageGroup[] = [];
    try {
      const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.api.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          variables: { account: cfAccountId, ns: namespaceId, start, end },
        }),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as Resp;
      const acc = json.data?.viewer?.accounts?.[0];
      ops = acc?.kvOperationsAdaptiveGroups ?? [];
      storage = acc?.kvStorageAdaptiveGroups ?? [];
    } catch {
      return [];
    }

    // Bucket operations by actionType (read/write/delete/list) per day.
    const tsOfDate = (s: { dimensions: { date: string } }): number =>
      new Date(`${s.dimensions.date}T00:00:00Z`).getTime();
    const byAction = new Map<string, Map<number, number>>();
    for (const g of ops) {
      const a = g.dimensions.actionType || "unknown";
      const ts = tsOfDate(g);
      const v = Number(g.sum.requests ?? 0);
      let m = byAction.get(a);
      if (!m) {
        m = new Map();
        byAction.set(a, m);
      }
      m.set(ts, (m.get(ts) ?? 0) + v);
    }

    // Friendly labels keyed by the action types KV emits.
    const ACTION_LABELS: Record<string, string> = {
      read: "Reads",
      write: "Writes",
      delete: "Deletes",
      list: "Lists",
    };

    const series: MetricSeries[] = [];
    for (const [action, m] of byAction) {
      series.push({
        label: ACTION_LABELS[action] ?? `Operations (${action})`,
        unit: "requests",
        points: [...m.entries()]
          .sort(([a], [b]) => a - b)
          .map(([timestamp, value]) => ({ timestamp, value })),
      });
    }

    if (storage.length > 0) {
      series.push({
        label: "Key Count",
        unit: "keys",
        points: storage.map((g) => ({
          timestamp: tsOfDate(g),
          value: Number(g.max.keyCount ?? 0),
        })),
      });
      series.push({
        label: "Stored Bytes",
        unit: "bytes",
        points: storage.map((g) => ({
          timestamp: tsOfDate(g),
          value: Number(g.max.byteCount ?? 0),
        })),
      });
    }

    return series.filter((s) => s.points.some((p) => p.value > 0));
  }

  /**
   * Queue metrics via GraphQL `queueMessageOperationsAdaptiveGroups` (publish/
   * consume counts and bytes) and `queuesBacklogAdaptiveGroups` (backlog
   * messages/bytes). Account-scoped, filter by `queueId`. Resource id:
   * `${accountId}:queue:${queueId}`.
   */
  private async fetchQueueMetricSeries(
    resourceId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const queueId = resourceId.split(":").pop();
    if (!queueId) return [];

    let cfAccountId: string;
    try {
      cfAccountId = await this.api.getAccountId();
    } catch {
      return [];
    }

    const now = Date.now();
    const from = new Date(timeRange?.startMs ?? now - 24 * 3_600_000).toISOString();
    const to = new Date(timeRange?.endMs ?? now).toISOString();
    const windowMs = (timeRange?.endMs ?? now) - (timeRange?.startMs ?? now - 24 * 3_600_000);
    const useHourly = windowMs >= 6 * 3_600_000;
    const timeDim = useHourly ? "datetimeHour" : "datetimeMinute";

    const query = `query Q($account: String!, $queue: string, $from: Time!, $to: Time!) {
      viewer {
        accounts(filter: { accountTag: $account }) {
          queueMessageOperationsAdaptiveGroups(
            limit: 10000
            filter: { queueId: $queue, datetime_geq: $from, datetime_leq: $to }
            orderBy: [${timeDim}_ASC]
          ) {
            count
            sum { bytes }
            dimensions { ${timeDim} actionType }
          }
          queuesBacklogAdaptiveGroups(
            limit: 10000
            filter: { queueId: $queue, datetime_geq: $from, datetime_leq: $to }
            orderBy: [${timeDim}_ASC]
          ) {
            avg { messages bytes }
            dimensions { ${timeDim} }
          }
        }
      }
    }`;

    interface OpsGroup {
      count?: number;
      sum: { bytes?: number };
      dimensions: { datetimeMinute?: string; datetimeHour?: string; actionType: string };
    }
    interface BacklogGroup {
      avg: { messages?: number; bytes?: number };
      dimensions: { datetimeMinute?: string; datetimeHour?: string };
    }
    interface Resp {
      data?: {
        viewer?: {
          accounts?: Array<{
            queueMessageOperationsAdaptiveGroups?: OpsGroup[];
            queuesBacklogAdaptiveGroups?: BacklogGroup[];
          }>;
        };
      };
    }

    let ops: OpsGroup[] = [];
    let backlog: BacklogGroup[] = [];
    try {
      const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.api.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          variables: { account: cfAccountId, queue: queueId, from, to },
        }),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as Resp;
      const acc = json.data?.viewer?.accounts?.[0];
      ops = acc?.queueMessageOperationsAdaptiveGroups ?? [];
      backlog = acc?.queuesBacklogAdaptiveGroups ?? [];
    } catch {
      return [];
    }

    const tsOf = (g: {
      dimensions: { datetimeMinute?: string; datetimeHour?: string };
    }): number => {
      const v = g.dimensions[timeDim as "datetimeHour"] ?? "";
      return new Date(v).getTime();
    };

    // Bucket message ops by actionType. The action axis includes things like
    // WriteMessage, ReadMessage, AckMessage, etc.; collapse them to friendly
    // produce/consume/ack categories so the chart stays readable.
    const PRODUCE = new Set(["WriteMessage", "WriteMessageBatch"]);
    const CONSUME = new Set(["ReadMessage", "ReadMessageBatch"]);
    const ACK = new Set(["AckMessage", "AckMessageBatch"]);
    const RETRY = new Set(["RetryMessage", "RetryMessageBatch"]);
    const produce = new Map<number, number>();
    const consume = new Map<number, number>();
    const ack = new Map<number, number>();
    const retry = new Map<number, number>();
    const other = new Map<number, number>();
    const bytes = new Map<number, number>();
    for (const g of ops) {
      const t = tsOf(g);
      if (Number.isNaN(t)) continue;
      const c = Number(g.count ?? 0);
      const b = Number(g.sum.bytes ?? 0);
      const a = g.dimensions.actionType;
      const bucket = PRODUCE.has(a)
        ? produce
        : CONSUME.has(a)
          ? consume
          : ACK.has(a)
            ? ack
            : RETRY.has(a)
              ? retry
              : other;
      bucket.set(t, (bucket.get(t) ?? 0) + c);
      bytes.set(t, (bytes.get(t) ?? 0) + b);
    }

    const toSeries = (m: Map<number, number>, label: string, unit: string): MetricSeries => ({
      label,
      unit,
      points: [...m.entries()]
        .sort(([a], [b]) => a - b)
        .map(([timestamp, value]) => ({ timestamp, value })),
    });

    const series: MetricSeries[] = [
      toSeries(produce, "Messages Produced", "messages"),
      toSeries(consume, "Messages Consumed", "messages"),
      toSeries(ack, "Messages Acknowledged", "messages"),
      toSeries(retry, "Messages Retried", "messages"),
      toSeries(other, "Other Operations", "operations"),
      toSeries(bytes, "Bytes Transferred", "bytes"),
    ];

    if (backlog.length > 0) {
      series.push({
        label: "Backlog Messages",
        unit: "messages",
        points: backlog.map((g) => ({
          timestamp: tsOf(g),
          value: Number(g.avg.messages ?? 0),
        })),
      });
      series.push({
        label: "Backlog Bytes",
        unit: "bytes",
        points: backlog.map((g) => ({
          timestamp: tsOf(g),
          value: Number(g.avg.bytes ?? 0),
        })),
      });
    }

    return series.filter((s) => s.points.some((p) => p.value > 0));
  }

  /**
   * Hyperdrive metrics via GraphQL `hyperdriveQueriesAdaptiveGroups`. Account
   * scoped, filter by `configId`. Resource id:
   * `${accountId}:hyperdrive:${configId}`.
   */
  private async fetchHyperdriveMetricSeries(
    resourceId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const configId = resourceId.split(":").pop();
    if (!configId) return [];

    let cfAccountId: string;
    try {
      cfAccountId = await this.api.getAccountId();
    } catch {
      return [];
    }

    const now = Date.now();
    const from = new Date(timeRange?.startMs ?? now - 24 * 3_600_000).toISOString();
    const to = new Date(timeRange?.endMs ?? now).toISOString();
    const windowMs = (timeRange?.endMs ?? now) - (timeRange?.startMs ?? now - 24 * 3_600_000);
    const useHourly = windowMs >= 6 * 3_600_000;
    const timeDim = useHourly ? "datetimeHour" : "datetimeMinute";

    const query = `query H($account: String!, $config: string, $from: Time!, $to: Time!) {
      viewer {
        accounts(filter: { accountTag: $account }) {
          hyperdriveQueriesAdaptiveGroups(
            limit: 10000
            filter: { configId: $config, datetime_geq: $from, datetime_leq: $to }
            orderBy: [${timeDim}_ASC]
          ) {
            count
            sum { queryBytes resultBytes }
            avg { queryLatency connectionLatency }
            dimensions { ${timeDim} cacheStatus eventStatus }
          }
        }
      }
    }`;

    interface Group {
      count?: number;
      sum: { queryBytes?: number; resultBytes?: number };
      avg: { queryLatency?: number; connectionLatency?: number };
      dimensions: {
        datetimeMinute?: string;
        datetimeHour?: string;
        cacheStatus: string;
        eventStatus: string;
      };
    }
    interface Resp {
      data?: { viewer?: { accounts?: Array<{ hyperdriveQueriesAdaptiveGroups?: Group[] }> } };
    }

    let groups: Group[] = [];
    try {
      const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.api.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          variables: { account: cfAccountId, config: configId, from, to },
        }),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as Resp;
      groups = json.data?.viewer?.accounts?.[0]?.hyperdriveQueriesAdaptiveGroups ?? [];
    } catch {
      return [];
    }
    if (groups.length === 0) return [];

    const tsOf = (g: Group): number =>
      new Date(g.dimensions[timeDim as "datetimeHour"] ?? "").getTime();

    // Roll up cache hits/misses and errors separately so the user can see
    // cache effectiveness and reliability at a glance.
    const totalQueries = new Map<number, number>();
    const cacheHits = new Map<number, number>();
    const cacheMisses = new Map<number, number>();
    const errors = new Map<number, number>();
    const queryBytes = new Map<number, number>();
    const resultBytes = new Map<number, number>();
    const queryLatencySum = new Map<number, number>();
    const queryLatencyCount = new Map<number, number>();
    const connectionLatencySum = new Map<number, number>();
    const connectionLatencyCount = new Map<number, number>();

    for (const g of groups) {
      const t = tsOf(g);
      if (Number.isNaN(t)) continue;
      const c = Number(g.count ?? 0);
      totalQueries.set(t, (totalQueries.get(t) ?? 0) + c);
      if (g.dimensions.cacheStatus === "hit") {
        cacheHits.set(t, (cacheHits.get(t) ?? 0) + c);
      } else if (g.dimensions.cacheStatus === "miss") {
        cacheMisses.set(t, (cacheMisses.get(t) ?? 0) + c);
      }
      if (g.dimensions.eventStatus === "error") {
        errors.set(t, (errors.get(t) ?? 0) + c);
      }
      queryBytes.set(t, (queryBytes.get(t) ?? 0) + Number(g.sum.queryBytes ?? 0));
      resultBytes.set(t, (resultBytes.get(t) ?? 0) + Number(g.sum.resultBytes ?? 0));
      // Weighted average across groupings: sum (avg × count), divide by total count.
      const ql = Number(g.avg.queryLatency ?? 0);
      const cl = Number(g.avg.connectionLatency ?? 0);
      if (ql > 0) {
        queryLatencySum.set(t, (queryLatencySum.get(t) ?? 0) + ql * c);
        queryLatencyCount.set(t, (queryLatencyCount.get(t) ?? 0) + c);
      }
      if (cl > 0) {
        connectionLatencySum.set(t, (connectionLatencySum.get(t) ?? 0) + cl * c);
        connectionLatencyCount.set(t, (connectionLatencyCount.get(t) ?? 0) + c);
      }
    }

    const toSeries = (m: Map<number, number>, label: string, unit: string): MetricSeries => ({
      label,
      unit,
      points: [...m.entries()]
        .sort(([a], [b]) => a - b)
        .map(([timestamp, value]) => ({ timestamp, value })),
    });

    const avgSeries = (
      sums: Map<number, number>,
      counts: Map<number, number>,
      label: string,
      unit: string,
    ): MetricSeries => ({
      label,
      unit,
      points: [...sums.entries()]
        .sort(([a], [b]) => a - b)
        .map(([timestamp, total]) => {
          const n = counts.get(timestamp) ?? 0;
          return { timestamp, value: n > 0 ? total / n : 0 };
        }),
    });

    const series: MetricSeries[] = [
      toSeries(totalQueries, "Queries", "queries"),
      toSeries(cacheHits, "Cache Hits", "queries"),
      toSeries(cacheMisses, "Cache Misses", "queries"),
      toSeries(errors, "Errors", "queries"),
      toSeries(queryBytes, "Query Bytes", "bytes"),
      toSeries(resultBytes, "Result Bytes", "bytes"),
      avgSeries(queryLatencySum, queryLatencyCount, "Query Latency", "ms"),
      avgSeries(connectionLatencySum, connectionLatencyCount, "Connection Latency", "ms"),
    ];
    return series.filter((s) => s.points.some((p) => p.value > 0));
  }

  /**
   * AI Gateway metrics via GraphQL `aiGatewayRequestsAdaptiveGroups`. Account
   * scoped, filtered by the `gateway` id. Surfaces the same four headline
   * numbers as the Cloudflare dashboard (requests, tokens, cost, errors) plus a
   * cache-hit series. Resource id: `${accountId}:ai-gateway:${gatewayId}`.
   */
  private async fetchAiGatewayMetricSeries(
    resourceId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const gatewayId = resourceId.split(":").slice(2).join(":");
    if (!gatewayId) return [];

    let cfAccountId: string;
    try {
      cfAccountId = await this.api.getAccountId();
    } catch {
      return [];
    }

    const now = Date.now();
    const from = new Date(timeRange?.startMs ?? now - 24 * 3_600_000).toISOString();
    const to = new Date(timeRange?.endMs ?? now).toISOString();

    // The dataset's only documented time dimension is `datetimeHour`.
    const query = `query AIG($account: String!, $gateway: string, $from: Time!, $to: Time!) {
      viewer {
        accounts(filter: { accountTag: $account }) {
          aiGatewayRequestsAdaptiveGroups(
            limit: 10000
            filter: { gateway: $gateway, datetimeHour_geq: $from, datetimeHour_leq: $to }
            orderBy: [datetimeHour_ASC]
          ) {
            count
            sum {
              cost
              cachedRequests
              erroredRequests
              uncachedTokensIn
              uncachedTokensOut
              cachedTokensIn
              cachedTokensOut
            }
            dimensions { datetimeHour }
          }
        }
      }
    }`;

    interface Group {
      count?: number;
      sum: {
        cost?: number;
        cachedRequests?: number;
        erroredRequests?: number;
        uncachedTokensIn?: number;
        uncachedTokensOut?: number;
        cachedTokensIn?: number;
        cachedTokensOut?: number;
      };
      dimensions: { datetimeHour?: string };
    }
    interface Resp {
      data?: { viewer?: { accounts?: Array<{ aiGatewayRequestsAdaptiveGroups?: Group[] }> } };
    }

    let groups: Group[] = [];
    try {
      const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.api.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          variables: { account: cfAccountId, gateway: gatewayId, from, to },
        }),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as Resp;
      groups = json.data?.viewer?.accounts?.[0]?.aiGatewayRequestsAdaptiveGroups ?? [];
    } catch {
      return [];
    }
    if (groups.length === 0) return [];

    const requests = new Map<number, number>();
    const tokensIn = new Map<number, number>();
    const tokensOut = new Map<number, number>();
    const cost = new Map<number, number>();
    const errors = new Map<number, number>();
    const cacheHits = new Map<number, number>();

    for (const g of groups) {
      const t = new Date(g.dimensions.datetimeHour ?? "").getTime();
      if (Number.isNaN(t)) continue;
      requests.set(t, (requests.get(t) ?? 0) + Number(g.count ?? 0));
      tokensIn.set(
        t,
        (tokensIn.get(t) ?? 0) +
          Number(g.sum.uncachedTokensIn ?? 0) +
          Number(g.sum.cachedTokensIn ?? 0),
      );
      tokensOut.set(
        t,
        (tokensOut.get(t) ?? 0) +
          Number(g.sum.uncachedTokensOut ?? 0) +
          Number(g.sum.cachedTokensOut ?? 0),
      );
      cost.set(t, (cost.get(t) ?? 0) + Number(g.sum.cost ?? 0));
      errors.set(t, (errors.get(t) ?? 0) + Number(g.sum.erroredRequests ?? 0));
      cacheHits.set(t, (cacheHits.get(t) ?? 0) + Number(g.sum.cachedRequests ?? 0));
    }

    const toSeries = (m: Map<number, number>, label: string, unit: string): MetricSeries => ({
      label,
      unit,
      points: [...m.entries()]
        .sort(([a], [b]) => a - b)
        .map(([timestamp, value]) => ({ timestamp, value })),
    });

    const series: MetricSeries[] = [
      toSeries(requests, "Requests", "requests"),
      toSeries(tokensIn, "Tokens In", "tokens"),
      toSeries(tokensOut, "Tokens Out", "tokens"),
      toSeries(cost, "Cost", "USD"),
      toSeries(errors, "Errors", "requests"),
      toSeries(cacheHits, "Cache Hits", "requests"),
    ];
    return series.filter((s) => s.points.some((p) => p.value > 0));
  }

  /**
   * Load balancer metrics via GraphQL `loadBalancingRequestsAdaptiveGroups`.
   * Zone-scoped, filtered by `lbName`. The resource id encodes
   * `${zoneId}/${lbUuid}` — but the analytics dataset filters by name, not
   * UUID, so we resolve the name via the SDK first.
   * Resource id: `${accountId}:load-balancer:${zoneId}/${lbUuid}`.
   */
  private async fetchLoadBalancerMetricSeries(
    resourceId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const lastSegment = resourceId.split(":").pop();
    if (!lastSegment) return [];
    const slashIdx = lastSegment.indexOf("/");
    if (slashIdx === -1) return [];
    const zoneId = lastSegment.slice(0, slashIdx);
    const lbUuid = lastSegment.slice(slashIdx + 1);
    if (!zoneId || !lbUuid) return [];

    // The GraphQL filter for loadBalancingRequestsAdaptiveGroups uses lbName
    // (the LB hostname / configured name) rather than UUID. Look it up.
    let lbName = "";
    try {
      const lb = (await this.api.cf.loadBalancers.get(lbUuid, {
        zone_id: zoneId,
      })) as unknown as Record<string, unknown>;
      lbName = String(lb["name"] ?? "");
    } catch {
      return [];
    }
    if (!lbName) return [];

    const now = Date.now();
    const from = new Date(timeRange?.startMs ?? now - 24 * 3_600_000).toISOString();
    const to = new Date(timeRange?.endMs ?? now).toISOString();
    // LB analytics is sampled in fifteen-minute buckets; coarser windows roll
    // up via the same dimension since it is the finest granularity exposed.
    const timeDim = "datetimeFifteenMinutes";

    const query = `query L($zone: String!, $lb: string, $from: Time!, $to: Time!) {
      viewer {
        zones(filter: { zoneTag: $zone }) {
          loadBalancingRequestsAdaptiveGroups(
            limit: 10000
            filter: { lbName: $lb, datetime_geq: $from, datetime_leq: $to }
            orderBy: [${timeDim}_ASC]
          ) {
            count
            dimensions { ${timeDim} selectedPoolName coloCode }
          }
        }
      }
    }`;

    interface Group {
      count?: number;
      dimensions: {
        datetimeFifteenMinutes: string;
        selectedPoolName: string;
        coloCode: string;
      };
    }
    interface Resp {
      data?: { viewer?: { zones?: Array<{ loadBalancingRequestsAdaptiveGroups?: Group[] }> } };
    }

    let groups: Group[] = [];
    try {
      const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.api.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          variables: { zone: zoneId, lb: lbName, from, to },
        }),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as Resp;
      groups = json.data?.viewer?.zones?.[0]?.loadBalancingRequestsAdaptiveGroups ?? [];
    } catch {
      return [];
    }
    if (groups.length === 0) return [];

    const tsOf = (g: Group): number => new Date(g.dimensions.datetimeFifteenMinutes).getTime();

    // Aggregate total requests per bucket, plus per-pool series so the user
    // can see how the LB is distributing traffic.
    const totalReqs = new Map<number, number>();
    const perPool = new Map<string, Map<number, number>>();
    for (const g of groups) {
      const t = tsOf(g);
      if (Number.isNaN(t)) continue;
      const c = Number(g.count ?? 0);
      totalReqs.set(t, (totalReqs.get(t) ?? 0) + c);
      const pool = g.dimensions.selectedPoolName || "unassigned";
      let m = perPool.get(pool);
      if (!m) {
        m = new Map();
        perPool.set(pool, m);
      }
      m.set(t, (m.get(t) ?? 0) + c);
    }

    const toSeries = (m: Map<number, number>, label: string, unit: string): MetricSeries => ({
      label,
      unit,
      points: [...m.entries()]
        .sort(([a], [b]) => a - b)
        .map(([timestamp, value]) => ({ timestamp, value })),
    });

    const series: MetricSeries[] = [toSeries(totalReqs, "Requests", "requests")];
    for (const [pool, m] of perPool) {
      series.push(toSeries(m, `Pool: ${pool}`, "requests"));
    }
    return series.filter((s) => s.points.some((p) => p.value > 0));
  }

  /**
   * Waiting room metrics via GraphQL `waitingRoomAnalyticsAdaptiveGroups`.
   * Zone-scoped, filter by `waitingRoomId`. Resource id:
   * `${accountId}:waiting-room:${zoneId}/${roomId}`.
   */
  private async fetchWaitingRoomMetricSeries(
    resourceId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const lastSegment = resourceId.split(":").pop();
    if (!lastSegment) return [];
    const slashIdx = lastSegment.indexOf("/");
    if (slashIdx === -1) return [];
    const zoneId = lastSegment.slice(0, slashIdx);
    const roomId = lastSegment.slice(slashIdx + 1);
    if (!zoneId || !roomId) return [];

    const now = Date.now();
    const from = new Date(timeRange?.startMs ?? now - 24 * 3_600_000).toISOString();
    const to = new Date(timeRange?.endMs ?? now).toISOString();
    const windowMs = (timeRange?.endMs ?? now) - (timeRange?.startMs ?? now - 24 * 3_600_000);
    // Waiting Room analytics exposes 15-minute and 1-hour buckets.
    const useHourly = windowMs >= 6 * 3_600_000;
    const timeDim = useHourly ? "datetimeHour" : "datetimeFifteenMinutes";

    const query = `query W($zone: String!, $room: string, $from: Time!, $to: Time!) {
      viewer {
        zones(filter: { zoneTag: $zone }) {
          waitingRoomAnalyticsAdaptiveGroups(
            limit: 10000
            filter: { waitingRoomId: $room, datetime_geq: $from, datetime_leq: $to }
            orderBy: [${timeDim}_ASC]
          ) {
            avg { totalActiveUsers totalQueuedUsers newUsersPerMinute }
            avgWeighted { timeOnOriginP50 totalTimeWaitedP90 }
            dimensions { ${timeDim} }
          }
        }
      }
    }`;

    interface Group {
      avg: {
        totalActiveUsers?: number;
        totalQueuedUsers?: number;
        newUsersPerMinute?: number;
      };
      avgWeighted: { timeOnOriginP50?: number; totalTimeWaitedP90?: number };
      dimensions: { datetimeFifteenMinutes?: string; datetimeHour?: string };
    }
    interface Resp {
      data?: { viewer?: { zones?: Array<{ waitingRoomAnalyticsAdaptiveGroups?: Group[] }> } };
    }

    let groups: Group[] = [];
    try {
      const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.api.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          variables: { zone: zoneId, room: roomId, from, to },
        }),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as Resp;
      groups = json.data?.viewer?.zones?.[0]?.waitingRoomAnalyticsAdaptiveGroups ?? [];
    } catch {
      return [];
    }
    if (groups.length === 0) return [];

    const tsOf = (g: Group): number => {
      const v = g.dimensions[timeDim as "datetimeHour"] ?? "";
      return new Date(v).getTime();
    };

    const series: MetricSeries[] = [
      {
        label: "Active Users",
        unit: "users",
        points: groups.map((g) => ({
          timestamp: tsOf(g),
          value: Number(g.avg.totalActiveUsers ?? 0),
        })),
      },
      {
        label: "Queued Users",
        unit: "users",
        points: groups.map((g) => ({
          timestamp: tsOf(g),
          value: Number(g.avg.totalQueuedUsers ?? 0),
        })),
      },
      {
        label: "New Users / Minute",
        unit: "users/min",
        points: groups.map((g) => ({
          timestamp: tsOf(g),
          value: Number(g.avg.newUsersPerMinute ?? 0),
        })),
      },
      {
        label: "Time on Origin p50",
        unit: "seconds",
        points: groups.map((g) => ({
          timestamp: tsOf(g),
          value: Number(g.avgWeighted.timeOnOriginP50 ?? 0),
        })),
      },
      {
        label: "Time Waited p90",
        unit: "seconds",
        points: groups.map((g) => ({
          timestamp: tsOf(g),
          value: Number(g.avgWeighted.totalTimeWaitedP90 ?? 0),
        })),
      },
    ];
    return series.filter((s) => s.points.some((p) => p.value > 0));
  }

  /**
   * Stream a chat completion from a Workers AI text-generation model. Backs
   * the host-rendered "Playground" tab on `workers-ai-model` resources.
   *
   * Hits the OpenAI-compatible endpoint
   * `POST /accounts/{id}/ai/v1/chat/completions` with `stream: true` and
   * parses the SSE response (`data: {json}\n\n` lines, terminated by
   * `data: [DONE]`), accumulating `choices[0].delta.content` and capturing
   * the final `usage` block when present.
   */
  async *streamChatMessage(
    typeId: string,
    resourceId: string,
    _accountId: string,
    messages: ChatMessage[],
    options?: { model?: string },
  ): AsyncGenerator<ChatStreamEvent, void, unknown> {
    if (typeId !== "workers-ai-model" && typeId !== "ai-gateway") {
      yield {
        kind: "error",
        message: `Cloudflare plugin: streamChatMessage not supported for type "${typeId}".`,
      };
      return;
    }

    let cfAccountId: string;
    try {
      cfAccountId = await this.api.getAccountId();
    } catch (err) {
      yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
      return;
    }

    // Pick the model + OpenAI-compatible endpoint per resource type:
    //  - workers-ai-model: model is fixed by the resource (the id tail), called
    //    directly against the account's Workers AI endpoint.
    //  - ai-gateway: model comes from the playground's picker, routed through
    //    the gateway's `workers-ai` provider so the call lands in the gateway's
    //    logs/analytics. Auth is the same Cloudflare token (no provider key).
    let model: string;
    let endpoint: string;
    if (typeId === "workers-ai-model") {
      // Resource id: `${infrawrenchAccountId}:workers-ai-model:${@cf/...}`. The
      // model name contains slashes but no colons, so everything after the
      // second colon is the model name.
      model = resourceId.split(":").slice(2).join(":");
      if (!model) {
        yield { kind: "error", message: "Couldn't determine the Workers AI model name." };
        return;
      }
      endpoint = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/v1/chat/completions`;
    } else {
      const gatewayId = resourceId.split(":").slice(2).join(":");
      model = options?.model ?? "";
      if (!gatewayId) {
        yield { kind: "error", message: "Couldn't determine the AI Gateway id." };
        return;
      }
      if (!model) {
        yield { kind: "error", message: "Pick a Workers AI model to chat through this gateway." };
        return;
      }
      endpoint = `https://gateway.ai.cloudflare.com/v1/${cfAccountId}/${gatewayId}/workers-ai/v1/chat/completions`;
    }

    const body = JSON.stringify({
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    });

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.api.apiToken}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body,
      });
    } catch (err) {
      yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
      return;
    }

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => "");
      yield {
        kind: "error",
        message: `Chat endpoint returned ${res.status}: ${errText || res.statusText}`,
      };
      return;
    }

    // Parse SSE chunks. OpenAI-compatible stream format is `data: {json}\n\n`
    // lines until `data: [DONE]`. Accumulate `choices[0].delta.content` so we
    // can hand the host the full message in the terminal `done` event.
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buffer = "";
    let assembled = "";
    let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
              usage?: {
                prompt_tokens?: number;
                completion_tokens?: number;
                total_tokens?: number;
              };
            };
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              assembled += delta;
              yield { kind: "delta", text: delta };
            }
            if (parsed.usage) {
              usage = {};
              if (parsed.usage.prompt_tokens !== undefined) {
                usage.inputTokens = parsed.usage.prompt_tokens;
              }
              if (parsed.usage.completion_tokens !== undefined) {
                usage.outputTokens = parsed.usage.completion_tokens;
              }
              if (parsed.usage.total_tokens !== undefined) {
                usage.totalTokens = parsed.usage.total_tokens;
              }
            }
          } catch {
            // Malformed SSE chunk — skip rather than abort the whole stream.
          }
        }
      }
    } catch (err) {
      yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
      return;
    }

    yield {
      kind: "done",
      message: { role: "assistant", content: assembled },
      ...(usage ? { usage } : {}),
    };
  }

  /** List DNS records for a specific zone */
  async listDnsRecordsForZone(zoneId: string, accountId: string): Promise<ResourceInstance[]> {
    return dnsRecordApi.listDnsRecordsForZone(this.api, zoneId, accountId);
  }
}
