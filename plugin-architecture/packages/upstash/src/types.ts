/** Slices of Upstash API objects this plugin reads. Everything is optional. */

export interface Point {
  x?: string;
  y?: number;
}

export interface UpRedis {
  database_id?: string;
  database_name?: string;
  region?: string;
  port?: number;
  creation_time?: number;
  state?: string;
  endpoint?: string;
  tls?: boolean;
  password?: string;
  rest_token?: string;
  read_only_rest_token?: string;
  type?: string;
  budget?: number;
  primary_region?: string;
  read_regions?: string[];
  all_members?: string[];
  eviction?: boolean;
  auto_upgrade?: boolean;
  modifying_state?: string;
  db_disk_threshold?: number;
  db_memory_threshold?: number;
  db_max_clients?: number;
  db_max_commands_per_second?: number;
  db_max_request_size?: number;
  db_max_entry_size?: number;
  db_request_limit?: number;
  db_resource_size?: string;
  customer_id?: string;
  daily_backup_enabled?: boolean;
  prod_pack_enabled?: boolean;
  securityAddons?: Record<string, boolean | undefined>;
}

export interface UpRedisStats {
  connection_count?: Point[];
  keyspace?: Point[];
  throughput?: Point[];
  diskusage?: Point[];
  latencymean?: Point[];
  latency_99?: Point[];
  hits?: Point[];
  misses?: Point[];
  read?: Point[];
  write?: Point[];
  bandwidths?: Point[];
  dailybilling?: Point[];
  daily_net_commands?: number;
  total_monthly_requests?: number;
  total_monthly_bandwidth?: number;
  current_storage?: number;
  total_monthly_billing?: number;
}

export interface UpBackup {
  backup_id?: string;
  name?: string;
  creation_time?: number;
  state?: string;
  backup_size?: number;
  daily_backup?: string;
}

export interface UpVector {
  id?: string;
  name?: string;
  customer_id?: string;
  similarity_function?: string;
  dimension_count?: number;
  embedding_model?: string;
  sparse_embedding_model?: string;
  index_type?: string;
  endpoint?: string;
  token?: string;
  read_only_token?: string;
  type?: string;
  region?: string;
  max_vector_count?: number;
  max_daily_queries?: number;
  max_daily_updates?: number;
  reserved_price?: number;
  creation_time?: number;
}

export interface UpSearch {
  id?: string;
  name?: string;
  customer_id?: string;
  endpoint?: string;
  type?: string;
  region?: string;
  token?: string;
  read_only_token?: string;
  max_vector_count?: number;
  max_daily_queries?: number;
  max_daily_updates?: number;
  creation_time?: number;
  input_enrichment_enabled?: boolean;
}

export interface UpIndexStats {
  current_vector_count?: number;
  pending_index_count?: number;
  daily_query_count?: number;
  daily_update_count?: number;
  monthly_query_count?: number;
  monthly_update_count?: number;
  monthly_bandwidth_usage?: number;
  storage_usage?: number;
  monthly_cost?: number;
  query_throughput?: Point[];
  update_throughput?: Point[];
  query_latency_mean?: Point[];
  query_latency_99?: Point[];
  update_latency_mean?: Point[];
  vector_count?: Point[];
  data_size?: Point[];
}

export interface UpQStashUser {
  id?: string;
  customer_id?: string;
  token?: string;
  read_only_token?: string;
  active?: boolean;
  state?: string;
  type?: string;
  region?: string;
  reserved_type?: string;
  reserved_price?: number;
  budget?: number;
  prod_pack_enabled?: boolean;
  max_requests_per_day?: number;
  max_requests_per_second?: number;
  max_message_size?: number;
  max_topics?: number;
  max_schedules?: number;
  max_queues?: number;
  max_dlq_size?: number;
  max_retries?: number;
  max_delay?: number;
  max_parallelism?: number;
  timeout?: number;
  creation_time?: number;
  deletion_time?: number;
}

export interface UpQStashStats {
  daily_requests?: Point[];
  daily_billings?: Point[];
  daily_bandwidths?: Point[];
  daily_used?: Point[];
}

export interface UpSchedule {
  scheduleId?: string;
  cron?: string;
  destination?: string;
  createdAt?: number;
  method?: string;
  body?: string;
  retries?: number;
  delay?: number;
  callback?: string;
  failureCallback?: string;
  isPaused?: boolean;
  label?: string;
  labels?: string[];
  lastScheduleTime?: number;
  nextScheduleTime?: number;
}

export interface UpQueue {
  name?: string;
  createdAt?: number;
  updatedAt?: number;
  parallelism?: number;
  paused?: boolean;
  lag?: number;
}

export interface UpUrlGroup {
  name?: string;
  createdAt?: number;
  updatedAt?: number;
  endpoints?: Array<{ name?: string; url?: string }>;
}

export interface UpDlqMessage {
  dlqId?: string;
  messageId?: string;
  url?: string;
  topicName?: string;
  queueName?: string;
  scheduleId?: string;
  method?: string;
  createdAt?: number;
  responseStatus?: number;
  responseBody?: string;
}

export interface UpLog {
  time?: number;
  messageId?: string;
  state?: string;
  error?: string;
  url?: string;
  topicName?: string;
  queueName?: string;
  scheduleId?: string;
  responseStatus?: number;
}

export interface UpTeam {
  team_id?: string;
  team_name?: string;
  copy_cc?: boolean;
}

export interface UpTeamMember {
  team_id?: string;
  member_email?: string;
  member_role?: string;
}

export interface UpAuditLog {
  timestamp?: number;
  actor?: string;
  action_string?: string;
  readable_format?: string;
  source?: string;
  entity?: string;
  ip?: string;
}
