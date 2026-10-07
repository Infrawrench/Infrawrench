/**
 * The slice of Vast.ai payloads this plugin reads (wire names from the
 * published OpenAPI document, checked 2026-10). Everything is optional: the
 * spec marks almost nothing required and Vast omits nulls freely.
 */

export interface VInstance {
  id: number;
  label?: string | null;
  actual_status?: string | null;
  intended_status?: string | null;
  cur_state?: string | null;
  next_state?: string | null;
  status_msg?: string | null;
  template_id?: number | null;
  template_hash_id?: string | null;
  template_name?: string | null;
  image_uuid?: string | null;
  image_runtype?: string | null;
  onstart?: string | null;
  jupyter_token?: string | null;
  public_ipaddr?: string | null;
  ssh_host?: string | null;
  ssh_port?: number | null;
  machine_id?: number | null;
  host_id?: number | null;
  start_date?: number | null;
  end_date?: number | null;
  uptime_mins?: number | null;
  cpu_name?: string | null;
  cpu_cores_effective?: number | null;
  cpu_ram?: number | null;
  cpu_util?: number | null;
  mem_usage?: number | null;
  mem_limit?: number | null;
  gpu_name?: string | null;
  num_gpus?: number | null;
  gpu_ram?: number | null;
  gpu_util?: number | null;
  gpu_temp?: number | null;
  disk_space?: number | null;
  disk_usage?: number | null;
  ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }>> | number[] | null;
  geolocation?: string | null;
  verification?: string | null;
  reliability2?: number | null;
  is_bid?: boolean | null;
  min_bid?: number | null;
  dph_total?: number | null;
  dph_base?: number | null;
  storage_total_cost?: number | null;
  inet_up_cost?: number | null;
  inet_down_cost?: number | null;
  static_ip?: boolean | null;
  cuda_max_good?: number | null;
  driver_version?: string | null;
  time_remaining?: string | null;
  volume_info?: Array<{ volume_id?: number; mount_path?: string }> | null;
}

export interface VOffer {
  id: number;
  ask_contract_id?: number;
  gpu_name?: string;
  num_gpus?: number;
  gpu_ram?: number;
  cpu_cores_effective?: number;
  cpu_ram?: number;
  disk_space?: number;
  dph_total?: number;
  min_bid?: number;
  reliability?: number;
  reliability2?: number;
  geolocation?: string;
  verification?: string;
  cuda_max_good?: number;
  inet_down?: number;
  inet_up?: number;
  dlperf?: number;
  datacenter?: boolean | null;
  storage_cost?: number;
}

export interface VVolume {
  id: number;
  label?: string | null;
  status?: string | null;
  disk_space?: number | null;
  disk_name?: string | null;
  machine_id?: number | null;
  host_id?: number | null;
  geolocation?: string | null;
  start_date?: number | null;
  storage_total_cost?: number | null;
  instances?: number[] | null;
  verification?: string | null;
  cluster_id?: number | null;
}

export interface VVolumeOffer {
  id: number;
  disk_space?: number;
  storage_cost?: number;
  geolocation?: string;
  reliability2?: number;
  machine_id?: number;
  disk_name?: string;
  verification?: string;
}

export interface VTemplate {
  id: number;
  hash_id?: string;
  name?: string;
  image?: string;
  tag?: string;
  desc?: string;
  readme?: string;
  env?: string;
  onstart?: string;
  runtype?: string;
  ssh_direct?: boolean;
  jup_direct?: boolean;
  use_ssh?: boolean;
  recommended_disk_space?: number;
  private?: boolean;
  recommended?: boolean;
  creator_id?: number;
  count_created?: number;
  created_at?: number | string;
}

export interface VSshKey {
  id: number;
  key?: string;
  public_key?: string;
  created_at?: string;
  deleted_at?: string | null;
}

export interface VEndpoint {
  id: number;
  endpoint_name?: string;
  endpoint_state?: string;
  min_load?: number;
  target_util?: number;
  cold_mult?: number;
  cold_workers?: number;
  max_workers?: number;
  created_at?: string | number;
}

export interface VWorkergroup {
  id: number;
  endpoint_id?: number;
  endpoint_name?: string;
  template_hash?: string;
  template_id?: number;
  search_query?: unknown;
  launch_args?: string;
  gpu_ram?: number;
  min_load?: number;
  target_util?: number;
  cold_mult?: number;
  cold_workers?: number;
  max_workers?: number;
  test_workers?: number;
  created_at?: string | number;
}

export interface VUser {
  id?: number;
  email?: string;
  balance?: number;
  credit?: number;
}

export interface VChargeEntry {
  start?: number;
  end?: number;
  type?: string;
  source?: string | null;
  description?: string;
  amount?: number;
  metadata?: {
    label?: string;
    template_id?: number;
    endpoint_id?: number;
    workergroup_id?: number;
  };
  items?: VChargeEntry[];
}
