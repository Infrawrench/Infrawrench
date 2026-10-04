/**
 * Edits. The host sends only the changed keys, spelled as the type's
 * fields; each branch maps them onto the one or two endpoints Linode splits
 * an edit across (a label is a PUT, a plan change is an action).
 */

import { type LinodeApi, formBool, trailingId } from "./api.js";
import { listValue, recordBody } from "./create.js";
import type { LinodeFirewall, LinodeInstance } from "./types.js";

const has = (fields: Record<string, string>, ...keys: string[]) => keys.some((k) => k in fields);
const intOf = (v: string | undefined) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : undefined;
};

export async function applyUpdate(
  api: LinodeApi,
  typeId: string,
  resourceId: string,
  fields: Record<string, string>,
): Promise<void> {
  const id = trailingId(resourceId);
  switch (typeId) {
    case "linode": {
      const body: Record<string, unknown> = {};
      if ("label" in fields) body["label"] = fields["label"];
      if ("tags" in fields) body["tags"] = listValue(fields["tags"]);
      const watchdog = formBool(fields["watchdogEnabled"]);
      if (watchdog !== undefined) body["watchdog_enabled"] = watchdog;
      if (Object.keys(body).length) await api.send("PUT", `/linode/instances/${id}`, body);
      if (fields["type"]) {
        const current = await api.get<LinodeInstance>(`/linode/instances/${id}`);
        if (current.lke_cluster_id != null) {
          throw new Error(
            "This Linode is an LKE worker node. Change the node pool's plan instead: add a pool with the new plan and remove the old one.",
          );
        }
        if (current.type !== fields["type"]) {
          await api.send("POST", `/linode/instances/${id}/resize`, {
            type: fields["type"],
            allow_auto_disk_resize: true,
            migration_type: "cold",
          });
        }
      }
      return;
    }
    case "volume": {
      const body: Record<string, unknown> = {};
      if ("label" in fields) body["label"] = fields["label"];
      if ("tags" in fields) body["tags"] = listValue(fields["tags"]);
      if (Object.keys(body).length) await api.send("PUT", `/volumes/${id}`, body);
      if (fields["sizeGb"]) {
        const size = intOf(fields["sizeGb"]);
        const current = await api.get<{ size?: number }>(`/volumes/${id}`);
        if (size !== undefined && size < (current.size ?? 0)) {
          throw new Error(
            "Linode volumes can only grow. Create a smaller volume and copy the data instead.",
          );
        }
        if (size !== undefined && size !== current.size) {
          await api.send("POST", `/volumes/${id}/resize`, { size });
        }
      }
      return;
    }
    case "nodebalancer": {
      const body: Record<string, unknown> = {};
      if ("label" in fields) body["label"] = fields["label"];
      if ("clientConnThrottle" in fields)
        body["client_conn_throttle"] = intOf(fields["clientConnThrottle"]) ?? 0;
      if ("tags" in fields) body["tags"] = listValue(fields["tags"]);
      if (Object.keys(body).length) await api.send("PUT", `/nodebalancers/${id}`, body);
      return;
    }
    case "lke-cluster": {
      const body: Record<string, unknown> = {};
      if ("label" in fields) body["label"] = fields["label"];
      if ("k8sVersion" in fields) body["k8s_version"] = fields["k8sVersion"];
      if ("tags" in fields) body["tags"] = listValue(fields["tags"]);
      const ha = formBool(fields["highAvailability"]);
      if (ha === false) {
        throw new Error("A high-availability control plane cannot be turned off once enabled.");
      }
      if (ha === true) body["control_plane"] = { high_availability: true };
      if (Object.keys(body).length) await api.send("PUT", `/lke/clusters/${id}`, body);
      return;
    }
    case "lke-node-pool": {
      const [clusterId, poolId] = id.split("/");
      const body: Record<string, unknown> = {};
      if ("count" in fields) body["count"] = intOf(fields["count"]);
      if (has(fields, "autoscalerEnabled", "autoscalerMin", "autoscalerMax")) {
        const current = await api.get<{
          autoscaler?: { enabled?: boolean; min?: number; max?: number };
        }>(`/lke/clusters/${clusterId}/pools/${poolId}`);
        body["autoscaler"] = {
          enabled: formBool(fields["autoscalerEnabled"]) ?? current.autoscaler?.enabled ?? false,
          min: intOf(fields["autoscalerMin"]) ?? current.autoscaler?.min ?? 1,
          max: intOf(fields["autoscalerMax"]) ?? current.autoscaler?.max ?? 1,
        };
      }
      if ("tags" in fields) body["tags"] = listValue(fields["tags"]);
      if (Object.keys(body).length)
        await api.send("PUT", `/lke/clusters/${clusterId}/pools/${poolId}`, body);
      return;
    }
    case "bucket": {
      const [region, ...rest] = id.split("/");
      const name = rest.join("/");
      const body: Record<string, unknown> = {};
      if (fields["acl"]) body["acl"] = fields["acl"];
      const cors = formBool(fields["corsEnabled"]);
      if (cors !== undefined) body["cors_enabled"] = cors;
      if (Object.keys(body).length) {
        await api.send(
          "PUT",
          `/object-storage/buckets/${region}/${encodeURIComponent(name)}/access`,
          body,
        );
      }
      return;
    }
    case "database": {
      const [engine, dbId] = id.split("/");
      const body: Record<string, unknown> = {};
      if ("label" in fields) body["label"] = fields["label"];
      if ("allowList" in fields) body["allow_list"] = listValue(fields["allowList"]);
      if (fields["type"]) body["type"] = fields["type"];
      if (Object.keys(body).length)
        await api.send("PUT", `/databases/${engine}/instances/${dbId}`, body);
      return;
    }
    case "firewall": {
      const body: Record<string, unknown> = {};
      if ("label" in fields) body["label"] = fields["label"];
      if ("tags" in fields) body["tags"] = listValue(fields["tags"]);
      if (fields["status"]) body["status"] = fields["status"];
      if (Object.keys(body).length) await api.send("PUT", `/networking/firewalls/${id}`, body);
      if (fields["inboundPolicy"] || fields["outboundPolicy"]) {
        const current = await api.get<NonNullable<LinodeFirewall["rules"]>>(
          `/networking/firewalls/${id}/rules`,
        );
        await api.send("PUT", `/networking/firewalls/${id}/rules`, {
          inbound: current.inbound ?? [],
          outbound: current.outbound ?? [],
          inbound_policy: fields["inboundPolicy"] || current.inbound_policy,
          outbound_policy: fields["outboundPolicy"] || current.outbound_policy,
        });
      }
      return;
    }
    case "domain": {
      const body: Record<string, unknown> = {};
      if (fields["status"]) body["status"] = fields["status"];
      if ("soaEmail" in fields) body["soa_email"] = fields["soaEmail"];
      if ("ttlSec" in fields) body["ttl_sec"] = intOf(fields["ttlSec"]) ?? 0;
      if ("masterIps" in fields) body["master_ips"] = listValue(fields["masterIps"]);
      if ("description" in fields) body["description"] = fields["description"];
      if ("tags" in fields) body["tags"] = listValue(fields["tags"]);
      if (Object.keys(body).length) await api.send("PUT", `/domains/${id}`, body);
      return;
    }
    case "domain-record": {
      const [domainId, recordId] = id.split("/");
      const current = await api.get<Record<string, unknown>>(
        `/domains/${domainId}/records/${recordId}`,
      );
      const merged: Record<string, string> = {
        type: String(current["type"] ?? "A"),
        name: String(current["name"] ?? ""),
        target: String(current["target"] ?? ""),
        ttlSec: String(current["ttl_sec"] ?? 0),
        priority: String(current["priority"] ?? 0),
        weight: String(current["weight"] ?? 0),
        port: String(current["port"] ?? 0),
        service: String(current["service"] ?? ""),
        protocol: String(current["protocol"] ?? ""),
        tag: String(current["tag"] ?? ""),
        ...fields,
      };
      const body = recordBody(merged);
      delete body["type"]; // a record's type cannot change
      await api.send("PUT", `/domains/${domainId}/records/${recordId}`, body);
      return;
    }
    case "vpc": {
      const body: Record<string, unknown> = {};
      if ("label" in fields) body["label"] = fields["label"];
      if ("description" in fields) body["description"] = fields["description"];
      if (Object.keys(body).length) await api.send("PUT", `/vpcs/${id}`, body);
      return;
    }
    case "image": {
      const body: Record<string, unknown> = {};
      if ("label" in fields) body["label"] = fields["label"];
      if ("description" in fields) body["description"] = fields["description"];
      if ("tags" in fields) body["tags"] = listValue(fields["tags"]);
      if (Object.keys(body).length)
        await api.send("PUT", `/images/${encodeURIComponent(id)}`, body);
      return;
    }
    case "stackscript": {
      const body: Record<string, unknown> = {};
      if ("label" in fields) body["label"] = fields["label"];
      if ("description" in fields) body["description"] = fields["description"];
      if ("images" in fields) body["images"] = listValue(fields["images"]);
      if ("script" in fields) body["script"] = fields["script"];
      if ("revNote" in fields) body["rev_note"] = fields["revNote"];
      const isPublic = formBool(fields["isPublic"]);
      if (isPublic === false) {
        throw new Error("A public StackScript cannot be made private again.");
      }
      if (isPublic === true) body["is_public"] = true;
      if (Object.keys(body).length) await api.send("PUT", `/linode/stackscripts/${id}`, body);
      return;
    }
    case "reserved-ip": {
      if ("tags" in fields) {
        await api.send("PUT", `/networking/reserved/ips/${id}`, {
          tags: listValue(fields["tags"]),
        });
      }
      return;
    }
    default:
      throw new Error(`Linode plugin: "${typeId}" cannot be edited`);
  }
}
