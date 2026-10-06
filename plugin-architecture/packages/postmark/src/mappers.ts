/**
 * Postmark response shapes (the fields this plugin reads, verified against
 * postmarkapp.com/developer/api 2026-10) and their mapping to
 * `ResourceInstance`s.
 *
 * External ids of server-scoped objects carry the server id
 * (`{serverId}/{id}`), because every server-level call needs that server's
 * token and the resource id is all `getResource` receives.
 */
import type { ResourceInstance } from "@infrawrench/plugin-base";

export const PLUGIN_ID = "postmark";

export interface PmServer {
  ID?: number;
  Name?: string;
  ApiTokens?: string[];
  Color?: string;
  SmtpApiActivated?: boolean;
  RawEmailEnabled?: boolean;
  DeliveryType?: string;
  ServerLink?: string;
  InboundAddress?: string;
  InboundHookUrl?: string;
  PostFirstOpenOnly?: boolean;
  InboundDomain?: string;
  InboundHash?: string;
  InboundSpamThreshold?: number;
  TrackOpens?: boolean;
  TrackLinks?: string;
  IncludeBounceContentInHook?: boolean;
  EnableSmtpApiErrorHooks?: boolean;
}

export interface PmMessageStream {
  ID?: string;
  ServerID?: number;
  Name?: string;
  Description?: string | null;
  MessageStreamType?: string;
  CreatedAt?: string | null;
  UpdatedAt?: string | null;
  ArchivedAt?: string | null;
  ExpectedPurgeDate?: string | null;
  SubscriptionManagementConfiguration?: { UnsubscribeHandlingType?: string } | null;
}

export interface PmDomain {
  ID?: number;
  Name?: string;
  SPFVerified?: boolean;
  SPFHost?: string;
  SPFTextValue?: string;
  DKIMVerified?: boolean;
  WeakDKIM?: boolean;
  DKIMHost?: string;
  DKIMTextValue?: string;
  DKIMPendingHost?: string;
  DKIMPendingTextValue?: string;
  DKIMRevokedHost?: string;
  DKIMRevokedTextValue?: string;
  SafeToRemoveRevokedKeyFromDNS?: boolean;
  DKIMUpdateStatus?: string;
  ReturnPathDomain?: string;
  ReturnPathDomainVerified?: boolean;
  ReturnPathDomainCNAMEValue?: string;
}

export interface PmSenderSignature {
  ID?: number;
  Domain?: string;
  EmailAddress?: string;
  ReplyToEmailAddress?: string;
  Name?: string;
  Confirmed?: boolean;
  ReturnPathDomain?: string;
}

export interface PmTrigger {
  Enabled?: boolean;
  PostFirstOpenOnly?: boolean;
  IncludeContent?: boolean;
}

export interface PmWebhook {
  ID?: number;
  Url?: string;
  MessageStream?: string;
  HttpAuth?: { Username?: string; Password?: string } | null;
  HttpHeaders?: Array<{ Name?: string; Value?: string }> | null;
  Triggers?: {
    Open?: PmTrigger;
    Click?: PmTrigger;
    Delivery?: PmTrigger;
    Bounce?: PmTrigger;
    SpamComplaint?: PmTrigger;
    SubscriptionChange?: PmTrigger;
  } | null;
}

export interface PmTemplate {
  TemplateId?: number;
  Name?: string;
  Alias?: string | null;
  Subject?: string | null;
  HtmlBody?: string | null;
  TextBody?: string | null;
  Active?: boolean;
  TemplateType?: string;
  LayoutTemplate?: string | null;
  AssociatedServerId?: number;
}

export interface PmInboundRule {
  ID?: number;
  Rule?: string;
}

/** The server a server-scoped object belongs to. */
export interface ServerRef {
  id: string;
  name: string;
}

const now = () => new Date().toISOString();

type Fields = ResourceInstance["fields"];

/** Drop undefined/null so stored fields never carry the string "undefined". */
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
  const at = now();
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

/** Split a `{serverId}/{rest}` external id. */
export function splitScoped(externalId: string): { serverId: string; id: string } {
  const slash = externalId.indexOf("/");
  if (slash < 0) return { serverId: "", id: externalId };
  return { serverId: externalId.slice(0, slash), id: externalId.slice(slash + 1) };
}

