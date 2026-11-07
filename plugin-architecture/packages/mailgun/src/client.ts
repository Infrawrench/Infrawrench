import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
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
  UnreadListPart,
} from "@infrawrench/plugin-base";
import {
  ListPageError,
  ListTruncatedError,
  QuotaAccessError,
  externalIdOf,
  reportUnreadListPart,
  requireListPage,
} from "@infrawrench/plugin-base";
import type { FormValue, MailgunContext, MailgunRegion, MailgunRequest } from "./api.js";
import { MailgunApiError, REGIONS, listPaging, listSkip, mailgunFetch, statusOf } from "./api.js";
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
  resourceId,
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
/**
 * Domains one type reads children for in one poll. Mailgun documents no limit for these
 * routes, so this is sized on the poll: a domain's DNS records take three requests, and
 * every type together stays near 125 seconds of a poll's 300 at four at a time.
 */
const DOMAIN_READS_PER_POLL = 500;
const MAX_TAGS = 100_000;
const TAG_PAGE_SIZE = 1000;
const MAX_CREDENTIALS_PER_DOMAIN = 10_000;

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

interface DomainSummary {
  region: MailgunRegion;
  domain: MgDomain;
}

/** What every region answered, for each type reading it to act on for itself. */
interface RegionRead<T> {
  rows: T[];
  /** Regions that rejected a key another region took. */
  unreadRegions: MailgunRegion[];
  /** Why no region could be read, when it was a permission and not a bad key. */
  refused: MailgunApiError | undefined;
}

interface DomainsRead {
  summaries: RegionRead<DomainSummary>;
  bundles: DomainBundle[];
  unread: DomainSummary[];
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

/** Starts where the clock says, so polls that read only part get round to all of it. */
function rotatedByClock<T>(items: T[]): T[] {
  const minute = Math.floor(Date.now() / 60_000);
  const start = Math.floor(((minute * 0.618_033_988_75) % 1) * items.length);
  return [...items.slice(start), ...items.slice(0, start)];
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
  const addresses = [
    ...new Set(
      raw
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter((s) => s.includes("@")),
    ),
  ];
  // Mailgun's JSON suppression and member uploads take 1,000 entries a request.
  if (addresses.length > MAX_ADDRESSES) {
    throw new Error(
      `Enter at most 1,000 addresses at a time; this has ${addresses.length.toLocaleString("en-US")}.`,
    );
  }
  return addresses;
}

function isUnavailable(err: unknown): boolean {
  const s = statusOf(err);
  return s === 403 || s === 404;
}

/** Keep a type's stored rows when the key's role may not read it. */
function keepRowsOfRefusedType(err: unknown): ResourceInstance[] {
  // A host that keeps no track (the desktop) answers false, and there it should still show.
  if (!reportUnreadListPart({ idPrefixes: [""] })) throw err;
  return [];
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
  private domainCache: Cached<DomainsRead> | undefined;

  constructor(credentials: Credentials, services?: HostServices) {
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
      if (statusOf(err) === 404) return [];
      if (statusOf(err) === 403) return keepRowsOfRefusedType(err);
      throw err;
    }
  }

  /**
   * Run `fn` in every configured region. A 403 or 404 reads as a region this key has
   * nothing in, and a throttle or 5xx fails the read. A 401 is the same key failing, so
   * only another region taking it makes it about the region.
   */
  private async perRegion<T>(fn: (region: MailgunRegion) => Promise<T[]>): Promise<RegionRead<T>> {
    const refusals = new Map<MailgunRegion, MailgunApiError>();
    const results = await Promise.all(
      this.ctx.regions.map((region) =>
        fn(region).catch((err): T[] => {
          if (!(err instanceof MailgunApiError) || ![401, 403, 404].includes(err.status)) throw err;
          refusals.set(region, err);
          return [];
        }),
      ),
    );
    const refused = [...refusals.values()];
    const answered = refusals.size < this.ctx.regions.length;
    const rejected = refused.find((err) => err.status === 401);
    if (rejected && !answered) throw rejected;
    return {
      rows: results.flat(),
      unreadRegions: [...refusals].filter(([, err]) => err.status === 401).map(([r]) => r),
      refused: answered ? undefined : refused.find((err) => err.status === 403),
    };
  }

