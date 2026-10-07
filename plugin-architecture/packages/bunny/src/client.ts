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
import type { BunnyContext } from "./api.js";
import {
  BunnyApiError,
  bunnyFetch,
  bunnyPaged,
  bunnyRaw,
  chartPoints,
  mcPaged,
  statusOf,
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
  Billing,
  ContainerApp,
  DnsZone,
  EdgeRule,
  EdgeScript,
  PullZone,
  StorageZone,
  VideoLibrary,
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
      const v = JSON.parse(t) as unknown;
      if (Array.isArray(v)) return v.map(String).filter(Boolean);
    } catch {
      // fall through
    }
  }
  return splitList(t);
}

function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function series(label: string, unit: string, chart: unknown, scale = 1): MetricSeries {
  return {
    label,
    unit,
    points: chartPoints(chart).map((p) => ({ timestamp: p.timestamp, value: p.value * scale })),
  };
}

/** Body for `POST /pullzone/{id}` from changed form fields. */
export function pullZoneUpdateBody(fields: Record<string, string>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const map: Array<[string, string, "bool" | "int" | "str" | "list"]> = [
    ["originUrl", "OriginUrl", "str"],
    ["monthlyBandwidthLimit", "MonthlyBandwidthLimit", "int"],
    ["cacheMaxAgeOverride", "CacheControlMaxAgeOverride", "int"],
    ["browserMaxAgeOverride", "CacheControlPublicMaxAgeOverride", "int"],
    ["ignoreQueryStrings", "IgnoreQueryStrings", "bool"],
    ["smartCache", "EnableSmartCache", "bool"],
    ["originShield", "EnableOriginShield", "bool"],
    ["logging", "EnableLogging", "bool"],
    ["optimizer", "OptimizerEnabled", "bool"],
    ["verifyOriginSsl", "VerifyOriginSSL", "bool"],
    ["originHostHeader", "OriginHostHeader", "str"],
    ["tokenAuthentication", "ZoneSecurityEnabled", "bool"],
    ["blockedCountries", "BlockedCountries", "list"],
    ["allowedReferrers", "AllowedReferrers", "list"],
    ["blockedIps", "BlockedIps", "list"],
    ["geoUS", "EnableGeoZoneUS", "bool"],
    ["geoEU", "EnableGeoZoneEU", "bool"],
    ["geoASIA", "EnableGeoZoneASIA", "bool"],
    ["geoSA", "EnableGeoZoneSA", "bool"],
    ["geoAF", "EnableGeoZoneAF", "bool"],
  ];
  for (const [key, api, kind] of map) {
    const v = fields[key];
    if (v === undefined) continue;
    if (kind === "bool") body[api] = bool(v) === true;
    else if (kind === "int") body[api] = int(v) ?? 0;
    else if (kind === "list")
      body[api] = splitList(v).map((x) => (api === "BlockedCountries" ? x.toUpperCase() : x));
    else body[api] = v.trim();
  }
  if (body["OriginHostHeader"] !== undefined)
    body["AddHostHeader"] = body["OriginHostHeader"] !== "";
  return body;
}

