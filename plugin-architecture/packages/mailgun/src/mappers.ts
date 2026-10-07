/**
 * Mailgun response shapes (the fields this plugin reads, verified against the
 * OpenAPI document, 2026-10) and their mapping to `ResourceInstance`s.
 */
import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { MailgunRegion } from "./api.js";
import { API_HOSTS, SMTP_HOSTS } from "./api.js";
import { WEBHOOK_EVENTS, eventFieldKey } from "./resource-types.js";

export const PLUGIN_ID = "mailgun";

export interface MgDomain {
  id?: string;
  name?: string;
  state?: string;
  type?: string;
  spam_action?: string;
  web_scheme?: string;
  web_prefix?: string;
  tracking_host?: string;
  wildcard?: boolean;
  require_tls?: boolean;
  skip_verification?: boolean;
  use_automatic_sender_security?: boolean;
  message_ttl?: number;
  archive_to?: string;
  smtp_login?: string;
  is_disabled?: boolean;
  disabled?: { reason?: string; note?: string; until?: string } | null;
  subaccount_id?: string;
  created_at?: string;
}

export interface MgDnsRecord {
  is_active?: boolean;
  cached?: string[];
  name?: string;
  priority?: string;
  record_type?: string;
  valid?: string;
  value?: string;
}

export interface MgDomainDetail {
  domain?: MgDomain | null;
  receiving_dns_records?: Array<MgDnsRecord | null>;
  sending_dns_records?: Array<MgDnsRecord | null>;
}

export interface MgTracking {
  open?: { active?: boolean };
  click?: { active?: boolean };
  unsubscribe?: { active?: boolean };
}

/** A domain read in full: details, DNS, tracking, IP pool. */
export interface DomainBundle {
  region: MailgunRegion;
  detail: MgDomainDetail;
  tracking?: MgTracking;
  ipPoolId?: string;
}

export interface MgKey {
  id?: string;
  description?: string;
  kind?: string;
  role?: string;
  created_at?: string;
  updated_at?: string;
  expires_at?: string | null;
  disabled_reason?: string | null;
  is_disabled?: boolean;
  domain_name?: string | null;
  user_name?: string | null;
  secret?: string;
}

export interface MgRoute {
  id?: string;
  priority?: number;
  description?: string;
  expression?: string;
  actions?: string[];
  created_at?: string;
}

export interface MgList {
  address?: string;
  name?: string;
  description?: string;
  access_level?: string;
  reply_preference?: string;
  created_at?: string;
  members_count?: number;
}

export interface MgCredential {
  login?: string;
  mailbox?: string;
  created_at?: string;
}

export interface MgIpPool {
  pool_id?: string;
  name?: string;
  description?: string;
  ips?: string[];
  is_linked?: boolean;
  is_inherited?: boolean;
}

export interface MgIpDetail {
  ip?: string;
  is_on_warmup?: boolean;
  dedicated?: boolean;
  enabled?: boolean;
}

export interface MgTag {
  tag?: string;
  description?: string;
  first_seen?: unknown;
  last_seen?: unknown;
}

export interface MgSubaccount {
  id?: string;
  name?: string;
  status?: string;
  created_at?: string;
}

export interface MgAccountWebhook {
  webhook_id?: string;
  description?: string;
  url?: string;
  event_types?: string[];
  created_at?: string;
}

type Fields = ResourceInstance["fields"];

function clean(fields: Record<string, string | number | boolean | null | undefined>): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

export function resourceId(accountId: string, typeId: string, externalId: string): string {
  return `${accountId}:${typeId}:${externalId}`;
}

function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Fields,
  parentResourceId?: string,
): ResourceInstance {
  const at = new Date().toISOString();
  return {
    id: resourceId(accountId, typeId, externalId),
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields,
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    ...(parentResourceId ? { parentResourceId } : {}),
    createdAt: at,
    updatedAt: at,
  };
}

/** `{region}/{rest}` external ids. */
export function splitRegion(externalId: string): { region: MailgunRegion; rest: string } {
  const slash = externalId.indexOf("/");
  const head = slash < 0 ? "" : externalId.slice(0, slash);
  if (head === "us" || head === "eu") return { region: head, rest: externalId.slice(slash + 1) };
  return { region: "us", rest: externalId };
}

const domainParent = (accountId: string, region: MailgunRegion, domain: string) =>
  resourceId(accountId, "mailgun-domain", `${region}/${domain}`);

