import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { ApiBody, PluginEffect } from "@infrawrench/plugin-base";
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
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { QuotaAccessError, externalIdOf, pathEncode } from "@infrawrench/plugin-base";
import type { SendGridApi, SendGridApis, SendGridContext, SendGridRegion } from "./api.js";
import { createSendGridApis, listTemplates, statusOf } from "./api.js";
import type { operations as AlertOperations } from "./api-types.alerts.gen.js";
import type { operations as DomainOperations } from "./api-types.domain-authentication.gen.js";
import type { operations as SubuserOperations } from "./api-types.subusers.gen.js";
import type { operations as SuppressionOperations } from "./api-types.suppressions.gen.js";
import type { operations as VerifiedSenderOperations } from "./api-types.verified-senders.gen.js";
import type { operations as WebhookOperations } from "./api-types.webhooks.gen.js";
import type {
  AccountSummary,
  SgApiKey,
  SgIp,
  SgSubuserCredits,
  SgVerifiedSender,
} from "./mappers.js";
import {
  domainDnsRecords,
  eventBody,
  keyIdOf,
  linkDnsRecords,
  mapAccount,
  mapAlert,
  mapApiKey,
  mapAsmGroup,
  mapDomain,
  mapEventWebhook,
  mapIp,
  mapIpPool,
  mapLink,
  mapParse,
  mapReverseDns,
  mapSubuser,
  mapTemplate,
  mapVerifiedSender,
  parseDnsRecords,
  reverseDnsRecords,
} from "./mappers.js";
import { rangeOrDefault, seriesFromDays, statDays, sumDays } from "./metrics.js";
import type { DnsRow } from "./render.js";
import {
  AVAILABLE_IPS_KEY,
  COMMANDS,
  DNS_KEY,
  STATS_KEY,
  SUPPRESSIONS_KEY,
  SUPPRESSION_LISTS,
  VERSIONS_KEY,
  renderSendGridDetail,
  renderSendGridSidebar,
} from "./render.js";
import { EVENT_KEYS, eventFieldKey } from "./resource-types.js";

