/** Wire shapes from the Supabase Management API OpenAPI document (2026-10). */

export type ProjectStatus =
  | "INACTIVE"
  | "ACTIVE_HEALTHY"
  | "ACTIVE_UNHEALTHY"
  | "COMING_UP"
  | "UNKNOWN"
  | "GOING_DOWN"
  | "INIT_FAILED"
  | "REMOVED"
  | "RESTORING"
  | "UPGRADING"
  | "PAUSING"
  | "RESTORE_FAILED"
  | "RESTARTING"
  | "PAUSE_FAILED"
  | "RESIZING";

export interface SbOrganization {
  id: string;
  slug: string;
  name: string;
}

export interface SbOrganizationDetail {
  id: string;
  name: string;
  plan?: string;
  opt_in_tags?: string[];
  allowed_release_channels?: string[];
}

export interface SbMember {
  user_id: string;
  user_name: string;
  email?: string;
  role_name?: string;
  mfa_enabled: boolean;
}

export interface SbProject {
  id?: string;
  ref: string;
  organization_id?: string;
  organization_slug: string;
  name: string;
  region: string;
  created_at: string;
  status: ProjectStatus | string;
  database?: {
    host: string;
    version: string;
    postgres_engine: string;
    release_channel: string;
  };
}

/** One database in `GET /v1/organizations/{slug}/projects` (primary or read replica). */
export interface SbOrgProjectDatabase {
  infra_compute_size?: string;
  region: string;
  status: string;
  cloud_provider: string;
  identifier: string;
  type: "PRIMARY" | "READ_REPLICA";
  disk_volume_size_gb?: number;
  disk_type?: string;
  disk_throughput_mbps?: number;
  disk_last_modified_at?: string;
}

export interface SbOrgProject {
  ref: string;
  name: string;
  cloud_provider: string;
  region: string;
  is_branch: boolean;
  status: string;
  inserted_at: string;
  databases: SbOrgProjectDatabase[];
}

export interface SbOrgProjectsPage {
  projects: SbOrgProject[];
  pagination: { count: number; limit: number; offset: number };
}

export interface SbBranch {
  id: string;
  name: string;
  project_ref: string;
  parent_project_ref: string;
  is_default: boolean;
  git_branch?: string;
  pr_number?: number;
  persistent: boolean;
  status: string;
  created_at: string;
  updated_at: string;
  review_requested_at?: string;
  with_data: boolean;
  notify_url?: string;
  deletion_scheduled_at?: string;
  preview_project_status?: string;
}

export interface SbBranchConfig {
  ref: string;
  postgres_version: string;
  postgres_engine: string;
  release_channel: string;
  status: string;
  db_host: string;
  db_port: number;
  db_user?: string;
  db_pass?: string;
}

export interface SbFunction {
  id: string;
  slug: string;
  name: string;
  status: string;
  version: number;
  created_at: number;
  updated_at: number;
  verify_jwt?: boolean;
  import_map?: boolean;
  entrypoint_path?: string;
  import_map_path?: string;
  ezbr_sha256?: string;
}

export interface SbSecret {
  name: string;
  /** A SHA-256 digest of the value, never the value itself. */
  value: string;
  updated_at?: string;
}

export interface SbApiKey {
  api_key?: string | null;
  id?: string | null;
  type?: "legacy" | "publishable" | "secret" | null;
  prefix?: string | null;
  name: string;
  description?: string | null;
  hash?: string | null;
  secret_jwt_template?: Record<string, unknown> | null;
  inserted_at?: string | null;
  updated_at?: string | null;
}

export interface SbBucket {
  id: string;
  name: string;
  owner: string;
  created_at: string;
  updated_at: string;
  public: boolean;
}

/** Storage API bucket, which carries limits the Management API omits. */
export interface SbStorageBucket extends SbBucket {
  file_size_limit?: number | null;
  allowed_mime_types?: string[] | null;
  type?: string;
}

export interface SbStorageObject {
  name: string;
  id: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  metadata?: { size?: number; mimetype?: string; lastModified?: string } | null;
}

export interface SbBackups {
  region: string;
  walg_enabled: boolean;
  pitr_enabled: boolean;
  backups: Array<{
    id: number;
    is_physical_backup: boolean;
    status: string;
    inserted_at: string;
  }>;
  physical_backup_data?: {
    earliest_physical_backup_date_unix?: number;
    latest_physical_backup_date_unix?: number;
  };
}

