/**
 * Anyscale API response shapes: only the fields this plugin reads, named as in
 * the published `/api/v2` OpenAPI document (verified 2026-10).
 */

export interface MiniUser {
  id?: string;
  name?: string;
  username?: string;
  email?: string;
}

export interface MiniProject {
  id?: string;
  name?: string;
  is_default?: boolean;
}

export interface MiniCloud {
  id?: string;
  name?: string;
  provider?: string;
  is_k8s?: boolean;
  is_aioa?: boolean;
}

/** `GET /api/v2/userinfo/` */
export interface AsUserInfo {
  id?: string;
  email?: string;
  name?: string;
  organization_permission_level?: string;
  organizations?: AsOrganization[];
}

export interface AsOrganization {
  id?: string;
  name?: string;
  public_identifier?: string;
  default_cloud_id?: string | null;
  sso_mode?: string;
  is_usage_blocked?: boolean;
}

/** `GET /api/v2/clouds/` */
export interface AsCloud {
  id?: string;
  name?: string;
  provider?: string;
  compute_stack?: string;
  region?: string;
  is_k8s?: boolean;
  /** Anyscale-hosted ("serverless") cloud: Anyscale owns the infrastructure. */
  is_aioa?: boolean;
  is_bring_your_own_resource?: boolean;
  is_private_cloud?: boolean;
  is_default?: boolean;
  state?: string;
  status?: string;
  created_at?: string;
  creator?: MiniUser | null;
}

/** `GET /api/v2/projects/` */
export interface AsProject {
  id?: string;
  name?: string;
  description?: string;
  cloud_id?: string | null;
  parent_cloud_id?: string | null;
  created_at?: string;
  is_default?: boolean;
  owners?: MiniUser[];
}

/** `GET /api/v2/experimental_workspaces/` */
export interface AsWorkspace {
  id?: string;
  name?: string;
  description?: string;
  project_id?: string;
  cloud_id?: string;
  compute_config_id?: string;
  cluster_id?: string;
  creator_id?: string;
  creator_email?: string;
  created_at?: string;
  latest_started_at?: string | null;
  state?: string;
  is_deleted?: boolean;
}

/** `GET /api/v2/decorated_sessions/`: the cluster behind a workload. */
export interface AsCluster {
  id?: string;
  name?: string;
  project_id?: string;
  cloud_id?: string;
  state?: string;
  status?: string;
  idle_timeout?: number | null;
  idle_termination_status?: string | null;
  idle_timeout_last_activity_at?: string | null;
  idle_time_remaining_seconds?: number | null;
  maximum_uptime_will_terminate_cluster_at?: string | null;
  ha_job_id?: string | null;
  is_system_cluster?: boolean;
  latest_started_at?: string | null;
  ray_version?: string | null;
  compute_template?: { id?: string; name?: string } | null;
  cloud?: MiniCloud | null;
  project?: MiniProject | null;
  creator?: MiniUser | null;
}

/** `GET /api/v2/decorated_ha_jobs/` */
export interface AsJob {
  id?: string;
  name?: string;
  description?: string;
  created_at?: string;
  updated_at?: string;
  status_updated_at?: string;
  project_id?: string;
  cloud_id?: string;
  creator?: MiniUser | null;
  project?: MiniProject | null;
  schedule?: { id?: string; name?: string } | null;
  job_queue?: { id?: string; name?: string } | null;
  overview_url?: string;
  archived_at?: string | null;
  state?: {
    current_state?: string;
    goal_state?: string;
    error?: string | null;
    operation_message?: string | null;
    cluster_id?: string | null;
    state_transitioned_at?: string;
  } | null;
  last_job_run?: {
    id?: string;
    status?: string;
    created_at?: string;
    finished_at?: string | null;
  } | null;
  config?: {
    entrypoint?: string;
    image_uri?: string;
    compute_config_id?: string;
    max_retries?: number | null;
    timeout_s?: number | null;
  } | null;
}

export interface AsServiceVersion {
  id?: string;
  version?: string;
  weight?: number;
  current_weight?: number | null;
  target_weight?: number | null;
  current_state?: string;
  compute_config_id?: string;
  created_at?: string;
}

