/**
 * SendGrid response shapes (the fields this plugin reads, verified against
 * `twilio/sendgrid-oai` 2026-10) and their mapping to `ResourceInstance`s.
 */
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { EVENT_KEYS, eventFieldKey } from "./resource-types.js";

export const PLUGIN_ID = "sendgrid";

export interface SgDnsEntry {
  valid?: boolean;
  type?: string;
  host?: string;
  data?: string;
}

export interface SgDomain {
  id?: number;
  user_id?: number;
  subdomain?: string;
  domain?: string;
  username?: string;
  ips?: string[];
  custom_spf?: boolean;
  default?: boolean;
  legacy?: boolean;
  automatic_security?: boolean;
  valid?: boolean;
  dns?: Record<string, SgDnsEntry | undefined>;
  subusers?: Array<{ user_id?: number; username?: string }>;
  last_validation_attempt_at?: number;
}

export interface SgLink {
  id?: number;
  domain?: string;
  subdomain?: string;
  username?: string;
  default?: boolean;
  valid?: boolean;
  legacy?: boolean;
  dns?: Record<string, SgDnsEntry | undefined>;
}

export interface SgReverseDns {
  id?: number;
  ip?: string;
  rdns?: string;
  subdomain?: string;
  domain?: string;
  valid?: boolean;
  a_record?: SgDnsEntry;
}

export interface SgIp {
  ip?: string;
  subusers?: string[];
  rdns?: string;
  pools?: string[];
  warmup?: boolean;
  start_date?: number | null;
  whitelabeled?: boolean;
  assigned_at?: number | null;
}

export interface SgApiKey {
  api_key_id?: string;
  name?: string;
  scopes?: string[];
  api_key?: string;
}

export interface SgSubuser {
  id?: number;
  username?: string;
  email?: string;
  disabled?: boolean;
  region?: string;
}

export interface SgSubuserCredits {
  type?: string;
  reset_frequency?: string | null;
  remain?: number | null;
  total?: number | null;
  used?: number | null;
}

export interface SgEventWebhook {
  id?: string;
  enabled?: boolean;
  url?: string;
  friendly_name?: string | null;
  created_date?: string | null;
  updated_date?: string | null;
  oauth_client_id?: string | null;
  public_key?: string | null;
  [event: string]: unknown;
}

export interface SgParse {
  url?: string;
  hostname?: string;
  spam_check?: boolean;
  send_raw?: boolean;
}

export interface SgTemplateVersion {
  id?: string;
  active?: number;
  name?: string;
  subject?: string;
  updated_at?: string;
  html_content?: string;
  plain_content?: string;
  editor?: string;
}

export interface SgTemplate {
  id?: string;
  name?: string;
  generation?: string;
  updated_at?: string;
  versions?: SgTemplateVersion[];
}

export interface SgAsmGroup {
  id?: number;
  name?: string;
  description?: string;
  is_default?: boolean;
  unsubscribes?: number;
}

export interface SgVerifiedSender {
  id?: number;
  nickname?: string;
  from_email?: string;
  from_name?: string;
  reply_to?: string;
  reply_to_name?: string;
  address?: string;
  address2?: string;
  state?: string;
  city?: string;
  zip?: string;
  country?: string;
  verified?: boolean;
  locked?: boolean;
}

export interface SgAlert {
  id?: number;
  type?: string;
  email_to?: string;
  frequency?: string | null;
  percentage?: number | null;
}

export interface AccountSummary {
  username: string;
  userId?: number;
  type?: string;
  reputation?: number;
  credits?: {
    remain?: number;
    total?: number;
    used?: number;
    overage?: number;
    next_reset?: string;
    reset_frequency?: string;
  };
  company?: string;
  region: string;
  onBehalfOf: string;
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

/** Unix seconds → ISO, or undefined. */
export function isoFromUnix(v: number | null | undefined): string | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
  return new Date(v * 1000).toISOString();
}

