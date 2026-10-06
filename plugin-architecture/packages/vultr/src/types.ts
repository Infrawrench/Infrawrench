/**
 * Wire shapes for the Vultr API v2, trimmed to the fields the plugin reads.
 * Field names follow `vultr/govultr` v3.33.1 (2026-10-05), which tracks the
 * API reference; every field is optional because the API omits keys freely.
 */

export interface VultrRegion {
  id: string;
  city?: string;
  country?: string;
  continent?: string;
  options?: string[];
  connectivity?: string[];
}

export interface VultrPlanLocationCost {
  monthly_cost?: number;
  hourly_cost?: number;
}

export interface VultrPlan {
  id: string;
  vcpu_count?: number;
  ram?: number;
  disk?: number;
  disk_count?: number;
  bandwidth?: number;
  monthly_cost?: number;
  hourly_cost?: number;
  type?: string;
  locations?: string[];
  location_cost?: Record<string, VultrPlanLocationCost>;
  gpu_vram_gb?: number;
  gpu_type?: string;
  gpu_count?: number;
  deploy_ondemand?: boolean;
}

export interface VultrBareMetalPlan {
  id: string;
  cpu_count?: number;
  cpu_threads?: number;
  cpu_model?: string;
  ram?: number;
  disk?: number;
  disk_count?: number;
  monthly_cost?: number;
  type?: string;
  locations?: string[];
}

export interface VultrOs {
  id: number;
  name?: string;
  arch?: string;
  family?: string;
}

export interface VultrApplication {
  id: number;
  name?: string;
  short_name?: string;
  deploy_name?: string;
  type?: string;
  vendor?: string;
  image_id?: string;
}

export interface VultrInstance {
  id: string;
  os?: string;
  ram?: number;
  disk?: number;
  plan?: string;
  main_ip?: string;
  vpc_only?: boolean;
  vcpu_count?: number;
  region?: string;
  date_created?: string;
  status?: string;
  allowed_bandwidth?: number;
  power_status?: string;
  server_status?: string;
  v6_main_ip?: string;
  v6_network?: string;
  label?: string;
  internal_ip?: string;
  kvm?: string;
  os_id?: number;
  app_id?: number;
  image_id?: string;
  firewall_group_id?: string;
  features?: string[];
  hostname?: string;
  tags?: string[];
  user_scheme?: string;
  default_password?: string;
}

export interface VultrBareMetal {
  id: string;
  os?: string;
  ram?: string;
  disk?: string;
  main_ip?: string;
  cpu_count?: number;
  region?: string;
  date_created?: string;
  status?: string;
  power_status?: string;
  server_status?: string;
  label?: string;
  plan?: string;
  v6_main_ip?: string;
  tags?: string[];
  mac_address?: number;
}

export interface VultrBlock {
  id: string;
  date_created?: string;
  cost?: number;
  pending_charges?: number;
  status?: string;
  size_gb?: number;
  region?: string;
  attached_to_instance?: string;
  attached_to_instance_label?: string;
  attached_to_instance_ip?: string;
  label?: string;
  mount_id?: string;
  block_type?: string;
  bootable?: boolean;
}

export interface VultrSnapshot {
  id: string;
  date_created?: string;
  description?: string;
  size?: number;
  compressed_size?: number;
  status?: string;
  os_id?: number;
  app_id?: number;
}

export interface VultrBackup {
  id: string;
  date_created?: string;
  description?: string;
  size?: number;
  status?: string;
}

export interface VultrReservedIp {
  id: string;
  region?: string;
  ip_type?: string;
  subnet?: string;
  subnet_size?: number;
  label?: string;
  instance_id?: string;
}

export interface VultrFirewallGroup {
  id: string;
  description?: string;
  date_created?: string;
  date_modified?: string;
  instance_count?: number;
  rule_count?: number;
  max_rule_count?: number;
}

export interface VultrFirewallRule {
  id: number;
  action?: string;
  ip_type?: string;
  protocol?: string;
  port?: string;
  subnet?: string;
  subnet_size?: number;
  source?: string;
  notes?: string;
}

export interface VultrVpc {
  id: string;
  region?: string;
  description?: string;
  v4_subnet?: string;
  v4_subnet_mask?: number;
  date_created?: string;
}

export interface VultrVpcAttachment {
  id: string;
  type?: string;
  mac_address?: string;
  ip?: { v4?: string };
}

export interface VultrDomain {
  domain: string;
  date_created?: string;
  dns_sec?: string;
}

export interface VultrDomainRecord {
  id: string;
  type?: string;
  name?: string;
  data?: string;
  priority?: number;
  ttl?: number;
}

