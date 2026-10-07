/**
 * One-click actions (`invokeAction`) and form-backed actions
 * (`executeNoSqlCommand`, reached through `prompt-nosql-command`).
 */
import { decodePromptArgs, externalIdOf } from "@infrawrench/plugin-base";
import { ProxmoxApiError, type FormValue } from "./api.js";
import { seg, type ProxmoxClient } from "./client.js";
import { parseBackupExternalId, parseStorageExternalId, truthy } from "./mappers.js";
import { BACKUP, CT, HA_RESOURCE, IPSET, NODE, SECURITY_GROUP, STORAGE, VM } from "./resources.js";

const GUEST_POWER = new Set(["start", "stop", "shutdown", "reboot", "reset", "suspend", "resume"]);

const yes = (v: string | undefined): boolean => v === "true" || v === "1";

export async function proxmoxInvokeAction(
  client: ProxmoxClient,
  typeId: string,
  resourceId: string,
  actionId: string,
): Promise<void> {
  const ext = externalIdOf(resourceId);
  const api = client.api;
  try {
    if (typeId === VM || typeId === CT) {
      const loc = await client.locateGuest(ext);
      const path = client.guestPath(loc);
      if (GUEST_POWER.has(actionId)) {
        if (loc.kind === "lxc" && actionId === "reset") {
          throw new ProxmoxApiError("Containers have no reset; use Reboot or Stop.", 400);
        }
        await api.post(`${path}/status/${actionId}`);
        return;
      }
      if (actionId === "template") {
        await api.post(`${path}/template`);
        return;
      }
      if (actionId === "protect" || actionId === "unprotect") {
        await api.put(`${path}/config`, { protection: actionId === "protect" });
        return;
      }
      if (actionId.startsWith("snapshot-rollback:")) {
        const name = actionId.slice("snapshot-rollback:".length);
        await api.post(`${path}/snapshot/${seg(name)}/rollback`);
        return;
      }
      if (actionId.startsWith("snapshot-delete:")) {
        const name = actionId.slice("snapshot-delete:".length);
        await api.delete(`${path}/snapshot/${seg(name)}`);
        return;
      }
      if (actionId.startsWith("firewall-delete:")) {
        const pos = actionId.slice("firewall-delete:".length);
        await api.delete(`${path}/firewall/rules/${seg(pos)}`);
        return;
      }
    }
    if (typeId === NODE) {
      const node = seg(ext);
      switch (actionId) {
        case "node-reboot":
          await api.post(`/nodes/${node}/status`, { command: "reboot" });
          return;
        case "node-shutdown":
          await api.post(`/nodes/${node}/status`, { command: "shutdown" });
          return;
        case "startall":
          await api.post(`/nodes/${node}/startall`);
          return;
        case "stopall":
          await api.post(`/nodes/${node}/stopall`);
          return;
        case "apt-update":
          await api.post(`/nodes/${node}/apt/update`);
          return;
      }
    }
    if (typeId === STORAGE && actionId.startsWith("volume-delete:")) {
      const { node, storage } = parseStorageExternalId(ext);
      const volid = actionId.slice("volume-delete:".length);
      await api.delete(`/nodes/${seg(node)}/storage/${seg(storage)}/content/${seg(volid)}`);
      return;
    }
    if (typeId === SECURITY_GROUP && actionId.startsWith("group-rule-delete:")) {
      const pos = actionId.slice("group-rule-delete:".length);
      await api.delete(`/cluster/firewall/groups/${seg(ext)}/${seg(pos)}`);
      return;
    }
    if (typeId === IPSET && actionId.startsWith("ipset-remove:")) {
      const cidr = actionId.slice("ipset-remove:".length);
      await api.delete(`/cluster/firewall/ipset/${seg(ext)}/${seg(cidr)}`);
      return;
    }
  } finally {
    client.invalidate();
  }
  throw new Error(`Proxmox plugin: action "${actionId}" is not supported for ${typeId}`);
}

/** Firewall rule params from a prompt's values. */
function ruleParams(v: Record<string, string>): Record<string, FormValue> {
  const p: Record<string, FormValue> = {
    type: v["type"] || "in",
    action: v["action"] || "ACCEPT",
    enable: 1,
  };
  for (const k of ["macro", "proto", "dport", "source", "comment"]) {
    if (v[k]) p[k] = v[k];
  }
  return p;
}

