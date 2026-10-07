import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Auth0 resource types. Paths and fields verified against Auth0's published
 * Management API v2 OpenAPI document (2026-10).
 */

export const TenantResourceType = rt({
  name: "Tenant",
  id: "tenant",
  description:
    "The Auth0 tenant these credentials manage: settings, Universal Login branding, attack protection, logs, daily sign-in stats and rate-limit headroom.",
  accountRoot: true,
  fields: [
    f("friendlyName", "Friendly Name", {
      description: "Shown on the Universal Login page and in emails.",
    }),
    f("domain", "Domain", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("supportEmail", "Support Email", { required: false }),
    f("supportUrl", "Support URL", { required: false }),
    f("pictureUrl", "Logo URL (tenant)", { required: false }),
    f("defaultAudience", "Default Audience", { required: false }),
    f("defaultDirectory", "Default Directory", {
      required: false,
      description: "Connection used for the password grant when none is given.",
    }),
    f("sessionLifetime", "Session Lifetime (hours)", { kind: "number", required: false }),
    f("idleSessionLifetime", "Idle Session Lifetime (hours)", { kind: "number", required: false }),
    f("enabledLocales", "Enabled Locales", {
      required: false,
      description: "Comma-separated, first is the default.",
    }),
    f("sandboxVersion", "Node Runtime", { required: false, editable: false }),
    f("brandPrimaryColor", "Brand Primary Color", {
      required: false,
      description: "Hex, e.g. #0059d6.",
    }),
    f("brandBackgroundColor", "Brand Page Background", {
      required: false,
      description: "Hex, e.g. #000000.",
    }),
    f("brandLogoUrl", "Brand Logo URL", { required: false }),
    f("brandFaviconUrl", "Brand Favicon URL", { required: false }),
    f("activeUsers", "Active Users (30 days)", {
      kind: "number",
      required: false,
      editable: false,
    }),
  ],
  outputs: [
    o("domain", "Tenant Domain"),
    o("issuer", "Issuer URL", {
      description: "https://{domain}/, the `iss` of tokens this tenant mints.",
    }),
    o("jwksUrl", "JWKS URL"),
  ],
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "organization",
});

export const ApplicationResourceType = rt({
  name: "Application",
  id: "application",
  description: "An Auth0 application (client): SPA, regular web, native or machine-to-machine.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("appType", "Type", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: ["spa", "regular_web", "native", "non_interactive"],
    }),
    f("clientId", "Client ID", { required: false, editable: false }),
    f("callbacks", "Allowed Callback URLs", { required: false, description: "Comma-separated." }),
    f("allowedLogoutUrls", "Allowed Logout URLs", {
      required: false,
      description: "Comma-separated.",
    }),
    f("webOrigins", "Allowed Web Origins", { required: false, description: "Comma-separated." }),
    f("allowedOrigins", "Allowed Origins (CORS)", {
      required: false,
      description: "Comma-separated.",
    }),
    f("grantTypes", "Grant Types", { required: false, editable: false }),
    f("tokenEndpointAuthMethod", "Token Endpoint Auth", { required: false, editable: false }),
    f("isFirstParty", "First Party", { kind: "boolean", required: false, editable: false }),
    f("initiateLoginUri", "Initiate Login URI", { required: false }),
    f("logoUri", "Logo URL", { required: false }),
  ],
  outputs: [
    o("clientId", "Client ID"),
    o("clientSecret", "Client Secret", { sensitive: true }),
    o("domain", "Auth0 Domain"),
  ],
  secretExportTemplates: [
    {
      id: "auth0-nextjs",
      displayName: "Auth0 Next.js SDK",
      entries: [
        { envKey: "AUTH0_DOMAIN", outputKey: "domain" },
        { envKey: "AUTH0_CLIENT_ID", outputKey: "clientId" },
        { envKey: "AUTH0_CLIENT_SECRET", outputKey: "clientSecret" },
      ],
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "app",
});

