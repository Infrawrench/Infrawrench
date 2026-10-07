/** Weaviate REST shapes (`/v1`). Only the fields this plugin reads. */

export interface WvMeta {
  hostname?: string;
  version?: string;
  modules?: Record<string, unknown>;
}

export interface WvShard {
  name?: string;
  class?: string;
  objectCount?: number;
  vectorIndexingStatus?: string;
  vectorQueueLength?: number;
  compressed?: boolean;
  loaded?: boolean;
}

export interface WvNode {
  name?: string;
  status?: string;
  version?: string;
  gitHash?: string;
  stats?: { shardCount?: number; objectCount?: number };
  shards?: WvShard[] | null;
  operationalMode?: string;
}

export interface WvProperty {
  name: string;
  dataType?: string[];
  description?: string;
  tokenization?: string;
  indexFilterable?: boolean;
  indexSearchable?: boolean;
  indexRangeFilters?: boolean;
}

export interface WvClass {
  class: string;
  description?: string;
  vectorizer?: string;
  vectorIndexType?: string;
  vectorIndexConfig?: Record<string, unknown>;
  vectorConfig?: Record<string, { vectorizer?: Record<string, unknown>; vectorIndexType?: string }>;
  replicationConfig?: { factor?: number; asyncEnabled?: boolean; deletionStrategy?: string };
  multiTenancyConfig?: {
    enabled?: boolean;
    autoTenantCreation?: boolean;
    autoTenantActivation?: boolean;
  };
  shardingConfig?: { desiredCount?: number; actualCount?: number };
  properties?: WvProperty[];
  [k: string]: unknown;
}

export interface WvTenant {
  name: string;
  activityStatus?: string;
}

export interface WvAlias {
  alias: string;
  class: string;
}

export interface WvBackup {
  id: string;
  classes?: string[];
  status?: string;
  startedAt?: string;
  completedAt?: string;
  size?: number;
  backend?: string;
}

export interface WvDbUser {
  userId: string;
  roles?: string[];
  dbUserType?: string;
  active?: boolean;
  createdAt?: string | null;
  apiKeyFirstLetters?: string | null;
  lastUsedAt?: string | null;
}

export interface WvRole {
  name: string;
  permissions?: Array<{ action?: string; [k: string]: unknown }>;
}