export async function proxmoxPromptCommand(
  client: ProxmoxClient,
  typeId: string,
  resourceId: string,
  command: string,
  args: (string | number)[],
): Promise<unknown> {
  const v = decodePromptArgs(args);
  const ext = externalIdOf(resourceId);
  const api = client.api;
  try {
    if (typeId === VM || typeId === CT) {
      const loc = await client.locateGuest(ext);
      const path = client.guestPath(loc);
      const isVm = loc.kind === "qemu";
      switch (command) {
        case "snapshot": {
          if (!v["snapname"]) throw new ProxmoxApiError("A snapshot name is required.", 400);
          await api.post(`${path}/snapshot`, {
            snapname: v["snapname"],
            description: v["description"] || undefined,
            ...(isVm && yes(v["vmstate"]) ? { vmstate: true } : {}),
          });
          return { ok: true };
        }
        case "backup": {
          await api.post(`/nodes/${seg(loc.node)}/vzdump`, {
            vmid: loc.vmid,
            storage: v["storage"] || undefined,
            mode: v["mode"] || "snapshot",
            compress: v["compress"] || "zstd",
            "notes-template": v["notes"] || undefined,
            ...(yes(v["protected"]) ? { protected: true } : {}),
          });
          return { ok: true };
        }
        case "clone": {
          const newid = v["newid"]
            ? Number(v["newid"])
            : Number(await api.get<string | number>("/cluster/nextid"));
          const full = yes(v["full"]) || !truthy(loc.resource.template);
          await api.post(`${path}/clone`, {
            newid,
            [isVm ? "name" : "hostname"]: v["name"] || undefined,
            target: v["target"] || undefined,
            full,
            storage: full && v["storage"] ? v["storage"] : undefined,
            pool: v["pool"] || undefined,
          });
          return { ok: true, vmid: newid };
        }
        case "migrate": {
          if (!v["target"]) throw new ProxmoxApiError("Pick a target node.", 400);
          if (isVm) {
            await api.post(`${path}/migrate`, {
              target: v["target"],
              online: yes(v["online"]),
              ...(yes(v["withLocalDisks"]) ? { "with-local-disks": true } : {}),
            });
          } else {
            await api.post(`${path}/migrate`, {
              target: v["target"],
              ...(yes(v["restart"]) ? { restart: true } : {}),
            });
          }
          return { ok: true };
        }
        case "resize": {
          const grow = Number(v["size"]);
          if (!v["disk"] || !Number.isFinite(grow) || grow <= 0) {
            throw new ProxmoxApiError("Pick a disk and a positive size to grow by.", 400);
          }
          await api.put(`${path}/resize`, { disk: v["disk"], size: `+${grow}G` });
          return { ok: true };
        }
        case "pool": {
          const target = v["pool"] ?? "";
          const current = String(loc.resource.pool ?? "");
          if (target === current) return { ok: true };
          if (current)
            await api.put("/pools", { poolid: current, vms: String(loc.vmid), delete: true });
          if (target)
            await api.put("/pools", { poolid: target, vms: String(loc.vmid), "allow-move": true });
          return { ok: true };
        }
        case "firewall-add":
          await api.post(`${path}/firewall/rules`, ruleParams(v));
          return { ok: true };
        case "ha-add":
          await api.post("/cluster/ha/resources", {
            sid: `${isVm ? "vm" : "ct"}:${loc.vmid}`,
            state: v["state"] || "started",
            comment: v["comment"] || undefined,
          });
          return { ok: true };
      }
    }
    if (typeId === STORAGE && command === "download-url") {
      const { node, storage } = parseStorageExternalId(ext);
      if (!v["url"] || !v["filename"])
        throw new ProxmoxApiError("A URL and a file name are required.", 400);
      await api.post(`/nodes/${seg(node)}/storage/${seg(storage)}/download-url`, {
        url: v["url"],
        filename: v["filename"],
        content: v["content"] || "iso",
        checksum: v["checksum"] || undefined,
        "checksum-algorithm": v["checksum"] ? v["checksumAlgorithm"] || "sha256" : undefined,
      });
      return { ok: true };
    }
    if (typeId === BACKUP && command === "restore") {
      const { volid } = parseBackupExternalId(ext);
      const resource = await client.getResource(typeId, resourceId, resourceId.split(":")[0] ?? "");
      const isLxc = resource.fields["guestType"] === "lxc";
      const node = v["node"] || String(resource.fields["node"] ?? "");
      const vmid = v["vmid"]
        ? Number(v["vmid"])
        : Number(await api.get<string | number>("/cluster/nextid"));
      if (isLxc) {
        await api.post(`/nodes/${seg(node)}/lxc`, {
          vmid,
          ostemplate: volid,
          restore: true,
          storage: v["storage"] || undefined,
          force: true,
          ...(yes(v["start"]) ? { start: true } : {}),
        });
      } else {
        await api.post(`/nodes/${seg(node)}/qemu`, {
          vmid,
          archive: volid,
          storage: v["storage"] || undefined,
          force: true,
          unique: true,
          ...(yes(v["start"]) ? { start: true } : {}),
        });
      }
      return { ok: true, vmid };
    }
    if (typeId === SECURITY_GROUP && command === "group-rule-add") {
      await api.post(`/cluster/firewall/groups/${seg(ext)}`, ruleParams(v));
      return { ok: true };
    }
    if (typeId === IPSET && command === "ipset-add") {
      if (!v["cidr"]) throw new ProxmoxApiError("An address or CIDR is required.", 400);
      await api.post(`/cluster/firewall/ipset/${seg(ext)}`, {
        cidr: v["cidr"],
        comment: v["comment"] || undefined,
        ...(yes(v["nomatch"]) ? { nomatch: true } : {}),
      });
      return { ok: true };
    }
    if (typeId === HA_RESOURCE && (command === "ha-migrate" || command === "ha-relocate")) {
      if (!v["node"]) throw new ProxmoxApiError("Pick a target node.", 400);
      await api.post(
        `/cluster/ha/resources/${seg(ext)}/${command === "ha-migrate" ? "migrate" : "relocate"}`,
        {
          node: v["node"],
        },
      );
      return { ok: true };
    }
  } finally {
    client.invalidate();
  }
  throw new Error(`Proxmox plugin: command "${command}" is not supported for ${typeId}`);
}
