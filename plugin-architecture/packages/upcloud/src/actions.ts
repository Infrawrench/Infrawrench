/**
 * Deletes, drag-attach, one-click actions and prompted actions
 * (`executeNoSqlCommand`, `args[0]` is the prompt's JSON form).
 */

import { decodePromptArgs } from "@infrawrench/plugin-base";
import { type UpCloudApi, intOr, splitPair, trailingId, unwrap } from "./api.js";
import { publicMac } from "./create.js";
import { type Json, str } from "./listers.js";

export async function deleteResource(
  api: UpCloudApi,
  typeId: string,
  resourceId: string,
): Promise<void> {
  const id = trailingId(resourceId);
  const [a, b] = splitPair(id);
  const del = (path: string) => api.send("DELETE", path).then(() => undefined);
  switch (typeId) {
    case "server": {
      const s = await api.get<{ server?: Json }>(`/server/${id}`);
      if (str(s.server?.["state"]) !== "stopped")
        throw new Error("Stop the server before deleting it.");
      // Deletes the server's storages too, keeping their latest backup.
      return del(`/server/${id}/?storages=1&backups=keep_latest`);
    }
    case "storage":
    case "backup":
    case "template":
      return del(`/storage/${id}`);
    case "network":
      return del(`/network/${id}`);
    case "router":
      return del(`/router/${id}`);
    case "floating-ip":
      return del(`/ip_address/${id}`);
    case "kubernetes-cluster":
      return del(`/kubernetes/${id}`);
    case "node-group":
      return del(`/kubernetes/${a}/node-groups/${encodeURIComponent(b)}`);
    case "database":
      return del(`/database/${id}`);
    case "database-user":
      return del(`/database/${a}/users/${encodeURIComponent(b)}`);
    case "database-db":
      return del(`/database/${a}/databases/${encodeURIComponent(b)}`);
    case "load-balancer":
      return del(`/load-balancer/${id}`);
    case "object-storage":
      return del(`/object-storage-2/${id}`);
    case "bucket":
      return del(`/object-storage-2/${a}/buckets/${encodeURIComponent(b)}`);
    case "object-storage-user":
      return del(`/object-storage-2/${a}/users/${encodeURIComponent(b)}`);
    default:
      throw new Error(`UpCloud plugin: "${typeId}" cannot be deleted here`);
  }
}

export async function attachStorage(
  api: UpCloudApi,
  storageId: string,
  serverId: string,
): Promise<void> {
  await api.send("POST", `/server/${serverId}/storage/attach`, {
    storage_device: { type: "disk", storage: storageId },
  });
}

export async function detachStorage(api: UpCloudApi, storageId: string): Promise<void> {
  const s = await api.get<{ storage?: Json }>(`/storage/${storageId}`);
  const serverId = unwrap<string>(s.storage ?? {}, "servers", "server")[0];
  if (!serverId) throw new Error("The storage is not attached to a server.");
  const server = await api.get<{ server?: Json }>(`/server/${serverId}`);
  const device = unwrap<Json>(server.server ?? {}, "storage_devices", "storage_device").find(
    (d) => d["storage"] === storageId,
  );
  if (!device) throw new Error("The server does not list this storage.");
  await api.send("POST", `/server/${serverId}/storage/detach`, {
    storage_device: { address: str(device["address"]) },
  });
}

export async function attachResource(
  api: UpCloudApi,
  sourceTypeId: string,
  sourceResourceId: string,
  targetTypeId: string,
  targetResourceId: string,
): Promise<void> {
  const source = trailingId(sourceResourceId);
  const target = trailingId(targetResourceId);
  if (targetTypeId !== "server")
    throw new Error(`UpCloud plugin: cannot attach to ${targetTypeId}`);
  if (sourceTypeId === "storage") return attachStorage(api, source, target);
  if (sourceTypeId === "floating-ip") {
    await api.send("PATCH", `/ip_address/${source}`, {
      ip_address: { mac: await publicMac(api, target) },
    });
    return;
  }
  throw new Error(`UpCloud plugin: cannot attach ${sourceTypeId} to a server`);
}

export async function invokeAction(
  api: UpCloudApi,
  typeId: string,
  resourceId: string,
  actionId: string,
): Promise<void> {
  const id = trailingId(resourceId);
  if (typeId === "server") {
    switch (actionId) {
      case "start":
        return void (await api.send("POST", `/server/${id}/start`, { server: {} }));
      case "stop":
        return void (await api.send("POST", `/server/${id}/stop`, {
          stop_server: { stop_type: "soft", timeout: "60" },
        }));
      case "hard-stop":
        return void (await api.send("POST", `/server/${id}/stop`, {
          stop_server: { stop_type: "hard", timeout: "60" },
        }));
      case "restart":
        return void (await api.send("POST", `/server/${id}/restart`, {
          restart_server: { stop_type: "soft", timeout: "60", timeout_action: "destroy" },
        }));
      case "firewall-on":
      case "firewall-off":
        return void (await api.send("PUT", `/server/${id}`, {
          server: { firewall: actionId === "firewall-on" ? "on" : "off" },
        }));
    }
  }
  if (typeId === "storage" && actionId === "detach") return detachStorage(api, id);
  if (typeId === "backup" && actionId === "restore")
    return void (await api.send("POST", `/storage/${id}/restore`));
  if (typeId === "floating-ip" && actionId === "unassign") {
    return void (await api.send("PATCH", `/ip_address/${id}`, { ip_address: { mac: null } }));
  }
  if (typeId === "database" && (actionId === "power-on" || actionId === "power-off")) {
    return void (await api.send("PATCH", `/database/${id}`, { powered: actionId === "power-on" }));
  }
  if (typeId === "load-balancer" && (actionId === "start" || actionId === "stop")) {
    return void (await api.send("PATCH", `/load-balancer/${id}`, {
      configured_status: actionId === "start" ? "started" : "stopped",
    }));
  }
  throw new Error(`UpCloud plugin: unknown action "${actionId}" for ${typeId}`);
}

