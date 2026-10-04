/**
 * The slice of Crusoe's API payloads this plugin reads. Field names are the
 * wire names from the published spec (`https://api.crusoecloud.com/v1/openapi.json`,
 * Swagger 2.0, host `api.cloud.crusoe.ai`, basePath `/v1`), checked 2026-10.
 * Everything is optional because the spec marks almost nothing required.
 */

export interface CrusoeEntity {
  id: string;
  name?: string;
  company_name?: string;
  organization_type?: string;
  state?: string;
  billing?: { balance?: string; billing_method?: string; delinquent?: boolean };
}

export interface CrusoeProject {
  id: string;
  name?: string;
  organization_id?: string;
  resources?: Record<string, { count?: number } | undefined>;
}

export interface CrusoeOperation {
  operation_id?: string;
  state?: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result?: unknown;
  metadata?: unknown;
  started_at?: string;
  completed_at?: string;
}

export interface CrusoeAsyncResponse {
  operation?: CrusoeOperation;
}

export interface CrusoeAttachedDisk {
  id: string;
  name?: string;
  attachment_type?: string;
  mode?: string;
  size?: string;
  type?: string;
}

export interface CrusoeNetworkInterface {
  id?: string;
  name?: string;
  network?: string;
  subnet?: string;
  external_dns_name?: string;
  ips?: Array<{
    private_ipv4?: { address?: string };
    public_ipv4?: { address?: string; id?: string; type?: string };
  }>;
}

export interface CrusoeVm {
  id: string;
  name?: string;
  project_id?: string;
  location?: string;
  type?: string;
  state?: string;
  billing_type?: string;
  reservation_id?: string;
  instance_group_id?: string;
  instance_template_id?: string;
  maintenance_policy?: string;
  nvlink_domain_id?: string;
  created_at?: string;
  updated_at?: string;
  disks?: CrusoeAttachedDisk[];
  network_interfaces?: CrusoeNetworkInterface[];
}

export interface CrusoeVmType {
  product_name: string;
  description?: string;
  cpu_cores?: number;
  cpu_type?: string;
  memory_gb?: number;
  disk_gb?: number;
  disk_type?: string;
  gpu_type?: string;
  num_gpu?: number;
}

export interface CrusoeImage {
  id: string;
  name: string;
  description?: string;
  locations?: string[];
  tags?: string[];
  supported_product_lines?: string[];
}

export interface CrusoeDisk {
  id: string;
  name?: string;
  location?: string;
  size?: string;
  type?: string;
  block_size?: number;
  serial_number?: string;
  dns_name?: string;
  created_at?: string;
  attached_to?: Array<{ vm_id?: string; attachment_type?: string; mode?: string }>;
}

export interface CrusoeSnapshot {
  id: string;
  name?: string;
  size?: string;
  created_from?: string;
  created_at?: string;
  block_size?: number;
}

export interface CrusoeVpcNetwork {
  id: string;
  name?: string;
  cidr?: string;
  gateway?: string;
  subnets?: string[];
}

export interface CrusoeVpcSubnet {
  id: string;
  name?: string;
  cidr?: string;
  location?: string;
  vpc_network_id?: string;
  nat_gateways?: Array<{ id?: string; public_ipv4_address?: string }>;
}

export interface CrusoeFirewallTarget {
  cidr?: string;
  resource_id?: string;
}

export interface CrusoeFirewallRule {
  id: string;
  name?: string;
  vpc_network_id?: string;
  action?: string;
  direction?: string;
  state?: string;
  protocols?: string[];
  sources?: CrusoeFirewallTarget[];
  source_ports?: string[];
  destinations?: CrusoeFirewallTarget[];
  destination_ports?: string[];
}

export interface CrusoeSshKey {
  id: string;
  name?: string;
  public_key?: string;
  created_at?: string;
  fingerprints?: { md5?: string; sha256?: string };
}

export interface CrusoeCluster {
  id: string;
  name?: string;
  project_id?: string;
  location?: string;
  version?: string;
  state?: string;
  dns_name?: string;
  private?: boolean;
  subnet_id?: string;
  cluster_cidr?: string;
  service_cluster_ip_range?: string;
  routing_mode?: string;
  node_pools?: string[];
  add_ons?: string[];
  created_at?: string;
}

export interface CrusoeNodePool {
  id: string;
  name?: string;
  cluster_id?: string;
  project_id?: string;
  type?: string;
  count?: number;
  current?: number;
  state?: string;
  image_id?: string;
  subnet_id?: string;
  reservation_id?: string;
  public_ip_type?: string;
  instance_ids?: string[];
  autoscaling_config?: { enabled?: boolean; min_node_size?: number; max_node_size?: number };
  health?: { issues?: Array<{ code?: string; message?: string; affected_count?: number }> };
  created_at?: string;
}

export interface CrusoeLoadBalancer {
  id: string;
  name?: string;
  location?: string;
  protocol?: string;
  vip?: string;
  vpc_id?: string;
  listen_ports_and_backends?: Array<{
    listen_port?: number;
    backends?: Array<{ ip?: string; port?: number; status?: string }>;
  }>;
}

export interface CrusoeReservation {
  id: string;
  product_line?: string;
  reservation_type?: string;
  quantity?: number;
  used_quantity?: number;
  price?: string;
  duration?: number;
  locations?: string[];
  projects?: string[];
  vm_ids?: string[];
  contract_start_date?: string;
  contract_end_date?: string;
  date_delivered?: string;
}

export interface CrusoeQuota {
  programmatic_name?: string;
  description?: string;
  category?: string;
  max?: number;
  used?: number;
  available?: number;
}

export interface CrusoeKubeCredentials {
  kube_config?: string;
  cluster_address?: string;
  cluster_name?: string;
}

export interface CrusoeKubeVersions {
  kubernetes_cluster_versions?: Array<{ cluster_version_name?: string; tags?: string[] }>;
  kubernetes_node_pool_versions?: Array<{ node_pool_version_name?: string; tags?: string[] }>;
}
