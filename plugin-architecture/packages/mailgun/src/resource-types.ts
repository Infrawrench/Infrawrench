import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Mailgun resource types. Field names follow Mailgun's OpenAPI document
 * (2026-10). Region-scoped types carry `region` ("us" or "eu") and an
 * external id prefixed with it, because the same name can exist in both.
 */

export const WEBHOOK_EVENTS = [
  ["accepted", "Accepted"],
  ["delivered", "Delivered"],
  ["opened", "Opened"],
  ["clicked", "Clicked"],
  ["unsubscribed", "Unsubscribed"],
  ["complained", "Complained"],
  ["temporary_fail", "Temporary failure"],
  ["permanent_fail", "Permanent failure"],
] as const;

export const eventFieldKey = (event: string) =>
  event.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

const REGION_FIELD = f("region", "Region", {
  kind: "enum",
  enumValues: ["us", "eu"],
  required: false,
  editable: false,
});

/** `GET /v5/accounts/limit/custom/monthly` and the account's metrics. */
export const AccountResourceType = rt({
  name: "Account",
  id: "mailgun-account",
  description:
    "The Mailgun account: the custom monthly sending limit and how much of it is used, the webhook signing key, and daily sending metrics across every domain.",
  fields: [
    f("name", "Name", { editable: false }),
    f("regions", "Regions", { required: false, editable: false }),
    f("domainCount", "Domains", { kind: "number", required: false, editable: false }),
    f("monthlyLimit", "Custom Monthly Limit", {
      kind: "number",
      required: false,
      description:
        "A hard cap on messages per calendar month. Mailgun emails you at 50% and 75% and disables sending at 100% until next month. 0 removes the limit.",
    }),
    f("monthlySent", "Sent This Month", { kind: "number", required: false, editable: false }),
    f("limitPeriod", "Limit Period", { required: false, editable: false }),
  ],
  outputs: [
    o("webhookSigningKey", "Webhook Signing Key", {
      sensitive: true,
      description: "Verifies that webhook requests came from Mailgun.",
    }),
  ],
  secretExportTemplates: [
    {
      id: "webhook-signing-key",
      displayName: "Webhook signing key",
      entries: [{ envKey: "MAILGUN_WEBHOOK_SIGNING_KEY", outputKey: "webhookSigningKey" }],
    },
  ],
  accountRoot: true,
  supportsUpdate: true,
  supportsDelete: false,
  supportsMetrics: true,
  iconKey: "account",
});

