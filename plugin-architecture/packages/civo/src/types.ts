/**
 * Wire shapes for the Civo API v2, trimmed to the fields the plugin reads.
 * Field names follow `civo/civogo` (2026-08-31), which tracks the API.
 */

export interface CivoRegion {
  code: string;
  name?: string;
  type?: string;
  out_of_capacity?: boolean;
  country?: string;
  country_name?: string;
  default?: boolean;
  features?: {
    iaas?: boolean;
    kubernetes?: boolean;
    object_store?: boolean;
    loadbalancer?: boolean;
    dbaas?: boolean;
    volume?: boolean;
    gpu?: boolean;
  };
}

export interface CivoSize {
  type?: string;
  name: string;
  nice_name?: string;
  cpu_cores?: number;
  gpu_count?: number;
  gpu_type?: string;
  ram_mb?: number;
  disk_gb?: number;
  transfer_tb?: number;
  description?: string;
  selectable?: boolean;
}

export interface CivoDiskImage {
  id: string;
  name?: string;
  version?: string;
  state?: string;
  distribution?: string;
  label?: string;
  initial_user?: string;
  distribution_default?: boolean;
}

export interface CivoInstance {
  id: string;
  hostname?: string;
  reverse_dns?: string;
  size?: string;
  region?: string;
  network_id?: string;
  private_ip?: string;
  public_ip?: string;
  ipv6?: string;
  source_type?: string;
  source_id?: string;
  initial_user?: string;
  initial_password?: string;
  ssh_key_id?: string;
  status?: string;
  notes?: string;
  firewall_id?: string;
  tags?: string[];
  cpu_cores?: number;
  ram_mb?: number;
  disk_gb?: number;
  gpu_count?: number;
  gpu_type?: string;
  created_at?: string;
  reserved_ip_id?: string;
  reserved_ip?: string;
  attached_volumes?: Array<{ id: string }>;
  network_bandwidth_limit?: number;
  allowed_ips?: string[];
}

export interface CivoVolume {
  id: string;
  name?: string;
  instance_id?: string;
  cluster_id?: string;
  network_id?: string;
  mountpoint?: string;
  status?: string;
  volume_type?: string;
  size_gb?: number;
  bootable?: boolean;
  created_at?: string;
}

export interface CivoVolumeSnapshot {
  name?: string;
  snapshot_id: string;
  snapshot_description?: string;
  volume_id?: string;
  instance_id?: string;
  source_volume_name?: string;
  restore_size?: number;
  state?: string;
  creation_time?: string;
}

export interface CivoInstanceSnapshot {
  id: string;
  name?: string;
  description?: string;
  included_volumes?: string[];
  status?: { state?: string };
  created_at?: string;
}

export interface CivoNetwork {
  id: string;
  name?: string;
  label?: string;
  default?: boolean;
  cidr?: string;
  status?: string;
  ipv4_enabled?: boolean;
  ipv6_enabled?: boolean;
  nameservers_v4?: string[];
  free_ip_count?: number;
}

export interface CivoFirewallRule {
  id?: string;
  firewall_id?: string;
  protocol?: string;
  start_port?: string;
  end_port?: string;
  cidr?: string[];
  direction?: string;
  action?: string;
  label?: string;
  ports?: string;
}

export interface CivoFirewall {
  id: string;
  name?: string;
  rules_count?: number;
  instance_count?: number;
  cluster_count?: number;
  loadbalancer_count?: number;
  network_id?: string;
  rules?: CivoFirewallRule[];
}

export interface CivoIp {
  id: string;
  name?: string;
  ip?: string;
  assigned_to?: { id?: string; type?: string; name?: string };
}

export interface CivoPoolInstance {
  id?: string;
  hostname?: string;
  size?: string;
  status?: string;
  public_ip?: string;
  cpu_cores?: number;
  ram_mb?: number;
  disk_gb?: number;
}

export interface CivoPool {
  id: string;
  count?: number;
  size?: string;
  instance_names?: string[];
  instances?: CivoPoolInstance[];
  labels?: Record<string, string>;
  public_ip_node_pool?: boolean;
}

export interface CivoCluster {
  id: string;
  name?: string;
  version?: string;
  status?: string;
  ready?: boolean;
  cluster_type?: string;
  num_target_nodes?: number;
  target_nodes_size?: string;
  kubeconfig?: string;
  kubernetes_version?: string;
  api_endpoint?: string;
  master_ip?: string;
  dns_entry?: string;
  upgrade_available_to?: string;
  network_id?: string;
  firewall_id?: string;
  cni_plugin?: string;
  tags?: string[];
  created_at?: string;
  pools?: CivoPool[];
  installed_applications?: Array<{
    application?: string;
    name?: string;
    version?: string;
    installed?: boolean;
  }>;
}

export interface CivoKubernetesVersion {
  label?: string;
  version: string;
  type?: string;
  default?: boolean;
  clusterType?: string;
}

export interface CivoMarketplaceApp {
  name: string;
  title?: string;
  version?: string;
  description?: string;
  category?: string;
  default?: boolean;
}

export interface CivoLoadBalancer {
  id: string;
  name?: string;
  network_id?: string;
  algorithm?: string;
  backends?: Array<{
    ip?: string;
    protocol?: string;
    source_port?: number;
    target_port?: number;
    health_check_port?: number;
  }>;
  instance_pools?: Array<{
    tags?: string[];
    names?: string[];
    protocol?: string;
    source_port?: number;
    target_port?: number;
  }>;
  external_traffic_policy?: string;
  session_affinity?: string;
  enable_proxy_protocol?: string;
  public_ip?: string;
  private_ip?: string;
  firewall_id?: string;
  cluster_id?: string;
  state?: string;
  reserved_ip?: string;
  max_concurrent_requests?: number;
}

export interface CivoDatabase {
  id: string;
  name?: string;
  nodes?: number;
  size?: string;
  software?: string;
  software_version?: string;
  public_ipv4?: string;
  private_ipv4?: string;
  network_id?: string;
  firewall_id?: string;
  port?: number;
  username?: string;
  password?: string;
  database_user_info?: Array<{ username?: string; password?: string; port?: number }>;
  dns_entry?: string;
  status?: string;
}

export interface CivoDatabaseBackup {
  id?: string;
  name?: string;
  software?: string;
  status?: string;
  schedule?: string;
  database_name?: string;
  database_id?: string;
  is_scheduled?: boolean;
  created_at?: string;
}

export interface CivoObjectStore {
  id: string;
  name?: string;
  max_size?: number;
  owner_info?: { access_key_id?: string; name?: string; credential_id?: string };
  objectstore_endpoint?: string;
  status?: string;
}

export interface CivoObjectStoreCredential {
  id: string;
  name?: string;
  access_key_id?: string;
  secret_access_key_id?: string;
  max_size_gb?: number;
  suspended?: boolean;
  status?: string;
}

export interface CivoDnsDomain {
  id: string;
  account_id?: string;
  name: string;
}

export interface CivoDnsRecord {
  id: string;
  domain_id?: string;
  name?: string;
  value?: string;
  type?: string;
  priority?: number;
  ttl?: number;
  created_at?: string;
}

export interface CivoSshKey {
  id: string;
  name?: string;
  fingerprint?: string;
  public_key?: string;
  created_at?: string;
}

export interface CivoCharge {
  code?: string;
  product_id?: string;
  label?: string;
  from?: string;
  to?: string;
  num_hours?: number;
  size_gb?: number | null;
  region?: string;
}

export type CivoQuota = Record<string, number | string>;