  /** The rows of a region read, after saying which of `typeId`'s stored rows it could not see. */
  private rowsOf<T>(typeId: string, accountId: string, read: RegionRead<T>): T[] {
    if (read.refused) keepRowsOfRefusedType(read.refused);
    if (read.unreadRegions.length > 0) {
      reportUnreadListPart({
        idPrefixes: read.unreadRegions.map((r) => resourceId(accountId, typeId, `${r}/`)),
      });
    }
    return read.rows;
  }

  private async regionRows<T>(
    typeId: string,
    accountId: string,
    fn: (region: MailgunRegion) => Promise<T[]>,
  ): Promise<T[]> {
    return this.rowsOf(typeId, accountId, await this.perRegion(fn));
  }

  /**
   * Read something per domain, as far as one poll's requests and Mailgun's patience go.
   * A domain past either is named, so its stored rows go stale rather than being deleted.
   * A host that keeps no track prunes nothing and shows all it can, so it reads them all.
   */
  private async fanOut<R>(
    domains: DomainSummary[],
    part: (summary: DomainSummary) => UnreadListPart,
    load: (summary: DomainSummary) => Promise<R[]>,
  ): Promise<{ rows: R[]; unread: DomainSummary[] }> {
    const order = domains.length > DOMAIN_READS_PER_POLL ? rotatedByClock(domains) : domains;
    const unread: DomainSummary[] = [];
    let started = 0;
    let throttled = false;
    const lists = await mapLimit(order, CONCURRENCY, async (summary): Promise<R[]> => {
      const turn = started++;
      if ((throttled || turn >= DOMAIN_READS_PER_POLL) && reportUnreadListPart(part(summary))) {
        unread.push(summary);
        return [];
      }
      try {
        return await load(summary);
      } catch (err) {
        const status = statusOf(err);
        if (status === 404) return [];
        // A 400 is the only refusal the credentials route documents.
        if (status === 400 || status === 403) {
          // A host that keeps no track answers false, and there the refusal shows.
          if (!reportUnreadListPart(part(summary))) throw err;
          unread.push(summary);
          return [];
        }
        if (status === 429 && reportUnreadListPart(part(summary))) {
          throttled = true;
          unread.push(summary);
          return [];
        }
        throw err;
      }
    });
    return { rows: lists.flat(), unread };
  }

  /** How a type names a domain it did not read: the row itself, or the domain's children. */
  private unreadDomainPart(
    typeId: string,
    accountId: string,
  ): (summary: DomainSummary) => UnreadListPart {
    return ({ region, domain }) => {
      const id = resourceId(accountId, "mailgun-domain", `${region}/${domain.name ?? ""}`);
      return typeId === "mailgun-domain" ? { idPrefixes: [id] } : { parentResourceIds: [id] };
    };
  }

  private async perDomain(
    typeId: string,
    accountId: string,
    load: (summary: DomainSummary) => Promise<ResourceInstance[]>,
  ): Promise<ResourceInstance[]> {
    const summaries = this.rowsOf(typeId, accountId, await this.domainSummaries());
    const { rows } = await this.fanOut(summaries, this.unreadDomainPart(typeId, accountId), load);
    return rows;
  }

  // -------------------------------------------------------------------------
  // Domains (shared by the domain, DNS, webhook and credential listers)
  // -------------------------------------------------------------------------

  private domainSummaries(): Promise<RegionRead<DomainSummary>> {
    return this.perRegion(async (region) =>
      (await listSkip<MgDomain>(this.ctx, region, "/v4/domains", { pageSize: 1000 })).map(
        (domain) => ({ region, domain }),
      ),
    );
  }

