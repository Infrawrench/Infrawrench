/**
 * Detail enrichment: the extra reads a detail view needs, stashed as JSON
 * strings in `resolvedOutputs.__name__` so `renderDetail` stays synchronous.
 * Every read fails soft: a missing table is better than a broken page.
 */

import type { ResourceInstance, SizeOption } from "@infrawrench/plugin-base";
import { type VultrApi, trailingId } from "./api.js";
import { type PlanCatalogCache, planSizeOption } from "./catalog.js";
import { imageOptions, instancePolicyOptions } from "./create.js";
import type {
  VultrBackup,
  VultrFirewallRule,
  VultrInvoiceItem,
  VultrKubernetesCluster,
  VultrLoadBalancer,
  VultrOs,
  VultrSnapshot,
  VultrVpc,
  VultrVpcAttachment,
} from "./types.js";

async function soft<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

function stash(resource: ResourceInstance, values: Record<string, unknown>): ResourceInstance {
  const outputs = { ...resource.resolvedOutputs };
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && value !== undefined) outputs[`__${key}__`] = JSON.stringify(value);
  }
  return { ...resource, resolvedOutputs: outputs };
}

export async function enrichDetail(
  api: VultrApi,
  catalog: PlanCatalogCache,
  resource: ResourceInstance,
): Promise<ResourceInstance> {
  const id = trailingId(resource.id);
  switch (resource.resourceTypeId) {
    case "instance": {
      const [upgrades, plans, backups, snapshots, schedule, vpcs, allVpcs, images] =
        await Promise.all([
          soft(
            api.get<{ upgrades?: { plans?: string[]; os?: VultrOs[] } }>(
              `/instances/${id}/upgrades`,
            ),
          ),
          soft(catalog.get()),
          soft(api.all<VultrBackup>("/backups", "backups", { instance_id: id })),
          soft(api.all<VultrSnapshot>("/snapshots", "snapshots")),
          soft(
            api.get<{ backup_schedule?: Record<string, unknown> }>(
              `/instances/${id}/backup-schedule`,
            ),
          ),
          soft(
            api.all<{ id: string; ip_address?: string; mac_address?: string }>(
              `/instances/${id}/vpcs`,
              "vpcs",
            ),
          ),
          soft(api.all<VultrVpc>("/vpcs", "vpcs")),
          soft(imageOptions(api)),
        ]);
      const region = String(resource.fields["region"] ?? "");
      const upgradePlans = new Set(upgrades?.upgrades?.plans ?? []);
      const resizeOptions: SizeOption[] = (plans ?? [])
        .filter((p) => upgradePlans.has(p.id))
        .map((p) => planSizeOption(p, region));
      const vpcNames = new Map((allVpcs ?? []).map((v) => [v.id, v.description || v.id]));
      return stash(resource, {
        resizePlans: resizeOptions,
        backups: (backups ?? []).map((b) => ({
          id: b.id,
          label: `${b.description || b.id} (${(b.date_created ?? "").slice(0, 16).replace("T", " ")})`,
        })),
        snapshots: (snapshots ?? [])
          .filter((s) => s.status === "complete")
          .map((s) => ({ id: s.id, label: s.description || s.id })),
        backupSchedule: schedule?.backup_schedule ?? null,
        vpcs: vpcs
          ? vpcs.map((v) => ({
              id: v.id,
              name: vpcNames.get(v.id) ?? v.id,
              ip: v.ip_address ?? "",
            }))
          : null,
        regionVpcs: (allVpcs ?? [])
          .filter((v) => v.region === region)
          .map((v) => ({ id: v.id, label: v.description || v.id })),
        images: images ?? null,
      });
    }
    case "firewall-group": {
      const rules = await soft(
        api.all<VultrFirewallRule>(`/firewalls/${id}/rules`, "firewall_rules"),
      );
      return stash(resource, { rules });
    }
    case "load-balancer": {
      const [lb, instances] = await Promise.all([
        soft(api.get<{ load_balancer?: VultrLoadBalancer }>(`/load-balancers/${id}`)),
        soft(instancePolicyOptions(api)),
      ]);
      return stash(resource, {
        lb: lb?.load_balancer ?? null,
        instanceOptions: instances,
      });
    }
    case "kubernetes-cluster": {
      const [cluster, upgrades] = await Promise.all([
        soft(api.get<{ vke_cluster?: VultrKubernetesCluster }>(`/kubernetes/clusters/${id}`)),
        soft(
          api.get<{ available_upgrades?: string[] }>(
            `/kubernetes/clusters/${id}/available-upgrades`,
          ),
        ),
      ]);
      return stash(resource, {
        nodePools: cluster?.vke_cluster?.node_pools ?? null,
        upgrades: upgrades?.available_upgrades ?? [],
      });
    }
    case "node-pool": {
      const [clusterId, poolId] = id.split("/");
      const pool = await soft(
        api.get<{ node_pool?: { nodes?: unknown[] } }>(
          `/kubernetes/clusters/${clusterId}/node-pools/${poolId}`,
        ),
      );
      return stash(resource, { nodes: pool?.node_pool?.nodes ?? null });
    }
    case "database": {
      const [versions, usage, backups, plans] = await Promise.all([
        soft(api.get<{ available_versions?: string[] }>(`/databases/${id}/version-upgrade`)),
        soft(api.get<{ usage?: Record<string, Record<string, number>> }>(`/databases/${id}/usage`)),
        soft(
          api.get<{
            latest_backup?: { date?: string; time?: string };
            oldest_backup?: { date?: string; time?: string };
          }>(`/databases/${id}/backups`),
        ),
        soft(
          api.all<{
            id: string;
            vcpu_count?: number;
            ram?: number;
            disk?: number;
            monthly_cost?: number;
            number_of_nodes?: number;
          }>("/databases/plans", "plans", { engine: String(resource.fields["engine"] ?? "") }),
        ),
      ]);
      return stash(resource, {
        versions: versions?.available_versions ?? [],
        usage: usage?.usage ?? null,
        backups,
        plans: (plans ?? []).map((p) => ({
          id: p.id,
          label: p.id,
          vcpus: p.vcpu_count ?? 0,
          memoryMb: p.ram ?? 0,
          diskGb: p.disk ?? 0,
          category: `${p.number_of_nodes ?? 1} node(s)`,
          ...(typeof p.monthly_cost === "number" ? { priceMonthly: p.monthly_cost } : {}),
        })),
      });
    }
    case "vpc": {
      const attachments = await soft(
        api.all<VultrVpcAttachment>(`/vpcs/${id}/attachments`, "attachments"),
      );
      return stash(resource, { attachments });
    }
    case "domain": {
      const soa = await soft(
        api.get<{ dns_soa?: { nsprimary?: string; email?: string } }>(
          `/domains/${encodeURIComponent(id)}/soa`,
        ),
      );
      if (!soa?.dns_soa) return resource;
      return {
        ...resource,
        fields: {
          ...resource.fields,
          soaPrimary: soa.dns_soa.nsprimary ?? "",
          soaEmail: soa.dns_soa.email ?? "",
        },
      };
    }
    case "invoice": {
      const items = await soft(
        api.all<VultrInvoiceItem>(`/billing/invoices/${id}/items`, "invoice_items"),
      );
      return stash(resource, { items });
    }
    case "account": {
      const pending = await soft(
        api.get<{ pending_charges?: VultrInvoiceItem[] }>("/billing/pending-charges"),
      );
      return stash(resource, { pending: pending?.pending_charges ?? null });
    }
    default:
      return resource;
  }
}
