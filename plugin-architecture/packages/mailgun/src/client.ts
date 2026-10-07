import type {
  CreateFieldConfig,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  QuotaUsage,
  ResourceInstance,
  SelectOption,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { QuotaAccessError, externalIdOf } from "@infrawrench/plugin-base";
import type { FormValue, MailgunContext, MailgunRegion, MailgunRequest } from "./api.js";
import { REGIONS, listPaging, listSkip, mailgunFetch, statusOf } from "./api.js";
import type {
  DomainBundle,
  MgAccountWebhook,
  MgCredential,
  MgDomain,
  MgDomainDetail,
  MgIpDetail,
  MgIpPool,
  MgKey,
  MgList,
  MgRoute,
  MgSubaccount,
  MgTag,
  MgTracking,
} from "./mappers.js";
import {
  eventsFrom,
  groupWebhooks,
  mapAccountWebhook,
  mapCredential,
  mapDnsRecords,
  mapDomain,
  mapIp,
  mapIpPool,
  mapKey,
  mapList,
  mapRoute,
  mapSubaccount,
  mapTag,
  mapWebhook,
  parseActions,
  splitRegion,
} from "./mappers.js";
import { queryMetrics, rangeOrDefault, seriesFromItems, totals } from "./metrics.js";
import type { MemberRow, QueueStatus } from "./render.js";
import {
  AVAILABLE_IPS_KEY,
  COMMANDS,
  DOMAINS_KEY,
  MEMBERS_KEY,
  QUEUES_KEY,
  STATS_KEY,
  SUPPRESSIONS_KEY,
  SUPPRESSION_LISTS,
  renderMailgunDetail,
  renderMailgunSidebar,
} from "./render.js";
import { WEBHOOK_EVENTS, eventFieldKey } from "./resource-types.js";

const CACHE_MS = 60_000;
const CONCURRENCY = 4;
const MAX_ADDRESSES = 1000;
const DAY_MS = 86_400_000;

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const bool = (v: string | undefined): boolean | undefined =>
  v === undefined || v === "" ? undefined : v === "true";

const trimmed = (fields: Record<string, string>, key: string): string => (fields[key] ?? "").trim();

/** "us", "eu" or "both" (the default) → the regions to read. */
export function resolveRegions(raw: string | undefined): MailgunRegion[] {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "us") return ["us"];
  if (v === "eu") return ["eu"];
  return [...REGIONS];
}

export function parsePromptValues(args: (string | number)[]): Record<string, string> {
  const first = args[0];
  if (typeof first !== "string" || !first) return {};
  try {
    const parsed = JSON.parse(first) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v ?? "")]));
  } catch {
    return {};
  }
}

export function parseAddresses(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter((s) => s.includes("@")),
    ),
  ].slice(0, MAX_ADDRESSES);
}

function isUnavailable(err: unknown): boolean {
  const s = statusOf(err);
  return s === 403 || s === 404;
}

function stash(r: ResourceInstance, extras: Record<string, unknown>): ResourceInstance {
  const out: Record<string, string> = { ...r.resolvedOutputs };
  for (const [k, v] of Object.entries(extras)) {
    if (v !== undefined) out[k] = JSON.stringify(v);
  }
  return { ...r, resolvedOutputs: out };
}

function notFound(typeId: string, resourceId: string): Error {
  return Object.assign(new Error(`Mailgun plugin: ${typeId} ${resourceId} not found`), {
    status: 404,
  });
}

const DOMAIN_FORM: Record<string, string> = {
  spamAction: "spam_action",
  webScheme: "web_scheme",
  webPrefix: "web_prefix",
  wildcard: "wildcard",
  requireTls: "require_tls",
  skipVerification: "skip_verification",
  automaticSenderSecurity: "use_automatic_sender_security",
  messageTtl: "message_ttl",
  archiveTo: "archive_to",
};

/** Edited domain fields → `PUT /v4/domains/{name}` form (only what changed). */
export function domainForm(fields: Record<string, string>): Record<string, FormValue> {
  const form: Record<string, FormValue> = {};
  for (const [key, param] of Object.entries(DOMAIN_FORM)) {
    if (!(key in fields)) continue;
    const v = (fields[key] ?? "").trim();
    if (key === "messageTtl" && v === "") continue;
    form[param] = v;
  }
  return form;
}

