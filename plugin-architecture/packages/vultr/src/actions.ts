/**
 * Deletes, drag-attach, one-click actions (`invokeAction`) and prompted
 * actions (`executeNoSqlCommand`; the host packs a prompt's form as
 * `args[0] = JSON.stringify(values)`).
 */

import { decodePromptArgs } from "@infrawrench/plugin-base";
import { type VultrApi, intOr, listValue, trailingId } from "./api.js";
import { bootSource, splitCidr } from "./create.js";
import type { VultrLoadBalancer } from "./types.js";

function split(id: string): [string, string] {
  const i = id.indexOf("/");
  return i < 0 ? [id, ""] : [id.slice(0, i), id.slice(i + 1)];
}

export async function deleteResource(
  api: VultrApi,
  typeId: string,
  resourceId: string,
): Promise<void> {
  const id = trailingId(resourceId);
  const [a, b] = split(id);
  const del = (path: string) => api.send("DELETE", path).then(() => undefined);
  switch (typeId) {
    case "instance":
      return del(`/instances/${id}`);
    case "bare-metal":
      return del(`/bare-metals/${id}`);
    case "block-storage": {
      const block = await api.get<{ block?: { attached_to_instance?: string } }>(`/blocks/${id}`);
      if (block.block?.attached_to_instance) {
        throw new Error("Detach the volume from its instance before deleting it.");
      }
      return del(`/blocks/${id}`);
    }
    case "snapshot":
      return del(`/snapshots/${id}`);
    case "kubernetes-cluster":
      return del(`/kubernetes/clusters/${id}`);
    case "node-pool":
      return del(`/kubernetes/clusters/${a}/node-pools/${b}`);
    case "database":
      return del(`/databases/${id}`);
    case "database-user":
      return del(`/databases/${a}/users/${encodeURIComponent(b)}`);
    case "database-db":
      return del(`/databases/${a}/dbs/${encodeURIComponent(b)}`);
    case "load-balancer":
      return del(`/load-balancers/${id}`);
    case "firewall-group":
      return del(`/firewalls/${id}`);
    case "vpc":
      return del(`/vpcs/${id}`);
    case "reserved-ip":
      return del(`/reserved-ips/${id}`);
    case "domain":
      return del(`/domains/${encodeURIComponent(id)}`);
    case "dns-record":
      return del(`/domains/${encodeURIComponent(a)}/records/${b}`);
    case "object-storage":
      return del(`/object-storage/${id}`);
    case "bucket":
      return del(`/object-storage/${a}/bucket/${encodeURIComponent(b)}`);
    case "ssh-key":
      return del(`/ssh-keys/${id}`);
    case "startup-script":
      return del(`/startup-scripts/${id}`);
    default:
      throw new Error(`Vultr plugin: "${typeId}" cannot be deleted here`);
  }
}

export async function attachResource(
  api: VultrApi,
  sourceTypeId: string,
  sourceResourceId: string,
  targetTypeId: string,
  targetResourceId: string,
): Promise<void> {
  const source = trailingId(sourceResourceId);
  const target = trailingId(targetResourceId);
  if (targetTypeId !== "instance") {
    throw new Error(`Vultr plugin: cannot attach ${sourceTypeId} to ${targetTypeId}`);
  }
  switch (sourceTypeId) {
    case "block-storage":
      await api.send("POST", `/blocks/${source}/attach`, { instance_id: target, live: true });
      return;
    case "reserved-ip":
      await api.send("POST", `/reserved-ips/${source}/attach`, { instance_id: target });
      return;
    case "firewall-group":
      await api.send("PATCH", `/instances/${target}`, { firewall_group_id: source });
      return;
    case "vpc":
      await api.send("POST", `/instances/${target}/vpcs/attach`, { vpc_id: source });
      return;
    default:
      throw new Error(`Vultr plugin: cannot attach ${sourceTypeId} to an instance`);
  }
}

export async function invokeAction(
  api: VultrApi,
  typeId: string,
  resourceId: string,
  actionId: string,
): Promise<void> {
  const id = trailingId(resourceId);
  const post = (path: string, body?: unknown) =>
    api.send("POST", path, body ?? {}).then(() => undefined);
  if (typeId === "instance" || typeId === "bare-metal") {
    const base = typeId === "instance" ? `/instances/${id}` : `/bare-metals/${id}`;
    switch (actionId) {
      case "start":
      case "halt":
      case "reboot":
      case "reinstall":
        return post(`${base}/${actionId}`);
      case "enable-backups":
        return void (await api.send("PATCH", base, { backups: "enabled" }));
      case "disable-backups":
        return void (await api.send("PATCH", base, { backups: "disabled" }));
    }
  }
  if (typeId === "block-storage" && actionId === "detach")
    return post(`/blocks/${id}/detach`, { live: true });
  if (typeId === "reserved-ip" && actionId === "detach") return post(`/reserved-ips/${id}/detach`);
  if (typeId === "object-storage" && actionId === "regenerate-keys") {
    return post(`/object-storage/${id}/regenerate-keys`);
  }
  if (typeId === "database" && actionId === "maintenance")
    return post(`/databases/${id}/maintenance`);
  if (typeId === "load-balancer" && actionId === "remove-ssl") {
    return void (await api.send("DELETE", `/load-balancers/${id}/ssl`));
  }
  throw new Error(`Vultr plugin: unknown action "${actionId}" for ${typeId}`);
}

