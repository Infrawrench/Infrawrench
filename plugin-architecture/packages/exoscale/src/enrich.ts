/** Detail enrichment: extra reads stashed as JSON in `resolvedOutputs.__name__`; every read fails soft. */

import type { ResourceInstance } from "@infrawrench/plugin-base";
import { DEFAULT_ZONE, type ExoscaleApi, rawId, trailingId, zonal } from "./api.js";
import { instanceTypeOptions, templateOptions } from "./create.js";
import { type DbaasService, dbaasPath, str } from "./listers.js";

async function soft<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

function stash(r: ResourceInstance, values: Record<string, object | null>): ResourceInstance {
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
      const z = api.at(zone);
      const [inst, types, images, groups, eips, nets] = await Promise.all([
        soft(z.get(`/instance/${rawId(id)}`)),
        soft(instanceTypeOptions(api)),
        soft(templateOptions(api, zone)),
        soft(api.at(DEFAULT_ZONE).get("/security-group")),
        soft(z.get("/elastic-ip")),
        soft(z.get("/private-network")),
      ]);
      const name = <T extends { id?: string }>(
        list: readonly T[] | undefined,
        label: (x: T) => string | undefined,
      ) => new Map((list ?? []).map((x) => [str(x["id"]), str(label(x))]));
      const sgNames = name(groups?.["security-groups"], (x) => x["name"]);
      const eipNames = name(eips?.["elastic-ips"], (x) => x["ip"]);
      const netNames = name(nets?.["private-networks"], (x) => x["name"]);
      const refs = (list: readonly { id?: string }[] | undefined) =>
        (list ?? []).map((x) => str(x["id"]));
      return stash(r, {
        types: (types ?? []).filter((t) => (t.availableFor ?? [zone]).includes(zone)),
        images,
        snapshots: (inst?.["snapshots"] ?? []).map((s) => ({
          id: str(s["id"]),
          label: str(s["id"]).slice(0, 8),
        })),
        securityGroups: refs(inst?.["security-groups"]).map((x) => ({
          id: x,
          label: sgNames.get(x) ?? x,
        })),
        elasticIps: refs(inst?.["elastic-ips"]).map((x) => ({
          id: x,
          label: eipNames.get(x) ?? x,
        })),
        privateNetworks: refs(inst?.["private-networks"]).map((x) => ({
          id: x,
          label: netNames.get(x) ?? x,
        })),
      });
    }
    case "security-group": {
      const g = await soft(api.at(DEFAULT_ZONE).get(`/security-group/${rawId(trailingId(r.id))}`));
      return stash(r, { rules: g?.["rules"] ?? null });
    }
    case "sks-cluster": {
      const versions = await soft(api.at(DEFAULT_ZONE).get("/sks-cluster-version"));
      const current = String(r.fields["version"] ?? "");
      return stash(r, {
        versions: (versions?.["sks-cluster-versions"] ?? []).filter((v) => v > current),
      });
    }
    case "nlb": {
      const [lb, pools] = await Promise.all([
        soft(api.at(zone).get(`/load-balancer/${rawId(id)}`)),
        soft(api.at(zone).get("/instance-pool")),
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
      const full: DbaasService | null = await soft(
        api.at(zone).get(`/dbaas-${rawId(dbaasPath(type))}/${rawId(id)}`),
      );
      return stash(r, { users: full?.["users"] ?? null, backups: full?.["backups"] ?? null });
    }
    default:
      return r;
  }
}