export function mapAccount(accountId: string, a: AccountSummary): ResourceInstance {
  return instance(
    accountId,
    "sendgrid-account",
    a.username,
    a.username,
    clean({
      username: a.username,
      userId: a.userId,
      type: a.type,
      reputation: a.reputation,
      creditsTotal: a.credits?.total,
      creditsUsed: a.credits?.used,
      creditsRemain: a.credits?.remain,
      creditsOverage: a.credits?.overage,
      creditsResetFrequency: a.credits?.reset_frequency,
      creditsNextReset: a.credits?.next_reset,
      company: a.company,
      region: a.region,
      onBehalfOf: a.onBehalfOf,
    }),
  );
}

/** Admin-equivalent: a key that can mint keys can mint one with every scope it holds. */
export function mapApiKey(accountId: string, k: SgApiKey, inUseId: string): ResourceInstance {
  const id = k.api_key_id ?? "";
  const scopes = k.scopes;
  const r = instance(
    accountId,
    "sendgrid-api-key",
    id,
    k.name ?? id,
    clean({
      name: k.name,
      apiKeyId: id,
      scopes: scopes ? scopes.join(", ") : undefined,
      scopeCount: scopes?.length,
      canCreateKeys: scopes ? scopes.includes("api_keys.create") : undefined,
      inUse: Boolean(inUseId) && id === inUseId,
    }),
  );
  if (k.api_key) r.resolvedOutputs = { apiKey: k.api_key, apiKeyId: id };
  return r;
}

/** `SG.<api_key_id>.<secret>`: the key id is the middle segment. */
export function keyIdOf(apiKey: string): string {
  const parts = apiKey.split(".");
  return parts.length === 3 && parts[0] === "SG" ? (parts[1] ?? "") : "";
}

export function mapDomain(accountId: string, d: SgDomain): ResourceInstance {
  const id = String(d.id ?? "");
  return instance(
    accountId,
    "sendgrid-domain",
    id,
    d.domain ?? id,
    clean({
      domain: d.domain,
      subdomain: d.subdomain,
      username: d.username,
      valid: d.valid,
      default: d.default,
      customSpf: d.custom_spf,
      automaticSecurity: d.automatic_security,
      legacy: d.legacy,
      ips: d.ips?.length ? d.ips.join(", ") : undefined,
      subusers: d.subusers?.length ? d.subusers.map((s) => s.username).join(", ") : undefined,
      lastValidationAt: isoFromUnix(d.last_validation_attempt_at),
      domainId: id,
    }),
  );
}

export function mapLink(accountId: string, l: SgLink): ResourceInstance {
  const id = String(l.id ?? "");
  const host = l.subdomain && l.domain ? `${l.subdomain}.${l.domain}` : (l.domain ?? id);
  return instance(
    accountId,
    "sendgrid-link-branding",
    id,
    host,
    clean({
      domain: l.domain,
      subdomain: l.subdomain,
      username: l.username,
      valid: l.valid,
      default: l.default,
      legacy: l.legacy,
      linkId: id,
    }),
  );
}

export function mapReverseDns(accountId: string, r: SgReverseDns): ResourceInstance {
  const id = String(r.id ?? "");
  return instance(
    accountId,
    "sendgrid-reverse-dns",
    id,
    r.rdns || r.ip || id,
    clean({
      ip: r.ip,
      rdns: r.rdns,
      domain: r.domain,
      subdomain: r.subdomain,
      valid: r.valid,
      rdnsId: id,
    }),
  );
}

const PURPOSE: Record<string, string> = {
  mail_cname: "Mail CNAME (Return-Path)",
  dkim1: "DKIM key 1",
  dkim2: "DKIM key 2",
  dkim: "DKIM",
  mail_server: "Mail server (MX)",
  subdomain_spf: "Return-Path SPF",
  domain_spf: "Domain SPF",
  domain_cname: "Link branding CNAME",
  owner_cname: "Ownership CNAME",
  a_record: "Reverse DNS A record",
};

