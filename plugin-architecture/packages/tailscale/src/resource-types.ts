import { f, o, rt } from "@infrawrench/plugin-base";

// Leaf module: both plugin.ts (the registry entry) and client.ts (the detail
// view labels its fields from these definitions) import it, so it must not
// import either of them back.

/** User roles accepted by `POST /users/{userId}/role`. */
export const USER_ROLES = [
  "owner",
  "admin",
  "it-admin",
  "network-admin",
  "billing-admin",
  "auditor",
  "member",
];

/** Roles an invite can carry: every user role except owner. */
export const INVITE_ROLES = USER_ROLES.filter((role) => role !== "owner");

/** Events a webhook endpoint can subscribe to (spec enum, in documented order). */
export const WEBHOOK_EVENTS = [
  "nodeCreated",
  "nodeNeedsApproval",
  "nodeApproved",
  "nodeKeyExpiringInOneDay",
  "nodeKeyExpired",
  "nodeDeleted",
  "nodeSigned",
  "nodeNeedsSignature",
  "policyUpdate",
  "userCreated",
  "userNeedsApproval",
  "userSuspended",
  "userRestored",
  "userDeleted",
  "userApproved",
  "userRoleUpdated",
  "subnetIPForwardingNotEnabled",
  "exitNodeIPForwardingNotEnabled",
];

export const POSTURE_PROVIDERS = ["falcon", "intune", "jamfpro", "kandji", "kolide", "sentinelone"];

export const deviceType = rt({
  id: "device",
  name: "Device",
  description: "A device connected to your Tailscale network.",
  fields: [
    f("name", "DNS name", { editable: true }),
    f("hostname", "Hostname", { editable: false }),
    f("os", "Operating system", { editable: false }),
    f("distro", "Distribution", { required: false, editable: false }),
    f("user", "Owner", { editable: false }),
    f("addresses", "Addresses", { editable: false }),
    f("ipv4", "Tailscale IPv4", {
      required: false,
      description:
        "The device's 100.x.y.z address. Changing it breaks existing connections to the old address.",
    }),
    f("tags", "Tags", {
      required: false,
      description:
        "Comma-separated ACL tags, e.g. tag:server. Tagging a device removes its user ownership; tags must be defined in tagOwners.",
    }),
    f("authorized", "Approved", { kind: "boolean", editable: false }),
    f("connected", "Connected", { kind: "boolean", editable: false }),
    f("clientVersion", "Client version", { editable: false }),
    f("updateAvailable", "Update available", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("lastSeen", "Last seen", { editable: false }),
    f("created", "Added", { required: false, editable: false }),
    f("expires", "Key expires", {
      editable: false,
      description: "Empty when key expiry is disabled for this device.",
    }),
    f("keyExpiryDisabled", "Key expiry disabled", {
      kind: "boolean",
      description: "Turn on to stop this device's node key from expiring.",
    }),
    f("advertisedRoutes", "Advertised routes", {
      required: false,
      editable: false,
      description: "Subnet routes and exit-node routes the device offers.",
    }),
    f("enabledRoutes", "Approved routes", {
      required: false,
      description:
        "Comma-separated routes approved for this device. Only routes it advertises take effect; 0.0.0.0/0 and ::/0 together make it an exit node.",
    }),
    f("isEphemeral", "Ephemeral", { kind: "boolean", required: false, editable: false }),
    f("sshEnabled", "Tailscale SSH", { kind: "boolean", required: false, editable: false }),
    f("blocksIncomingConnections", "Shields up", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("multipleConnections", "Duplicate node key", {
      kind: "boolean",
      required: false,
      editable: false,
      description: "Several machines are connected with the same node key.",
    }),
    f("tailnetLockError", "Tailnet Lock error", { required: false, editable: false }),
  ],
  outputs: [o("ip", "Tailscale IP"), o("dnsName", "DNS name")],
  expiryFields: [{ fieldKey: "expires", from: "expiry", kind: "other", label: "Node key expires" }],
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  sshEndpoint: { hostOutputKey: "ip", defaultUsername: "root" },
});

export const userType = rt({
  id: "user",
  name: "User",
  description: "A person who belongs to the tailnet or has a device shared into it.",
  fields: [
    f("loginName", "Login name", { editable: false }),
    f("displayName", "Name", { required: false, editable: false }),
    f("role", "Role", {
      kind: "enum",
      enumValues: USER_ROLES,
      description: "Only the tailnet owner can grant or take away the owner role.",
    }),
    f("status", "Status", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: ["active", "idle", "suspended", "needs-approval", "over-billing-limit"],
    }),
    f("type", "Membership", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: ["member", "shared"],
    }),
    f("deviceCount", "Devices", { kind: "number", required: false, editable: false }),
    f("currentlyConnected", "Connected", { kind: "boolean", required: false, editable: false }),
    f("lastSeen", "Last seen", { required: false, editable: false }),
    f("created", "Joined", { required: false, editable: false }),
  ],
  outputs: [o("loginName", "Login name"), o("userId", "User ID")],
  principalRole: {
    role: "user",
    lastUsedKey: "lastSeen",
    createdKey: "created",
    adminIndicatorKey: "role",
    adminValues: ["owner", "admin", "it-admin", "network-admin"],
    revokeActionId: "suspend",
  },
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "user",
});

