import type { ApiListItem, ApiResponse, ResourceInstance } from "@infrawrench/plugin-base";
import type { operations } from "./api-types.gen.js";
import {
  ACCOUNT,
  API_KEY,
  AUTOMATION,
  BROADCAST,
  CONTACT,
  CONTACT_PROPERTY,
  DNS_RECORD,
  DOMAIN,
  EMAIL,
  OAUTH_GRANT,
  SEGMENT,
  SUPPRESSION,
  TEMPLATE,
  TOPIC,
  WEBHOOK,
} from "./resource-types.js";

// ------------------------------------------------------------------ wire types

/**
 * An entity is named by its widest response: every list row and create answer has
 * fewer optional fields and is assignable to it.
 */
type Answer<Op extends keyof operations> = ApiResponse<operations[Op]>;

/** `tls` is on a domain's requests and missing from every answer in the document, so it is read only in case Resend sends it. */
export type ResendDomain = Answer<"domains/get"> & { tls?: string };
export type ResendApiKey = ApiListItem<operations["api-keys/list"], "data">;
export type ResendWebhook = Answer<"webhooks/get">;
/** `scheduled_at` is on no email response in the document. */
export type ResendEmail = Answer<"emails/get"> & { scheduled_at?: string | null };
export type ResendBroadcast = Answer<"broadcasts/get">;
export type ResendTemplate = Answer<"templates/get">;
export type ResendSegment = Answer<"segments/get">;
export type ResendTopic = Answer<"topics/get">;
export type ResendContact = Answer<"contacts/get">;
export type ResendContactProperty = Answer<"contact-properties/get">;
export type ResendSuppression = Answer<"suppressions/get">;
export type ResendAutomation = Answer<"automations/get">;
export type ResendOAuthGrant = ApiListItem<operations["oauth/list-grants"], "data">;
export type ResendUsage = Answer<"usage/get">;

// ---------------------------------------------------------------------- helpers

function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, string | number | boolean>,
  createdAt: string | undefined,
  extra: Partial<ResourceInstance> = {},
): ResourceInstance {
  const now = new Date().toISOString();
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: "resend",
    resourceTypeId: typeId,
    accountId,
    displayName,
    externalId,
    fields,
    resolvedOutputs: {},
    secretStates: [],
    createdAt: createdAt ? toIso(createdAt) : now,
    updatedAt: now,
    ...extra,
  };
}

/** Resend timestamps look like `2023-04-26 20:21:26.347412+00`; normalise to ISO. */
export function toIso(value: string | null | undefined): string {
  if (!value) return "";
  const ms = Date.parse(value);
  if (Number.isFinite(ms)) return new Date(ms).toISOString();
  const fixed = value.replace(" ", "T").replace(/\+00$/, "Z");
  const again = Date.parse(fixed);
  return Number.isFinite(again) ? new Date(again).toISOString() : value;
}

const list = (value: string[] | string | null | undefined): string =>
  Array.isArray(value) ? value.join(", ") : (value ?? "");

const num = (value: number | null | undefined): number => (typeof value === "number" ? value : 0);

// ---------------------------------------------------------------------- mappers

export function mapAccount(accountId: string, usage: ResendUsage | null): ResourceInstance {
  const daily = usage?.emails?.daily;
  const monthly = usage?.emails?.monthly;
  const rate = usage?.rate_limit;
  return instance(
    accountId,
    ACCOUNT,
    "account",
    "Resend",
    {
      emailsToday: num(daily?.used),
      dailyLimit: num(daily?.limit),
      emailsThisPeriod: num(monthly?.used),
      monthlyLimit: num(monthly?.limit),
      sentThisPeriod: num(monthly?.sent),
      receivedThisPeriod: num(monthly?.received),
      periodResetsAt: toIso(monthly?.resets_at),
      contacts: num(usage?.contacts?.used),
      contactsLimit: num(usage?.contacts?.limit),
      domains: num(usage?.domains?.used),
      domainsLimit: num(usage?.domains?.limit),
      segments: num(usage?.segments?.used),
      segmentsLimit: num(usage?.segments?.limit),
      broadcastsSent: num(usage?.broadcasts?.used),
      automationRuns: num(usage?.automation_runs?.used),
      automationRunsLimit: num(usage?.automation_runs?.limit),
      aiCredits: num(usage?.ai_credits?.used),
      aiCreditsLimit: num(usage?.ai_credits?.limit),
      rateLimit: rate?.limit ? `${rate.limit} per ${rate.duration ?? "second"}` : "",
    },
    undefined,
  );
}

