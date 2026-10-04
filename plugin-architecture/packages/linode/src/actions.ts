/**
 * Deletes, drag-attach, one-click actions (`invokeAction`) and prompted
 * actions (`executeNoSqlCommand`, dispatched from `prompt-nosql-command`
 * header actions; the host packs the form as `args[0] = JSON.stringify(values)`).
 */

import { decodePromptArgs } from "@infrawrench/plugin-base";
import { type LinodeApi, trailingId } from "./api.js";
import { listValue, randomRootPassword } from "./create.js";
import type { LinodeFirewall, LinodeFirewallRule, LinodeReservedIp } from "./types.js";

export async function deleteResource(
  api: LinodeApi,
  typeId: string,
  resourceId: string,
): Promise<void> {
  const id = trailingId(resourceId);
  const [a, ...rest] = id.split("/");
  const b = rest.join("/");
  switch (typeId) {
    case "linode":
      return void (await api.send("DELETE", `/linode/instances/${id}`));
    case "volume": {
      const vol = await api.get<{ linode_id?: number | null }>(`/volumes/${id}`);
      if (vol.linode_id != null) {
        throw new Error("Detach the volume from its Linode before deleting it.");
      }
      return void (await api.send("DELETE", `/volumes/${id}`));
    }
    case "nodebalancer":
      return void (await api.send("DELETE", `/nodebalancers/${id}`));
    case "lke-cluster":
      return void (await api.send("DELETE", `/lke/clusters/${id}`));
    case "lke-node-pool":
      return void (await api.send("DELETE", `/lke/clusters/${a}/pools/${b}`));
    case "bucket":
      return void (await api.send(
        "DELETE",
        `/object-storage/buckets/${a}/${encodeURIComponent(b)}`,
      ));
    case "database":
      return void (await api.send("DELETE", `/databases/${a}/instances/${b}`));
    case "firewall":
      return void (await api.send("DELETE", `/networking/firewalls/${id}`));
    case "domain":
      return void (await api.send("DELETE", `/domains/${id}`));
    case "domain-record":
      return void (await api.send("DELETE", `/domains/${a}/records/${b}`));
    case "vpc":
      return void (await api.send("DELETE", `/vpcs/${id}`));
    case "image":
      return void (await api.send("DELETE", `/images/${encodeURIComponent(id)}`));
    case "stackscript":
      return void (await api.send("DELETE", `/linode/stackscripts/${id}`));
    case "reserved-ip":
      return void (await api.send("DELETE", `/networking/reserved/ips/${id}`));
    default:
      throw new Error(`Linode plugin: "${typeId}" cannot be deleted here`);
  }
}

export async function attachResource(
  api: LinodeApi,
  sourceTypeId: string,
  sourceResourceId: string,
  targetTypeId: string,
  targetResourceId: string,
): Promise<void> {
  const source = trailingId(sourceResourceId);
  const target = Number(trailingId(targetResourceId));
  if (sourceTypeId === "volume" && targetTypeId === "linode") {
    await api.send("POST", `/volumes/${source}/attach`, {
      linode_id: target,
      persist_across_boots: true,
    });
    return;
  }
  if (
    sourceTypeId === "firewall" &&
    (targetTypeId === "linode" || targetTypeId === "nodebalancer")
  ) {
    await api.send("POST", `/networking/firewalls/${source}/devices`, {
      id: target,
      type: targetTypeId,
    });
    return;
  }
  if (sourceTypeId === "reserved-ip" && targetTypeId === "linode") {
    const ip = await api.get<LinodeReservedIp>(`/networking/reserved/ips/${source}`);
    await api.send("POST", "/networking/ips/assign", {
      region: ip.region,
      assignments: [{ address: source, linode_id: target }],
    });
    return;
  }
  throw new Error(`Linode plugin: cannot attach ${sourceTypeId} to ${targetTypeId}`);
}