export interface VultrNodePool {
  id: string;
  date_created?: string;
  label?: string;
  plan?: string;
  status?: string;
  node_quantity?: number;
  min_nodes?: number;
  max_nodes?: number;
  auto_scaler?: boolean;
  tag?: string;
  nodes?: Array<{
    id: string;
    label?: string;
    status?: string;
    date_created?: string;
    ip?: string;
  }>;
}

export interface VultrKubernetesCluster {
  id: string;
  label?: string;
  date_created?: string;
  cluster_subnet?: string;
  service_subnet?: string;
  ip?: string;
  endpoint?: string;
  version?: string;
  region?: string;
  status?: string;
  ha_controlplanes?: boolean;
  firewall_group_id?: string;
  node_pools?: VultrNodePool[];
}

export interface VultrLoadBalancer {
  id: string;
  date_created?: string;
  region?: string;
  label?: string;
  status?: string;
  ipv4?: string;
  ipv6?: string;
  instances?: string[];
  nodes?: number;
  has_ssl?: boolean;
  http2?: boolean;
  http3?: boolean;
  health_check?: {
    protocol?: string;
    port?: number;
    path?: string;
    check_interval?: number;
    response_timeout?: number;
    unhealthy_threshold?: number;
    healthy_threshold?: number;
  };
  generic_info?: {
    balancing_algorithm?: string;
    ssl_redirect?: boolean;
    sticky_sessions?: { cookie_name?: string };
    proxy_protocol?: boolean;
    timeout?: number;
    vpc?: string;
  };
  forwarding_rules?: Array<{
    id?: string;
    frontend_protocol?: string;
    frontend_port?: number;
    backend_protocol?: string;
    backend_port?: number;
  }>;
  firewall_rules?: Array<{ id?: string; port?: number; ip_type?: string; source?: string }>;
}

export interface VultrDatabase {
  id: string;
  date_created?: string;
  plan?: string;
  plan_disk?: number;
  plan_ram?: number;
  plan_vcpus?: number;
  plan_replicas?: number;
  plan_brokers?: number;
  region?: string;
  database_engine?: string;
  database_engine_version?: string;
  vpc_id?: string;
  status?: string;
  label?: string;
  tag?: string;
  dbname?: string;
  host?: string;
  public_host?: string;
  port?: string;
  sasl_port?: string;
  user?: string;
  password?: string;
  maintenance_dow?: string;
  maintenance_time?: string;
  latest_backup?: string;
  trusted_ips?: string[];
  ca_certificate?: string;
  read_replicas?: VultrDatabase[];
}

export interface VultrDatabasePlan {
  id: string;
  number_of_nodes?: number;
  type?: string;
  vcpu_count?: number;
  ram?: number;
  disk?: number;
  monthly_cost?: number;
  supported_engines?: { mysql?: boolean; pg?: boolean; valkey?: boolean; kafka?: boolean };
  locations?: string[];
}

export interface VultrDatabaseUser {
  username: string;
  password?: string;
  encryption?: string;
  permission?: string;
}

export interface VultrObjectStorage {
  id: string;
  date_created?: string;
  cluster_id?: number;
  region?: string;
  location?: string;
  label?: string;
  status?: string;
  s3_hostname?: string;
  s3_access_key?: string;
  s3_secret_key?: string;
  tier?: { sales_name?: string; slug?: string; price?: number };
}

export interface VultrObjectStorageCluster {
  id: number;
  region?: string;
  hostname?: string;
  deploy?: string;
}

export interface VultrObjectStorageTier {
  id: number;
  sales_name?: string;
  sales_desc?: string;
  price?: number;
  bw_gb_price?: number;
  disk_gb_price?: number;
  slug?: string;
  is_default?: string;
  locations?: VultrObjectStorageCluster[];
}

export interface VultrSshKey {
  id: string;
  name?: string;
  ssh_key?: string;
  date_created?: string;
}

export interface VultrStartupScript {
  id: string;
  name?: string;
  type?: string;
  script?: string;
  date_created?: string;
  date_modified?: string;
}

export interface VultrAccount {
  name?: string;
  email?: string;
  acls?: string[];
  balance?: number;
  pending_charges?: number;
  last_payment_date?: string;
  last_payment_amount?: number;
}

export interface VultrInvoice {
  id: number;
  date?: string;
  description?: string;
  amount?: number;
  balance?: number;
}

export interface VultrInvoiceItem {
  description?: string;
  product?: string;
  start_date?: string;
  end_date?: string;
  units?: number;
  unit_type?: string;
  unit_price?: number;
  total?: number;
}
