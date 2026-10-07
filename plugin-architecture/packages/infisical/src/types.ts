/** Infisical API shapes (only the fields this plugin reads). */

export interface InfEnvironment {
  id?: string;
  name?: string;
  slug?: string;
  position?: number;
  projectId?: string;
}

export interface InfProject {
  id?: string;
  name?: string;
  slug?: string;
  description?: string | null;
  type?: string;
  orgId?: string;
  createdAt?: string;
  updatedAt?: string;
  autoCapitalization?: boolean | null;
  hasDeleteProtection?: boolean | null;
  secretSharing?: boolean;
  pitVersionLimit?: number;
  environments?: InfEnvironment[];
}

export interface InfFolder {
  id?: string;
  name?: string;
  envId?: string;
  parentId?: string | null;
  description?: string | null;
  lastSecretModified?: string | null;
  relativePath?: string;
  path?: string;
  projectId?: string;
  environment?: { slug?: string; name?: string; id?: string };
  createdAt?: string;
  updatedAt?: string;
}

export interface InfSecret {
  id?: string;
  workspace?: string;
  environment?: string;
  version?: number;
  type?: string;
  secretKey?: string;
  secretValue?: string;
  secretValueHidden?: boolean;
  secretComment?: string;
  secretReminderNote?: string | null;
  secretReminderRepeatDays?: number | null;
  secretPath?: string;
  isRotatedSecret?: boolean;
  tags?: Array<{ id?: string; slug?: string; name?: string }>;
  createdAt?: string;
  updatedAt?: string;
}

export interface InfDynamicSecret {
  id?: string;
  name?: string;
  type?: string;
  defaultTTL?: string;
  maxTTL?: string | null;
  status?: string | null;
  statusDetails?: string | null;
  folderId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface InfLease {
  id?: string;
  externalEntityId?: string;
  expireAt?: string;
  status?: string | null;
  createdAt?: string;
}

export interface InfSecretSync {
  id?: string;
  name?: string;
  description?: string | null;
  isAutoSyncEnabled?: boolean;
  projectId?: string;
  connectionId?: string;
  syncStatus?: string | null;
  lastSyncMessage?: string | null;
  lastSyncedAt?: string | null;
  importStatus?: string | null;
  lastImportMessage?: string | null;
  removeStatus?: string | null;
  connection?: { app?: string; name?: string; id?: string };
  environment?: { slug?: string; name?: string; id?: string } | null;
  folder?: { id?: string; path?: string } | null;
  destination?: string;
  destinationConfig?: Record<string, unknown>;
  syncOptions?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface InfSyncOption {
  name?: string;
  destination?: string;
  canImportSecrets?: boolean;
}

export interface InfIntegration {
  id?: string;
  isActive?: boolean;
  integration?: string;
  app?: string | null;
  owner?: string | null;
  targetEnvironment?: string | null;
  secretPath?: string;
  isSynced?: boolean | null;
  syncMessage?: string | null;
  lastUsed?: string | null;
  environment?: { slug?: string; name?: string };
  createdAt?: string;
  updatedAt?: string;
}

export interface InfIdentityMembership {
  id?: string;
  role?: string;
  orgId?: string;
  identityId?: string;
  lastLoginAuthMethod?: string | null;
  lastLoginTime?: string | null;
  createdAt?: string;
  updatedAt?: string;
  customRole?: { slug?: string; name?: string };
  identity?: {
    id?: string;
    name?: string;
    hasDeleteProtection?: boolean;
    authMethods?: string[];
    activeLockoutAuthMethods?: string[];
  };
}

export interface InfUniversalAuth {
  clientId?: string;
  accessTokenTTL?: number;
  accessTokenMaxTTL?: number;
  lockoutEnabled?: boolean;
}

export interface InfClientSecret {
  id?: string;
  description?: string;
  clientSecretPrefix?: string;
  clientSecretNumUses?: number;
  clientSecretNumUsesLimit?: number;
  clientSecretTTL?: number;
  isClientSecretRevoked?: boolean;
  createdAt?: string;
}

export interface InfRole {
  id?: string;
  name?: string;
  slug?: string;
}

export interface InfCa {
  id?: string;
  projectId?: string;
  status?: string;
  name?: string;
  type?: string;
  friendlyName?: string;
  commonName?: string;
  keyAlgorithm?: string;
  serialNumber?: string | null;
  notBefore?: string;
  notAfter?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface InfCertificate {
  id?: string;
  caId?: string | null;
  status?: string;
  serialNumber?: string;
  friendlyName?: string;
  commonName?: string;
  notBefore?: string;
  notAfter?: string;
  revokedAt?: string | null;
  altNames?: string | null;
  profileId?: string | null;
  projectId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface InfCertificateProfile {
  id?: string;
  slug?: string;
  description?: string | null;
  enrollmentType?: string;
  caId?: string | null;
}

export interface InfAuditLog {
  id?: string;
  createdAt?: string;
  ipAddress?: string | null;
  userAgentType?: string | null;
  projectName?: string | null;
  event?: { type?: string; metadata?: Record<string, unknown> };
  actor?: { type?: string; metadata?: Record<string, unknown> };
}
