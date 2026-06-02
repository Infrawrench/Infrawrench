import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { CloudflareClient } from "./client.js";
import { ZoneResourceType } from "./resources/zone.js";
import { DnsRecordResourceType } from "./resources/dns-record.js";
import { WorkerResourceType } from "./resources/worker.js";
import { R2BucketResourceType } from "./resources/r2-bucket.js";
import { KVNamespaceResourceType } from "./resources/kv-namespace.js";
import { D1DatabaseResourceType } from "./resources/d1-database.js";
import { QueueResourceType } from "./resources/queue.js";
import { TunnelResourceType } from "./resources/tunnel.js";
import { SSLCertificateResourceType } from "./resources/ssl-certificate.js";
import { PageRuleResourceType } from "./resources/page-rule.js";
import { FirewallRuleResourceType } from "./resources/firewall-rule.js";
import { AccessApplicationResourceType } from "./resources/access-application.js";
import { AccessPolicyResourceType } from "./resources/access-policy.js";
import { LoadBalancerResourceType } from "./resources/load-balancer.js";
import { WorkerRouteResourceType } from "./resources/worker-route.js";
import { CustomHostnameResourceType } from "./resources/custom-hostname.js";
import { HyperdriveResourceType } from "./resources/hyperdrive.js";
import { EmailRoutingRuleResourceType } from "./resources/email-routing-rule.js";
import { WaitingRoomResourceType } from "./resources/waiting-room.js";
import { SpectrumApplicationResourceType } from "./resources/spectrum-application.js";
import { LogpushJobResourceType } from "./resources/logpush-job.js";
import { WorkersAiModelResourceType } from "./resources/workers-ai-model.js";
import { RateLimitRuleResourceType } from "./resources/rate-limit-rule.js";
import { RedirectRuleResourceType } from "./resources/redirect-rule.js";
import { CacheRuleResourceType } from "./resources/cache-rule.js";
import { IpAccessRuleResourceType } from "./resources/ip-access-rule.js";
import { TurnstileWidgetResourceType } from "./resources/turnstile-widget.js";
import { HealthcheckResourceType } from "./resources/healthcheck.js";
import { NotificationPolicyResourceType } from "./resources/notification-policy.js";
import { VectorizeIndexResourceType } from "./resources/vectorize-index.js";
import { AiGatewayResourceType } from "./resources/ai-gateway.js";
import { AiSearchResourceType } from "./resources/ai-search.js";
import { DurableObjectNamespaceResourceType } from "./resources/durable-object-namespace.js";

// Deep link to Cloudflare's "Create Token" page (user/profile tokens) with the
// scopes this plugin uses pre-selected. Format per Cloudflare's token-template
// docs: the profile token page plus a URL-encoded `permissionGroupKeys` JSON
// array of { key, type }. `accountId=*` / `zoneId=all` apply the token to every
// account and zone. Edit covers the resources the plugin can create/delete;
// analytics is read-only (zone/Workers metrics).
const CREATE_TOKEN_SCOPES = [
  { key: "zone", type: "edit" },
  { key: "zone_settings", type: "edit" },
  { key: "dns", type: "edit" },
  { key: "ssl_and_certificates", type: "edit" },
  { key: "page_rules", type: "edit" },
  { key: "load_balancers", type: "edit" },
  { key: "access", type: "edit" },
  { key: "workers_scripts", type: "edit" },
  { key: "workers_ai", type: "read" },
  { key: "workers_kv_storage", type: "edit" },
  { key: "workers_r2", type: "edit" },
  { key: "workers_routes", type: "edit" },
  { key: "d1", type: "edit" },
  { key: "queues", type: "edit" },
  { key: "hyperdrive", type: "edit" },
  { key: "pages", type: "edit" },
  { key: "argotunnel", type: "edit" },
  { key: "waiting_rooms", type: "edit" },
  { key: "firewall_services", type: "edit" },
  { key: "spectrum", type: "edit" },
  { key: "logs", type: "edit" },
  { key: "cache_purge", type: "purge" },
  { key: "cache_settings", type: "edit" },
  { key: "transform_rules", type: "edit" },
  { key: "health_checks", type: "edit" },
  { key: "turnstile", type: "edit" },
  { key: "notifications", type: "edit" },
  { key: "vectorize", type: "edit" },
  { key: "ai_gateway", type: "edit" },
  { key: "autorag", type: "edit" },
  { key: "analytics", type: "read" },
];

const CREATE_TOKEN_URL = `https://dash.cloudflare.com/profile/api-tokens?${new URLSearchParams({
  permissionGroupKeys: JSON.stringify(CREATE_TOKEN_SCOPES),
  accountId: "*",
  zoneId: "all",
  name: "Infrawrench",
}).toString()}`;

const manifest: PluginManifest = {
  id: "cloudflare",
  version: "0.3.0",
  displayName: "Cloudflare",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#F6821F"/>
    <g transform="translate(10,20) scale(3.33)" fill="white">
      <path d="M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiToken",
      label: "API Token",
      description:
        "A Cloudflare API token. Use the link below to open Cloudflare's token creator with the recommended scopes pre-filled, then paste the generated token here.",
      sensitive: true,
      placeholder: "Scoped API token...",
      helpLink: {
        label: "Create a token with these scopes",
        url: CREATE_TOKEN_URL,
      },
    },
  ],
  rateLimit: { capacity: 80, refillPerSecond: 6 },
};

const resourceTypes: ResourceTypeDefinition[] = [
  ZoneResourceType,
  DnsRecordResourceType,
  WorkerResourceType,
  R2BucketResourceType,
  KVNamespaceResourceType,
  D1DatabaseResourceType,
  QueueResourceType,
  TunnelResourceType,
  SSLCertificateResourceType,
  PageRuleResourceType,
  FirewallRuleResourceType,
  AccessApplicationResourceType,
  AccessPolicyResourceType,
  LoadBalancerResourceType,
  WorkerRouteResourceType,
  CustomHostnameResourceType,
  HyperdriveResourceType,
  EmailRoutingRuleResourceType,
  WaitingRoomResourceType,
  SpectrumApplicationResourceType,
  LogpushJobResourceType,
  WorkersAiModelResourceType,
  RateLimitRuleResourceType,
  RedirectRuleResourceType,
  CacheRuleResourceType,
  IpAccessRuleResourceType,
  TurnstileWidgetResourceType,
  HealthcheckResourceType,
  NotificationPolicyResourceType,
  VectorizeIndexResourceType,
  AiGatewayResourceType,
  AiSearchResourceType,
  DurableObjectNamespaceResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials) => new CloudflareClient(credentials, resourceTypes),
};
