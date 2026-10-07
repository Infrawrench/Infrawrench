/** Slices of Aiven API objects this plugin reads. Everything is optional. */

export interface AvProject {
  project_name?: string;
  account_id?: string;
  organization_id?: string;
  billing_group_id?: string;
  billing_group_name?: string;
  billing_currency?: string;
  default_cloud?: string;
  estimated_balance?: string;
  payment_method?: string;
  tags?: Record<string, string>;
  tech_emails?: Array<{ email?: string }>;
  trial_expiration_time?: string;
}

export interface AvComponent {
  component?: string;
  host?: string;
  port?: number;
  route?: string;
  usage?: string;
  ssl?: boolean;
  kafka_authentication_method?: string;
}

export interface AvServiceUser {
  username?: string;
  password?: string;
  type?: string;
  authentication?: string;
  access_cert?: string;
  access_key?: string;
  access_cert_not_valid_after_time?: string;
  password_updated_time?: string;
}

export interface AvIntegration {
  service_integration_id?: string;
  integration_type?: string;
  source_service?: string;
  source_project?: string;
  dest_service?: string;
  dest_project?: string;
  dest_endpoint?: string;
  source_endpoint?: string;
  enabled?: boolean;
  active?: boolean;
  description?: string;
}

export interface AvPool {
  pool_name?: string;
  database?: string;
  username?: string;
  pool_mode?: string;
  pool_size?: number;
  connection_uri?: string;
}

export interface AvService {
  service_name?: string;
  service_type?: string;
  service_type_description?: string;
  plan?: string;
  cloud_name?: string;
  cloud_description?: string;
  state?: string;
  node_count?: number;
  node_cpu_count?: number;
  node_memory_mb?: number;
  disk_space_mb?: number;
  project_vpc_id?: string | null;
  service_uri?: string | null;
  service_uri_params?: Record<string, string>;
  termination_protection?: boolean;
  create_time?: string;
  update_time?: string;
  maintenance?: {
    dow?: string;
    time?: string;
    updates?: Array<{ description?: string; deadline?: string; start_after?: string }>;
  };
  metadata?: Record<string, unknown>;
  user_config?: Record<string, unknown>;
  components?: AvComponent[];
  users?: AvServiceUser[];
  databases?: string[];
  connection_pools?: AvPool[];
  acl?: Array<{ id?: string; permission?: string; topic?: string; username?: string }>;
  service_integrations?: AvIntegration[];
  tags?: Record<string, string>;
  backups?: Array<{ backup_name?: string; backup_time?: string; data_size?: number }>;
  node_states?: Array<{ name?: string; role?: string; state?: string }>;
}

export interface AvTopic {
  topic_name?: string;
  partitions?: number;
  replication?: number;
  retention_hours?: number;
  retention_bytes?: number;
  cleanup_policy?: string;
  min_insync_replicas?: number;
  state?: string;
  topic_description?: string;
}

export interface AvConnector {
  name?: string;
  config?: Record<string, string>;
  plugin?: { class?: string; title?: string; type?: string; version?: string };
  tasks?: Array<{ task?: number }>;
}

export interface AvConnectorStatus {
  state?: string;
  tasks?: Array<{ id?: number; state?: string; trace?: string }>;
}

export interface AvVpc {
  project_vpc_id?: string;
  cloud_name?: string;
  network_cidr?: string;
  state?: string;
  create_time?: string;
  peering_connections?: AvPeering[];
}

export interface AvPeering {
  peer_cloud_account?: string;
  peer_vpc?: string;
  peer_region?: string | null;
  peer_resource_group?: string | null;
  state?: string;
  state_info?: { message?: string };
  user_peer_network_cidrs?: string[];
  create_time?: string;
}

export interface AvBillingGroup {
  billing_group_id?: string;
  billing_group_name?: string;
  billing_currency?: string;
  billing_type?: string;
  account_name?: string;
  estimated_balance_usd?: string;
  estimated_balance_local?: string;
  payment_method?: string;
  billing_emails?: Array<{ email?: string }>;
}

export interface AvInvoice {
  invoice_number?: string;
  period_begin?: string;
  period_end?: string;
  state?: string;
  currency?: string;
  total_inc_vat?: string;
  total_vat_zero?: string;
}

export interface AvInvoiceLine {
  description?: string;
  line_total_usd?: string;
  line_type?: string;
  project_name?: string;
  service_name?: string;
  service_type?: string;
  service_plan?: string;
  cloud_name?: string;
  tags?: Record<string, string>;
  timestamp_begin?: string;
  timestamp_end?: string;
}

export interface AvCredit {
  code?: string;
  type?: string;
  value?: string;
  remaining_value?: string;
  expire_time?: string;
}

export interface AvPlan {
  service_plan?: string;
  service_type?: string;
  node_count?: number;
  regions?: Record<string, { price_usd?: string; disk_space_mb?: number; node_memory_mb?: number }>;
}

export interface AvCloud {
  cloud_name?: string;
  cloud_description?: string;
  geo_region?: string;
  provider?: string;
}

export interface AvMetric {
  data?: {
    cols?: Array<{ label?: string; type?: string }>;
    rows?: Array<unknown[] | { c?: Array<{ v?: unknown } | null> }>;
  };
  hints?: { title?: string };
}