/** Parameterless actions, each one POST. */
const SIMPLE_ACTIONS: Record<string, Record<string, (id: string) => string>> = {
  linode: {
    boot: (id) => `/linode/instances/${id}/boot`,
    shutdown: (id) => `/linode/instances/${id}/shutdown`,
    reboot: (id) => `/linode/instances/${id}/reboot`,
    enable_backups: (id) => `/linode/instances/${id}/backups/enable`,
    cancel_backups: (id) => `/linode/instances/${id}/backups/cancel`,
  },
  volume: { detach: (id) => `/volumes/${id}/detach` },
  "lke-cluster": { recycle: (id) => `/lke/clusters/${id}/recycle` },
  "lke-node-pool": {
    recycle: (id) => {
      const [c, p] = id.split("/");
      return `/lke/clusters/${c}/pools/${p}/recycle`;
    },
  },
  database: {
    suspend: (id) => {
      const [e, d] = id.split("/");
      return `/databases/${e}/instances/${d}/suspend`;
    },
    resume: (id) => {
      const [e, d] = id.split("/");
      return `/databases/${e}/instances/${d}/resume`;
    },
    patch: (id) => {
      const [e, d] = id.split("/");
      return `/databases/${e}/instances/${d}/patch`;
    },
    reset_credentials: (id) => {
      const [e, d] = id.split("/");
      return `/databases/${e}/instances/${d}/credentials/reset`;
    },
  },
};

export async function invokeAction(
  api: LinodeApi,
  typeId: string,
  resourceId: string,
  actionId: string,
): Promise<void> {
  const id = trailingId(resourceId);
  if (typeId === "linode" && actionId === "snapshot") {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    await api.send("POST", `/linode/instances/${id}/backups`, { label: `infrawrench-${stamp}` });
    return;
  }
  if (typeId === "lke-cluster" && actionId === "regenerate_kubeconfig") {
    await api.send("POST", `/lke/clusters/${id}/regenerate`, { kubeconfig: true });
    return;
  }
  const path = SIMPLE_ACTIONS[typeId]?.[actionId];
  if (!path) throw new Error(`Linode plugin: action "${actionId}" is not available for ${typeId}`);
  await api.send("POST", path(id), {});
}

function rule(values: Record<string, string>): LinodeFirewallRule {
  const sources = listValue(values["addresses"]);
  const ipv4 = sources.filter((s) => !s.includes(":"));
  const ipv6 = sources.filter((s) => s.includes(":"));
  const anywhere = sources.length === 0;
  const protocol = values["protocol"] || "TCP";
  return {
    label:
      values["label"] ||
      `${protocol.toLowerCase()}-${(values["ports"] || "all").replace(/[^0-9a-z]+/gi, "-")}`.slice(
        0,
        32,
      ),
    action: values["action"] || "ACCEPT",
    protocol,
    ...(protocol !== "ICMP" && protocol !== "IPENCAP" && values["ports"]
      ? { ports: values["ports"] }
      : {}),
    addresses: anywhere ? { ipv4: ["0.0.0.0/0"], ipv6: ["::/0"] } : { ipv4, ipv6 },
  };
}

