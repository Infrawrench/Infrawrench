/**
 * Deletes, drag-attach, one-click actions and prompted actions
 * (`executeNoSqlCommand`; `args[0]` is the prompt's JSON-encoded form).
 */

import { decodePromptArgs } from "@infrawrench/plugin-base";
import { type CivoApi, intOr, listValue, regional, trailingId } from "./api.js";
import { firewallRule } from "./create.js";
import type { CivoLoadBalancer } from "./types.js";

export async function deleteResource(
  api: CivoApi,
  typeId: string,
  resourceId: string,
): Promise<void> {
  const { region, id } = regional(resourceId);
  const [a, b] = id.split("/");
  const del = (path: string, r: string | undefined = region) =>
    api.send("DELETE", path, r).then(() => undefined);
  switch (typeId) {
    case "instance":
      return del(`/instances/${id}`);
    case "volume":
      return del(`/volumes/${id}`);
    case "volume-snapshot":
      return del(`/snapshots/${id}`);
    case "instance-snapshot":
      return del(`/instances/${a}/snapshots/${b}`);
    case "kubernetes-cluster":
      return del(`/kubernetes/clusters/${id}`);
    case "node-pool":
      return del(`/kubernetes/clusters/${a}/pools/${b}`);
    case "database":
      return del(`/databases/${id}`);
    case "database-backup":
      return del(`/databases/${a}/backups/${b}`);
    case "load-balancer":
      return del(`/loadbalancers/${id}`);
    case "firewall":
      return del(`/firewalls/${id}`);
    case "network":
      return del(`/networks/${id}`);
    case "reserved-ip":
      return del(`/ips/${id}`);
    case "object-store":
      return del(`/objectstores/${id}`);
    case "object-store-credential":
      return del(`/objectstore/credentials/${id}`);
    case "domain":
      return del(`/dns/${trailingId(resourceId)}`, undefined);
    case "dns-record": {
      const [domainId, recordId] = trailingId(resourceId).split("/");
      return del(`/dns/${domainId}/records/${recordId}`, undefined);
    }
    case "ssh-key":
      return del(`/sshkeys/${trailingId(resourceId)}`, undefined);
    default:
      throw new Error(`Civo plugin: "${typeId}" cannot be deleted here`);
  }
}

export async function attachResource(
  api: CivoApi,
  sourceTypeId: string,
  sourceResourceId: string,
  targetTypeId: string,
  targetResourceId: string,
): Promise<void> {
  const source = regional(sourceResourceId);
  const target = regional(targetResourceId);
  if (targetTypeId !== "instance") throw new Error(`Civo plugin: cannot attach to ${targetTypeId}`);
  switch (sourceTypeId) {
    case "volume":
      await api.send("PUT", `/volumes/${source.id}/attach`, source.region, {
        instance_id: target.id,
        attach_at_boot: false,
      });
      return;
    case "firewall":
      await api.send("PUT", `/instances/${target.id}/firewall`, target.region, {
        firewall_id: source.id,
      });
      return;
    case "reserved-ip":
      await api.send("POST", `/ips/${source.id}/actions`, source.region, {
        action: "assign",
        assign_to_id: target.id,
        assign_to_type: "instance",
      });
      return;
    default:
      throw new Error(`Civo plugin: cannot attach ${sourceTypeId} to an instance`);
  }
}

export async function invokeAction(
  api: CivoApi,
  typeId: string,
  resourceId: string,
  actionId: string,
): Promise<void> {
  const { region, id } = regional(resourceId);
  if (typeId === "instance") {
    switch (actionId) {
      case "start":
      case "stop":
        return void (await api.send("PUT", `/instances/${id}/${actionId}`, region));
      case "reboot":
        return void (await api.send("POST", `/instances/${id}/soft_reboots`, region));
      case "hard-reboot":
        return void (await api.send("POST", `/instances/${id}/hard_reboots`, region));
      case "enable-recovery":
        return void (await api.send("PUT", `/instances/${id}/recovery`, region));
      case "disable-recovery":
        return void (await api.send("DELETE", `/instances/${id}/recovery`, region));
    }
  }
  if (typeId === "volume" && actionId === "detach") {
    return void (await api.send("PUT", `/volumes/${id}/detach`, region));
  }
  if (typeId === "reserved-ip" && actionId === "unassign") {
    return void (await api.send("POST", `/ips/${id}/actions`, region, { action: "unassign" }));
  }
  if (typeId === "kubernetes-cluster" && actionId === "upgrade") {
    const cluster = await api.get<{ upgrade_available_to?: string }>(`/kubernetes/clusters/${id}`, {
      region,
    });
    if (!cluster.upgrade_available_to)
      throw new Error("Civo offers no newer version for this cluster.");
    return void (await api.send("PUT", `/kubernetes/clusters/${id}`, region, {
      kubernetes_version: cluster.upgrade_available_to,
    }));
  }
  throw new Error(`Civo plugin: unknown action "${actionId}" for ${typeId}`);
}

