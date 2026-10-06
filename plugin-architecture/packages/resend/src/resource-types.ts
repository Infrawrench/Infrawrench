import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Resend resource types. Field names follow the API reference
 * (https://resend.com/docs/api-reference, OpenAPI 1.5.1).
 */

export const ACCOUNT = "resend-account";
export const DOMAIN = "resend-domain";
export const DNS_RECORD = "resend-dns-record";
export const API_KEY = "resend-api-key";
export const WEBHOOK = "resend-webhook";
export const EMAIL = "resend-email";
export const BROADCAST = "resend-broadcast";
export const TEMPLATE = "resend-template";
export const SEGMENT = "resend-segment";
export const TOPIC = "resend-topic";
export const CONTACT = "resend-contact";
export const CONTACT_PROPERTY = "resend-contact-property";
export const SUPPRESSION = "resend-suppression";
export const AUTOMATION = "resend-automation";
export const OAUTH_GRANT = "resend-oauth-grant";

const ro = { required: false, editable: false } as const;
const opt = { required: false } as const;

export const AccountResourceType = rt({
  name: "Account",
  id: ACCOUNT,
  description:
    "The Resend team the API key belongs to: emails sent today and this billing period against the plan's limits, contacts, domains, segments, broadcasts, automation runs and AI credits, deliverability metrics for every domain, and the API request log.",
  fields: [
    f("emailsToday", "Emails Today", { ...ro, kind: "number" }),
    f("dailyLimit", "Daily Limit", { ...ro, kind: "number" }),
    f("emailsThisPeriod", "Emails This Period", { ...ro, kind: "number" }),
    f("monthlyLimit", "Monthly Limit", { ...ro, kind: "number" }),
    f("sentThisPeriod", "Sent This Period", { ...ro, kind: "number" }),
    f("receivedThisPeriod", "Received This Period", { ...ro, kind: "number" }),
    f("periodResetsAt", "Period Resets", ro),
    f("contacts", "Contacts", { ...ro, kind: "number" }),
    f("contactsLimit", "Contacts Limit", { ...ro, kind: "number" }),
    f("domains", "Domains", { ...ro, kind: "number" }),
    f("domainsLimit", "Domains Limit", { ...ro, kind: "number" }),
    f("segments", "Segments", { ...ro, kind: "number" }),
    f("segmentsLimit", "Segments Limit", { ...ro, kind: "number" }),
    f("broadcastsSent", "Broadcasts Sent", { ...ro, kind: "number" }),
    f("automationRuns", "Automation Runs", { ...ro, kind: "number" }),
    f("automationRunsLimit", "Automation Runs Limit", { ...ro, kind: "number" }),
    f("aiCredits", "AI Credits Used", { ...ro, kind: "number" }),
    f("aiCreditsLimit", "AI Credits Limit", { ...ro, kind: "number" }),
    f("rateLimit", "API Rate Limit", ro),
  ],
  outputs: [o("apiBaseUrl", "API Base URL")],
  accountRoot: true,
  supportsDelete: false,
  supportsMetrics: true,
  iconKey: "account",
});

export const DomainResourceType = rt({
  name: "Domain",
  id: DOMAIN,
  description:
    "A domain Resend sends or receives mail for, with its verification status and the DNS records it needs. Add one with a region, edit tracking, TLS and sending or receiving, re-run verification, or delete it. Charts its deliverability.",
  fields: [
    f("name", "Domain", { editable: false }),
    f("status", "Status", ro),
    f("region", "Region", ro),
    f("sending", "Sending", {
      kind: "enum",
      enumValues: ["enabled", "disabled"],
      required: false,
    }),
    f("receiving", "Receiving", {
      kind: "enum",
      enumValues: ["enabled", "disabled"],
      required: false,
    }),
    f("openTracking", "Open Tracking", { kind: "boolean", required: false }),
    f("clickTracking", "Click Tracking", { kind: "boolean", required: false }),
    f("trackingSubdomain", "Tracking Subdomain", {
      required: false,
      description: "The subdomain tracked links and pixels are served from, for example `links`.",
    }),
    f("tls", "TLS", {
      kind: "enum",
      enumValues: ["opportunistic", "enforced"],
      required: false,
      description: "Enforced refuses to deliver to servers without TLS.",
    }),
    f("recordsVerified", "Records Verified", { ...ro, kind: "number" }),
    f("recordsTotal", "Records", { ...ro, kind: "number" }),
    f("domainId", "Domain ID", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("domainId", "Domain ID"), o("name", "Domain")],
  postureChecks: [
    {
      id: "resend-domain-unverified",
      title: "Resend domain not fully verified",
      severity: "medium",
      category: "other",
      conditions: [{ fieldKey: "status", when: "notEquals", value: "verified" }],
      reason:
        "Resend cannot send (or receive) for this domain until its DKIM, SPF and MX records verify, so mail from it fails or goes out unauthenticated.",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "dns",
});

export const DnsRecordResourceType = rt({
  name: "Required DNS Record",
  id: DNS_RECORD,
  parentTypeId: DOMAIN,
  description:
    "A DNS record Resend needs at your DNS provider for a domain: the DKIM key, the SPF TXT and MX records on the bounce subdomain, the inbound MX for receiving, and the tracking CNAME and CAA, with Resend's verification status for each.",
  fields: [
    f("name", "Host"),
    f("type", "Type"),
    f("content", "Value"),
    f("priority", "Priority", { kind: "number", required: false }),
    f("ttl", "TTL", { required: false }),
    f("purpose", "Purpose", opt),
    f("status", "Status", opt),
    f("domainName", "Domain", opt),
    f("domainId", "Domain ID", opt),
  ],
  outputs: [o("name", "Host"), o("content", "Value")],
  dependsOn: [{ fieldKey: "domainId", targetTypeId: DOMAIN, label: "for domain" }],
  dnsRole: { role: "record", priorityKey: "priority" },
  supportsDelete: false,
  pinnable: false,
  iconKey: "dns-record",
});

export const ApiKeyResourceType = rt({
  name: "API Key",
  id: API_KEY,
  description:
    "An API key on the team, with when it was last used. Create a full-access or sending-only key (optionally limited to one domain); the token is kept as a sensitive output because Resend shows it once. Rename or delete keys. Resend does not report a key's permission after creation.",
  fields: [
    f("name", "Name"),
    f("lastUsedAt", "Last Used", ro),
    f("apiKeyId", "API Key ID", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [
    o("apiKeyId", "API Key ID"),
    o("token", "Token", {
      sensitive: true,
      description: "The re_… token. Only available for keys created from Infrawrench.",
    }),
  ],
  expiryFields: [
    { fieldKey: "createdAt", from: "created", kind: "api-token", label: "API key age" },
  ],
  secretExportTemplates: [
    {
      id: "resend-api-key",
      displayName: "Resend API key",
      entries: [{ envKey: "RESEND_API_KEY", outputKey: "token" }],
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "key",
});

export const WebhookResourceType = rt({
  name: "Webhook",
  id: WEBHOOK,
  description:
    "An endpoint Resend posts email, contact, domain and suppression events to. Create it with an event picker, change its URL and events, enable or disable it, rotate its signing secret, and see recent deliveries with their attempts; replay a failed one from the list.",
  fields: [
    f("endpoint", "Endpoint URL"),
    f("events", "Events", {
      description: "Comma-separated event types, for example `email.bounced, email.complained`.",
    }),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["enabled", "disabled"],
      required: false,
    }),
    f("webhookId", "Webhook ID", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [
    o("webhookId", "Webhook ID"),
    o("endpoint", "Endpoint URL"),
    o("signingSecret", "Signing Secret", {
      sensitive: true,
      description: "The whsec_… secret for verifying webhook signatures.",
    }),
  ],
  secretExportTemplates: [
    {
      id: "resend-webhook-secret",
      displayName: "Webhook signing secret",
      entries: [{ envKey: "RESEND_WEBHOOK_SECRET", outputKey: "signingSecret" }],
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "webhook",
});

export const EmailResourceType = rt({
  name: "Email",
  id: EMAIL,
  description:
    "A recently sent email (the 100 newest) with its recipients, subject and latest delivery event. A scheduled email can be cancelled.",
  fields: [
    f("subject", "Subject", ro),
    f("from", "From", ro),
    f("to", "To", ro),
    f("cc", "Cc", ro),
    f("lastEvent", "Last Event", ro),
    f("scheduledAt", "Scheduled For", ro),
    f("messageId", "Message-ID", ro),
    f("emailId", "Email ID", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("emailId", "Email ID")],
  supportsDelete: false,
  pinnable: false,
  iconKey: "email",
});

export const BroadcastResourceType = rt({
  name: "Broadcast",
  id: BROADCAST,
  description:
    "A marketing email to a segment. Create a draft with segment and topic pickers, edit it while it is a draft, send it now or on a schedule, cancel a scheduled send, duplicate or delete it. Sent broadcasts chart their deliverability.",
  fields: [
    f("name", "Name", opt),
    f("subject", "Subject", opt),
    f("from", "From", opt),
    f("replyTo", "Reply-To", opt),
    f("previewText", "Preview Text", opt),
    f("segmentId", "Segment", opt),
    f("topicId", "Topic", opt),
    f("status", "Status", ro),
    f("scheduledAt", "Scheduled For", ro),
    f("sentAt", "Sent", ro),
    f("broadcastId", "Broadcast ID", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("broadcastId", "Broadcast ID")],
  dependsOn: [
    { fieldKey: "segmentId", targetTypeId: SEGMENT, label: "sends to" },
    { fieldKey: "topicId", targetTypeId: TOPIC, label: "scoped to" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "email",
});

export const TemplateResourceType = rt({
  name: "Template",
  id: TEMPLATE,
  description:
    "A reusable email template with variables. Create and edit its name, alias, sender, subject and bodies, publish the draft, duplicate or delete it.",
  fields: [
    f("name", "Name"),
    f("alias", "Alias", {
      ...opt,
      description: "A stable name to send the template by, instead of its id.",
    }),
    f("from", "From", opt),
    f("subject", "Subject", opt),
    f("status", "Status", ro),
    f("hasUnpublishedVersions", "Unpublished Changes", { ...ro, kind: "boolean" }),
    f("publishedAt", "Published", ro),
    f("templateId", "Template ID", ro),
    f("createdAt", "Created", ro),
    f("updatedAt", "Updated", ro),
  ],
  outputs: [o("templateId", "Template ID"), o("alias", "Alias")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "file",
});

export const SegmentResourceType = rt({
  name: "Segment",
  id: SEGMENT,
  description:
    "A group of contacts broadcasts are sent to (Resend's replacement for audiences). Create, rename or delete it; its first contacts are listed on the detail page.",
  fields: [f("name", "Name"), f("segmentId", "Segment ID", ro), f("createdAt", "Created", ro)],
  outputs: [o("segmentId", "Segment ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "group",
});

export const TopicResourceType = rt({
  name: "Topic",
  id: TOPIC,
  description:
    "A subscription topic contacts can opt in or out of on the unsubscribe page. Create it with its default, edit the name, description and visibility, or delete it.",
  fields: [
    f("name", "Name"),
    f("description", "Description", opt),
    f("defaultSubscription", "Default", ro),
    f("visibility", "Visibility", {
      kind: "enum",
      enumValues: ["public", "private"],
      required: false,
    }),
    f("topicId", "Topic ID", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("topicId", "Topic ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "tag",
});

export const ContactResourceType = rt({
  name: "Contact",
  id: CONTACT,
  description:
    "A marketing contact (the 1,000 newest are listed). Add one to segments, edit the name and global unsubscribe, or delete it.",
  fields: [
    f("email", "Email"),
    f("firstName", "First Name", opt),
    f("lastName", "Last Name", opt),
    f("unsubscribed", "Unsubscribed", { kind: "boolean", required: false }),
    f("contactId", "Contact ID", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("contactId", "Contact ID"), o("email", "Email")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "user",
});

export const ContactPropertyResource = rt({
  name: "Contact Property",
  plural: "Contact Properties",
  id: CONTACT_PROPERTY,
  description:
    "A custom field on contacts, usable as a variable in broadcasts. Create it with a type, change its fallback value, or delete it.",
  fields: [
    f("key", "Key", { editable: false }),
    f("type", "Type", ro),
    f("fallbackValue", "Fallback Value", opt),
    f("propertyId", "Property ID", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("key", "Key")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "sliders",
});

export const SuppressionResourceType = rt({
  name: "Suppression",
  id: SUPPRESSION,
  description:
    "An address Resend will not send to, because it hard-bounced, complained or was added by hand (the 1,000 newest). Add one, or delete it to allow sending again.",
  fields: [
    f("email", "Email"),
    f("origin", "Origin", ro),
    f("sourceId", "Source", ro),
    f("suppressionId", "Suppression ID", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("email", "Email")],
  supportsCreate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "shield",
});

export const AutomationResourceType = rt({
  name: "Automation",
  id: AUTOMATION,
  description:
    "An event-driven email workflow. See its steps and recent runs, enable or disable it, stop its runs in flight, rename, duplicate or delete it.",
  fields: [
    f("name", "Name"),
    f("status", "Status", { kind: "enum", enumValues: ["enabled", "disabled"], required: false }),
    f("automationId", "Automation ID", ro),
    f("createdAt", "Created", ro),
    f("updatedAt", "Updated", ro),
  ],
  outputs: [o("automationId", "Automation ID")],
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "workflow",
});

export const OAuthGrantResourceType = rt({
  name: "OAuth Grant",
  id: OAUTH_GRANT,
  description:
    "A third-party app the team has authorised over OAuth, with its scopes. Revoke it to cut off its access.",
  fields: [
    f("clientName", "App", ro),
    f("clientId", "Client ID", ro),
    f("scopes", "Scopes", ro),
    f("revokedAt", "Revoked", ro),
    f("revokedReason", "Revoked Reason", ro),
    f("grantId", "Grant ID", ro),
    f("createdAt", "Granted", ro),
  ],
  outputs: [o("grantId", "Grant ID")],
  supportsDelete: true,
  pinnable: false,
  iconKey: "role",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  AccountResourceType,
  DomainResourceType,
  DnsRecordResourceType,
  ApiKeyResourceType,
  WebhookResourceType,
  EmailResourceType,
  BroadcastResourceType,
  TemplateResourceType,
  SegmentResourceType,
  TopicResourceType,
  ContactResourceType,
  ContactPropertyResource,
  SuppressionResourceType,
  AutomationResourceType,
  OAuthGrantResourceType,
];
