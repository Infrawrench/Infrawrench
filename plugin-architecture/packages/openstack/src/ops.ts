/** Actions, form actions, edits, deletes and drag-to-attach. */
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { decodePromptArgs } from "@infrawrench/plugin-base";
import { OpenStackApiError } from "./api.js";
import type { OpenStackClient } from "./client.js";
import { str } from "./mappers.js";
import {
  CONTAINER,
  DNS_RECORDSET,
  DNS_ZONE,
  FLOATING_IP,
  IMAGE,
  KEYPAIR,
  LB_LISTENER,
  LB_POOL,
  LOADBALANCER,
  NETWORK,
  ROUTER,
  SECURITY_GROUP,
  SERVER,
  SG_RULE,
  STACK,
  SUBNET,
  VOLUME,
  VOLUME_BACKUP,
  VOLUME_SNAPSHOT,
} from "./resources.js";

const e = encodeURIComponent;

const SERVER_ACTIONS: Record<string, Record<string, unknown>> = {
  start: { "os-start": null },
  stop: { "os-stop": null },
  "reboot-soft": { reboot: { type: "SOFT" } },
  "reboot-hard": { reboot: { type: "HARD" } },
  pause: { pause: null },
  unpause: { unpause: null },
  suspend: { suspend: null },
  resume: { resume: null },
  shelve: { shelve: null },
  unshelve: { unshelve: null },
  lock: { lock: null },
  unlock: { unlock: null },
  "confirm-resize": { confirmResize: null },
  "revert-resize": { revertResize: null },
};

const serverAction = (c: OpenStackClient, id: string, body: unknown) =>
  c.api.json("compute", "POST", `/servers/${e(id)}/action`, { body });

/** The port a floating IP should bind to: the server's first IPv4 port. */
async function serverPort(c: OpenStackClient, serverId: string): Promise<string> {
  const ports = await c.api.get<{
    ports?: Array<{ id: string; fixed_ips?: Array<{ ip_address?: string }> }>;
  }>("network", "/v2.0/ports", { device_id: serverId });
  const port =
    (ports?.ports ?? []).find((p) =>
      (p.fixed_ips ?? []).some((ip) => ip.ip_address && !ip.ip_address.includes(":")),
    ) ?? ports?.ports?.[0];
  if (!port)
    throw new OpenStackApiError(
      "The server has no network port to associate a floating IP with.",
      409,
    );
  return port.id;
}

/** Heat stack ids are stored as `name/id`, exactly the path segment Heat wants. */
const stackPath = (ext: string) => `/stacks/${ext.split("/").map(e).join("/")}`;

export async function openstackInvokeAction(
  c: OpenStackClient,
  typeId: string,
  ext: string,
  actionId: string,
): Promise<void> {
  try {
    if (typeId === SERVER) {
      const body = SERVER_ACTIONS[actionId];
      if (body) {
        await serverAction(c, ext, body);
        return;
      }
      if (actionId.startsWith("fip-disassociate:")) {
        await c.api.json("network", "PUT", `/v2.0/floatingips/${e(actionId.slice(17))}`, {
          body: { floatingip: { port_id: null } },
        });
        return;
      }
    }
    if (typeId === VOLUME && actionId === "detach") {
      const vol = (await c.volumes()).find((v) => v["id"] === ext);
      const serverId = (vol?.["attachments"] as Array<{ server_id?: string }> | undefined)?.[0]
        ?.server_id;
      if (!serverId) throw new OpenStackApiError("The volume is not attached.", 409);
      await c.api.request(
        "compute",
        "DELETE",
        `/servers/${e(serverId)}/os-volume_attachments/${e(ext)}`,
      );
      return;
    }
    if (typeId === SECURITY_GROUP && actionId.startsWith("rule-delete:")) {
      await c.api.request(
        "network",
        "DELETE",
        `/v2.0/security-group-rules/${e(actionId.slice(12))}`,
      );
      return;
    }
    if (typeId === FLOATING_IP && actionId === "disassociate") {
      await c.api.json("network", "PUT", `/v2.0/floatingips/${e(ext)}`, {
        body: { floatingip: { port_id: null } },
      });
      return;
    }
    if (typeId === LOADBALANCER && actionId === "failover") {
      await c.api.request("load-balancer", "PUT", `/v2/lbaas/loadbalancers/${e(ext)}/failover`);
      return;
    }
    if (typeId === LB_POOL && actionId.startsWith("member-delete:")) {
      await c.api.request(
        "load-balancer",
        "DELETE",
        `/v2/lbaas/pools/${e(ext)}/members/${e(actionId.slice(14))}`,
      );
      return;
    }
    if (typeId === STACK && actionId.startsWith("stack-")) {
      const verb = actionId.slice(6).replace("-", "_");
      if (!["suspend", "resume", "check", "cancel_update"].includes(verb))
        throw new Error(`unknown stack action ${verb}`);
      await c.api.json("orchestration", "POST", `${stackPath(ext)}/actions`, {
        body: { [verb]: null },
      });
      return;
    }
  } finally {
    c.invalidate();
  }
  throw new Error(`OpenStack plugin: action "${actionId}" is not supported for ${typeId}`);
}