export async function executeCommand(
  api: CivoApi,
  typeId: string,
  resourceId: string,
  command: string,
  args: (string | number)[],
): Promise<unknown> {
  const { region, id } = regional(resourceId);
  const v = decodePromptArgs(args);
  switch (`${typeId}:${command}`) {
    case "instance:resize":
      return api.send("PUT", `/instances/${id}/resize`, region, { size: v["size"] });
    case "instance:set-firewall":
      if (!v["firewallId"]) throw new Error("Pick a firewall.");
      return api.send("PUT", `/instances/${id}/firewall`, region, { firewall_id: v["firewallId"] });
    case "instance:snapshot":
      return api.send("POST", `/instances/${id}/snapshots`, region, {
        name: v["name"],
        ...(v["description"] ? { description: v["description"] } : {}),
      });
    case "instance-snapshot:restore": {
      const [instanceId, snapshotId] = id.split("/");
      return api.send("POST", `/instances/${instanceId}/snapshots/${snapshotId}/restore`, region, {
        ...(v["hostname"] ? { hostname: v["hostname"] } : {}),
        overwrite_existing: v["overwrite"] === "true",
      });
    }
    case "volume:attach":
      if (!v["instanceId"]) throw new Error("Pick the instance to attach to.");
      return api.send("PUT", `/volumes/${id}/attach`, region, {
        instance_id: v["instanceId"],
        attach_at_boot: v["attachAtBoot"] === "true",
      });
    case "reserved-ip:assign":
      if (!v["instanceId"]) throw new Error("Pick the instance to assign to.");
      return api.send("POST", `/ips/${id}/actions`, region, {
        action: "assign",
        assign_to_id: v["instanceId"],
        assign_to_type: "instance",
      });
    case "firewall:add-rule": {
      const cidr = listValue(v["cidr"]);
      return api.send(
        "POST",
        `/firewalls/${id}/rules`,
        region,
        firewallRule(
          (v["protocol"] || "tcp").toLowerCase(),
          v["protocol"] === "icmp" ? "all" : (v["ports"] || "").trim(),
          cidr.length ? cidr : ["0.0.0.0/0"],
          v["label"] ?? "",
          v["direction"] || "ingress",
          v["action"] || "allow",
        ),
      );
    }
    case "firewall:remove-rule":
      return api.send("DELETE", `/firewalls/${id}/rules/${v["ruleId"]}`, region);
    case "kubernetes-cluster:recycle-node":
      if (!v["hostname"]) throw new Error("Pick the node to recycle.");
      return api.send("POST", `/kubernetes/clusters/${id}/recycle`, region, {
        hostname: v["hostname"],
      });
    case "kubernetes-cluster:install-apps": {
      const apps = listValue(v["applications"]);
      if (!apps.length) throw new Error("Pick at least one application.");
      return api.send("PUT", `/kubernetes/clusters/${id}`, region, {
        applications: apps.join(","),
      });
    }
    case "kubernetes-cluster:set-firewall":
      return api.send("PUT", `/kubernetes/clusters/${id}`, region, {
        firewall_id: v["firewallId"],
      });
    case "node-pool:delete-node": {
      const [clusterId, poolId] = id.split("/");
      return api.send(
        "DELETE",
        `/kubernetes/clusters/${clusterId}/pools/${poolId}/instances/${v["nodeId"]}`,
        region,
      );
    }
    case "database:restore":
      if (!v["backup"]) throw new Error("Pick a backup.");
      return api.send("POST", `/databases/${id}/restore`, region, {
        name: v["name"] || v["backup"],
        backup: v["backup"],
      });
    case "database:set-firewall":
      return api.send("PUT", `/databases/${id}`, region, { firewall_id: v["firewallId"] });
    case "load-balancer:set-backends": {
      const lb = await api.get<CivoLoadBalancer>(`/loadbalancers/${id}`, { region });
      const template = lb.backends?.[0];
      return api.send("PUT", `/loadbalancers/${id}`, region, {
        backends: listValue(v["backends"]).map((ip) => ({
          ip,
          protocol: v["protocol"] || template?.protocol || "TCP",
          source_port: intOr(v["sourcePort"], template?.source_port ?? 80),
          target_port: intOr(v["targetPort"], template?.target_port ?? 80),
        })),
      });
    }
    case "load-balancer:set-firewall":
      return api.send("PUT", `/loadbalancers/${id}`, region, { firewall_id: v["firewallId"] });
    default:
      throw new Error(`Civo plugin: unknown command "${command}" for ${typeId}`);
  }
}
