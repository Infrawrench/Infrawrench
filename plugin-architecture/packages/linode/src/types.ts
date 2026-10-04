/**
 * Response shapes from Linode API v4, narrowed to the fields this plugin
 * reads. Verified against the published OpenAPI document (linode-api-docs
 * 4.215.0) and the per-operation definitions on techdocs.akamai.com
 * (2026-10). Every field is optional: the API grows fields over time and a
 * missing one must degrade to an empty value, never a crash.
 */

export interface LinodePrice {
  hourly?: number | null;
  monthly?: number | null;
}

export interface LinodeRegionPrice extends LinodePrice {
  id?: string;
}

export interface LinodeInstance {
  id: number;
  label?: string;
  status?: string;
  type?: string | null;
  region?: string;
  image?: string | null;
  ipv4?: string[];
  ipv6?: string | null;
  created?: string;
  updated?: string;
  tags?: string[];
  specs?: { disk?: number; memory?: number; vcpus?: number; gpus?: number; transfer?: number };
  backups?: {
    enabled?: boolean;
    available?: boolean;
    last_successful?: string | null;
    schedule?: { day?: string | null; window?: string | null };
  };
  lke_cluster_id?: number | null;
  placement_group?: { id?: number; label?: string } | null;
  disk_encryption?: string;
  watchdog_enabled?: boolean;
  host_uuid?: string;
}

export interface LinodeType {
  id: string;
  label?: string;
  class?: string;
  disk?: number;
  memory?: number;
  vcpus?: number;
  gpus?: number;
  transfer?: number;
  network_out?: number;
  price?: LinodePrice;
  region_prices?: LinodeRegionPrice[];
  addons?: { backups?: { price?: LinodePrice; region_prices?: LinodeRegionPrice[] } };
  successor?: string | null;
}

/** `/volumes/types`, `/nodebalancers/types`, `/lke/types`, `/object-storage/types`, ... */
export interface LinodeSimpleType {
  id: string;
  label?: string;
  price?: LinodePrice;
  region_prices?: LinodeRegionPrice[];
  transfer?: number;
}

export interface LinodeDatabaseType {
  id: string;
  label?: string;
  class?: string;
  disk?: number;
  memory?: number;
  vcpus?: number;
  engines?: Record<string, Array<{ quantity?: number; price?: LinodePrice }>>;
}

export interface LinodeVolume {
  id: number;
  label?: string;
  status?: string;
  size?: number;
  region?: string;
  linode_id?: number | null;
  linode_label?: string | null;
  filesystem_path?: string;
  hardware_type?: string;
  encryption?: string;
  created?: string;
  tags?: string[];
}

export interface LinodeNodeBalancer {
  id: number;
  label?: string;
  region?: string;
  hostname?: string;
  ipv4?: string;
  ipv6?: string | null;
  client_conn_throttle?: number;
  type?: string;
  created?: string;
  tags?: string[];
  transfer?: { in?: number | null; out?: number | null; total?: number | null };
  lke_cluster?: { id?: number | string; label?: string } | null;
}

export interface LinodeNodeBalancerConfig {
  id: number;
  port?: number;
  protocol?: string;
  algorithm?: string;
  stickiness?: string;
  check?: string;
  nodes_status?: { up?: number; down?: number };
}

export interface LinodeLkeCluster {
  id: number;
  label?: string;
  region?: string;
  k8s_version?: string;
  tier?: string;
  status?: string;
  created?: string;
  tags?: string[];
  control_plane?: { high_availability?: boolean };
}

export interface LinodeLkePool {
  id: number;
  type?: string;
  count?: number;
  label?: string | null;
  autoscaler?: { enabled?: boolean; min?: number; max?: number };
  nodes?: Array<{ id?: string; instance_id?: number | null; status?: string }>;
  tags?: string[];
  disk_encryption?: string;
}

export interface LinodeBucket {
  label: string;
  region?: string;
  cluster?: string;
  hostname?: string;
  s3_endpoint?: string;
  endpoint_type?: string;
  objects?: number;
  size?: number;
  created?: string;
}

