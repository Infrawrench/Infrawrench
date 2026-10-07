/** Wire shapes from the Tiger Cloud OpenAPI document (tiger-cli `openapi.yaml`, 2026-10). */

export interface TgProject {
  id: string;
  name?: string;
}

export interface TgEndpoint {
  host?: string;
  port?: number;
}

export interface TgReadReplicaSet {
  id: string;
  name?: string;
  status?: string;
  nodes?: number;
  cpu_millis?: number;
  memory_gbs?: number;
  metadata?: { environment?: string };
  endpoint?: TgEndpoint;
  connection_pooler?: { endpoint?: TgEndpoint };
}

export interface TgService {
  service_id: string;
  project_id: string;
  name?: string;
  region_code?: string;
  service_type?: string;
  created?: string;
  initial_password?: string;
  status?: string;
  resources?: Array<{
    id?: string;
    spec?: { cpu_millis?: number; memory_gbs?: number; volume_type?: string };
  }>;
  metrics?: {
    memory_mb?: number | null;
    storage_mb?: number | null;
    milli_cpu?: number | null;
  } | null;
  metadata?: { environment?: string };
  endpoint?: TgEndpoint;
  vpc_endpoint?: TgEndpoint & { vpc_id?: string };
  vpcEndpoint?: TgEndpoint & { vpc_id?: string };
  forked_from?: { project_id?: string; service_id?: string; is_standby?: boolean };
  ha_replicas?: { sync_replica_count?: number; replica_count?: number };
  connection_pooler?: { endpoint?: TgEndpoint };
  data_tiering?: { enabled?: boolean };
  read_replica_sets?: TgReadReplicaSet[];
  metric_exporter_id?: string;
  log_exporter_id?: string;
}

export interface TgVpc {
  id: string;
  name?: string;
  cidr?: string;
  region_code?: string;
}

export interface TgPeering {
  id: string;
  peer_account_id?: string;
  peer_region_code?: string;
  peer_vpc_id?: string;
  provisioned_id?: string;
  status?: string;
  error_message?: string;
}

export type TgExporterType =
  | "CLOUDWATCH_LOGS"
  | "CLOUDWATCH_METRICS"
  | "DATADOG_METRICS"
  | "PROMETHEUS_METRICS"
  | "AZURE_MONITOR_METRICS";

export interface TgExporter {
  exporter_id: string;
  project_id?: string;
  name?: string;
  type?: TgExporterType | string;
  region_code?: string;
  created?: string;
  config?: {
    include_pg_metrics?: boolean;
    log_group_name?: string;
    log_stream_name?: string;
    aws_region?: string;
    namespace?: string;
    site?: string;
    username?: string;
    endpoint?: string;
    credentials?: { type?: string; aws_role_arn?: string; aws_access_key?: string };
  };
}

export interface TgAllowList {
  allow_list_id: string;
  project_id?: string;
  description?: string;
  cidr_blocks?: string[];
  created_at?: string;
}

export interface TgBackup {
  label: string;
  type?: string;
  started_at?: string;
  finished_at?: string;
  duration_seconds?: number;
  size_bytes?: number;
  regions?: Array<{ region_code?: string; status?: string }>;
}

export interface TgBackupRegion {
  region_code: string;
  created?: string;
}

export interface TgLogs {
  logs?: string[];
  entries?: Array<{ timestamp?: string; message?: string; severity?: string }>;
  last_cursor?: string;
}

export interface TgMetricSeries {
  labels?: Record<string, string>;
  data?: Array<{ time?: string; value?: number | null }>;
}