export function firewallRuleBody(v: Record<string, string>): Record<string, unknown> {
  const protocol = v["protocol"] || "tcp";
  const [srcStart, srcEnd] = (v["source"] || "").split("-").map((s) => s.trim());
  const [portStart, portEnd] = (v["port"] || "").split("-").map((s) => s.trim());
  return {
    firewall_rule: {
      direction: v["direction"] || "in",
      action: v["action"] || "accept",
      family: v["family"] || "IPv4",
      ...(protocol !== "any" ? { protocol } : {}),
      ...(srcStart
        ? { source_address_start: srcStart, source_address_end: srcEnd || srcStart }
        : {}),
      ...(portStart && ["tcp", "udp"].includes(protocol)
        ? { destination_port_start: portStart, destination_port_end: portEnd || portStart }
        : {}),
      ...(v["comment"] ? { comment: v["comment"] } : {}),
    },
  };
}

export async function executeCommand(
  api: UpCloudApi,
  typeId: string,
  resourceId: string,
  command: string,
  args: (string | number)[],
): Promise<unknown> {
  const id = trailingId(resourceId);
  const [a, b] = splitPair(id);
  const v = decodePromptArgs(args);
  switch (`${typeId}:${command}`) {
    case "server:resize":
      return api.send("PUT", `/server/${id}`, { server: { plan: v["plan"] } });
    case "server:add-rule":
      return api.send("POST", `/server/${id}/firewall_rule`, firewallRuleBody(v));
    case "server:remove-rule":
      return api.send("DELETE", `/server/${id}/firewall_rule/${v["position"]}`);
    case "server:attach-storage":
      if (!v["storageId"]) throw new Error("Pick a storage.");
      return attachStorage(api, v["storageId"], id);
    case "storage:attach":
      if (!v["serverId"]) throw new Error("Pick a server.");
      return attachStorage(api, id, v["serverId"]);
    case "storage:backup":
      return api.send("POST", `/storage/${id}/backup`, {
        storage: { title: v["title"] || `backup-${Date.now()}` },
      });
    case "storage:clone":
      return api.send("POST", `/storage/${id}/clone`, {
        storage: { title: v["title"], zone: v["zone"], ...(v["tier"] ? { tier: v["tier"] } : {}) },
      });
    case "floating-ip:assign":
      if (!v["serverId"]) throw new Error("Pick a server.");
      return api.send("PATCH", `/ip_address/${id}`, {
        ip_address: { mac: await publicMac(api, v["serverId"]) },
      });
    case "kubernetes-cluster:upgrade":
      if (!v["version"]) throw new Error("Pick the version.");
      return api.send("POST", `/kubernetes/${id}/upgrade`, { version: v["version"] });
    case "node-group:delete-node":
      return api.send(
        "DELETE",
        `/kubernetes/${a}/node-groups/${encodeURIComponent(b)}/${encodeURIComponent(v["node"] ?? "")}`,
      );
    case "database:upgrade":
      if (!v["version"]) throw new Error("Pick the version.");
      return api.send("POST", `/database/${id}/upgrade`, { target_version: v["version"] });
    case "database:fork":
      return api.send("POST", `/database/${id}/clone`, {
        title: v["title"],
        hostname_prefix: (v["title"] ?? "fork")
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, "-")
          .slice(0, 30),
        zone: v["zone"],
        plan: v["plan"],
        ...(v["cloneTime"] ? { clone_time: v["cloneTime"] } : {}),
      });
    case "load-balancer:add-member":
      return api.send(
        "POST",
        `/load-balancer/${id}/backends/${encodeURIComponent(v["backend"] ?? "default")}/members`,
        {
          name: v["name"] || `member-${Date.now() % 100000}`,
          ip: v["ip"],
          port: intOr(v["port"], 80),
          weight: intOr(v["weight"], 100),
          max_sessions: 1000,
          type: "static",
          enabled: true,
        },
      );
    case "load-balancer:remove-member":
      return api.send(
        "DELETE",
        `/load-balancer/${id}/backends/${encodeURIComponent(v["backend"] ?? "")}/members/${encodeURIComponent(v["member"] ?? "")}`,
      );
    default:
      throw new Error(`UpCloud plugin: unknown command "${command}" for ${typeId}`);
  }
}