export class MailgunClient implements PluginClient {
  readonly ctx: MailgunContext;
  private domainCache: Cached<DomainBundle[]> | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) throw new Error("Mailgun plugin: missing API key");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      apiKey,
      regions: resolveRegions(credentials["region"]),
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
  }

  /** Account-level calls (keys, IPs, pools, subaccounts, limits) go to the first region. */
  private get home(): MailgunRegion {
    return this.ctx.regions[0] ?? "us";
  }

  private call<T>(region: MailgunRegion, path: string, req: MailgunRequest = {}): Promise<T> {
    return mailgunFetch<T>(this.ctx, region, path, req);
  }

  private async scoped(load: () => Promise<ResourceInstance[]>): Promise<ResourceInstance[]> {
    try {
      return await load();
    } catch (err) {
      if (isUnavailable(err)) return [];
      throw err;
    }
  }

  /** Run `fn` in every configured region; a region the key cannot read is skipped. */
  private async perRegion<T>(fn: (region: MailgunRegion) => Promise<T[]>): Promise<T[]> {
    const results = await Promise.all(
      this.ctx.regions.map((region) =>
        fn(region).catch((err) => {
          if (isUnavailable(err) || (statusOf(err) === 401 && this.ctx.regions.length > 1))
            return [] as T[];
          throw err;
        }),
      ),
    );
    return results.flat();
  }

  // -------------------------------------------------------------------------
  // Domains (shared by the domain, DNS, webhook and credential listers)
  // -------------------------------------------------------------------------

  private domainSummaries(): Promise<Array<{ region: MailgunRegion; domain: MgDomain }>> {
    return this.perRegion(async (region) =>
      (await listSkip<MgDomain>(this.ctx, region, "/v4/domains", {}, 1000)).map((domain) => ({
        region,
        domain,
      })),
    );
  }

  private async domainBundle(region: MailgunRegion, name: string): Promise<DomainBundle> {
    const enc = encodeURIComponent(name);
    const [detail, tracking, pool] = await Promise.all([
      this.call<MgDomainDetail>(region, `/v4/domains/${enc}`),
      this.call<{ tracking?: MgTracking }>(region, `/v3/domains/${enc}/tracking`).catch(
        () => undefined,
      ),
      this.call<{ extra_dedicated_ips?: { pool_id?: string } }>(
        region,
        `/v3/ips/domain/${enc}`,
      ).catch(() => undefined),
    ]);
    return {
      region,
      detail,
      ...(tracking?.tracking ? { tracking: tracking.tracking } : {}),
      ...(pool?.extra_dedicated_ips?.pool_id ? { ipPoolId: pool.extra_dedicated_ips.pool_id } : {}),
    };
  }

  private domains(): Promise<DomainBundle[]> {
    if (this.domainCache && Date.now() - this.domainCache.at < CACHE_MS)
      return this.domainCache.value;
    const value = (async () => {
      const summaries = await this.domainSummaries();
      return mapLimit(summaries, CONCURRENCY, ({ region, domain }) =>
        this.domainBundle(region, domain.name ?? "").catch((): DomainBundle => ({
          region,
          detail: { domain },
        })),
      );
    })();
    value.catch(() => {
      if (this.domainCache?.value === value) this.domainCache = undefined;
    });
    this.domainCache = { at: Date.now(), value };
    return value;
  }

  private invalidate(): void {
    this.domainCache = undefined;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "mailgun-account":
        return [await this.loadAccount(accountId)];
      case "mailgun-domain":
        return (await this.domains()).map((b) => mapDomain(accountId, b));
      case "mailgun-dns-record":
        return (await this.domains()).flatMap((b) => mapDnsRecords(accountId, b));
      case "mailgun-api-key":
        return this.scoped(async () => {
          const res = await this.call<{ items?: MgKey[] }>(this.home, "/v1/keys");
          return (res?.items ?? []).map((k) => mapKey(accountId, k));
        });
      case "mailgun-webhook": {
        const domains = await this.domainSummaries();
        const lists = await mapLimit(domains, CONCURRENCY, async ({ region, domain }) => {
          const name = domain.name ?? "";
          const res = await this.call<{ webhooks?: Record<string, { urls?: string[] } | null> }>(
            region,
            `/v3/domains/${encodeURIComponent(name)}/webhooks`,
          ).catch(() => undefined);
          return [...groupWebhooks(res?.webhooks ?? {})].map(([url, events]) =>
            mapWebhook(accountId, region, name, url, events),
          );
        });
        return lists.flat();
      }
      case "mailgun-account-webhook":
        return this.scoped(async () => {
          const res = await this.call<{ webhooks?: MgAccountWebhook[] }>(this.home, "/v1/webhooks");
          return (res?.webhooks ?? []).map((w) => mapAccountWebhook(accountId, w));
        });
      case "mailgun-route":
        return this.perRegion(async (region) =>
          (await listSkip<MgRoute>(this.ctx, region, "/v3/routes", {}, 1000)).map((r) =>
            mapRoute(accountId, region, r),
          ),
        );
      case "mailgun-mailing-list":
        return this.perRegion(async (region) =>
          (await listPaging<MgList>(this.ctx, region, "/v3/lists/pages", { limit: 100 })).map((l) =>
            mapList(accountId, region, l),
          ),
        );
      case "mailgun-smtp-credential": {
        const domains = await this.domainSummaries();
        const lists = await mapLimit(domains, CONCURRENCY, async ({ region, domain }) => {
          const name = domain.name ?? "";
          const creds = await listSkip<MgCredential>(
            this.ctx,
            region,
            `/v3/domains/${encodeURIComponent(name)}/credentials`,
          ).catch(() => [] as MgCredential[]);
          return creds.map((c) => mapCredential(accountId, region, name, c));
        });
        return lists.flat();
      }
      case "mailgun-ip-pool":
        return this.scoped(async () => (await this.pools()).map((p) => mapIpPool(accountId, p)));
      case "mailgun-ip":
        return this.scoped(async () => {
          const [ips, pools] = await Promise.all([
            this.ips(),
            this.pools().catch(() => [] as MgIpPool[]),
          ]);
          return ips.map((ip) =>
            mapIp(
              accountId,
              ip,
              pools.filter((p) => (p.ips ?? []).includes(ip.ip ?? "")).map((p) => p.pool_id ?? ""),
            ),
          );
        });
      case "mailgun-tag":
        return this.perRegion(async (region) => {
          const out: ResourceInstance[] = [];
          for (let skip = 0; skip < 5000; skip += 100) {
            const res = await this.call<{ items?: MgTag[] }>(region, "/v1/analytics/tags", {
              json: {
                pagination: { sort: "lastseen:desc", skip, limit: 100 },
                include_subaccounts: false,
              },
            });
            const items = res?.items ?? [];
            out.push(...items.map((t) => mapTag(accountId, region, t)));
            if (items.length < 100) break;
          }
          return out;
        });
      case "mailgun-subaccount":
        return this.scoped(async () =>
          (await this.subaccounts()).map((s) => mapSubaccount(accountId, s)),
        );
      default:
        throw new Error(`Mailgun plugin: unknown resource type "${typeId}"`);
    }
  }

  private async pools(): Promise<MgIpPool[]> {
    const res = await this.call<{ ip_pools?: MgIpPool[] }>(this.home, "/v3/ip_pools");
    return res?.ip_pools ?? [];
  }

  private async ips(): Promise<MgIpDetail[]> {
    const res = await this.call<{ details?: MgIpDetail[]; items?: string[] }>(this.home, "/v3/ips");
    if (res?.details?.length) return res.details;
    return (res?.items ?? []).map((ip) => ({ ip }));
  }

  private async subaccounts(): Promise<MgSubaccount[]> {
    const out: MgSubaccount[] = [];
    for (let skip = 0; skip < 10_000; skip += 1000) {
      const res = await this.call<{ subaccounts?: MgSubaccount[]; total?: number }>(
        this.home,
        "/v5/accounts/subaccounts",
        {
          query: { limit: 1000, skip },
        },
      );
      const items = res?.subaccounts ?? [];
      out.push(...items);
      if (items.length < 1000) break;
    }
    return out;
  }

  /** The custom monthly limit, or undefined when none is set (Mailgun answers 404). */
  private async monthlyLimit(
    subaccountId?: string,
  ): Promise<{ limit?: number; current?: number; period?: string } | undefined> {
    const path = subaccountId
      ? `/v5/accounts/subaccounts/${encodeURIComponent(subaccountId)}/limit/custom/monthly`
      : "/v5/accounts/limit/custom/monthly";
    try {
      return await this.call(this.home, path);
    } catch (err) {
      if (statusOf(err) === 404) return undefined;
      throw err;
    }
  }

  private async loadAccount(accountId: string): Promise<ResourceInstance> {
    // Listing domains doubles as the credential check: a bad key fails here.
    const [domains, limit] = await Promise.all([
      this.domainSummaries(),
      this.monthlyLimit().catch(() => undefined),
    ]);
    const at = new Date().toISOString();
    return {
      id: `${accountId}:mailgun-account:account`,
      pluginId: "mailgun",
      resourceTypeId: "mailgun-account",
      accountId,
      displayName: "Mailgun account",
      fields: {
        name: "Mailgun account",
        regions: this.ctx.regions.map((r) => r.toUpperCase()).join(", "),
        domainCount: domains.length,
        ...(typeof limit?.limit === "number" ? { monthlyLimit: limit.limit } : {}),
        ...(typeof limit?.current === "number" ? { monthlySent: limit.current } : {}),
        ...(limit?.period ? { limitPeriod: limit.period } : {}),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: "account",
      createdAt: at,
      updatedAt: at,
    };
  }

  // -------------------------------------------------------------------------
  // Single reads
  // -------------------------------------------------------------------------

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const ext = externalIdOf(resourceId);
    const { region, rest } = splitRegion(ext);
    switch (typeId) {
      case "mailgun-account": {
        const r = await this.loadAccount(accountId);
        const end = Date.now();
        const items = await Promise.all(
          this.ctx.regions.map((rg) =>
            queryMetrics(this.ctx, rg, { startMs: end - 30 * DAY_MS, endMs: end }).catch(
              () => null,
            ),
          ),
        );
        const ok = items.filter((x): x is NonNullable<typeof x> => x !== null);
        return stash(r, { [STATS_KEY]: ok.length > 0 ? totals(ok.flat()) : undefined });
      }
      case "mailgun-domain": {
        const enc = encodeURIComponent(rest);
        const end = Date.now();
        const [bundle, metrics, queues, ...lists] = await Promise.all([
          this.domainBundle(region, rest),
          queryMetrics(this.ctx, region, { startMs: end - 30 * DAY_MS, endMs: end }, rest).catch(
            () => undefined,
          ),
          this.call<QueueStatus>(region, `/v3/domains/${enc}/sending_queues`).catch(
            () => undefined,
          ),
          ...SUPPRESSION_LISTS.map((l) =>
            this.call<{ items?: unknown[] }>(region, `/v3/${enc}/${l.id}`, {
              query: { limit: 50 },
            }).catch(() => undefined),
          ),
        ]);
        const supp: Record<string, unknown> = {};
        SUPPRESSION_LISTS.forEach((l, i) => {
          const items = lists[i]?.items;
          if (Array.isArray(items)) supp[l.id] = items;
        });
        return stash(mapDomain(accountId, bundle), {
          [STATS_KEY]: metrics ? totals(metrics) : undefined,
          [QUEUES_KEY]: queues,
          [SUPPRESSIONS_KEY]: Object.keys(supp).length > 0 ? supp : undefined,
        });
      }
      case "mailgun-mailing-list": {
        const enc = encodeURIComponent(rest);
        const [res, members] = await Promise.all([
          this.call<{ list?: MgList }>(region, `/v3/lists/${enc}`),
          this.call<{ items?: MemberRow[] }>(region, `/v3/lists/${enc}/members/pages`, {
            query: { limit: 100 },
          }).catch(() => undefined),
        ]);
        return stash(mapList(accountId, region, res?.list ?? { address: rest }), {
          [MEMBERS_KEY]: members?.items?.map((m) => ({
            address: m.address,
            name: m.name,
            subscribed: m.subscribed,
          })),
        });
      }
      case "mailgun-route": {
        const res = await this.call<{ route?: MgRoute }>(
          region,
          `/v3/routes/${encodeURIComponent(rest)}`,
        );
        return mapRoute(accountId, region, res?.route ?? {});
      }
      case "mailgun-ip-pool": {
        const [pool, ips, domains] = await Promise.all([
          this.call<{ ip_pool?: MgIpPool } & MgIpPool>(
            this.home,
            `/v3/ip_pools/${encodeURIComponent(ext)}`,
          ),
          this.ips().catch(() => [] as MgIpDetail[]),
          this.domainSummaries().catch(() => []),
        ]);
        const p = pool?.ip_pool ?? pool;
        const inPool = new Set(p?.ips ?? []);
        return stash(mapIpPool(accountId, { ...p, pool_id: p?.pool_id ?? ext }), {
          [AVAILABLE_IPS_KEY]: ips
            .filter((i) => i.dedicated !== false && i.ip && !inPool.has(i.ip))
            .map((i) => i.ip),
          [DOMAINS_KEY]: domains
            .filter((d) => d.region === this.home)
            .map((d) => d.domain.name ?? "")
            .filter(Boolean),
        });
      }
      case "mailgun-subaccount": {
        const [res, limit] = await Promise.all([
          this.call<{ subaccount?: MgSubaccount }>(
            this.home,
            `/v5/accounts/subaccounts/${encodeURIComponent(ext)}`,
          ),
          this.monthlyLimit(ext).catch(() => undefined),
        ]);
        return mapSubaccount(accountId, res?.subaccount ?? { id: ext }, limit);
      }
      default: {
        const all = await this.listResources(typeId, accountId);
        const found = all.find((r) => r.id === resourceId || r.externalId === ext);
        if (!found) throw notFound(typeId, resourceId);
        return found;
      }
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "mailgun-account" && outputKey === "webhookSigningKey") {
      const res = await this.call<{ http_signing_key?: string }>(
        this.home,
        "/v5/accounts/http_signing_key",
      );
      if (!res?.http_signing_key)
        throw new Error("Mailgun plugin: the account has no webhook signing key");
      return res.http_signing_key;
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    const resolved = resource.resolvedOutputs[outputKey];
    if (resolved !== undefined) return resolved;
    const field = resource.fields[outputKey];
    if (field !== undefined) return String(field);
    throw new Error(`Mailgun plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Metrics, stats and quotas
  // -------------------------------------------------------------------------

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const range = rangeOrDefault(timeRange);
    if (resourceTypeId === "mailgun-account") {
      const items = await Promise.all(
        this.ctx.regions.map((r) => queryMetrics(this.ctx, r, range)),
      );
      return seriesFromItems(items.flat());
    }
    if (resourceTypeId === "mailgun-domain") {
      const { region, rest } = splitRegion(externalIdOf(resourceId));
      return seriesFromItems(await queryMetrics(this.ctx, region, range, rest));
    }
    return [];
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    if (resourceTypeId === "mailgun-account") {
      const r = await this.loadAccount(accountId);
      const limit = Number(r.fields["monthlyLimit"] ?? 0);
      const sent = Number(r.fields["monthlySent"] ?? 0);
      return [
        { label: "Domains", value: String(r.fields["domainCount"] ?? 0) },
        {
          label: "Monthly limit",
          value: limit > 0 ? `${Math.round((sent / limit) * 100)}%` : "None",
          variant:
            limit > 0
              ? sent >= limit
                ? "status-error"
                : sent / limit >= 0.75
                  ? "status-degraded"
                  : "status-healthy"
              : "default",
        },
      ];
    }
    if (resourceTypeId === "mailgun-domain") {
      const { region, rest } = splitRegion(externalIdOf(resourceId));
      const end = Date.now();
      const t = totals(
        await queryMetrics(this.ctx, region, { startMs: end - 30 * DAY_MS, endMs: end }, rest),
      );
      return [
        { label: "Delivered (30d)", value: (t["delivered_count"] ?? 0).toLocaleString("en-US") },
        {
          label: "Failed (30d)",
          value: (t["permanent_failed_count"] ?? 0).toLocaleString("en-US"),
        },
      ];
    }
    return [];
  }

  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
    let limit: { limit?: number; current?: number } | undefined;
    try {
      limit = await this.monthlyLimit();
    } catch (err) {
      if (statusOf(err) === 401 || statusOf(err) === 403) {
        throw new QuotaAccessError("This Mailgun API key cannot read the custom sending limit.", {
          label: "Manage API keys",
          url: "https://app.mailgun.com/settings/api_security",
        });
      }
      throw err;
    }
    if (!limit || typeof limit.limit !== "number" || limit.limit <= 0) return [];
    return [
      {
        id: "custom-monthly-limit",
        service: "Sending",
        name: "Messages this month (custom limit)",
        limit: limit.limit,
        used: Number(limit.current ?? 0),
        unit: "messages",
        adjustable: true,
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  private regionField(): CreateFieldConfig {
    return {
      key: "region",
      label: "Region",
      kind: "select",
      required: true,
      defaultValue: this.home,
      options: this.ctx.regions.map((r) => ({
        id: r,
        label: r === "us" ? "US" : "EU",
        description: r === "us" ? "api.mailgun.net" : "api.eu.mailgun.net (data stays in the EU)",
      })),
    };
  }

  private async domainOptions(): Promise<SelectOption[]> {
    return (await this.domainSummaries().catch(() => [])).map(({ region, domain }) => ({
      id: `${region}/${domain.name ?? ""}`,
      label: domain.name ?? "",
      description: `${region.toUpperCase()}, ${domain.state ?? ""}`,
    }));
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    const text = (
      key: string,
      label: string,
      opts: Partial<CreateFieldConfig> = {},
    ): CreateFieldConfig => ({
      key,
      label,
      kind: "text",
      required: false,
      ...opts,
    });
    const toggle = (
      key: string,
      label: string,
      on: boolean,
      description?: string,
    ): CreateFieldConfig => ({
      key,
      label,
      kind: "select",
      required: false,
      defaultValue: String(on),
      options: [
        { id: "true", label: "On" },
        { id: "false", label: "Off" },
      ],
      ...(description ? { description } : {}),
    });
    const domainPicker = async (): Promise<CreateFieldConfig[]> => {
      if (parentResourceId) return [];
      const options = await this.domainOptions();
      return [
        {
          key: "domain",
          label: "Domain",
          kind: "select",
          required: true,
          ...(options[0] ? { defaultValue: options[0].id } : {}),
          options,
        },
      ];
    };
    switch (typeId) {
      case "mailgun-domain": {
        const pools = await this.pools().catch(() => [] as MgIpPool[]);
        return {
          fields: [
            text("name", "Domain", {
              required: true,
              placeholder: "mg.example.com",
              description:
                "A subdomain such as mg.example.com keeps Mailgun's MX records off your main domain.",
            }),
            this.regionField(),
            toggle(
              "automaticSenderSecurity",
              "Automatic sender security",
              true,
              "Mailgun manages and rotates the DKIM key through a CNAME.",
            ),
            {
              key: "dkimKeySize",
              label: "DKIM key size",
              kind: "select",
              required: false,
              defaultValue: "2048",
              options: [
                { id: "2048", label: "2048 bits" },
                {
                  id: "1024",
                  label: "1024 bits",
                  description: "Only for DNS providers that cannot hold a 2048-bit TXT record.",
                },
              ],
            },
            {
              key: "spamAction",
              label: "Inbound spam action",
              kind: "select",
              required: false,
              defaultValue: "disabled",
              options: [
                { id: "disabled", label: "Do nothing" },
                { id: "tag", label: "Tag as spam" },
                { id: "block", label: "Block" },
              ],
            },
            {
              key: "webScheme",
              label: "Tracking scheme",
              kind: "select",
              required: false,
              defaultValue: "https",
              options: [
                { id: "https", label: "HTTPS" },
                { id: "http", label: "HTTP" },
              ],
            },
            toggle("wildcard", "Accept mail for subdomains", false),
            ...(pools.length > 0
              ? [
                  {
                    key: "poolId",
                    label: "Dedicated IP pool",
                    kind: "select" as const,
                    required: false,
                    defaultValue: "",
                    options: [
                      { id: "", label: "Shared IPs" },
                      ...pools.map((p) => ({
                        id: p.pool_id ?? "",
                        label: p.name ?? "",
                        description: (p.ips ?? []).join(", "),
                      })),
                    ],
                  },
                ]
              : []),
          ],
        };
      }
      case "mailgun-api-key": {
        const options = await this.domainOptions();
        return {
          fields: [
            {
              key: "kind",
              label: "Kind",
              kind: "select",
              required: true,
              defaultValue: "domain",
              options: [
                {
                  id: "domain",
                  label: "Domain sending key",
                  description: "Can only send mail for one domain.",
                },
                {
                  id: "user",
                  label: "Account key",
                  description: "Manages the account with the role you pick.",
                },
              ],
            },
            {
              key: "domain",
              label: "Domain",
              kind: "select",
              required: false,
              showWhen: { fieldKey: "kind", fieldValue: "domain" },
              ...(options[0] ? { defaultValue: options[0].id } : {}),
              options,
            },
            {
              key: "role",
              label: "Role",
              kind: "select",
              required: false,
              defaultValue: "developer",
              showWhen: { fieldKey: "kind", fieldValue: "user" },
              description: "Roles other than admin need a plan with role-based access control.",
              options: [
                { id: "admin", label: "Admin", description: "Everything." },
                {
                  id: "developer",
                  label: "Developer",
                  description: "Technical endpoints, read keys.",
                },
                { id: "basic", label: "Basic" },
              ],
            },
            text("description", "Description", { required: true }),
            {
              key: "expiration",
              label: "Expires after (seconds)",
              kind: "number",
              required: false,
              minValue: 0,
              description: "Optional. Blank never expires.",
            },
          ],
        };
      }
      case "mailgun-webhook":
        return {
          fields: [
            ...(await domainPicker()),
            text("url", "URL", {
              required: true,
              placeholder: "https://example.com/mailgun/events",
            }),
            ...WEBHOOK_EVENTS.map(([event, label]) =>
              toggle(
                eventFieldKey(event),
                label,
                ["delivered", "permanent_fail", "complained"].includes(event),
              ),
            ),
          ],
        };
      case "mailgun-account-webhook":
        return {
          fields: [
            text("url", "URL", {
              required: true,
              placeholder: "https://example.com/mailgun/events",
            }),
            text("description", "Description"),
            ...WEBHOOK_EVENTS.map(([event, label]) =>
              toggle(
                eventFieldKey(event),
                label,
                ["delivered", "permanent_fail", "complained"].includes(event),
              ),
            ),
          ],
        };
      case "mailgun-route":
        return {
          fields: [
            this.regionField(),
            text("description", "Description"),
            text("expression", "Filter expression", {
              required: true,
              placeholder: 'match_recipient(".*@mg.example.com")',
              description: "match_recipient, match_header or catch_all().",
            }),
            text("actions", "Actions", {
              required: true,
              multiline: true,
              placeholder: 'forward("https://example.com/inbound")\nstop()',
              description: 'One per line: forward(...), store(notify="..."), stop().',
            }),
            {
              key: "priority",
              label: "Priority",
              kind: "number",
              required: false,
              defaultValue: "0",
              minValue: 0,
            },
          ],
        };
      case "mailgun-mailing-list":
        return {
          fields: [
            this.regionField(),
            text("address", "Address", { required: true, placeholder: "team@mg.example.com" }),
            text("name", "Name"),
            text("description", "Description"),
            {
              key: "accessLevel",
              label: "Who can post",
              kind: "select",
              required: false,
              defaultValue: "readonly",
              options: [
                { id: "readonly", label: "Only through the API" },
                { id: "members", label: "Members" },
                { id: "everyone", label: "Everyone" },
              ],
            },
            {
              key: "replyPreference",
              label: "Replies go to",
              kind: "select",
              required: false,
              defaultValue: "list",
              options: [
                { id: "list", label: "The list" },
                { id: "sender", label: "The sender" },
              ],
            },
          ],
        };
      case "mailgun-smtp-credential":
        return {
          fields: [
            ...(await domainPicker()),
            text("login", "Login", {
              required: true,
              placeholder: "postmaster",
              description: "The part before @; Mailgun adds the domain.",
            }),
            {
              key: "password",
              label: "Password",
              kind: "password",
              required: true,
              description: "5 to 32 characters.",
            },
          ],
        };
      case "mailgun-ip-pool": {
        const ips = await this.ips().catch(() => [] as MgIpDetail[]);
        return {
          fields: [
            text("name", "Name", { required: true }),
            text("description", "Description", { required: true }),
            {
              key: "ip",
              label: "First IP",
              kind: "select",
              required: false,
              defaultValue: "",
              options: [
                { id: "", label: "None for now" },
                ...ips
                  .filter((i) => i.dedicated !== false)
                  .map((i) => ({ id: i.ip ?? "", label: i.ip ?? "" })),
              ],
            },
          ],
        };
      }
      case "mailgun-subaccount":
        return { fields: [text("name", "Name", { required: true })] };
      default:
        throw new Error(`Mailgun plugin: "${typeId}" cannot be created from Infrawrench`);
    }
  }

  /** The `{region}/{domain}` a create form picked, or the parent domain's. */
  private pickedDomain(
    fields: Record<string, string>,
    parentResourceId?: string,
  ): { region: MailgunRegion; domain: string } {
    const raw = parentResourceId ? externalIdOf(parentResourceId) : trimmed(fields, "domain");
    if (!raw) throw new Error("Mailgun plugin: pick a domain");
    const { region, rest } = splitRegion(raw);
    return { region, domain: rest };
  }

  private regionOf(fields: Record<string, string>): MailgunRegion {
    const r = trimmed(fields, "region");
    return r === "eu" || r === "us" ? r : this.home;
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    this.invalidate();
    switch (typeId) {
      case "mailgun-domain": {
        const region = this.regionOf(fields);
        const name = trimmed(fields, "name").toLowerCase();
        await this.call(region, "/v4/domains", {
          form: {
            name,
            use_automatic_sender_security: bool(fields["automaticSenderSecurity"]) ?? true,
            dkim_key_size: trimmed(fields, "dkimKeySize") || undefined,
            spam_action: trimmed(fields, "spamAction") || undefined,
            web_scheme: trimmed(fields, "webScheme") || undefined,
            wildcard: bool(fields["wildcard"]),
            pool_id: trimmed(fields, "poolId") || undefined,
          },
        });
        return mapDomain(accountId, await this.domainBundle(region, name));
      }
      case "mailgun-api-key": {
        const kind = trimmed(fields, "kind") || "domain";
        const expiration = trimmed(fields, "expiration");
        const form: Record<string, FormValue> = {
          kind,
          description: trimmed(fields, "description"),
          ...(expiration ? { expiration: Number(expiration) } : {}),
        };
        let region = this.home;
        if (kind === "domain") {
          const picked = this.pickedDomain(fields);
          region = picked.region;
          form["domain_name"] = picked.domain;
          form["role"] = "sending";
        } else {
          form["role"] = trimmed(fields, "role") || "developer";
        }
        const res = await this.call<{ key?: MgKey }>(region, "/v1/keys", { form });
        return mapKey(accountId, res?.key ?? {});
      }
      case "mailgun-webhook": {
        const { region, domain } = this.pickedDomain(fields, parentResourceId);
        const url = trimmed(fields, "url");
        if (!/^https?:\/\//i.test(url))
          throw new Error("Mailgun plugin: the webhook URL must start with https://");
        const events = eventsFrom(fields);
        if (events.length === 0) throw new Error("Mailgun plugin: pick at least one event");
        await this.call(region, `/v4/domains/${encodeURIComponent(domain)}/webhooks`, {
          form: { url, event_types: events },
        });
        return mapWebhook(accountId, region, domain, url, events);
      }
      case "mailgun-account-webhook": {
        const events = eventsFrom(fields);
        if (events.length === 0) throw new Error("Mailgun plugin: pick at least one event");
        const res = await this.call<{ webhook_id?: string }>(this.home, "/v1/webhooks", {
          form: {
            url: trimmed(fields, "url"),
            description: trimmed(fields, "description") || undefined,
            event_types: events,
          },
        });
        return mapAccountWebhook(accountId, {
          webhook_id: res?.webhook_id ?? "",
          url: trimmed(fields, "url"),
          description: trimmed(fields, "description"),
          event_types: events,
        });
      }
      case "mailgun-route": {
        const region = this.regionOf(fields);
        const actions = parseActions(fields["actions"] ?? "");
        if (actions.length === 0)
          throw new Error("Mailgun plugin: a route needs at least one action");
        const res = await this.call<{ route?: MgRoute }>(region, "/v3/routes", {
          form: {
            priority: trimmed(fields, "priority") || "0",
            description: trimmed(fields, "description") || undefined,
            expression: trimmed(fields, "expression"),
            action: actions,
          },
        });
        return mapRoute(accountId, region, res?.route ?? {});
      }
      case "mailgun-mailing-list": {
        const region = this.regionOf(fields);
        const res = await this.call<{ list?: MgList }>(region, "/v3/lists", {
          form: {
            address: trimmed(fields, "address"),
            name: trimmed(fields, "name") || undefined,
            description: trimmed(fields, "description") || undefined,
            access_level: trimmed(fields, "accessLevel") || undefined,
            reply_preference: trimmed(fields, "replyPreference") || undefined,
          },
        });
        return mapList(accountId, region, res?.list ?? { address: trimmed(fields, "address") });
      }
      case "mailgun-smtp-credential": {
        const { region, domain } = this.pickedDomain(fields, parentResourceId);
        const login = trimmed(fields, "login");
        await this.call(region, `/v3/domains/${encodeURIComponent(domain)}/credentials`, {
          form: { login, password: fields["password"] ?? "" },
        });
        const full = login.includes("@") ? login : `${login}@${domain}`;
        return mapCredential(accountId, region, domain, {
          login: full,
          created_at: new Date().toISOString(),
        });
      }
      case "mailgun-ip-pool": {
        const name = trimmed(fields, "name");
        await this.call(this.home, "/v3/ip_pools", {
          form: {
            name,
            description: trimmed(fields, "description"),
            ip: trimmed(fields, "ip") || undefined,
          },
        });
        const created = (await this.pools()).find((p) => p.name === name);
        if (!created)
          throw new Error("Mailgun plugin: the pool was created but could not be read back");
        return mapIpPool(accountId, created);
      }
      case "mailgun-subaccount": {
        const res = await this.call<{ subaccount?: MgSubaccount }>(
          this.home,
          "/v5/accounts/subaccounts",
          {
            method: "POST",
            query: { name: trimmed(fields, "name") },
          },
        );
        return mapSubaccount(accountId, res?.subaccount ?? {});
      }
      default:
        throw new Error(`Mailgun plugin: "${typeId}" cannot be created from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  private async setMonthlyLimit(value: string, subaccountId?: string): Promise<void> {
    const path = subaccountId
      ? `/v5/accounts/subaccounts/${encodeURIComponent(subaccountId)}/limit/custom/monthly`
      : "/v5/accounts/limit/custom/monthly";
    const n = Number(value.trim() || "0");
    if (!Number.isFinite(n) || n < 0)
      throw new Error("Mailgun plugin: the limit must be a number of zero or more");
    if (n === 0) {
      await this.call(this.home, path, { method: "DELETE" }).catch((err) => {
        if (statusOf(err) !== 404) throw err;
      });
      return;
    }
    await this.call(this.home, path, { method: "PUT", query: { limit: Math.floor(n) } });
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const ext = externalIdOf(resourceId);
    const { region, rest } = splitRegion(ext);
    this.invalidate();
    switch (typeId) {
      case "mailgun-account":
        if ("monthlyLimit" in fields) await this.setMonthlyLimit(fields["monthlyLimit"] ?? "");
        return this.loadAccount(accountId);
      case "mailgun-subaccount":
        if ("monthlyLimit" in fields) await this.setMonthlyLimit(fields["monthlyLimit"] ?? "", ext);
        return this.getResource(typeId, resourceId, accountId);
      case "mailgun-domain": {
        const enc = encodeURIComponent(rest);
        const form = domainForm(fields);
        if (Object.keys(form).length > 0)
          await this.call(region, `/v4/domains/${enc}`, { method: "PUT", form });
        const tracking: Array<[string, string]> = [
          ["trackOpens", "open"],
          ["trackClicks", "click"],
          ["trackUnsubscribes", "unsubscribe"],
        ];
        for (const [key, kind] of tracking) {
          const v = bool(fields[key]);
          if (v === undefined) continue;
          await this.call(region, `/v3/domains/${enc}/tracking/${kind}`, {
            method: "PUT",
            form: { active: v },
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "mailgun-webhook": {
        const slash = rest.indexOf("/");
        const domain = rest.slice(0, slash);
        const url = rest.slice(slash + 1);
        const current = await this.listResources(typeId, accountId).then((all) =>
          all.find((r) => r.externalId === ext),
        );
        const merged = { ...(current?.fields ?? {}), ...fields } as Record<
          string,
          string | boolean | number
        >;
        const events = eventsFrom(merged);
        if (events.length === 0)
          throw new Error("Mailgun plugin: keep at least one event, or delete the webhook");
        await this.call(region, `/v4/domains/${encodeURIComponent(domain)}/webhooks`, {
          method: "PUT",
          form: { url, event_types: events },
        });
        return mapWebhook(accountId, region, domain, url, events);
      }
      case "mailgun-account-webhook": {
        const current = (await this.listResources(typeId, accountId)).find(
          (r) => r.externalId === ext,
        );
        const merged = { ...(current?.fields ?? {}), ...fields } as Record<
          string,
          string | boolean | number
        >;
        const events = eventsFrom(merged);
        if (events.length === 0)
          throw new Error("Mailgun plugin: keep at least one event, or delete the webhook");
        await this.call(this.home, `/v1/webhooks/${encodeURIComponent(ext)}`, {
          method: "PUT",
          form: {
            url: String(merged["url"] ?? "").trim(),
            description: String(merged["description"] ?? "").trim(),
            event_types: events,
          },
        });
        return this.getResource(typeId, resourceId, accountId);
      }
      case "mailgun-route": {
        const form: Record<string, FormValue> = {};
        if ("description" in fields) form["description"] = trimmed(fields, "description");
        if ("expression" in fields) form["expression"] = trimmed(fields, "expression");
        if ("priority" in fields && trimmed(fields, "priority"))
          form["priority"] = trimmed(fields, "priority");
        if ("actions" in fields) {
          const actions = parseActions(fields["actions"] ?? "");
          if (actions.length === 0)
            throw new Error("Mailgun plugin: a route needs at least one action");
          form["action"] = actions;
        }
        const res = await this.call<{ route?: MgRoute }>(
          region,
          `/v3/routes/${encodeURIComponent(rest)}`,
          {
            method: "PUT",
            form,
          },
        );
        return res?.route
          ? mapRoute(accountId, region, res.route)
          : this.getResource(typeId, resourceId, accountId);
      }
      case "mailgun-mailing-list": {
        const form: Record<string, FormValue> = {};
        if ("name" in fields) form["name"] = trimmed(fields, "name");
        if ("description" in fields) form["description"] = trimmed(fields, "description");
        if (trimmed(fields, "accessLevel")) form["access_level"] = trimmed(fields, "accessLevel");
        if (trimmed(fields, "replyPreference")) {
          // The create endpoint and Mailgun's guides call it reply_preference;
          // the update schema spells it reply_reference. Send both.
          form["reply_preference"] = trimmed(fields, "replyPreference");
          form["reply_reference"] = trimmed(fields, "replyPreference");
        }
        await this.call(region, `/v3/lists/${encodeURIComponent(rest)}`, { method: "PUT", form });
        return this.getResource(typeId, resourceId, accountId);
      }
      case "mailgun-smtp-credential": {
        const slash = rest.indexOf("/");
        const domain = rest.slice(0, slash);
        const login = rest.slice(slash + 1);
        const password = fields["password"] ?? "";
        if (password) {
          const spec = login.split("@")[0] ?? login;
          await this.call(
            region,
            `/v3/domains/${encodeURIComponent(domain)}/credentials/${encodeURIComponent(spec)}`,
            {
              method: "PUT",
              form: { password },
            },
          );
        }
        return mapCredential(accountId, region, domain, { login });
      }
      case "mailgun-ip-pool": {
        const form: Record<string, FormValue> = {};
        if ("name" in fields) form["name"] = trimmed(fields, "name");
        if ("description" in fields) form["description"] = trimmed(fields, "description");
        await this.call(this.home, `/v3/ip_pools/${encodeURIComponent(ext)}`, {
          method: "PATCH",
          form,
        });
        return this.getResource(typeId, resourceId, accountId);
      }
      case "mailgun-tag": {
        await this.call(region, "/v1/analytics/tags", {
          method: "PUT",
          json: { tag: rest, description: trimmed(fields, "description") },
        });
        return {
          ...mapTag(accountId, region, { tag: rest, description: trimmed(fields, "description") }),
        };
      }
      default:
        throw new Error(`Mailgun plugin: "${typeId}" cannot be edited from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Delete, actions, commands
  // -------------------------------------------------------------------------

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const ext = externalIdOf(resourceId);
    const { region, rest } = splitRegion(ext);
    this.invalidate();
    switch (typeId) {
      case "mailgun-domain":
        await this.call(region, `/v3/domains/${encodeURIComponent(rest)}`, { method: "DELETE" });
        return;
      case "mailgun-api-key":
        await this.call(this.home, `/v1/keys/${encodeURIComponent(ext)}`, { method: "DELETE" });
        return;
      case "mailgun-webhook": {
        const slash = rest.indexOf("/");
        await this.call(
          region,
          `/v4/domains/${encodeURIComponent(rest.slice(0, slash))}/webhooks`,
          {
            method: "DELETE",
            query: { url: rest.slice(slash + 1) },
          },
        );
        return;
      }
      case "mailgun-account-webhook":
        await this.call(this.home, `/v1/webhooks/${encodeURIComponent(ext)}`, { method: "DELETE" });
        return;
      case "mailgun-route":
        await this.call(region, `/v3/routes/${encodeURIComponent(rest)}`, { method: "DELETE" });
        return;
      case "mailgun-mailing-list":
        await this.call(region, `/v3/lists/${encodeURIComponent(rest)}`, { method: "DELETE" });
        return;
      case "mailgun-smtp-credential": {
        const slash = rest.indexOf("/");
        const login = rest.slice(slash + 1);
        await this.call(
          region,
          `/v3/domains/${encodeURIComponent(rest.slice(0, slash))}/credentials/${encodeURIComponent(login.split("@")[0] ?? login)}`,
          { method: "DELETE" },
        );
        return;
      }
      case "mailgun-ip-pool":
        // Domains linked to the pool fall back to shared IPs.
        await this.call(this.home, `/v3/ip_pools/${encodeURIComponent(ext)}`, {
          method: "DELETE",
          query: { ip: "shared" },
        });
        return;
      case "mailgun-tag":
        await this.call(region, "/v1/analytics/tags", { method: "DELETE", json: { tag: rest } });
        return;
      case "mailgun-subaccount":
        await this.call(this.home, "/v5/accounts/subaccounts", {
          method: "DELETE",
          headers: { "X-Mailgun-On-Behalf-Of": ext },
        });
        return;
      default:
        throw new Error(`Mailgun plugin: "${typeId}" cannot be deleted from Infrawrench`);
    }
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const ext = externalIdOf(resourceId);
    const { region, rest } = splitRegion(ext);
    this.invalidate();
    if (typeId === "mailgun-domain" && actionId === "verify") {
      const res = await this.call<MgDomainDetail>(
        region,
        `/v4/domains/${encodeURIComponent(rest)}/verify`,
        { method: "PUT" },
      );
      const bad = [...(res?.sending_dns_records ?? [])].filter((r) => r && r.valid !== "valid");
      if (bad.length > 0 && res?.domain?.state !== "active") {
        throw new Error(
          `Mailgun has not found every sending record yet: ${bad.map((r) => `${r?.record_type} ${r?.name}`).join(", ")}. DNS changes can take a while to show up.`,
        );
      }
      return;
    }
    if (typeId === "mailgun-subaccount" && (actionId === "enable" || actionId === "disable")) {
      await this.call(
        this.home,
        `/v5/accounts/subaccounts/${encodeURIComponent(ext)}/${actionId}`,
        { method: "POST" },
      );
      return;
    }
    throw new Error(`Mailgun plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const values = parsePromptValues(args);
    const ext = externalIdOf(resourceId);
    const { region, rest } = splitRegion(ext);
    const emails = () => {
      const list = parseAddresses(values["emails"] ?? "");
      if (list.length === 0) throw new Error("Enter at least one email address.");
      return list;
    };
    if (
      typeId === "mailgun-domain" &&
      (command === COMMANDS.addSuppressions || command === COMMANDS.removeSuppressions)
    ) {
      const list = SUPPRESSION_LISTS.find((l) => l.id === values["list"]);
      if (!list) throw new Error("Pick a suppression list.");
      const enc = encodeURIComponent(rest);
      const targets = emails();
      if (command === COMMANDS.removeSuppressions) {
        await mapLimit(targets, CONCURRENCY, (e) =>
          this.call(region, `/v3/${enc}/${list.id}/${encodeURIComponent(e)}`, {
            method: "DELETE",
          }).catch((err) => {
            if (statusOf(err) !== 404) throw err;
          }),
        );
      } else if (list.id === "whitelists") {
        await mapLimit(targets, CONCURRENCY, (address) =>
          this.call(region, `/v3/${enc}/whitelists`, { form: { address } }),
        );
      } else {
        // JSON bodies take up to 1000 entries per request.
        await this.call(region, `/v3/${enc}/${list.id}`, {
          json: targets.map((address) => ({ address })),
        });
      }
      return { ok: true, count: targets.length };
    }
    if (typeId === "mailgun-mailing-list" && command === COMMANDS.addMembers) {
      const members = emails().map((address) => ({ address, subscribed: true }));
      return this.call(region, `/v3/lists/${encodeURIComponent(rest)}/members.json`, {
        form: { members: JSON.stringify(members), upsert: "yes" },
      });
    }
    if (typeId === "mailgun-mailing-list" && command === COMMANDS.removeMembers) {
      const targets = emails();
      await mapLimit(targets, CONCURRENCY, (e) =>
        this.call(
          region,
          `/v3/lists/${encodeURIComponent(rest)}/members/${encodeURIComponent(e)}`,
          { method: "DELETE" },
        ),
      );
      return { ok: true, count: targets.length };
    }
    if (typeId === "mailgun-ip-pool") {
      const enc = encodeURIComponent(ext);
      if (command === COMMANDS.addPoolIp || command === COMMANDS.removePoolIp) {
        const ip = (values["ip"] ?? "").trim();
        if (!ip) throw new Error("Pick an IP.");
        return this.call(this.home, `/v3/ip_pools/${enc}/ips/${encodeURIComponent(ip)}`, {
          method: command === COMMANDS.addPoolIp ? "PUT" : "DELETE",
        });
      }
      if (command === COMMANDS.linkPoolDomain) {
        const domain = (values["domain"] ?? "").trim();
        if (!domain) throw new Error("Pick a domain.");
        return this.call(this.home, `/v3/ip_pools/${enc}`, {
          method: "PATCH",
          form: { link_domain: domain },
        });
      }
    }
    throw new Error(`Mailgun plugin: unknown command "${command}" for "${typeId}"`);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderMailgunDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderMailgunSidebar(resource);
  }
}