/** `GET /v4/domains` + `GET /v4/domains/{name}` + `GET /v3/domains/{name}/tracking`. */
export const DomainResourceType = rt({
  name: "Domain",
  id: "mailgun-domain",
  description:
    "A sending domain in the US or EU region, with its DNS records, verification state, tracking and security settings, suppressions and daily metrics. Verify it, edit it, or create and delete domains.",
  fields: [
    f("name", "Domain", { editable: false }),
    REGION_FIELD,
    f("state", "State", { required: false, editable: false }),
    f("type", "Type", { required: false, editable: false }),
    f("spamAction", "Inbound Spam Action", {
      kind: "enum",
      enumValues: ["disabled", "tag", "block"],
      required: false,
      description: "What happens to inbound spam: nothing, tag it, or block it.",
    }),
    f("webScheme", "Tracking Scheme", {
      kind: "enum",
      enumValues: ["https", "http"],
      required: false,
      description:
        "Whether open and click tracking links use HTTPS (needs a certificate for the tracking host).",
    }),
    f("webPrefix", "Tracking Subdomain", { required: false }),
    f("trackingHost", "Tracking Host", { required: false, editable: false }),
    f("trackOpens", "Track Opens", { kind: "boolean", required: false }),
    f("trackClicks", "Track Clicks", { kind: "boolean", required: false }),
    f("trackUnsubscribes", "Unsubscribe Links", { kind: "boolean", required: false }),
    f("wildcard", "Accept Subdomains", { kind: "boolean", required: false }),
    f("requireTls", "Require TLS", { kind: "boolean", required: false }),
    f("skipVerification", "Skip TLS Certificate Verification", {
      kind: "boolean",
      required: false,
    }),
    f("automaticSenderSecurity", "Automatic Sender Security", { kind: "boolean", required: false }),
    f("messageTtl", "Message Retention (seconds)", { kind: "number", required: false }),
    f("archiveTo", "Archive To", { required: false }),
    f("smtpLogin", "Default SMTP Login", { required: false, editable: false }),
    f("disabled", "Disabled", { kind: "boolean", required: false, editable: false }),
    f("disabledReason", "Disabled Reason", { required: false, editable: false }),
    f("ipPoolId", "Dedicated IP Pool", { required: false, editable: false }),
    f("subaccountId", "Subaccount", { required: false, editable: false }),
    f("domainId", "Domain ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("name", "Domain"), o("smtpHost", "SMTP Host"), o("apiBaseUrl", "API Base URL")],
  dependsOn: [
    { fieldKey: "ipPoolId", targetTypeId: "mailgun-ip-pool", label: "sends through" },
    { fieldKey: "subaccountId", targetTypeId: "mailgun-subaccount", label: "owned by" },
  ],
  postureChecks: [
    {
      id: "mailgun-domain-unverified",
      title: "Mailgun domain not verified",
      severity: "medium",
      category: "other",
      conditions: [{ fieldKey: "state", when: "equals", value: "unverified" }],
      reason:
        "Mailgun has not found this domain's SPF and DKIM records, so it cannot send from it with your domain's authentication.",
    },
    {
      id: "mailgun-domain-tracking-http",
      title: "Mailgun tracking links use plain HTTP",
      severity: "low",
      category: "encryption",
      conditions: [{ fieldKey: "webScheme", when: "equals", value: "http" }],
      reason: "Open and click tracking links on this domain are served over unencrypted HTTP.",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "globe",
});

/** The domain's `sending_dns_records` and `receiving_dns_records`. */
export const DnsRecordResourceType = rt({
  name: "Required DNS Record",
  id: "mailgun-dns-record",
  description:
    "A DNS record Mailgun needs at your DNS provider for a domain: SPF and DKIM TXT records and the tracking CNAME for sending, MX records for receiving, with whether Mailgun found it.",
  fields: [
    f("name", "Host"),
    f("type", "Type"),
    f("content", "Value"),
    f("priority", "Priority", { kind: "number", required: false }),
    f("purpose", "Purpose", { required: false }),
    f("valid", "Valid", { required: false }),
    f("cached", "Currently Published", { required: false }),
    f("domainName", "Domain", { required: false }),
    REGION_FIELD,
  ],
  outputs: [o("name", "Host"), o("content", "Value")],
  parentTypeId: "mailgun-domain",
  dependsOn: [
    {
      fieldKey: "domainName",
      targetTypeId: "mailgun-domain",
      targetKey: "name",
      label: "for domain",
    },
  ],
  dnsRole: { role: "record", priorityKey: "priority" },
  supportsDelete: false,
  pinnable: false,
  iconKey: "dns-record",
});

/** `GET /v1/keys`. */
export const ApiKeyResourceType = rt({
  name: "API Key",
  id: "mailgun-api-key",
  description:
    "A Mailgun API key: account keys with a role (admin, developer, analyst, support) and domain sending keys that can only send for one domain. Create keys (the secret is shown once) or delete them to revoke.",
  fields: [
    f("description", "Description", { editable: false }),
    f("kind", "Kind", { required: false, editable: false }),
    f("role", "Role", { required: false, editable: false }),
    f("domainName", "Domain", { required: false, editable: false }),
    f("userName", "User", { required: false, editable: false }),
    f("disabled", "Disabled", { kind: "boolean", required: false, editable: false }),
    f("disabledReason", "Disabled Reason", { required: false, editable: false }),
    f("expiresAt", "Expires", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("keyId", "Key ID", { required: false, editable: false }),
  ],
  outputs: [
    o("keyId", "Key ID"),
    o("secret", "Secret", {
      sensitive: true,
      description: "Only returned when the key is created.",
    }),
  ],
  secretExportTemplates: [
    {
      id: "api-key",
      displayName: "Mailgun API key",
      description: "The key, as MAILGUN_API_KEY (available right after creating it)",
      entries: [{ envKey: "MAILGUN_API_KEY", outputKey: "secret" }],
    },
  ],
  dependsOn: [
    {
      fieldKey: "domainName",
      targetTypeId: "mailgun-domain",
      targetKey: "name",
      label: "sends for",
    },
  ],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "api-token", label: "API key expires" },
    { fieldKey: "createdAt", from: "created", kind: "access-key", label: "Key due for rotation" },
  ],
  principalRole: {
    role: "key",
    createdKey: "createdAt",
    adminIndicatorKey: "role",
    adminValues: ["admin"],
    parentKey: "userName",
  },
  supportsCreate: true,
  pinnable: false,
  iconKey: "key",
});

/** `GET /v3/domains/{domain}/webhooks`, regrouped by URL. */
export const WebhookResourceType = rt({
  name: "Domain Webhook",
  id: "mailgun-webhook",
  description:
    "A URL Mailgun posts a domain's events to (delivered, opened, clicked, failures, complaints, unsubscribes). Change its events, or create and delete webhooks.",
  fields: [
    f("url", "URL", { editable: false }),
    f("domainName", "Domain", { required: false, editable: false }),
    REGION_FIELD,
    ...WEBHOOK_EVENTS.map(([event, label]) =>
      f(eventFieldKey(event), label, { kind: "boolean", required: false }),
    ),
  ],
  outputs: [o("url", "URL")],
  parentTypeId: "mailgun-domain",
  dependsOn: [
    {
      fieldKey: "domainName",
      targetTypeId: "mailgun-domain",
      targetKey: "name",
      label: "for domain",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "hook",
});

/** `GET /v1/webhooks`. */
export const AccountWebhookResourceType = rt({
  name: "Account Webhook",
  id: "mailgun-account-webhook",
  description:
    "An account-level webhook: events from every domain on the account, posted to one URL. Edit its URL, events and description, or create and delete them.",
  fields: [
    f("url", "URL"),
    f("description", "Description", { required: false }),
    ...WEBHOOK_EVENTS.map(([event, label]) =>
      f(eventFieldKey(event), label, { kind: "boolean", required: false }),
    ),
    f("webhookId", "Webhook ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("url", "URL")],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "hook",
});

/** `GET /v3/routes`. */
export const RouteResourceType = rt({
  name: "Route",
  id: "mailgun-route",
  description:
    "An inbound route: a filter expression and the actions Mailgun takes on matching mail (forward, store, stop). Edit, create and delete routes.",
  fields: [
    f("description", "Description", { required: false }),
    f("expression", "Filter Expression", {
      description: 'For example match_recipient(".*@example.com") or catch_all().',
    }),
    f("actions", "Actions", {
      description: 'One per line, for example forward("https://example.com/inbound") and stop().',
    }),
    f("priority", "Priority", {
      kind: "number",
      required: false,
      description: "Lower runs first. Routes with the same priority run in creation order.",
    }),
    REGION_FIELD,
    f("routeId", "Route ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("routeId", "Route ID")],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "route",
});

/** `GET /v3/lists/pages`. */
export const MailingListResourceType = rt({
  name: "Mailing List",
  id: "mailgun-mailing-list",
  description:
    "A mailing list address that fans mail out to its members. Edit its name, description, access level and reply handling, see recent members, add or remove members, or create and delete lists.",
  fields: [
    f("address", "Address", { editable: false }),
    f("name", "Name", { required: false }),
    f("description", "Description", { required: false }),
    f("accessLevel", "Who Can Post", {
      kind: "enum",
      enumValues: ["readonly", "members", "everyone"],
      required: false,
      description: "readonly: only through the API. members: list members. everyone: anyone.",
    }),
    f("replyPreference", "Replies Go To", {
      kind: "enum",
      enumValues: ["list", "sender"],
      required: false,
    }),
    f("membersCount", "Members", { kind: "number", required: false, editable: false }),
    REGION_FIELD,
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("address", "Address")],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "users",
});

/** `GET /v3/domains/{domain}/credentials`. */
export const SmtpCredentialResourceType = rt({
  name: "SMTP Credential",
  id: "mailgun-smtp-credential",
  description: "An SMTP login for a domain. Reset its password or create and delete logins.",
  fields: [
    f("login", "Login", { editable: false }),
    f("password", "Password", {
      kind: "password",
      required: false,
      description: "Set a new password. Leave blank to keep the current one.",
    }),
    f("domainName", "Domain", { required: false, editable: false }),
    REGION_FIELD,
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("login", "Login"), o("smtpHost", "SMTP Host")],
  parentTypeId: "mailgun-domain",
  dependsOn: [
    {
      fieldKey: "domainName",
      targetTypeId: "mailgun-domain",
      targetKey: "name",
      label: "for domain",
    },
  ],
  expiryFields: [
    {
      fieldKey: "createdAt",
      from: "created",
      kind: "access-key",
      label: "SMTP password due for rotation",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "key",
});

/** `GET /v3/ip_pools`. */
export const IpPoolResourceType = rt({
  name: "IP Pool",
  id: "mailgun-ip-pool",
  description:
    "A dedicated IP pool (DIPP): a named group of dedicated IPs that linked domains send from. Rename, add or remove IPs, link domains, or create and delete pools.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("ips", "IPs", { required: false, editable: false }),
    f("ipCount", "IP Count", { kind: "number", required: false, editable: false }),
    f("linked", "Linked to Domains", { kind: "boolean", required: false, editable: false }),
    f("inherited", "Inherited from Parent", { kind: "boolean", required: false, editable: false }),
    f("poolId", "Pool ID", { required: false, editable: false }),
  ],
  outputs: [o("poolId", "Pool ID")],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "network",
});

/** `GET /v3/ips` + `GET /v3/ips/{ip}`. */
export const IpResourceType = rt({
  name: "IP Address",
  id: "mailgun-ip",
  description:
    "A sending IP on the account: whether it is dedicated, enabled and warming up, and its reverse DNS.",
  fields: [
    f("ip", "IP Address", { editable: false }),
    f("dedicated", "Dedicated", { kind: "boolean", required: false, editable: false }),
    f("enabled", "Enabled", { kind: "boolean", required: false, editable: false }),
    f("warmingUp", "Warming Up", { kind: "boolean", required: false, editable: false }),
    f("pools", "IP Pools", { required: false, editable: false }),
  ],
  outputs: [o("ip", "IP Address")],
  dependsOn: [{ fieldKey: "pools", targetTypeId: "mailgun-ip-pool", label: "in pool" }],
  supportsDelete: false,
  pinnable: false,
  iconKey: "network",
});

/** `POST /v1/analytics/tags` (list query). */
export const TagResourceType = rt({
  name: "Tag",
  id: "mailgun-tag",
  description:
    "A message tag with its description and when it was first and last seen. Edit the description or delete the tag.",
  fields: [
    f("tag", "Tag", { editable: false }),
    f("description", "Description", { required: false }),
    f("firstSeen", "First Seen", { required: false, editable: false }),
    f("lastSeen", "Last Seen", { required: false, editable: false }),
    REGION_FIELD,
  ],
  outputs: [o("tag", "Tag")],
  pinnable: false,
  supportsUpdate: true,
  iconKey: "tag",
});

/** `GET /v5/accounts/subaccounts`. */
export const SubaccountResourceType = rt({
  name: "Subaccount",
  id: "mailgun-subaccount",
  description:
    "A subaccount of the primary account, with its own domains and custom sending limit. Enable or disable it, change its limit, or create and delete subaccounts.",
  fields: [
    f("name", "Name", { editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("monthlyLimit", "Custom Monthly Limit", {
      kind: "number",
      required: false,
      description: "A hard cap on messages per calendar month for this subaccount. 0 removes it.",
    }),
    f("monthlySent", "Sent This Month", { kind: "number", required: false, editable: false }),
    f("subaccountId", "Subaccount ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("subaccountId", "Subaccount ID")],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "users",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  AccountResourceType,
  DomainResourceType,
  DnsRecordResourceType,
  ApiKeyResourceType,
  WebhookResourceType,
  AccountWebhookResourceType,
  RouteResourceType,
  MailingListResourceType,
  SmtpCredentialResourceType,
  IpPoolResourceType,
  IpResourceType,
  TagResourceType,
  SubaccountResourceType,
];
