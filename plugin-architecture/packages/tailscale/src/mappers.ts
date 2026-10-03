import type { ResourceInstance } from "@infrawrench/plugin-base";
import type {
  Contact,
  Contacts,
  Device,
  DnsConfiguration,
  Key,
  PostureIntegration,
  Service,
  TailnetSettings,
  User,
  UserInvite,
  Webhook,
} from "./api.js";

/** Comma-joined list, the convention every list-valued field in this plugin uses. */
export function joinList(values: readonly string[] | undefined | null): string {
  return (values ?? []).join(", ");
}

/** Inverse of `joinList`: trims, drops blanks, keeps order. */
export function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: ResourceInstance["fields"],
  resolvedOutputs: Record<string, string>,
  createdAt?: string,
  updatedAt?: string,
): ResourceInstance {
  const now = new Date().toISOString();
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: "tailscale",
    resourceTypeId: typeId,
    accountId,
    displayName,
    externalId,
    fields,
    resolvedOutputs,
    secretStates: [],
    createdAt: createdAt || now,
    updatedAt: updatedAt || now,
  };
}

export function ipv4Of(addresses: readonly string[] | undefined): string {
  return (addresses ?? []).find((a) => !a.includes(":")) ?? "";
}

export function mapDevice(d: Device, accountId: string): ResourceInstance {
  const externalId = d.nodeId || d.id;
  const ipv4 = ipv4Of(d.addresses);
  const distro = [d.distro?.name, d.distro?.version].filter(Boolean).join(" ");
  return instance(
    accountId,
    "device",
    externalId,
    d.hostname || d.name,
    {
      name: d.name,
      hostname: d.hostname,
      os: d.os ?? "",
      distro,
      user: d.user ?? "",
      addresses: d.addresses.join(", "),
      ipv4,
      tags: joinList(d.tags),
      authorized: d.authorized ?? false,
      connected: d.connectedToControl ?? false,
      clientVersion: d.clientVersion ?? "",
      updateAvailable: d.updateAvailable ?? false,
      lastSeen: d.lastSeen ?? "",
      created: d.created ?? "",
      // A disabled expiry keeps its original timestamp server-side; showing it
      // would put a key that never expires on the expiry radar.
      expires: d.keyExpiryDisabled ? "" : (d.expires ?? ""),
      keyExpiryDisabled: d.keyExpiryDisabled ?? false,
      advertisedRoutes: joinList(d.advertisedRoutes),
      enabledRoutes: joinList(d.enabledRoutes),
      isEphemeral: d.isEphemeral ?? false,
      sshEnabled: d.sshEnabled ?? false,
      blocksIncomingConnections: d.blocksIncomingConnections ?? false,
      multipleConnections: d.multipleConnections ?? false,
      tailnetLockError: d.tailnetLockError ?? "",
    },
    { ip: ipv4 || d.addresses[0] || "", dnsName: d.name },
    d.created,
  );
}

export function mapUser(u: User, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "user",
    u.id,
    u.displayName || u.loginName || u.id,
    {
      loginName: u.loginName ?? "",
      displayName: u.displayName ?? "",
      role: u.role ?? "",
      status: u.status ?? "",
      type: u.type ?? "",
      deviceCount: u.deviceCount ?? 0,
      currentlyConnected: u.currentlyConnected ?? false,
      lastSeen: u.lastSeen ?? "",
      created: u.created ?? "",
    },
    { loginName: u.loginName ?? "", userId: u.id },
    u.created,
  );
}

export function mapUserInvite(i: UserInvite, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "user-invite",
    i.id,
    i.email || `Invite link (${i.role ?? "member"})`,
    { email: i.email ?? "", role: i.role ?? "", lastEmailSentAt: i.lastEmailSentAt ?? "" },
    { inviteUrl: i.inviteUrl ?? "" },
  );
}

export function mapKey(k: Key, accountId: string): ResourceInstance {
  const create = k.capabilities?.devices?.create;
  const tags = k.tags?.length ? k.tags : create?.tags;
  return instance(
    accountId,
    "key",
    k.id,
    k.description || k.id,
    {
      description: k.description ?? "",
      keyType: k.keyType ?? "auth",
      reusable: create?.reusable ?? false,
      ephemeral: create?.ephemeral ?? false,
      preauthorized: create?.preauthorized ?? false,
      tags: joinList(tags),
      scopes: joinList(k.scopes),
      issuer: k.issuer ?? "",
      subject: k.subject ?? "",
      userId: k.userId ?? "",
      created: k.created ?? "",
      // A revoked key is already dead; its old expiry would only be noise.
      expires: k.revoked || k.invalid ? "" : (k.expires ?? ""),
      revoked: k.revoked ?? "",
      invalid: k.invalid ?? false,
    },
    { keyId: k.id },
    k.created,
  );
}

