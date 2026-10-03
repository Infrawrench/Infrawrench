// Wire shapes for https://api.tailscale.com/api/v2, verified against the
// published OpenAPI document (https://api.tailscale.com/api/v2?outputOpenapiSchema=true)
// and Tailscale's official client:
// https://github.com/tailscale/tailscale-client-go-v2

export interface Device {
  id: string;
  nodeId?: string;
  name: string;
  hostname: string;
  addresses: string[];
  os?: string;
  user?: string;
  tags?: string[];
  authorized?: boolean;
  connectedToControl?: boolean;
  clientVersion?: string;
  updateAvailable?: boolean;
  lastSeen?: string | null;
  created?: string;
  expires?: string;
  keyExpiryDisabled?: boolean;
  /** Shared in from another tailnet, not a member of this one. */
  isExternal?: boolean;
  multipleConnections?: boolean;
  blocksIncomingConnections?: boolean;
  enabledRoutes?: string[];
  advertisedRoutes?: string[];
  tailnetLockError?: string;
  sshEnabled?: boolean;
  isEphemeral?: boolean;
  distro?: { name?: string; version?: string; codeName?: string };
  clientConnectivity?: {
    endpoints?: string[];
    mappingVariesByDestIP?: boolean;
    latency?: Record<string, { latencyMs?: number; preferred?: boolean }>;
  };
}

export interface User {
  id: string;
  displayName?: string;
  loginName?: string;
  profilePicUrl?: string;
  created?: string;
  type?: string;
  role?: string;
  status?: string;
  deviceCount?: number;
  lastSeen?: string;
  currentlyConnected?: boolean;
}

export interface UserInvite {
  id: string;
  role?: string;
  email?: string;
  lastEmailSentAt?: string;
  inviteUrl?: string;
}

export interface Key {
  id: string;
  key?: string;
  keyType?: string;
  description?: string;
  created?: string;
  expires?: string;
  revoked?: string;
  invalid?: boolean;
  userId?: string;
  scopes?: string[];
  tags?: string[];
  issuer?: string;
  subject?: string;
  capabilities?: {
    devices?: {
      create?: {
        reusable?: boolean;
        ephemeral?: boolean;
        preauthorized?: boolean;
        tags?: string[];
      };
    };
  };
}

export interface Webhook {
  endpointId: string;
  endpointUrl?: string;
  providerType?: string;
  creatorLoginName?: string;
  created?: string;
  lastModified?: string;
  subscriptions?: string[];
  secret?: string;
}

export interface Service {
  name: string;
  displayName?: string;
  addrs?: string[];
  comment?: string;
  ports?: string[];
  tags?: string[];
}

export interface ServiceHost {
  stableNodeID: string;
  approvalLevel?: string;
  configured?: string;
}

export interface PostureIntegration {
  id: string;
  provider?: string;
  cloudId?: string;
  clientId?: string;
  tenantId?: string;
  configUpdated?: string;
  status?: {
    lastSync?: string;
    error?: string;
    providerHostCount?: number;
    matchedCount?: number;
    possibleMatchedCount?: number;
  };
}

export interface TailnetSettings {
  aclsExternallyManagedOn?: boolean | null;
  aclsExternalLink?: string;
  devicesApprovalOn?: boolean | null;
  devicesAutoUpdatesOn?: boolean | null;
  devicesKeyDurationDays?: number;
  usersApprovalOn?: boolean | null;
  usersRoleAllowedToJoinExternalTailnets?: string;
  networkFlowLoggingOn?: boolean | null;
  regionalRoutingOn?: boolean | null;
  postureIdentityCollectionOn?: boolean | null;
  httpsEnabled?: boolean | null;
}

export interface DnsConfiguration {
  nameservers?: Array<{ address: string; useWithExitNode?: boolean }>;
  splitDNS?: Record<string, Array<{ address: string; useWithExitNode?: boolean }> | null>;
  searchPaths?: string[];
  preferences?: { overrideLocalDNS?: boolean; magicDNS?: boolean };
}

export interface Contact {
  email?: string;
  fallbackEmail?: string;
  needsVerification?: boolean;
}

export interface Contacts {
  account?: Contact;
  support?: Contact;
  security?: Contact;
}

export interface LogStreamConfig {
  logType?: string;
  destinationType?: string;
  url?: string;
  uploadPeriodMinutes?: number;
  compressionFormat?: string;
  s3Bucket?: string;
  s3Region?: string;
}

export interface LogStreamStatus {
  lastActivity?: string;
  lastError?: string;
  numEntriesSent?: number;
  numBytesSent?: number;
  numFailedRequests?: number;
  numTotalRequests?: number;
}

export interface ConfigurationAuditLog {
  eventTime?: string;
  origin?: string;
  action?: string;
  actionDetails?: string;
  error?: string;
  actor?: { id?: string; type?: string; loginName?: string; displayName?: string };
  target?: { id?: string; name?: string; type?: string; property?: string };
  old?: unknown;
  new?: unknown;
}

/** Settings keys that `PATCH /tailnet/{tailnet}/settings` accepts as booleans. */
export const BOOLEAN_SETTINGS = [
  "devicesApprovalOn",
  "devicesAutoUpdatesOn",
  "usersApprovalOn",
  "networkFlowLoggingOn",
  "regionalRoutingOn",
  "postureIdentityCollectionOn",
  "httpsEnabled",
  "aclsExternallyManagedOn",
] as const;
