import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Clerk resource types. Paths and fields verified against the Backend API
 * spec (github.com/clerk/openapi-specs, bapi/2026-05-12.yml).
 */

export const InstanceResourceType = rt({
  name: "Instance",
  id: "instance",
  description:
    "The Clerk instance this secret key belongs to (development or production): allowed origins, sign-up restrictions, organization settings, bot protection, webhooks and user counts.",
  accountRoot: true,
  fields: [
    f("instanceId", "Instance ID", { required: false, editable: false }),
    f("environmentType", "Environment", { required: false, editable: false }),
    f("allowedOrigins", "Allowed Origins", {
      required: false,
      description: "Comma-separated origins allowed to use the Frontend API.",
    }),
    f("supportEmail", "Support Email", {
      required: false,
      description: "Write-only: Clerk does not return it.",
    }),
    f("primaryDomain", "Primary Domain", { required: false, editable: false }),
    f("frontendApiUrl", "Frontend API URL", { required: false, editable: false }),
    f("userCount", "Users", { kind: "number", required: false, editable: false }),
    f("activeUsers30d", "Active Users (30 days)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("organizationsEnabled", "Organizations Enabled", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
  ],
  outputs: [
    o("frontendApiUrl", "Frontend API URL", {
      description: "The Clerk Frontend API host your app's publishable key points at.",
    }),
    o("instanceId", "Instance ID"),
  ],
  credentialFormats: [
    {
      id: "webhooks-dashboard",
      label: "Webhooks dashboard link",
      description:
        "A short-lived sign-in link to the Svix dashboard where this instance's webhook endpoints are managed.",
      mediaType: "text",
    },
  ],
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "settings",
});

export const UserResourceType = rt({
  name: "User",
  id: "user",
  description:
    "A Clerk user. Ban, lock, reset MFA, revoke sessions and manage organization memberships.",
  fields: [
    f("email", "Primary Email", { required: false, editable: false }),
    f("firstName", "First Name", { required: false }),
    f("lastName", "Last Name", { required: false }),
    f("username", "Username", { required: false }),
    f("externalId", "External ID", { required: false }),
    f("password", "Password", {
      kind: "password",
      required: false,
      description: "Write-only. Set a new password.",
    }),
    f("userId", "User ID", { required: false, editable: false }),
    f("banned", "Banned", { kind: "boolean", required: false, editable: false }),
    f("locked", "Locked", { kind: "boolean", required: false, editable: false }),
    f("twoFactorEnabled", "Two-factor", { kind: "boolean", required: false, editable: false }),
    f("signInMethods", "Sign-in Methods", { required: false, editable: false }),
    f("organizations", "Organizations", { required: false, editable: false }),
    f("lastSignInAt", "Last Sign-in", { required: false, editable: false }),
    f("lastActiveAt", "Last Active", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("userId", "User ID")],
  principalRole: {
    role: "user",
    lastUsedKey: "lastActiveAt",
    createdKey: "createdAt",
    mfaKey: "twoFactorEnabled",
  },
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "user",
});

export const OrganizationResourceType = rt({
  name: "Organization",
  id: "organization",
  description: "A Clerk organization with members, roles and invitations.",
  fields: [
    f("name", "Name"),
    f("slug", "Slug", { required: false }),
    f("maxAllowedMemberships", "Member Limit", {
      kind: "number",
      required: false,
      description: "0 means unlimited.",
    }),
    f("adminDeleteEnabled", "Admins Can Delete", { kind: "boolean", required: false }),
    f("membersCount", "Members", { kind: "number", required: false, editable: false }),
    f("pendingInvitations", "Pending Invitations", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("organizationId", "Organization ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("organizationId", "Organization ID"), o("slug", "Slug")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "users",
});

export const DomainResourceType = rt({
  name: "Domain",
  id: "domain",
  description:
    "The instance's primary domain or a satellite domain, with the DNS records Clerk needs.",
  fields: [
    f("name", "Domain", { editable: false }),
    f("isSatellite", "Satellite", { kind: "boolean", required: false, editable: false }),
    f("proxyUrl", "Proxy URL", {
      required: false,
      description: "Serve the Frontend API through your own proxy.",
    }),
    f("frontendApiUrl", "Frontend API URL", { required: false, editable: false }),
    f("accountsPortalUrl", "Account Portal", { required: false, editable: false }),
    f("dnsRecords", "DNS Records", { required: false, editable: false }),
  ],
  outputs: [o("frontendApiUrl", "Frontend API URL"), o("name", "Domain")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "globe",
});

export const JwtTemplateResourceType = rt({
  name: "JWT Template",
  id: "jwt-template",
  description:
    "A session-token template for third parties (Supabase, Hasura, Convex, your own API): claims, lifetime and signing.",
  fields: [
    f("name", "Name"),
    f("claims", "Claims (JSON)", {
      required: false,
      description: "Shortcodes like {{user.id}} are filled per session.",
    }),
    f("lifetime", "Lifetime (seconds)", { kind: "number", required: false }),
    f("allowedClockSkew", "Allowed Clock Skew (seconds)", { kind: "number", required: false }),
    f("signingAlgorithm", "Signing Algorithm", { required: false, editable: false }),
    f("customSigningKey", "Custom Signing Key", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("name", "Template Name", { description: "Pass to getToken({ template })." })],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "code",
});

export const OAuthApplicationResourceType = rt({
  name: "OAuth Application",
  id: "oauth-application",
  description: "An OAuth/OIDC application that uses Clerk as its identity provider.",
  fields: [
    f("name", "Name"),
    f("clientId", "Client ID", { required: false, editable: false }),
    f("redirectUris", "Redirect URIs", { required: false, description: "Comma-separated." }),
    f("scopes", "Scopes", { required: false, description: "Space-separated, e.g. profile email." }),
    f("public", "Public Client", { kind: "boolean", required: false, editable: false }),
    f("consentScreenEnabled", "Consent Screen", { kind: "boolean", required: false }),
    f("pkceRequired", "PKCE Required", { kind: "boolean", required: false }),
    f("discoveryUrl", "Discovery URL", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("clientId", "Client ID"), o("discoveryUrl", "Discovery URL")],
  credentialFormats: [
    {
      id: "rotate-secret",
      label: "New client secret (rotates the current one)",
      description:
        "Clerk only shows a client secret when it is created, so this rotates it and shows the new one once.",
      mediaType: "text",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "app",
});

export const EnterpriseConnectionResourceType = rt({
  name: "Enterprise Connection",
  id: "enterprise-connection",
  description:
    "A SAML or OIDC enterprise SSO connection (Okta, Entra ID, Google Workspace, custom) for one or more email domains.",
  fields: [
    f("name", "Name"),
    f("provider", "Provider", { required: false, editable: false }),
    f("domains", "Domains", {
      required: false,
      description: "Comma-separated email domains routed to this connection.",
    }),
    f("active", "Active", { kind: "boolean", required: false }),
    f("syncUserAttributes", "Sync User Attributes", { kind: "boolean", required: false }),
    f("organizationId", "Organization", { required: false, editable: false }),
    f("acsUrl", "ACS URL", { required: false, editable: false }),
    f("spEntityId", "SP Entity ID", { required: false, editable: false }),
    f("spMetadataUrl", "SP Metadata URL", { required: false, editable: false }),
    f("idpCertificateExpiresAt", "IdP Certificate Expires", { required: false, editable: false }),
  ],
  outputs: [
    o("acsUrl", "ACS URL"),
    o("spEntityId", "SP Entity ID"),
    o("spMetadataUrl", "SP Metadata URL"),
  ],
  dependsOn: [{ fieldKey: "organizationId", targetTypeId: "organization", label: "for" }],
  expiryFields: [
    {
      fieldKey: "idpCertificateExpiresAt",
      from: "expiry",
      kind: "tls-cert",
      label: "IdP signing certificate",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "shield",
});

export const MachineResourceType = rt({
  name: "Machine",
  id: "machine",
  description:
    "A machine identity for machine-to-machine tokens, with the other machines it may call.",
  fields: [
    f("name", "Name"),
    f("defaultTokenTtl", "Default Token TTL (seconds)", { kind: "number", required: false }),
    f("scopedMachines", "Can Call", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("machineId", "Machine ID"),
    o("secretKey", "Machine Secret Key", { sensitive: true }),
  ],
  credentialFormats: [
    {
      id: "rotate-secret-grace",
      label: "Rotate secret key (old key valid 1 hour)",
      description:
        "Issues a new secret key; the previous one keeps working for an hour so deployments can roll over.",
      mediaType: "text",
    },
    {
      id: "rotate-secret-now",
      label: "Rotate secret key now",
      description: "Issues a new secret key and revokes the previous one immediately.",
      mediaType: "text",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "robot",
});

export const AllowlistIdentifierResourceType = rt({
  name: "Allowlist Entry",
  id: "allowlist-identifier",
  plural: "Allowlist",
  description:
    "An email, domain (*@example.com), phone number or wallet allowed to sign up when the allowlist is on.",
  fields: [
    f("identifier", "Identifier", { editable: false }),
    f("identifierType", "Type", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "check",
});

export const BlocklistIdentifierResourceType = rt({
  name: "Blocklist Entry",
  id: "blocklist-identifier",
  plural: "Blocklist",
  description:
    "An email, domain, phone number or wallet blocked from signing up or in when the blocklist is on.",
  fields: [
    f("identifier", "Identifier", { editable: false }),
    f("identifierType", "Type", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "block",
});

export const InvitationResourceType = rt({
  name: "Invitation",
  id: "invitation",
  description: "A pending invitation to sign up to the application.",
  fields: [
    f("email", "Email", { editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("url", "Invitation URL", { required: false, editable: false }),
    f("expiresAt", "Expires", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "mail",
});

export const RedirectUrlResourceType = rt({
  name: "Redirect URL",
  id: "redirect-url",
  description: "A whitelisted redirect URL for native and mobile OAuth flows.",
  fields: [
    f("url", "URL", { editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("url", "URL")],
  supportsCreate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "link",
});

export const RESOURCE_TYPES = [
  InstanceResourceType,
  UserResourceType,
  OrganizationResourceType,
  DomainResourceType,
  JwtTemplateResourceType,
  OAuthApplicationResourceType,
  EnterpriseConnectionResourceType,
  MachineResourceType,
  AllowlistIdentifierResourceType,
  BlocklistIdentifierResourceType,
  InvitationResourceType,
  RedirectUrlResourceType,
];
