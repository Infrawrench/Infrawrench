import type { ApiBody, ApiResponse } from "@infrawrench/plugin-base";
import type { operations as computeOperations } from "./api-types.compute.gen.js";
import type { components, operations } from "./api-types.core.gen.js";
import type { operations as mcOperations } from "./api-types.mc.gen.js";

/** bunny.net API models, from the published OpenAPI documents (see `plugingen.json`). */

export type PullZone = ApiResponse<operations["PullZonePublic_Index"]>;
export type Hostname = components["schemas"]["HostnameModel"];
/** An edge rule as stored on a pull zone, which always has its guid. */
export type EdgeRule = NonNullable<PullZone["EdgeRules"]>[number];
/** An edge rule as written, which has no guid until bunny.net gives it one. */
export type EdgeRuleBody = components["schemas"]["EdgeRuleV2Model"];
export type StorageZone = ApiResponse<operations["StorageZonePublic_Index"]>;
export type DnsZone = ApiResponse<operations["DnsZonePublic_Index2"]>;
export type DnsRecord = NonNullable<DnsZone["Records"]>[number];
export type VideoLibrary = components["schemas"]["VideoLibraryModel"];
export type EdgeScript = ApiResponse<
  computeOperations["GetEdgeScriptByIdEndpoint_GetEdgeScriptById"]
>;
export type ContainerApp = ApiResponse<mcOperations["GetApplication"]>;
export type Billing = ApiResponse<operations["GetBillingDetailsEndpoint_GetBillingDetails"]>;

export type PullZoneUpdate = ApiBody<operations["PullZonePublic_UpdatePullZone"]>;
export type DnsRecordBody = ApiBody<operations["DnsZonePublic_AddRecord"]>;

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
/** `PullZoneOriginType`, not the document's `OriginType`, which numbers load balancer origins. */
export const ORIGIN_TYPES = [
  "Standard",
  "DnsAccelerate",
  "Storage",
  "LoadBalancer",
  "EdgeScript",
  "MagicContainer",
  "PushZone",
] as const;
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