/** An edge rule from form fields, keeping what the form cannot express. */
export function edgeRuleFromFields(fields: Record<string, string>, current?: EdgeRule): EdgeRule {
  const action = fields["action"] ?? (current ? EDGE_ACTIONS[current.ActionType] : undefined);
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
  const rule: EdgeRule = {
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
  if (!rule.Guid) delete (rule as { Guid?: string }).Guid;
  return rule;
}

export class BunnyClient implements PluginClient {
  private readonly ctx: BunnyContext;
  private pullZonesCache: { at: number; value: Promise<PullZone[]> } | undefined;
  private storageZonesCache: { at: number; value: Promise<StorageZone[]> } | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) throw new Error("bunny.net plugin: missing apiKey credential");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      apiKey,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
  }

  private invalidate(): void {
    this.pullZonesCache = undefined;
    this.storageZonesCache = undefined;
  }

  private pullZones(): Promise<PullZone[]> {
    if (this.pullZonesCache && Date.now() - this.pullZonesCache.at < CACHE_MS)
      return this.pullZonesCache.value;
    const value = bunnyFetch<PullZone[]>(this.ctx, "/pullzone").then((r) => r ?? []);
    this.pullZonesCache = { at: Date.now(), value };
    value.catch(() => (this.pullZonesCache = undefined));
    return value;
  }

  private storageZones(): Promise<StorageZone[]> {
    if (this.storageZonesCache && Date.now() - this.storageZonesCache.at < CACHE_MS)
      return this.storageZonesCache.value;
    const value = bunnyFetch<StorageZone[]>(this.ctx, "/storagezone").then((r) =>
      (r ?? []).filter((z) => !z.Deleted),
    );
    this.storageZonesCache = { at: Date.now(), value };
    value.catch(() => (this.storageZonesCache = undefined));
    return value;
  }

  private async dnsZones(): Promise<DnsZone[]> {
    return bunnyPaged<DnsZone>(this.ctx, "/dnszone");
  }

  private async pullZone(id: string): Promise<PullZone> {
    return bunnyFetch<PullZone>(this.ctx, `/pullzone/${encodeURIComponent(id)}`);
  }

  // ── Listing ─────────────────────────────────────────────────────────────

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
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
        return (await bunnyPaged<VideoLibrary>(this.ctx, "/videolibrary")).map((l) =>
          libraryInstance(accountId, l),
        );
      case "edge-script":
        return (
          await bunnyPaged<EdgeScript>(this.ctx, "/compute/script", {
            includeLinkedPullzones: true,
          })
        )
          .filter((s) => !s.Deleted)
          .map((s) => scriptInstance(accountId, s));
      case "container-app": {
        try {
          const items = await mcPaged<{ id: string }>(this.ctx, "/apps");
          const apps = await Promise.all(
            items.map((a) =>
              bunnyFetch<ContainerApp>(this.ctx, `/mc/apps/${encodeURIComponent(a.id)}`),
            ),
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
  }

  private async accountInstance(accountId: string): Promise<ResourceInstance> {
    const [billing, pz, sz, dns] = await Promise.all([
      bunnyFetch<Billing>(this.ctx, "/billing").catch(() => undefined),
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

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "pull-zone":
        return pullZoneInstance(accountId, await this.pullZone(id));
      case "storage-zone":
        return storageZoneInstance(
          accountId,
          await bunnyFetch<StorageZone>(this.ctx, `/storagezone/${encodeURIComponent(id)}`),
        );
      case "dns-zone":
        return dnsZoneInstance(
          accountId,
          await bunnyFetch<DnsZone>(this.ctx, `/dnszone/${encodeURIComponent(id)}`),
        );
      case "dns-record": {
        const { parent, key } = splitChild(id);
        const zone = await bunnyFetch<DnsZone>(this.ctx, `/dnszone/${encodeURIComponent(parent)}`);
        const rec = (zone.Records ?? []).find((r) => String(r.Id) === key);
        if (!rec) throw new BunnyApiError(404, `bunny.net: DNS record ${id} not found`);
        return dnsRecordInstance(accountId, zone, rec);
      }
      case "video-library":
        return libraryInstance(
          accountId,
          await bunnyFetch<VideoLibrary>(this.ctx, `/videolibrary/${encodeURIComponent(id)}`),
        );
      case "edge-script":
        return scriptInstance(
          accountId,
          await bunnyFetch<EdgeScript>(this.ctx, `/compute/script/${encodeURIComponent(id)}`),
        );
      case "container-app":
        return appInstance(
          accountId,
          await bunnyFetch<ContainerApp>(this.ctx, `/mc/apps/${encodeURIComponent(id)}`),
        );
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
        const found = (await this.listResources(typeId, accountId)).find(
          (r) => r.externalId === id,
        );
        if (!found) throw new BunnyApiError(404, `bunny.net: ${typeId} ${id} not found`);
        return found;
      }
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    _accountId: string,
  ): Promise<string> {
    const id = externalIdOf(resourceId);
    if (typeId === "pull-zone") {
      const z = await this.pullZone(id);
      if (outputKey === "cdnHostname") return systemHostname(z);
      if (outputKey === "cdnUrl") return `https://${systemHostname(z)}`;
      if (outputKey === "tokenKey") return z.ZoneSecurityKey ?? "";
    }
    if (typeId === "hostname" && outputKey === "url") return `https://${splitChild(id).key}`;
    if (typeId === "storage-zone") {
      const z = await bunnyFetch<StorageZone>(this.ctx, `/storagezone/${encodeURIComponent(id)}`);
      if (outputKey === "storageHostname") return z.StorageHostname ?? "";
      if (outputKey === "password") return z.Password ?? "";
      if (outputKey === "readOnlyPassword") return z.ReadOnlyPassword ?? "";
      if (outputKey === "ftpUsername") return z.Name;
    }
    if (typeId === "dns-zone" && outputKey === "nameservers") {
      const z = await bunnyFetch<DnsZone>(this.ctx, `/dnszone/${encodeURIComponent(id)}`);
      return [z.Nameserver1, z.Nameserver2].filter(Boolean).join(", ");
    }
    if (typeId === "video-library") {
      if (outputKey === "libraryId") return id;
      const l = await bunnyFetch<VideoLibrary>(this.ctx, `/videolibrary/${encodeURIComponent(id)}`);
      if (outputKey === "apiKey") return l.ApiKey ?? "";
      if (outputKey === "readOnlyApiKey") return l.ReadOnlyApiKey ?? "";
    }
    if (typeId === "edge-script" && outputKey === "url") {
      const s = await bunnyFetch<EdgeScript>(this.ctx, `/compute/script/${encodeURIComponent(id)}`);
      const h = s.DefaultHostname ?? s.SystemHostname ?? "";
      return h ? `https://${h}` : "";
    }
    if (typeId === "container-app" && outputKey === "endpoint") {
      const a = await bunnyFetch<ContainerApp>(this.ctx, `/mc/apps/${encodeURIComponent(id)}`);
      return a.displayEndpoint?.address ?? "";
    }
    throw new Error(`bunny.net plugin: unknown output ${outputKey} on ${typeId}`);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderBunnyDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderBunnySidebar(resource);
  }

  async verifyCredentials(): Promise<PreflightResult> {
    const probe = async (id: string, fn: () => Promise<unknown>) => {
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
        probe("resources", () => bunnyFetch(this.ctx, "/pullzone")),
        probe("costs", () => bunnyFetch(this.ctx, "/billing")),
        probe("containers", () => mcPaged(this.ctx, "/apps", 1)),
      ]),
    };
  }

  // ── Create ──────────────────────────────────────────────────────────────

  private async storageRegionOptions(): Promise<
    Array<{ id: string; label: string; description?: string }>
  > {
    const regions = await bunnyFetch<Array<{ Id: string; Name: string; Url?: string }>>(
      this.ctx,
      "/storagezone/regions",
    ).catch(() => []);
    return (regions ?? []).map((r) => ({ id: r.Id, label: r.Name, description: r.Id }));
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
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
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const parent = parentResourceId ? externalIdOf(parentResourceId) : "";
    switch (typeId) {
      case "pull-zone": {
        const storage = fields["originType"] === "storage";
        if (storage && !fields["storageZoneId"]) throw new Error("Pick a storage zone.");
        if (!storage && !/^https?:\/\//i.test(fields["originUrl"] ?? ""))
          throw new Error("Enter the origin URL, starting with http:// or https://.");
        const z = await bunnyFetch<PullZone>(this.ctx, "/pullzone", {
          method: "POST",
          json: {
            Name: (fields["name"] ?? "").trim(),
            Type: Number(fields["type"] ?? 0),
            ...(storage
              ? { OriginType: 1, StorageZoneId: Number(fields["storageZoneId"]) }
              : { OriginUrl: fields["originUrl"] }),
          },
        });
        this.invalidate();
        return pullZoneInstance(accountId, z);
      }
      case "hostname": {
        const pz = fields["pullZoneId"] || parent;
        const host = (fields["hostname"] ?? "").trim().toLowerCase();
        await bunnyFetch(this.ctx, `/pullzone/${pz}/addHostname`, {
          method: "POST",
          json: { Hostname: host },
        });
        if (fields["certificate"] !== "no") {
          await bunnyFetch(this.ctx, "/pullzone/loadFreeCertificate", {
            query: { hostname: host },
          }).catch(() => undefined);
        }
        this.invalidate();
        return this.getResource("hostname", `${accountId}:hostname:${pz}/${host}`, accountId);
      }
      case "edge-rule": {
        const pz = fields["pullZoneId"] || parent;
        const before = new Set(((await this.pullZone(pz)).EdgeRules ?? []).map((r) => r.Guid));
        await bunnyFetch(this.ctx, `/pullzone/${pz}/edgerules/addOrUpdate`, {
          method: "POST",
          json: edgeRuleFromFields(fields),
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
        const z = await bunnyFetch<StorageZone>(this.ctx, "/storagezone", {
          method: "POST",
          json: {
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
        const z = await bunnyFetch<DnsZone>(this.ctx, "/dnszone", {
          method: "POST",
          json: { Domain: (fields["domain"] ?? "").trim().toLowerCase() },
        });
        return dnsZoneInstance(accountId, z);
      }
      case "dns-record": {
        const zoneId = fields["zoneId"] || parent;
        const rec = await bunnyFetch<{ Id: number }>(this.ctx, `/dnszone/${zoneId}/records`, {
          method: "PUT",
          json: recordBody(fields),
        });
        return this.getResource(
          "dns-record",
          `${accountId}:dns-record:${zoneId}/${rec.Id}`,
          accountId,
        );
      }
      case "video-library": {
        const l = await bunnyFetch<VideoLibrary>(this.ctx, "/videolibrary", {
          method: "POST",
          json: {
            Name: (fields["name"] ?? "").trim(),
            ReplicationRegions: parsePicked(fields["replicationRegions"]),
          },
        });
        return libraryInstance(accountId, l);
      }
      case "edge-script": {
        const s = await bunnyFetch<EdgeScript>(this.ctx, "/compute/script", {
          method: "POST",
          json: {
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
  }

  // ── Update ──────────────────────────────────────────────────────────────

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "pull-zone":
        await bunnyFetch(this.ctx, `/pullzone/${id}`, {
          method: "POST",
          json: pullZoneUpdateBody(fields),
        });
        this.invalidate();
        break;
      case "hostname": {
        const { parent, key } = splitChild(id);
        if (fields["forceSsl"] !== undefined) {
          await bunnyFetch(this.ctx, `/pullzone/${parent}/setForceSSL`, {
            method: "POST",
            json: { Hostname: key, ForceSSL: bool(fields["forceSsl"]) === true },
          });
        }
        this.invalidate();
        break;
      }
      case "edge-rule": {
        const { parent, key } = splitChild(id);
        const current = ((await this.pullZone(parent)).EdgeRules ?? []).find((r) => r.Guid === key);
        if (!current) throw new BunnyApiError(404, "That edge rule no longer exists.");
        const onlyEnabled = Object.keys(fields).every((k) => k === "enabled");
        if (onlyEnabled) {
          await bunnyFetch(this.ctx, `/pullzone/${parent}/edgerules/${key}/setEdgeRuleEnabled`, {
            method: "POST",
            json: { Id: Number(parent), Value: bool(fields["enabled"]) === true },
          });
        } else {
          await bunnyFetch(this.ctx, `/pullzone/${parent}/edgerules/addOrUpdate`, {
            method: "POST",
            json: edgeRuleFromFields(fields, current),
          });
        }
        this.invalidate();
        break;
      }
      case "storage-zone": {
        const body: Record<string, unknown> = {};
        if (fields["replicationRegions"] !== undefined)
          body["ReplicationZones"] = splitList(fields["replicationRegions"]).map((r) =>
            r.toUpperCase(),
          );
        if (fields["rewrite404To200"] !== undefined)
          body["Rewrite404To200"] = bool(fields["rewrite404To200"]) === true;
        if (fields["custom404FilePath"] !== undefined)
          body["Custom404FilePath"] = fields["custom404FilePath"];
        await bunnyFetch(this.ctx, `/storagezone/${id}`, { method: "POST", json: body });
        this.invalidate();
        break;
      }
      case "dns-zone": {
        const body: Record<string, unknown> = {};
        if (fields["soaEmail"] !== undefined) body["SoaEmail"] = fields["soaEmail"];
        if (fields["logging"] !== undefined)
          body["LoggingEnabled"] = bool(fields["logging"]) === true;
        if (Object.keys(body).length > 0)
          await bunnyFetch(this.ctx, `/dnszone/${id}`, { method: "POST", json: body });
        if (fields["dnssec"] !== undefined) {
          await bunnyFetch(this.ctx, `/dnszone/${id}/dnssec`, {
            method: bool(fields["dnssec"]) ? "POST" : "DELETE",
          });
        }
        break;
      }
      case "dns-record": {
        const { parent, key } = splitChild(id);
        const current = await this.getResource("dns-record", resourceId, accountId);
        const merged: Record<string, string> = {};
        for (const [k, v] of Object.entries(current.fields)) merged[k] = String(v);
        Object.assign(merged, fields);
        await bunnyFetch(this.ctx, `/dnszone/${parent}/records/${key}`, {
          method: "POST",
          json: { ...recordBody(merged), Id: Number(key) },
        });
        break;
      }
      case "video-library": {
        const body: Record<string, unknown> = {};
        const map: Array<[string, string, "bool" | "str"]> = [
          ["name", "Name", "str"],
          ["resolutions", "EnabledResolutions", "str"],
          ["webhookUrl", "WebhookUrl", "str"],
          ["mp4Fallback", "EnableMP4Fallback", "bool"],
          ["keepOriginals", "KeepOriginalFiles", "bool"],
          ["directPlay", "AllowDirectPlay", "bool"],
          ["transcribing", "EnableTranscribing", "bool"],
          ["tokenAuthentication", "PlayerTokenAuthenticationEnabled", "bool"],
          ["blockNoReferrer", "BlockNoneReferrer", "bool"],
        ];
        for (const [k, api, kind] of map) {
          const v = fields[k];
          if (v !== undefined) body[api] = kind === "bool" ? bool(v) === true : v;
        }
        await bunnyFetch(this.ctx, `/videolibrary/${id}`, { method: "POST", json: body });
        break;
      }
      case "edge-script":
        if (fields["name"] !== undefined) {
          await bunnyFetch(this.ctx, `/compute/script/${id}`, {
            method: "POST",
            json: { Name: fields["name"] },
          });
        }
        break;
      case "container-app": {
        const app = await bunnyFetch<ContainerApp>(this.ctx, `/mc/apps/${id}`);
        const min = int(fields["minInstances"]) ?? app.autoScaling?.min ?? 1;
        const max = int(fields["maxInstances"]) ?? app.autoScaling?.max ?? min;
        if (max < min) throw new Error("Max instances must be at least min instances.");
        await bunnyFetch(this.ctx, `/mc/apps/${id}/autoscaling`, {
          method: "PUT",
          json: { min, max },
        });
        break;
      }
      default:
        throw new Error(`bunny.net plugin: ${typeId} cannot be edited`);
    }
    return this.getResource(typeId, resourceId, accountId);
  }

  // ── Delete and actions ──────────────────────────────────────────────────

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "pull-zone":
        await bunnyFetch(this.ctx, `/pullzone/${id}`, { method: "DELETE" });
        break;
      case "hostname": {
        const { parent, key } = splitChild(id);
        await bunnyFetch(this.ctx, `/pullzone/${parent}/removeHostname`, {
          method: "DELETE",
          json: { Hostname: key },
        });
        break;
      }
      case "edge-rule": {
        const { parent, key } = splitChild(id);
        await bunnyFetch(this.ctx, `/pullzone/${parent}/edgerules/${key}`, { method: "DELETE" });
        break;
      }
      case "storage-zone":
        await bunnyFetch(this.ctx, `/storagezone/${id}`, { method: "DELETE" });
        break;
      case "dns-zone":
        await bunnyFetch(this.ctx, `/dnszone/${id}`, { method: "DELETE" });
        break;
      case "dns-record": {
        const { parent, key } = splitChild(id);
        await bunnyFetch(this.ctx, `/dnszone/${parent}/records/${key}`, { method: "DELETE" });
        break;
      }
      case "video-library":
        await bunnyFetch(this.ctx, `/videolibrary/${id}`, { method: "DELETE" });
        break;
      case "edge-script":
        await bunnyFetch(this.ctx, `/compute/script/${id}`, { method: "DELETE" });
        break;
      case "container-app":
        await bunnyFetch(this.ctx, `/mc/apps/${id}`, { method: "DELETE" });
        break;
      default:
        throw new Error(`bunny.net plugin: ${typeId} cannot be deleted`);
    }
    this.invalidate();
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const id = externalIdOf(resourceId);
    const call = (
      path: string,
      init: { method?: string; json?: unknown; query?: Record<string, string> } = {},
    ) => bunnyFetch(this.ctx, path, { method: "POST", ...init });
    switch (`${typeId}:${actionId}`) {
      case "pull-zone:purge-all":
        await call(`/pullzone/${id}/purgeCache`, { json: {} });
        return;
      case "pull-zone:reset-token-key":
        await call(`/pullzone/${id}/resetSecurityKey`);
        return;
      case "hostname:load-certificate":
        await bunnyFetch(this.ctx, "/pullzone/loadFreeCertificate", {
          query: { hostname: splitChild(id).key },
        });
        return;
      case "storage-zone:reset-password":
        await call(`/storagezone/${id}/resetPassword`);
        this.invalidate();
        return;
      case "video-library:reset-api-key":
        await call(`/videolibrary/${id}/resetApiKey`);
        return;
      case "edge-script:publish":
        await call(`/compute/script/${id}/publish`, {
          json: { Note: "Published from Infrawrench" },
        });
        return;
      case "container-app:restart":
        await call(`/mc/apps/${id}/restart`);
        return;
      case "container-app:deploy":
        await call(`/mc/apps/${id}/deploy`);
        return;
      case "container-app:undeploy":
        await call(`/mc/apps/${id}/undeploy`);
        return;
      default:
        throw new Error(`bunny.net plugin: unknown action ${actionId} on ${typeId}`);
    }
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const values = JSON.parse(String(args[0] ?? "{}")) as Record<string, string>;
    const id = externalIdOf(resourceId);
    if (command === "purge-url") {
      const raw = (values["url"] ?? "").trim();
      if (!raw) throw new Error("Enter the URL to purge.");
      const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      await bunnyFetch(this.ctx, "/purge", { method: "POST", query: { url, async: false } });
      return { message: `Purged ${url}.` };
    }
    if (typeId === "pull-zone" && command === "purge-tag") {
      const tag = (values["tag"] ?? "").trim();
      if (!tag) throw new Error("Enter a cache tag.");
      await bunnyFetch(this.ctx, `/pullzone/${id}/purgeCache`, {
        method: "POST",
        json: { CacheTag: tag },
      });
      return { message: `Purged objects tagged ${tag}.` };
    }
    if (typeId === "pull-zone" && command === "add-hostname") {
      const host = (values["hostname"] ?? "").trim().toLowerCase();
      if (!host) throw new Error("Enter a hostname.");
      await bunnyFetch(this.ctx, `/pullzone/${id}/addHostname`, {
        method: "POST",
        json: { Hostname: host },
      });
      if (values["certificate"] !== "no") {
        await bunnyFetch(this.ctx, "/pullzone/loadFreeCertificate", {
          query: { hostname: host },
        }).catch(() => undefined);
      }
      this.invalidate();
      return { message: `Added ${host}.` };
    }
    throw new Error(`bunny.net plugin: unknown command ${command}`);
  }

  // ── Storage browser (Edge Storage API) ──────────────────────────────────

  private async zoneByName(name: string): Promise<StorageZone> {
    const z = (await this.storageZones()).find((x) => x.Name === name);
    if (!z?.Password)
      throw new BunnyApiError(404, `bunny.net: storage zone ${name} not found or has no password`);
    return z;
  }

  private storageUrl(z: StorageZone, path: string): string {
    const host = z.StorageHostname || "storage.bunnycdn.com";
    const encoded = path
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");
    return `https://${host}/${encodeURIComponent(z.Name)}/${encoded}`;
  }

  async listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    const z = await this.zoneByName(bucket);
    const dir = prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix;
    const res = await bunnyRaw(this.ctx, this.storageUrl(z, dir), { accessKey: z.Password! });
    const items = JSON.parse(res.body || "[]") as Array<{
      ObjectName: string;
      Length?: number;
      LastChanged?: string;
      IsDirectory?: boolean;
      ContentType?: string;
    }>;
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
  }

  async uploadStorageObject(
    bucket: string,
    key: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    const z = await this.zoneByName(bucket);
    await bunnyRaw(this.ctx, this.storageUrl(z, key), {
      method: "PUT",
      accessKey: z.Password!,
      body: new Uint8Array(await file.arrayBuffer()),
      headers: { "Content-Type": "application/octet-stream" },
    });
    onProgress?.(100);
  }

  async makeStorageFolder(bucket: string, key: string): Promise<void> {
    // Edge Storage creates directories implicitly; a PUT to the path with a
    // trailing slash makes an empty one.
    const z = await this.zoneByName(bucket);
    await bunnyRaw(this.ctx, this.storageUrl(z, key.endsWith("/") ? key : `${key}/`), {
      method: "PUT",
      accessKey: z.Password!,
      body: new Uint8Array(0),
      headers: { "Content-Type": "application/octet-stream" },
    });
  }

  async deleteStorageObject(bucket: string, key: string): Promise<void> {
    // DELETE on a directory removes it recursively.
    const z = await this.zoneByName(bucket);
    await bunnyRaw(this.ctx, this.storageUrl(z, key), { method: "DELETE", accessKey: z.Password! });
  }

  // ── Cost, credits, metrics ──────────────────────────────────────────────

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    const billing = await bunnyFetch<Billing>(this.ctx, "/billing");
    return billingCostRows(billing).filter(
      (r) => r.date >= range.fromDate.slice(0, 8) + "01" && r.date <= range.toDate,
    );
  }

  async fetchCreditBalance(_accountId: string): Promise<CreditBalance[]> {
    try {
      return creditBalances(await bunnyFetch<Billing>(this.ctx, "/billing"));
    } catch (err) {
      if ([401, 403].includes(statusOf(err))) {
        throw new CreditAccessError(
          "This API key cannot read billing. Use the account API key from Account settings → API key.",
        );
      }
      throw err;
    }
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const end = timeRange?.endMs ?? Date.now();
    const start = timeRange?.startMs ?? end - DEFAULT_METRICS_WINDOW_MS;
    const hourly = end - start <= 3 * 86_400_000;
    const dates = { dateFrom: ymd(start), dateTo: ymd(end) };
    const id = externalIdOf(resourceId);
    switch (resourceTypeId) {
      case "pull-zone":
      case "account": {
        const s = await bunnyFetch<Record<string, unknown>>(this.ctx, "/statistics", {
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
          series("Bandwidth", "GB", s["BandwidthUsedChart"], 1 / 1e9),
          series("Cached bandwidth", "GB", s["BandwidthCachedChart"], 1 / 1e9),
          series("Requests", "requests", s["RequestsServedChart"]),
          series("Cache hit rate", "%", s["CacheHitRateChart"]),
          series("Origin traffic", "GB", s["OriginTrafficChart"], 1 / 1e9),
          series("Origin response time", "ms", s["OriginResponseTimeChart"]),
          series("3xx responses", "responses", s["Error3xxChart"]),
          series("4xx responses", "responses", s["Error4xxChart"]),
          series("5xx responses", "responses", s["Error5xxChart"]),
        ].filter((x) => x.points.length > 0);
      }
      case "storage-zone": {
        const s = await bunnyFetch<Record<string, unknown>>(
          this.ctx,
          `/storagezone/${id}/statistics`,
          { query: dates },
        );
        return [
          series("Storage used", "GB", s["StorageUsedChart"], 1 / 1e9),
          series("Files", "files", s["FileCountChart"]),
        ];
      }
      case "dns-zone": {
        const s = await bunnyFetch<Record<string, unknown>>(this.ctx, `/dnszone/${id}/statistics`, {
          query: dates,
        });
        return [
          series("Queries", "queries", s["QueriesServedChart"]),
          series("Standard queries", "queries", s["NormalQueriesServedChart"]),
          series("Smart queries", "queries", s["SmartQueriesServedChart"]),
        ];
      }
      case "edge-script": {
        const s = await bunnyFetch<Record<string, unknown>>(
          this.ctx,
          `/compute/script/${id}/statistics`,
          { query: { ...dates, hourly } },
        );
        return [
          series("Requests", "requests", s["RequestsServedChart"]),
          series("Average CPU time", "ms", s["AverageCpuTimeChart"]),
          series("Total CPU time", "ms", s["TotalCpuTimeChart"]),
        ];
      }
      case "container-app": {
        const s = await bunnyFetch<Record<string, unknown>>(this.ctx, `/mc/apps/${id}/statistics`, {
          query: { fromDate: new Date(start).toISOString(), toDate: new Date(end).toISOString() },
        });
        return [
          series("CPU", "cores", s["cpuUsageChart"]),
          series("Memory", "MB", s["ramUsageChart"]),
          series("Traffic", "bytes", s["trafficChart"]),
          series("Instances", "instances", s["instancesChart"]),
          series("Latency", "ms", s["latencyChart"]),
        ].filter((x) => x.points.length > 0);
      }
      default:
        return [];
    }
  }
}

/** DNS record body from form fields (type by name). */
export function recordBody(fields: Record<string, string>): Record<string, unknown> {
  const type = fields["type"] ?? "A";
  const body: Record<string, unknown> = {
    Type: enumIndex(DNS_RECORD_TYPES, type, "record type"),
    Name: (fields["name"] ?? "").trim(),
    Value: (fields["content"] ?? "").trim(),
    Ttl: int(fields["ttl"]) ?? 300,
  };
  for (const [k, api] of [
    ["priority", "Priority"],
    ["weight", "Weight"],
    ["port", "Port"],
  ] as const) {
    const v = int(fields[k]);
    if (v !== undefined) body[api] = v;
  }
  if (fields["disabled"] !== undefined) body["Disabled"] = bool(fields["disabled"]) === true;
  if (fields["accelerated"] !== undefined)
    body["Accelerated"] = bool(fields["accelerated"]) === true;
  if (fields["comment"] !== undefined) body["Comment"] = fields["comment"];
  return body;
}
