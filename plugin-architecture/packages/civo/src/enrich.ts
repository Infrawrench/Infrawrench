/**
 * Detail enrichment: extra reads stashed as JSON in
 * `resolvedOutputs.__name__`, so `renderDetail` stays synchronous. Every
 * read fails soft.
 */

import type { PolicyOption, ResourceInstance, SizeOption } from "@infrawrench/plugin-base";
import { type CivoApi, regional } from "./api.js";
import { instancePolicyOptions, listSizes, sizeOptions } from "./create.js";
import type {
  CivoCharge,
  CivoCluster,
  CivoDatabaseBackup,
  CivoFirewallRule,
  CivoLoadBalancer,
  CivoMarketplaceApp,
  CivoObjectStore,
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
  for (const [k, v] of Object.entries(values)) {
    if (v !== null && v !== undefined) outputs[`__${k}__`] = JSON.stringify(v);
  }
  return { ...resource, resolvedOutputs: outputs };
}

/** First and last instant of the current UTC month so far (charges allow 31 days). */
export function monthToDate(now = new Date()): { from: string; to: string } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    from: from.toISOString().replace(/\.\d{3}Z$/, "Z"),
    to: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}

export async function enrichDetail(
  api: CivoApi,
  resource: ResourceInstance,
): Promise<ResourceInstance> {
  const { region, id } = regional(resource.id);
  switch (resource.resourceTypeId) {
    case "instance": {
      const sizes = await soft(listSizes(api));
      const current = String(resource.fields["size"] ?? "");
      const all = sizeOptions(sizes ?? [], "instance");
      const cur = all.find((s) => s.id === current);
      // Civo only resizes upwards: offer sizes with at least the current disk.
      const bigger: SizeOption[] = all.filter(
        (s) => s.id !== current && (!cur || (s.diskGb ?? 0) >= (cur.diskGb ?? 0)),
      );
      return stash(resource, { sizes: bigger });
    }
    case "firewall": {
      const rules = await soft(api.list<CivoFirewallRule>(`/firewalls/${id}/rules`, { region }));
      return stash(resource, { rules });
    }
    case "kubernetes-cluster": {
      const [cluster, apps] = await Promise.all([
        soft(api.get<CivoCluster>(`/kubernetes/clusters/${id}`, { region })),
        soft(api.get<CivoMarketplaceApp[]>("/kubernetes/applications")),
      ]);
      const nodes = (cluster?.pools ?? []).flatMap((p) =>
        (p.instances ?? []).map((n) => ({
          hostname: n.hostname ?? "",
          status: n.status ?? "",
          ip: n.public_ip ?? "",
          pool: p.id,
        })),
      );
      const installed = new Set(
        (cluster?.installed_applications ?? []).map((a) => a.application ?? a.name),
      );
      return stash(resource, {
        nodes,
        apps: (apps ?? [])
          .filter((a) => !installed.has(a.name))
          .map((a): PolicyOption => ({
            id: a.name,
            label: a.title || a.name,
            category: a.category ?? "Other",
          })),
      });
    }
    case "node-pool": {
      const [clusterId, poolId] = id.split("/");
      const cluster = await soft(
        api.get<CivoCluster>(`/kubernetes/clusters/${clusterId}`, { region }),
      );
      const pool = (cluster?.pools ?? []).find((p) => p.id === poolId);
      return stash(resource, { nodes: pool?.instances ?? null });
    }
    case "database": {
      const backups = await soft(
        api.list<CivoDatabaseBackup>(`/databases/${id}/backups`, { region }),
      );
      return stash(resource, { backups });
    }
    case "load-balancer": {
      const [lb, instances] = await Promise.all([
        soft(api.get<CivoLoadBalancer>(`/loadbalancers/${id}`, { region })),
        soft(instancePolicyOptions(api, region)),
      ]);
      return stash(resource, { lb, instanceOptions: instances });
    }
    case "object-store": {
      const stats = await soft(
        api.get<{ size_kb_utilised?: number; max_size_kb?: number; num_objects?: number }>(
          `/objectstores/${id}/stats`,
          { region },
        ),
      );
      return stash(resource, { stats });
    }
    case "account": {
      const range = monthToDate();
      const charges = await soft(api.get<CivoCharge[]>("/charges", range));
      return stash(resource, { charges });
    }
    default:
      return resource;
  }
}

export type { CivoObjectStore };
