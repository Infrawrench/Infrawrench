import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Twilio SendGrid resource types. Field names follow `twilio/sendgrid-oai`
 * (2026-10); each type names the endpoint it lists from.
 */

/** `GET /v3/user/username`, `/v3/user/account`, `/v3/user/credits`, `/v3/user/profile`. */
export const AccountResourceType = rt({
  name: "Account",
  id: "sendgrid-account",
  description:
    "The SendGrid account (or subuser) the API key belongs to: plan type, sender reputation, the email credits left this period, account-wide suppressions, and daily sending metrics.",
  fields: [
    f("username", "Username", { editable: false }),
    f("userId", "User ID", { required: false, editable: false }),
    f("type", "Plan Type", { required: false, editable: false }),
    f("reputation", "Sender Reputation", { kind: "number", required: false, editable: false }),
    f("creditsTotal", "Email Credits", { kind: "number", required: false, editable: false }),
    f("creditsUsed", "Credits Used", { kind: "number", required: false, editable: false }),
    f("creditsRemain", "Credits Remaining", { kind: "number", required: false, editable: false }),
    f("creditsOverage", "Overage", { kind: "number", required: false, editable: false }),
    f("creditsResetFrequency", "Credits Reset", { required: false, editable: false }),
    f("creditsNextReset", "Next Reset", { required: false, editable: false }),
    f("company", "Company", { required: false, editable: false }),
    f("region", "API Region", { required: false, editable: false }),
    f("onBehalfOf", "Acting As Subuser", { required: false, editable: false }),
  ],
  outputs: [o("username", "Username")],
  accountRoot: true,
  supportsDelete: false,
  supportsMetrics: true,
  iconKey: "account",
});

/** `GET /v3/api_keys` + `GET /v3/api_keys/{id}` for the scopes. */
export const ApiKeyResourceType = rt({
  name: "API Key",
  id: "sendgrid-api-key",
  description:
    "A SendGrid API key and the scopes it holds. Rename it, change its scopes, create new keys (the secret is shown once) or delete one to revoke it.",
  fields: [
    f("name", "Name"),
    f("apiKeyId", "Key ID", { required: false, editable: false }),
    f("scopes", "Scopes", {
      required: false,
      description:
        "Comma-separated SendGrid scopes, such as mail.send. A key can only grant scopes the connected key holds.",
    }),
    f("scopeCount", "Scope Count", { kind: "number", required: false, editable: false }),
    f("canCreateKeys", "Can Create API Keys", {
      kind: "boolean",
      required: false,
      editable: false,
      description:
        "Holds api_keys.create, so it can mint keys with any of its scopes: admin-equivalent.",
    }),
    f("inUse", "Used by This Connection", { kind: "boolean", required: false, editable: false }),
  ],
  outputs: [
    o("apiKeyId", "Key ID"),
    o("apiKey", "API Key", {
      sensitive: true,
      description: "Only returned when the key is created.",
    }),
  ],
  secretExportTemplates: [
    {
      id: "api-key",
      displayName: "SendGrid API key",
      description: "The key, as SENDGRID_API_KEY (available right after creating it)",
      entries: [{ envKey: "SENDGRID_API_KEY", outputKey: "apiKey" }],
    },
  ],
  principalRole: { role: "key", adminIndicatorKey: "canCreateKeys" },
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "key",
});

