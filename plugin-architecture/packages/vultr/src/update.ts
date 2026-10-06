/**
 * Edit-form updates. `fields` holds only the keys the user changed; each
 * branch sends the smallest body Vultr accepts for the endpoint (PATCH where
 * Vultr offers it, PUT for VKE, databases, firewall groups, VPCs, snapshots,
 * domains and object storage, which is what the API defines for them).
 */

import { type VultrApi, formBool, intOr, listValue, toBase64, trailingId } from "./api.js";

function split(id: string): [string, string] {
  const i = id.indexOf("/");
  return i < 0 ? [id, ""] : [id.slice(0, i), id.slice(i + 1)];
}

const has = (fields: Record<string, string>, key: string) =>
  Object.prototype.hasOwnProperty.call(fields, key);

/** Copy `fields[key]` into `body[target]` when the user changed it. */
function pick(
  body: Record<string, unknown>,
  fields: Record<string, string>,
  key: string,
  target: string,
  map: (v: string) => unknown = (v) => v,
): void {
  if (!has(fields, key)) return;
  const value = map(fields[key] ?? "");
  if (value !== undefined) body[target] = value;
}

export async function applyUpdate(
  api: VultrApi,
  typeId: string,
  resourceId: string,
  fields: Record<string, string>,
): Promise<void> {
  const id = trailingId(resourceId);
  const [a, b] = split(id);
  const body: Record<string, unknown> = {};
  const send = async (method: "PATCH" | "PUT", path: string) => {
    if (Object.keys(body).length > 0) await api.send(method, path, body);
  };
  switch (typeId) {
    case "instance":
      pick(body, fields, "label", "label");
      pick(body, fields, "plan", "plan");
      pick(body, fields, "tags", "tags", listValue);
      pick(body, fields, "backupsEnabled", "backups", (v) =>
        formBool(v) === undefined ? undefined : formBool(v) ? "enabled" : "disabled",
      );
      pick(body, fields, "ddosProtection", "ddos_protection", formBool);
      return send("PATCH", `/instances/${id}`);
    case "bare-metal":
      pick(body, fields, "label", "label");
      pick(body, fields, "tags", "tags", listValue);
      return send("PATCH", `/bare-metals/${id}`);
    case "block-storage":
      pick(body, fields, "label", "label");
      pick(body, fields, "sizeGb", "size_gb", (v) => intOr(v));
      return send("PATCH", `/blocks/${id}`);
    case "snapshot":
      pick(body, fields, "description", "description");
      return send("PUT", `/snapshots/${id}`);
    case "kubernetes-cluster":
      pick(body, fields, "label", "label");
      return send("PUT", `/kubernetes/clusters/${id}`);
    case "node-pool":
      pick(body, fields, "nodeQuantity", "node_quantity", (v) => intOr(v));
      pick(body, fields, "autoScaler", "auto_scaler", formBool);
      pick(body, fields, "minNodes", "min_nodes", (v) => intOr(v));
      pick(body, fields, "maxNodes", "max_nodes", (v) => intOr(v));
      pick(body, fields, "tag", "tag");
      return send("PATCH", `/kubernetes/clusters/${a}/node-pools/${b}`);
    case "database":
      pick(body, fields, "label", "label");
      pick(body, fields, "plan", "plan");
      pick(body, fields, "tag", "tag");
      pick(body, fields, "trustedIps", "trusted_ips", listValue);
      pick(body, fields, "maintenanceDow", "maintenance_dow");
      pick(body, fields, "maintenanceTime", "maintenance_time");
      return send("PUT", `/databases/${id}`);
    case "database-user":
      if (!fields["password"]) return;
      body["password"] = fields["password"];
      return send("PUT", `/databases/${a}/users/${encodeURIComponent(b)}`);
    case "load-balancer":
      pick(body, fields, "label", "label");
      pick(body, fields, "nodes", "nodes", (v) => intOr(v));
      pick(body, fields, "balancingAlgorithm", "balancing_algorithm");
      pick(body, fields, "sslRedirect", "ssl_redirect", formBool);
      pick(body, fields, "proxyProtocol", "proxy_protocol", formBool);
      return send("PATCH", `/load-balancers/${id}`);
    case "firewall-group":
      pick(body, fields, "description", "description");
      return send("PUT", `/firewalls/${id}`);
    case "vpc":
      pick(body, fields, "description", "description");
      return send("PUT", `/vpcs/${id}`);
    case "reserved-ip":
      pick(body, fields, "label", "label");
      return send("PATCH", `/reserved-ips/${id}`);
    case "domain": {
      const domain = encodeURIComponent(id);
      if (has(fields, "dnsSec")) {
        await api.send("PUT", `/domains/${domain}`, {
          dns_sec: fields["dnsSec"] === "enabled" ? "enabled" : "disabled",
        });
      }
      pick(body, fields, "soaPrimary", "nsprimary");
      pick(body, fields, "soaEmail", "email");
      return send("PATCH", `/domains/${domain}/soa`);
    }
    case "dns-record":
      pick(body, fields, "name", "name", (v) => (v.trim() === "@" ? "" : v.trim()));
      pick(body, fields, "data", "data");
      pick(body, fields, "ttl", "ttl", (v) => intOr(v));
      pick(body, fields, "priority", "priority", (v) => intOr(v));
      return send("PATCH", `/domains/${encodeURIComponent(a)}/records/${b}`);
    case "object-storage":
      pick(body, fields, "label", "label");
      return send("PUT", `/object-storage/${id}`);
    case "ssh-key":
      pick(body, fields, "name", "name");
      return send("PATCH", `/ssh-keys/${id}`);
    case "startup-script":
      pick(body, fields, "name", "name");
      pick(body, fields, "script", "script", toBase64);
      return send("PATCH", `/startup-scripts/${id}`);
    default:
      throw new Error(`Vultr plugin: "${typeId}" cannot be edited`);
  }
}
