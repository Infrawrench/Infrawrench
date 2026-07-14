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
import { getCreateConfig as getCreateConfigImpl } from "./create-configs.js";
import { fetchMetricSeries as fetchMetricSeriesImpl } from "./metric-series.js";
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

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    return getCreateConfigImpl(this.api, typeId, parentResourceId);
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
   * zone-level cache purge and DNSSEC toggles.
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
    if (typeId === "zone" && actionId === "dnssec-enable") {
      return withCloudflareErrors(() => zoneApi.setDnssec(this.api, externalId, true));
    }
    if (typeId === "zone" && actionId === "dnssec-disable") {
      return withCloudflareErrors(() => zoneApi.setDnssec(this.api, externalId, false));
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
    return fetchMetricSeriesImpl(this.api, resourceTypeId, resourceId, _accountId, timeRange);
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

    // Both resource types call the account's OpenAI-compatible Workers AI
    // endpoint with the Cloudflare API token. They differ in where the model
    // comes from and whether the request is routed through a gateway:
    //  - workers-ai-model: model is fixed by the resource (the id tail).
    //  - ai-gateway: model comes from the playground's picker, and we add the
    //    `cf-aig-gateway-id` header so Cloudflare routes the call through this
    //    gateway (filling its logs/analytics). This is Cloudflare's documented
    //    way to send Workers AI through a gateway — NOT a gateway.ai.cloudflare
    //    .com URL, which needs separate per-gateway auth.
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/v1/chat/completions`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.api.apiToken}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    let model: string;
    if (typeId === "workers-ai-model") {
      // Resource id: `${infrawrenchAccountId}:workers-ai-model:${@cf/...}`. The
      // model name contains slashes but no colons, so everything after the
      // second colon is the model name.
      model = resourceId.split(":").slice(2).join(":");
      if (!model) {
        yield { kind: "error", message: "Couldn't determine the Workers AI model name." };
        return;
      }
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
      headers["cf-aig-gateway-id"] = gatewayId;
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
        headers,
        body,
      });
    } catch (err) {
      yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
      return;
    }

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => "");
      // A 401/403 (or Cloudflare's catch-all auth code 10000 / per-resource
      // 9109) on the Workers AI endpoint means the token can't run models —
      // almost always a missing Workers AI scope rather than a bad request.
      const isAuth =
        res.status === 401 ||
        res.status === 403 ||
        /"code":\s*(10000|9109)|Authentication error/i.test(errText);
      yield {
        kind: "error",
        message: isAuth
          ? "Workers AI rejected this request (Authentication error). This account's Cloudflare API token needs the Account · Workers AI:Read permission to run models. Add it in Cloudflare → My Profile → API Tokens (edit the token, add Account · Workers AI:Read, save) and try again."
          : `Chat endpoint returned ${res.status}: ${errText || res.statusText}`,
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
