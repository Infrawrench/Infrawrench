/** Wire shapes from the Pinecone `2026-07` specs. Only the fields this plugin reads. */

export interface PcPagination {
  next?: string;
}

export interface PcSchemaField {
  type?: string;
  description?: string | null;
  dimension?: number | null;
  metric?: string;
  model?: string;
  filterable?: boolean;
  full_text_search?: { language?: string; stemming?: boolean; stop_words?: boolean } | null;
  write_parameters?: Record<string, unknown> | null;
  read_parameters?: Record<string, unknown> | null;
}

export interface PcDeployment {
  deployment_type?: "managed" | "pod" | "byoc" | string;
  cloud?: string;
  region?: string;
  environment?: string;
  replicas?: number;
  shards?: number;
  pod_type?: string;
}

export interface PcReadCapacity {
  mode?: "OnDemand" | "Dedicated" | string;
  dedicated?: {
    node_type?: string;
    scaling?: string;
    manual?: { replicas?: number; shards?: number };
  };
  status?: {
    state?: string;
    current_replicas?: number | null;
    current_shards?: number | null;
    error_message?: string;
  };
}

export interface PcIndex {
  name: string;
  host?: string;
  private_host?: string;
  status?: { ready?: boolean; state?: string };
  deployment?: PcDeployment;
  read_capacity?: PcReadCapacity;
  source_collection?: string;
  source_backup_id?: string;
  cmek_id?: string;
  schema?: { fields?: Record<string, PcSchemaField> };
  tags?: Record<string, string> | null;
  deletion_protection?: "enabled" | "disabled" | string;
}

export interface PcIndexStats {
  namespaces?: Record<string, { vectorCount?: number }>;
  dimension?: number;
  indexFullness?: number;
  totalVectorCount?: number;
  metric?: string;
  vectorType?: string;
  memoryFullness?: number;
  storageFullness?: number;
}

export interface PcCollection {
  name: string;
  size?: number;
  status?: string;
  dimension?: number;
  vector_count?: number;
  environment?: string;
}

export interface PcBackup {
  backup_id: string;
  source_index_name?: string;
  source_index_id?: string;
  source_index_deleted_at?: string;
  name?: string;
  description?: string;
  status?: string;
  cloud?: string;
  region?: string;
  record_count?: number;
  namespace_count?: number;
  size_bytes?: number;
  tags?: Record<string, string> | null;
  created_at?: string;
}

export interface PcBackupSchedule {
  schedule_id: string;
  name?: string;
  index_id?: string;
  project_id?: string;
  schedule_type?: string;
  frequency?: string;
  retention_expire_after_days?: number;
  enabled?: boolean;
  next_scheduled_run?: string | null;
  created_at?: string;
}

export interface PcRestoreJob {
  restore_job_id: string;
  backup_id?: string;
  target_index_name?: string;
  target_index_id?: string;
  status?: string;
  created_at?: string | null;
  completed_at?: string | null;
  percent_complete?: number;
}

export interface PcAssistant {
  name: string;
  instructions?: string | null;
  metadata?: Record<string, unknown> | null;
  status?: string;
  host?: string;
  region?: string;
  created_at?: string;
  updated_at?: string;
}

export interface PcAssistantFile {
  name?: string;
  id?: string;
  status?: string;
  size?: number;
  created_on?: string;
  percent_done?: number;
}

export interface PcModel {
  model: string;
  short_description?: string;
  type?: string;
  vector_type?: string;
  default_dimension?: number;
  supported_dimensions?: number[];
  supported_metrics?: string[];
  provider_name?: string;
}

export interface PcProject {
  id: string;
  name: string;
  max_pods?: number;
  force_encryption_with_cmek?: boolean;
  organization_id?: string;
  created_at?: string;
}

export interface PcApiKey {
  id: string;
  name: string;
  project_id: string;
  roles?: string[];
}

export interface PcServiceAccount {
  id: string;
  name: string;
  client_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface PcPrometheusTarget {
  targets?: string[];
  labels?: Record<string, string>;
}
