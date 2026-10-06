/** Narrow shapes of the Koyeb API payloads this plugin reads (spec 2026-10). Int64s arrive as strings. */

export interface KyOrganization {
  id: string;
  name: string;
  plan?: string;
  status?: string;
  status_message?: string;
  has_payment_method?: boolean;
  trialing?: boolean;
  trial_ends_at?: string;
  billing_email?: string;
  default_project_id?: string;
}

export interface KyProject {
  id: string;
  name: string;
  description?: string;
  service_count?: string;
  created_at?: string;
  updated_at?: string;
}

export interface KyDomain {
  id: string;
  name: string;
  status?: string;
  type?: "AUTOASSIGNED" | "CUSTOM";
  app_id?: string;
  intended_cname?: string;
  verified_at?: string;
  messages?: string[];
  project_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface KyApp {
  id: string;
  name: string;
  status?: string;
  messages?: string[];
  domains?: KyDomain[];
  created_at?: string;
  updated_at?: string;
  paused_at?: string;
}

export interface KyEnv {
  scopes?: string[];
  key: string;
  value?: string;
  secret?: string;
}

export interface KyScaling {
  scopes?: string[];
  min?: number;
  max?: number;
  targets?: Array<
    Record<
      string,
      { value?: number; quantile?: string; deep_sleep_value?: number; light_sleep_value?: number }
    >
  >;
}

export interface KyDefinition {
  name?: string;
  type?: string;
  strategy?: { type?: string };
  routes?: Array<{ port?: number; path?: string }>;
  ports?: Array<{ port?: number; protocol?: string }>;
  proxy_ports?: Array<{ port?: number; protocol?: string }>;
  env?: KyEnv[];
  regions?: string[];
  scalings?: KyScaling[];
  instance_types?: Array<{ scopes?: string[]; type?: string }>;
  health_checks?: unknown[];
  volumes?: Array<{ id?: string; path?: string; replica_index?: number; scopes?: string[] }>;
  skip_cache?: boolean;
  docker?: {
    image?: string;
    command?: string;
    args?: string[];
    image_registry_secret?: string;
    entrypoint?: string[];
  };
  git?: {
    repository?: string;
    branch?: string;
    tag?: string;
    sha?: string;
    build_command?: string;
    run_command?: string;
    no_deploy_on_push?: boolean;
    workdir?: string;
    buildpack?: { build_command?: string; run_command?: string };
    docker?: { dockerfile?: string; command?: string; args?: string[]; target?: string };
  };
  database?: {
    neon_postgres?: {
      pg_version?: number;
      region?: string;
      instance_type?: string;
      roles?: Array<{ name?: string; secret?: string }>;
      databases?: Array<{ name?: string; owner?: string }>;
    };
  };
  [k: string]: unknown;
}

export interface KyService {
  id: string;
  name: string;
  type?: string;
  app_id: string;
  project_id?: string;
  status?: string;
  messages?: string[];
  active_deployment_id?: string;
  latest_deployment_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface KyDeployment {
  id: string;
  app_id?: string;
  service_id?: string;
  status?: string;
  messages?: string[];
  definition?: KyDefinition;
  metadata?: {
    trigger?: {
      type?: string;
      actor?: string;
      git?: { sha?: string; message?: string; branch?: string };
    };
    proxy_ports?: Array<{ host?: string; public_port?: number; port?: number; protocol?: string }>;
  };
  provisioning_info?: { sha?: string; image?: string };
  database_info?: {
    neon_postgres?: {
      server_host?: string;
      server_port?: number;
      endpoint_state?: string;
      endpoint_last_active?: string;
      default_branch_logical_size?: string;
      compute_time_seconds?: string;
      active_time_seconds?: string;
      data_storage_bytes_hour?: string;
      roles?: Array<{ name?: string; secret_id?: string }>;
    };
  };
  created_at?: string;
  updated_at?: string;
  succeeded_at?: string;
  terminated_at?: string;
  version?: string;
}

export interface KyInstance {
  id: string;
  app_id?: string;
  service_id?: string;
  type?: string;
  region?: string;
  datacenter?: string;
  replica_index?: number;
  status?: string;
  messages?: string[];
  created_at?: string;
  started_at?: string;
}

export interface KySecret {
  id: string;
  name: string;
  type?: "SIMPLE" | "REGISTRY" | "MANAGED";
  project_id?: string;
  created_at?: string;
  updated_at?: string;
  docker_hub_registry?: { username?: string };
  private_registry?: { username?: string; url?: string };
  github_registry?: { username?: string };
  gitlab_registry?: { username?: string };
  digital_ocean_registry?: { username?: string };
  gcp_container_registry?: { url?: string };
  azure_container_registry?: { registry_name?: string; username?: string };
  database_role_password?: { username?: string };
}

export interface KyVolume {
  id: string;
  name: string;
  region?: string;
  service_id?: string;
  snapshot_id?: string;
  read_only?: boolean;
  max_size?: number;
  cur_size?: number;
  status?: string;
  backing_store?: string;
  created_at?: string;
  updated_at?: string;
}

export interface KySnapshot {
  id: string;
  name: string;
  size?: number;
  parent_volume_id?: string;
  region?: string;
  status?: string;
  type?: string;
  created_at?: string;
}

export interface KyRegion {
  id: string;
  name: string;
  status?: string;
  instances?: string[];
  volumes_enabled?: boolean;
  scope?: string;
}

export interface KyInstanceType {
  id: string;
  display_name?: string;
  description?: string;
  type?: string;
  vcpu?: number;
  vcpu_shares?: number;
  memory?: string;
  disk?: string;
  price_monthly?: string;
  price_hourly?: string;
  price_per_second?: string;
  regions?: string[];
  status?: string;
  service_types?: string[];
  volumes_enabled?: boolean;
}

export interface KyNextInvoice {
  stripe_invoice?: {
    subtotal_excluding_tax?: number;
    total_excluding_tax?: number;
    currency?: string;
  };
  lines?: Array<{
    amount_excluding_tax?: number;
    period?: { start?: string; end?: string };
    plan_nickname?: string;
    price?: { unit_amount_decimal?: number };
    quantity?: number;
  }>;
  discounts?: Array<{ type?: string; name?: string; amount?: string }>;
}

export interface KyQuotaUsage {
  apps_used?: number;
  apps_limit?: number;
  services_used?: number;
  services_limit?: number;
  memory_mb_used?: number;
  memory_mb_limit?: number;
  custom_domains_used?: number;
  custom_domains_limit?: number;
  koyeb_lb_domains_used?: number;
  koyeb_lb_domains_limit?: number;
  proxy_ports_used?: number;
  proxy_ports_limit?: number;
  instances_by_type?: Array<{ instance_type?: string; used?: number; limit?: number }>;
  persistent_volumes_by_region?: Array<{
    region?: string;
    total_size_gb_used?: number;
    total_size_gb_limit?: number;
  }>;
  instance_snapshots_by_type?: Array<{ type?: string; used?: number; limit?: number }>;
}
