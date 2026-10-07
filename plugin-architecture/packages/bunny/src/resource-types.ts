import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";
import { DNS_RECORD_TYPES, EDGE_ACTIONS, MATCH_TYPES, TRIGGER_TYPES } from "./types.js";

const ro = { required: false, editable: false } as const;

export const AccountResourceType = rt({
  id: "account",
  name: "Account",
  description:
    "The bunny.net account: prepaid balance, this month's charges by product, and account-wide traffic.",
  fields: [
    f("balance", "Balance (USD)", { kind: "number", ...ro }),
    f("thisMonthCharges", "This Month's Charges (USD)", { kind: "number", ...ro }),
    f("couponBalance", "Coupon Balance (USD)", { kind: "number", ...ro }),
    f("pullZoneCount", "Pull Zones", { kind: "number", ...ro }),
    f("storageZoneCount", "Storage Zones", { kind: "number", ...ro }),
    f("dnsZoneCount", "DNS Zones", { kind: "number", ...ro }),
    f("chargesBreakdown", "Charges This Month (JSON)", ro),
  ],
  outputs: [],
  supportsMetrics: true,
  supportsDelete: false,
  iconKey: "account",
});

export const PullZoneResourceType = rt({
  id: "pull-zone",
  name: "Pull Zone",
  description:
    "A CDN pull zone. Purge its cache, manage hostnames and SSL, edge rules, caching, security and geo settings, and chart bandwidth, requests, cache hit rate and errors.",
  fields: [
    f("name", "Name", { editable: false }),
    f("originType", "Origin Type", { ...ro }),
    f("originUrl", "Origin URL", {
      required: false,
      description: "The origin bunny.net fetches from (for a URL origin).",
    }),
    f("storageZoneId", "Storage Zone ID", ro),
    f("type", "Tier", { ...ro }),
    f("enabled", "Enabled", { kind: "boolean", ...ro }),
    f("suspended", "Suspended", { kind: "boolean", ...ro }),
    f("cdnHostname", "CDN Hostname", ro),
    f("hostnames", "Hostnames", ro),
    f("monthlyBandwidthUsed", "Bandwidth This Month (bytes)", { kind: "number", ...ro }),
    f("monthlyCharges", "Charges This Month (USD)", { kind: "number", ...ro }),
    f("monthlyBandwidthLimit", "Monthly Bandwidth Limit (bytes)", {
      kind: "number",
      required: false,
      description: "0 for unlimited.",
    }),
    f("cacheMaxAgeOverride", "Cache Expiration Override (seconds)", {
      kind: "number",
      required: false,
      description: "-1 respects the origin's Cache-Control; 0 disables caching.",
    }),
    f("browserMaxAgeOverride", "Browser Cache Override (seconds)", {
      kind: "number",
      required: false,
      description: "-1 matches the server cache time.",
    }),
    f("ignoreQueryStrings", "Ignore Query Strings", { kind: "boolean", required: false }),
    f("smartCache", "Smart Cache", { kind: "boolean", required: false }),
    f("originShield", "Origin Shield", { kind: "boolean", required: false }),
    f("logging", "Logging", { kind: "boolean", required: false }),
    f("optimizer", "Bunny Optimizer", { kind: "boolean", required: false }),
    f("verifyOriginSsl", "Verify Origin SSL", { kind: "boolean", required: false }),
    f("originHostHeader", "Origin Host Header", { required: false }),
    f("tokenAuthentication", "Token Authentication", { kind: "boolean", required: false }),
    f("blockedCountries", "Blocked Countries", {
      required: false,
      description: "Comma-separated ISO country codes.",
    }),
    f("allowedReferrers", "Allowed Referrers", {
      required: false,
      description: "Comma-separated hostnames; empty allows any.",
    }),
    f("blockedIps", "Blocked IPs", {
      required: false,
      description: "Comma-separated IP addresses.",
    }),
    f("geoUS", "Serve North America", { kind: "boolean", required: false }),
    f("geoEU", "Serve Europe", { kind: "boolean", required: false }),
    f("geoASIA", "Serve Asia and Oceania", { kind: "boolean", required: false }),
    f("geoSA", "Serve South America", { kind: "boolean", required: false }),
    f("geoAF", "Serve Middle East and Africa", { kind: "boolean", required: false }),
    f("edgeRulesJson", "Edge Rules (JSON)", ro),
    f("originJson", "Origin (JSON)", ro),
  ],
  outputs: [
    o("cdnHostname", "CDN Hostname"),
    o("cdnUrl", "CDN URL"),
    o("tokenKey", "Token Authentication Key", { sensitive: true }),
  ],
  dependsOn: [{ fieldKey: "storageZoneId", targetTypeId: "storage-zone", label: "pulls from" }],
  dnsServiceHosts: [
    {
      id: "bunny-pull-zone",
      label: "bunny.net pull zone hostname",
      hostPattern: "([a-z0-9][a-z0-9-]*)\\.b-cdn\\.net",
      hostKeys: ["cdnHostname"],
      reason:
        "Pull zone names are global, so whoever creates a pull zone with this name serves content on this hostname.",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "cdn",
});

export const HostnameResourceType = rt({
  id: "hostname",
  name: "Hostname",
  description: "A hostname a pull zone answers on, with its SSL certificate and Force SSL setting.",
  parentTypeId: "pull-zone",
  fields: [
    f("pullZoneId", "Pull Zone ID", { editable: false }),
    f("hostname", "Hostname", { editable: false }),
    f("forceSsl", "Force SSL", { kind: "boolean", required: false }),
    f("hasCertificate", "Has Certificate", { kind: "boolean", ...ro }),
    f("isSystem", "bunny.net Hostname", { kind: "boolean", ...ro }),
  ],
  outputs: [o("url", "URL")],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  dependsOn: [{ fieldKey: "pullZoneId", targetTypeId: "pull-zone", label: "served by" }],
  iconKey: "globe",
});

export const EdgeRuleResourceType = rt({
  id: "edge-rule",
  name: "Edge Rule",
  description:
    "A pull zone edge rule: when its triggers match, bunny.net applies its action at the edge.",
  parentTypeId: "pull-zone",
  fields: [
    f("pullZoneId", "Pull Zone ID", { editable: false }),
    f("description", "Description", { required: false }),
    f("enabled", "Enabled", { kind: "boolean", required: false }),
    f("action", "Action", { kind: "enum", enumValues: [...EDGE_ACTIONS] }),
    f("actionParameter1", "Action Parameter 1", {
      required: false,
      description:
        "The redirect URL, header name, cache time, status code… depending on the action.",
    }),
    f("actionParameter2", "Action Parameter 2", {
      required: false,
      description: "The header value, for header actions.",
    }),
    f("triggerType", "Trigger", { kind: "enum", enumValues: [...TRIGGER_TYPES], required: false }),
    f("triggerPatterns", "Trigger Patterns", {
      required: false,
      description: "Comma-separated; * wildcards, e.g. */images/*.",
    }),
    f("triggerParameter", "Trigger Parameter", {
      required: false,
      description: "The header or cookie name for header and cookie triggers.",
    }),
    f("matchType", "Trigger Matching", {
      kind: "enum",
      enumValues: [...MATCH_TYPES],
      required: false,
    }),
    f("triggerCount", "Triggers", { kind: "number", ...ro }),
    f("ruleJson", "Rule (JSON)", ro),
  ],
  outputs: [],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  dependsOn: [{ fieldKey: "pullZoneId", targetTypeId: "pull-zone", label: "runs on" }],
  iconKey: "rule",
});

export const StorageZoneResourceType = rt({
  id: "storage-zone",
  name: "Storage Zone",
  description:
    "Edge Storage. Browse, upload and delete files, add replication regions, set 404 handling, and chart storage used and file count.",
  fields: [
    f("name", "Name", { editable: false }),
    f("region", "Main Region", { editable: false }),
    f("replicationRegions", "Replication Regions", {
      required: false,
      description: "Comma-separated region codes. Regions can be added but not removed.",
    }),
    f("tier", "Tier", ro),
    f("storageUsed", "Storage Used (bytes)", { kind: "number", ...ro }),
    f("filesStored", "Files", { kind: "number", ...ro }),
    f("storageHostname", "Storage API Hostname", ro),
    f("s3Hostname", "S3 Hostname", ro),
    f("pullZones", "Connected Pull Zones", ro),
    f("rewrite404To200", "Rewrite 404 to 200", { kind: "boolean", required: false }),
    f("custom404FilePath", "Custom 404 File", {
      required: false,
      description: "Path of the file served for missing files, e.g. /404.html.",
    }),
    f("dateModified", "Modified", ro),
  ],
  outputs: [
    o("storageHostname", "Storage API Hostname"),
    o("password", "Password (FTP and API)", { sensitive: true }),
    o("readOnlyPassword", "Read-Only Password", { sensitive: true }),
    o("ftpUsername", "FTP Username"),
  ],
  secretExportTemplates: [
    {
      id: "storage-api",
      displayName: "Storage API",
      entries: [
        { envKey: "BUNNY_STORAGE_ZONE", outputKey: "ftpUsername" },
        { envKey: "BUNNY_STORAGE_HOST", outputKey: "storageHostname" },
        { envKey: "BUNNY_STORAGE_PASSWORD", outputKey: "password" },
      ],
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsStorageBrowser: true,
  supportsMetrics: true,
  iconKey: "bucket",
});

export const DnsZoneResourceType = rt({
  id: "dns-zone",
  name: "DNS Zone",
  description:
    "A bunny DNS zone with its records, nameserver status, DNSSEC, logging and query statistics.",
  fields: [
    f("name", "Domain", { editable: false }),
    f("nameserversDetected", "Nameservers Detected", { kind: "boolean", ...ro }),
    f("nameserver1", "Nameserver 1", ro),
    f("nameserver2", "Nameserver 2", ro),
    f("soaEmail", "SOA Email", { required: false }),
    f("logging", "Query Logging", { kind: "boolean", required: false }),
    f("dnssec", "DNSSEC", { kind: "boolean", required: false }),
    f("recordCount", "Records", { kind: "number", ...ro }),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("nameservers", "Nameservers")],
  dnsRole: { role: "zone", recordCountKey: "recordCount" },
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "dns",
});

export const DnsRecordResourceType = rt({
  id: "dns-record",
  name: "DNS Record",
  description: "A record in a bunny DNS zone.",
  parentTypeId: "dns-zone",
  fields: [
    f("zoneId", "Zone ID", { editable: false }),
    f("zoneName", "Zone", { ...ro }),
    f("type", "Type", { kind: "enum", enumValues: [...DNS_RECORD_TYPES], editable: false }),
    f("name", "Name", {
      required: false,
      description: "Relative to the zone; empty for the apex.",
    }),
    f("content", "Value", { required: false }),
    f("ttl", "TTL (seconds)", { kind: "number", required: false }),
    f("priority", "Priority", { kind: "number", required: false }),
    f("weight", "Weight", { kind: "number", required: false }),
    f("port", "Port", { kind: "number", required: false }),
    f("disabled", "Disabled", { kind: "boolean", required: false }),
    f("accelerated", "Accelerated (via CDN)", { kind: "boolean", required: false }),
    f("comment", "Comment", { required: false }),
  ],
  outputs: [],
  dnsRole: { role: "record", zoneKey: "zoneId" },
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "dns",
});

export const VideoLibraryResourceType = rt({
  id: "video-library",
  name: "Stream Library",
  description:
    "A bunny Stream video library: videos, storage and traffic, player and encoding settings, and its API key.",
  fields: [
    f("name", "Name", { required: false }),
    f("videoCount", "Videos", { kind: "number", ...ro }),
    f("storageUsage", "Storage (bytes)", { kind: "number", ...ro }),
    f("trafficUsage", "Traffic (bytes)", { kind: "number", ...ro }),
    f("replicationRegions", "Replication Regions", ro),
    f("pullZoneId", "Pull Zone ID", ro),
    f("storageZoneId", "Storage Zone ID", ro),
    f("resolutions", "Enabled Resolutions", {
      required: false,
      description: "Comma-separated, e.g. 240p,360p,720p,1080p.",
    }),
    f("webhookUrl", "Webhook URL", { required: false }),
    f("mp4Fallback", "MP4 Fallback", { kind: "boolean", required: false }),
    f("keepOriginals", "Keep Original Files", { kind: "boolean", required: false }),
    f("directPlay", "Direct Play", { kind: "boolean", required: false }),
    f("transcribing", "Automatic Transcribing", { kind: "boolean", required: false }),
    f("tokenAuthentication", "Token Authentication", { kind: "boolean", required: false }),
    f("blockNoReferrer", "Block Direct URL Access", { kind: "boolean", required: false }),
    f("drm", "DRM", { kind: "boolean", ...ro }),
    f("createdAt", "Created", ro),
  ],
  outputs: [
    o("libraryId", "Library ID"),
    o("apiKey", "API Key", { sensitive: true }),
    o("readOnlyApiKey", "Read-Only API Key", { sensitive: true }),
  ],
  dependsOn: [
    { fieldKey: "pullZoneId", targetTypeId: "pull-zone", label: "delivered by" },
    { fieldKey: "storageZoneId", targetTypeId: "storage-zone", label: "stored in" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "video",
});

export const EdgeScriptResourceType = rt({
  id: "edge-script",
  name: "Edge Script",
  description:
    "An Edge Scripting script (standalone, middleware or DNS): linked pull zones, monthly requests, CPU time and cost.",
  fields: [
    f("name", "Name", { required: false }),
    f("scriptType", "Type", ro),
    f("defaultHostname", "Hostname", ro),
    f("linkedPullZones", "Linked Pull Zones", ro),
    f("currentReleaseId", "Current Release", { kind: "number", ...ro }),
    f("monthlyRequests", "Requests This Month", { kind: "number", ...ro }),
    f("monthlyCpuTime", "CPU Time This Month (ms)", { kind: "number", ...ro }),
    f("monthlyCost", "Cost This Month (USD)", { kind: "number", ...ro }),
    f("lastModified", "Modified", ro),
  ],
  outputs: [o("url", "URL")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "function",
});

export const ContainerAppResourceType = rt({
  id: "container-app",
  name: "Magic Containers App",
  description:
    "A Magic Containers application: status, endpoint, regions, containers and autoscaling, with restart, deploy and undeploy.",
  fields: [
    f("name", "Name", { editable: false }),
    f("status", "Status", ro),
    f("runtimeType", "Runtime", ro),
    f("endpoint", "Endpoint", ro),
    f("images", "Images", ro),
    f("instances", "Instances", { kind: "number", ...ro }),
    f("regions", "Allowed Regions", ro),
    f("minInstances", "Min Instances", { kind: "number", required: false }),
    f("maxInstances", "Max Instances", { kind: "number", required: false }),
  ],
  outputs: [o("endpoint", "Endpoint")],
  supportsUpdate: true,
  supportsMetrics: true,
  lifecycle: {
    startActionId: "deploy",
    stopActionId: "undeploy",
    statusFieldKey: "status",
    runningValues: ["active", "progressing"],
    stoppedValues: ["inactive"],
  },
  iconKey: "container",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  AccountResourceType,
  PullZoneResourceType,
  HostnameResourceType,
  EdgeRuleResourceType,
  StorageZoneResourceType,
  DnsZoneResourceType,
  DnsRecordResourceType,
  VideoLibraryResourceType,
  EdgeScriptResourceType,
  ContainerAppResourceType,
];
