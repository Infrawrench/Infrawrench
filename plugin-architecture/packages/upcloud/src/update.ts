/**
 * Edit-form updates (only the changed keys arrive). Legacy IaaS objects are
 * modified with PUT and a wrapped body (`{ server: {...} }`); managed
 * services with PATCH and a bare body.
 */

import { type UpCloudApi, intOr, labelsFromText, listValue, splitPair, trailingId } from "./api.js";
import { simpleBackupValue } from "./create.js";

const has = (f: Record<string, string>, k: string) => Object.prototype.hasOwnProperty.call(f, k);
const bool = (v: string | undefined) => v === "true";

export function backupRuleBody(text: string | undefined): Record<string, string> | null {
  const [interval, time, retention] = (text ?? "").split(",").map((s) => s.trim());
  if (!interval) return null;
  return { interval, time: time || "0430", retention: retention || "7" };
}

export async function applyUpdate(
  api: UpCloudApi,
  typeId: string,
  resourceId: string,
  fields: Record<string, string>,
): Promise<void> {
  const id = trailingId(resourceId);
  const [a, b] = splitPair(id);
  const body: Record<string, unknown> = {};
  const copy = (key: string, target: string, map: (v: string) => unknown = (v) => v) => {
    if (has(fields, key)) body[target] = map(fields[key] ?? "");
  };
  switch (typeId) {
    case "server":
      copy("title", "title");
      copy("hostname", "hostname");
      copy("plan", "plan");
      copy("firewall", "firewall", (v) => (bool(v) ? "on" : "off"));
      copy("simpleBackup", "simple_backup", simpleBackupValue);
      copy("labels", "labels", (v) => ({ label: labelsFromText(v) }));
      if (Object.keys(body).length) await api.send("PUT", `/server/${id}`, { server: body });
      return;
    case "storage":
      copy("title", "title");
      copy("sizeGb", "size", (v) => String(intOr(v)));
      copy("backupRule", "backup_rule", (v) => backupRuleBody(v) ?? {});
      copy("labels", "labels", (v) => labelsFromText(v));
      if (Object.keys(body).length) await api.send("PUT", `/storage/${id}`, { storage: body });
      return;
    case "template":
      copy("title", "title");
      if (Object.keys(body).length) await api.send("PUT", `/storage/${id}`, { storage: body });
      return;
    case "network":
      copy("name", "name");
      copy("labels", "labels", (v) => labelsFromText(v));
      if (Object.keys(body).length) await api.send("PUT", `/network/${id}`, { network: body });
      return;
    case "router":
      copy("name", "name");
      copy("labels", "labels", (v) => labelsFromText(v));
      if (Object.keys(body).length) await api.send("PATCH", `/router/${id}`, { router: body });
      return;
    case "floating-ip":
      copy("ptrRecord", "ptr_record");
      if (Object.keys(body).length)
        await api.send("PATCH", `/ip_address/${id}`, { ip_address: body });
      return;
    case "kubernetes-cluster":
      copy("controlPlaneIpFilter", "control_plane_ip_filter", listValue);
      copy("labels", "labels", (v) => labelsFromText(v));
      if (Object.keys(body).length) await api.send("PATCH", `/kubernetes/${id}`, body);
      return;
    case "node-group":
      copy("count", "count", (v) => intOr(v, 1));
      if (Object.keys(body).length)
        await api.send("PATCH", `/kubernetes/${a}/node-groups/${encodeURIComponent(b)}`, body);
      return;
    case "database": {
      copy("title", "title");
      copy("plan", "plan");
      copy("powered", "powered", bool);
      copy("terminationProtection", "termination_protection", bool);
      copy("labels", "labels", (v) => labelsFromText(v));
      const props: Record<string, unknown> = {};
      if (has(fields, "ipFilter")) props["ip_filter"] = listValue(fields["ipFilter"]);
      if (has(fields, "publicAccess")) props["public_access"] = bool(fields["publicAccess"]);
      if (Object.keys(props).length) body["properties"] = props;
      if (has(fields, "maintenanceDow") || has(fields, "maintenanceTime")) {
        body["maintenance"] = {
          ...(fields["maintenanceDow"] ? { dow: fields["maintenanceDow"] } : {}),
          ...(fields["maintenanceTime"] ? { time: fields["maintenanceTime"] } : {}),
        };
      }
      if (Object.keys(body).length) await api.send("PATCH", `/database/${id}`, body);
      return;
    }
    case "database-user":
      if (fields["password"]) {
        await api.send("PATCH", `/database/${a}/users/${encodeURIComponent(b)}`, {
          password: fields["password"],
        });
      }
      return;
    case "load-balancer":
      copy("name", "name");
      copy("plan", "plan");
      copy("configuredStatus", "configured_status");
      copy("labels", "labels", (v) => labelsFromText(v));
      if (Object.keys(body).length) await api.send("PATCH", `/load-balancer/${id}`, body);
      return;
    case "object-storage":
      copy("name", "name");
      copy("configuredStatus", "configured_status");
      copy("labels", "labels", (v) => labelsFromText(v));
      if (Object.keys(body).length) await api.send("PATCH", `/object-storage-2/${id}`, body);
      return;
    default:
      throw new Error(`UpCloud plugin: "${typeId}" cannot be edited`);
  }
}