export function ruleBody(
  securityGroupId: string,
  v: Record<string, string>,
): Record<string, unknown> {
  const proto = v["protocol"] ?? "";
  const min = v["portMin"] ? Number(v["portMin"]) : undefined;
  const max = v["portMax"] ? Number(v["portMax"]) : min;
  return {
    security_group_rule: {
      security_group_id: securityGroupId,
      direction: v["direction"] || "ingress",
      ethertype: v["ethertype"] || "IPv4",
      ...(proto ? { protocol: proto } : {}),
      ...(proto && proto !== "icmp" && min !== undefined
        ? { port_range_min: min, port_range_max: max }
        : {}),
      ...(v["remoteIpPrefix"] ? { remote_ip_prefix: v["remoteIpPrefix"] } : {}),
      ...(v["description"] ? { description: v["description"] } : {}),
    },
  };
}

export async function openstackPrompt(
  c: OpenStackClient,
  typeId: string,
  ext: string,
  command: string,
  args: (string | number)[],
): Promise<unknown> {
  const v = decodePromptArgs(args);
  try {
    if (typeId === SERVER) {
      switch (command) {
        case "resize":
          if (!v["flavorRef"]) throw new OpenStackApiError("Pick a flavor.", 400);
          await serverAction(c, ext, { resize: { flavorRef: v["flavorRef"] } });
          return { ok: true };
        case "create-image":
          await serverAction(c, ext, { createImage: { name: v["name"] || `${ext}-snapshot` } });
          return { ok: true };
        case "fip-associate":
          if (!v["floatingIpId"]) throw new OpenStackApiError("Pick a floating IP.", 400);
          await c.api.json("network", "PUT", `/v2.0/floatingips/${e(v["floatingIpId"])}`, {
            body: { floatingip: { port_id: await serverPort(c, ext) } },
          });
          return { ok: true };
        case "attach-volume":
          if (!v["volumeId"]) throw new OpenStackApiError("Pick a volume.", 400);
          await c.api.json("compute", "POST", `/servers/${e(ext)}/os-volume_attachments`, {
            body: { volumeAttachment: { volumeId: v["volumeId"] } },
          });
          return { ok: true };
        case "add-sg":
        case "remove-sg":
          if (!v["name"]) throw new OpenStackApiError("Pick a security group.", 400);
          await serverAction(c, ext, {
            [command === "add-sg" ? "addSecurityGroup" : "removeSecurityGroup"]: {
              name: v["name"],
            },
          });
          return { ok: true };
      }
    }
    if (typeId === VOLUME) {
      switch (command) {
        case "extend": {
          const size = Number(v["newSize"]);
          if (!Number.isFinite(size) || size <= 0)
            throw new OpenStackApiError("Enter the new size in GiB.", 400);
          await c.api.json("block-storage", "POST", `/volumes/${e(ext)}/action`, {
            body: { "os-extend": { new_size: size } },
          });
          return { ok: true };
        }
        case "snapshot":
          await c.api.json("block-storage", "POST", "/snapshots", {
            body: {
              snapshot: {
                volume_id: ext,
                name: v["name"] || undefined,
                force: v["force"] === "true",
              },
            },
          });
          return { ok: true };
        case "backup":
          await c.api.json("block-storage", "POST", "/backups", {
            body: {
              backup: {
                volume_id: ext,
                name: v["name"] || undefined,
                incremental: v["incremental"] === "true",
                force: true,
              },
            },
          });
          return { ok: true };
      }
    }
    if (typeId === SECURITY_GROUP && command === "rule-add") {
      await c.api.json("network", "POST", "/v2.0/security-group-rules", { body: ruleBody(ext, v) });
      return { ok: true };
    }
    if (typeId === ROUTER) {
      if (command === "router-add-interface" || command === "router-remove-interface") {
        if (!v["subnetId"]) throw new OpenStackApiError("Pick a subnet.", 400);
        await c.api.json(
          "network",
          "PUT",
          `/v2.0/routers/${e(ext)}/${command === "router-add-interface" ? "add" : "remove"}_router_interface`,
          {
            body: { subnet_id: v["subnetId"] },
          },
        );
        return { ok: true };
      }
      if (command === "router-gateway") {
        await c.api.json("network", "PUT", `/v2.0/routers/${e(ext)}`, {
          body: {
            router: {
              external_gateway_info: v["networkId"] ? { network_id: v["networkId"] } : null,
            },
          },
        });
        return { ok: true };
      }
    }
    if (typeId === LB_POOL && command === "member-add") {
      if (!v["address"] || !v["port"])
        throw new OpenStackApiError("An address and a port are required.", 400);
      await c.api.json("load-balancer", "POST", `/v2/lbaas/pools/${e(ext)}/members`, {
        body: {
          member: {
            address: v["address"],
            protocol_port: Number(v["port"]),
            ...(v["subnetId"] ? { subnet_id: v["subnetId"] } : {}),
            ...(v["weight"] ? { weight: Number(v["weight"]) } : {}),
          },
        },
      });
      return { ok: true };
    }
  } finally {
    c.invalidate();
  }
  throw new Error(`OpenStack plugin: command "${command}" is not supported for ${typeId}`);
}

