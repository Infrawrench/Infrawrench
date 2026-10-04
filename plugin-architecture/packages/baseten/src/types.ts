/**
 * Payload shapes of the Baseten management API (`https://api.baseten.co/v1`),
 * transcribed from Baseten's published OpenAPI document
 * (`https://api.baseten.co/v1/spec`, fetched 2026-10). Only the properties
 * the plugin reads are declared; everything is optional because the spec
 * marks most of it nullable.
 *
 * Money arrives as `number | string` (the spec's decimal pattern), so every
 * amount goes through `money()` in `mappers.ts` rather than `Number()`.
 */

export type Decimal = number | string;

export interface BasetenTeam {
  id: string;
  name?: string;
  default?: boolean;
  created_at?: string;
}

export interface BasetenOrganization {
  org_id?: string;
  name?: string;
  created_at?: string;
}

export interface BasetenInstanceType {
  id: string;
  name?: string;
  memory_limit_mib?: number;
  millicpu_limit?: number;
  gpu_count?: number;
  gpu_type?: string | null;
  gpu_memory_limit_mib?: number | null;
}

export interface BasetenInstanceTypePrice {
  instance_type: BasetenInstanceType;
  /** USD per minute. */
  price?: number;
}

export interface BasetenModel {
  id: string;
  name?: string;
  created_at?: string;
  deployments_count?: number;
  production_deployment_id?: string | null;
  development_deployment_id?: string | null;
  instance_type_name?: string | null;
  team_name?: string | null;
}

export interface BasetenAutoscaling {
  min_replica?: number | null;
  max_replica?: number | null;
  autoscaling_window?: number | null;
  scale_down_delay?: number | null;
  concurrency_target?: number | null;
  target_utilization_percentage?: number | null;
  target_in_flight_tokens?: number | null;
  max_scale_down_rate?: number | null;
}

export type BasetenDeploymentStatus =
  | "BUILDING"
  | "DEPLOYING"
  | "DEPLOY_FAILED"
  | "LOADING_MODEL"
  | "ACTIVE"
  | "UNHEALTHY"
  | "BUILD_FAILED"
  | "BUILD_STOPPED"
  | "DEACTIVATING"
  | "INACTIVE"
  | "FAILED"
  | "UPDATING"
  | "SCALED_TO_ZERO"
  | "WAKING_UP";

export interface BasetenRegion {
  slug?: string;
  display_name?: string;
}

export interface BasetenDeployment {
  id: string;
  name?: string;
  created_at?: string;
  model_id?: string;
  is_production?: boolean;
  is_development?: boolean;
  status?: BasetenDeploymentStatus | string;
  active_replica_count?: number;
  autoscaling_settings?: BasetenAutoscaling | null;
  instance_type_name?: string | null;
  environment?: string | null;
  labels?: Record<string, unknown> | null;
  region?: BasetenRegion | null;
  request_backpressure_settings?: { policy?: string | null } | null;
}

export interface BasetenEnvironment {
  name: string;
  created_at?: string;
  model_id?: string;
  current_deployment?: BasetenDeployment | null;
  candidate_deployment?: BasetenDeployment | null;
  in_progress_promotion?: {
    status?: string;
    percent_traffic_to_new_version?: number | null;
    error_message?: string | null;
    rolling_deploy?: boolean | null;
  } | null;
  autoscaling_settings?: BasetenAutoscaling | null;
  promotion_settings?: {
    redeploy_on_promotion?: boolean | null;
    rolling_deploy?: boolean | null;
    promotion_cleanup_strategy?: string | null;
    ramp_up_while_promoting?: boolean | null;
    ramp_up_duration_seconds?: number | null;
  } | null;
  instance_type?: BasetenInstanceType | null;
  request_backpressure_settings?: { policy?: string | null } | null;
  autoscaling_schedules?: {
    timezone?: string | null;
    schedules?: Array<{ id?: string; name?: string; enabled?: boolean }>;
  } | null;
}

export interface BasetenChain {
  id: string;
  name?: string;
  created_at?: string;
  deployments_count?: number;
  team_name?: string | null;
}

export interface BasetenSecret {
  id?: string;
  name: string;
  created_at?: string;
  team_name?: string | null;
}

export interface BasetenTrainingJob {
  id: string;
  name?: string | null;
  created_at?: string;
  updated_at?: string;
  current_status?: string;
  error_message?: string | null;
  instance_type?: BasetenInstanceType | null;
  node_count?: number | null;
  training_project_id?: string;
  training_project?: { id?: string; name?: string } | null;
  priority?: number | null;
  availability_model?: "dedicated" | "spot" | string | null;
  user?: { email?: string } | null;
}

export interface BasetenTrainingProject {
  id: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
  team_name?: string | null;
  latest_job?: BasetenTrainingJob | null;
}