export function mapDomain(accountId: string, b: DomainBundle): ResourceInstance {
  const d = b.detail.domain ?? {};
  const name = d.name ?? "";
  const r = instance(
    accountId,
    "mailgun-domain",
    `${b.region}/${name}`,
    name,
    clean({
      name,
      region: b.region,
      state: d.state,
      type: d.type,
      spamAction: d.spam_action,
      webScheme: d.web_scheme,
      webPrefix: d.web_prefix,
      trackingHost: d.tracking_host,
      trackOpens: b.tracking?.open?.active,
      trackClicks: b.tracking?.click?.active,
      trackUnsubscribes: b.tracking?.unsubscribe?.active,
      wildcard: d.wildcard,
      requireTls: d.require_tls,
      skipVerification: d.skip_verification,
      automaticSenderSecurity: d.use_automatic_sender_security,
      messageTtl: d.message_ttl,
      archiveTo: d.archive_to ?? "",
      smtpLogin: d.smtp_login,
      disabled: d.is_disabled,
      disabledReason: d.disabled?.reason ?? d.disabled?.note,
      ipPoolId: b.ipPoolId,
      subaccountId: d.subaccount_id,
      domainId: d.id,
      createdAt: d.created_at,
    }),
  );
  r.resolvedOutputs = {
    name,
    smtpHost: SMTP_HOSTS[b.region],
    apiBaseUrl: API_HOSTS[b.region],
  };
  return r;
}

export function mapDnsRecords(accountId: string, b: DomainBundle): ResourceInstance[] {
  const domain = b.detail.domain?.name ?? "";
  const parent = domainParent(accountId, b.region, domain);
  const out: ResourceInstance[] = [];
  const add = (list: Array<MgDnsRecord | null> | undefined, purpose: string, key: string) => {
    (list ?? []).forEach((rec, i) => {
      if (!rec?.value || !rec.record_type) return;
      const type = rec.record_type.toUpperCase();
      // Receiving MX records carry no name: they sit on the domain itself.
      const name = rec.name || domain;
      const priority =
        rec.priority !== undefined && rec.priority !== "" ? Number(rec.priority) : undefined;
      out.push(
        instance(
          accountId,
          "mailgun-dns-record",
          `${b.region}/${domain}/${key}/${i}`,
          `${type} ${name}`,
          clean({
            name,
            type,
            content: rec.value,
            priority: Number.isFinite(priority) ? priority : undefined,
            purpose: purposeOf(type, name, purpose),
            valid: rec.valid,
            cached: (rec.cached ?? []).join(", "),
            domainName: domain,
            region: b.region,
          }),
          parent,
        ),
      );
    });
  };
  add(b.detail.sending_dns_records, "Sending", "sending");
  add(b.detail.receiving_dns_records, "Receiving", "receiving");
  return out;
}

function purposeOf(type: string, name: string, group: string): string {
  if (type === "MX") return "Receiving (MX)";
  if (type === "CNAME") return "Tracking (CNAME)";
  if (type === "TXT" && /_domainkey/i.test(name)) return "DKIM";
  if (type === "TXT") return "SPF";
  return group;
}

export function mapKey(accountId: string, k: MgKey): ResourceInstance {
  const id = k.id ?? "";
  const r = instance(
    accountId,
    "mailgun-api-key",
    id,
    k.description || (k.domain_name ? `Sending key for ${k.domain_name}` : id),
    clean({
      description: k.description ?? "",
      kind: k.kind,
      role: k.role,
      domainName: k.domain_name,
      userName: k.user_name,
      disabled: k.is_disabled,
      disabledReason: k.disabled_reason,
      expiresAt: k.expires_at,
      createdAt: k.created_at,
      keyId: id,
    }),
  );
  if (k.secret) r.resolvedOutputs = { keyId: id, secret: k.secret };
  return r;
}

/**
 * The v3 webhooks response maps event → URLs. A webhook resource is one URL
 * on one domain with the events it receives, which is how the v4 API writes.
 */
export function groupWebhooks(
  webhooks: Record<string, { urls?: string[] } | null | undefined>,
): Map<string, Set<string>> {
  const byUrl = new Map<string, Set<string>>();
  for (const [event, entry] of Object.entries(webhooks ?? {})) {
    for (const url of entry?.urls ?? []) {
      if (!byUrl.has(url)) byUrl.set(url, new Set());
      byUrl.get(url)?.add(event);
    }
  }
  return byUrl;
}

function eventFields(events: Iterable<string>): Record<string, boolean> {
  const set = new Set(events);
  const out: Record<string, boolean> = {};
  for (const [event] of WEBHOOK_EVENTS) out[eventFieldKey(event)] = set.has(event);
  return out;
}