export async function openstackDelete(
  c: OpenStackClient,
  typeId: string,
  ext: string,
): Promise<void> {
  const del = (
    service: Parameters<typeof c.api.request>[0],
    path: string,
    query?: Record<string, string>,
  ) => c.api.request(service, "DELETE", path, query ? { query } : {});
  switch (typeId) {
    case SERVER:
      await del("compute", `/servers/${e(ext)}`);
      break;
    case IMAGE:
      await del("image", `/v2/images/${e(ext)}`);
      break;
    case KEYPAIR:
      await del("compute", `/os-keypairs/${e(ext)}`);
      break;
    case VOLUME:
      await del("block-storage", `/volumes/${e(ext)}`);
      break;
    case VOLUME_SNAPSHOT:
      await del("block-storage", `/snapshots/${e(ext)}`);
      break;
    case VOLUME_BACKUP:
      await del("block-storage", `/backups/${e(ext)}`);
      break;
    case NETWORK:
      await del("network", `/v2.0/networks/${e(ext)}`);
      break;
    case SUBNET:
      await del("network", `/v2.0/subnets/${e(ext)}`);
      break;
    case ROUTER:
      await del("network", `/v2.0/routers/${e(ext)}`);
      break;
    case FLOATING_IP:
      await del("network", `/v2.0/floatingips/${e(ext)}`);
      break;
    case SECURITY_GROUP:
      await del("network", `/v2.0/security-groups/${e(ext)}`);
      break;
    case SG_RULE:
      await del("network", `/v2.0/security-group-rules/${e(ext)}`);
      break;
    case LOADBALANCER:
      await del("load-balancer", `/v2/lbaas/loadbalancers/${e(ext)}`, { cascade: "true" });
      break;
    case LB_LISTENER:
      await del("load-balancer", `/v2/lbaas/listeners/${e(ext)}`);
      break;
    case LB_POOL:
      await del("load-balancer", `/v2/lbaas/pools/${e(ext)}`);
      break;
    case CONTAINER:
      try {
        await del("object-store", `/${e(ext)}`);
      } catch (err) {
        if (err instanceof OpenStackApiError && err.status === 409) {
          throw new OpenStackApiError(
            "Swift only deletes empty containers. Delete its objects in the Storage tab first.",
            409,
          );
        }
        throw err;
      }
      break;
    case DNS_ZONE:
      await del("dns", `/v2/zones/${e(ext)}`);
      break;
    case DNS_RECORDSET: {
      const [zone, id] = ext.split("/");
      await del("dns", `/v2/zones/${e(zone ?? "")}/recordsets/${e(id ?? "")}`);
      break;
    }
    case STACK:
      await del("orchestration", stackPath(ext));
      break;
    default:
      throw new Error(`OpenStack plugin: ${typeId} cannot be deleted`);
  }
  c.invalidate();
}