export interface BasetenModelApi {
  name: string;
  display_name?: string;
  description?: string | null;
  model_family?: string | null;
  release_date?: string | null;
  invoke_url?: string | null;
  context_length?: number | null;
  cost_per_million_input_tokens?: Decimal | null;
  cost_per_million_output_tokens?: Decimal | null;
  rate_limits?: Array<{ type?: string; unit?: string; threshold?: number }> | null;
  org_details?: { added_at?: string | null; last_used_at?: string | null } | null;
}

export interface BasetenPagination {
  has_more?: boolean;
  cursor?: string | null;
}

export interface BasetenTrainingCapacity {
  gpu_capacities?: Array<{
    gpu_type: string;
    baseline?: number;
    limit?: number;
    usage_count?: number;
    dedicated_usage_count?: number;
    spot_usage_count?: number;
  }>;
  team_gpu_capacities?: Array<{
    team_id?: string;
    team_name?: string;
    gpu_type: string;
    baseline?: number;
    limit?: number;
    usage_count?: number;
  }>;
}

// ── Billing ─────────────────────────────────────────────────────────────

export type BillableResourceKind =
  "LOOPS_SAMPLER" | "LOOPS_TRAINER" | "MODEL_DEPLOYMENT" | "TRAINING_JOB" | "CHAINLET";

export interface BillableResource {
  id: string;
  kind: BillableResourceKind | string;
  name?: string | null;
  model_id?: string | null;
  model_name?: string | null;
  is_deleted?: boolean;
  instance_type?: string | null;
  base_model?: string | null;
  environment_name?: string | null;
  chain_metadata?: {
    chain_id?: string;
    chain_name?: string | null;
    chain_deployment_id?: string;
  } | null;
  team_id?: string | null;
  team_name?: string | null;
}

export interface DailyDedicatedUsage {
  date: string;
  subtotal: Decimal;
  compute_cost?: Decimal;
  surcharge_cost?: Decimal;
  minutes?: number;
  inference_requests?: number;
}

export interface DedicatedItem {
  billable_resource: BillableResource;
  subtotal: Decimal;
  compute_cost?: Decimal;
  surcharge_cost?: Decimal;
  minutes?: number;
  inference_requests?: number;
  daily?: DailyDedicatedUsage[] | null;
}

export interface DailyTrainingUsage {
  date: string;
  subtotal: Decimal;
  minutes?: number;
}

export interface TrainingItem {
  billable_resource: BillableResource;
  subtotal: Decimal;
  minutes?: number;
  daily?: DailyTrainingUsage[] | null;
}

export interface DailyModelApiUsage {
  date: string;
  subtotal: Decimal;
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
}

export interface ModelApiItem {
  model_name: string;
  model_family?: string | null;
  subtotal: Decimal;
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  daily?: DailyModelApiUsage[] | null;
}

interface UsageBlock<T> {
  subtotal: Decimal;
  credits_used: Decimal;
  total: Decimal;
  minutes?: number;
  breakdown?: T[] | null;
}

export interface UsageSummary {
  dedicated_usage?: UsageBlock<DedicatedItem> | null;
  training_usage?: UsageBlock<TrainingItem> | null;
  model_apis_usage?: UsageBlock<ModelApiItem> | null;
}

// ── Metrics ─────────────────────────────────────────────────────────────

export interface MetricDescriptor {
  name: string;
  unit_hint?: "PER_SECOND" | "SECONDS" | "BYTES" | "MEBIBYTES" | "COUNT" | "RATIO" | string;
  kind?: "GAUGE" | "COUNTER" | "HISTOGRAM" | string;
  label_sets?: Array<Record<string, string>>;
}

export interface MetricsResponse {
  start_epoch_millis?: number;
  end_epoch_millis?: number;
  mode?: string;
  step_seconds?: number | null;
  metric_descriptors?: MetricDescriptor[];
  metric_values?: Array<{
    start_epoch_millis: number;
    values: Array<Array<number | null> | null>;
  }>;
}

export interface ModelApiUsageResponse {
  items?: Array<{
    start_time: string;
    end_time?: string;
    results?: Array<{
      model?: string | null;
      input_tokens?: number;
      cached_input_tokens?: number;
      uncached_input_tokens?: number;
      output_tokens?: number;
      request_count?: number;
    }>;
  }>;
  pagination?: BasetenPagination;
}

export interface TrainingMetricPoint {
  value: number;
  timestamp: string;
}

export interface TrainingJobMetrics {
  gpu_memory_usage_bytes?: Record<string, TrainingMetricPoint[]> | null;
  gpu_utilization?: Record<string, TrainingMetricPoint[]> | null;
  cpu_usage?: TrainingMetricPoint[] | null;
  cpu_memory_usage_bytes?: TrainingMetricPoint[] | null;
}