  private async domainBundle(region: MailgunRegion, name: string): Promise<DomainBundle> {
    const enc = encodeURIComponent(name);
    const [detail, tracking, pool] = await Promise.all([
      this.call<MgDomainDetail>(region, `/v4/domains/${enc}`),
      this.call<{ tracking?: MgTracking }>(region, `/v3/domains/${enc}/tracking`).catch(
        () => undefined,
      ),
      this.call<{ extra_dedicated_ips?: { pool_id?: string } }>(region, `/v3/ips/domain/${enc}`)
        .then((answer) => answer.extra_dedicated_ips?.pool_id ?? "")
        .catch((err: unknown) => (statusOf(err) === 404 ? "" : undefined)),
    ]);
    // A failed read leaves its fields out, so the sync keeps the stored ones; an answer
    // naming no pool writes "" so a domain taken out of its pool stops pointing at it.
    return {
      region,
      detail,
      ...(tracking?.tracking ? { tracking: tracking.tracking } : {}),
      ...(pool !== undefined ? { ipPoolId: pool } : {}),
    };
  }

  private domains(part: (summary: DomainSummary) => UnreadListPart): Promise<DomainsRead> {
    if (this.domainCache && Date.now() - this.domainCache.at < CACHE_MS)
      return this.domainCache.value;
    const value = (async () => {
      const summaries = await this.domainSummaries();
      const { rows, unread } = await this.fanOut(summaries.rows, part, async (s) => [
        await this.domainBundle(s.region, s.domain.name ?? ""),
      ]);
      return { summaries, bundles: rows, unread };
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

  /** The domain bundles, naming what went unread for each type, since the read is cached. */
  private async readDomains(typeId: string, accountId: string): Promise<DomainBundle[]> {
    const part = this.unreadDomainPart(typeId, accountId);
    const { summaries, bundles, unread } = await this.domains(part);
    this.rowsOf(typeId, accountId, summaries);
    // The read is cached, so it may have left domains unread for a host that kept track.
    // One that keeps none here answers false: the read is done again, and reads them all.
    if (!unread.every((summary) => reportUnreadListPart(part(summary)))) {
      this.invalidate();
      return (await this.domains(part)).bundles;
    }
    return bundles;
  }

  private async domainWebhooks(
    accountId: string,
    region: MailgunRegion,
    domain: string,
  ): Promise<ResourceInstance[]> {
    const path = `/v3/domains/${encodeURIComponent(domain)}/webhooks`;
    const res = await this.call<{
      webhooks?: Record<string, { urls?: string[] } | null> | null;
    }>(region, path);
    const webhooks = res?.webhooks;
    if (webhooks === undefined || Array.isArray(webhooks)) {
      throw new ListPageError({
        vendor: "Mailgun",
        path,
        key: "webhooks",
        found: webhooks,
        page: res,
      });
    }
    return [...groupWebhooks(webhooks ?? {})].map(([url, events]) =>
      mapWebhook(accountId, region, domain, url, events),
    );
  }

  private async domainCredentials(
    accountId: string,
    region: MailgunRegion,
    domain: string,
  ): Promise<ResourceInstance[]> {
    const creds = await listSkip<MgCredential>(
      this.ctx,
      region,
      `/v3/domains/${encodeURIComponent(domain)}/credentials`,
      { maxItems: MAX_CREDENTIALS_PER_DOMAIN },
    );
    return creds.map((c) => mapCredential(accountId, region, domain, c));
  }

  private async tags(accountId: string, region: MailgunRegion): Promise<ResourceInstance[]> {
    const path = "/v1/analytics/tags";
    const out: ResourceInstance[] = [];
    while (out.length < MAX_TAGS) {
      const res = await this.call<{ items?: MgTag[] }>(region, path, {
        json: {
          pagination: { sort: "lastseen:desc", skip: out.length, limit: TAG_PAGE_SIZE },
          include_subaccounts: false,
        },
      });
      const items = requireListPage(res?.items, {
        vendor: "Mailgun",
        path,
        key: "items",
        page: res,
      });
      if (items.length === 0) return out;
      out.push(...items.map((t) => mapTag(accountId, region, t)));
    }
    throw new ListTruncatedError({
      vendor: "Mailgun",
      path,
      items: out.length,
      maxItems: MAX_TAGS,
    });
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      switch (typeId) {
        case "mailgun-account":
          return [await this.loadAccount(accountId)];
        case "mailgun-domain":
          return (await this.readDomains(typeId, accountId)).map((b) => mapDomain(accountId, b));
        case "mailgun-dns-record":
          return (await this.readDomains(typeId, accountId)).flatMap((b) =>
            mapDnsRecords(accountId, b),
          );
        case "mailgun-api-key":
          return this.scoped(async () => {
            const path = "/v1/keys";
            const res = await this.call<{ items?: MgKey[] }>(this.home, path);
            return requireListPage(res?.items, {
              vendor: "Mailgun",
              path,
              key: "items",
              page: res,
            }).map((k) => mapKey(accountId, k));
          });
        case "mailgun-webhook":
          return this.perDomain(typeId, accountId, ({ region, domain }) =>
            this.domainWebhooks(accountId, region, domain.name ?? ""),
          );
        case "mailgun-account-webhook":
          return this.scoped(async () => {
            const path = "/v1/webhooks";
            const res = await this.call<{ webhooks?: MgAccountWebhook[] }>(this.home, path);
            return requireListPage(res?.webhooks, {
              vendor: "Mailgun",
              path,
              key: "webhooks",
              page: res,
            }).map((w) => mapAccountWebhook(accountId, w));
          });
        case "mailgun-route":
          return this.regionRows(typeId, accountId, async (region) =>
            (await listSkip<MgRoute>(this.ctx, region, "/v3/routes", { pageSize: 1000 })).map((r) =>
              mapRoute(accountId, region, r),
            ),
          );
        case "mailgun-mailing-list":
          return this.regionRows(typeId, accountId, async (region) =>
            (await listPaging<MgList>(this.ctx, region, "/v3/lists/pages", { limit: 100 })).map(
              (l) => mapList(accountId, region, l),
            ),
          );
        case "mailgun-smtp-credential":
          return this.perDomain(typeId, accountId, ({ region, domain }) =>
            this.domainCredentials(accountId, region, domain.name ?? ""),
          );
        case "mailgun-ip-pool":
          return this.scoped(async () => (await this.pools()).map((p) => mapIpPool(accountId, p)));
        case "mailgun-ip":
          return this.scoped(async () => {
            const [ips, pools] = await Promise.all([
              this.ips(),
              this.pools().catch((err): MgIpPool[] => {
                if (isUnavailable(err)) return [];
                throw err;
              }),
            ]);
            return ips.map((ip) =>
              mapIp(
                accountId,
                ip,
                pools
                  .filter((p) => (p.ips ?? []).includes(ip.ip ?? ""))
                  .map((p) => p.pool_id ?? ""),
              ),
            );
          });
        case "mailgun-tag":
          return this.regionRows(typeId, accountId, (region) => this.tags(accountId, region));
        case "mailgun-subaccount":
          return this.scoped(async () =>
            (await this.subaccounts()).map((s) => mapSubaccount(accountId, s)),
          );
        default:
          throw new Error(`Mailgun plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  private async pools(): Promise<MgIpPool[]> {
    const path = "/v3/ip_pools";
    const res = await this.call<{ ip_pools?: MgIpPool[] }>(this.home, path);
    return requireListPage(res?.ip_pools, {
      vendor: "Mailgun",
      path,
      key: "ip_pools",
      page: res,
    });
  }

  private async ips(): Promise<MgIpDetail[]> {
    const path = "/v3/ips";
    const res = await this.call<{ details?: MgIpDetail[]; items?: string[] }>(this.home, path);
    if (res?.details?.length) return res.details;
    return requireListPage(res?.items, { vendor: "Mailgun", path, key: "items", page: res }).map(
      (ip) => ({ ip }),
    );
  }

  private subaccounts(): Promise<MgSubaccount[]> {
    return listSkip<MgSubaccount>(this.ctx, this.home, "/v5/accounts/subaccounts", {
      pageSize: 1000,
      key: "subaccounts",
    });
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
      this.domainSummaries().then((read) => read.rows),
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

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
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
            this.domainSummaries()
              .then((read) => read.rows)
              .catch((): DomainSummary[] => []),
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
        // These lists read only so many domains a poll, and this one's may not be among them.
        case "mailgun-webhook":
        case "mailgun-smtp-credential":
        case "mailgun-dns-record": {
          const domain = rest.slice(0, Math.max(rest.indexOf("/"), 0));
          if (!domain) throw notFound(typeId, resourceId);
          const children =
            typeId === "mailgun-webhook"
              ? await this.domainWebhooks(accountId, region, domain)
              : typeId === "mailgun-smtp-credential"
                ? await this.domainCredentials(accountId, region, domain)
                : mapDnsRecords(accountId, await this.domainBundle(region, domain));
          const found = children.find((r) => r.externalId === ext);
          if (!found) throw notFound(typeId, resourceId);
          return found;
        }
        default: {
          const all = await runPluginEffect(this.listResources(typeId, accountId));
          const found = all.find((r) => r.id === resourceId || r.externalId === ext);
          if (!found) throw notFound(typeId, resourceId);
          return found;
        }
      }
    });
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      if (typeId === "mailgun-account" && outputKey === "webhookSigningKey") {
        const res = await this.call<{ http_signing_key?: string }>(
          this.home,
          "/v5/accounts/http_signing_key",
        );
        if (!res?.http_signing_key)
          throw new Error("Mailgun plugin: the account has no webhook signing key");
        return res.http_signing_key;
      }
      const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const resolved = resource.resolvedOutputs[outputKey];
      if (resolved !== undefined) return resolved;
      const field = resource.fields[outputKey];
      if (field !== undefined) return String(field);
      throw new Error(`Mailgun plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
    });
  }

  // -------------------------------------------------------------------------
  // Metrics, stats and quotas
  // -------------------------------------------------------------------------

  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
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
    });
  }

  fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
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
    });
  }

  fetchQuotas(_accountId: string): PluginEffect<QuotaUsage[]> {
    return attempt(async () => {
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
    });
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
    const read = await this.domainSummaries().catch(() => undefined);
    return (read?.rows ?? []).map(({ region, domain }) => ({
      id: `${region}/${domain.name ?? ""}`,
      label: domain.name ?? "",
      description: `${region.toUpperCase()}, ${domain.state ?? ""}`,
    }));
  }

  getCreateConfig(typeId: string, parentResourceId?: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
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
    });
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

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
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
    });
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

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const ext = externalIdOf(resourceId);
      const { region, rest } = splitRegion(ext);
      this.invalidate();
      switch (typeId) {
        case "mailgun-account":
          if ("monthlyLimit" in fields) await this.setMonthlyLimit(fields["monthlyLimit"] ?? "");
          return this.loadAccount(accountId);
        case "mailgun-subaccount":
          if ("monthlyLimit" in fields)
            await this.setMonthlyLimit(fields["monthlyLimit"] ?? "", ext);
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
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
          const written: Record<string, boolean> = {};
          for (const [key, kind] of tracking) {
            const v = bool(fields[key]);
            if (v === undefined) continue;
            await this.call(region, `/v3/domains/${enc}/tracking/${kind}`, {
              method: "PUT",
              form: { active: v },
            });
            written[key] = v;
          }
          const updated = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
          // The host stores this answer as the row, so a tracking read that failed after
          // the write must not drop the values just set.
          return { ...updated, fields: { ...written, ...updated.fields } };
        }
        case "mailgun-webhook": {
          const slash = rest.indexOf("/");
          const domain = rest.slice(0, slash);
          const url = rest.slice(slash + 1);
          // This write replaces the webhook's events, so what is there has to be read first.
          const current = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
          const merged = { ...current.fields, ...fields } as Record<
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
          // This write replaces the URL and description too, so a miss must not reach it.
          const current = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
          const merged = { ...current.fields, ...fields } as Record<
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
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
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
            : runPluginEffect(this.getResource(typeId, resourceId, accountId));
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
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
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
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "mailgun-tag": {
          await this.call(region, "/v1/analytics/tags", {
            method: "PUT",
            json: { tag: rest, description: trimmed(fields, "description") },
          });
          return {
            ...mapTag(accountId, region, {
              tag: rest,
              description: trimmed(fields, "description"),
            }),
          };
        }
        default:
          throw new Error(`Mailgun plugin: "${typeId}" cannot be edited from Infrawrench`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Delete, actions, commands
  // -------------------------------------------------------------------------

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
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
          await this.call(this.home, `/v1/webhooks/${encodeURIComponent(ext)}`, {
            method: "DELETE",
          });
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
    });
  }

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
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
    });
  }

  executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): PluginEffect<unknown> {
    return attempt(async () => {
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
    });
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderMailgunDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderMailgunSidebar(resource);
  }
}