export async function openstackUpdate(
  c: OpenStackClient,
  typeId: string,
  resourceId: string,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const ext = resourceId.split(":").slice(2).join(":");
  const has = (k: string) => Object.prototype.hasOwnProperty.call(fields, k);
  const pickStr = (map: Record<string, string>) => {
    const out: Record<string, unknown> = {};
    for (const [form, api] of Object.entries(map)) if (has(form)) out[api] = fields[form] ?? "";
    return out;
  };
  const pickBool = (map: Record<string, string>) => {
    const out: Record<string, unknown> = {};
    for (const [form, api] of Object.entries(map))
      if (has(form)) out[api] = fields[form] === "true";
    return out;
  };
  const pickNum = (map: Record<string, string>) => {
    const out: Record<string, unknown> = {};
    for (const [form, api] of Object.entries(map))
      if (has(form) && fields[form] !== "") out[api] = Number(fields[form]);
    return out;
  };
  const put = (service: Parameters<typeof c.api.json>[0], path: string, body: unknown) =>
    c.api.json(service, "PUT", path, { body });

  switch (typeId) {
    case SERVER:
      await put("compute", `/servers/${e(ext)}`, {
        server: pickStr({ name: "name", description: "description" }),
      });
      break;
    case IMAGE: {
      const ops: Array<{ op: string; path: string; value: unknown }> = [];
      if (has("name")) ops.push({ op: "replace", path: "/name", value: fields["name"] });
      if (has("visibility"))
        ops.push({ op: "replace", path: "/visibility", value: fields["visibility"] });
      if (has("protected"))
        ops.push({ op: "replace", path: "/protected", value: fields["protected"] === "true" });
      if (has("minDiskGb"))
        ops.push({ op: "replace", path: "/min_disk", value: Number(fields["minDiskGb"] || 0) });
      if (has("minRamMb"))
        ops.push({ op: "replace", path: "/min_ram", value: Number(fields["minRamMb"] || 0) });
      if (ops.length) {
        await c.api.request("image", "PATCH", `/v2/images/${e(ext)}`, {
          rawBody: JSON.stringify(ops),
          headers: { "Content-Type": "application/openstack-images-v2.1-json-patch" },
        });
      }
      break;
    }
    case VOLUME: {
      const body = pickStr({ name: "name", description: "description" });
      if (Object.keys(body).length)
        await put("block-storage", `/volumes/${e(ext)}`, { volume: body });
      if (has("sizeGb") && fields["sizeGb"]) {
        await c.api.json("block-storage", "POST", `/volumes/${e(ext)}/action`, {
          body: { "os-extend": { new_size: Number(fields["sizeGb"]) } },
        });
      }
      break;
    }
    case VOLUME_SNAPSHOT:
      await put("block-storage", `/snapshots/${e(ext)}`, {
        snapshot: pickStr({ name: "name", description: "description" }),
      });
      break;
    case NETWORK:
      await put("network", `/v2.0/networks/${e(ext)}`, {
        network: {
          ...pickStr({ name: "name", description: "description" }),
          ...pickBool({ adminStateUp: "admin_state_up" }),
          ...pickNum({ mtu: "mtu" }),
        },
      });
      break;
    case SUBNET: {
      const body: Record<string, unknown> = {
        ...pickStr({ name: "name", description: "description" }),
        ...pickBool({ enableDhcp: "enable_dhcp" }),
      };
      if (has("gatewayIp")) body["gateway_ip"] = fields["gatewayIp"] || null;
      if (has("dnsNameservers"))
        body["dns_nameservers"] = (fields["dnsNameservers"] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      await put("network", `/v2.0/subnets/${e(ext)}`, { subnet: body });
      break;
    }
    case ROUTER:
      await put("network", `/v2.0/routers/${e(ext)}`, {
        router: {
          ...pickStr({ name: "name", description: "description" }),
          ...pickBool({ adminStateUp: "admin_state_up" }),
        },
      });
      break;
    case FLOATING_IP:
      await put("network", `/v2.0/floatingips/${e(ext)}`, {
        floatingip: pickStr({ description: "description" }),
      });
      break;
    case SECURITY_GROUP:
      await put("network", `/v2.0/security-groups/${e(ext)}`, {
        security_group: pickStr({ name: "name", description: "description" }),
      });
      break;
    case LOADBALANCER:
      await put("load-balancer", `/v2/lbaas/loadbalancers/${e(ext)}`, {
        loadbalancer: {
          ...pickStr({ name: "name", description: "description" }),
          ...pickBool({ adminStateUp: "admin_state_up" }),
        },
      });
      break;
    case LB_LISTENER:
      await put("load-balancer", `/v2/lbaas/listeners/${e(ext)}`, {
        listener: {
          ...pickStr({ name: "name" }),
          ...pickNum({ connectionLimit: "connection_limit" }),
          ...pickBool({ adminStateUp: "admin_state_up" }),
        },
      });
      break;
    case LB_POOL:
      await put("load-balancer", `/v2/lbaas/pools/${e(ext)}`, {
        pool: pickStr({ name: "name", lbAlgorithm: "lb_algorithm" }),
      });
      break;
    case CONTAINER:
      if (has("publicRead")) {
        await c.api.request("object-store", "POST", `/${e(ext)}`, {
          headers:
            fields["publicRead"] === "true"
              ? { "X-Container-Read": ".r:*,.rlistings" }
              : { "X-Remove-Container-Read": "x" },
        });
      }
      break;
    case DNS_ZONE:
      await c.api.json("dns", "PATCH", `/v2/zones/${e(ext)}`, {
        body: {
          ...pickStr({ email: "email", description: "description" }),
          ...pickNum({ ttl: "ttl" }),
        },
      });
      break;
    case DNS_RECORDSET: {
      const [zone, id] = ext.split("/");
      const body: Record<string, unknown> = {
        ...pickStr({ description: "description" }),
        ...pickNum({ ttl: "ttl" }),
      };
      if (has("content"))
        body["records"] = (fields["content"] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      await put("dns", `/v2/zones/${e(zone ?? "")}/recordsets/${e(id ?? "")}`, body);
      break;
    }
    default:
      throw new Error(`OpenStack plugin: ${typeId} cannot be edited`);
  }
  c.invalidate();
  return c.getResource(typeId, resourceId, accountId);
}

export async function openstackAttach(
  c: OpenStackClient,
  sourceTypeId: string,
  sourceId: string,
  targetTypeId: string,
  targetId: string,
): Promise<void> {
  if (targetTypeId !== SERVER) throw new Error("OpenStack plugin: only servers accept attachments");
  try {
    if (sourceTypeId === VOLUME) {
      await c.api.json("compute", "POST", `/servers/${e(targetId)}/os-volume_attachments`, {
        body: { volumeAttachment: { volumeId: sourceId } },
      });
      return;
    }
    if (sourceTypeId === FLOATING_IP) {
      await c.api.json("network", "PUT", `/v2.0/floatingips/${e(sourceId)}`, {
        body: { floatingip: { port_id: await serverPort(c, targetId) } },
      });
      return;
    }
    if (sourceTypeId === SECURITY_GROUP) {
      const g = (await c.securityGroups()).find((x) => x.id === sourceId);
      await serverAction(c, targetId, { addSecurityGroup: { name: str(g?.name ?? sourceId) } });
      return;
    }
  } finally {
    c.invalidate();
  }
  throw new Error(`OpenStack plugin: ${sourceTypeId} cannot be attached to a server`);
}
