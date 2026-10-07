import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Okta resource types. Paths and fields verified against Okta's published
 * Management API spec (okta/okta-management-openapi-spec, 2026.09.1).
 */

const LIFECYCLE = ["ACTIVE", "INACTIVE"];

export const OrgResourceType = rt({
  name: "Okta Org",
  id: "org",
  description:
    "The Okta org these credentials manage: company details, support contacts, System Log, sign-in and rate-limit metrics, and rate-limit headroom.",
  accountRoot: true,
  fields: [
    f("companyName", "Company Name"),
    f("subdomain", "Subdomain", { required: false, editable: false }),
    f("orgUrl", "Org URL", { required: false, editable: false }),
    f("website", "Website", { required: false }),
    f("phoneNumber", "Phone", { required: false }),
    f("supportPhoneNumber", "Support Phone", { required: false }),
    f("endUserSupportHelpURL", "End-user Support URL", { required: false }),
    f("address1", "Address", { required: false }),
    f("city", "City", { required: false }),
    f("state", "State", { required: false }),
    f("postalCode", "Postal Code", { required: false }),
    f("country", "Country", { required: false }),
    f("status", "Status", { required: false, editable: false }),
    f("created", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("orgUrl", "Org URL", {
      description:
        "https://{subdomain}.okta.com, the issuer base for the org authorization server.",
    }),
    o("orgId", "Org ID"),
  ],
  supportsUpdate: true,
  supportsMetrics: true,
  pinnable: true,
  iconKey: "organization",
});

export const UserResourceType = rt({
  name: "User",
  id: "user",
  description:
    "An Okta user, with lifecycle actions (activate, suspend, unlock, reset password, sign out everywhere).",
  fields: [
    f("login", "Login", {
      description: "Usually the email address. Changing it changes how the user signs in.",
    }),
    f("email", "Email"),
    f("firstName", "First Name"),
    f("lastName", "Last Name"),
    f("displayName", "Display Name", { required: false }),
    f("title", "Title", { required: false }),
    f("department", "Department", { required: false }),
    f("mobilePhone", "Mobile Phone", { required: false }),
    f("status", "Status", { required: false, editable: false }),
    f("userId", "User ID", { required: false, editable: false }),
    f("lastLogin", "Last Sign-in", { required: false, editable: false }),
    f("passwordChanged", "Password Changed", { required: false, editable: false }),
    f("statusChanged", "Status Changed", { required: false, editable: false }),
    f("created", "Created", { required: false, editable: false }),
    f("groups", "Groups", { required: false, editable: false }),
  ],
  outputs: [o("userId", "User ID"), o("login", "Login")],
  principalRole: { role: "user", lastUsedKey: "lastLogin", createdKey: "created" },
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "user",
});

export const GroupResourceType = rt({
  name: "Group",
  id: "group",
  description:
    "An Okta group. Okta-mastered groups can be renamed and have members added or removed; app-imported groups are read-only.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("type", "Type", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: ["OKTA_GROUP", "APP_GROUP", "BUILT_IN"],
    }),
    f("memberCount", "Members", { kind: "number", required: false, editable: false }),
    f("appCount", "Apps", { kind: "number", required: false, editable: false }),
    f("lastMembershipUpdated", "Membership Changed", { required: false, editable: false }),
    f("created", "Created", { required: false, editable: false }),
  ],
  outputs: [o("groupId", "Group ID")],
  principalRole: { role: "group", createdKey: "created" },
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "users",
});

export const AppResourceType = rt({
  name: "Application",
  id: "app",
  description:
    "An app integration (SAML, OIDC, SWA, bookmark, API service). Rename, activate or deactivate, and assign groups.",
  fields: [
    f("label", "Label"),
    f("name", "App Name", { required: false, editable: false }),
    f("signOnMode", "Sign-on Mode", { required: false, editable: false }),
    f("status", "Status", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: LIFECYCLE,
    }),
    f("clientId", "Client ID", { required: false, editable: false }),
    f("features", "Provisioning Features", { required: false, editable: false }),
    f("created", "Created", { required: false, editable: false }),
    f("lastUpdated", "Updated", { required: false, editable: false }),
  ],
  outputs: [
    o("appId", "App ID"),
    o("clientId", "OAuth Client ID", { description: "Present for OIDC and API service apps." }),
    o("metadataUrl", "SAML Metadata URL", { description: "Present for SAML apps." }),
  ],
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "app",
});

export const AuthorizationServerResourceType = rt({
  name: "Authorization Server",
  id: "authorization-server",
  description:
    "A custom OAuth 2.0 authorization server with its audience, scopes, claims and access policies.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("audiences", "Audience", { description: "The `aud` claim of the access tokens it mints." }),
    f("issuer", "Issuer", { required: false, editable: false }),
    f("issuerMode", "Issuer Mode", {
      kind: "enum",
      required: false,
      enumValues: ["ORG_URL", "CUSTOM_URL", "DYNAMIC"],
    }),
    f("status", "Status", { required: false, editable: false }),
    f("rotationMode", "Key Rotation", { required: false, editable: false }),
    f("nextKeyRotation", "Next Key Rotation", { required: false, editable: false }),
    f("created", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("issuer", "Issuer URL"),
    o("authServerId", "Authorization Server ID"),
    o("metadataUrl", "Discovery URL", {
      description: "OpenID/OAuth metadata document for clients.",
    }),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "shield",
});

export const PolicyResourceType = rt({
  name: "Policy",
  id: "policy",
  plural: "Policies",
  description:
    "A sign-on, password, MFA enrollment, app sign-in, profile enrollment, IdP discovery or other org policy, with its rules.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("type", "Type", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("priority", "Priority", {
      kind: "number",
      required: false,
      description: "1 is evaluated first.",
    }),
    f("system", "System Policy", { kind: "boolean", required: false, editable: false }),
    f("created", "Created", { required: false, editable: false }),
    f("lastUpdated", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("policyId", "Policy ID")],
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "policy",
});

