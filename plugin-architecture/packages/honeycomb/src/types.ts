/**
 * Wire types for the Honeycomb API, from Honeycomb's published OpenAPI
 * document (`https://docs.honeycomb.io/api/openapi-public.yaml`, 2026-10) and
 * the official Go client in honeycombio/terraform-provider-honeycombio.
 * Every field is optional here because listers must survive partial bodies.
 */

export interface HnyAuth {
  id?: string;
  type?: "configuration" | "ingest" | string;
  api_key_access?: Record<string, boolean | undefined>;
  environment?: { name?: string; slug?: string };
  team?: { name?: string; slug?: string };
}

export interface HnyAuthV2 {
  data?: {
    id?: string;
    attributes?: {
      name?: string;
      key_type?: string;
      disabled?: boolean;
      scopes?: string[];
    };
    relationships?: { team?: { data?: { id?: string } } };
  };
  included?: Array<{ id?: string; type?: string; attributes?: { name?: string; slug?: string } }>;
}

export interface HnyEnvironmentAttrs {
  name?: string;
  slug?: string;
  description?: string;
  color?: string;
  settings?: { delete_protected?: boolean };
}

export interface HnyApiKeyAttrs {
  name?: string;
  key_type?: "ingest" | "configuration" | string;
  disabled?: boolean;
  secret?: string;
  permissions?: Record<string, boolean | undefined>;
  timestamps?: { created?: string; updated?: string };
}

export interface HnyDataset {
  name?: string;
  slug?: string;
  description?: string;
  expand_json_depth?: number;
  settings?: { delete_protected?: boolean };
  regular_columns_count?: number | null;
  last_written_at?: string | null;
  created_at?: string;
  dataset_type?: string;
}

export interface HnyDefinitionColumn {
  name?: string;
  column_type?: string;
}

export type HnyDatasetDefinitions = Record<string, HnyDefinitionColumn | null | undefined>;

export interface HnyColumn {
  id?: string;
  key_name?: string;
  type?: string;
  description?: string;
  hidden?: boolean;
  last_written?: string;
  created_at?: string;
  updated_at?: string;
}

export interface HnyDerivedColumn {
  id?: string;
  alias?: string;
  expression?: string;
  description?: string;
}

export interface HnyTag {
  key?: string;
  value?: string;
}

export interface HnyNotificationRecipient {
  id?: string;
  type?: string;
  target?: string;
  details?: { pagerduty_severity?: string; muted?: boolean };
}

export interface HnyQuerySpec {
  id?: string;
  calculations?: Array<{
    op?: string;
    column?: string | null;
    name?: string | null;
    filters?: HnyFilter[];
    filter_combination?: string;
  }>;
  filters?: HnyFilter[];
  filter_combination?: string;
  breakdowns?: string[];
  orders?: Array<{ column?: string; op?: string; order?: string }>;
  havings?: unknown[];
  limit?: number;
  time_range?: number;
  start_time?: number;
  end_time?: number;
  granularity?: number;
  calculated_fields?: Array<{ name?: string; expression?: string }>;
  formulas?: Array<{ name?: string; expression?: string }>;
  compare_time_offset_seconds?: number;
  usage_mode?: boolean;
}

export interface HnyFilter {
  column?: string | null;
  op?: string;
  value?: unknown;
}

export interface HnyTrigger {
  id?: string;
  dataset_slug?: string;
  name?: string;
  description?: string;
  tags?: HnyTag[];
  threshold?: { op?: string; value?: number; exceeded_limit?: number };
  frequency?: number;
  alert_type?: string;
  disabled?: boolean;
  triggered?: boolean;
  recipients?: HnyNotificationRecipient[];
  evaluation_schedule_type?: string;
  evaluation_schedule?: unknown;
  created_at?: string;
  updated_at?: string;
  baseline_details?: unknown;
  auto_investigate?: boolean;
  query?: HnyQuerySpec;
  query_id?: string;
}

export interface HnySlo {
  id?: string;
  name?: string;
  description?: string;
  sli?: { alias?: string };
  time_period_days?: number;
  target_per_million?: number;
  tags?: HnyTag[];
  reset_at?: string | null;
  created_at?: string;
  updated_at?: string;
  dataset_slugs?: string[];
  compliance?: number;
  budget_remaining?: number;
  status?: string;
  burn_rate?: number;
}

export interface HnyBurnAlert {
  id?: string;
  description?: string;
  triggered?: boolean;
  created_at?: string;
  updated_at?: string;
  auto_investigate?: boolean;
  alert_type?: "exhaustion_time" | "budget_rate" | string;
  exhaustion_minutes?: number;
  budget_rate_window_minutes?: number;
  budget_rate_decrease_threshold_per_million?: number;
  slo?: { id?: string };
  recipients?: HnyNotificationRecipient[];
}

export interface HnyBoard {
  id?: string;
  name?: string;
  description?: string;
  type?: string;
  links?: { board_url?: string };
  panels?: Array<{ type?: string }>;
  layout_generation?: string;
  tags?: HnyTag[];
  preset_filters?: Array<{ column?: string; alias?: string }>;
}

export interface HnyBoardView {
  id?: string;
  name?: string;
  filters?: Array<{ column?: string; operation?: string; value?: unknown }>;
}

export interface HnyMarker {
  id?: string;
  start_time?: number;
  end_time?: number;
  message?: string;
  type?: string;
  url?: string;
  created_at?: string;
  updated_at?: string;
  color?: string;
}

export interface HnyMarkerSetting {
  id?: string;
  type?: string;
  color?: string;
  created_at?: string;
  updated_at?: string;
}

export interface HnyRecipient {
  id?: string;
  type?: string;
  created_at?: string;
  updated_at?: string;
  details?: {
    email_address?: string;
    slack_channel?: string;
    pagerduty_integration_name?: string;
    pagerduty_integration_key?: string;
    webhook_name?: string;
    webhook_url?: string;
    webhook_secret?: string;
    webhook_headers?: unknown[];
    webhook_payloads?: unknown;
  };
}

export interface HnyQueryAnnotation {
  id?: string;
  name?: string;
  description?: string;
  query_id?: string;
  created_at?: string;
  updated_at?: string;
  source?: string;
}

export interface HnySignal {
  id?: string;
  service_name?: string;
  dataset_slug?: string;
  environment_slug?: string;
  measured_signal?: string;
  enabled?: boolean;
  status?: string;
  sensitivity?: string | null;
  currently_anomalous?: boolean;
  last_anomaly_started_at?: number | null;
  last_anomaly_ended_at?: number | null;
  created_at?: string;
  updated_at?: string;
}

export interface HnyQueryResult {
  id?: string;
  complete?: boolean;
  error?: string;
  data?: {
    series?: Array<{ time?: string; data?: Record<string, unknown> }>;
    results?: Array<{ data?: Record<string, unknown> }>;
  };
  links?: { query_url?: string; graph_image_url?: string };
}

export interface HnySloHistory {
  slo_id?: string;
  resolution_seconds?: number;
  buckets?: Array<{
    start_time?: number;
    end_time?: number;
    total_count?: number;
    error_count?: number;
    is_partial?: boolean;
  }>;
}
