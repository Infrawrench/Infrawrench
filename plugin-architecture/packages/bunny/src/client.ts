import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
import type {
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  CreditBalance,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  PreflightResult,
  ResourceInstance,
  SidebarItemSchema,
  StorageObject,
} from "@infrawrench/plugin-base";
import { CreditAccessError, externalIdOf } from "@infrawrench/plugin-base";
import type { BunnyApis, BunnyContext, Chart } from "./api.js";
import {
  BunnyApiError,
  bunnyPaged,
  chartPoints,
  createBunnyApis,
  idSegment,
  listStorage,
  mcApps,
  statusOf,
  writeStorage,
} from "./api.js";
import { billingCostRows, chargesBreakdown, creditBalances } from "./cost.js";
import {
  appInstance,
  dnsRecordInstance,
  dnsZoneInstance,
  edgeRuleInstance,
  hostnameInstance,
  instance,
  libraryInstance,
  pullZoneInstance,
  scriptInstance,
  splitChild,
  splitList,
  storageZoneInstance,
  systemHostname,
} from "./mappers.js";
import { DEFAULT_METRICS_WINDOW_MS, renderBunnyDetail, renderBunnySidebar } from "./render.js";
import type {
  DnsRecordBody,
  DnsZone,
  EdgeRuleBody,
  PullZone,
  PullZoneUpdate,
  StorageZone,
} from "./types.js";
import { DNS_RECORD_TYPES, EDGE_ACTIONS, MATCH_TYPES, TRIGGER_TYPES, enumIndex } from "./types.js";

const CACHE_MS = 30_000;

function bool(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === "") return undefined;
  return raw === "true" || raw === "on" || raw === "1" || raw === "yes";
}

function int(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`"${raw}" is not a number.`);
  return Math.trunc(n);
}

function parsePicked(raw: string | undefined): string[] {
  const t = (raw ?? "").trim();
  if (t.startsWith("[")) {
    try {
      const v: unknown = JSON.parse(t);
      if (Array.isArray(v)) return v.map(String).filter(Boolean);
    } catch {
      // fall through
    }
  }
  return splitList(t);
}

/** A child's ids for a write, where a blank key would reach the API as an empty value. */
function childOf(id: string): { parent: string; key: string } {
  const { parent, key } = splitChild(id);
  if (!parent || !key) throw new Error(`bunny.net plugin: "${id}" does not name a child resource.`);
  return { parent, key };
}

function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function series(label: string, unit: string, chart: Chart, scale = 1): MetricSeries {
  return {
    label,
    unit,
    points: chartPoints(chart).map((p) => ({ timestamp: p.timestamp, value: p.value * scale })),
  };
}

/** A boolean form field, or nothing when the form did not send it. */
function flag(raw: string | undefined): boolean | undefined {
  return raw === undefined ? undefined : bool(raw) === true;
}

/** A number form field, 0 when blank, or nothing when the form did not send it. */
function intOrZero(raw: string | undefined): number | undefined {
  return raw === undefined ? undefined : (int(raw) ?? 0);
}

/** A trimmed text form field, or nothing when the form did not send it. */
function trimmed(raw: string | undefined): string | undefined {
  return raw === undefined ? undefined : raw.trim();
}

/** A list form field, or nothing when the form did not send it. */
function list(raw: string | undefined): string[] | undefined {
  return raw === undefined ? undefined : splitList(raw);
}

/** Body for `POST /pullzone/{id}` from changed form fields. */
export function pullZoneUpdateBody(fields: Record<string, string>): PullZoneUpdate {
  const originHostHeader = trimmed(fields["originHostHeader"]);
  return {
    OriginUrl: trimmed(fields["originUrl"]),
    MonthlyBandwidthLimit: intOrZero(fields["monthlyBandwidthLimit"]),
    CacheControlMaxAgeOverride: intOrZero(fields["cacheMaxAgeOverride"]),
    CacheControlPublicMaxAgeOverride: intOrZero(fields["browserMaxAgeOverride"]),
    IgnoreQueryStrings: flag(fields["ignoreQueryStrings"]),
    EnableSmartCache: flag(fields["smartCache"]),
    EnableOriginShield: flag(fields["originShield"]),
    EnableLogging: flag(fields["logging"]),
    OptimizerEnabled: flag(fields["optimizer"]),
    VerifyOriginSSL: flag(fields["verifyOriginSsl"]),
    OriginHostHeader: originHostHeader,
    ZoneSecurityEnabled: flag(fields["tokenAuthentication"]),
    BlockedCountries: list(fields["blockedCountries"])?.map((x) => x.toUpperCase()),
    AllowedReferrers: list(fields["allowedReferrers"]),
    BlockedIps: list(fields["blockedIps"]),
    EnableGeoZoneUS: flag(fields["geoUS"]),
    EnableGeoZoneEU: flag(fields["geoEU"]),
    EnableGeoZoneASIA: flag(fields["geoASIA"]),
    EnableGeoZoneSA: flag(fields["geoSA"]),
    EnableGeoZoneAF: flag(fields["geoAF"]),
    AddHostHeader: originHostHeader === undefined ? undefined : originHostHeader !== "",
  };
}