export const userInviteType = rt({
  id: "user-invite",
  name: "User invite",
  description: "An open invitation for someone to join the tailnet with a preassigned role.",
  fields: [
    f("email", "Email", { required: false, editable: false }),
    f("role", "Role", { kind: "enum", editable: false, enumValues: INVITE_ROLES }),
    f("lastEmailSentAt", "Last emailed", { required: false, editable: false }),
  ],
  outputs: [
    o("inviteUrl", "Invite link", {
      sensitive: true,
      description: "Anyone with this link can join the tailnet with the invite's role.",
    }),
  ],
  pinnable: false,
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "invite",
});

export const keyType = rt({
  id: "key",
  name: "Key",
  description:
    "An auth key, API access token, OAuth client, or federated identity. Auth keys and OAuth clients can be created here; deleting a key revokes it.",
  fields: [
    f("description", "Description", { required: false, editable: false }),
    f("keyType", "Type", {
      kind: "enum",
      editable: false,
      enumValues: ["auth", "client", "api", "federated"],
    }),
    f("reusable", "Reusable", { kind: "boolean", required: false, editable: false }),
    f("ephemeral", "Ephemeral", { kind: "boolean", required: false, editable: false }),
    f("preauthorized", "Pre-approved", { kind: "boolean", required: false, editable: false }),
    f("tags", "Tags", { required: false, editable: false }),
    f("scopes", "Scopes", { required: false, editable: false }),
    f("issuer", "OIDC issuer", { required: false, editable: false }),
    f("subject", "OIDC subject", { required: false, editable: false }),
    f("userId", "Created by", { required: false, editable: false }),
    f("created", "Created", { required: false, editable: false }),
    f("expires", "Expires", { required: false, editable: false }),
    f("revoked", "Revoked", { required: false, editable: false }),
    f("invalid", "Invalid", { kind: "boolean", required: false, editable: false }),
  ],
  outputs: [
    o("keyId", "Key ID"),
    o("key", "Key", {
      sensitive: true,
      description:
        "The secret, returned only when the key is created here. Tailscale never shows it again.",
    }),
  ],
  expiryFields: [{ fieldKey: "expires", from: "expiry", kind: "api-token", label: "Key expires" }],
  principalRole: {
    role: "key",
    createdKey: "created",
    adminIndicatorKey: "scopes",
    adminValues: ["all"],
  },
  pinnable: false,
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "key",
});

