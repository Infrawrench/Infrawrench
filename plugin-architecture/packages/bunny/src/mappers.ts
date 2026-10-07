import type { ResourceInstance } from "@infrawrench/plugin-base";
import type {
  ContainerApp,
  DnsRecord,
  DnsZone,
  EdgeRule,
  EdgeScript,
  Hostname,
  PullZone,
  StorageZone,
  VideoLibrary,
} from "./types.js";
import {
  DNS_RECORD_TYPES,
  EDGE_ACTIONS,
  MATCH_TYPES,
  ORIGIN_TYPES,
  PULL_ZONE_TYPES,
  SCRIPT_TYPES,
  TRIGGER_TYPES,
  ZONE_TIERS,
  enumName,
} from "./types.js";

export const PLUGIN_ID = "bunny";
type Fields = Record<string, string | number | boolean>;

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Fields,
  parent?: { typeId: string; externalId: string },
): ResourceInstance {
  const now = new Date().toISOString();
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName,
    fields,
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    ...(parent ? { parentResourceId: `${accountId}:${parent.typeId}:${parent.externalId}` } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

export function splitChild(externalId: string): { parent: string; key: string } {
  const i = externalId.indexOf("/");
  return i < 0
    ? { parent: externalId, key: "" }
    : { parent: externalId.slice(0, i), key: externalId.slice(i + 1) };
}

export function splitList(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

export function systemHostname(z: PullZone): string {
  return (
    z.Hostnames?.find((h) => h.IsSystemHostname)?.Value ?? (z.Name ? `${z.Name}.b-cdn.net` : "")
  );
}

export function pullZoneInstance(accountId: string, z: PullZone): ResourceInstance {
  const fields: Fields = {
    name: z.Name,
    originType: enumName(ORIGIN_TYPES, z.OriginType),
    originUrl: z.OriginUrl ?? "",
    type: enumName(PULL_ZONE_TYPES, z.Type),
    enabled: z.Enabled !== false,
    suspended: z.Suspended === true,
    cdnHostname: systemHostname(z),
    hostnames: (z.Hostnames ?? []).map((h) => h.Value).join(", "),
    monthlyBandwidthUsed: z.MonthlyBandwidthUsed ?? 0,
    monthlyCharges: z.MonthlyCharges ?? 0,
    monthlyBandwidthLimit: z.MonthlyBandwidthLimit ?? 0,
    ignoreQueryStrings: z.IgnoreQueryStrings === true,
    smartCache: z.EnableSmartCache === true,
    originShield: z.EnableOriginShield === true,
    logging: z.EnableLogging === true,
    optimizer: z.OptimizerEnabled === true,
    verifyOriginSsl: z.VerifyOriginSSL === true,
    originHostHeader: z.OriginHostHeader ?? "",
    tokenAuthentication: z.ZoneSecurityEnabled === true,
    blockedCountries: (z.BlockedCountries ?? []).join(", "),
    allowedReferrers: (z.AllowedReferrers ?? []).join(", "),
    blockedIps: (z.BlockedIps ?? []).join(", "),
    geoUS: z.EnableGeoZoneUS !== false,
    geoEU: z.EnableGeoZoneEU !== false,
    geoASIA: z.EnableGeoZoneASIA !== false,
    geoSA: z.EnableGeoZoneSA !== false,
    geoAF: z.EnableGeoZoneAF !== false,
    edgeRulesJson: JSON.stringify((z.EdgeRules ?? []).filter((r) => !r.ReadOnly)),
    originJson: JSON.stringify({
      type: enumName(ORIGIN_TYPES, z.OriginType),
      url: z.OriginUrl ?? "",
      storageZoneId: z.StorageZoneId ?? 0,
      edgeScriptId: z.EdgeScriptId ?? 0,
      containerAppId: z.MagicContainersAppId ?? "",
    }),
  };
  if (typeof z.CacheControlMaxAgeOverride === "number")
    fields["cacheMaxAgeOverride"] = z.CacheControlMaxAgeOverride;
  if (typeof z.CacheControlPublicMaxAgeOverride === "number")
    fields["browserMaxAgeOverride"] = z.CacheControlPublicMaxAgeOverride;
  if (z.StorageZoneId && z.StorageZoneId > 0) fields["storageZoneId"] = String(z.StorageZoneId);
  return instance(accountId, "pull-zone", String(z.Id), z.Name, fields);
}

export function hostnameInstance(accountId: string, zoneId: number, h: Hostname): ResourceInstance {
  return instance(
    accountId,
    "hostname",
    `${zoneId}/${h.Value}`,
    h.Value,
    {
      pullZoneId: String(zoneId),
      hostname: h.Value,
      forceSsl: h.ForceSSL === true,
      hasCertificate: h.HasCertificate === true,
      isSystem: h.IsSystemHostname === true,
    },
    { typeId: "pull-zone", externalId: String(zoneId) },
  );
}

export function edgeRuleInstance(accountId: string, zoneId: number, r: EdgeRule): ResourceInstance {
  const first = r.Triggers?.[0];
  const action = enumName(EDGE_ACTIONS, r.ActionType);
  return instance(
    accountId,
    "edge-rule",
    `${zoneId}/${r.Guid}`,
    r.Description || action || r.Guid,
    {
      pullZoneId: String(zoneId),
      description: r.Description ?? "",
      enabled: r.Enabled !== false,
      action,
      actionParameter1: r.ActionParameter1 ?? "",
      actionParameter2: r.ActionParameter2 ?? "",
      triggerType: first ? enumName(TRIGGER_TYPES, first.Type) : "",
      triggerPatterns: (first?.PatternMatches ?? []).join(", "),
      triggerParameter: first?.Parameter1 ?? "",
      matchType: enumName(MATCH_TYPES, r.TriggerMatchingType ?? 0),
      triggerCount: (r.Triggers ?? []).length,
      ruleJson: JSON.stringify(r),
    },
    { typeId: "pull-zone", externalId: String(zoneId) },
  );
}

export function storageZoneInstance(accountId: string, z: StorageZone): ResourceInstance {
  return instance(accountId, "storage-zone", String(z.Id), z.Name, {
    name: z.Name,
    region: z.Region ?? "",
    replicationRegions: (z.ReplicationRegions ?? []).join(", "),
    tier: enumName(ZONE_TIERS, z.ZoneTier ?? 0),
    storageUsed: z.StorageUsed ?? 0,
    filesStored: z.FilesStored ?? 0,
    storageHostname: z.StorageHostname ?? "",
    s3Hostname: z.S3Hostname ?? "",
    pullZones: (z.PullZones ?? []).map((p) => p.Name).join(", "),
    rewrite404To200: z.Rewrite404To200 === true,
    custom404FilePath: z.Custom404FilePath ?? "",
    dateModified: z.DateModified ?? "",
  });
}

export function dnsZoneInstance(accountId: string, z: DnsZone): ResourceInstance {
  return instance(accountId, "dns-zone", String(z.Id), z.Domain, {
    name: z.Domain,
    nameserversDetected: z.NameserversDetected === true,
    nameserver1: z.Nameserver1 ?? "",
    nameserver2: z.Nameserver2 ?? "",
    soaEmail: z.SoaEmail ?? "",
    logging: z.LoggingEnabled === true,
    dnssec: z.DnsSecEnabled === true,
    recordCount: (z.Records ?? []).length,
    createdAt: z.DateCreated ?? "",
  });
}

export function dnsRecordInstance(accountId: string, z: DnsZone, r: DnsRecord): ResourceInstance {
  const type = enumName(DNS_RECORD_TYPES, r.Type);
  const name = r.Name ?? "";
  const fields: Fields = {
    zoneId: String(z.Id),
    zoneName: z.Domain,
    type,
    name,
    content: r.Value ?? r.LinkName ?? "",
    ttl: r.Ttl ?? 0,
    disabled: r.Disabled === true,
    accelerated: r.Accelerated === true,
    comment: r.Comment ?? "",
  };
  if (r.Priority) fields["priority"] = r.Priority;
  if (r.Weight) fields["weight"] = r.Weight;
  if (r.Port) fields["port"] = r.Port;
  return instance(accountId, "dns-record", `${z.Id}/${r.Id}`, `${type} ${name || "@"}`, fields, {
    typeId: "dns-zone",
    externalId: String(z.Id),
  });
}

export function libraryInstance(accountId: string, l: VideoLibrary): ResourceInstance {
  const fields: Fields = {
    name: l.Name,
    videoCount: l.VideoCount ?? 0,
    storageUsage: l.StorageUsage ?? 0,
    trafficUsage: l.TrafficUsage ?? 0,
    replicationRegions: (l.ReplicationRegions ?? []).join(", "),
    resolutions: l.EnabledResolutions ?? "",
    webhookUrl: l.WebhookUrl ?? "",
    mp4Fallback: l.EnableMP4Fallback === true,
    keepOriginals: l.KeepOriginalFiles === true,
    directPlay: l.AllowDirectPlay === true,
    transcribing: l.EnableTranscribing === true,
    tokenAuthentication: l.PlayerTokenAuthenticationEnabled === true,
    blockNoReferrer: l.BlockNoneReferrer === true,
    drm: l.EnableDRM === true,
    createdAt: l.DateCreated ?? "",
  };
  if (l.PullZoneId) fields["pullZoneId"] = String(l.PullZoneId);
  if (l.StorageZoneId) fields["storageZoneId"] = String(l.StorageZoneId);
  return instance(accountId, "video-library", String(l.Id), l.Name, fields);
}

export function scriptInstance(accountId: string, s: EdgeScript): ResourceInstance {
  return instance(accountId, "edge-script", String(s.Id), s.Name, {
    name: s.Name,
    scriptType: enumName(SCRIPT_TYPES, s.ScriptType),
    defaultHostname: s.DefaultHostname ?? s.SystemHostname ?? "",
    linkedPullZones: (s.LinkedPullZones ?? []).map((p) => p.PullZoneName).join(", "),
    currentReleaseId: s.CurrentReleaseId ?? 0,
    monthlyRequests: s.MonthlyRequestCount ?? 0,
    monthlyCpuTime: s.MonthlyCpuTime ?? 0,
    monthlyCost: s.MonthlyCost ?? 0,
    lastModified: s.LastModified ?? "",
  });
}

export function appInstance(accountId: string, a: ContainerApp): ResourceInstance {
  const fields: Fields = {
    name: a.name,
    status: a.status ?? "",
    runtimeType: a.runtimeType ?? "",
    endpoint: a.displayEndpoint?.address ?? "",
    images: (a.containerTemplates ?? [])
      .map((t) => t.image || [t.imageName, t.imageTag].filter(Boolean).join(":"))
      .filter(Boolean)
      .join(", "),
    instances: (a.containerInstances ?? []).length,
    regions: (a.regionSettings?.allowedRegionIds ?? []).join(", "),
  };
  if (a.autoScaling?.min !== undefined) fields["minInstances"] = a.autoScaling.min;
  if (a.autoScaling?.max !== undefined) fields["maxInstances"] = a.autoScaling.max;
  return instance(accountId, "container-app", a.id, a.name, fields);
}
