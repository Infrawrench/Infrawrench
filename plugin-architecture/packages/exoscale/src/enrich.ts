/** Detail enrichment: extra reads stashed as JSON in `resolvedOutputs.__name__`; every read fails soft. */

import type { ResourceInstance } from "@infrawrench/plugin-base";
import { DEFAULT_ZONE, type ExoscaleApi, trailingId, zonal } from "./api.js";
import { instanceTypeOptions, templateOptions } from "./create.js";
import { type Json, dbaasPath, str } from "./listers.js";

async function soft<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

function stash(r: ResourceInstance, values: Record<string, unknown>): ResourceInstance {
  const outputs = { ...r.resolvedOutputs };
  for (const [k, v] of Object.entries(values))
    if (v !== null && v !== undefined) outputs[`__${k}__`] = JSON.stringify(v);
  return { ...r, resolvedOutputs: outputs };
}

export async function enrichDetail(
  api: ExoscaleApi,
  r: ResourceInstance,
): Promise<ResourceInstance> {
  const { zone, id } = zonal(r.id);
  switch (r.resourceTypeId) {
    case "instance": {
      const [inst, types, images, groups, eips, nets] = await Promise.all([
        soft(api.get<Json>(zone, `/instance/${id}`)),
        soft(instanceTypeOptions(api)),
        soft(templateOptions(api, zone)),
        soft(api.get<{ "security-groups"?: Json[] }>(DEFAULT_ZONE, "/security-group")),
        soft(api.get<{ "elastic-ips"?: Json[] }>(zone, "/elastic-ip")),
        soft(api.get<{ "private-networks"?: Json[] }>(zone, "/private-network")),
      ]);
      const name = (list: Json[] | undefined, key: string) =>
        new Map((list ?? []).map((x) => [str(x["id"]), str(x[key])]));
      const sgNames = name(groups?.["security-groups"], "name");
      const eipNames = name(eips?.["elastic-ips"], "ip");
      const netNames = name(nets?.["private-networks"], "name");
      const refs = (k: string) =>
        ((inst?.[k] as Json[] | undefined) ?? []).map((x) => str(x["id"]));
      return stash(r, {
        types: (types ?? []).filter((t) => (t.availableFor ?? [zone]).includes(zone)),
        images,
        snapshots: ((inst?.["snapshots"] as Json[] | undefined) ?? []).map((s) => ({
          id: str(s["id"]),
          label: str(s["id"]).slice(0, 8),
        })),
        securityGroups: refs("security-groups").map((x) => ({ id: x, label: sgNames.get(x) ?? x })),
        elasticIps: refs("elastic-ips").map((x) => ({ id: x, label: eipNames.get(x) ?? x })),
        privateNetworks: refs("private-networks").map((x) => ({
          id: x,
          label: netNames.get(x) ?? x,
        })),
      });
    }
    case "security-group": {
      const g = await soft(api.get<Json>(DEFAULT_ZONE, `/security-group/${trailingId(r.id)}`));
      return stash(r, { rules: g?.["rules"] ?? null });
    }
    case "sks-cluster": {
      const versions = await soft(
        api.get<{ "sks-cluster-versions"?: string[] }>(DEFAULT_ZONE, "/sks-cluster-version"),
      );
      const current = String(r.fields["version"] ?? "");
      return stash(r, {
        versions: (versions?.["sks-cluster-versions"] ?? []).filter((v) => v > current),
      });
    }
    case "nlb": {
      const [lb, pools] = await Promise.all([
        soft(api.get<Json>(zone, `/load-balancer/${id}`)),
        soft(api.get<{ "instance-pools"?: Json[] }>(zone, "/instance-pool")),
      ]);
      return stash(r, {
        services: lb?.["services"] ?? null,
        pools: (pools?.["instance-pools"] ?? []).map((p) => ({
          id: str(p["id"]),
          label: str(p["name"]),
        })),
      });
    }
    case "dbaas": {
      const type = String(r.fields["type"] ?? "");
      const full = await soft(api.get<Json>(zone, `/dbaas-${dbaasPath(type)}/${id}`));
      return stash(r, { users: full?.["users"] ?? null, backups: full?.["backups"] ?? null });
    }
    default:
      return r;
  }
}
