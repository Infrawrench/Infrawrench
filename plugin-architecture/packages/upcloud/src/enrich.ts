/**
 * Detail enrichment: extra reads stashed as JSON in
 * `resolvedOutputs.__name__` so `renderDetail` stays synchronous. Every
 * read fails soft.
 */

import type { ResourceInstance, SizeOption } from "@infrawrench/plugin-base";
import { type UpCloudApi, splitPair, trailingId, unwrap } from "./api.js";
import { type Catalog, planSizeOptions, serverIpOptions } from "./create.js";
import type { Json } from "./listers.js";

async function soft<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

function stash(resource: ResourceInstance, values: Record<string, unknown>): ResourceInstance {
  const outputs = { ...resource.resolvedOutputs };
  for (const [k, v] of Object.entries(values))
    if (v !== null && v !== undefined) outputs[`__${k}__`] = JSON.stringify(v);
  return { ...resource, resolvedOutputs: outputs };
}

export async function enrichDetail(
  api: UpCloudApi,
  catalog: () => Promise<Catalog>,
  resource: ResourceInstance,
): Promise<ResourceInstance> {
  const id = trailingId(resource.id);
  const zone = String(resource.fields["region"] ?? "");
  switch (resource.resourceTypeId) {
    case "server": {
      const [rules, cat, detached] = await Promise.all([
        soft(
          api
            .get(`/server/${id}/firewall_rule`)
            .then((r) => unwrap<Json>(r, "firewall_rules", "firewall_rule")),
        ),
        soft(catalog()),
        soft(
          api
            .get("/storage/private")
            .then((r) => unwrap<Json>(r, "storages", "storage"))
            .then((list) =>
              list.filter(
                (s) => s["type"] === "normal" && s["zone"] === zone && s["state"] === "online",
              ),
            ),
        ),
      ]);
      const sizes: SizeOption[] = cat ? planSizeOptions(cat, zone) : [];
      return stash(resource, {
        rules,
        plans: sizes.filter((s) => s.id !== resource.fields["plan"]),
        storages: (detached ?? []).map((s) => ({
          id: String(s["uuid"]),
          label: `${String(s["title"])} (${String(s["size"])} GB)`,
        })),
      });
    }
    case "kubernetes-cluster": {
      const upgrades = await soft(
        api.get<{ versions?: string[] }>(`/kubernetes/${id}/available-upgrades`),
      );
      return stash(resource, { upgrades: upgrades?.versions ?? [] });
    }
    case "node-group": {
      const [clusterId, name] = splitPair(id);
      const group = await soft(
        api.get<Json>(`/kubernetes/${clusterId}/node-groups/${encodeURIComponent(name)}`),
      );
      return stash(resource, { nodes: (group?.["nodes"] as unknown[] | undefined) ?? null });
    }
    case "database": {
      const [versions, db] = await Promise.all([
        soft(api.get<string[]>(`/database/${id}/versions`)),
        soft(api.get<Json>(`/database/${id}`)),
      ]);
      return stash(resource, {
        versions,
        backups: (db?.["backups"] as unknown[] | undefined) ?? null,
      });
    }
    case "load-balancer": {
      const [lb, ips] = await Promise.all([
        soft(api.get<Json>(`/load-balancer/${id}`)),
        soft(serverIpOptions(api)),
      ]);
      return stash(resource, { lb, ips });
    }
    default:
      return resource;
  }
}
