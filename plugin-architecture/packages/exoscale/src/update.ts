/**
 * Edit-form updates (only changed keys arrive). Exoscale splits instance
 * edits: `PUT /instance/{id}` (name, labels), `:scale` (type; the instance
 * must be stopped) and `:resize-disk` (grow only).
 */

import {
  DEFAULT_ZONE,
  type ExoscaleApi,
  intOr,
  labelsFromText,
  listValue,
  trailingId,
  zonal,
} from "./api.js";
import { recordBody } from "./create.js";
import { type Json, dbaasPath, str } from "./listers.js";

const has = (f: Record<string, string>, k: string) => Object.prototype.hasOwnProperty.call(f, k);

/** Resolve `family.size` (or an id) to an instance type id. */
export async function instanceTypeId(api: ExoscaleApi, value: string): Promise<string> {
  if (/^[0-9a-f-]{36}$/i.test(value)) return value;
  const res = await api.get<{ "instance-types"?: Json[] }>(DEFAULT_ZONE, "/instance-type");
  const [family, size] = value.includes(".") ? value.split(".") : ["standard", value];
  const t = (res["instance-types"] ?? []).find((x) => x["family"] === family && x["size"] === size);
  if (!t)
    throw new Error(
      `Exoscale has no instance type "${value}"; use family.size, e.g. standard.medium.`,
    );
  return str(t["id"]);
}

export async function applyUpdate(
  api: ExoscaleApi,
  typeId: string,
  resourceId: string,
  fields: Record<string, string>,
): Promise<void> {
  const { zone, id } = zonal(resourceId);
  const body: Record<string, unknown> = {};
  const copy = (key: string, target: string, map: (v: string) => unknown = (v) => v) => {
    if (has(fields, key)) body[target] = map(fields[key] ?? "");
  };
  const put = async (path: string, z = zone) => {
    if (Object.keys(body).length) await api.mutate(z, "PUT", path, body);
  };
  switch (typeId) {
    case "instance": {
      copy("name", "name");
      copy("labels", "labels", labelsFromText);
      await put(`/instance/${id}`);
      if (has(fields, "instanceType") && fields["instanceType"]) {
        await api.mutate(zone, "PUT", `/instance/${id}:scale`, {
          "instance-type": { id: await instanceTypeId(api, fields["instanceType"]) },
        });
      }
      if (has(fields, "diskGb"))
        await api.mutate(zone, "PUT", `/instance/${id}:resize-disk`, {
          "disk-size": intOr(fields["diskGb"]),
        });
      return;
    }
    case "block-storage":
      copy("name", "name");
      copy("labels", "labels", labelsFromText);
      await put(`/block-storage/${id}`);
      if (has(fields, "sizeGb"))
        await api.send(zone, "PUT", `/block-storage/${id}:resize-volume`, {
          size: intOr(fields["sizeGb"]),
        });
      return;
    case "block-storage-snapshot":
      copy("name", "name");
      return put(`/block-storage-snapshot/${id}`);
    case "template":
      copy("name", "name");
      copy("description", "description");
      return put(`/template/${id}`);
    case "private-network":
      copy("name", "name");
      copy("description", "description");
      copy("labels", "labels", labelsFromText);
      return put(`/private-network/${id}`);
    case "elastic-ip":
      copy("description", "description");
      copy("labels", "labels", labelsFromText);
      return put(`/elastic-ip/${id}`);
    case "sks-cluster":
      copy("name", "name");
      copy("description", "description");
      copy("autoUpgrade", "auto-upgrade", (v) => v === "true");
      copy("allowedNetworks", "allowed-networks", listValue);
      copy("labels", "labels", labelsFromText);
      return put(`/sks-cluster/${id}`);
    case "sks-nodepool": {
      const [clusterId, poolId] = id.split("/");
      copy("name", "name");
      copy("description", "description");
      copy("diskGb", "disk-size", (v) => intOr(v));
      copy("labels", "labels", labelsFromText);
      await put(`/sks-cluster/${clusterId}/nodepool/${poolId}`);
      if (has(fields, "size"))
        await api.mutate(zone, "PUT", `/sks-cluster/${clusterId}/nodepool/${poolId}:scale`, {
          size: intOr(fields["size"], 1),
        });
      return;
    }
    case "nlb":
      copy("name", "name");
      copy("description", "description");
      copy("labels", "labels", labelsFromText);
      return put(`/load-balancer/${id}`);
    case "instance-pool":
      copy("name", "name");
      copy("description", "description");
      copy("labels", "labels", labelsFromText);
      await put(`/instance-pool/${id}`);
      if (has(fields, "size"))
        await api.mutate(zone, "PUT", `/instance-pool/${id}:scale`, {
          size: intOr(fields["size"], 1),
        });
      return;
    case "dbaas": {
      const svc = await api.get<{ "dbaas-services"?: Json[] }>(DEFAULT_ZONE, "/dbaas-service");
      const type = str((svc["dbaas-services"] ?? []).find((s) => s["name"] === id)?.["type"]);
      if (!type) throw new Error("That database service no longer exists.");
      copy("plan", "plan");
      copy("ipFilter", "ip-filter", listValue);
      copy("terminationProtection", "termination-protection", (v) => v === "true");
      if (has(fields, "maintenanceDow") || has(fields, "maintenanceTime")) {
        body["maintenance"] = {
          dow: fields["maintenanceDow"] || "sunday",
          time: fields["maintenanceTime"] || "03:00:00",
        };
      }
      return put(`/dbaas-${dbaasPath(type)}/${id}`);
    }
    case "dns-record": {
      const [domainId, recordId] = trailingId(resourceId).split("/");
      const current = await api.get<Json>(
        DEFAULT_ZONE,
        `/dns-domain/${domainId}/record/${recordId}`,
      );
      const merged = {
        type: str(current["type"]),
        name: str(current["name"]),
        content: str(current["content"]),
        ttl: str(current["ttl"]),
        priority: str(current["priority"]),
        ...fields,
      };
      await api.mutate(
        DEFAULT_ZONE,
        "PUT",
        `/dns-domain/${domainId}/record/${recordId}`,
        recordBody(merged, false),
      );
      return;
    }
    default:
      throw new Error(`Exoscale plugin: "${typeId}" cannot be edited`);
  }
}