function dnsRecord(
  accountId: string,
  externalId: string,
  key: string,
  e: SgDnsEntry,
  owner: Record<string, string | undefined>,
  ownerType: string,
  ownerName: string,
): ResourceInstance | null {
  if (!e.host || !e.data) return null;
  const type = (e.type ?? "").toUpperCase();
  // SendGrid's MX `data` is the bare host; the priority it asks for is 10.
  const priority = type === "MX" ? 10 : undefined;
  return instance(
    accountId,
    "sendgrid-dns-record",
    externalId,
    `${type} ${e.host}`,
    clean({
      name: e.host,
      type,
      content: e.data,
      priority,
      purpose: PURPOSE[key] ?? key,
      valid: e.valid,
      ownerType,
      ownerName,
      ...owner,
    }),
    // The owner (domain, link branding, reverse DNS, parse host) is linked by
    // `dependsOn`, not as a parent: the record type has several possible
    // owners and a resource type can only declare one parent.
    undefined,
  );
}

export function domainDnsRecords(accountId: string, d: SgDomain): ResourceInstance[] {
  const id = String(d.id ?? "");
  return Object.entries(d.dns ?? {}).flatMap(([key, e]) => {
    const r = e
      ? dnsRecord(
          accountId,
          `domain/${id}/${key}`,
          key,
          e,
          { domainId: id },
          "Domain authentication",
          d.domain ?? id,
        )
      : null;
    return r ? [r] : [];
  });
}

export function linkDnsRecords(accountId: string, l: SgLink): ResourceInstance[] {
  const id = String(l.id ?? "");
  return Object.entries(l.dns ?? {}).flatMap(([key, e]) => {
    const r = e
      ? dnsRecord(
          accountId,
          `link/${id}/${key}`,
          key,
          e,
          { linkId: id },
          "Link branding",
          l.domain ?? id,
        )
      : null;
    return r ? [r] : [];
  });
}

export function reverseDnsRecords(accountId: string, r: SgReverseDns): ResourceInstance[] {
  const id = String(r.id ?? "");
  if (!r.a_record) return [];
  const rec = dnsRecord(
    accountId,
    `rdns/${id}/a_record`,
    "a_record",
    r.a_record,
    { rdnsId: id },
    "Reverse DNS",
    r.ip ?? id,
  );
  return rec ? [rec] : [];
}

/** Inbound Parse needs `<hostname> MX 10 mx.sendgrid.net`; SendGrid does not report whether it exists. */
export function parseDnsRecords(accountId: string, p: SgParse): ResourceInstance[] {
  if (!p.hostname) return [];
  const rec = dnsRecord(
    accountId,
    `parse/${p.hostname}/mx`,
    "mail_server",
    { host: p.hostname, type: "mx", data: "mx.sendgrid.net" },
    { parseHostname: p.hostname },
    "Inbound Parse",
    p.hostname,
  );
  return rec ? [rec] : [];
}

export function mapIp(accountId: string, ip: SgIp): ResourceInstance {
  const addr = ip.ip ?? "";
  return instance(
    accountId,
    "sendgrid-ip",
    addr,
    addr,
    clean({
      ip: addr,
      pools: (ip.pools ?? []).join(", "),
      warmup: ip.warmup,
      warmupStartedAt: ip.warmup ? isoFromUnix(ip.start_date) : undefined,
      rdns: ip.rdns,
      whitelabeled: ip.whitelabeled,
      subusers: (ip.subusers ?? []).join(", "),
      assignedAt: isoFromUnix(ip.assigned_at),
    }),
  );
}

export function mapIpPool(
  accountId: string,
  name: string,
  ips: string[] | undefined,
): ResourceInstance {
  return instance(
    accountId,
    "sendgrid-ip-pool",
    name,
    name,
    clean({ name, ips: ips ? ips.join(", ") : undefined, ipCount: ips?.length }),
  );
}

export function mapSubuser(
  accountId: string,
  s: SgSubuser,
  extra: { reputation?: number; credits?: SgSubuserCredits } = {},
): ResourceInstance {
  const name = s.username ?? "";
  const c = extra.credits;
  return instance(
    accountId,
    "sendgrid-subuser",
    name,
    name,
    clean({
      username: name,
      email: s.email,
      disabled: s.disabled,
      region: s.region,
      reputation: extra.reputation,
      creditType: c?.type,
      creditTotal: c?.total ?? undefined,
      creditResetFrequency: c?.reset_frequency ?? undefined,
      creditUsed: c?.used ?? undefined,
      creditRemain: c?.remain ?? undefined,
      userId: s.id,
    }),
  );
}