export function mapDomain(accountId: string, d: ResendDomain): ResourceInstance {
  const id = d.id ?? "";
  const records = d.records ?? [];
  return instance(
    accountId,
    DOMAIN,
    id,
    d.name || id,
    {
      name: d.name ?? "",
      status: d.status ?? "",
      region: d.region ?? "",
      sending: d.capabilities?.sending ?? "",
      receiving: d.capabilities?.receiving ?? "",
      openTracking: d.open_tracking ?? false,
      clickTracking: d.click_tracking ?? false,
      trackingSubdomain: d.tracking_subdomain ?? "",
      tls: d.tls ?? "",
      recordsVerified: records.filter((r) => r.status === "verified").length,
      recordsTotal: records.length,
      domainId: id,
      createdAt: toIso(d.created_at),
    },
    d.created_at,
  );
}

/**
 * Resend returns record names relative to the domain (`resend._domainkey`,
 * `send`, `@` or empty for the apex). Stored fully qualified so the Domains
 * view can place them without a zone.
 */
export function qualify(name: string | undefined, domain: string): string {
  const n = (name ?? "").trim().replace(/\.$/, "");
  if (!n || n === "@") return domain;
  if (n === domain || n.endsWith(`.${domain}`)) return n;
  return `${n}.${domain}`;
}

export function mapDnsRecords(accountId: string, d: ResendDomain): ResourceInstance[] {
  const domainId = d.id ?? "";
  const domain = d.name ?? "";
  const parent = `${accountId}:${DOMAIN}:${domainId}`;
  return (d.records ?? []).map((r) => {
    const host = qualify(r.name, domain);
    const type = r.type ?? "";
    const ttl = Number(r.ttl);
    return instance(
      accountId,
      DNS_RECORD,
      `${domainId}/${r.record ?? ""}/${type}/${host}`,
      `${type} ${host}`,
      {
        name: host,
        type,
        content: r.value ?? "",
        ...(typeof r.priority === "number" ? { priority: r.priority } : {}),
        ...(Number.isFinite(ttl) && ttl > 0 ? { ttl } : { ttl: r.ttl ?? "" }),
        purpose: r.record ?? "",
        status: r.status ?? "",
        domainName: domain,
        domainId,
      },
      d.created_at,
      { parentResourceId: parent },
    );
  });
}

export function mapApiKey(accountId: string, k: ResendApiKey): ResourceInstance {
  const id = k.id ?? "";
  return instance(
    accountId,
    API_KEY,
    id,
    k.name || id,
    {
      name: k.name ?? "",
      lastUsedAt: toIso(k.last_used_at),
      apiKeyId: id,
      createdAt: toIso(k.created_at),
    },
    k.created_at,
  );
}

export function mapWebhook(accountId: string, w: ResendWebhook): ResourceInstance {
  const id = w.id ?? "";
  return instance(
    accountId,
    WEBHOOK,
    id,
    w.endpoint || id,
    {
      endpoint: w.endpoint ?? "",
      events: list(w.events),
      status: w.status ?? "",
      webhookId: id,
      createdAt: toIso(w.created_at),
    },
    w.created_at,
  );
}

export function mapEmail(accountId: string, e: ResendEmail): ResourceInstance {
  const id = e.id ?? "";
  return instance(
    accountId,
    EMAIL,
    id,
    e.subject || id,
    {
      subject: e.subject ?? "",
      from: e.from ?? "",
      to: list(e.to),
      cc: list(e.cc),
      lastEvent: e.last_event ?? "",
      scheduledAt: toIso(e.scheduled_at),
      messageId: e.message_id ?? "",
      emailId: id,
      createdAt: toIso(e.created_at),
    },
    e.created_at,
  );
}

export function mapBroadcast(accountId: string, b: ResendBroadcast): ResourceInstance {
  const id = b.id ?? "";
  return instance(
    accountId,
    BROADCAST,
    id,
    b.name || b.subject || id,
    {
      name: b.name ?? "",
      subject: b.subject ?? "",
      from: b.from ?? "",
      replyTo: list(b.reply_to),
      previewText: b.preview_text ?? "",
      segmentId: b.segment_id ?? b.audience_id ?? "",
      topicId: b.topic_id ?? "",
      status: b.status ?? "",
      scheduledAt: toIso(b.scheduled_at),
      sentAt: toIso(b.sent_at),
      broadcastId: id,
      createdAt: toIso(b.created_at),
    },
    b.created_at,
  );
}

