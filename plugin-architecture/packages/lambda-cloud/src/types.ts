/**
 * The slice of Lambda Cloud API payloads this plugin reads, with wire names
 * from the published OpenAPI document (v1.10.0, checked 2026-10).
 */

export interface LRegion {
  name: string;
  description?: string;
}

export interface LInstanceType {
  name: string;
  description?: string;
  gpu_description?: string;
  price_cents_per_hour?: number;
  specs?: { vcpus?: number; memory_gib?: number; storage_gib?: number; gpus?: number };
  architecture?: string;
}

export interface LActionAvailability {
  available?: boolean;
  reason_code?: string | null;
  reason_description?: string;
}

export interface LInstance {
  id: string;
  name?: string | null;
  ip?: string | null;
  private_ip?: string | null;
  status?: string;
  ssh_key_names?: string[];
  file_system_names?: string[];
  file_system_mounts?: Array<{ mount_point?: string; file_system_id?: string }>;
  region?: LRegion;
  instance_type?: LInstanceType;
  image?: { id?: string; family?: string } | null;
  hostname?: string | null;
  jupyter_token?: string | null;
  jupyter_url?: string | null;
  first_healthy?: string | null;
  actions?: Partial<
    Record<
      "migrate" | "rebuild" | "restart" | "cold_reboot" | "power_cycle" | "terminate",
      LActionAvailability
    >
  >;
  tags?: Array<{ key: string; value: string }>;
  firewall_rulesets?: Array<{ id: string }>;
}

export interface LInstanceTypeItem {
  instance_type: LInstanceType;
  regions_with_capacity_available?: LRegion[];
}

export interface LFilesystem {
  id: string;
  name?: string;
  mount_point?: string;
  created?: string;
  created_by?: { id?: string; email?: string } | null;
  is_in_use?: boolean;
  region?: LRegion;
  bytes_used?: number | null;
}

export interface LImage {
  id: string;
  name?: string;
  description?: string;
  family?: string;
  version?: string;
  architecture?: string;
  region?: LRegion;
  created_time?: string;
}

export interface LSshKey {
  id: string;
  name?: string;
  public_key?: string;
}

export interface LFirewallRule {
  protocol: "tcp" | "udp" | "icmp" | "all";
  port_range?: [number, number];
  source_network: string;
  description: string;
}

export interface LFirewallRuleset {
  id: string;
  name?: string;
  region?: LRegion;
  rules?: LFirewallRule[];
  created?: string;
  instance_ids?: string[];
}