export async function executeCommand(
  api: LinodeApi,
  typeId: string,
  resourceId: string,
  command: string,
  args: (string | number)[],
): Promise<unknown> {
  const id = trailingId(resourceId);
  const values = decodePromptArgs(args);

  if (typeId === "linode") {
    switch (command) {
      case "resize": {
        if (!values["type"]) throw new Error("Pick a plan.");
        const current = await api.get<{ lke_cluster_id?: number | null }>(
          `/linode/instances/${id}`,
        );
        if (current.lke_cluster_id != null) {
          throw new Error("This Linode is an LKE worker node; resize its node pool instead.");
        }
        await api.send("POST", `/linode/instances/${id}/resize`, {
          type: values["type"],
          allow_auto_disk_resize: values["autoDiskResize"] !== "false",
          migration_type: values["migrationType"] === "warm" ? "warm" : "cold",
        });
        return { ok: true };
      }
      case "rebuild": {
        if (!values["image"]) throw new Error("Pick an image.");
        const keys = values["sshPublicKey"] ? [values["sshPublicKey"].trim()] : [];
        await api.send("POST", `/linode/instances/${id}/rebuild`, {
          image: values["image"],
          root_pass: values["rootPass"] || randomRootPassword(),
          ...(keys.length ? { authorized_keys: keys } : {}),
        });
        return { ok: true };
      }
      case "snapshot-named": {
        await api.send("POST", `/linode/instances/${id}/backups`, {
          label: values["label"] || "snapshot",
        });
        return { ok: true };
      }
      case "restore-backup": {
        if (!values["backupId"]) throw new Error("Pick a backup.");
        await api.send("POST", `/linode/instances/${id}/backups/${values["backupId"]}/restore`, {
          linode_id: Number(id),
          overwrite: values["overwrite"] === "true",
        });
        return { ok: true };
      }
    }
  }

  if (typeId === "volume" && command === "attach") {
    const linodeId = Number(values["linodeId"]);
    if (!linodeId) throw new Error("Pick a Linode.");
    await api.send("POST", `/volumes/${id}/attach`, {
      linode_id: linodeId,
      persist_across_boots: true,
    });
    return { ok: true };
  }

  if (typeId === "nodebalancer") {
    switch (command) {
      case "add-port": {
        const port = Number(values["port"]);
        if (!port) throw new Error("Enter a port.");
        await api.send("POST", `/nodebalancers/${id}/configs`, {
          port,
          protocol: values["protocol"] || "http",
          algorithm: values["algorithm"] || "roundrobin",
          stickiness: values["stickiness"] || "none",
          check: values["check"] || "connection",
          ...(values["check"] === "http" || values["check"] === "http_body"
            ? { check_path: values["checkPath"] || "/" }
            : {}),
          ...(values["protocol"] === "https"
            ? { ssl_cert: values["sslCert"], ssl_key: values["sslKey"] }
            : {}),
        });
        return { ok: true };
      }
      case "remove-port":
        await api.send("DELETE", `/nodebalancers/${id}/configs/${values["configId"]}`);
        return { ok: true };
      case "add-node": {
        const address = (values["address"] ?? "").trim();
        const port = Number(values["port"]) || 80;
        if (!values["configId"] || !address) throw new Error("Pick a port and a backend Linode.");
        await api.send("POST", `/nodebalancers/${id}/configs/${values["configId"]}/nodes`, {
          label: (values["label"] || address.replace(/[^0-9a-z]+/gi, "-")).slice(0, 32),
          address: `${address}:${port}`,
          weight: Number(values["weight"]) || 100,
          mode: values["mode"] || "accept",
        });
        return { ok: true };
      }
      case "remove-node":
        await api.send(
          "DELETE",
          `/nodebalancers/${id}/configs/${values["configId"]}/nodes/${values["nodeId"]}`,
        );
        return { ok: true };
    }
  }

  if (typeId === "firewall") {
    const current = await api.get<NonNullable<LinodeFirewall["rules"]>>(
      `/networking/firewalls/${id}/rules`,
    );
    const direction = values["direction"] === "outbound" ? "outbound" : "inbound";
    const inbound = [...(current.inbound ?? [])];
    const outbound = [...(current.outbound ?? [])];
    const list = direction === "outbound" ? outbound : inbound;
    if (command === "add-rule") {
      list.push(rule(values));
    } else if (command === "remove-rule") {
      const index = Number(values["index"]);
      if (!Number.isInteger(index) || index < 0 || index >= list.length)
        throw new Error("That rule no longer exists.");
      list.splice(index, 1);
    } else if (command === "remove-device") {
      await api.send("DELETE", `/networking/firewalls/${id}/devices/${values["deviceId"]}`);
      return { ok: true };
    } else {
      throw new Error(`Linode plugin: unknown firewall command "${command}"`);
    }
    await api.send("PUT", `/networking/firewalls/${id}/rules`, {
      inbound,
      outbound,
      inbound_policy: current.inbound_policy,
      outbound_policy: current.outbound_policy,
    });
    return { ok: true };
  }

  if (typeId === "vpc") {
    if (command === "add-subnet") {
      if (!values["ipv4"]) throw new Error("Enter an IPv4 range.");
      await api.send("POST", `/vpcs/${id}/subnets`, {
        label: values["label"] || "subnet",
        ipv4: values["ipv4"],
      });
      return { ok: true };
    }
    if (command === "remove-subnet") {
      await api.send("DELETE", `/vpcs/${id}/subnets/${values["subnetId"]}`);
      return { ok: true };
    }
  }

  throw new Error(`Linode plugin: unknown command "${command}" for ${typeId}`);
}