/** `GET /api/v2/services-v2/` */
export interface AsService {
  id?: string;
  name?: string;
  description?: string;
  project_id?: string;
  cloud_id?: string;
  created_at?: string;
  ended_at?: string | null;
  hostname?: string;
  base_url?: string;
  current_state?: string;
  goal_state?: string;
  auto_rollout_enabled?: boolean;
  primary_version?: AsServiceVersion | null;
  canary_version?: AsServiceVersion | null;
  creator?: MiniUser | null;
  error_message?: string | null;
}

export interface AsNodeType {
  name?: string;
  instance_type?: string;
  min_workers?: number | null;
  max_workers?: number | null;
  use_spot?: boolean;
}

/** `POST /api/v2/compute_templates/search` */
export interface AsComputeConfig {
  id?: string;
  name?: string;
  version?: number;
  project_id?: string | null;
  created_at?: string;
  last_modified_at?: string;
  archived_at?: string | null;
  anonymous?: boolean;
  creator?: MiniUser | null;
  config?: {
    cloud_id?: string;
    region?: string;
    idle_termination_minutes?: number | null;
    maximum_uptime_minutes?: number | null;
    auto_select_worker_config?: boolean;
    head_node_type?: AsNodeType | null;
    worker_node_types?: AsNodeType[] | null;
    cloud?: MiniCloud | null;
  } | null;
}

/** `GET /api/v2/instance_usage_budgets/` */
export interface AsBudget {
  id?: string;
  name?: string;
  budget_amount?: number;
  evaluation_period?: string;
  budget_unit?: string | null;
  project_id?: string | null;
  cloud_id?: string | null;
  project?: MiniProject | null;
  cloud?: MiniCloud | null;
  curr_instance_usage?: number | null;
  is_enabled?: boolean;
  created_at?: string;
  last_notified_at?: string | null;
  last_usage_updated_at?: string | null;
  creator?: MiniUser | null;
}

/** `POST /api/v2/aggregated_instance_usage/cluster` rows. */
export interface AsUsageByCluster {
  anyscale_credits?: number | null;
  dollar_value?: number | null;
  date?: string | null;
  user_id?: string | null;
  user_email?: string | null;
  user_name?: string | null;
  cloud_id?: string | null;
  cloud_name?: string | null;
  project_id?: string | null;
  project_name?: string | null;
  cluster_id?: string | null;
  job_id?: string | null;
  job_name?: string | null;
  job_queue_id?: string | null;
  job_queue_name?: string | null;
  service_id?: string | null;
  service_name?: string | null;
  workspace_id?: string | null;
  workspace_name?: string | null;
}

/** `POST /api/v2/aggregated_instance_usage/{cluster_type,project,user}` rows. */
export interface AsUsageGroup {
  anyscale_credits?: number | null;
  dollar_value?: number | null;
  date?: string | null;
  cluster_type?: string | null;
  project_id?: string | null;
  project_name?: string | null;
  cloud_name?: string | null;
  user_email?: string | null;
  user_name?: string | null;
}

export interface AsCreditRecord {
  credit_name?: string;
  contract_name?: string | null;
  effective_date_start?: string | null;
  effective_date_end?: string | null;
  total_balance_usd?: number | null;
  last_month_usage_usd?: number | null;
  amount_consumed_usd?: number | null;
  total_granted_usd?: number | null;
  credit_type?: string | null;
}

/** `GET /api/v2/organization_billing/credits_v2` */
export interface AsCredits {
  in_use_credits?: AsCreditRecord[];
  pending_credits?: AsCreditRecord[];
  expired_credits?: AsCreditRecord[];
  in_use_commits?: AsCreditRecord[];
  pending_commits?: AsCreditRecord[];
  expired_commits?: AsCreditRecord[];
  current_balance_usd?: number | null;
  amount_spent_usd?: number | null;
  total_granted_usd?: number | null;
}

/** `GET /api/v2/clouds/{id}/cluster-utilization/timeseries` */
export interface AsUtilizationTimeseries {
  result?: {
    series?: Array<{
      name?: string;
      points?: Array<{ timestamp?: number; value?: number | null }>;
    }>;
  };
}