/** `GET /v3/whitelabel/domains`. */
export const DomainResourceType = rt({
  name: "Authenticated Domain",
  id: "sendgrid-domain",
  description:
    "A domain authenticated for sending (DKIM and SPF through CNAME or TXT records). Validate its DNS, make it the default, or create and delete domains.",
  fields: [
    f("domain", "Domain", { editable: false }),
    f("subdomain", "Return-Path Subdomain", { required: false, editable: false }),
    f("username", "Owner", { required: false, editable: false }),
    f("valid", "Valid", { kind: "boolean", required: false, editable: false }),
    f("default", "Default", {
      kind: "boolean",
      required: false,
      description: "Used for mail whose From domain matches no other authenticated domain.",
    }),
    f("customSpf", "Custom SPF", { kind: "boolean", required: false }),
    f("automaticSecurity", "Automated Security", {
      kind: "boolean",
      required: false,
      editable: false,
      description: "SendGrid manages SPF and rotates DKIM keys through CNAMEs.",
    }),
    f("legacy", "Legacy", { kind: "boolean", required: false, editable: false }),
    f("ips", "Custom SPF IPs", { required: false, editable: false }),
    f("subusers", "Subusers", { required: false, editable: false }),
    f("lastValidationAt", "Last Validated", { required: false, editable: false }),
    f("domainId", "Domain ID", { required: false, editable: false }),
  ],
  outputs: [o("domain", "Domain"), o("domainId", "Domain ID")],
  postureChecks: [
    {
      id: "sendgrid-domain-unvalidated",
      title: "SendGrid authenticated domain not validated",
      severity: "medium",
      category: "other",
      conditions: [{ fieldKey: "valid", when: "falsy" }],
      reason:
        "SendGrid could not find this domain's DNS records, so mail from it is not DKIM-signed with your domain and fails DMARC alignment.",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "globe",
});

/** `GET /v3/whitelabel/links`. */
export const LinkBrandingResourceType = rt({
  name: "Link Branding",
  id: "sendgrid-link-branding",
  description:
    "Branded tracking links: click and open tracking served from your own subdomain instead of sendgrid.net. Validate, make default, create or delete.",
  fields: [
    f("domain", "Domain", { editable: false }),
    f("subdomain", "Subdomain", { required: false, editable: false }),
    f("username", "Owner", { required: false, editable: false }),
    f("valid", "Valid", { kind: "boolean", required: false, editable: false }),
    f("default", "Default", { kind: "boolean", required: false }),
    f("legacy", "Legacy", { kind: "boolean", required: false, editable: false }),
    f("linkId", "Link Branding ID", { required: false, editable: false }),
  ],
  outputs: [o("linkId", "Link Branding ID")],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "link",
});

/** `GET /v3/whitelabel/ips`. */
export const ReverseDnsResourceType = rt({
  name: "Reverse DNS",
  id: "sendgrid-reverse-dns",
  description:
    "Reverse DNS for a dedicated IP: the hostname the IP answers to, backed by an A record you publish. Validate, create or delete.",
  fields: [
    f("ip", "IP Address", { editable: false }),
    f("rdns", "Hostname", { required: false, editable: false }),
    f("domain", "Domain", { required: false, editable: false }),
    f("subdomain", "Subdomain", { required: false, editable: false }),
    f("valid", "Valid", { kind: "boolean", required: false, editable: false }),
    f("rdnsId", "Reverse DNS ID", { required: false, editable: false }),
  ],
  outputs: [o("rdns", "Hostname")],
  dependsOn: [{ fieldKey: "ip", targetTypeId: "sendgrid-ip", label: "for IP" }],
  supportsCreate: true,
  pinnable: false,
  iconKey: "dns",
});

/**
 * The DNS records SendGrid needs at your DNS provider, read from the `dns`
 * objects of authenticated domains and link branding, a reverse-DNS
 * `a_record`, and the MX an inbound parse hostname needs.
 */
export const DnsRecordResourceType = rt({
  name: "Required DNS Record",
  id: "sendgrid-dns-record",
  description:
    "A DNS record SendGrid needs at your DNS provider: domain authentication CNAMEs or TXT records, link branding CNAMEs, reverse DNS A records and inbound parse MX records, with whether SendGrid found it.",
  fields: [
    f("name", "Host"),
    f("type", "Type"),
    f("content", "Value"),
    f("priority", "Priority", { kind: "number", required: false }),
    f("purpose", "Purpose", { required: false }),
    f("valid", "Valid", { kind: "boolean", required: false }),
    f("ownerType", "For", { required: false }),
    f("ownerName", "Owner", { required: false }),
    f("domainId", "Authenticated Domain", { required: false }),
    f("linkId", "Link Branding", { required: false }),
    f("rdnsId", "Reverse DNS", { required: false }),
    f("parseHostname", "Inbound Parse Host", { required: false }),
  ],
  outputs: [o("name", "Host"), o("content", "Value")],
  dependsOn: [
    { fieldKey: "domainId", targetTypeId: "sendgrid-domain", label: "for domain" },
    { fieldKey: "linkId", targetTypeId: "sendgrid-link-branding", label: "for link branding" },
    { fieldKey: "rdnsId", targetTypeId: "sendgrid-reverse-dns", label: "for reverse DNS" },
    {
      fieldKey: "parseHostname",
      targetTypeId: "sendgrid-inbound-parse",
      label: "for inbound parse",
    },
  ],
  dnsRole: { role: "record", priorityKey: "priority" },
  supportsDelete: false,
  pinnable: false,
  iconKey: "dns-record",
});

/** `GET /v3/ips`. */
export const IpResourceType = rt({
  name: "Dedicated IP",
  id: "sendgrid-ip",
  description:
    "A dedicated sending IP: its pools, warmup state, reverse DNS and the subusers that send from it. Start or stop automatic warmup.",
  fields: [
    f("ip", "IP Address", { editable: false }),
    f("pools", "IP Pools", { required: false, editable: false }),
    f("warmup", "Warming Up", { kind: "boolean", required: false, editable: false }),
    f("warmupStartedAt", "Warmup Started", { required: false, editable: false }),
    f("rdns", "Reverse DNS", { required: false, editable: false }),
    f("whitelabeled", "Reverse DNS Set Up", { kind: "boolean", required: false, editable: false }),
    f("subusers", "Subusers", { required: false, editable: false }),
    f("assignedAt", "Assigned", { required: false, editable: false }),
  ],
  outputs: [o("ip", "IP Address")],
  dependsOn: [
    { fieldKey: "pools", targetTypeId: "sendgrid-ip-pool", targetKey: "name", label: "in pool" },
  ],
  supportsDelete: false,
  pinnable: false,
  iconKey: "network",
});

/** `GET /v3/ips/pools` + `GET /v3/ips/pools/{name}`. */
export const IpPoolResourceType = rt({
  name: "IP Pool",
  id: "sendgrid-ip-pool",
  description:
    "A named group of dedicated IPs that mail can be sent through. Rename, add or remove IPs, create or delete pools.",
  fields: [
    f("name", "Name", { description: "Up to 64 characters." }),
    f("ips", "IPs", { required: false, editable: false }),
    f("ipCount", "IP Count", { kind: "number", required: false, editable: false }),
  ],
  outputs: [o("name", "Name")],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "network",
});

/** `GET /v3/subusers` (parent accounts only). */
export const SubuserResourceType = rt({
  name: "Subuser",
  id: "sendgrid-subuser",
  description:
    "A subuser of the parent account: its own reputation, credit allocation and daily sending metrics. Enable or disable it, change its credits, or create and delete subusers.",
  fields: [
    f("username", "Username", { editable: false }),
    f("email", "Email", { required: false, editable: false }),
    f("disabled", "Disabled", {
      kind: "boolean",
      required: false,
      description: "A disabled subuser cannot send mail or sign in.",
    }),
    f("region", "Region", { required: false, editable: false }),
    f("reputation", "Sender Reputation", { kind: "number", required: false, editable: false }),
    f("creditType", "Credit Allocation", {
      kind: "enum",
      enumValues: ["unlimited", "recurring", "nonrecurring"],
      required: false,
      description:
        "unlimited: draws on the parent. recurring: a fixed amount every period. nonrecurring: a one-off amount.",
    }),
    f("creditTotal", "Credits per Period", { kind: "number", required: false }),
    f("creditResetFrequency", "Credit Reset", {
      kind: "enum",
      enumValues: ["monthly", "weekly", "daily"],
      required: false,
    }),
    f("creditUsed", "Credits Used", { kind: "number", required: false, editable: false }),
    f("creditRemain", "Credits Remaining", { kind: "number", required: false, editable: false }),
    f("userId", "User ID", { required: false, editable: false }),
  ],
  outputs: [o("username", "Username")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "users",
});

export const EVENT_KEYS = [
  ["processed", "Processed"],
  ["delivered", "Delivered"],
  ["deferred", "Deferred"],
  ["bounce", "Bounce"],
  ["dropped", "Dropped"],
  ["spam_report", "Spam report"],
  ["open", "Open"],
  ["click", "Click"],
  ["unsubscribe", "Unsubscribe"],
  ["group_unsubscribe", "Group unsubscribe"],
  ["group_resubscribe", "Group resubscribe"],
] as const;

/** Field key for each event flag (`spam_report` → `spamReport`). */
export const eventFieldKey = (event: string) =>
  event.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** `GET /v3/user/webhooks/event/settings/all`. */
export const EventWebhookResourceType = rt({
  name: "Event Webhook",
  id: "sendgrid-event-webhook",
  description:
    "An Event Webhook: which delivery and engagement events SendGrid posts, and where. Enable or disable it, change its events, send a test event, or create and delete webhooks.",
  fields: [
    f("friendlyName", "Name", { required: false }),
    f("url", "URL"),
    f("enabled", "Enabled", { kind: "boolean", required: false }),
    ...EVENT_KEYS.map(([event, label]) =>
      f(eventFieldKey(event), label, { kind: "boolean", required: false }),
    ),
    f("signed", "Signature Verification", {
      kind: "boolean",
      required: false,
      description: "SendGrid signs each POST so the receiver can verify it came from SendGrid.",
    }),
    f("oauth", "OAuth", { kind: "boolean", required: false, editable: false }),
    f("webhookId", "Webhook ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("url", "URL"), o("publicKey", "Verification Public Key")],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "hook",
});

/** `GET /v3/user/webhooks/parse/settings`. */
export const InboundParseResourceType = rt({
  name: "Inbound Parse",
  id: "sendgrid-inbound-parse",
  description:
    "An Inbound Parse hostname: mail to it is parsed and posted to your URL. Needs an MX record to mx.sendgrid.net.",
  fields: [
    f("hostname", "Receiving Hostname", { editable: false }),
    f("url", "Destination URL"),
    f("spamCheck", "Check for Spam", { kind: "boolean", required: false }),
    f("sendRaw", "Post the Raw MIME", { kind: "boolean", required: false }),
  ],
  outputs: [o("hostname", "Receiving Hostname")],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "mail",
});

/** `GET /v3/templates?generations=legacy,dynamic`. */
export const TemplateResourceType = rt({
  name: "Template",
  id: "sendgrid-template",
  description:
    "A transactional template (dynamic or legacy) and its versions. Rename it, see the active version's subject and content, or create and delete templates.",
  fields: [
    f("name", "Name"),
    f("generation", "Generation", {
      kind: "enum",
      enumValues: ["dynamic", "legacy"],
      required: false,
      editable: false,
    }),
    f("activeVersion", "Active Version", { required: false, editable: false }),
    f("subject", "Active Subject", { required: false, editable: false }),
    f("versionCount", "Versions", { kind: "number", required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
    f("templateId", "Template ID", { required: false, editable: false }),
  ],
  outputs: [o("templateId", "Template ID")],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "file",
});

/** `GET /v3/asm/groups`. */
export const UnsubscribeGroupResourceType = rt({
  name: "Unsubscribe Group",
  id: "sendgrid-unsubscribe-group",
  description:
    "An unsubscribe (suppression) group recipients can opt out of individually. Edit, create and delete groups, and see how many have unsubscribed.",
  fields: [
    f("name", "Name", { description: "Up to 30 characters, shown to recipients." }),
    f("description", "Description", {
      required: false,
      description: "Up to 100 characters, shown to recipients.",
    }),
    f("isDefault", "Default", { kind: "boolean", required: false }),
    f("unsubscribes", "Unsubscribes", { kind: "number", required: false, editable: false }),
    f("groupId", "Group ID", { required: false, editable: false }),
  ],
  outputs: [o("groupId", "Group ID")],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "users",
});

/** `GET /v3/verified_senders`. */
export const VerifiedSenderResourceType = rt({
  name: "Verified Sender",
  id: "sendgrid-verified-sender",
  description:
    "A single From address verified by email (Single Sender Verification). Edit it, resend the verification email, or create and delete senders.",
  fields: [
    f("nickname", "Nickname"),
    f("fromEmail", "From Address", { editable: false }),
    f("fromName", "From Name", { required: false }),
    f("replyTo", "Reply-To"),
    f("replyToName", "Reply-To Name", { required: false }),
    f("address", "Address"),
    f("address2", "Address Line 2", { required: false }),
    f("city", "City"),
    f("state", "State", { required: false }),
    f("zip", "ZIP", { required: false }),
    f("country", "Country"),
    f("verified", "Verified", { kind: "boolean", required: false, editable: false }),
    f("locked", "Locked", { kind: "boolean", required: false, editable: false }),
    f("senderId", "Sender ID", { required: false, editable: false }),
  ],
  outputs: [o("fromEmail", "From Address")],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "mail",
});

/** `GET /v3/alerts`. */
export const AlertResourceType = rt({
  name: "Alert",
  id: "sendgrid-alert",
  description:
    "A SendGrid email alert: a usage alert when a percentage of the plan's credits is used, or a periodic stats summary.",
  fields: [
    f("type", "Type", {
      kind: "enum",
      enumValues: ["usage_limit", "stats_notification"],
      editable: false,
    }),
    f("emailTo", "Send To"),
    f("percentage", "At Percent of Credits Used", { kind: "number", required: false }),
    f("frequency", "Frequency", {
      kind: "enum",
      enumValues: ["daily", "weekly", "monthly"],
      required: false,
    }),
    f("alertId", "Alert ID", { required: false, editable: false }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "bell",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  AccountResourceType,
  ApiKeyResourceType,
  DomainResourceType,
  LinkBrandingResourceType,
  ReverseDnsResourceType,
  DnsRecordResourceType,
  IpResourceType,
  IpPoolResourceType,
  SubuserResourceType,
  EventWebhookResourceType,
  InboundParseResourceType,
  TemplateResourceType,
  UnsubscribeGroupResourceType,
  VerifiedSenderResourceType,
  AlertResourceType,
];