export function mapServer(accountId: string, s: PmServer): ResourceInstance {
  const id = String(s.ID ?? "");
  return instance(
    accountId,
    "postmark-server",
    id,
    s.Name ?? id,
    clean({
      name: s.Name,
      serverId: id,
      color: s.Color,
      deliveryType: s.DeliveryType,
      smtpApiActivated: s.SmtpApiActivated,
      rawEmailEnabled: s.RawEmailEnabled,
      trackOpens: s.TrackOpens,
      trackLinks: s.TrackLinks,
      inboundHookUrl: s.InboundHookUrl ?? "",
      inboundDomain: s.InboundDomain ?? "",
      inboundSpamThreshold: s.InboundSpamThreshold,
      inboundAddress: s.InboundAddress,
      postFirstOpenOnly: s.PostFirstOpenOnly,
      includeBounceContentInHook: s.IncludeBounceContentInHook,
      enableSmtpApiErrorHooks: s.EnableSmtpApiErrorHooks,
      serverLink: s.ServerLink,
    }),
  );
}

export function mapMessageStream(
  accountId: string,
  server: ServerRef,
  s: PmMessageStream,
): ResourceInstance {
  const streamId = s.ID ?? "";
  return instance(
    accountId,
    "postmark-message-stream",
    `${server.id}/${streamId}`,
    s.Name ?? streamId,
    clean({
      name: s.Name,
      streamId,
      serverId: server.id,
      serverName: server.name,
      messageStreamType: s.MessageStreamType,
      description: s.Description ?? "",
      unsubscribeHandlingType: s.SubscriptionManagementConfiguration?.UnsubscribeHandlingType,
      archived: Boolean(s.ArchivedAt),
      archivedAt: s.ArchivedAt,
      expectedPurgeDate: s.ExpectedPurgeDate,
      createdAt: s.CreatedAt,
      updatedAt: s.UpdatedAt,
    }),
    resourceId(accountId, "postmark-server", server.id),
  );
}

export function mapDomain(accountId: string, d: PmDomain): ResourceInstance {
  const id = String(d.ID ?? "");
  return instance(
    accountId,
    "postmark-domain",
    id,
    d.Name ?? id,
    clean({
      name: d.Name,
      domainId: id,
      dkimVerified: d.DKIMVerified,
      weakDkim: d.WeakDKIM,
      dkimHost: d.DKIMHost,
      dkimUpdateStatus: d.DKIMUpdateStatus,
      dkimPendingHost: d.DKIMPendingHost,
      safeToRemoveRevokedKey: d.SafeToRemoveRevokedKeyFromDNS,
      returnPathDomain: d.ReturnPathDomain ?? "",
      returnPathDomainVerified: d.ReturnPathDomainVerified,
      spfVerified: d.SPFVerified,
    }),
  );
}

/** One record a domain needs, before it becomes a resource. */
export interface RequiredRecord {
  key: string;
  purpose: string;
  type: "TXT" | "CNAME";
  name: string;
  content: string;
  verified: boolean | undefined;
}

/**
 * The records Postmark checks for a domain: the active DKIM key (TXT), the
 * pending key during a rotation (TXT, unverified until Postmark sees it), and
 * the Return-Path CNAME when one is configured. SPF is no longer required by
 * Postmark (the Return-Path carries it), so it is not listed.
 */
export function requiredRecords(d: PmDomain): RequiredRecord[] {
  const out: RequiredRecord[] = [];
  if (d.DKIMHost && d.DKIMTextValue) {
    out.push({
      key: "dkim",
      purpose: "DKIM",
      type: "TXT",
      name: d.DKIMHost,
      content: d.DKIMTextValue,
      verified: d.DKIMVerified,
    });
  }
  if (d.DKIMPendingHost && d.DKIMPendingTextValue) {
    out.push({
      key: "dkim-pending",
      purpose: "DKIM (new key, pending)",
      type: "TXT",
      name: d.DKIMPendingHost,
      content: d.DKIMPendingTextValue,
      verified: false,
    });
  }
  if (d.ReturnPathDomain && d.ReturnPathDomainCNAMEValue) {
    out.push({
      key: "return-path",
      purpose: "Return-Path",
      type: "CNAME",
      name: d.ReturnPathDomain,
      content: d.ReturnPathDomainCNAMEValue,
      verified: d.ReturnPathDomainVerified,
    });
  }
  return out;
}