export function mapWebhook(w: Webhook, accountId: string): ResourceInstance {
  let host = w.endpointUrl ?? "";
  try {
    host = new URL(host).host || host;
  } catch {
    // Keep the raw URL when it does not parse.
  }
  return instance(
    accountId,
    "webhook",
    w.endpointId,
    host || w.endpointId,
    {
      endpointUrl: w.endpointUrl ?? "",
      providerType: w.providerType ?? "",
      subscriptions: joinList(w.subscriptions),
      creatorLoginName: w.creatorLoginName ?? "",
      created: w.created ?? "",
      lastModified: w.lastModified ?? "",
    },
    { webhookId: w.endpointId },
    w.created,
    w.lastModified,
  );
}

export function mapService(s: Service, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "service",
    s.name,
    s.displayName || s.name,
    {
      name: s.name,
      displayName: s.displayName ?? "",
      ports: joinList(s.ports),
      tags: joinList(s.tags),
      comment: s.comment ?? "",
      addresses: joinList(s.addrs),
    },
    { ip: ipv4Of(s.addrs), serviceName: s.name },
  );
}

export function mapPostureIntegration(p: PostureIntegration, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "posture-integration",
    p.id,
    [p.provider, p.cloudId].filter(Boolean).join(" · ") || p.id,
    {
      provider: p.provider ?? "",
      cloudId: p.cloudId ?? "",
      clientId: p.clientId ?? "",
      tenantId: p.tenantId ?? "",
      lastSync: p.status?.lastSync ?? "",
      syncError: p.status?.error ?? "",
      providerHostCount: p.status?.providerHostCount ?? 0,
      matchedCount: p.status?.matchedCount ?? 0,
      configUpdated: p.configUpdated ?? "",
    },
    {},
    undefined,
    p.configUpdated,
  );
}

function contactLabel(contact: Contact | undefined): string {
  if (!contact?.email) return "";
  return contact.needsVerification ? `${contact.email} (unverified)` : contact.email;
}

export interface TailnetSnapshot {
  /** The tailnet as the credential names it; `-` for the token's own tailnet. */
  id: string;
  /** MagicDNS suffix (e.g. `tail1234.ts.net`) when a device reveals it. */
  dnsName: string;
  settings: TailnetSettings;
  dns?: DnsConfiguration;
  contacts?: Contacts;
}

export function mapTailnet(t: TailnetSnapshot, accountId: string): ResourceInstance {
  const s = t.settings;
  const split = Object.entries(t.dns?.splitDNS ?? {})
    .map(
      ([domain, resolvers]) => `${domain} → ${(resolvers ?? []).map((r) => r.address).join(" ")}`,
    )
    .join("; ");
  return instance(
    accountId,
    "tailnet",
    t.id,
    t.id !== "-" ? t.id : t.dnsName || "Tailnet",
    {
      devicesApprovalOn: s.devicesApprovalOn ?? false,
      devicesAutoUpdatesOn: s.devicesAutoUpdatesOn ?? false,
      devicesKeyDurationDays: s.devicesKeyDurationDays ?? 0,
      usersApprovalOn: s.usersApprovalOn ?? false,
      usersRoleAllowedToJoinExternalTailnets: s.usersRoleAllowedToJoinExternalTailnets ?? "",
      networkFlowLoggingOn: s.networkFlowLoggingOn ?? false,
      regionalRoutingOn: s.regionalRoutingOn ?? false,
      postureIdentityCollectionOn: s.postureIdentityCollectionOn ?? false,
      httpsEnabled: s.httpsEnabled ?? false,
      aclsExternallyManagedOn: s.aclsExternallyManagedOn ?? false,
      aclsExternalLink: s.aclsExternalLink ?? "",
      magicDNS: t.dns?.preferences?.magicDNS ?? false,
      overrideLocalDNS: t.dns?.preferences?.overrideLocalDNS ?? false,
      nameservers: joinList(t.dns?.nameservers?.map((n) => n.address)),
      searchPaths: joinList(t.dns?.searchPaths),
      splitDNS: split,
      accountContact: contactLabel(t.contacts?.account),
      securityContact: contactLabel(t.contacts?.security),
      supportContact: contactLabel(t.contacts?.support),
    },
    { dnsName: t.dnsName },
  );
}
