import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Fastly resource types. Field names follow the API models in Fastly's
 * published OpenAPI clients (2026-10); each type names the endpoint it lists
 * from. Children of a service are read from the service's active version (or
 * its newest version when none is active), because that is the configuration
 * actually serving traffic.
 */

/** `GET /current_customer`, `/current_user`, `/tokens/self` and the billing API. */
export const AccountResourceType = rt({
  name: "Fastly Account",
  id: "account",
  description:
    "The Fastly customer account the token belongs to. Shows the month-to-date bill by product, recent invoices, billable usage and account-wide traffic, and purges a URL from any service.",
  fields: [
    f("name", "Name", { editable: false }),
    f("customerId", "Customer ID", { required: false, editable: false }),
    f("pricingPlan", "Pricing Plan", { required: false, editable: false }),
    f("monthToDate", "Month-to-Date Bill", { kind: "number", required: false, editable: false }),
    f("currency", "Currency", { required: false, editable: false }),
    f("serviceCount", "Services", { kind: "number", required: false, editable: false }),
    f("userLogin", "Token Owner", { required: false, editable: false }),
    f("userRole", "Owner Role", { required: false, editable: false }),
    f("tokenScope", "Token Scope", { required: false, editable: false }),
  ],
  outputs: [o("customerId", "Customer ID")],
  accountRoot: true,
  supportsMetrics: true,
  supportsDelete: false,
  iconKey: "account",
});