export function mapDnsRecords(accountId: string, d: PmDomain): ResourceInstance[] {
  const domainId = String(d.ID ?? "");
  const parent = resourceId(accountId, "postmark-domain", domainId);
  return requiredRecords(d).map((r) =>
    instance(
      accountId,
      "postmark-dns-record",
      `${domainId}/${r.key}`,
      `${r.purpose}: ${r.name}`,
      clean({
        name: r.name,
        type: r.type,
        content: r.content,
        purpose: r.purpose,
        verified: r.verified,
        domainName: d.Name,
        domainId,
      }),
      parent,
    ),
  );
}

export function mapSenderSignature(accountId: string, s: PmSenderSignature): ResourceInstance {
  const id = String(s.ID ?? "");
  return instance(
    accountId,
    "postmark-sender-signature",
    id,
    s.EmailAddress ?? id,
    clean({
      emailAddress: s.EmailAddress,
      name: s.Name,
      replyToEmailAddress: s.ReplyToEmailAddress ?? "",
      returnPathDomain: s.ReturnPathDomain ?? "",
      domain: s.Domain,
      confirmed: s.Confirmed,
      signatureId: id,
    }),
  );
}

export function mapWebhook(accountId: string, server: ServerRef, w: PmWebhook): ResourceInstance {
  const id = String(w.ID ?? "");
  const t = w.Triggers ?? {};
  return instance(
    accountId,
    "postmark-webhook",
    `${server.id}/${id}`,
    `${w.MessageStream ?? "outbound"}: ${w.Url ?? id}`,
    clean({
      url: w.Url,
      serverId: server.id,
      serverName: server.name,
      messageStream: w.MessageStream,
      delivery: t.Delivery?.Enabled ?? false,
      bounce: t.Bounce?.Enabled ?? false,
      bounceIncludeContent: t.Bounce?.IncludeContent ?? false,
      spamComplaint: t.SpamComplaint?.Enabled ?? false,
      spamIncludeContent: t.SpamComplaint?.IncludeContent ?? false,
      open: t.Open?.Enabled ?? false,
      postFirstOpenOnly: t.Open?.PostFirstOpenOnly ?? false,
      click: t.Click?.Enabled ?? false,
      subscriptionChange: t.SubscriptionChange?.Enabled ?? false,
      httpAuthUsername: w.HttpAuth?.Username ?? "",
      headerCount: (w.HttpHeaders ?? []).length,
      webhookId: id,
    }),
    resourceId(accountId, "postmark-server", server.id),
  );
}

export function mapTemplate(accountId: string, server: ServerRef, t: PmTemplate): ResourceInstance {
  const id = String(t.TemplateId ?? "");
  return instance(
    accountId,
    "postmark-template",
    `${server.id}/${id}`,
    t.Name ?? t.Alias ?? id,
    clean({
      name: t.Name,
      alias: t.Alias ?? "",
      templateType: t.TemplateType,
      layoutTemplate: t.LayoutTemplate ?? "",
      subject: t.Subject ?? undefined,
      htmlBody: t.HtmlBody ?? undefined,
      textBody: t.TextBody ?? undefined,
      active: t.Active,
      serverId: server.id,
      serverName: server.name,
      templateId: id,
    }),
    resourceId(accountId, "postmark-server", server.id),
  );
}

export function mapInboundRule(
  accountId: string,
  server: ServerRef,
  r: PmInboundRule,
): ResourceInstance {
  const id = String(r.ID ?? "");
  return instance(
    accountId,
    "postmark-inbound-rule",
    `${server.id}/${id}`,
    r.Rule ?? id,
    clean({ rule: r.Rule, serverId: server.id, serverName: server.name }),
    resourceId(accountId, "postmark-server", server.id),
  );
}

/** Trigger form values → Postmark's `Triggers` object. */
export function triggersFrom(values: Record<string, string | boolean | undefined>) {
  const on = (k: string) => values[k] === true || values[k] === "true";
  return {
    Open: { Enabled: on("open"), PostFirstOpenOnly: on("postFirstOpenOnly") },
    Click: { Enabled: on("click") },
    Delivery: { Enabled: on("delivery") },
    Bounce: { Enabled: on("bounce"), IncludeContent: on("bounceIncludeContent") },
    SpamComplaint: { Enabled: on("spamComplaint"), IncludeContent: on("spamIncludeContent") },
    SubscriptionChange: { Enabled: on("subscriptionChange") },
  };
}