export function mapEventWebhook(accountId: string, w: SgEventWebhook): ResourceInstance {
  const id = w.id ?? "";
  const events: Record<string, boolean> = {};
  for (const [event] of EVENT_KEYS) events[eventFieldKey(event)] = w[event] === true;
  const r = instance(
    accountId,
    "sendgrid-event-webhook",
    id,
    w.friendly_name || w.url || id,
    clean({
      friendlyName: w.friendly_name ?? "",
      url: w.url,
      enabled: w.enabled,
      ...events,
      signed: Boolean(w.public_key),
      oauth: Boolean(w.oauth_client_id),
      webhookId: id,
      createdAt: w.created_date,
      updatedAt: w.updated_date,
    }),
  );
  if (w.public_key) r.resolvedOutputs = { publicKey: w.public_key };
  return r;
}

/** Event flags from form values (strings or booleans), for create/PATCH bodies. */
export function eventBody(
  values: Record<string, string | boolean | number | undefined>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [event] of EVENT_KEYS) {
    const v = values[eventFieldKey(event)];
    if (v === undefined || v === "") continue;
    out[event] = v === true || v === "true";
  }
  return out;
}

export function mapParse(accountId: string, p: SgParse): ResourceInstance {
  const host = p.hostname ?? "";
  return instance(
    accountId,
    "sendgrid-inbound-parse",
    host,
    host,
    clean({ hostname: host, url: p.url, spamCheck: p.spam_check, sendRaw: p.send_raw }),
  );
}

export function activeVersion(t: SgTemplate): SgTemplateVersion | undefined {
  return (t.versions ?? []).find((v) => v.active === 1);
}

export function mapTemplate(accountId: string, t: SgTemplate): ResourceInstance {
  const id = t.id ?? "";
  const active = activeVersion(t);
  return instance(
    accountId,
    "sendgrid-template",
    id,
    t.name ?? id,
    clean({
      name: t.name,
      generation: t.generation,
      activeVersion: active?.name,
      subject: active?.subject,
      versionCount: t.versions?.length ?? 0,
      updatedAt: t.updated_at,
      templateId: id,
    }),
  );
}

export function mapAsmGroup(accountId: string, g: SgAsmGroup): ResourceInstance {
  const id = String(g.id ?? "");
  return instance(
    accountId,
    "sendgrid-unsubscribe-group",
    id,
    g.name ?? id,
    clean({
      name: g.name,
      description: g.description ?? "",
      isDefault: g.is_default,
      unsubscribes: g.unsubscribes,
      groupId: id,
    }),
  );
}

export function mapVerifiedSender(accountId: string, s: SgVerifiedSender): ResourceInstance {
  const id = String(s.id ?? "");
  return instance(
    accountId,
    "sendgrid-verified-sender",
    id,
    s.from_email ?? s.nickname ?? id,
    clean({
      nickname: s.nickname,
      fromEmail: s.from_email,
      fromName: s.from_name ?? "",
      replyTo: s.reply_to,
      replyToName: s.reply_to_name ?? "",
      address: s.address,
      address2: s.address2 ?? "",
      city: s.city,
      state: s.state ?? "",
      zip: s.zip ?? "",
      country: s.country,
      verified: s.verified,
      locked: s.locked,
      senderId: id,
    }),
  );
}

export function mapAlert(accountId: string, a: SgAlert): ResourceInstance {
  const id = String(a.id ?? "");
  const label =
    a.type === "usage_limit"
      ? `Usage alert at ${a.percentage ?? "?"}%`
      : `Stats summary (${a.frequency ?? "periodic"})`;
  return instance(
    accountId,
    "sendgrid-alert",
    id,
    label,
    clean({
      type: a.type,
      emailTo: a.email_to,
      percentage: a.percentage ?? undefined,
      frequency: a.frequency ?? undefined,
      alertId: id,
    }),
  );
}
