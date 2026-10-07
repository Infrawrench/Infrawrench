/** bunny.net API models (subset), field names from the published OpenAPI specs (2026-10). */

export interface Hostname {
  Id: number;
  Value: string;
  ForceSSL?: boolean;
  IsSystemHostname?: boolean;
  IsManagedHostname?: boolean;
  HasCertificate?: boolean;
}

export interface EdgeTrigger {
  Type: number;
  PatternMatches?: string[];
  PatternMatchingType?: number;
  Parameter1?: string | null;
}

export interface EdgeRule {
  Guid: string;
  ActionType: number;
  ActionParameter1?: string | null;
  ActionParameter2?: string | null;
  ActionParameter3?: string | null;
  Triggers?: EdgeTrigger[];
  ExtraActions?: Array<{
    ActionType: number;
    ActionParameter1?: string | null;
    ActionParameter2?: string | null;
  }>;
  TriggerMatchingType?: number;
  Description?: string | null;
  Enabled?: boolean;
  OrderIndex?: number;
  ReadOnly?: boolean;
}

export interface PullZone {
  Id: number;
  Name: string;
  OriginUrl?: string | null;
  OriginType?: number;
  Enabled?: boolean;
  Suspended?: boolean;
  Hostnames?: Hostname[];
  StorageZoneId?: number;
  EdgeScriptId?: number;
  MagicContainersAppId?: string | null;
  Type?: number;
  CnameDomain?: string | null;
  MonthlyBandwidthUsed?: number;
  MonthlyBandwidthLimit?: number;
  MonthlyCharges?: number;
  EdgeRules?: EdgeRule[];
  EnableOriginShield?: boolean;
  OriginShieldZoneCode?: string | null;
  EnableLogging?: boolean;
  IgnoreQueryStrings?: boolean;
  CacheControlMaxAgeOverride?: number;
  CacheControlPublicMaxAgeOverride?: number;
  BlockedCountries?: string[];
  AllowedReferrers?: string[];
  BlockedReferrers?: string[];
  BlockedIps?: string[];
  EnableGeoZoneUS?: boolean;
  EnableGeoZoneEU?: boolean;
  EnableGeoZoneASIA?: boolean;
  EnableGeoZoneSA?: boolean;
  EnableGeoZoneAF?: boolean;
  ZoneSecurityEnabled?: boolean;
  ZoneSecurityKey?: string | null;
  VerifyOriginSSL?: boolean;
  AddHostHeader?: boolean;
  OriginHostHeader?: string | null;
  EnableTLS1?: boolean;
  EnableTLS1_1?: boolean;
  EnableSmartCache?: boolean;
  EnableWebPVary?: boolean;
  OptimizerEnabled?: boolean;
  DisableCookies?: boolean;
  VideoLibraryId?: number;
  DnsZoneId?: number;
}

export interface StorageZone {
  Id: number;
  Name: string;
  Password?: string;
  ReadOnlyPassword?: string;
  DateModified?: string;
  Deleted?: boolean;
  StorageUsed?: number;
  FilesStored?: number;
  Region?: string;
  ReplicationRegions?: string[];
  PullZones?: Array<{ Id: number; Name: string }>;
  Rewrite404To200?: boolean;
  Custom404FilePath?: string | null;
  StorageHostname?: string;
  S3Hostname?: string | null;
  ZoneTier?: number;
}

export interface DnsRecord {
  Id: number;
  Type: number;
  Ttl?: number;
  Value?: string | null;
  Name?: string | null;
  Weight?: number;
  Priority?: number;
  Port?: number;
  Flags?: number;
  Tag?: string | null;
  Accelerated?: boolean;
  AcceleratedPullZoneId?: number;
  LinkName?: string | null;
  MonitorType?: number;
  MonitorStatus?: number;
  Disabled?: boolean;
  Comment?: string | null;
}

export interface DnsZone {
  Id: number;
  Domain: string;
  Records?: DnsRecord[];
  DateModified?: string;
  DateCreated?: string;
  NameserversDetected?: boolean;
  CustomNameserversEnabled?: boolean;
  Nameserver1?: string;
  Nameserver2?: string;
  SoaEmail?: string;
  LoggingEnabled?: boolean;
  DnsSecEnabled?: boolean;
}

export interface VideoLibrary {
  Id: number;
  Name: string;
  VideoCount?: number;
  TrafficUsage?: number;
  StorageUsage?: number;
  DateCreated?: string;
  ReplicationRegions?: string[];
  ApiKey?: string;
  ReadOnlyApiKey?: string;
  PullZoneId?: number;
  StorageZoneId?: number;
  EnabledResolutions?: string;
  WebhookUrl?: string | null;
  EnableMP4Fallback?: boolean;
  KeepOriginalFiles?: boolean;
  AllowDirectPlay?: boolean;
  EnableTranscribing?: boolean;
  PlayerTokenAuthenticationEnabled?: boolean;
  EnableDRM?: boolean;
  BlockNoneReferrer?: boolean;
}