export function mapTemplate(accountId: string, t: ResendTemplate): ResourceInstance {
  const id = t.id ?? "";
  return instance(
    accountId,
    TEMPLATE,
    id,
    t.name || t.alias || id,
    {
      name: t.name ?? "",
      alias: t.alias ?? "",
      from: t.from ?? "",
      subject: t.subject ?? "",
      status: t.status ?? "",
      hasUnpublishedVersions: t.has_unpublished_versions ?? false,
      publishedAt: toIso(t.published_at),
      templateId: id,
      createdAt: toIso(t.created_at),
      updatedAt: toIso(t.updated_at),
    },
    t.created_at,
  );
}

export function mapSegment(accountId: string, s: ResendSegment): ResourceInstance {
  const id = s.id ?? "";
  return instance(
    accountId,
    SEGMENT,
    id,
    s.name || id,
    { name: s.name ?? "", segmentId: id, createdAt: toIso(s.created_at) },
    s.created_at,
  );
}

export function mapTopic(accountId: string, t: ResendTopic): ResourceInstance {
  const id = t.id ?? "";
  return instance(
    accountId,
    TOPIC,
    id,
    t.name || id,
    {
      name: t.name ?? "",
      description: t.description ?? "",
      defaultSubscription: t.default_subscription ?? "",
      visibility: t.visibility ?? "",
      topicId: id,
      createdAt: toIso(t.created_at),
    },
    t.created_at,
  );
}

export function mapContact(accountId: string, c: ResendContact): ResourceInstance {
  const id = c.id ?? "";
  const name = [c.first_name, c.last_name].filter(Boolean).join(" ");
  return instance(
    accountId,
    CONTACT,
    id,
    name ? `${name} <${c.email ?? ""}>` : c.email || id,
    {
      email: c.email ?? "",
      firstName: c.first_name ?? "",
      lastName: c.last_name ?? "",
      unsubscribed: c.unsubscribed ?? false,
      contactId: id,
      createdAt: toIso(c.created_at),
    },
    c.created_at,
  );
}

export function mapContactProperty(accountId: string, p: ResendContactProperty): ResourceInstance {
  const id = p.id ?? "";
  return instance(
    accountId,
    CONTACT_PROPERTY,
    id,
    p.key || id,
    {
      key: p.key ?? "",
      type: p.type ?? "",
      fallbackValue:
        p.fallback_value === null || p.fallback_value === undefined ? "" : String(p.fallback_value),
      propertyId: id,
      createdAt: toIso(p.created_at),
    },
    p.created_at,
  );
}

export function mapSuppression(accountId: string, s: ResendSuppression): ResourceInstance {
  const id = s.id ?? "";
  return instance(
    accountId,
    SUPPRESSION,
    id,
    s.email || id,
    {
      email: s.email ?? "",
      origin: s.origin ?? "",
      sourceId: s.source_id ?? "",
      suppressionId: id,
      createdAt: toIso(s.created_at),
    },
    s.created_at,
  );
}

export function mapAutomation(accountId: string, a: ResendAutomation): ResourceInstance {
  const id = a.id ?? "";
  return instance(
    accountId,
    AUTOMATION,
    id,
    a.name || id,
    {
      name: a.name ?? "",
      status: a.status ?? "",
      automationId: id,
      createdAt: toIso(a.created_at),
      updatedAt: toIso(a.updated_at),
    },
    a.created_at,
  );
}

export function mapOAuthGrant(accountId: string, g: ResendOAuthGrant): ResourceInstance {
  const id = g.id ?? "";
  return instance(
    accountId,
    OAUTH_GRANT,
    id,
    g.client?.name || g.client_id || id,
    {
      clientName: g.client?.name ?? "",
      clientId: g.client_id ?? "",
      scopes: (g.scopes ?? []).join(", "),
      revokedAt: toIso(g.revoked_at),
      revokedReason: g.revoked_reason ?? "",
      grantId: id,
      createdAt: toIso(g.created_at),
    },
    g.created_at,
  );
}