export const ApiResourceType = rt({
  name: "API",
  id: "api",
  plural: "APIs",
  description:
    "An API (resource server) whose identifier is the `audience` of the access tokens Auth0 mints for it.",
  fields: [
    f("name", "Name"),
    f("identifier", "Identifier", {
      editable: false,
      description: "The audience. Cannot change after creation.",
    }),
    f("signingAlg", "Signing Algorithm", {
      kind: "enum",
      required: false,
      enumValues: ["RS256", "HS256", "PS256"],
    }),
    f("tokenLifetime", "Token Lifetime (seconds)", { kind: "number", required: false }),
    f("tokenLifetimeForWeb", "Token Lifetime for SPAs (seconds)", {
      kind: "number",
      required: false,
    }),
    f("allowOfflineAccess", "Allow Offline Access", { kind: "boolean", required: false }),
    f("skipConsent", "Skip Consent for First-party Apps", { kind: "boolean", required: false }),
    f("enforcePolicies", "RBAC Enabled", { kind: "boolean", required: false }),
    f("tokenDialect", "Token Dialect", {
      kind: "enum",
      required: false,
      enumValues: [
        "access_token",
        "access_token_authz",
        "rfc9068_profile",
        "rfc9068_profile_authz",
      ],
    }),
    f("scopes", "Permissions", { required: false, editable: false }),
    f("isSystem", "System API", { kind: "boolean", required: false, editable: false }),
  ],
  outputs: [o("identifier", "Audience"), o("apiId", "API ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "api",
});

export const ConnectionResourceType = rt({
  name: "Connection",
  id: "connection",
  description:
    "An identity source: a database, social provider, or enterprise (SAML, OIDC, Azure AD, Google Workspace) connection.",
  fields: [
    f("name", "Name", { editable: false }),
    f("displayName", "Display Name", { required: false }),
    f("strategy", "Strategy", { required: false, editable: false }),
    f("enabledClients", "Enabled Applications", { required: false, editable: false }),
    f("isDomainConnection", "Domain Connection", { kind: "boolean", required: false }),
    f("showAsButton", "Show as Button", { kind: "boolean", required: false }),
    f("realms", "Realms", { required: false, editable: false }),
  ],
  outputs: [o("connectionId", "Connection ID"), o("name", "Connection Name")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "plug",
});

export const UserResourceType = rt({
  name: "User",
  id: "user",
  description:
    "An Auth0 user. Block or unblock, resend verification, reset password, manage roles, and read the user's log.",
  fields: [
    f("email", "Email"),
    f("name", "Name", { required: false }),
    f("nickname", "Nickname", { required: false }),
    f("emailVerified", "Email Verified", { kind: "boolean", required: false }),
    f("blocked", "Blocked", { kind: "boolean", required: false }),
    f("connection", "Connection", { required: false, editable: false }),
    f("userId", "User ID", { required: false, editable: false }),
    f("loginsCount", "Logins", { kind: "number", required: false, editable: false }),
    f("lastLogin", "Last Login", { required: false, editable: false }),
    f("lastIp", "Last IP", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("userId", "User ID")],
  credentialFormats: [
    {
      id: "password-reset-link",
      label: "Password reset link",
      description:
        "A one-time link (valid 24 hours) the user opens to set a new password. Database connections only.",
      mediaType: "text",
    },
  ],
  principalRole: { role: "user", lastUsedKey: "lastLogin", createdKey: "createdAt" },
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "user",
});

export const RoleResourceType = rt({
  name: "Role",
  id: "role",
  description:
    "An RBAC role: a named set of API permissions assignable to users and organization members.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("permissions", "Permissions", { required: false, editable: false }),
  ],
  outputs: [o("roleId", "Role ID")],
  principalRole: { role: "role" },
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "shield",
});

export const OrganizationResourceType = rt({
  name: "Organization",
  id: "organization",
  description:
    "A B2B organization with its own members, enabled connections, invitations and login branding.",
  fields: [
    f("name", "Name", {
      description: "Lowercase identifier used in the `organization` login parameter.",
    }),
    f("displayName", "Display Name", { required: false }),
    f("logoUrl", "Logo URL", { required: false }),
    f("primaryColor", "Primary Color", { required: false }),
    f("backgroundColor", "Page Background", { required: false }),
    f("organizationId", "Organization ID", { required: false, editable: false }),
  ],
  outputs: [o("organizationId", "Organization ID"), o("name", "Organization Name")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "users",
});

export const ActionResourceType = rt({
  name: "Action",
  id: "action",
  description:
    "A Node.js Action bound to a trigger (post-login, pre-registration, M2M token exchange, ...). Edit code, deploy, and bind it to its flow.",
  fields: [
    f("name", "Name"),
    f("trigger", "Trigger", { required: false, editable: false }),
    f("runtime", "Runtime", { kind: "enum", required: false, enumValues: ["node18", "node22"] }),
    f("status", "Build Status", { required: false, editable: false }),
    f("deployed", "Deployed", { kind: "boolean", required: false, editable: false }),
    f("allChangesDeployed", "All Changes Deployed", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("bound", "In Flow", { kind: "boolean", required: false, editable: false }),
    f("dependencies", "Dependencies", { required: false, editable: false }),
    f("secrets", "Secrets", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("actionId", "Action ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "function",
});

export const LogStreamResourceType = rt({
  name: "Log Stream",
  id: "log-stream",
  description:
    "Streams tenant logs to an HTTP endpoint, Datadog, Splunk, Sumo Logic, AWS EventBridge, Azure Event Grid, Segment or Mixpanel.",
  fields: [
    f("name", "Name"),
    f("type", "Destination", { required: false, editable: false }),
    f("status", "Status", {
      kind: "enum",
      required: false,
      enumValues: ["active", "paused", "suspended"],
    }),
    f("target", "Target", { required: false, editable: false }),
    f("filters", "Filters", { required: false, editable: false }),
    f("isPriority", "Priority Stream", { kind: "boolean", required: false, editable: false }),
  ],
  outputs: [o("logStreamId", "Log Stream ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "logs",
});

export const CustomDomainResourceType = rt({
  name: "Custom Domain",
  id: "custom-domain",
  description:
    "A custom login domain. Publish the verification record it lists, verify, and point a CNAME at the origin domain.",
  fields: [
    f("domain", "Domain", { editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("type", "Certificates", { required: false, editable: false }),
    f("primary", "Primary", { kind: "boolean", required: false, editable: false }),
    f("originDomainName", "CNAME Target", { required: false, editable: false }),
    f("verificationStatus", "Verification", { required: false, editable: false }),
    f("certificateStatus", "Certificate", { required: false, editable: false }),
    f("certificateRenewsBefore", "Certificate Renews Before", { required: false, editable: false }),
    f("tlsPolicy", "TLS Policy", { kind: "enum", required: false, enumValues: ["recommended"] }),
    f("customClientIpHeader", "Client IP Header", {
      kind: "enum",
      required: false,
      enumValues: ["", "true-client-ip", "cf-connecting-ip", "x-forwarded-for", "x-azure-clientip"],
      description:
        "Self-managed certificates behind a proxy: which header carries the real client IP.",
    }),
  ],
  outputs: [o("domain", "Domain"), o("originDomainName", "CNAME Target")],
  expiryFields: [
    {
      fieldKey: "certificateRenewsBefore",
      from: "expiry",
      kind: "tls-cert",
      label: "Custom domain certificate",
    },
  ],
  dnsServiceHosts: [
    {
      id: "auth0-custom-domain",
      label: "Auth0 custom domain edge",
      hostPattern: String.raw`([a-z0-9_-]+)\.edge\.tenants(?:\.[a-z]{2})?\.auth0\.com`,
      labelIs: "opaque",
      hostKeys: ["originDomainName"],
      reason:
        "Deleting the custom domain in Auth0 leaves the CNAME pointing at Auth0's edge, where the hostname could be claimed by another tenant.",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "globe",
});

export const RESOURCE_TYPES = [
  TenantResourceType,
  ApplicationResourceType,
  ApiResourceType,
  ConnectionResourceType,
  UserResourceType,
  RoleResourceType,
  OrganizationResourceType,
  ActionResourceType,
  LogStreamResourceType,
  CustomDomainResourceType,
];
