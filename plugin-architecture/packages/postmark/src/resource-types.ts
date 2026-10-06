import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Postmark resource types. Field names follow the Postmark API reference
 * (postmarkapp.com/developer/api, 2026-10); each type names its endpoint.
 */

export const SERVER_COLORS = [
  "Purple",
  "Blue",
  "Turquoise",
  "Green",
  "Red",
  "Yellow",
  "Grey",
  "Orange",
];
export const TRACK_LINKS = ["None", "HtmlAndText", "HtmlOnly", "TextOnly"];
export const UNSUBSCRIBE_HANDLING = ["none", "Postmark", "Custom"];

/** `GET /servers` (account token) or `GET /server` (server token). */
export const ServerResourceType = rt({
  name: "Server",
  id: "postmark-server",
  description:
    "A Postmark server: a project with its own API tokens, message streams, webhooks, templates and sending stats. Edit tracking, inbound and SMTP settings, or create and delete servers with an account token.",
  fields: [
    f("name", "Name"),
    f("serverId", "Server ID", { required: false, editable: false }),
    f("color", "Color", { kind: "enum", enumValues: SERVER_COLORS, required: false }),
    f("deliveryType", "Delivery Type", {
      kind: "enum",
      enumValues: ["Live", "Sandbox"],
      required: false,
      editable: false,
      description: "Sandbox servers accept mail but never deliver it. Fixed at creation.",
    }),
    f("smtpApiActivated", "SMTP Enabled", { kind: "boolean", required: false }),
    f("rawEmailEnabled", "Raw Email in Inbound Webhooks", { kind: "boolean", required: false }),
    f("trackOpens", "Track Opens", { kind: "boolean", required: false }),
    f("trackLinks", "Track Links", {
      kind: "enum",
      enumValues: TRACK_LINKS,
      required: false,
    }),
    f("inboundHookUrl", "Inbound Webhook URL", {
      required: false,
      description: "Postmark posts each inbound message on this server here as JSON.",
    }),
    f("inboundDomain", "Inbound Domain", {
      required: false,
      description: "A domain whose MX records point at inbound.postmarkapp.com.",
    }),
    f("inboundSpamThreshold", "Inbound Spam Threshold", {
      kind: "number",
      required: false,
      description: "SpamAssassin score above which inbound mail is blocked. 0 turns filtering off.",
    }),
    f("inboundAddress", "Inbound Address", { required: false, editable: false }),
    f("postFirstOpenOnly", "Only Post the First Open", { kind: "boolean", required: false }),
    f("includeBounceContentInHook", "Include Bounce Content in Webhooks", {
      kind: "boolean",
      required: false,
    }),
    f("enableSmtpApiErrorHooks", "SMTP API Error Webhooks", { kind: "boolean", required: false }),
    f("serverLink", "Server Link", { required: false, editable: false }),
  ],
  outputs: [
    o("serverId", "Server ID"),
    o("serverToken", "Server API Token", {
      sensitive: true,
      description: "Sends mail and reads this server's data. Use it as POSTMARK_SERVER_TOKEN.",
    }),
    o("inboundAddress", "Inbound Address"),
  ],
  secretExportTemplates: [
    {
      id: "server-token",
      displayName: "Server API token",
      description: "The server token your app sends mail with",
      entries: [{ envKey: "POSTMARK_SERVER_TOKEN", outputKey: "serverToken" }],
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "server",
});

/** `GET /message-streams?IncludeArchivedStreams=true` (server token). */
export const MessageStreamResourceType = rt({
  name: "Message Stream",
  id: "postmark-message-stream",
  description:
    "A message stream on a server: transactional, broadcast or inbound. Edit its name, description and unsubscribe handling, see its suppression list and daily volume, and archive or restore it.",
  fields: [
    f("name", "Name"),
    f("streamId", "Stream ID", { required: false, editable: false }),
    f("serverId", "Server", { required: false, editable: false }),
    f("serverName", "Server Name", { required: false, editable: false }),
    f("messageStreamType", "Type", {
      kind: "enum",
      enumValues: ["Transactional", "Broadcasts", "Inbound"],
      required: false,
      editable: false,
    }),
    f("description", "Description", { required: false }),
    f("unsubscribeHandlingType", "Unsubscribe Handling", {
      kind: "enum",
      enumValues: UNSUBSCRIBE_HANDLING,
      required: false,
      description:
        "Postmark: Postmark adds and handles the unsubscribe link. Custom: you handle unsubscribes. none: no unsubscribe link (transactional streams only).",
    }),
    f("archived", "Archived", { kind: "boolean", required: false, editable: false }),
    f("archivedAt", "Archived At", { required: false, editable: false }),
    f("expectedPurgeDate", "Purged On", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("streamId", "Stream ID")],
  parentTypeId: "postmark-server",
  showInSidebar: true,
  dependsOn: [{ fieldKey: "serverId", targetTypeId: "postmark-server", label: "on server" }],
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  pinnable: false,
  iconKey: "stream",
});

/** `GET /domains` + `GET /domains/{id}` (account token). */
export const DomainResourceType = rt({
  name: "Sending Domain",
  id: "postmark-domain",
  description:
    "A domain verified for sending, with the DKIM and Return-Path DNS records Postmark checks. Verify DKIM and Return-Path, rotate the DKIM key, and set a custom Return-Path.",
  fields: [
    f("name", "Domain", { editable: false }),
    f("domainId", "Domain ID", { required: false, editable: false }),
    f("dkimVerified", "DKIM Verified", { kind: "boolean", required: false, editable: false }),
    f("weakDkim", "Weak DKIM Key", { kind: "boolean", required: false, editable: false }),
    f("dkimHost", "DKIM Host", { required: false, editable: false }),
    f("dkimUpdateStatus", "DKIM Update Status", { required: false, editable: false }),
    f("dkimPendingHost", "Pending DKIM Host", { required: false, editable: false }),
    f("safeToRemoveRevokedKey", "Revoked DKIM Key Safe to Remove", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("returnPathDomain", "Return-Path Domain", {
      required: false,
      description:
        "A subdomain such as pm-bounces.example.com, with a CNAME to pm.mtasv.net. Aligns SPF with your domain for DMARC.",
    }),
    f("returnPathDomainVerified", "Return-Path Verified", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("spfVerified", "SPF Verified", { kind: "boolean", required: false, editable: false }),
  ],
  outputs: [o("domainId", "Domain ID"), o("name", "Domain")],
  postureChecks: [
    {
      id: "postmark-domain-dkim-unverified",
      title: "Postmark sending domain without verified DKIM",
      severity: "medium",
      category: "other",
      conditions: [{ fieldKey: "dkimVerified", when: "falsy" }],
      reason:
        "Mail from this domain is not DKIM-signed with your domain, so it fails DMARC alignment and is more likely to land in spam.",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "globe",
});

/**
 * The DNS records a sending domain needs, synthesised from the domain's
 * `DKIMHost`/`DKIMTextValue` (TXT), the pending key during a rotation, and
 * `ReturnPathDomain` → `ReturnPathDomainCNAMEValue` (CNAME). Postmark does
 * not host DNS: these are the records that must exist at your DNS provider.
 */
export const DnsRecordResourceType = rt({
  name: "Required DNS Record",
  id: "postmark-dns-record",
  description:
    "A DNS record Postmark needs at your DNS provider for a sending domain: the DKIM TXT key and the Return-Path CNAME, with whether Postmark has verified it.",
  fields: [
    f("name", "Host"),
    f("type", "Type"),
    f("content", "Value"),
    f("purpose", "Purpose", { required: false }),
    f("verified", "Verified", { kind: "boolean", required: false }),
    f("domainName", "Domain", { required: false }),
    f("domainId", "Domain ID", { required: false }),
  ],
  outputs: [o("name", "Host"), o("content", "Value")],
  parentTypeId: "postmark-domain",
  dependsOn: [{ fieldKey: "domainId", targetTypeId: "postmark-domain", label: "for domain" }],
  dnsRole: { role: "record" },
  supportsDelete: false,
  pinnable: false,
  iconKey: "dns-record",
});

/** `GET /senders` (account token). */
export const SenderSignatureResourceType = rt({
  name: "Sender Signature",
  id: "postmark-sender-signature",
  description:
    "A confirmed From address. Edit its name, Reply-To and Return-Path, resend the confirmation email, or delete it.",
  fields: [
    f("emailAddress", "From Address", { editable: false }),
    f("name", "From Name"),
    f("replyToEmailAddress", "Reply-To", { required: false }),
    f("returnPathDomain", "Return-Path Domain", { required: false }),
    f("domain", "Domain", { required: false, editable: false }),
    f("confirmed", "Confirmed", { kind: "boolean", required: false, editable: false }),
    f("signatureId", "Signature ID", { required: false, editable: false }),
  ],
  outputs: [o("emailAddress", "From Address")],
  dependsOn: [
    { fieldKey: "domain", targetTypeId: "postmark-domain", targetKey: "name", label: "on domain" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "mail",
});

/** `GET /webhooks` (server token). */
export const WebhookResourceType = rt({
  name: "Webhook",
  id: "postmark-webhook",
  description:
    "A webhook on a message stream: which events Postmark posts (deliveries, bounces, spam complaints, opens, clicks, subscription changes), where, and with what auth. Shows the last 24 hours of delivery attempts.",
  fields: [
    f("url", "URL"),
    f("serverId", "Server", { required: false, editable: false }),
    f("serverName", "Server Name", { required: false, editable: false }),
    f("messageStream", "Message Stream", { required: false, editable: false }),
    f("delivery", "Delivery", { kind: "boolean", required: false }),
    f("bounce", "Bounce", { kind: "boolean", required: false }),
    f("bounceIncludeContent", "Include Bounce Content", { kind: "boolean", required: false }),
    f("spamComplaint", "Spam Complaint", { kind: "boolean", required: false }),
    f("spamIncludeContent", "Include Spam Complaint Content", {
      kind: "boolean",
      required: false,
    }),
    f("open", "Open", { kind: "boolean", required: false }),
    f("postFirstOpenOnly", "Only the First Open", { kind: "boolean", required: false }),
    f("click", "Click", { kind: "boolean", required: false }),
    f("subscriptionChange", "Subscription Change", { kind: "boolean", required: false }),
    f("httpAuthUsername", "Basic Auth Username", { required: false }),
    f("httpAuthPassword", "Basic Auth Password", {
      kind: "password",
      required: false,
      description: "Leave blank to keep the current password.",
    }),
    f("headerCount", "Custom Headers", { kind: "number", required: false, editable: false }),
    f("webhookId", "Webhook ID", { required: false, editable: false }),
  ],
  outputs: [o("url", "URL")],
  parentTypeId: "postmark-server",
  dependsOn: [{ fieldKey: "serverId", targetTypeId: "postmark-server", label: "on server" }],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "hook",
});

/** `GET /templates` (server token). */
export const TemplateResourceType = rt({
  name: "Template",
  id: "postmark-template",
  description:
    "An email template or layout on a server. Edit its name, alias, subject and bodies, or create and delete templates.",
  fields: [
    f("name", "Name"),
    f("alias", "Alias", { required: false }),
    f("templateType", "Type", {
      kind: "enum",
      enumValues: ["Standard", "Layout"],
      required: false,
      editable: false,
    }),
    f("layoutTemplate", "Layout", {
      required: false,
      description: "Alias of the layout this template renders inside. Blank for none.",
    }),
    f("subject", "Subject", { required: false }),
    f("htmlBody", "HTML Body", { required: false }),
    f("textBody", "Text Body", { required: false }),
    f("active", "Active", { kind: "boolean", required: false, editable: false }),
    f("serverId", "Server", { required: false, editable: false }),
    f("serverName", "Server Name", { required: false, editable: false }),
    f("templateId", "Template ID", { required: false, editable: false }),
  ],
  outputs: [o("templateId", "Template ID"), o("alias", "Alias")],
  parentTypeId: "postmark-server",
  dependsOn: [{ fieldKey: "serverId", targetTypeId: "postmark-server", label: "on server" }],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "file",
});

/** `GET /triggers/inboundrules` (server token). */
export const InboundRuleResourceType = rt({
  name: "Inbound Rule",
  id: "postmark-inbound-rule",
  description:
    "A block rule for inbound mail on a server: an address or a whole domain whose messages Postmark drops.",
  fields: [
    f("rule", "Blocked Address or Domain", { editable: false }),
    f("serverId", "Server", { required: false, editable: false }),
    f("serverName", "Server Name", { required: false, editable: false }),
  ],
  outputs: [],
  parentTypeId: "postmark-server",
  dependsOn: [{ fieldKey: "serverId", targetTypeId: "postmark-server", label: "on server" }],
  supportsCreate: true,
  pinnable: false,
  iconKey: "shield",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  ServerResourceType,
  MessageStreamResourceType,
  DomainResourceType,
  DnsRecordResourceType,
  SenderSignatureResourceType,
  WebhookResourceType,
  TemplateResourceType,
  InboundRuleResourceType,
];
