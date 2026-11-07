/**
 * Edit-form updates (only changed keys arrive). Exoscale splits instance
 * edits: `PUT /instance/{id}` (name, labels), `:scale` (type; the instance
 * must be stopped) and `:resize-disk` (grow only).
 */

import {
  DEFAULT_ZONE,
  type ExoscaleApi,
  byId,
  intOr,
  labelsFromText,
  listValue,
  rawId,
  trailingId,
  zonal,
} from "./api.js";
import { recordBody } from "./create.js";
import { dbaasPath, str } from "./listers.js";

const has = (f: Record<string, string>, k: string) => Object.prototype.hasOwnProperty.call(f, k);

/** Resolve `family.size` (or an id) to an instance type id. */
export async function instanceTypeId(api: ExoscaleApi, value: string): Promise<string> {
  if (/^[0-9a-f-]{36}$/i.test(value)) return value;
  const res = await api.at(DEFAULT_ZONE).get("/instance-type");
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
  const z = api.at(zone);
  const ref = rawId(id);
  // A PUT only goes out when the form changed something it carries. Each body writes
  // its keys out, so the document checks them; an unchanged field is undefined and
  // is not sent.
  const edited = (...keys: string[]) => keys.some((k) => has(fields, k));
  const labels = has(fields, "labels") ? labelsFromText(fields["labels"]) : undefined;
  switch (typeId) {
    case "instance": {
      if (edited("name", "labels"))
        await z.settle(z.put(`/instance/${ref}`, { body: { name: fields["name"], labels } }));
      if (has(fields, "instanceType") && fields["instanceType"]) {
        await z.settle(
          z.put(`/instance/${ref}:scale`, {
            body: {
              "instance-type": byId(await instanceTypeId(api, fields["instanceType"])),
            },
          }),
        );
      }
      if (has(fields, "diskGb"))
        await z.settle(
          z.put(`/instance/${ref}:resize-disk`, {
            body: { "disk-size": intOr(fields["diskGb"]) },
          }),
        );
      return;
    }
    case "block-storage":
      if (edited("name", "labels"))
        await z.settle(z.put(`/block-storage/${ref}`, { body: { name: fields["name"], labels } }));
      if (has(fields, "sizeGb"))
        await z.put(`/block-storage/${ref}:resize-volume`, {
          body: { size: intOr(fields["sizeGb"]) },
        });
      return;
    case "block-storage-snapshot":
      if (edited("name"))
        await z.settle(z.put(`/block-storage-snapshot/${ref}`, { body: { name: fields["name"] } }));
      return;
    case "template":
      if (edited("name", "description"))
        await z.settle(
          z.put(`/template/${ref}`, {
            body: { name: fields["name"], description: fields["description"] },
          }),
        );
      return;
    case "private-network":
      if (edited("name", "description", "labels"))
        await z.settle(
          z.put(`/private-network/${ref}`, {
            body: { name: fields["name"], description: fields["description"], labels },
          }),
        );
      return;
    case "elastic-ip":
      if (edited("description", "labels"))
        await z.settle(
          z.put(`/elastic-ip/${ref}`, {
            body: { description: fields["description"], labels },
          }),
        );
      return;
    case "sks-cluster":
      if (edited("name", "description", "autoUpgrade", "allowedNetworks", "labels"))
        await z.settle(
          z.put(`/sks-cluster/${ref}`, {
            body: {
              name: fields["name"],
              description: fields["description"],
              "auto-upgrade": has(fields, "autoUpgrade")
                ? fields["autoUpgrade"] === "true"
                : undefined,
              "allowed-networks": has(fields, "allowedNetworks")
                ? listValue(fields["allowedNetworks"])
                : undefined,
              labels,
            },
          }),
        );
      return;
    case "sks-nodepool": {
      const [clusterId, poolId] = id.split("/");
      const pool = `/sks-cluster/${rawId(clusterId)}/nodepool/${rawId(poolId)}` as const;
      if (edited("name", "description", "diskGb", "labels"))
        await z.settle(
          z.put(pool, {
            body: {
              name: fields["name"],
              description: fields["description"],
              "disk-size": intOr(fields["diskGb"]),
              labels,
            },
          }),
        );
      if (has(fields, "size"))
        await z.settle(
          z.put(`${pool}:scale`, {
            body: { size: intOr(fields["size"], 1) },
          }),
        );
      return;
    }
    case "nlb":
      if (edited("name", "description", "labels"))
        await z.settle(
          z.put(`/load-balancer/${ref}`, {
            body: { name: fields["name"], description: fields["description"], labels },
          }),
        );
      return;
    case "instance-pool":
      if (edited("name", "description", "labels"))
        await z.settle(
          z.put(`/instance-pool/${ref}`, {
            body: { name: fields["name"], description: fields["description"], labels },
          }),
        );
      if (has(fields, "size"))
        await z.settle(
          z.put(`/instance-pool/${ref}:scale`, {
            body: { size: intOr(fields["size"], 1) },
          }),
        );
      return;
    case "dbaas": {
      const svc = await api.at(DEFAULT_ZONE).get("/dbaas-service");
      const type = str((svc["dbaas-services"] ?? []).find((s) => s["name"] === id)?.["type"]);
      if (!type) throw new Error("That database service no longer exists.");
      if (
        edited("plan", "ipFilter", "terminationProtection", "maintenanceDow", "maintenanceTime")
      ) {
        await z.settle(
          z.put(`/dbaas-${rawId(dbaasPath(type))}/${ref}`, {
            body: {
              plan: fields["plan"],
              "ip-filter": has(fields, "ipFilter") ? listValue(fields["ipFilter"]) : undefined,
              "termination-protection": has(fields, "terminationProtection")
                ? fields["terminationProtection"] === "true"
                : undefined,
              maintenance:
                has(fields, "maintenanceDow") || has(fields, "maintenanceTime")
                  ? {
                      dow: fields["maintenanceDow"] || "sunday",
                      time: fields["maintenanceTime"] || "03:00:00",
                    }
                  : undefined,
            },
          }),
        );
      }
      return;
    }
    case "dns-record": {
      const [domainId, recordId] = trailingId(resourceId).split("/");
      const record = `/dns-domain/${rawId(domainId)}/record/${rawId(recordId)}` as const;
      const current = await api.at(DEFAULT_ZONE).get(record);
      const merged = {
        type: str(current["type"]),
        name: str(current["name"]),
        content: str(current["content"]),
        ttl: str(current["ttl"]),
        priority: str(current["priority"]),
        ...fields,
      };
      const dns = api.at(DEFAULT_ZONE);
      await dns.settle(dns.put(record, { body: recordBody(merged, false) }));
      return;
    }
    default:
      throw new Error(`Exoscale plugin: "${typeId}" cannot be edited`);
  }
}