export interface LinodeDatabase {
  id: number;
  label?: string;
  engine?: string;
  version?: string;
  region?: string;
  status?: string;
  type?: string;
  cluster_size?: number;
  platform?: string;
  port?: number;
  hosts?: { primary?: string | null; secondary?: string | null };
  allow_list?: string[];
  total_disk_size_gb?: number;
  used_disk_size_gb?: number;
  created?: string;
  updates?: { day_of_week?: number; hour_of_day?: number; duration?: number; frequency?: string };
}

export interface LinodeFirewall {
  id: number;
  label?: string;
  status?: string;
  created?: string;
  tags?: string[];
  entities?: Array<{ id?: number; type?: string; label?: string }>;
  rules?: {
    inbound_policy?: string;
    outbound_policy?: string;
    inbound?: LinodeFirewallRule[];
    outbound?: LinodeFirewallRule[];
  };
}

export interface LinodeFirewallRule {
  action?: string;
  protocol?: string;
  ports?: string;
  label?: string;
  description?: string;
  addresses?: { ipv4?: string[]; ipv6?: string[] };
}

export interface LinodeDomain {
  id: number;
  domain?: string;
  type?: string;
  status?: string;
  soa_email?: string;
  description?: string;
  ttl_sec?: number;
  master_ips?: string[];
  tags?: string[];
}

export interface LinodeDomainRecord {
  id: number;
  type?: string;
  name?: string;
  target?: string;
  ttl_sec?: number;
  priority?: number;
  weight?: number;
  port?: number;
  service?: string | null;
  protocol?: string | null;
  tag?: string | null;
}

export interface LinodeVpc {
  id: number;
  label?: string;
  region?: string;
  description?: string;
  created?: string;
  subnets?: Array<{ id?: number; label?: string; ipv4?: string; linodes?: unknown[] }>;
}

export interface LinodeImage {
  id: string;
  label?: string;
  description?: string;
  type?: string;
  status?: string;
  is_public?: boolean;
  size?: number;
  total_size?: number;
  vendor?: string | null;
  created?: string;
  created_by?: string;
  expiry?: string | null;
  deprecated?: boolean;
  regions?: Array<{ region?: string; status?: string }>;
  capabilities?: string[];
  tags?: string[];
}

export interface LinodeStackScript {
  id: number;
  label?: string;
  description?: string;
  images?: string[];
  is_public?: boolean;
  mine?: boolean;
  script?: string;
  rev_note?: string;
  deployments_active?: number;
  deployments_total?: number;
  created?: string;
  updated?: string;
}

export interface LinodeReservedIp {
  address: string;
  region?: string;
  rdns?: string | null;
  tags?: string[];
  linode_id?: number | null;
  assigned_entity?: { id?: number; label?: string; type?: string } | null;
}

export interface LinodeRegion {
  id: string;
  label?: string;
  country?: string;
  capabilities?: string[];
  status?: string;
  site_type?: string;
}

export interface LinodeAccount {
  company?: string;
  email?: string;
  euuid?: string;
  balance?: number;
  balance_uninvoiced?: number;
  active_since?: string;
  billing_source?: string;
  capabilities?: string[];
  active_promotions?: LinodePromotion[];
}

export interface LinodePromotion {
  summary?: string;
  description?: string;
  service_type?: string;
  credit_monthly_cap?: string;
  credit_remaining?: string;
  this_month_credit_remaining?: string;
  expire_dt?: string | null;
}

export interface LinodeInvoice {
  id: number;
  label?: string;
  date?: string;
  subtotal?: number;
  tax?: number;
  total?: number;
  billing_source?: string;
}

export interface LinodeInvoiceItem {
  label?: string;
  amount?: number;
  tax?: number;
  total?: number;
  from?: string | null;
  to?: string | null;
  quantity?: number | null;
  unit_price?: string | null;
  type?: string;
  region?: string | null;
}

export interface LinodeTransfer {
  used?: number;
  quota?: number;
  billable?: number;
  region_transfers?: Array<{ id?: string; used?: number; quota?: number; billable?: number }>;
}