/** `GET /service` (paged), enriched from `GET /service/{id}/details`. */
export const ServiceResourceType = rt({
  name: "Service",
  id: "service",
  description:
    "A Fastly delivery (VCL) or Compute service. Charts requests, bandwidth, cache hit ratio, errors and product usage, shows live traffic, purges by URL, surrogate key or everything, manages versions, and toggles products such as Image Optimizer and Next-Gen WAF.",
  fields: [
    f("name", "Name", { description: "The service's display name." }),
    f("comment", "Comment", { required: false, description: "A freeform note." }),
    f("type", "Type", {
      kind: "enum",
      enumValues: ["vcl", "wasm"],
      required: false,
      editable: false,
      description: "vcl is a delivery service; wasm is a Compute service.",
    }),
    f("activeVersion", "Active Version", { kind: "number", required: false, editable: false }),
    f("latestVersion", "Latest Version", { kind: "number", required: false, editable: false }),
    f("versionCount", "Versions", { kind: "number", required: false, editable: false }),
    f("domains", "Domains", { required: false, editable: false }),
    f("backendCount", "Backends", { kind: "number", required: false, editable: false }),
    f("products", "Products", { required: false, editable: false }),
    f("paused", "Paused", { kind: "boolean", required: false, editable: false }),
    f("serviceId", "Service ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("serviceId", "Service ID"), o("domain", "Primary Domain")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "cache",
});

/** `versions` on `GET /service/{id}/details`. */
export const ServiceVersionResourceType = rt({
  name: "Service Version",
  id: "service-version",
  description:
    "One configuration version of a Fastly service. Activate it, deactivate it, clone it into a new draft, lock it, validate it, or edit its comment.",
  fields: [
    f("comment", "Comment", { required: false }),
    f("number", "Number", { kind: "number", required: false, editable: false }),
    f("active", "Active", { kind: "boolean", required: false, editable: false }),
    f("locked", "Locked", { kind: "boolean", required: false, editable: false }),
    f("serviceName", "Service", { required: false, editable: false }),
    f("serviceId", "Service ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("number", "Version Number")],
  parentTypeId: "service",
  supportsUpdate: true,
  supportsDelete: false,
  pinnable: false,
  iconKey: "layers",
});

/** `domains` on the active version of `GET /service/{id}/details`. */
export const DomainResourceType = rt({
  name: "Domain",
  id: "domain",
  description: "A hostname a Fastly service answers for, on the service's active version.",
  fields: [
    f("name", "Domain", { editable: false }),
    f("comment", "Comment", { required: false, editable: false }),
    f("serviceName", "Service", { required: false, editable: false }),
    f("serviceId", "Service ID", { required: false, editable: false }),
    f("version", "Version", { kind: "number", required: false, editable: false }),
  ],
  outputs: [o("name", "Domain")],
  parentTypeId: "service",
  showInSidebar: true,
  supportsDelete: false,
  iconKey: "dns",
});

/** `backends` on the active version of `GET /service/{id}/details`. */
export const BackendResourceType = rt({
  name: "Backend",
  id: "backend",
  description:
    "An origin server a Fastly service fetches from: its address, TLS settings, shielding POP, health check and timeouts.",
  fields: [
    f("name", "Name", { editable: false }),
    f("address", "Address", { required: false, editable: false }),
    f("port", "Port", { kind: "number", required: false, editable: false }),
    f("useSsl", "TLS to Origin", { kind: "boolean", required: false, editable: false }),
    f("sslCheckCert", "Verify Certificate", { kind: "boolean", required: false, editable: false }),
    f("sslCertHostname", "Certificate Hostname", { required: false, editable: false }),
    f("sslSniHostname", "SNI Hostname", { required: false, editable: false }),
    f("overrideHost", "Override Host", { required: false, editable: false }),
    f("shield", "Shield POP", { required: false, editable: false }),
    f("healthcheck", "Health Check", { required: false, editable: false }),
    f("connectTimeout", "Connect Timeout (ms)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("firstByteTimeout", "First Byte Timeout (ms)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("betweenBytesTimeout", "Between Bytes Timeout (ms)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("maxConn", "Max Connections", { kind: "number", required: false, editable: false }),
    f("weight", "Weight", { kind: "number", required: false, editable: false }),
    f("autoLoadbalance", "Auto Load Balance", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("minTlsVersion", "Minimum TLS", { required: false, editable: false }),
    f("serviceName", "Service", { required: false, editable: false }),
    f("serviceId", "Service ID", { required: false, editable: false }),
    f("version", "Version", { kind: "number", required: false, editable: false }),
  ],
  outputs: [o("address", "Address")],
  parentTypeId: "service",
  showInSidebar: true,
  supportsDelete: false,
  postureChecks: [
    {
      id: "fastly-backend-plaintext",
      title: "Origin traffic is not encrypted",
      severity: "medium",
      category: "encryption",
      conditions: [{ fieldKey: "useSsl", when: "falsy" }],
      reason:
        "This backend does not use TLS, so requests from Fastly to your origin cross the internet in plain text. Enable Use TLS on the backend and serve HTTPS at the origin.",
    },
    {
      id: "fastly-backend-cert-unverified",
      title: "Origin certificate is not verified",
      severity: "medium",
      category: "encryption",
      conditions: [
        { fieldKey: "useSsl", when: "truthy" },
        { fieldKey: "sslCheckCert", when: "falsy" },
      ],
      reason:
        "Fastly connects to this origin over TLS but accepts any certificate, so a man in the middle could impersonate the origin. Turn on certificate verification and set the certificate hostname.",
    },
  ],
  iconKey: "server",
});

/** `/service/{id}/version/{v}/logging/{type}` for every logging type. */
export const LoggingEndpointResourceType = rt({
  name: "Logging Endpoint",
  id: "logging-endpoint",
  description:
    "A real-time log streaming destination on a Fastly service: where the logs go, the log format and the condition that gates them.",
  fields: [
    f("name", "Name", { editable: false }),
    f("kind", "Destination Type", { required: false, editable: false }),
    f("destination", "Destination", { required: false, editable: false }),
    f("format", "Format", { required: false, editable: false }),
    f("formatVersion", "Format Version", { required: false, editable: false }),
    f("placement", "Placement", { required: false, editable: false }),
    f("responseCondition", "Condition", { required: false, editable: false }),
    f("serviceName", "Service", { required: false, editable: false }),
    f("serviceId", "Service ID", { required: false, editable: false }),
    f("version", "Version", { kind: "number", required: false, editable: false }),
  ],
  parentTypeId: "service",
  showInSidebar: true,
  supportsDelete: false,
  iconKey: "logs",
});

/** `GET /service/{id}/version/{v}/dictionary`; items via `/dictionary/{id}/items`. */
export const DictionaryResourceType = rt({
  name: "Edge Dictionary",
  plural: "Edge Dictionaries",
  id: "dictionary",
  description:
    "A key-value table attached to a VCL service. Browse, add, change and remove its items without a new service version; items of a write-only dictionary can be written but not read back.",
  fields: [
    f("name", "Name", { editable: false }),
    f("writeOnly", "Write-Only", { kind: "boolean", required: false, editable: false }),
    f("itemCount", "Items", { kind: "number", required: false, editable: false }),
    f("serviceName", "Service", { required: false, editable: false }),
    f("serviceId", "Service ID", { required: false, editable: false }),
    f("dictionaryId", "Dictionary ID", { required: false, editable: false }),
    f("version", "Version", { kind: "number", required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("dictionaryId", "Dictionary ID")],
  parentTypeId: "service",
  showInSidebar: true,
  supportsDelete: false,
  iconKey: "database",
});

/** `GET /resources/stores/kv`. */
export const KvStoreResourceType = rt({
  name: "KV Store",
  id: "kv-store",
  description:
    "A Fastly KV Store for Compute. Browse, read, write and delete keys, create new stores and delete empty ones.",
  fields: [
    f("name", "Name", { editable: false }),
    f("storeId", "Store ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("storeId", "Store ID")],
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "database",
});

/** `GET /resources/stores/config`. */
export const ConfigStoreResourceType = rt({
  name: "Config Store",
  id: "config-store",
  description:
    "A Fastly Config Store: small configuration values your services read at the edge. Browse and edit its items, rename it, see which services use it, create and delete stores.",
  fields: [
    f("name", "Name", { description: "Letters, digits, dashes and underscores." }),
    f("storeId", "Store ID", { required: false, editable: false }),
    f("itemCount", "Items", { kind: "number", required: false, editable: false }),
    f("services", "Linked Services", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("storeId", "Store ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "sliders",
});

/** `GET /resources/stores/secret`. Secret values are never readable. */
export const SecretStoreResourceType = rt({
  name: "Secret Store",
  id: "secret-store",
  description:
    "A Fastly Secret Store for credentials your Compute services read at the edge. Values are write-only in Fastly, so only the store is listed.",
  fields: [
    f("name", "Name", { editable: false }),
    f("storeId", "Store ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("storeId", "Store ID")],
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "secret",
});

/** `GET /tls/certificates` (custom certificates you uploaded). */
export const TlsCertificateResourceType = rt({
  name: "TLS Certificate",
  id: "tls-certificate",
  description:
    "A custom TLS certificate uploaded to Fastly: who it is issued to, by whom, the domains it covers and when it expires.",
  fields: [
    f("name", "Name", { required: false, editable: false }),
    f("issuedTo", "Issued To", { required: false, editable: false }),
    f("issuer", "Issuer", { required: false, editable: false }),
    f("domains", "Domains", { required: false, editable: false }),
    f("notBefore", "Valid From", { required: false, editable: false }),
    f("notAfter", "Expires", { required: false, editable: false }),
    f("serialNumber", "Serial Number", { required: false, editable: false }),
    f("signatureAlgorithm", "Signature Algorithm", { required: false, editable: false }),
    f("replace", "Rotation Recommended", { kind: "boolean", required: false, editable: false }),
    f("createdAt", "Uploaded", { required: false, editable: false }),
  ],
  outputs: [o("certificateId", "Certificate ID")],
  expiryFields: [
    { fieldKey: "notAfter", from: "expiry", kind: "tls-cert", label: "Certificate expires" },
  ],
  postureChecks: [
    {
      id: "fastly-tls-key-rotation",
      title: "Fastly recommends rotating this certificate's key",
      severity: "medium",
      category: "credential-age",
      conditions: [{ fieldKey: "replace", when: "truthy" }],
      reason:
        "Fastly flags this certificate's private key as due for rotation. Issue a new certificate with a new key and upload it in place of this one.",
    },
  ],
  supportsDelete: true,
  iconKey: "certificate",
});

/** `GET /tls/subscriptions?include=tls_certificates` (Fastly-managed certificates). */
export const TlsSubscriptionResourceType = rt({
  name: "TLS Subscription",
  id: "tls-subscription",
  description:
    "A Fastly-managed certificate subscription (Let's Encrypt, Certainly or GlobalSign): its domains, state and certificate expiry. Fastly renews it while the domains stay pointed at Fastly.",
  fields: [
    f("commonName", "Common Name", { required: false, editable: false }),
    f("domains", "Domains", { required: false, editable: false }),
    f("certificateAuthority", "Certificate Authority", { required: false, editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("hasActiveOrder", "Order In Progress", { kind: "boolean", required: false, editable: false }),
    f("notAfter", "Certificate Expires", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("subscriptionId", "Subscription ID")],
  expiryFields: [
    {
      fieldKey: "notAfter",
      from: "expiry",
      kind: "tls-cert",
      label: "Managed certificate expires",
    },
  ],
  supportsDelete: true,
  iconKey: "certificate",
});

/** `GET /tokens` (the token owner's own API tokens). */
export const ApiTokenResourceType = rt({
  name: "API Token",
  id: "api-token",
  description:
    "An API token of the user this account authenticates as: its scope, service limits, last use and expiry. Revoke tokens you no longer need.",
  fields: [
    f("name", "Name", { editable: false }),
    f("scope", "Scope", { required: false, editable: false }),
    f("services", "Limited To Services", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("lastUsedAt", "Last Used", { required: false, editable: false }),
    f("expiresAt", "Expires", { required: false, editable: false }),
    f("lastIp", "Last Used From", { required: false, editable: false }),
    f("current", "Used By This Account", { kind: "boolean", required: false, editable: false }),
  ],
  outputs: [o("tokenId", "Token ID")],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "api-token", label: "Token expires" },
  ],
  postureChecks: [
    {
      id: "fastly-token-no-expiry-global",
      title: "Global API token never expires",
      severity: "low",
      category: "credential-age",
      conditions: [
        { fieldKey: "scope", when: "equals", value: "global" },
        { fieldKey: "expiresAt", when: "empty" },
      ],
      reason:
        "This token can change any configuration its owner can and never expires. Use an expiry and the narrowest scope that works (global:read to read, purge_select to purge).",
    },
  ],
  principalRole: {
    role: "key",
    lastUsedKey: "lastUsedAt",
    createdKey: "createdAt",
    adminIndicatorKey: "scope",
    adminValues: ["global"],
    revokeActionId: "revoke",
  },
  supportsDelete: false,
  iconKey: "key",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  AccountResourceType,
  ServiceResourceType,
  ServiceVersionResourceType,
  DomainResourceType,
  BackendResourceType,
  LoggingEndpointResourceType,
  DictionaryResourceType,
  KvStoreResourceType,
  ConfigStoreResourceType,
  SecretStoreResourceType,
  TlsCertificateResourceType,
  TlsSubscriptionResourceType,
  ApiTokenResourceType,
];