/** Event flags from form values (strings or booleans) → event type ids. */
export function eventsFrom(
  values: Record<string, string | number | boolean | undefined>,
): string[] {
  return WEBHOOK_EVENTS.filter(([event]) => {
    const v = values[eventFieldKey(event)];
    return v === true || v === "true";
  }).map(([event]) => event);
}

export function mapWebhook(
  accountId: string,
  region: MailgunRegion,
  domain: string,
  url: string,
  events: Iterable<string>,
): ResourceInstance {
  return instance(
    accountId,
    "mailgun-webhook",
    `${region}/${domain}/${url}`,
    url,
    clean({ url, domainName: domain, region, ...eventFields(events) }),
    domainParent(accountId, region, domain),
  );
}

export function mapAccountWebhook(accountId: string, w: MgAccountWebhook): ResourceInstance {
  const id = w.webhook_id ?? "";
  return instance(
    accountId,
    "mailgun-account-webhook",
    id,
    w.description || w.url || id,
    clean({
      url: w.url,
      description: w.description ?? "",
      ...eventFields(w.event_types ?? []),
      webhookId: id,
      createdAt: w.created_at,
    }),
  );
}

export function mapRoute(accountId: string, region: MailgunRegion, r: MgRoute): ResourceInstance {
  const id = r.id ?? "";
  return instance(
    accountId,
    "mailgun-route",
    `${region}/${id}`,
    r.description || r.expression || id,
    clean({
      description: r.description ?? "",
      expression: r.expression,
      actions: (r.actions ?? []).join("\n"),
      priority: r.priority,
      region,
      routeId: id,
      createdAt: r.created_at,
    }),
  );
}

/** Route actions as entered: one per line (commas inside an action stay intact). */
export function parseActions(raw: string): string[] {
  return raw
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function mapList(accountId: string, region: MailgunRegion, l: MgList): ResourceInstance {
  const address = l.address ?? "";
  return instance(
    accountId,
    "mailgun-mailing-list",
    `${region}/${address}`,
    address,
    clean({
      address,
      name: l.name ?? "",
      description: l.description ?? "",
      accessLevel: l.access_level,
      replyPreference: l.reply_preference,
      membersCount: l.members_count,
      region,
      createdAt: l.created_at,
    }),
  );
}

export function mapCredential(
  accountId: string,
  region: MailgunRegion,
  domain: string,
  c: MgCredential,
): ResourceInstance {
  const login = c.login ?? c.mailbox ?? "";
  const r = instance(
    accountId,
    "mailgun-smtp-credential",
    `${region}/${domain}/${login}`,
    login,
    clean({ login, domainName: domain, region, createdAt: c.created_at }),
    domainParent(accountId, region, domain),
  );
  r.resolvedOutputs = { login, smtpHost: SMTP_HOSTS[region] };
  return r;
}

export function mapIpPool(accountId: string, p: MgIpPool): ResourceInstance {
  const id = p.pool_id ?? "";
  return instance(
    accountId,
    "mailgun-ip-pool",
    id,
    p.name || id,
    clean({
      name: p.name,
      description: p.description ?? "",
      ips: (p.ips ?? []).join(", "),
      ipCount: (p.ips ?? []).length,
      linked: p.is_linked,
      inherited: p.is_inherited,
      poolId: id,
    }),
  );
}

export function mapIp(accountId: string, ip: MgIpDetail, pools: string[]): ResourceInstance {
  const addr = ip.ip ?? "";
  return instance(
    accountId,
    "mailgun-ip",
    addr,
    addr,
    clean({
      ip: addr,
      dedicated: ip.dedicated,
      enabled: ip.enabled,
      warmingUp: ip.is_on_warmup,
      pools: pools.join(", "),
    }),
  );
}

function seenAt(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["timestamp", "time", "date", "value"])
      if (typeof o[k] === "string") return o[k] as string;
  }
  return undefined;
}

export function mapTag(accountId: string, region: MailgunRegion, t: MgTag): ResourceInstance {
  const tag = t.tag ?? "";
  return instance(
    accountId,
    "mailgun-tag",
    `${region}/${tag}`,
    tag,
    clean({
      tag,
      description: t.description ?? "",
      firstSeen: seenAt(t.first_seen),
      lastSeen: seenAt(t.last_seen),
      region,
    }),
  );
}

export function mapSubaccount(
  accountId: string,
  s: MgSubaccount,
  limit?: { limit?: number; current?: number },
): ResourceInstance {
  const id = s.id ?? "";
  return instance(
    accountId,
    "mailgun-subaccount",
    id,
    s.name || id,
    clean({
      name: s.name,
      status: s.status,
      monthlyLimit: limit?.limit,
      monthlySent: limit?.current,
      subaccountId: id,
      createdAt: s.created_at,
    }),
  );
}