export interface EdgeScript {
  Id: number;
  Name: string;
  LastModified?: string;
  ScriptType?: number;
  CurrentReleaseId?: number;
  LinkedPullZones?: Array<{ Id: number; PullZoneName: string; DefaultHostname?: string }>;
  DefaultHostname?: string | null;
  SystemHostname?: string | null;
  MonthlyCost?: number;
  MonthlyRequestCount?: number;
  MonthlyCpuTime?: number;
  Deleted?: boolean;
}

export interface ContainerApp {
  id: string;
  name: string;
  description?: string;
  status?: string;
  runtimeType?: string;
  displayEndpoint?: { id?: string; address?: string; type?: string } | null;
  regionSettings?: {
    allowedRegionIds?: string[];
    requiredRegionIds?: string[];
    maxAllowedRegions?: number;
  } | null;
  containerTemplates?: Array<{
    id?: string;
    name?: string;
    image?: string;
    imageName?: string;
    imageTag?: string;
  }>;
  containerInstances?: Array<{ id?: string }>;
  autoScaling?: { min?: number; max?: number } | null;
}

export interface Billing {
  Balance?: number;
  ThisMonthCharges?: number;
  CouponBalance?: number;
  AvailableBalance?: number;
  BillingRecords?: Array<{
    Id: number;
    Amount: number;
    Timestamp: string;
    Type: number;
    InvoiceAvailable?: boolean;
  }>;
  [key: string]: unknown;
}

export const DNS_RECORD_TYPES = [
  "A",
  "AAAA",
  "CNAME",
  "TXT",
  "MX",
  "Redirect",
  "Flatten",
  "PullZone",
  "SRV",
  "CAA",
  "PTR",
  "Script",
  "NS",
  "SVCB",
  "HTTPS",
  "TLSA",
] as const;

export const EDGE_ACTIONS = [
  "ForceSSL",
  "Redirect",
  "OriginUrl",
  "OverrideCacheTime",
  "BlockRequest",
  "SetResponseHeader",
  "SetRequestHeader",
  "ForceDownload",
  "DisableTokenAuthentication",
  "EnableTokenAuthentication",
  "OverrideCacheTimePublic",
  "IgnoreQueryString",
  "DisableOptimizer",
  "ForceCompression",
  "SetStatusCode",
  "BypassPermaCache",
  "OverrideBrowserCacheTime",
  "OriginStorage",
  "SetNetworkRateLimit",
  "SetConnectionLimit",
  "SetRequestsPerSecondLimit",
  "RunEdgeScript",
  "OriginMagicContainers",
  "DisableWAF",
  "RetryOrigin",
  "OverrideBrowserCacheResponseHeader",
  "RemoveBrowserCacheResponseHeader",
  "DisableShieldChallenge",
  "DisableShield",
  "DisableShieldBotDetection",
  "BypassAwsS3Authentication",
  "DisableShieldAccessLists",
  "DisableShieldRateLimiting",
  "EnableRequestCoalescing",
  "DisableRequestCoalescing",
  "UseLoadBalancer",
  "ForceLoadBalancerStickySessionMode",
  "StripCookiesClientToOrigin",
] as const;

export const TRIGGER_TYPES = [
  "Url",
  "RequestHeader",
  "ResponseHeader",
  "UrlExtension",
  "CountryCode",
  "RemoteIP",
  "UrlQueryString",
  "RandomChance",
  "StatusCode",
  "RequestMethod",
  "CookieValue",
  "CountryStateCode",
  "OriginRetryAttemptCount",
  "OriginConnectionError",
] as const;

export const MATCH_TYPES = ["MatchAny", "MatchAll", "MatchNone"] as const;
export const PULL_ZONE_TYPES = ["Premium", "Volume"] as const;
export const ORIGIN_TYPES = ["Standard", "Storage", "EdgeScript", "MagicContainer"] as const;
export const SCRIPT_TYPES = ["DNS", "CDN", "Middleware"] as const;
export const ZONE_TIERS = ["Standard", "Edge"] as const;

/** Enum index → name, "" when out of range. */
export function enumName(list: readonly string[], v: number | undefined | null): string {
  return v === undefined || v === null ? "" : (list[v] ?? String(v));
}

/** Name → enum index; throws on an unknown name. */
export function enumIndex(list: readonly string[], name: string, label: string): number {
  const i = list.indexOf(name);
  if (i < 0) throw new Error(`Unknown ${label} "${name}".`);
  return i;
}
