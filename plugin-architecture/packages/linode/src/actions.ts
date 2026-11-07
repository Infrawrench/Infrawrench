/**
 * Deletes, drag-attach, one-click actions (`invokeAction`) and prompted
 * actions (`executeNoSqlCommand`, dispatched from `prompt-nosql-command`
 * header actions; the host packs the form as `args[0] = JSON.stringify(values)`).
 */

import { decodePromptArgs, pathEncode } from "@infrawrench/plugin-base";
import { type LinodeApi, segment, trailingId } from "./api.js";
import { listValue, randomRootPassword } from "./create.js";
import type { LinodeFirewallRule } from "./types.js";

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
      return void (await api.delete(`/linode/instances/${segment(id)}`));
    case "volume": {
      const vol = await api.get(`/volumes/${segment(id)}`);
      if (vol.linode_id != null) {
        throw new Error("Detach the volume from its Linode before deleting it.");
      }
      return void (await api.delete(`/volumes/${segment(id)}`));
    }
    case "nodebalancer":
      return void (await api.delete(`/nodebalancers/${segment(id)}`));
    case "lke-cluster":
      return void (await api.delete(`/lke/clusters/${segment(id)}`));
    case "lke-node-pool":
      return void (await api.delete(`/lke/clusters/${segment(a)}/pools/${segment(b)}`));
    case "bucket":
      return void (await api.delete(`/object-storage/buckets/${segment(a)}/${pathEncode(b)}`));
    case "database":
      return void (await api.delete(`/databases/${segment(a)}/instances/${segment(b)}`));
    case "firewall":
      return void (await api.delete(`/networking/firewalls/${segment(id)}`));
    case "domain":
      return void (await api.delete(`/domains/${segment(id)}`));
    case "domain-record":
      return void (await api.delete(`/domains/${segment(a)}/records/${segment(b)}`));
    case "vpc":
      return void (await api.delete(`/vpcs/${segment(id)}`));
    case "image":
      return void (await api.delete(`/images/${pathEncode(id)}`));
    case "stackscript":
      return void (await api.delete(`/linode/stackscripts/${segment(id)}`));
    case "reserved-ip":
      return void (await api.delete(`/networking/reserved/ips/${segment(id)}`));
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
    await api.post(`/volumes/${segment(source)}/attach`, {
      body: { linode_id: target, persist_across_boots: true },
    });
    return;
  }
  if (
    sourceTypeId === "firewall" &&
    (targetTypeId === "linode" || targetTypeId === "nodebalancer")
  ) {
    await api.post(`/networking/firewalls/${segment(source)}/devices`, {
      body: { id: target, type: targetTypeId },
    });
    return;
  }
  if (sourceTypeId === "reserved-ip" && targetTypeId === "linode") {
    const ip = await api.get(`/networking/reserved/ips/${segment(source)}`);
    await api.post("/networking/ips/assign", {
      body: { region: ip.region, assignments: [{ address: source, linode_id: target }] },
    });
    return;
  }
  throw new Error(`Linode plugin: cannot attach ${sourceTypeId} to ${targetTypeId}`);
}

type SimpleAction = (api: LinodeApi, id: string) => Promise<unknown>;