/** Vultr firewall rule body from the "+ Rule" prompt. */
export function firewallRuleBody(v: Record<string, string>): Record<string, unknown> {
  const ipType = v["ipType"] === "v6" ? "v6" : "v4";
  const protocol = (v["protocol"] || "tcp").toLowerCase();
  let subnet = ipType === "v6" ? "::" : "0.0.0.0";
  let size = 0;
  let source = "";
  if (v["source"] === "cloudflare") {
    source = "cloudflare";
  } else if (v["source"] === "cidr") {
    const raw = (v["cidr"] ?? "").trim();
    const parsed = splitCidr(raw.includes("/") ? raw : `${raw}/${ipType === "v6" ? 128 : 32}`);
    if (!parsed) throw new Error("Enter an address or CIDR range, e.g. 203.0.113.0/24.");
    subnet = parsed.subnet;
    size = parsed.size;
  }
  return {
    ip_type: ipType,
    protocol,
    subnet,
    subnet_size: size,
    ...(["tcp", "udp"].includes(protocol) && v["port"] ? { port: v["port"].trim() } : {}),
    ...(source ? { source } : {}),
    ...(v["notes"] ? { notes: v["notes"] } : {}),
  };
}

export async function executeCommand(
  api: VultrApi,
  typeId: string,
  resourceId: string,
  command: string,
  args: (string | number)[],
): Promise<unknown> {
  const id = trailingId(resourceId);
  const v = decodePromptArgs(args);
  const post = (path: string, body?: unknown) => api.send("POST", path, body ?? {});
  switch (`${typeId}:${command}`) {
    // --- instances
    case "instance:resize":
      if (!v["plan"]) throw new Error("Pick the new plan.");
      return api.send("PATCH", `/instances/${id}`, { plan: v["plan"] });
    case "instance:set-firewall":
      return api.send("PATCH", `/instances/${id}`, {
        firewall_group_id: v["firewallGroupId"] ?? "",
      });
    case "instance:snapshot":
      return post("/snapshots", {
        instance_id: id,
        ...(v["description"] ? { description: v["description"] } : {}),
      });
    case "instance:restore": {
      const [kind, sourceId] = split((v["source"] ?? "").replace(":", "/"));
      if (!sourceId) throw new Error("Pick a backup or snapshot.");
      return post(
        `/instances/${id}/restore`,
        kind === "backup" ? { backup_id: sourceId } : { snapshot_id: sourceId },
      );
    }
    case "instance:rebuild":
      return api.send("PATCH", `/instances/${id}`, bootSource(v["image"]));
    case "instance:reinstall":
      return post(`/instances/${id}/reinstall`, v["hostname"] ? { hostname: v["hostname"] } : {});
    case "instance:backup-schedule": {
      const type = v["type"] || "daily";
      return post(`/instances/${id}/backup-schedule`, {
        type,
        hour: intOr(v["hour"], 0),
        ...(type === "weekly" ? { dow: intOr(v["dow"], 1) } : {}),
        ...(type === "monthly" ? { dom: intOr(v["dom"], 1) } : {}),
      });
    }
    case "instance:attach-vpc":
      if (!v["vpcId"]) throw new Error("Pick a VPC.");
      return post(`/instances/${id}/vpcs/attach`, { vpc_id: v["vpcId"] });
    case "instance:detach-vpc":
      return post(`/instances/${id}/vpcs/detach`, { vpc_id: v["vpcId"] });
    // --- block storage and reserved IPs
    case "block-storage:attach":
      if (!v["instanceId"]) throw new Error("Pick the instance to attach to.");
      return post(`/blocks/${id}/attach`, {
        instance_id: v["instanceId"],
        live: v["live"] !== "false",
      });
    case "reserved-ip:attach":
      if (!v["instanceId"]) throw new Error("Pick the instance to attach to.");
      return post(`/reserved-ips/${id}/attach`, { instance_id: v["instanceId"] });
    // --- firewall groups
    case "firewall-group:add-rule":
      return post(`/firewalls/${id}/rules`, firewallRuleBody(v));
    case "firewall-group:remove-rule":
      return api.send("DELETE", `/firewalls/${id}/rules/${v["ruleId"]}`);
    // --- load balancers
    case "load-balancer:add-forwarding-rule":
      return post(`/load-balancers/${id}/forwarding-rules`, {
        frontend_protocol: v["frontendProtocol"] || "http",
        frontend_port: intOr(v["frontendPort"], 80),
        backend_protocol: v["backendProtocol"] || "http",
        backend_port: intOr(v["backendPort"], 80),
      });
    case "load-balancer:remove-forwarding-rule":
      return api.send("DELETE", `/load-balancers/${id}/forwarding-rules/${v["ruleId"]}`);
    case "load-balancer:set-backends":
      return api.send("PATCH", `/load-balancers/${id}`, { instances: listValue(v["instances"]) });
    case "load-balancer:health-check":
      return api.send("PATCH", `/load-balancers/${id}`, {
        health_check: {
          protocol: v["protocol"] || "http",
          port: intOr(v["port"], 80),
          ...(v["protocol"] !== "tcp" ? { path: v["path"] || "/" } : {}),
          check_interval: intOr(v["checkInterval"], 15),
          response_timeout: intOr(v["responseTimeout"], 5),
          unhealthy_threshold: intOr(v["unhealthyThreshold"], 5),
          healthy_threshold: intOr(v["healthyThreshold"], 5),
        },
      });
    case "load-balancer:add-lb-firewall-rule": {
      const lb = await api.get<{ load_balancer?: VultrLoadBalancer }>(`/load-balancers/${id}`);
      const rules = (lb.load_balancer?.firewall_rules ?? []).map((r) => ({
        port: r.port,
        ip_type: r.ip_type,
        source: r.source,
      }));
      rules.push({
        port: intOr(v["port"], 443),
        ip_type: v["ipType"] || "v4",
        source: (v["source"] ?? "").trim(),
      });
      return api.send("PATCH", `/load-balancers/${id}`, { firewall_rules: rules });
    }
    case "load-balancer:remove-lb-firewall-rule":
      return api.send("DELETE", `/load-balancers/${id}/firewall-rules/${v["ruleId"]}`);
    case "load-balancer:set-ssl":
      return api.send("PATCH", `/load-balancers/${id}`, {
        ssl: {
          certificate: v["certificate"],
          private_key: v["privateKey"],
          ...(v["chain"] ? { chain: v["chain"] } : {}),
        },
      });
    // --- Kubernetes
    case "kubernetes-cluster:upgrade":
      if (!v["version"]) throw new Error("Pick the version to upgrade to.");
      return post(`/kubernetes/clusters/${id}/upgrades`, { upgrade_version: v["version"] });
    case "kubernetes-cluster:delete-with-linked":
      return api.send("DELETE", `/kubernetes/clusters/${id}/delete-with-linked-resources`);
    case "node-pool:recycle-node": {
      const [clusterId, poolId] = split(id);
      return post(
        `/kubernetes/clusters/${clusterId}/node-pools/${poolId}/nodes/${v["nodeId"]}/recycle`,
      );
    }
    case "node-pool:delete-node": {
      const [clusterId, poolId] = split(id);
      return api.send(
        "DELETE",
        `/kubernetes/clusters/${clusterId}/node-pools/${poolId}/nodes/${v["nodeId"]}`,
      );
    }
    // --- databases
    case "database:upgrade-version":
      if (!v["version"]) throw new Error("Pick the version to upgrade to.");
      return post(`/databases/${id}/version-upgrade`, { version: v["version"] });
    case "database:restore":
    case "database:fork": {
      const pitr = v["type"] === "pitr";
      if (pitr && (!v["date"] || !v["time"]))
        throw new Error("Enter the date and time to restore to.");
      return post(`/databases/${id}/${command}`, {
        label: v["label"],
        type: pitr ? "pitr" : "basebackup",
        ...(pitr ? { date: v["date"], time: v["time"] } : {}),
        ...(command === "fork" && v["plan"] ? { plan: v["plan"] } : {}),
        ...(command === "fork" && v["region"] ? { region: v["region"] } : {}),
      });
    }
    case "database:read-replica":
      return post(`/databases/${id}/read-replica`, { label: v["label"] });
    case "database:change-plan":
      return api.send("PUT", `/databases/${id}`, { plan: v["plan"] });
    case "database:maintenance-window":
      return api.send("PUT", `/databases/${id}`, {
        maintenance_dow: v["maintenanceDow"],
        maintenance_time: v["maintenanceTime"],
      });
    default:
      throw new Error(`Vultr plugin: unknown command "${command}" for ${typeId}`);
  }
}
