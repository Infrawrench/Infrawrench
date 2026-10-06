/**
 * Quotas: `GET /v2/quota` returns used/limit pairs for the account
 * (`instance_count_usage` / `instance_count_limit`, `cpu_core_*`,
 * `ram_mb_*`, `disk_gb_*`, volumes, snapshots, public IPs, networks,
 * security groups and rules, load balancers, object store GB and the
 * database counters). Both halves come from Civo, so every pair is reported
 * as is; a pair whose limit is missing or zero is skipped.
 */

import type { QuotaUsage } from "@infrawrench/plugin-base";
import { QuotaAccessError } from "@infrawrench/plugin-base";
import { type CivoApi, statusOf } from "./api.js";
import type { CivoQuota } from "./types.js";

const QUOTAS: Array<[string, string, string, string?]> = [
  ["instance_count", "Compute", "Instances"],
  ["cpu_core", "Compute", "vCPUs", "cores"],
  ["ram_mb", "Compute", "Memory", "MB"],
  ["disk_gb", "Storage", "Instance disk", "GB"],
  ["disk_volume_count", "Storage", "Volumes"],
  ["disk_snapshot_count", "Storage", "Volume snapshots"],
  ["public_ip_address", "Networking", "Public IP addresses"],
  ["network_count", "Networking", "Networks"],
  ["subnet_count", "Networking", "Subnets"],
  ["security_group", "Networking", "Firewalls"],
  ["security_group_rule", "Networking", "Firewall rules"],
  ["port_count", "Networking", "Ports"],
  ["loadbalancer_count", "Networking", "Load balancers"],
  ["objectstore_gb", "Object Storage", "Object store capacity", "GB"],
  ["database_count", "Databases", "Databases"],
  ["database_snapshot_count", "Databases", "Database snapshots"],
  ["database_cpu_core", "Databases", "Database vCPUs", "cores"],
  ["database_ram_mb", "Databases", "Database memory", "MB"],
  ["database_disk_gb", "Databases", "Database disk", "GB"],
];

export function quotasFrom(q: CivoQuota): QuotaUsage[] {
  const out: QuotaUsage[] = [];
  for (const [key, service, name, unit] of QUOTAS) {
    const limit = Number(q[`${key}_limit`]);
    const used = Number(q[`${key}_usage`]);
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used)) continue;
    out.push({
      id: key,
      service,
      name,
      limit,
      used,
      ...(unit ? { unit } : {}),
      adjustable: true,
      docsUrl: "https://dashboard.civo.com/quota",
    });
  }
  return out;
}

export async function fetchQuotas(api: CivoApi): Promise<QuotaUsage[]> {
  try {
    return quotasFrom(await api.get<CivoQuota>("/quota"));
  } catch (err) {
    const status = statusOf(err);
    if (status === 401 || status === 403) {
      throw new QuotaAccessError("This API key cannot read the account quota.", {
        label: "Open Civo security settings",
        url: "https://dashboard.civo.com/security",
      });
    }
    throw err;
  }
}