export interface SbAddonPrice {
  description: string;
  type: "fixed" | "usage";
  interval: "monthly" | "hourly";
  amount: number;
}

export interface SbAddonVariant {
  id: string;
  name: string;
  price: SbAddonPrice;
  meta?: unknown;
}

export interface SbAddons {
  selected_addons: Array<{ type: string; variant: SbAddonVariant }>;
  available_addons: Array<{ type: string; name: string; variants: SbAddonVariant[] }>;
}

export interface SbDiskConfig {
  attributes: {
    iops: number;
    size_gb: number;
    throughput_mibps?: number;
    type: "gp3" | "io2";
  };
  last_modified_at?: string;
}

export interface SbDiskUtil {
  timestamp: string;
  metrics: { fs_size_bytes: number; fs_avail_bytes: number; fs_used_bytes: number };
}

export interface SbDiskAutoscale {
  growth_percent: number;
  min_increment_gb: number;
  max_size_gb: number;
}

export interface SbPooler {
  identifier: string;
  database_type: "PRIMARY" | "READ_REPLICA";
  is_using_scram_auth: boolean;
  db_user: string;
  db_host: string;
  db_port: number;
  db_name: string;
  connection_string: string;
  default_pool_size: number | null;
  max_client_conn: number | null;
  pool_mode: "transaction" | "session";
}

export interface SbNetworkRestrictions {
  entitlement: "disallowed" | "allowed";
  config: { dbAllowedCidrs?: string[]; dbAllowedCidrsV6?: string[] };
  old_config?: { dbAllowedCidrs?: string[]; dbAllowedCidrsV6?: string[] };
  status: "stored" | "applied";
}

export interface SbSslEnforcement {
  currentConfig: { database: boolean };
  appliedSuccessfully: boolean;
}

export interface SbReadonly {
  enabled: boolean;
  override_enabled: boolean;
  override_active_until: string;
}

export interface SbHealth {
  name: string;
  healthy: boolean;
  status: "COMING_UP" | "ACTIVE_HEALTHY" | "UNHEALTHY";
  error?: string;
  info?: { version?: string; name?: string } | null;
}

export interface SbLint {
  name: string;
  title: string;
  level: "ERROR" | "WARN" | "INFO";
  facing: string;
  categories: string[];
  description: string;
  detail: string;
  remediation: string;
  metadata?: { schema?: string; name?: string; entity?: string; type?: string };
  cache_key: string;
}

export interface SbUpgradeEligibility {
  eligible: boolean;
  current_app_version: string;
  latest_app_version: string;
  target_upgrade_versions: Array<{
    postgres_version: string;
    release_channel: string;
    app_version: string;
  }>;
  duration_estimate_hours: number;
  validation_errors?: unknown[];
  warnings?: unknown[];
}

export interface SbCustomHostname {
  status: string;
  custom_hostname?: string;
  data?: {
    result?: {
      hostname?: string;
      status?: string;
      ssl?: { status?: string };
      ownership_verification?: { type?: string; name?: string; value?: string };
    };
  };
}

export interface SbVanity {
  status: "not-used" | "custom-domain-used" | "active";
  custom_domain?: string;
}

export interface SbSsoProvider {
  id: string;
  saml?: {
    entity_id: string;
    metadata_url?: string;
    metadata_xml?: string;
    name_id_format?: string;
    attribute_mapping?: { keys: Record<string, unknown> };
  };
  domains?: Array<{ domain?: string }>;
  created_at?: string;
  updated_at?: string;
}

export interface SbThirdPartyAuth {
  id: string;
  type: string;
  oidc_issuer_url?: string | null;
  jwks_url?: string | null;
  custom_jwks?: unknown;
  inserted_at: string;
  updated_at: string;
  resolved_at?: string | null;
}

export interface SbSigningKey {
  id: string;
  algorithm: "EdDSA" | "ES256" | "RS256" | "HS256";
  status: "in_use" | "previously_used" | "revoked" | "standby";
  public_jwk?: unknown;
  created_at: string;
  updated_at: string;
}

export interface SbRegionsResponse {
  recommendations?: { specific?: SbRegion[] };
  all?: { specific?: SbRegion[] };
}

export interface SbRegion {
  name: string;
  code: string;
  type: string;
  provider?: string;
  status?: string;
}

export interface SbApiCounts {
  result?: Array<{
    timestamp: string;
    total_auth_requests: number;
    total_realtime_requests: number;
    total_rest_requests: number;
    total_storage_requests: number;
  }>;
  error?: unknown;
}