const CONCURRENCY = 4;
const MAX_KEY_SCOPE_READS = 200;
const MAX_ADDRESSES = 1000;
/** SendGrid leaves a subuser's region out of the answer unless asked for it. */
const REGION_QUERY = { include_region: true };

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  const queue = Array.from(items).entries();
  async function worker() {
    for (const [i, item] of queue) out[i] = await fn(item);
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const bool = (v: string | undefined): boolean | undefined =>
  v === undefined || v === "" ? undefined : v === "true";

const trimmed = (fields: Record<string, string>, key: string): string => (fields[key] ?? "").trim();

export function resolveRegion(raw: string | undefined): SendGridRegion {
  return (raw ?? "").trim().toLowerCase() === "eu" ? "eu" : "global";
}

/** Parse a prompt form's values (the host sends them JSON-encoded in `args[0]`). */
export function parsePromptValues(args: (string | number)[]): Record<string, string> {
  const first = args[0];
  if (typeof first !== "string" || !first) return {};
  try {
    const parsed: Record<string, string | number | boolean | null> | null = JSON.parse(first);
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

/** A policy-picker value (JSON array) or a comma-separated list, as scope ids. */
export function parseScopes(raw: string): string[] {
  const value = raw.trim();
  if (!value) return [];
  if (value.startsWith("[")) {
    try {
      const parsed: string[] | object = JSON.parse(value);
      if (Array.isArray(parsed)) return [...new Set(parsed.map(String).filter(Boolean))];
    } catch {
      // fall through to the comma split
    }
  }
  return [...new Set(value.split(/[\s,]+/).filter(Boolean))];
}

/** 403/404 mean the key lacks the scope or the plan lacks the feature: list it empty. */
function isUnavailable(err: unknown): boolean {
  const s = statusOf(err);
  return s === 403 || s === 404;
}

function toRows(records: ResourceInstance[]): DnsRow[] {
  return records.map((r) => {
    const valid = r.fields["valid"];
    return {
      type: String(r.fields["type"] ?? ""),
      name: String(r.fields["name"] ?? ""),
      content: String(r.fields["content"] ?? ""),
      purpose: String(r.fields["purpose"] ?? ""),
      ...(typeof valid === "boolean" ? { valid } : {}),
    };
  });
}

function stash(r: ResourceInstance, extras: Record<string, object | undefined>): ResourceInstance {
  const out: Record<string, string> = { ...r.resolvedOutputs };
  for (const [k, v] of Object.entries(extras)) {
    if (v !== undefined) out[k] = JSON.stringify(v);
  }
  return { ...r, resolvedOutputs: out };
}

/** What the three `validate` endpoints have in common: one result per record. */
type ValidationAnswer =
  | {
      valid?: boolean;
      validation_results?: Record<string, { valid?: boolean; reason?: string | null } | undefined>;
    }
  | undefined;

function notFound(typeId: string, resourceId: string): Error {
  return Object.assign(new Error(`SendGrid plugin: ${typeId} ${resourceId} not found`), {
    status: 404,
  });
}

export class SendGridClient implements PluginClient {
  readonly ctx: SendGridContext;
  private readonly api: SendGridApi;
  private readonly parent: SendGridApi;
  private readonly apis: SendGridApis;

  constructor(credentials: Credentials, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) throw new Error("SendGrid plugin: missing API key");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      apiKey,
      region: resolveRegion(credentials["region"]),
      onBehalfOf: (credentials["onBehalfOf"] ?? "").trim(),
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
    this.apis = createSendGridApis(this.ctx);
    this.api = this.apis.api;
    this.parent = this.apis.parent;
  }

  private async scoped(load: () => Promise<ResourceInstance[]>): Promise<ResourceInstance[]> {
    try {
      return await load();
    } catch (err) {
      if (isUnavailable(err)) return [];
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Raw lists (shared by listers, DNS records and pickers)
  // -------------------------------------------------------------------------

  private domains() {
    return this.api.getAll("/v3/whitelabel/domains", null);
  }

  private async links() {
    const res = await this.api.get("/v3/whitelabel/links", { query: { limit: 500 } });
    return Array.isArray(res) ? res : [];
  }

  private reverseDns() {
    return this.api.getAll("/v3/whitelabel/ips", null);
  }

  private async parses() {
    const res = await this.api.get("/v3/user/webhooks/parse/settings");
    return res?.result ?? [];
  }

  private ips(): Promise<SgIp[]> {
    return this.api.getAll("/v3/ips", null);
  }

  private async scopes(): Promise<string[]> {
    const res = await this.api.get("/v3/scopes");
    return res?.scopes ?? [];
  }

  private async apiKeyDetail(id: string): Promise<SgApiKey> {
    // The spec wraps the single key in `result: [...]`; the live API answers a bare object.
    const res = await this.api.get(`/v3/api_keys/${pathEncode(id)}`);
    return res?.result?.[0] ?? res;
  }

  private async verifiedSenders(): Promise<SgVerifiedSender[]> {
    const out: SgVerifiedSender[] = [];
    let lastSeen: number | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await this.api.get("/v3/verified_senders", {
        query: { limit: 100, ...(lastSeen !== undefined ? { lastSeenID: lastSeen } : {}) },
      });
      const items = res?.results ?? [];
      out.push(...items);
      const last = items.at(-1)?.id;
      if (items.length < 100 || last === undefined || last === lastSeen) break;
      lastSeen = last;
    }
    return out;
  }

  private async poolIps(name: string): Promise<string[]> {
    const res = await this.api.get(`/v3/ips/pools/${pathEncode(name)}`);
    return (res?.ips ?? [])
      .map((ip) => (typeof ip === "string" ? ip : (ip.ip ?? "")))
      .filter(Boolean);
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      switch (typeId) {
        case "sendgrid-account":
          return [await this.loadAccount(accountId)];
        case "sendgrid-api-key":
          return this.scoped(async () => {
            const res = await this.api.get("/v3/api_keys");
            const keys = res?.result ?? [];
            const inUse = keyIdOf(this.ctx.apiKey);
            const detailed = await mapLimit(keys, CONCURRENCY, async (k): Promise<SgApiKey> =>
              k.api_key_id && keys.indexOf(k) < MAX_KEY_SCOPE_READS
                ? await this.apiKeyDetail(k.api_key_id).catch(() => k)
                : k,
            );
            return detailed.map((k) => mapApiKey(accountId, k, inUse));
          });
        case "sendgrid-domain":
          return this.scoped(async () =>
            (await this.domains()).map((d) => mapDomain(accountId, d)),
          );
        case "sendgrid-link-branding":
          return this.scoped(async () => (await this.links()).map((l) => mapLink(accountId, l)));
        case "sendgrid-reverse-dns":
          return this.scoped(async () =>
            (await this.reverseDns()).map((r) => mapReverseDns(accountId, r)),
          );
        case "sendgrid-dns-record": {
          const [domains, links, rdns, parses] = await Promise.all([
            this.scoped(async () =>
              (await this.domains()).flatMap((d) => domainDnsRecords(accountId, d)),
            ),
            this.scoped(async () =>
              (await this.links()).flatMap((l) => linkDnsRecords(accountId, l)),
            ),
            this.scoped(async () =>
              (await this.reverseDns()).flatMap((r) => reverseDnsRecords(accountId, r)),
            ),
            this.scoped(async () =>
              (await this.parses()).flatMap((p) => parseDnsRecords(accountId, p)),
            ),
          ]);
          return [...domains, ...links, ...rdns, ...parses];
        }
        case "sendgrid-ip":
          return this.scoped(async () => (await this.ips()).map((ip) => mapIp(accountId, ip)));
        case "sendgrid-ip-pool":
          return this.scoped(async () => {
            const pools = await this.api.get("/v3/ips/pools");
            const names = (Array.isArray(pools) ? pools : [])
              .map((p) => p.name ?? "")
              .filter(Boolean);
            return mapLimit(names, CONCURRENCY, async (name) =>
              mapIpPool(accountId, name, await this.poolIps(name).catch(() => undefined)),
            );
          });
        case "sendgrid-subuser":
          // Subusers belong to the parent account; a connection acting as a subuser has none.
          if (this.ctx.onBehalfOf) return [];
          return this.scoped(async () =>
            (await this.parent.getAll("/v3/subusers", null, { query: REGION_QUERY })).map((s) =>
              mapSubuser(accountId, s),
            ),
          );
        case "sendgrid-event-webhook":
          return this.scoped(async () => {
            const res = await this.api.get("/v3/user/webhooks/event/settings/all");
            return (res?.webhooks ?? []).map((w) => mapEventWebhook(accountId, w));
          });
        case "sendgrid-inbound-parse":
          return this.scoped(async () => (await this.parses()).map((p) => mapParse(accountId, p)));
        case "sendgrid-template":
          return this.scoped(async () =>
            (await listTemplates(this.api)).map((t) => mapTemplate(accountId, t)),
          );
        case "sendgrid-unsubscribe-group":
          return this.scoped(async () => {
            const res = await this.api.get("/v3/asm/groups");
            return (Array.isArray(res) ? res : []).map((g) => mapAsmGroup(accountId, g));
          });
        case "sendgrid-verified-sender":
          return this.scoped(async () =>
            (await this.verifiedSenders()).map((s) => mapVerifiedSender(accountId, s)),
          );
        case "sendgrid-alert":
          return this.scoped(async () => {
            const res = await this.api.get("/v3/alerts");
            return (Array.isArray(res) ? res : []).map((a) => mapAlert(accountId, a));
          });
        default:
          throw new Error(`SendGrid plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  private async loadAccount(accountId: string): Promise<ResourceInstance> {
    // The username call doubles as the credential check: a bad key fails here.
    const user = await this.api.get("/v3/user/username");
    const [account, credits, profile] = await Promise.all([
      this.api.get("/v3/user/account").catch(() => undefined),
      this.api.get("/v3/user/credits").catch(() => undefined),
      this.api.get("/v3/user/profile").catch(() => undefined),
    ]);
    const summary: AccountSummary = {
      username: user?.username ?? this.ctx.onBehalfOf ?? "sendgrid",
      region: this.ctx.region,
      onBehalfOf: this.ctx.onBehalfOf,
      ...(user?.user_id !== undefined ? { userId: user.user_id } : {}),
      ...(account?.type ? { type: account.type } : {}),
      ...(typeof account?.reputation === "number" ? { reputation: account.reputation } : {}),
      ...(credits ? { credits } : {}),
      ...(profile?.company ? { company: profile.company } : {}),
    };
    return mapAccount(accountId, summary);
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
      const id = externalIdOf(resourceId);
      const enc = pathEncode(id);
      switch (typeId) {
        case "sendgrid-account": {
          const r = await this.loadAccount(accountId);
          const end = Date.now();
          const [stats, ...lists] = await Promise.all([
            statDays(this.apis, { startMs: end - 30 * 86_400_000, endMs: end })
              .then(sumDays)
              .catch(() => undefined),
            ...SUPPRESSION_LISTS.map((l) =>
              this.api.get(l.path, { query: { limit: 50, offset: 0 } }).catch(() => undefined),
            ),
          ]);
          const supp: Record<string, object[]> = {};
          SUPPRESSION_LISTS.forEach((l, i) => {
            const rows = lists[i];
            if (Array.isArray(rows)) supp[l.id] = rows;
          });
          return stash(r, {
            [STATS_KEY]: stats,
            [SUPPRESSIONS_KEY]: Object.keys(supp).length > 0 ? supp : undefined,
          });
        }
        case "sendgrid-api-key":
          return mapApiKey(accountId, await this.apiKeyDetail(id), keyIdOf(this.ctx.apiKey));
        case "sendgrid-domain": {
          const d = await this.api.get(`/v3/whitelabel/domains/${enc}`);
          return stash(mapDomain(accountId, d), {
            [DNS_KEY]: toRows(domainDnsRecords(accountId, d)),
          });
        }
        case "sendgrid-link-branding": {
          const l = await this.api.get(`/v3/whitelabel/links/${enc}`);
          return stash(mapLink(accountId, l), { [DNS_KEY]: toRows(linkDnsRecords(accountId, l)) });
        }
        case "sendgrid-reverse-dns": {
          const r = await this.api.get(`/v3/whitelabel/ips/${enc}`);
          return stash(mapReverseDns(accountId, r), {
            [DNS_KEY]: toRows(reverseDnsRecords(accountId, r)),
          });
        }
        case "sendgrid-ip":
          return mapIp(accountId, await this.api.get(`/v3/ips/${enc}`));
        case "sendgrid-ip-pool": {
          const [ips, all] = await Promise.all([
            this.poolIps(id),
            this.ips().catch((): SgIp[] => []),
          ]);
          const inPool = new Set(ips);
          const available = all.map((i) => i.ip ?? "").filter((ip) => ip && !inPool.has(ip));
          return stash(mapIpPool(accountId, id, ips), { [AVAILABLE_IPS_KEY]: available });
        }
        case "sendgrid-subuser": {
          const list = await this.parent.get("/v3/subusers", {
            query: { username: id, ...REGION_QUERY },
          });
          const s = (Array.isArray(list) ? list : []).find((x) => x.username === id);
          if (!s) throw notFound(typeId, resourceId);
          const end = Date.now();
          const [credits, reps, stats] = await Promise.all([
            this.parent.get(`/v3/subusers/${enc}/credits`).catch(() => undefined),
            this.parent
              .get("/v3/subusers/reputations", { query: { usernames: id } })
              .catch(() => undefined),
            statDays(this.apis, { startMs: end - 30 * 86_400_000, endMs: end }, id)
              .then(sumDays)
              .catch(() => undefined),
          ]);
          const reputation = (reps ?? []).find((x) => x.username === id)?.reputation;
          return stash(
            mapSubuser(accountId, s, {
              ...(credits ? { credits } : {}),
              ...(typeof reputation === "number" ? { reputation } : {}),
            }),
            { [STATS_KEY]: stats },
          );
        }
        case "sendgrid-event-webhook":
          return mapEventWebhook(
            accountId,
            await this.api.get(`/v3/user/webhooks/event/settings/${enc}`),
          );
        case "sendgrid-inbound-parse":
          return mapParse(accountId, await this.api.get(`/v3/user/webhooks/parse/settings/${enc}`));
        case "sendgrid-template": {
          const t = await this.api.get(`/v3/templates/${enc}`);
          return stash(mapTemplate(accountId, t), {
            [VERSIONS_KEY]: (t.versions ?? []).map((v) => ({
              name: v.name,
              subject: v.subject,
              active: v.active,
              updated_at: v.updated_at,
              editor: v.editor,
            })),
          });
        }
        case "sendgrid-unsubscribe-group":
          return mapAsmGroup(accountId, await this.api.get(`/v3/asm/groups/${enc}`));
        case "sendgrid-verified-sender": {
          const res = await this.api.get("/v3/verified_senders", { query: { id } });
          const s = (res?.results ?? []).find((x) => String(x.id) === id);
          if (!s) throw notFound(typeId, resourceId);
          return mapVerifiedSender(accountId, s);
        }
        case "sendgrid-alert":
          return mapAlert(accountId, await this.api.get(`/v3/alerts/${enc}`));
        default: {
          const all = await runPluginEffect(this.listResources(typeId, accountId));
          const found = all.find((r) => r.id === resourceId || r.externalId === id);
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
      const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const resolved = resource.resolvedOutputs[outputKey];
      if (resolved !== undefined) return resolved;
      const field = resource.fields[outputKey];
      if (field !== undefined) return String(field);
      throw new Error(`SendGrid plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
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
      if (resourceTypeId === "sendgrid-account")
        return seriesFromDays(await statDays(this.apis, range));
      if (resourceTypeId === "sendgrid-subuser") {
        return seriesFromDays(await statDays(this.apis, range, externalIdOf(resourceId)));
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
      if (resourceTypeId !== "sendgrid-account") return [];
      const r = await this.loadAccount(accountId);
      const total = Number(r.fields["creditsTotal"] ?? 0);
      const used = Number(r.fields["creditsUsed"] ?? 0);
      const p = total > 0 ? used / total : undefined;
      return [
        {
          label: "Credits used",
          value: p === undefined ? "—" : `${Math.round(p * 100)}%`,
          variant:
            p === undefined
              ? "default"
              : p >= 1
                ? "status-error"
                : p >= 0.8
                  ? "status-degraded"
                  : "status-healthy",
        },
        {
          label: "Reputation",
          value: r.fields["reputation"] !== undefined ? `${r.fields["reputation"]}%` : "—",
        },
      ];
    });
  }

  fetchQuotas(_accountId: string): PluginEffect<QuotaUsage[]> {
    return attempt(async () => {
      let credits: AccountSummary["credits"];
      try {
        credits = await this.api.get("/v3/user/credits");
      } catch (err) {
        if (statusOf(err) === 403) {
          throw new QuotaAccessError(
            "This SendGrid API key cannot read email credits. Give it the user.credits.read scope.",
            {
              label: "Edit API keys",
              url: "https://app.sendgrid.com/settings/api_keys",
            },
          );
        }
        throw err;
      }
      const total = Number(credits?.total ?? 0);
      if (!Number.isFinite(total) || total <= 0) return [];
      return [
        {
          id: "email-credits",
          service: "Email",
          name: `Email credits this ${credits?.reset_frequency ?? "period"}`,
          limit: total,
          used: Number(credits?.used ?? 0),
          unit: "emails",
          adjustable: true,
          docsUrl: "https://app.sendgrid.com/account/billing",
        },
      ];
    });
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  getCreateConfig(typeId: string): PluginEffect<CreateResourceConfig> {
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
      switch (typeId) {
        case "sendgrid-api-key": {
          const scopes = await this.scopes().catch((): string[] => []);
          return {
            fields: [
              text("name", "Name", { required: true }),
              {
                key: "access",
                label: "Access",
                kind: "select",
                required: true,
                defaultValue: "mail",
                options: [
                  {
                    id: "mail",
                    label: "Mail Send only",
                    description: "mail.send: the usual key for an app.",
                  },
                  {
                    id: "full",
                    label: "Everything this connection can do",
                    description: `${scopes.length} scopes.`,
                  },
                  { id: "custom", label: "Pick scopes" },
                ],
              },
              {
                key: "scopes",
                label: "Scopes",
                kind: "policy-picker",
                required: false,
                showWhen: { fieldKey: "access", fieldValue: "custom" },
                description: "A key can only be given scopes the connected key holds.",
                policies: scopes.map((s) => ({
                  id: s,
                  label: s,
                  category: s.split(".")[0] ?? "other",
                })),
              },
            ],
          };
        }
        case "sendgrid-domain":
          return {
            fields: [
              text("domain", "Domain", { required: true, placeholder: "example.com" }),
              text("subdomain", "Return-Path subdomain", {
                placeholder: "em1234",
                description: "Optional. SendGrid picks one when blank.",
              }),
              toggle(
                "automaticSecurity",
                "Automated security",
                true,
                "SendGrid manages SPF and rotates DKIM through CNAME records. Off gives TXT and MX records you manage.",
              ),
              text("customDkimSelector", "Custom DKIM selector", {
                placeholder: "s1",
                description: "Three letters or numbers. Optional.",
              }),
              toggle("default", "Make default", false),
              {
                key: "region",
                label: "Data region",
                kind: "select",
                required: false,
                defaultValue: "global",
                options: [
                  { id: "global", label: "Global" },
                  { id: "eu", label: "EU" },
                ],
              },
            ],
          };
        case "sendgrid-link-branding":
          return {
            fields: [
              text("domain", "Domain", { required: true, placeholder: "example.com" }),
              text("subdomain", "Subdomain", {
                placeholder: "links",
                description: "Optional. SendGrid picks one when blank.",
              }),
              toggle("default", "Make default", false),
            ],
          };
        case "sendgrid-reverse-dns": {
          const ips = await this.ips().catch((): SgIp[] => []);
          return {
            fields: [
              {
                key: "ip",
                label: "Dedicated IP",
                kind: "select",
                required: true,
                options: ips.map((i) => ({
                  id: i.ip ?? "",
                  label: i.ip ?? "",
                  description: i.rdns ?? "",
                })),
              },
              text("domain", "Domain", { required: true, placeholder: "example.com" }),
              text("subdomain", "Subdomain", { placeholder: "o1", description: "Optional." }),
            ],
          };
        }
        case "sendgrid-ip-pool":
          return {
            fields: [text("name", "Name", { required: true, description: "Up to 64 characters." })],
          };
        case "sendgrid-subuser": {
          const ips = await this.ips().catch((): SgIp[] => []);
          return {
            fields: [
              text("username", "Username", { required: true }),
              text("email", "Email", { required: true }),
              { key: "password", label: "Password", kind: "password", required: true },
              {
                key: "ips",
                label: "Dedicated IPs",
                kind: "policy-picker",
                required: true,
                description: "At least one IP the subuser sends from.",
                policies: ips.map((i) => ({
                  id: i.ip ?? "",
                  label: i.ip ?? "",
                  ...(i.rdns ? { description: i.rdns } : {}),
                })),
              },
              {
                key: "region",
                label: "Region",
                kind: "select",
                required: false,
                defaultValue: "global",
                options: [
                  { id: "global", label: "Global" },
                  { id: "eu", label: "EU" },
                ],
              },
            ],
          };
        }
        case "sendgrid-event-webhook":
          return {
            fields: [
              text("friendlyName", "Name"),
              text("url", "URL", {
                required: true,
                placeholder: "https://example.com/sendgrid/events",
              }),
              toggle("enabled", "Enabled", true),
              ...EVENT_KEYS.map(([event, label]) =>
                toggle(
                  eventFieldKey(event),
                  label,
                  ["delivered", "bounce", "dropped", "spam_report"].includes(event),
                ),
              ),
            ],
          };
        case "sendgrid-inbound-parse":
          return {
            fields: [
              text("hostname", "Receiving hostname", {
                required: true,
                placeholder: "parse.example.com",
                description:
                  "A domain or subdomain you control. Point its MX record at mx.sendgrid.net.",
              }),
              text("url", "Destination URL", {
                required: true,
                placeholder: "https://example.com/inbound",
              }),
              toggle("spamCheck", "Check for spam", false),
              toggle("sendRaw", "Post the raw MIME", false),
            ],
          };
        case "sendgrid-template":
          return {
            fields: [
              text("name", "Name", { required: true }),
              {
                key: "generation",
                label: "Generation",
                kind: "select",
                required: true,
                defaultValue: "dynamic",
                options: [
                  { id: "dynamic", label: "Dynamic", description: "Handlebars templates." },
                  { id: "legacy", label: "Legacy" },
                ],
              },
            ],
          };
        case "sendgrid-unsubscribe-group":
          return {
            fields: [
              text("name", "Name", {
                required: true,
                description: "Up to 30 characters, shown to recipients.",
              }),
              text("description", "Description", {
                required: true,
                description: "Up to 100 characters, shown to recipients.",
              }),
              toggle("isDefault", "Default", false),
            ],
          };
        case "sendgrid-verified-sender":
          return {
            fields: [
              text("nickname", "Nickname", { required: true }),
              text("fromEmail", "From address", { required: true }),
              text("fromName", "From name"),
              text("replyTo", "Reply-To", { required: true }),
              text("replyToName", "Reply-To name"),
              text("address", "Address", { required: true }),
              text("address2", "Address line 2"),
              text("city", "City", { required: true }),
              text("state", "State"),
              text("zip", "ZIP"),
              text("country", "Country", { required: true }),
            ],
          };
        case "sendgrid-alert":
          return {
            fields: [
              {
                key: "type",
                label: "Type",
                kind: "select",
                required: true,
                defaultValue: "usage_limit",
                options: [
                  {
                    id: "usage_limit",
                    label: "Usage limit",
                    description: "When a percentage of the plan's credits is used.",
                  },
                  {
                    id: "stats_notification",
                    label: "Stats summary",
                    description: "A periodic sending summary.",
                  },
                ],
              },
              text("emailTo", "Send to", { required: true, placeholder: "ops@example.com" }),
              {
                key: "percentage",
                label: "At percent used",
                kind: "number",
                required: false,
                defaultValue: "80",
                minValue: 1,
                maxValue: 100,
                showWhen: { fieldKey: "type", fieldValue: "usage_limit" },
              },
              {
                key: "frequency",
                label: "Frequency",
                kind: "select",
                required: false,
                defaultValue: "weekly",
                showWhen: { fieldKey: "type", fieldValue: "stats_notification" },
                options: [
                  { id: "daily", label: "Daily" },
                  { id: "weekly", label: "Weekly" },
                  { id: "monthly", label: "Monthly" },
                ],
              },
            ],
          };
        default:
          throw new Error(`SendGrid plugin: "${typeId}" cannot be created from Infrawrench`);
      }
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      switch (typeId) {
        case "sendgrid-api-key": {
          const access = trimmed(fields, "access") || "mail";
          const scopes =
            access === "full"
              ? await this.scopes()
              : access === "custom"
                ? parseScopes(fields["scopes"] ?? "")
                : ["mail.send"];
          if (scopes.length === 0) throw new Error("SendGrid plugin: pick at least one scope");
          const k = await this.api.post("/v3/api_keys", {
            body: { name: trimmed(fields, "name"), scopes },
          });
          return mapApiKey(accountId, k, keyIdOf(this.ctx.apiKey));
        }
        case "sendgrid-domain": {
          const d = await this.api.post("/v3/whitelabel/domains", {
            body: {
              domain: trimmed(fields, "domain"),
              ...(trimmed(fields, "subdomain") ? { subdomain: trimmed(fields, "subdomain") } : {}),
              automatic_security: bool(fields["automaticSecurity"]) ?? true,
              ...(bool(fields["default"]) !== undefined
                ? { default: bool(fields["default"]) }
                : {}),
              ...(trimmed(fields, "customDkimSelector")
                ? { custom_dkim_selector: trimmed(fields, "customDkimSelector") }
                : {}),
              ...(trimmed(fields, "region") ? { region: trimmed(fields, "region") } : {}),
            },
          });
          return mapDomain(accountId, d);
        }
        case "sendgrid-link-branding":
          return mapLink(
            accountId,
            await this.api.post("/v3/whitelabel/links", {
              body: {
                domain: trimmed(fields, "domain"),
                ...(trimmed(fields, "subdomain")
                  ? { subdomain: trimmed(fields, "subdomain") }
                  : {}),
                ...(bool(fields["default"]) !== undefined
                  ? { default: bool(fields["default"]) }
                  : {}),
              },
            }),
          );
        case "sendgrid-reverse-dns":
          return mapReverseDns(
            accountId,
            await this.api.post("/v3/whitelabel/ips", {
              body: {
                ip: trimmed(fields, "ip"),
                domain: trimmed(fields, "domain"),
                ...(trimmed(fields, "subdomain")
                  ? { subdomain: trimmed(fields, "subdomain") }
                  : {}),
              },
            }),
          );
        case "sendgrid-ip-pool": {
          const name = trimmed(fields, "name");
          await this.api.post("/v3/ips/pools", { body: { name } });
          return mapIpPool(accountId, name, []);
        }
        case "sendgrid-subuser": {
          const ips = parseScopes(fields["ips"] ?? "");
          if (ips.length === 0)
            throw new Error("SendGrid plugin: a subuser needs at least one dedicated IP");
          const s = await this.parent.post("/v3/subusers", {
            body: {
              username: trimmed(fields, "username"),
              email: trimmed(fields, "email"),
              password: fields["password"] ?? "",
              ips,
              ...(trimmed(fields, "region") ? { region: trimmed(fields, "region") } : {}),
            },
          });
          return mapSubuser(accountId, {
            ...s,
            ...(s.user_id !== undefined ? { id: s.user_id } : {}),
          });
        }
        case "sendgrid-event-webhook": {
          const url = trimmed(fields, "url");
          if (!/^https?:\/\//i.test(url))
            throw new Error("SendGrid plugin: the webhook URL must start with https://");
          return mapEventWebhook(
            accountId,
            await this.api.post("/v3/user/webhooks/event/settings", {
              body: {
                url,
                enabled: bool(fields["enabled"]) ?? true,
                ...(trimmed(fields, "friendlyName")
                  ? { friendly_name: trimmed(fields, "friendlyName") }
                  : {}),
                ...eventBody(fields),
              },
            }),
          );
        }
        case "sendgrid-inbound-parse":
          return mapParse(
            accountId,
            await this.api.post("/v3/user/webhooks/parse/settings", {
              body: {
                hostname: trimmed(fields, "hostname"),
                url: trimmed(fields, "url"),
                spam_check: bool(fields["spamCheck"]) ?? false,
                send_raw: bool(fields["sendRaw"]) ?? false,
              },
            }),
          );
        case "sendgrid-template":
          return mapTemplate(
            accountId,
            await this.api.post("/v3/templates", {
              body: {
                name: trimmed(fields, "name"),
                generation: trimmed(fields, "generation") || "dynamic",
              },
            }),
          );
        case "sendgrid-unsubscribe-group":
          return mapAsmGroup(
            accountId,
            await this.api.post("/v3/asm/groups", {
              body: {
                name: trimmed(fields, "name"),
                description: trimmed(fields, "description"),
                is_default: bool(fields["isDefault"]) ?? false,
              },
            }),
          );
        case "sendgrid-verified-sender":
          return mapVerifiedSender(
            accountId,
            await this.api.post("/v3/verified_senders", { body: senderBody(fields) }),
          );
        case "sendgrid-alert": {
          const type = trimmed(fields, "type") || "usage_limit";
          const percentage = Number(trimmed(fields, "percentage") || "80");
          return mapAlert(
            accountId,
            await this.api.post("/v3/alerts", {
              body: {
                type,
                email_to: trimmed(fields, "emailTo"),
                ...(type === "usage_limit"
                  ? { percentage }
                  : { frequency: trimmed(fields, "frequency") || "weekly" }),
              },
            }),
          );
        }
        default:
          throw new Error(`SendGrid plugin: "${typeId}" cannot be created from Infrawrench`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const enc = pathEncode(id);
      switch (typeId) {
        case "sendgrid-api-key": {
          if ("scopes" in fields) {
            const current = await this.apiKeyDetail(id);
            const scopes = parseScopes(fields["scopes"] ?? "");
            if (scopes.length === 0)
              throw new Error("SendGrid plugin: a key needs at least one scope");
            await this.api.put(`/v3/api_keys/${enc}`, {
              body: {
                name: "name" in fields ? trimmed(fields, "name") : (current.name ?? ""),
                scopes,
              },
            });
          } else if ("name" in fields) {
            await this.api.patch(`/v3/api_keys/${enc}`, {
              body: { name: trimmed(fields, "name") },
            });
          }
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "sendgrid-domain": {
          const body: ApiBody<DomainOperations["UpdateAuthenticatedDomain"]> = {};
          if (bool(fields["default"]) !== undefined) body.default = bool(fields["default"]);
          if (bool(fields["customSpf"]) !== undefined) body.custom_spf = bool(fields["customSpf"]);
          await this.api.patch(`/v3/whitelabel/domains/${enc}`, { body });
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "sendgrid-link-branding":
          await this.api.patch(`/v3/whitelabel/links/${enc}`, {
            body: { default: bool(fields["default"]) ?? false },
          });
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        case "sendgrid-ip-pool": {
          const name = trimmed(fields, "name");
          if (!name) return runPluginEffect(this.getResource(typeId, resourceId, accountId));
          await this.api.put(`/v3/ips/pools/${enc}`, { body: { name } });
          return mapIpPool(accountId, name, await this.poolIps(name).catch(() => undefined));
        }
        case "sendgrid-subuser": {
          if (bool(fields["disabled"]) !== undefined) {
            await this.parent.patch(`/v3/subusers/${enc}`, {
              body: { disabled: bool(fields["disabled"]) },
            });
          }
          if (
            "creditType" in fields ||
            "creditTotal" in fields ||
            "creditResetFrequency" in fields
          ) {
            const current = await this.parent
              .get(`/v3/subusers/${enc}/credits`)
              .catch((): SgSubuserCredits => ({}));
            const type = trimmed(fields, "creditType") || current.type || "unlimited";
            const body: ApiBody<SubuserOperations["UpdateSubuserCredit"]> = { type };
            if (type !== "unlimited") {
              const total = Number(trimmed(fields, "creditTotal") || String(current.total ?? ""));
              if (!Number.isFinite(total) || total < 0)
                throw new Error("SendGrid plugin: credits must be a number of zero or more");
              body.total = total;
            }
            if (type === "recurring") {
              body.reset_frequency =
                trimmed(fields, "creditResetFrequency") || current.reset_frequency || "monthly";
            }
            await this.parent.put(`/v3/subusers/${enc}/credits`, { body });
          }
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "sendgrid-event-webhook": {
          const body: ApiBody<WebhookOperations["UpdateEventWebhook"]> = { ...eventBody(fields) };
          if ("url" in fields) body.url = trimmed(fields, "url");
          if ("friendlyName" in fields) body.friendly_name = trimmed(fields, "friendlyName");
          if (bool(fields["enabled"]) !== undefined) body.enabled = bool(fields["enabled"]);
          if (Object.keys(body).length > 0) {
            await this.api.patch(`/v3/user/webhooks/event/settings/${enc}`, { body });
          }
          if (bool(fields["signed"]) !== undefined) {
            await this.api.patch(`/v3/user/webhooks/event/settings/signed/${enc}`, {
              body: { enabled: bool(fields["signed"]) },
            });
          }
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "sendgrid-inbound-parse": {
          const body: ApiBody<WebhookOperations["UpdateParseSetting"]> = {};
          if ("url" in fields) body.url = trimmed(fields, "url");
          if (bool(fields["spamCheck"]) !== undefined) body.spam_check = bool(fields["spamCheck"]);
          if (bool(fields["sendRaw"]) !== undefined) body.send_raw = bool(fields["sendRaw"]);
          return mapParse(
            accountId,
            await this.api.patch(`/v3/user/webhooks/parse/settings/${enc}`, { body }),
          );
        }
        case "sendgrid-template":
          await this.api.patch(`/v3/templates/${enc}`, {
            body: { name: trimmed(fields, "name") },
          });
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        case "sendgrid-unsubscribe-group": {
          const body: ApiBody<SuppressionOperations["UpdateAsmGroup"]> = {};
          if ("name" in fields) body.name = trimmed(fields, "name");
          if ("description" in fields) body.description = trimmed(fields, "description");
          if (bool(fields["isDefault"]) !== undefined) body.is_default = bool(fields["isDefault"]);
          await this.api.patch(`/v3/asm/groups/${enc}`, { body });
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "sendgrid-verified-sender": {
          const body = senderBody(fields, true);
          await this.api.patch(`/v3/verified_senders/${enc}`, { body });
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "sendgrid-alert": {
          const body: ApiBody<AlertOperations["UpdateAlert"]> = {};
          if ("emailTo" in fields) body.email_to = trimmed(fields, "emailTo");
          if (trimmed(fields, "percentage"))
            body.percentage = Number(trimmed(fields, "percentage"));
          if (trimmed(fields, "frequency")) body.frequency = trimmed(fields, "frequency");
          return mapAlert(accountId, await this.api.patch(`/v3/alerts/${enc}`, { body }));
        }
        default:
          throw new Error(`SendGrid plugin: "${typeId}" cannot be edited from Infrawrench`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Delete, actions, commands
  // -------------------------------------------------------------------------

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const enc = pathEncode(id);
      const { api, parent } = this;
      const deletes: Record<string, () => Promise<undefined>> = {
        "sendgrid-api-key": () => api.delete(`/v3/api_keys/${enc}`),
        "sendgrid-domain": () => api.delete(`/v3/whitelabel/domains/${enc}`),
        "sendgrid-link-branding": () => api.delete(`/v3/whitelabel/links/${enc}`),
        "sendgrid-reverse-dns": () => api.delete(`/v3/whitelabel/ips/${enc}`),
        "sendgrid-ip-pool": () => api.delete(`/v3/ips/pools/${enc}`),
        "sendgrid-subuser": () => parent.delete(`/v3/subusers/${enc}`),
        "sendgrid-event-webhook": () => api.delete(`/v3/user/webhooks/event/settings/${enc}`),
        "sendgrid-inbound-parse": () => api.delete(`/v3/user/webhooks/parse/settings/${enc}`),
        "sendgrid-template": () => api.delete(`/v3/templates/${enc}`),
        "sendgrid-unsubscribe-group": () => api.delete(`/v3/asm/groups/${enc}`),
        "sendgrid-verified-sender": () => api.delete(`/v3/verified_senders/${enc}`),
        "sendgrid-alert": () => api.delete(`/v3/alerts/${enc}`),
      };
      const send = deletes[typeId];
      if (!send) throw new Error(`SendGrid plugin: "${typeId}" cannot be deleted from Infrawrench`);
      if (typeId === "sendgrid-api-key" && id === keyIdOf(this.ctx.apiKey)) {
        throw new Error(
          "This is the API key this connection signs in with. Change the account's credentials first, then delete it.",
        );
      }
      await send();
    });
  }

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const enc = pathEncode(id);
      const validate = async (answer: Promise<ValidationAnswer>) => {
        const res = await answer;
        if (res?.valid === false) {
          const reasons = Object.entries(res.validation_results ?? {})
            .filter(([, v]) => v?.valid === false)
            .map(([k, v]) => `${k}: ${v?.reason ?? "not found"}`);
          throw new Error(`SendGrid could not validate every record. ${reasons.join("; ")}`.trim());
        }
      };
      switch (`${typeId}:${actionId}`) {
        case "sendgrid-domain:validate":
          return validate(this.api.post(`/v3/whitelabel/domains/${enc}/validate`));
        case "sendgrid-link-branding:validate":
          return validate(this.api.post(`/v3/whitelabel/links/${enc}/validate`));
        case "sendgrid-reverse-dns:validate":
          return validate(this.api.post(`/v3/whitelabel/ips/${enc}/validate`));
        case "sendgrid-domain:make-default":
        case "sendgrid-link-branding:make-default":
          await runPluginEffect(
            this.updateResource(typeId, resourceId, accountId, { default: "true" }),
          );
          return;
        case "sendgrid-ip:start-warmup":
          await this.api.post("/v3/ips/warmup", { body: { ip: id } });
          return;
        case "sendgrid-ip:stop-warmup":
          await this.api.delete(`/v3/ips/warmup/${enc}`);
          return;
        case "sendgrid-event-webhook:test": {
          const w = await this.api.get(`/v3/user/webhooks/event/settings/${enc}`);
          await this.api.post("/v3/user/webhooks/event/test", { body: { id, url: w.url } });
          return;
        }
        case "sendgrid-verified-sender:resend":
          await this.api.post(`/v3/verified_senders/resend/${enc}`);
          return;
        case "sendgrid-subuser:enable":
        case "sendgrid-subuser:disable":
          await this.parent.patch(`/v3/subusers/${enc}`, {
            body: { disabled: actionId === "disable" },
          });
          return;
        default:
          throw new Error(`SendGrid plugin: unknown action "${actionId}" for "${typeId}"`);
      }
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
      const id = externalIdOf(resourceId);
      const enc = pathEncode(id);
      const emails = () => {
        const list = parseAddresses(values["emails"] ?? "");
        if (list.length === 0) throw new Error("Enter at least one email address.");
        return list;
      };
      if (typeId === "sendgrid-account" && command === COMMANDS.removeSuppressions) {
        const list = SUPPRESSION_LISTS.find((l) => l.id === values["list"]);
        if (!list) throw new Error("Pick a suppression list.");
        const base = list.id === "unsubscribes" ? "/v3/asm/suppressions/global" : list.path;
        const targets = emails();
        await mapLimit(targets, CONCURRENCY, (e) =>
          this.api.delete(`${base}/${pathEncode(e)}`).catch((err) => {
            if (statusOf(err) === 404) return undefined;
            throw err;
          }),
        );
        return { ok: true, count: targets.length };
      }
      if (typeId === "sendgrid-account" && command === COMMANDS.addGlobalUnsubscribes) {
        return this.api.post("/v3/asm/suppressions/global", {
          body: { recipient_emails: emails() },
        });
      }
      if (
        typeId === "sendgrid-ip-pool" &&
        (command === COMMANDS.addPoolIp || command === COMMANDS.removePoolIp)
      ) {
        const ip = (values["ip"] ?? "").trim();
        if (!ip) throw new Error("Pick an IP.");
        return command === COMMANDS.addPoolIp
          ? this.api.post(`/v3/ips/pools/${enc}/ips`, { body: { ip } })
          : this.api.delete(`/v3/ips/pools/${enc}/ips/${pathEncode(ip)}`);
      }
      if (typeId === "sendgrid-unsubscribe-group" && command === COMMANDS.addGroupSuppressions) {
        return this.api.post(`/v3/asm/groups/${enc}/suppressions`, {
          body: { recipient_emails: emails() },
        });
      }
      if (typeId === "sendgrid-unsubscribe-group" && command === COMMANDS.removeGroupSuppressions) {
        const targets = emails();
        await mapLimit(targets, CONCURRENCY, (e) =>
          this.api.delete(`/v3/asm/groups/${enc}/suppressions/${pathEncode(e)}`),
        );
        return { ok: true, count: targets.length };
      }
      throw new Error(`SendGrid plugin: unknown command "${command}" for "${typeId}"`);
    });
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderSendGridDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderSendGridSidebar(resource);
  }
}

const SENDER_FIELDS = {
  nickname: "nickname",
  fromEmail: "from_email",
  fromName: "from_name",
  replyTo: "reply_to",
  replyToName: "reply_to_name",
  address: "address",
  address2: "address2",
  city: "city",
  state: "state",
  zip: "zip",
  country: "country",
} as const;

/** Verified-sender form fields → SendGrid body (only the keys present on an edit). */
export function senderBody(
  fields: Record<string, string>,
  partial = false,
): ApiBody<VerifiedSenderOperations["CreateVerifiedSender"]> {
  const body: ApiBody<VerifiedSenderOperations["CreateVerifiedSender"]> = {};
  for (const [key, param] of Object.entries(SENDER_FIELDS)) {
    if (partial && !(key in fields)) continue;
    const v = (fields[key] ?? "").trim();
    if (!partial && !v) continue;
    body[param] = v;
  }
  return body;
}