export const webhookType = rt({
  id: "webhook",
  name: "Webhook",
  description: "An endpoint Tailscale posts tailnet events to.",
  fields: [
    f("endpointUrl", "Endpoint URL", { editable: false }),
    f("providerType", "Format", { required: false, editable: false }),
    f("subscriptions", "Events", {
      description: `Comma-separated event names: ${WEBHOOK_EVENTS.join(", ")}.`,
    }),
    f("creatorLoginName", "Created by", { required: false, editable: false }),
    f("created", "Created", { required: false, editable: false }),
    f("lastModified", "Last modified", { required: false, editable: false }),
  ],
  outputs: [
    o("webhookId", "Webhook ID"),
    o("secret", "Signing secret", {
      sensitive: true,
      description: "Returned only when the webhook is created here; rotate it to see a new one.",
    }),
  ],
  credentialFormats: [
    {
      id: "rotate-secret",
      label: "Rotate signing secret",
      description:
        "Issues a new signing secret and shows it once. The previous secret stops verifying immediately.",
      mediaType: "text",
      filenameTemplate: "tailscale-webhook-{resource}.secret",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "webhook",
});

export const serviceType = rt({
  id: "service",
  name: "Service",
  description:
    "A Tailscale Service: a stable virtual IP and MagicDNS name served by one or more hosting devices.",
  fields: [
    f("name", "Name", { editable: false, description: "Always starts with svc:." }),
    f("displayName", "Display name", { required: false }),
    f("ports", "Ports", {
      required: false,
      description: "Comma-separated protocol:port pairs, e.g. tcp:443. Only TCP is supported.",
    }),
    f("tags", "Tags", {
      required: false,
      description: "Comma-separated tags. ACL grants and auto-approvers match on these.",
    }),
    f("comment", "Comment", { required: false }),
    f("addresses", "Addresses", { required: false, editable: false }),
  ],
  outputs: [o("ip", "Service IPv4"), o("serviceName", "Service name")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "service",
});

export const postureIntegrationType = rt({
  id: "posture-integration",
  name: "Posture integration",
  description:
    "A device posture provider (CrowdStrike Falcon, Intune, Jamf Pro, Kandji, Kolide, SentinelOne) that feeds attributes into access rules.",
  fields: [
    f("provider", "Provider", { kind: "enum", editable: false, enumValues: POSTURE_PROVIDERS }),
    f("cloudId", "Cloud", { required: false }),
    f("clientId", "Client ID", { required: false }),
    f("tenantId", "Tenant ID", { required: false }),
    f("clientSecret", "Client secret", {
      kind: "password",
      required: false,
      description: "Leave blank to keep the current secret.",
    }),
    f("lastSync", "Last sync", { required: false, editable: false }),
    f("syncError", "Sync error", { required: false, editable: false }),
    f("providerHostCount", "Devices at provider", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("matchedCount", "Matched devices", { kind: "number", required: false, editable: false }),
    f("configUpdated", "Configuration updated", { required: false, editable: false }),
  ],
  pinnable: false,
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "shield",
});

export const tailnetType = rt({
  id: "tailnet",
  name: "Tailnet",
  description:
    "Tailnet-wide settings, DNS, contacts, log streaming, and the configuration audit log.",
  fields: [
    f("devicesApprovalOn", "Device approval", { kind: "boolean", required: false }),
    f("devicesAutoUpdatesOn", "Auto-update clients", { kind: "boolean", required: false }),
    f("devicesKeyDurationDays", "Key expiry (days)", {
      kind: "number",
      required: false,
      description: "How long new node keys last before devices must reauthenticate (1 to 180).",
    }),
    f("usersApprovalOn", "User approval", { kind: "boolean", required: false }),
    f("usersRoleAllowedToJoinExternalTailnets", "Who can join other tailnets", {
      kind: "enum",
      required: false,
      enumValues: ["none", "admin", "member"],
    }),
    f("networkFlowLoggingOn", "Network flow logs", { kind: "boolean", required: false }),
    f("regionalRoutingOn", "Regional routing", { kind: "boolean", required: false }),
    f("postureIdentityCollectionOn", "Collect device identifiers", {
      kind: "boolean",
      required: false,
    }),
    f("httpsEnabled", "HTTPS certificates", { kind: "boolean", required: false }),
    f("aclsExternallyManagedOn", "Policy managed externally", {
      kind: "boolean",
      required: false,
      description: "Locks the policy editor in the admin console (for GitOps or Terraform).",
    }),
    f("aclsExternalLink", "External policy link", { required: false }),
    f("magicDNS", "MagicDNS", { kind: "boolean", required: false }),
    f("overrideLocalDNS", "Override local DNS", { kind: "boolean", required: false }),
    f("nameservers", "Global nameservers", {
      required: false,
      description: "Comma-separated resolver IPs.",
    }),
    f("searchPaths", "Search domains", { required: false, description: "Comma-separated." }),
    f("splitDNS", "Split DNS", { required: false, editable: false }),
    f("accountContact", "Account contact", { required: false, editable: false }),
    f("securityContact", "Security contact", { required: false, editable: false }),
    f("supportContact", "Support contact", { required: false, editable: false }),
  ],
  outputs: [o("dnsName", "MagicDNS suffix", { description: "e.g. tail1234.ts.net" })],
  pinnable: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "network",
});

export const resourceTypes = [
  tailnetType,
  deviceType,
  userType,
  userInviteType,
  keyType,
  webhookType,
  serviceType,
  postureIntegrationType,
];
