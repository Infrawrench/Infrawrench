/**
 * Edit-form updates (only changed keys arrive). Civo splits instance edits
 * across endpoints: `PUT /instances/{id}` (hostname, reverse DNS, notes),
 * `/tags`, `/resize`, `/allowed_ips` and `/network_bandwidth_limit`.
 */

import { type CivoApi, intOr, listValue, regional, trailingId } from "./api.js";
import { recordBody } from "./create.js";
import type { CivoDnsRecord } from "./types.js";

const has = (f: Record<string, string>, k: string) => Object.prototype.hasOwnProperty.call(f, k);

export async function applyUpdate(
  api: CivoApi,
  typeId: string,
  resourceId: string,
  fields: Record<string, string>,
): Promise<void> {
  const { region, id } = regional(resourceId);
  switch (typeId) {
    case "instance": {
      const basic: Record<string, unknown> = {};
      if (has(fields, "hostname")) basic["hostname"] = fields["hostname"];
      if (has(fields, "reverseDns")) basic["reverse_dns"] = fields["reverseDns"];
      if (has(fields, "notes")) basic["notes"] = fields["notes"];
      if (Object.keys(basic).length) await api.send("PUT", `/instances/${id}`, region, basic);
      if (has(fields, "tags")) {
        await api.send("PUT", `/instances/${id}/tags`, region, {
          tags: listValue(fields["tags"]).join(" "),
        });
      }
      if (has(fields, "size") && fields["size"]) {
        await api.send("PUT", `/instances/${id}/resize`, region, { size: fields["size"] });
      }
      if (has(fields, "allowedIps")) {
        await api.send("PUT", `/instances/${id}/allowed_ips`, region, {
          allowed_ips: listValue(fields["allowedIps"]),
        });
      }
      if (has(fields, "bandwidthLimit")) {
        await api.send("PUT", `/instances/${id}/network_bandwidth_limit`, region, {
          network_bandwidth_limit: intOr(fields["bandwidthLimit"], 0),
        });
      }
      return;
    }
    case "volume":
      if (has(fields, "sizeGb"))
        await api.send("PUT", `/volumes/${id}/resize`, region, {
          size_gb: intOr(fields["sizeGb"]),
        });
      return;
    case "instance-snapshot": {
      const [instanceId, snapshotId] = id.split("/");
      const body: Record<string, unknown> = {};
      if (has(fields, "name")) body["name"] = fields["name"];
      if (has(fields, "description")) body["description"] = fields["description"];
      if (Object.keys(body).length)
        await api.send("PUT", `/instances/${instanceId}/snapshots/${snapshotId}`, region, body);
      return;
    }
    case "kubernetes-cluster": {
      const body: Record<string, unknown> = {};
      if (has(fields, "name")) body["name"] = fields["name"];
      if (has(fields, "tags")) body["tags"] = listValue(fields["tags"]).join(" ");
      if (Object.keys(body).length)
        await api.send("PUT", `/kubernetes/clusters/${id}`, region, body);
      return;
    }
    case "node-pool": {
      const [clusterId, poolId] = id.split("/");
      if (has(fields, "count")) {
        await api.send("PUT", `/kubernetes/clusters/${clusterId}/pools/${poolId}`, region, {
          count: intOr(fields["count"], 1),
        });
      }
      return;
    }
    case "database": {
      const body: Record<string, unknown> = {};
      if (has(fields, "name")) body["name"] = fields["name"];
      if (has(fields, "nodes")) body["nodes"] = intOr(fields["nodes"], 1);
      if (Object.keys(body).length) await api.send("PUT", `/databases/${id}`, region, body);
      return;
    }
    case "database-backup": {
      const [databaseId, backupId] = id.split("/");
      const body: Record<string, unknown> = {};
      if (has(fields, "schedule")) body["schedule"] = fields["schedule"];
      if (Object.keys(body).length)
        await api.send("PUT", `/databases/${databaseId}/backups/${backupId}`, region, body);
      return;
    }
    case "load-balancer": {
      const body: Record<string, unknown> = {};
      if (has(fields, "name")) body["name"] = fields["name"];
      if (has(fields, "algorithm")) body["algorithm"] = fields["algorithm"];
      if (has(fields, "externalTrafficPolicy"))
        body["external_traffic_policy"] = fields["externalTrafficPolicy"];
      if (has(fields, "sessionAffinity")) body["session_affinity"] = fields["sessionAffinity"];
      if (has(fields, "proxyProtocol")) body["enable_proxy_protocol"] = fields["proxyProtocol"];
      if (has(fields, "maxConcurrentRequests"))
        body["max_concurrent_requests"] = intOr(fields["maxConcurrentRequests"]);
      if (Object.keys(body).length) await api.send("PUT", `/loadbalancers/${id}`, region, body);
      return;
    }
    case "firewall":
      if (has(fields, "name"))
        await api.send("PUT", `/firewalls/${id}`, region, { name: fields["name"] });
      return;
    case "network":
      if (has(fields, "label"))
        await api.send("PUT", `/networks/${id}`, region, { label: fields["label"] });
      return;
    case "reserved-ip":
      if (has(fields, "name"))
        await api.send("PUT", `/ips/${id}`, region, { name: fields["name"] });
      return;
    case "domain":
      if (has(fields, "name"))
        await api.send("PUT", `/dns/${trailingId(resourceId)}`, undefined, {
          name: fields["name"],
        });
      return;
    case "dns-record": {
      const [domainId, recordId] = trailingId(resourceId).split("/");
      // The PUT replaces the whole record, so merge the edit onto the current one.
      const current = (await api.list<CivoDnsRecord>(`/dns/${domainId}/records`)).find(
        (r) => r.id === recordId,
      );
      const merged: Record<string, string> = {
        type: String(current?.type ?? "A"),
        name: String(current?.name ?? "@"),
        value: String(current?.value ?? ""),
        ttl: String(current?.ttl ?? 600),
        priority: String(current?.priority ?? 0),
        ...fields,
      };
      await api.send("PUT", `/dns/${domainId}/records/${recordId}`, undefined, recordBody(merged));
      return;
    }
    case "object-store":
      if (has(fields, "maxSizeGb")) {
        await api.send("PUT", `/objectstores/${id}`, region, {
          max_size_gb: intOr(fields["maxSizeGb"], 500),
        });
      }
      return;
    case "ssh-key":
      if (has(fields, "name"))
        await api.send("PUT", `/sshkeys/${trailingId(resourceId)}`, undefined, {
          name: fields["name"],
        });
      return;
    default:
      throw new Error(`Civo plugin: "${typeId}" cannot be edited`);
  }
}