export const NetworkZoneResourceType = rt({
  name: "Network Zone",
  id: "network-zone",
  description:
    "An IP or dynamic (location, ASN, proxy) network zone used by policies and the IP blocklist.",
  fields: [
    f("name", "Name"),
    f("type", "Type", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: ["IP", "DYNAMIC", "DYNAMIC_V2"],
    }),
    f("usage", "Usage", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: ["POLICY", "BLOCKLIST"],
    }),
    f("status", "Status", { required: false, editable: false }),
    f("gateways", "Gateway IPs", {
      required: false,
      description:
        "IP zones: CIDRs or ranges (a.b.c.d-e.f.g.h), comma-separated. Replaces the whole list.",
    }),
    f("proxies", "Trusted Proxies", {
      required: false,
      description: "IP zones: CIDRs or ranges, comma-separated.",
    }),
    f("locations", "Locations", { required: false, editable: false }),
    f("asns", "ASNs", { required: false, editable: false }),
    f("system", "System Zone", { kind: "boolean", required: false, editable: false }),
    f("created", "Created", { required: false, editable: false }),
  ],
  outputs: [o("zoneId", "Zone ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "network",
});

export const ApiTokenResourceType = rt({
  name: "API Token",
  id: "api-token",
  description:
    "An SSWS API token. Tokens act as the admin who created them; revoke the ones nobody uses.",
  fields: [
    f("name", "Name", { editable: false }),
    f("userId", "Owner", { required: false, editable: false }),
    f("clientName", "Created From", { required: false, editable: false }),
    f("network", "Network Restriction", { required: false, editable: false }),
    f("tokenWindow", "Inactivity Window", { required: false, editable: false }),
    f("created", "Created", { required: false, editable: false }),
    f("expiresAt", "Expires", { required: false, editable: false }),
  ],
  outputs: [],
  expiryFields: [{ fieldKey: "expiresAt", from: "expiry", kind: "api-token", label: "API token" }],
  principalRole: { role: "key", createdKey: "created" },
  dependsOn: [{ fieldKey: "userId", targetTypeId: "user", label: "acts as" }],
  supportsDelete: true,
  iconKey: "key",
});

export const EventHookResourceType = rt({
  name: "Event Hook",
  id: "event-hook",
  description: "An outbound webhook Okta calls for selected System Log event types.",
  fields: [
    f("name", "Name"),
    f("uri", "Endpoint URL"),
    f("events", "Events", {
      description: "Event types, comma-separated, e.g. user.lifecycle.create.",
    }),
    f("status", "Status", { required: false, editable: false }),
    f("verificationStatus", "Verification", { required: false, editable: false }),
    f("authHeaderName", "Auth Header", { required: false }),
    f("authHeaderValue", "Auth Header Value", {
      kind: "password",
      required: false,
      description: "Write-only. Okta never returns it; leave blank to keep the current value.",
    }),
    f("description", "Description", { required: false }),
    f("created", "Created", { required: false, editable: false }),
  ],
  outputs: [o("eventHookId", "Event Hook ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "webhook",
});

export const DomainResourceType = rt({
  name: "Custom Domain",
  id: "domain",
  description:
    "A custom domain for the Okta-hosted sign-in page. Publish the TXT and CNAME records it lists, then verify.",
  fields: [
    f("domain", "Domain", { editable: false }),
    f("validationStatus", "Validation", { required: false, editable: false }),
    f("certificateSourceType", "Certificate", { required: false, editable: false }),
    f("certificateExpiration", "Certificate Expires", { required: false, editable: false }),
    f("certificateSubject", "Certificate Subject", { required: false, editable: false }),
    f("cnameTarget", "CNAME Target", { required: false, editable: false }),
    f("brandId", "Brand", { required: false, editable: false }),
  ],
  outputs: [o("domain", "Domain")],
  expiryFields: [
    {
      fieldKey: "certificateExpiration",
      from: "expiry",
      kind: "tls-cert",
      label: "Custom domain certificate",
    },
  ],
  dnsServiceHosts: [
    {
      id: "okta-custom-domain",
      label: "Okta custom domain",
      hostPattern: String.raw`([a-z0-9-]+)\.customdomains\.(?:okta|oktapreview|okta-emea)\.com`,
      labelIs: "opaque",
      hostKeys: ["cnameTarget"],
      reason:
        "Deleting the custom domain in Okta leaves the CNAME pointing at Okta's custom-domain edge, where another org could claim the hostname.",
    },
  ],
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "globe",
});

export const TrustedOriginResourceType = rt({
  name: "Trusted Origin",
  id: "trusted-origin",
  description:
    "An origin allowed to make CORS requests to Okta, receive redirects after sign-in, or embed Okta in an iframe.",
  fields: [
    f("name", "Name"),
    f("origin", "Origin", {
      description: "Scheme, host and optional port, e.g. https://app.example.com.",
    }),
    f("cors", "CORS", { kind: "boolean", required: false }),
    f("redirect", "Redirect", { kind: "boolean", required: false }),
    f("iframeEmbed", "Iframe Embed", { kind: "boolean", required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("created", "Created", { required: false, editable: false }),
  ],
  outputs: [o("origin", "Origin")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "link",
});

export const RESOURCE_TYPES = [
  OrgResourceType,
  UserResourceType,
  GroupResourceType,
  AppResourceType,
  AuthorizationServerResourceType,
  PolicyResourceType,
  NetworkZoneResourceType,
  ApiTokenResourceType,
  EventHookResourceType,
  DomainResourceType,
  TrustedOriginResourceType,
];