/** An edge rule from form fields, keeping what the form cannot express. */
export function edgeRuleFromFields(
  fields: Record<string, string>,
  current?: EdgeRuleBody,
): EdgeRuleBody {
  const action =
    fields["action"] ??
    (current?.ActionType === undefined ? undefined : EDGE_ACTIONS[current.ActionType]);
  if (!action) throw new Error("Pick an action.");
  const triggers = [...(current?.Triggers ?? [])];
  const triggerType = fields["triggerType"];
  const patterns = fields["triggerPatterns"];
  if (
    triggerType !== undefined ||
    patterns !== undefined ||
    fields["triggerParameter"] !== undefined
  ) {
    const first = triggers[0] ?? { Type: 0, PatternMatches: [], PatternMatchingType: 0 };
    triggers[0] = {
      ...first,
      ...(triggerType ? { Type: enumIndex(TRIGGER_TYPES, triggerType, "trigger") } : {}),
      ...(patterns !== undefined ? { PatternMatches: parsePicked(patterns) } : {}),
      ...(fields["triggerParameter"] !== undefined
        ? { Parameter1: fields["triggerParameter"] }
        : {}),
    };
  }
  if (triggers.length === 0 || (triggers[0]?.PatternMatches ?? []).length === 0) {
    throw new Error("Add at least one trigger pattern, for example * to match every request.");
  }
  const rule: EdgeRuleBody = {
    Guid: current?.Guid ?? "",
    ActionType: enumIndex(EDGE_ACTIONS, action, "action"),
    ActionParameter1: fields["actionParameter1"] ?? current?.ActionParameter1 ?? "",
    ActionParameter2: fields["actionParameter2"] ?? current?.ActionParameter2 ?? "",
    ActionParameter3: current?.ActionParameter3 ?? "",
    Triggers: triggers,
    ExtraActions: current?.ExtraActions ?? [],
    TriggerMatchingType: fields["matchType"]
      ? enumIndex(MATCH_TYPES, fields["matchType"], "match type")
      : (current?.TriggerMatchingType ?? 0),
    Description: fields["description"] ?? current?.Description ?? "",
    Enabled:
      fields["enabled"] !== undefined
        ? bool(fields["enabled"]) !== false
        : (current?.Enabled ?? true),
  };
  if (!rule.Guid) delete rule.Guid;
  return rule;
}

export class BunnyClient implements PluginClient {
  private readonly ctx: BunnyContext;
  private readonly api: BunnyApis;
  private pullZonesCache: { at: number; value: Promise<PullZone[]> } | undefined;
  private storageZonesCache: { at: number; value: Promise<StorageZone[]> } | undefined;