/** Parameterless actions, each one POST with an empty object for a body. */
const SIMPLE_ACTIONS: Record<string, Record<string, SimpleAction>> = {
  linode: {
    boot: (api, id) => api.post(`/linode/instances/${segment(id)}/boot`, { body: {} }),
    shutdown: (api, id) => api.post(`/linode/instances/${segment(id)}/shutdown`, { body: {} }),
    reboot: (api, id) => api.post(`/linode/instances/${segment(id)}/reboot`, { body: {} }),
    enable_backups: (api, id) =>
      api.post(`/linode/instances/${segment(id)}/backups/enable`, { body: {} }),
    cancel_backups: (api, id) =>
      api.post(`/linode/instances/${segment(id)}/backups/cancel`, { body: {} }),
  },
  volume: { detach: (api, id) => api.post(`/volumes/${segment(id)}/detach`, { body: {} }) },
  "lke-cluster": {
    recycle: (api, id) => api.post(`/lke/clusters/${segment(id)}/recycle`, { body: {} }),
  },
  "lke-node-pool": {
    recycle: (api, id) => {
      const [c, p] = id.split("/");
      return api.post(`/lke/clusters/${segment(c)}/pools/${segment(p)}/recycle`, { body: {} });
    },
  },
  database: {
    suspend: (api, id) => {
      const [e, d] = id.split("/");
      return api.post(`/databases/${segment(e)}/instances/${segment(d)}/suspend`, { body: {} });
    },
    resume: (api, id) => {
      const [e, d] = id.split("/");
      return api.post(`/databases/${segment(e)}/instances/${segment(d)}/resume`, { body: {} });
    },
    patch: (api, id) => {
      const [e, d] = id.split("/");
      return api.post(`/databases/${segment(e)}/instances/${segment(d)}/patch`, { body: {} });
    },
    reset_credentials: (api, id) => {
      const [e, d] = id.split("/");
      return api.post(`/databases/${segment(e)}/instances/${segment(d)}/credentials/reset`, {
        body: {},
      });
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
    await api.post(`/linode/instances/${segment(id)}/backups`, {
      body: { label: `infrawrench-${stamp}` },
    });
    return;
  }
  if (typeId === "lke-cluster" && actionId === "regenerate_kubeconfig") {
    await api.post(`/lke/clusters/${segment(id)}/regenerate`, { body: { kubeconfig: true } });
    return;
  }
  const action = SIMPLE_ACTIONS[typeId]?.[actionId];
  if (!action) {
    throw new Error(`Linode plugin: action "${actionId}" is not available for ${typeId}`);
  }
  await action(api, id);
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
        const current = await api.get(`/linode/instances/${segment(id)}`);
        if (current.lke_cluster_id != null) {
          throw new Error("This Linode is an LKE worker node; resize its node pool instead.");
        }
        await api.post(`/linode/instances/${segment(id)}/resize`, {
          body: {
            type: values["type"],
            allow_auto_disk_resize: values["autoDiskResize"] !== "false",
            migration_type: values["migrationType"] === "warm" ? "warm" : "cold",
          },
        });
        return { ok: true };
      }
      case "rebuild": {
        if (!values["image"]) throw new Error("Pick an image.");
        const keys = values["sshPublicKey"] ? [values["sshPublicKey"].trim()] : [];
        await api.post(`/linode/instances/${segment(id)}/rebuild`, {
          body: {
            image: values["image"],
            root_pass: values["rootPass"] || randomRootPassword(),
            ...(keys.length ? { authorized_keys: keys } : {}),
          },
        });
        return { ok: true };
      }
      case "snapshot-named": {
        await api.post(`/linode/instances/${segment(id)}/backups`, {
          body: { label: values["label"] || "snapshot" },
        });
        return { ok: true };
      }
      case "restore-backup": {
        if (!values["backupId"]) throw new Error("Pick a backup.");
        await api.post(
          `/linode/instances/${segment(id)}/backups/${segment(values["backupId"])}/restore`,
          { body: { linode_id: Number(id), overwrite: values["overwrite"] === "true" } },
        );
        return { ok: true };
      }
    }
  }

  if (typeId === "volume" && command === "attach") {
    const linodeId = Number(values["linodeId"]);
    if (!linodeId) throw new Error("Pick a Linode.");
    await api.post(`/volumes/${segment(id)}/attach`, {
      body: { linode_id: linodeId, persist_across_boots: true },
    });
    return { ok: true };
  }

  if (typeId === "nodebalancer") {
    switch (command) {
      case "add-port": {
        const port = Number(values["port"]);
        if (!port) throw new Error("Enter a port.");
        await api.post(`/nodebalancers/${segment(id)}/configs`, {
          body: {
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
          },
        });
        return { ok: true };
      }
      case "remove-port":
        await api.delete(`/nodebalancers/${segment(id)}/configs/${segment(values["configId"])}`);
        return { ok: true };
      case "add-node": {
        const address = (values["address"] ?? "").trim();
        const port = Number(values["port"]) || 80;
        if (!values["configId"] || !address) throw new Error("Pick a port and a backend Linode.");
        await api.post(
          `/nodebalancers/${segment(id)}/configs/${segment(values["configId"])}/nodes`,
          {
            body: {
              label: (values["label"] || address.replace(/[^0-9a-z]+/gi, "-")).slice(0, 32),
              address: `${address}:${port}`,
              weight: Number(values["weight"]) || 100,
              mode: values["mode"] || "accept",
            },
          },
        );
        return { ok: true };
      }
      case "remove-node":
        await api.delete(
          `/nodebalancers/${segment(id)}/configs/${segment(values["configId"])}/nodes/${segment(values["nodeId"])}`,
        );
        return { ok: true };
    }
  }

  if (typeId === "firewall") {
    const current = await api.get(`/networking/firewalls/${segment(id)}/rules`);
    const direction = values["direction"] === "outbound" ? "outbound" : "inbound";
    const inbound: LinodeFirewallRule[] = [...(current.inbound ?? [])];
    const outbound: LinodeFirewallRule[] = [...(current.outbound ?? [])];
    const list = direction === "outbound" ? outbound : inbound;
    if (command === "add-rule") {
      list.push(rule(values));
    } else if (command === "remove-rule") {
      const index = Number(values["index"]);
      if (!Number.isInteger(index) || index < 0 || index >= list.length)
        throw new Error("That rule no longer exists.");
      list.splice(index, 1);
    } else if (command === "remove-device") {
      await api.delete(
        `/networking/firewalls/${segment(id)}/devices/${segment(values["deviceId"])}`,
      );
      return { ok: true };
    } else {
      throw new Error(`Linode plugin: unknown firewall command "${command}"`);
    }
    await api.put(`/networking/firewalls/${segment(id)}/rules`, {
      body: {
        inbound,
        outbound,
        inbound_policy: current.inbound_policy,
        outbound_policy: current.outbound_policy,
      },
    });
    return { ok: true };
  }

  if (typeId === "vpc") {
    if (command === "add-subnet") {
      if (!values["ipv4"]) throw new Error("Enter an IPv4 range.");
      await api.post(`/vpcs/${segment(id)}/subnets`, {
        body: { label: values["label"] || "subnet", ipv4: values["ipv4"] },
      });
      return { ok: true };
    }
    if (command === "remove-subnet") {
      await api.delete(`/vpcs/${segment(id)}/subnets/${segment(values["subnetId"])}`);
      return { ok: true };
    }
  }

  throw new Error(`Linode plugin: unknown command "${command}" for ${typeId}`);
}