  constructor(credentials: Credentials, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) throw new Error("bunny.net plugin: missing apiKey credential");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      apiKey,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
    this.api = createBunnyApis(this.ctx);
  }

  private invalidate(): void {
    this.pullZonesCache = undefined;
    this.storageZonesCache = undefined;
  }

  private pullZones(): Promise<PullZone[]> {
    if (this.pullZonesCache && Date.now() - this.pullZonesCache.at < CACHE_MS)
      return this.pullZonesCache.value;
    const value = this.api.core.get("/pullzone").then((r) => r ?? []);
    this.pullZonesCache = { at: Date.now(), value };
    value.catch(() => (this.pullZonesCache = undefined));
    return value;
  }

  private storageZones(): Promise<StorageZone[]> {
    if (this.storageZonesCache && Date.now() - this.storageZonesCache.at < CACHE_MS)
      return this.storageZonesCache.value;
    const value = this.api.core
      .get("/storagezone")
      .then((r) => (r ?? []).filter((z) => !z.Deleted));
    this.storageZonesCache = { at: Date.now(), value };
    value.catch(() => (this.storageZonesCache = undefined));
    return value;
  }

  private async dnsZones(): Promise<DnsZone[]> {
    return bunnyPaged((paging) => this.api.core.get("/dnszone", { query: paging }));
  }

  private async pullZone(id: string): Promise<PullZone> {
    return this.api.core.get(`/pullzone/${idSegment(id)}`);
  }

  // ── Listing ─────────────────────────────────────────────────────────────

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      switch (typeId) {
        case "account":
          return [await this.accountInstance(accountId)];
        case "pull-zone":
          return (await this.pullZones()).map((z) => pullZoneInstance(accountId, z));
        case "hostname":
          return (await this.pullZones()).flatMap((z) =>
            (z.Hostnames ?? []).map((h) => hostnameInstance(accountId, z.Id, h)),
          );
        case "edge-rule":
          return (await this.pullZones()).flatMap((z) =>
            (z.EdgeRules ?? [])
              .filter((r) => !r.ReadOnly)
              .map((r) => edgeRuleInstance(accountId, z.Id, r)),
          );
        case "storage-zone":
          return (await this.storageZones()).map((z) => storageZoneInstance(accountId, z));
        case "dns-zone":
          return (await this.dnsZones()).map((z) => dnsZoneInstance(accountId, z));
        case "dns-record":
          return (await this.dnsZones()).flatMap((z) =>
            (z.Records ?? []).map((r) => dnsRecordInstance(accountId, z, r)),
          );
        case "video-library":
          return (
            await bunnyPaged((paging) => this.api.core.get("/videolibrary", { query: paging }))
          ).map((l) => libraryInstance(accountId, l));
        case "edge-script":
          return (
            await bunnyPaged((paging) =>
              this.api.compute.get("/compute/script", {
                query: { includeLinkedPullzones: true, ...paging },
              }),
            )
          )
            .filter((s) => !s.Deleted)
            .map((s) => scriptInstance(accountId, s));
        case "container-app": {
          try {
            const items = await mcApps(this.api.mc);
            const apps = await Promise.all(
              items.map((a) => this.api.mc.get(`/apps/${idSegment(a.id)}`)),
            );
            return apps.filter(Boolean).map((a) => appInstance(accountId, a));
          } catch (err) {
            // Accounts without Magic Containers answer 403/404 here.
            if ([403, 404].includes(statusOf(err))) return [];
            throw err;
          }
        }
        default:
          return [];
      }
    });
  }

  private async accountInstance(accountId: string): Promise<ResourceInstance> {
    const [billing, pz, sz, dns] = await Promise.all([
      this.api.core.get("/billing").catch(() => undefined),
      this.pullZones().catch(() => []),
      this.storageZones().catch(() => []),
      this.dnsZones().catch(() => []),
    ]);
    const fields: Record<string, string | number | boolean> = {
      pullZoneCount: pz.length,
      storageZoneCount: sz.length,
      dnsZoneCount: dns.length,
    };
    if (billing) {
      if (typeof billing.Balance === "number") fields["balance"] = billing.Balance;
      if (typeof billing.ThisMonthCharges === "number")
        fields["thisMonthCharges"] = billing.ThisMonthCharges;
      if (typeof billing.CouponBalance === "number")
        fields["couponBalance"] = billing.CouponBalance;
      fields["chargesBreakdown"] = JSON.stringify(chargesBreakdown(billing));
    }
    return instance(accountId, "account", "account", "bunny.net account", fields);
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      switch (typeId) {
        case "pull-zone":
          return pullZoneInstance(accountId, await this.pullZone(id));
        case "storage-zone":
          return storageZoneInstance(
            accountId,
            await this.api.core.get(`/storagezone/${idSegment(id)}`),
          );
        case "dns-zone":
          return dnsZoneInstance(accountId, await this.api.core.get(`/dnszone/${idSegment(id)}`));
        case "dns-record": {
          const { parent, key } = splitChild(id);
          const zone = await this.api.core.get(`/dnszone/${idSegment(parent)}`);
          const rec = (zone.Records ?? []).find((r) => String(r.Id) === key);
          if (!rec) throw new BunnyApiError(404, `bunny.net: DNS record ${id} not found`);
          return dnsRecordInstance(accountId, zone, rec);
        }
        case "video-library":
          return libraryInstance(
            accountId,
            await this.api.core.get(`/videolibrary/${idSegment(id)}`),
          );
        case "edge-script":
          return scriptInstance(
            accountId,
            await this.api.compute.get(`/compute/script/${idSegment(id)}`),
          );
        case "container-app":
          return appInstance(accountId, await this.api.mc.get(`/apps/${idSegment(id)}`));
        case "hostname":
        case "edge-rule": {
          const { parent } = splitChild(id);
          this.pullZonesCache = undefined;
          const zone = await this.pullZone(parent);
          const found =
            typeId === "hostname"
              ? (zone.Hostnames ?? [])
                  .map((h) => hostnameInstance(accountId, zone.Id, h))
                  .find((r) => r.externalId === id)
              : (zone.EdgeRules ?? [])
                  .map((r) => edgeRuleInstance(accountId, zone.Id, r))
                  .find((r) => r.externalId === id);
          if (!found) throw new BunnyApiError(404, `bunny.net: ${typeId} ${id} not found`);
          return found;
        }
        default: {
          const found = (await runPluginEffect(this.listResources(typeId, accountId))).find(
            (r) => r.externalId === id,
          );
          if (!found) throw new BunnyApiError(404, `bunny.net: ${typeId} ${id} not found`);
          return found;
        }
      }
    });
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    _accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      if (typeId === "pull-zone") {
        const z = await this.pullZone(id);
        if (outputKey === "cdnHostname") return systemHostname(z);
        if (outputKey === "cdnUrl") return `https://${systemHostname(z)}`;
        if (outputKey === "tokenKey") return z.ZoneSecurityKey ?? "";
      }
      if (typeId === "hostname" && outputKey === "url") return `https://${splitChild(id).key}`;
      if (typeId === "storage-zone") {
        const z = await this.api.core.get(`/storagezone/${idSegment(id)}`);
        if (outputKey === "storageHostname") return z.StorageHostname ?? "";
        if (outputKey === "password") return z.Password ?? "";
        if (outputKey === "readOnlyPassword") return z.ReadOnlyPassword ?? "";
        if (outputKey === "ftpUsername") return z.Name;
      }
      if (typeId === "dns-zone" && outputKey === "nameservers") {
        const z = await this.api.core.get(`/dnszone/${idSegment(id)}`);
        return [z.Nameserver1, z.Nameserver2].filter(Boolean).join(", ");
      }
      if (typeId === "video-library") {
        if (outputKey === "libraryId") return id;
        const l = await this.api.core.get(`/videolibrary/${idSegment(id)}`);
        if (outputKey === "apiKey") return l.ApiKey ?? "";
        if (outputKey === "readOnlyApiKey") return l.ReadOnlyApiKey ?? "";
      }
      if (typeId === "edge-script" && outputKey === "url") {
        const s = await this.api.compute.get(`/compute/script/${idSegment(id)}`);
        const h = s.DefaultHostname ?? s.SystemHostname ?? "";
        return h ? `https://${h}` : "";
      }
      if (typeId === "container-app" && outputKey === "endpoint") {
        const a = await this.api.mc.get(`/apps/${idSegment(id)}`);
        return a.displayEndpoint?.address ?? "";
      }
      throw new Error(`bunny.net plugin: unknown output ${outputKey} on ${typeId}`);
    });
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderBunnyDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderBunnySidebar(resource);
  }

  verifyCredentials(): PluginEffect<PreflightResult> {
    return attempt(async () => {
      const probe = async <T>(id: string, fn: () => Promise<T>) => {
        try {
          await fn();
          return { capabilityId: id, status: "ok" as const };
        } catch (err) {
          const s = statusOf(err);
          if (s === 401)
            return {
              capabilityId: id,
              status: "missing" as const,
              missingPermissions: [],
              message: "The API key was rejected.",
            };
          if (s === 403)
            return {
              capabilityId: id,
              status: "missing" as const,
              missingPermissions: [],
              message: err instanceof Error ? err.message : "",
            };
          return {
            capabilityId: id,
            status: "unknown" as const,
            message: err instanceof Error ? err.message : String(err),
          };
        }
      };
      return {
        checks: await Promise.all([
          probe("resources", () => this.api.core.get("/pullzone")),
          probe("costs", () => this.api.core.get("/billing")),
          probe("containers", () => mcApps(this.api.mc, 1)),
        ]),
      };
    });
  }

  // ── Create ──────────────────────────────────────────────────────────────

  private async storageRegionOptions(): Promise<
    Array<{ id: string; label: string; description?: string }>
  > {
    const regions = await this.api.core.get("/storagezone/regions").catch(() => []);
    return (regions ?? []).map((r) => ({ id: r.Id, label: r.Name, description: r.Id }));
  }

  getCreateConfig(typeId: string, parentResourceId?: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      switch (typeId) {
        case "pull-zone": {
          const zones = await this.storageZones().catch(() => []);
          return {
            fields: [
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: true,
                placeholder: "my-site",
                description: "Becomes <name>.b-cdn.net; globally unique.",
              },
              {
                key: "originType",
                label: "Origin",
                kind: "select",
                required: true,
                defaultValue: "url",
                options: [
                  { id: "url", label: "Origin URL", description: "Your server or bucket" },
                  {
                    id: "storage",
                    label: "Storage zone",
                    description: "Serve files from bunny Edge Storage",
                  },
                ],
              },
              {
                key: "originUrl",
                label: "Origin URL",
                kind: "text",
                required: false,
                placeholder: "https://origin.example.com",
                showWhen: { fieldKey: "originType", fieldValue: "url" },
              },
              {
                key: "storageZoneId",
                label: "Storage zone",
                kind: "select",
                required: false,
                showWhen: { fieldKey: "originType", fieldValue: "storage" },
                options: zones.map((z) => ({
                  id: String(z.Id),
                  label: z.Name,
                  description: z.Region ?? "",
                })),
              },
              {
                key: "type",
                label: "Tier",
                kind: "select",
                required: true,
                defaultValue: "0",
                options: [
                  { id: "0", label: "Standard", description: "All 100+ PoPs, best performance" },
                  {
                    id: "1",
                    label: "Volume",
                    description: "Fewer, larger PoPs, cheaper for heavy traffic",
                  },
                ],
              },
            ],
          };
        }
        case "hostname":
          return {
            fields: [
              ...(parentResourceId
                ? []
                : [
                    {
                      key: "pullZoneId",
                      label: "Pull zone",
                      kind: "select" as const,
                      required: true,
                      options: (await this.pullZones()).map((z) => ({
                        id: String(z.Id),
                        label: z.Name,
                      })),
                    },
                  ]),
              {
                key: "hostname",
                label: "Hostname",
                kind: "text",
                required: true,
                placeholder: "cdn.example.com",
                description: "CNAME it to the pull zone's b-cdn.net hostname first.",
              },
              {
                key: "certificate",
                label: "Free SSL certificate",
                kind: "select",
                required: true,
                defaultValue: "yes",
                options: [
                  { id: "yes", label: "Request one now" },
                  { id: "no", label: "Not now" },
                ],
              },
            ],
          };
        case "edge-rule":
          return {
            fields: [
              ...(parentResourceId
                ? []
                : [
                    {
                      key: "pullZoneId",
                      label: "Pull zone",
                      kind: "select" as const,
                      required: true,
                      options: (await this.pullZones()).map((z) => ({
                        id: String(z.Id),
                        label: z.Name,
                      })),
                    },
                  ]),
              {
                key: "description",
                label: "Description",
                kind: "text",
                required: false,
                placeholder: "Redirect old blog",
              },
              {
                key: "action",
                label: "Action",
                kind: "select",
                required: true,
                defaultValue: "Redirect",
                options: EDGE_ACTIONS.map((a) => ({
                  id: a,
                  label: a.replace(/([a-z])([A-Z])/g, "$1 $2"),
                })),
              },
              {
                key: "actionParameter1",
                label: "Action parameter",
                kind: "text",
                required: false,
                description: "Redirect URL, header name, cache seconds, status code…",
              },
              {
                key: "actionParameter2",
                label: "Second parameter",
                kind: "text",
                required: false,
                description: "Header value for header actions.",
              },
              {
                key: "triggerType",
                label: "Trigger",
                kind: "select",
                required: true,
                defaultValue: "Url",
                options: TRIGGER_TYPES.map((t) => ({
                  id: t,
                  label: t.replace(/([a-z])([A-Z])/g, "$1 $2"),
                })),
              },
              {
                key: "triggerPatterns",
                label: "Patterns",
                kind: "string-list",
                required: true,
                placeholder: "*/blog/*",
              },
              {
                key: "triggerParameter",
                label: "Trigger parameter",
                kind: "text",
                required: false,
                description: "Header or cookie name for header and cookie triggers.",
              },
            ],
          };
        case "storage-zone": {
          const regions = await this.storageRegionOptions();
          return {
            fields: [
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: true,
                placeholder: "my-assets",
                description: "Globally unique; also the FTP username.",
              },
              {
                key: "tier",
                label: "Tier",
                kind: "select",
                required: true,
                defaultValue: "0",
                options: [
                  { id: "0", label: "Standard", description: "HDD, replicated on demand" },
                  { id: "1", label: "Edge (SSD)", description: "SSD with fast global replication" },
                ],
              },
              {
                key: "region",
                label: "Main region",
                kind: "select",
                required: true,
                defaultValue: regions[0]?.id ?? "DE",
                options: regions,
              },
              {
                key: "replicationRegions",
                label: "Replication regions",
                kind: "policy-picker",
                required: false,
                policies: regions.map((r) => ({ id: r.id, label: r.label })),
              },
            ],
          };
        }
        case "dns-zone":
          return {
            fields: [
              {
                key: "domain",
                label: "Domain",
                kind: "text",
                required: true,
                placeholder: "example.com",
              },
            ],
          };
        case "dns-record":
          return {
            fields: [
              ...(parentResourceId
                ? []
                : [
                    {
                      key: "zoneId",
                      label: "Zone",
                      kind: "select" as const,
                      required: true,
                      options: (await this.dnsZones()).map((z) => ({
                        id: String(z.Id),
                        label: z.Domain,
                      })),
                    },
                  ]),
              {
                key: "type",
                label: "Type",
                kind: "select",
                required: true,
                defaultValue: "A",
                options: DNS_RECORD_TYPES.map((t) => ({ id: t, label: t })),
              },
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: false,
                placeholder: "www",
                description: "Leave empty for the apex.",
              },
              {
                key: "content",
                label: "Value",
                kind: "text",
                required: true,
                placeholder: "203.0.113.10",
              },
              {
                key: "ttl",
                label: "TTL (seconds)",
                kind: "number",
                required: false,
                defaultValue: "300",
                minValue: 15,
              },
              {
                key: "priority",
                label: "Priority",
                kind: "number",
                required: false,
                showWhen: { fieldKey: "type", fieldValues: ["MX", "SRV"] },
              },
              {
                key: "weight",
                label: "Weight",
                kind: "number",
                required: false,
                showWhen: { fieldKey: "type", fieldValue: "SRV" },
              },
              {
                key: "port",
                label: "Port",
                kind: "number",
                required: false,
                showWhen: { fieldKey: "type", fieldValue: "SRV" },
              },
            ],
          };
        case "video-library": {
          const regions = await this.storageRegionOptions();
          return {
            fields: [
              { key: "name", label: "Name", kind: "text", required: true },
              {
                key: "replicationRegions",
                label: "Replication regions",
                kind: "policy-picker",
                required: false,
                policies: regions.map((r) => ({ id: r.id, label: r.label })),
              },
            ],
          };
        }
        case "edge-script":
          return {
            fields: [
              { key: "name", label: "Name", kind: "text", required: true },
              {
                key: "scriptType",
                label: "Type",
                kind: "select",
                required: true,
                defaultValue: "1",
                options: [
                  {
                    id: "1",
                    label: "Standalone",
                    description: "Answers requests itself on its own hostname",
                  },
                  {
                    id: "2",
                    label: "Middleware",
                    description: "Runs in front of a pull zone's origin",
                  },
                ],
              },
              {
                key: "code",
                label: "Code",
                kind: "code",
                codeLanguage: "javascript",
                required: false,
                defaultValue:
                  'import * as BunnySDK from "https://esm.sh/@bunny.net/edgescript-sdk@0.11.2";\n\nBunnySDK.net.http.serve(async (request) => {\n  return new Response("Hello from the edge");\n});\n',
              },
            ],
          };
        default:
          return { fields: [] };
      }
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const parent = parentResourceId ? externalIdOf(parentResourceId) : "";
      switch (typeId) {
        case "pull-zone": {
          const storage = fields["originType"] === "storage";
          if (storage && !fields["storageZoneId"]) throw new Error("Pick a storage zone.");
          if (!storage && !/^https?:\/\//i.test(fields["originUrl"] ?? ""))
            throw new Error("Enter the origin URL, starting with http:// or https://.");
          const z = await this.api.core.post("/pullzone", {
            body: {
              Name: (fields["name"] ?? "").trim(),
              Type: Number(fields["type"] ?? 0),
              OriginType: storage ? 1 : undefined,
              StorageZoneId: storage ? Number(fields["storageZoneId"]) : undefined,
              OriginUrl: storage ? undefined : fields["originUrl"],
            },
          });
          this.invalidate();
          return pullZoneInstance(accountId, z);
        }
        case "hostname": {
          const pz = fields["pullZoneId"] || parent;
          const host = (fields["hostname"] ?? "").trim().toLowerCase();
          await this.api.core.post(`/pullzone/${idSegment(pz)}/addHostname`, {
            body: { Hostname: host },
          });
          if (fields["certificate"] !== "no") {
            await this.api.core
              .get("/pullzone/loadFreeCertificate", { query: { hostname: host } })
              .catch(() => undefined);
          }
          this.invalidate();
          return runPluginEffect(
            this.getResource("hostname", `${accountId}:hostname:${pz}/${host}`, accountId),
          );
        }
        case "edge-rule": {
          const pz = fields["pullZoneId"] || parent;
          const before = new Set(((await this.pullZone(pz)).EdgeRules ?? []).map((r) => r.Guid));
          await this.api.core.post(`/pullzone/${idSegment(pz)}/edgerules/addOrUpdate`, {
            body: edgeRuleFromFields(fields),
          });
          const created = ((await this.pullZone(pz)).EdgeRules ?? []).find(
            (r) => !before.has(r.Guid),
          );
          this.invalidate();
          if (!created)
            throw new BunnyApiError(502, "bunny.net accepted the edge rule but did not list it.");
          return edgeRuleInstance(accountId, Number(pz), created);
        }
        case "storage-zone": {
          const z = await this.api.core.post("/storagezone", {
            body: {
              Name: (fields["name"] ?? "").trim(),
              Region: fields["region"] ?? "DE",
              ZoneTier: Number(fields["tier"] ?? 0),
              ReplicationRegions: parsePicked(fields["replicationRegions"]).filter(
                (r) => r !== fields["region"],
              ),
            },
          });
          this.invalidate();
          return storageZoneInstance(accountId, z);
        }
        case "dns-zone": {
          const z = await this.api.core.post("/dnszone", {
            body: { Domain: (fields["domain"] ?? "").trim().toLowerCase() },
          });
          return dnsZoneInstance(accountId, z);
        }
        case "dns-record": {
          const zoneId = fields["zoneId"] || parent;
          const rec = await this.api.core.put(`/dnszone/${idSegment(zoneId)}/records`, {
            body: recordBody(fields),
          });
          return runPluginEffect(
            this.getResource(
              "dns-record",
              `${accountId}:dns-record:${zoneId}/${rec.Id}`,
              accountId,
            ),
          );
        }
        case "video-library": {
          const l = await this.api.core.post("/videolibrary", {
            body: {
              Name: (fields["name"] ?? "").trim(),
              ReplicationRegions: parsePicked(fields["replicationRegions"]),
            },
          });
          return libraryInstance(accountId, l);
        }
        case "edge-script": {
          const s = await this.api.compute.post("/compute/script", {
            body: {
              Name: (fields["name"] ?? "").trim(),
              ScriptType: Number(fields["scriptType"] ?? 1),
              Code: fields["code"] ?? "",
              CreateLinkedPullZone: fields["scriptType"] !== "2",
            },
          });
          return scriptInstance(accountId, s);
        }
        default:
          throw new Error(`bunny.net plugin: cannot create ${typeId}`);
      }
    });
  }

  // ── Update ──────────────────────────────────────────────────────────────

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      switch (typeId) {
        case "pull-zone":
          await this.api.core.post(`/pullzone/${idSegment(id)}`, {
            body: pullZoneUpdateBody(fields),
          });
          this.invalidate();
          break;
        case "hostname": {
          const { parent, key } = childOf(id);
          if (fields["forceSsl"] !== undefined) {
            await this.api.core.post(`/pullzone/${idSegment(parent)}/setForceSSL`, {
              body: { Hostname: key, ForceSSL: bool(fields["forceSsl"]) === true },
            });
          }
          this.invalidate();
          break;
        }
        case "edge-rule": {
          const { parent, key } = childOf(id);
          const current = ((await this.pullZone(parent)).EdgeRules ?? []).find(
            (r) => r.Guid === key,
          );
          if (!current) throw new BunnyApiError(404, "That edge rule no longer exists.");
          const onlyEnabled = Object.keys(fields).every((k) => k === "enabled");
          if (onlyEnabled) {
            await this.api.core.post(
              `/pullzone/${idSegment(parent)}/edgerules/${idSegment(key)}/setEdgeRuleEnabled`,
              { body: { Id: Number(parent), Value: bool(fields["enabled"]) === true } },
            );
          } else {
            await this.api.core.post(`/pullzone/${idSegment(parent)}/edgerules/addOrUpdate`, {
              body: edgeRuleFromFields(fields, current),
            });
          }
          this.invalidate();
          break;
        }
        case "storage-zone": {
          await this.api.core.post(`/storagezone/${idSegment(id)}`, {
            body: {
              ReplicationZones: list(fields["replicationRegions"])?.map((r) => r.toUpperCase()),
              Rewrite404To200: flag(fields["rewrite404To200"]),
              Custom404FilePath: fields["custom404FilePath"],
            },
          });
          this.invalidate();
          break;
        }
        case "dns-zone": {
          if (fields["soaEmail"] !== undefined || fields["logging"] !== undefined) {
            await this.api.core.post(`/dnszone/${idSegment(id)}`, {
              body: { SoaEmail: fields["soaEmail"], LoggingEnabled: flag(fields["logging"]) },
            });
          }
          if (fields["dnssec"] !== undefined) {
            const dnssec = `/dnszone/${idSegment(id)}/dnssec` as const;
            if (bool(fields["dnssec"])) await this.api.core.post(dnssec);
            else await this.api.core.delete(dnssec);
          }
          break;
        }
        case "dns-record": {
          const { parent, key } = childOf(id);
          const current = await runPluginEffect(
            this.getResource("dns-record", resourceId, accountId),
          );
          const merged: Record<string, string> = {};
          for (const [k, v] of Object.entries(current.fields)) merged[k] = String(v);
          Object.assign(merged, fields);
          await this.api.core.post(`/dnszone/${idSegment(parent)}/records/${idSegment(key)}`, {
            body: { ...recordBody(merged), Id: Number(key) },
          });
          break;
        }
        case "video-library": {
          await this.api.core.post(`/videolibrary/${idSegment(id)}`, {
            body: {
              Name: fields["name"],
              EnabledResolutions: fields["resolutions"],
              WebhookUrl: fields["webhookUrl"],
              EnableMP4Fallback: flag(fields["mp4Fallback"]),
              KeepOriginalFiles: flag(fields["keepOriginals"]),
              AllowDirectPlay: flag(fields["directPlay"]),
              EnableTranscribing: flag(fields["transcribing"]),
              PlayerTokenAuthenticationEnabled: flag(fields["tokenAuthentication"]),
              BlockNoneReferrer: flag(fields["blockNoReferrer"]),
            },
          });
          break;
        }
        case "edge-script":
          if (fields["name"] !== undefined) {
            await this.api.compute.post(`/compute/script/${idSegment(id)}`, {
              body: { Name: fields["name"] },
            });
          }
          break;
        case "container-app": {
          const app = await this.api.mc.get(`/apps/${idSegment(id)}`);
          const min = int(fields["minInstances"]) ?? app.autoScaling?.min ?? 1;
          const max = int(fields["maxInstances"]) ?? app.autoScaling?.max ?? min;
          if (max < min) throw new Error("Max instances must be at least min instances.");
          await this.api.mc.put(`/apps/${idSegment(id)}/autoscaling`, {
            body: { min, max },
          });
          break;
        }
        default:
          throw new Error(`bunny.net plugin: ${typeId} cannot be edited`);
      }
      return runPluginEffect(this.getResource(typeId, resourceId, accountId));
    });
  }

  // ── Delete and actions ──────────────────────────────────────────────────

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      switch (typeId) {
        case "pull-zone":
          await this.api.core.delete(`/pullzone/${idSegment(id)}`);
          break;
        case "hostname": {
          const { parent, key } = childOf(id);
          await this.api.core.delete(`/pullzone/${idSegment(parent)}/removeHostname`, {
            body: { Hostname: key },
          });
          break;
        }
        case "edge-rule": {
          const { parent, key } = childOf(id);
          await this.api.core.delete(`/pullzone/${idSegment(parent)}/edgerules/${idSegment(key)}`);
          break;
        }
        case "storage-zone":
          await this.api.core.delete(`/storagezone/${idSegment(id)}`);
          break;
        case "dns-zone":
          await this.api.core.delete(`/dnszone/${idSegment(id)}`);
          break;
        case "dns-record": {
          const { parent, key } = childOf(id);
          await this.api.core.delete(`/dnszone/${idSegment(parent)}/records/${idSegment(key)}`);
          break;
        }
        case "video-library":
          await this.api.core.delete(`/videolibrary/${idSegment(id)}`);
          break;
        case "edge-script":
          await this.api.compute.delete(`/compute/script/${idSegment(id)}`);
          break;
        case "container-app":
          await this.api.mc.delete(`/apps/${idSegment(id)}`);
          break;
        default:
          throw new Error(`bunny.net plugin: ${typeId} cannot be deleted`);
      }
      this.invalidate();
    });
  }

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const raw = idSegment(id);
      switch (`${typeId}:${actionId}`) {
        case "pull-zone:purge-all":
          await this.api.core.post(`/pullzone/${raw}/purgeCache`, { body: {} });
          return;
        case "pull-zone:reset-token-key":
          await this.api.core.post(`/pullzone/${raw}/resetSecurityKey`);
          return;
        case "hostname:load-certificate":
          await this.api.core.get("/pullzone/loadFreeCertificate", {
            query: { hostname: childOf(id).key },
          });
          return;
        case "storage-zone:reset-password":
          await this.api.core.post(`/storagezone/${raw}/resetPassword`);
          this.invalidate();
          return;
        case "video-library:reset-api-key":
          await this.api.core.post(`/videolibrary/${raw}/resetApiKey`);
          return;
        case "edge-script:publish":
          await this.api.compute.post(`/compute/script/${raw}/publish`, {
            body: { Note: "Published from Infrawrench" },
          });
          return;
        case "container-app:restart":
          await this.api.mc.post(`/apps/${raw}/restart`);
          return;
        case "container-app:deploy":
          await this.api.mc.post(`/apps/${raw}/deploy`);
          return;
        case "container-app:undeploy":
          await this.api.mc.post(`/apps/${raw}/undeploy`);
          return;
        default:
          throw new Error(`bunny.net plugin: unknown action ${actionId} on ${typeId}`);
      }
    });
  }

  executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): PluginEffect<{ message: string }> {
    return attempt(async () => {
      const values: Record<string, string> = JSON.parse(String(args[0] ?? "{}"));
      const id = externalIdOf(resourceId);
      if (command === "purge-url") {
        const raw = (values["url"] ?? "").trim();
        if (!raw) throw new Error("Enter the URL to purge.");
        const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
        await this.api.core.post("/purge", { query: { url, async: false } });
        return { message: `Purged ${url}.` };
      }
      if (typeId === "pull-zone" && command === "purge-tag") {
        const tag = (values["tag"] ?? "").trim();
        if (!tag) throw new Error("Enter a cache tag.");
        await this.api.core.post(`/pullzone/${idSegment(id)}/purgeCache`, {
          body: { CacheTag: tag },
        });
        return { message: `Purged objects tagged ${tag}.` };
      }
      if (typeId === "pull-zone" && command === "add-hostname") {
        const host = (values["hostname"] ?? "").trim().toLowerCase();
        if (!host) throw new Error("Enter a hostname.");
        await this.api.core.post(`/pullzone/${idSegment(id)}/addHostname`, {
          body: { Hostname: host },
        });
        if (values["certificate"] !== "no") {
          await this.api.core
            .get("/pullzone/loadFreeCertificate", { query: { hostname: host } })
            .catch(() => undefined);
        }
        this.invalidate();
        return { message: `Added ${host}.` };
      }
      throw new Error(`bunny.net plugin: unknown command ${command}`);
    });
  }

  // ── Storage browser (Edge Storage API) ──────────────────────────────────

  private async zoneByName(name: string): Promise<StorageZone & { Password: string }> {
    const z = (await this.storageZones()).find((x) => x.Name === name);
    if (!z?.Password)
      throw new BunnyApiError(404, `bunny.net: storage zone ${name} not found or has no password`);
    return { ...z, Password: z.Password };
  }

  /**
   * A DELETE on a directory is recursive, so a blank key would empty the whole zone, and a
   * dot segment collapses in the URL to somewhere other than the key it came from.
   */
  private objectUrl(z: StorageZone, key: string): string {
    const segments = key.split("/").filter(Boolean);
    if (segments.length === 0 || segments.some((s) => s === "." || s === "..")) {
      throw new Error(`bunny.net plugin: "${key}" does not name a storage object.`);
    }
    return this.storageUrl(z, key);
  }

  private storageUrl(z: StorageZone, path: string): string {
    const host = z.StorageHostname || "storage.bunnycdn.com";
    const encoded = path
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");
    return `https://${host}/${encodeURIComponent(z.Name)}/${encoded}`;
  }

  listStorageObjects(bucket: string, prefix: string): PluginEffect<StorageObject[]> {
    return attempt(async () => {
      const z = await this.zoneByName(bucket);
      const dir = prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix;
      const items = await listStorage(this.ctx, this.storageUrl(z, dir), z.Password);
      return items.map((o) => ({
        key: `${dir}${o.ObjectName}${o.IsDirectory ? "/" : ""}`,
        name: o.ObjectName,
        size: o.Length ?? 0,
        lastModified: o.LastChanged
          ? /[zZ]$/.test(o.LastChanged)
            ? o.LastChanged
            : `${o.LastChanged}Z`
          : "",
        isDirectory: o.IsDirectory === true,
        ...(o.ContentType ? { contentType: o.ContentType } : {}),
      }));
    });
  }

  uploadStorageObject(
    bucket: string,
    key: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): PluginEffect<void> {
    return attempt(async () => {
      const z = await this.zoneByName(bucket);
      await writeStorage(this.ctx, this.objectUrl(z, key), z.Password, {
        method: "PUT",
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      onProgress?.(100);
    });
  }

  makeStorageFolder(bucket: string, key: string): PluginEffect<void> {
    return attempt(async () => {
      // Edge Storage creates directories implicitly; a PUT to the path with a
      // trailing slash makes an empty one.
      const z = await this.zoneByName(bucket);
      await writeStorage(
        this.ctx,
        this.objectUrl(z, key.endsWith("/") ? key : `${key}/`),
        z.Password,
        {
          method: "PUT",
          bytes: new Uint8Array(0),
        },
      );
    });
  }

  deleteStorageObject(bucket: string, key: string): PluginEffect<void> {
    return attempt(async () => {
      // DELETE on a directory removes it recursively.
      const z = await this.zoneByName(bucket);
      await writeStorage(this.ctx, this.objectUrl(z, key), z.Password, { method: "DELETE" });
    });
  }

  // ── Cost, credits, metrics ──────────────────────────────────────────────

  fetchCostData(_accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      const billing = await this.api.core.get("/billing");
      return billingCostRows(billing).filter(
        (r) => r.date >= range.fromDate.slice(0, 8) + "01" && r.date <= range.toDate,
      );
    });
  }

  fetchCreditBalance(_accountId: string): PluginEffect<CreditBalance[]> {
    return attempt(async () => {
      try {
        return creditBalances(await this.api.core.get("/billing"));
      } catch (err) {
        if ([401, 403].includes(statusOf(err))) {
          throw new CreditAccessError(
            "This API key cannot read billing. Use the account API key from Account settings → API key.",
          );
        }
        throw err;
      }
    });
  }

  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      const end = timeRange?.endMs ?? Date.now();
      const start = timeRange?.startMs ?? end - DEFAULT_METRICS_WINDOW_MS;
      const hourly = end - start <= 3 * 86_400_000;
      const dates = { dateFrom: ymd(start), dateTo: ymd(end) };
      const id = externalIdOf(resourceId);
      const raw = idSegment(id);
      switch (resourceTypeId) {
        case "pull-zone":
        case "account": {
          const s = await this.api.core.get("/statistics", {
            query: {
              ...dates,
              hourly,
              loadErrors: true,
              loadOriginResponseTimes: true,
              loadOriginTraffic: true,
              ...(resourceTypeId === "pull-zone" ? { pullZone: id } : {}),
            },
          });
          return [
            series("Bandwidth", "GB", s.BandwidthUsedChart, 1 / 1e9),
            series("Cached bandwidth", "GB", s.BandwidthCachedChart, 1 / 1e9),
            series("Requests", "requests", s.RequestsServedChart),
            series("Cache hit rate", "%", s.CacheHitRateChart),
            series("Origin traffic", "GB", s.OriginTrafficChart, 1 / 1e9),
            series("Origin response time", "ms", s.OriginResponseTimeChart),
            series("3xx responses", "responses", s.Error3xxChart),
            series("4xx responses", "responses", s.Error4xxChart),
            series("5xx responses", "responses", s.Error5xxChart),
          ].filter((x) => x.points.length > 0);
        }
        case "storage-zone": {
          const s = await this.api.core.get(`/storagezone/${raw}/statistics`, { query: dates });
          return [
            series("Storage used", "GB", s.StorageUsedChart, 1 / 1e9),
            series("Files", "files", s.FileCountChart),
          ];
        }
        case "dns-zone": {
          const s = await this.api.core.get(`/dnszone/${raw}/statistics`, { query: dates });
          return [
            series("Queries", "queries", s.QueriesServedChart),
            series("Standard queries", "queries", s.NormalQueriesServedChart),
            series("Smart queries", "queries", s.SmartQueriesServedChart),
          ];
        }
        case "edge-script": {
          const s = await this.api.compute.get(`/compute/script/${raw}/statistics`, {
            query: { ...dates, hourly },
          });
          return [
            series("Requests", "requests", s.RequestsServedChart),
            series("Average CPU time", "ms", s.AverageCpuTimeChart),
            series("Total CPU time", "ms", s.TotalCpuTimeChart),
          ];
        }
        case "container-app": {
          const s = await this.api.mc.get(`/apps/${raw}/statistics`, {
            query: {
              fromDate: new Date(start).toISOString(),
              toDate: new Date(end).toISOString(),
            },
          });
          return [
            series("CPU", "cores", s.cpuUsageChart),
            series("Memory", "MB", s.ramUsageChart),
            series("Traffic", "bytes", s.trafficChart),
            series("Instances", "instances", s.instancesChart),
            series("Latency", "ms", s.latencyChart),
          ].filter((x) => x.points.length > 0);
        }
        default:
          return [];
      }
    });
  }
}

/** DNS record body from form fields (type by name). */
export function recordBody(fields: Record<string, string>): DnsRecordBody {
  return {
    Type: enumIndex(DNS_RECORD_TYPES, fields["type"] ?? "A", "record type"),
    Name: (fields["name"] ?? "").trim(),
    Value: (fields["content"] ?? "").trim(),
    Ttl: int(fields["ttl"]) ?? 300,
    Priority: int(fields["priority"]),
    Weight: int(fields["weight"]),
    Port: int(fields["port"]),
    Disabled: flag(fields["disabled"]),
    Accelerated: flag(fields["accelerated"]),
    Comment: fields["comment"],
  };
}
