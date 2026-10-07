/**
 * Deletes, drag-attach, one-click actions and prompted actions
 * (`executeNoSqlCommand`; `args[0]` is the prompt's JSON form).
 */

import { decodePromptArgs, signedS3Fetch } from "@infrawrench/plugin-base";
import { DEFAULT_ZONE, type ExoscaleApi, intOr, trailingId, zonal } from "./api.js";
import { type Json, dbaasPath, sosEndpoint, str } from "./listers.js";
import { instanceTypeId } from "./update.js";

async function dbaasType(api: ExoscaleApi, name: string): Promise<string> {
  const svc = await api.get<{ "dbaas-services"?: Json[] }>(DEFAULT_ZONE, "/dbaas-service");
  const type = str((svc["dbaas-services"] ?? []).find((s) => s["name"] === name)?.["type"]);
  if (!type) throw new Error("That database service no longer exists.");
  return type;
}

export async function deleteResource(
  api: ExoscaleApi,
  typeId: string,
  resourceId: string,
): Promise<void> {
  const { zone, id } = zonal(resourceId);
  const raw = trailingId(resourceId);
  const del = (path: string, z = zone) => api.mutate(z, "DELETE", path).then(() => undefined);
  switch (typeId) {
    case "instance":
      return del(`/instance/${id}`);
    case "block-storage":
      return del(`/block-storage/${id}`);
    case "block-storage-snapshot":
      return del(`/block-storage-snapshot/${id}`);
    case "snapshot":
      return del(`/snapshot/${id}`);
    case "template":
      return del(`/template/${id}`);
    case "private-network":
      return del(`/private-network/${id}`);
    case "security-group":
      return del(`/security-group/${raw}`, DEFAULT_ZONE);
    case "elastic-ip":
      return del(`/elastic-ip/${id}`);
    case "sks-cluster":
      return del(`/sks-cluster/${id}`);
    case "sks-nodepool": {
      const [clusterId, poolId] = id.split("/");
      return del(`/sks-cluster/${clusterId}/nodepool/${poolId}`);
    }
    case "nlb":
      return del(`/load-balancer/${id}`);
    case "instance-pool":
      return del(`/instance-pool/${id}`);
    case "dbaas":
      return del(`/dbaas-${dbaasPath(await dbaasType(api, id))}/${id}`);
    case "dbaas-user":
    case "dbaas-database": {
      const [svc, name] = id.split("/");
      const base = `/dbaas-${dbaasPath(await dbaasType(api, svc ?? ""))}/${svc}`;
      return del(
        typeId === "dbaas-user"
          ? `${base}/user/${encodeURIComponent(name ?? "")}`
          : `${base}/database/${encodeURIComponent(name ?? "")}`,
      );
    }
    case "dns-domain":
      return del(`/dns-domain/${raw}`, DEFAULT_ZONE);
    case "dns-record": {
      const [domainId, recordId] = raw.split("/");
      return del(`/dns-domain/${domainId}/record/${recordId}`, DEFAULT_ZONE);
    }
    case "ssh-key":
      return del(`/ssh-key/${encodeURIComponent(raw)}`, DEFAULT_ZONE);
    case "anti-affinity-group":
      return del(`/anti-affinity-group/${raw}`, DEFAULT_ZONE);
    case "bucket": {
      const res = await signedS3Fetch({
        accessKey: api.apiKey,
        secretKey: api.apiSecret,
        region: zone,
        method: "DELETE",
        url: `${sosEndpoint(zone)}/${encodeURIComponent(id)}`,
      });
      if (!res.ok && res.status !== 404) {
        const err = new Error(
          `SOS refused to delete the bucket (it must be empty): ${res.status}`,
        ) as Error & { status: number };
        err.status = res.status;
        throw err;
      }
      return;
    }
    default:
      throw new Error(`Exoscale plugin: "${typeId}" cannot be deleted here`);
  }
}

export async function attachResource(
  api: ExoscaleApi,
  sourceTypeId: string,
  sourceResourceId: string,
  targetTypeId: string,
  targetResourceId: string,
): Promise<void> {
  const target = zonal(targetResourceId);
  if (targetTypeId !== "instance")
    throw new Error(`Exoscale plugin: cannot attach to ${targetTypeId}`);
  const body = { instance: { id: target.id } };
  switch (sourceTypeId) {
    case "block-storage": {
      const s = zonal(sourceResourceId);
      await api.mutate(s.zone, "PUT", `/block-storage/${s.id}:attach`, body);
      return;
    }
    case "elastic-ip": {
      const s = zonal(sourceResourceId);
      await api.mutate(s.zone, "PUT", `/elastic-ip/${s.id}:attach`, body);
      return;
    }
    case "private-network": {
      const s = zonal(sourceResourceId);
      await api.mutate(s.zone, "PUT", `/private-network/${s.id}:attach`, body);
      return;
    }
    case "security-group":
      await api.mutate(
        target.zone,
        "PUT",
        `/security-group/${trailingId(sourceResourceId)}:attach`,
        body,
      );
      return;
    default:
      throw new Error(`Exoscale plugin: cannot attach ${sourceTypeId} to an instance`);
  }
}

export async function invokeAction(
  api: ExoscaleApi,
  typeId: string,
  resourceId: string,
  actionId: string,
): Promise<void> {
  const { zone, id } = zonal(resourceId);
  if (typeId === "instance") {
    const verbs: Record<string, string> = {
      start: "start",
      stop: "stop",
      reboot: "reboot",
      "add-protection": "add-protection",
      "remove-protection": "remove-protection",
      snapshot: "create-snapshot",
    };
    const verb = verbs[actionId];
    if (verb) {
      await api.mutate(
        zone,
        verb === "create-snapshot" ? "POST" : "PUT",
        `/instance/${id}:${verb}`,
        verb === "start" ? {} : undefined,
      );
      return;
    }
  }
  if (typeId === "block-storage" && actionId === "detach")
    return void (await api.mutate(zone, "PUT", `/block-storage/${id}:detach`));
  if (typeId === "dbaas" && actionId === "maintenance") {
    return void (await api.send(
      zone,
      "PUT",
      `/dbaas-${dbaasPath(await dbaasType(api, id))}/${id}/maintenance/start`,
    ));
  }
  throw new Error(`Exoscale plugin: unknown action "${actionId}" for ${typeId}`);
}

export async function executeCommand(
  api: ExoscaleApi,
  typeId: string,
  resourceId: string,
  command: string,
  args: (string | number)[],
): Promise<unknown> {
  const { zone, id } = zonal(resourceId);
  const v = decodePromptArgs(args);
  switch (`${typeId}:${command}`) {
    case "instance:scale":
      return api.mutate(zone, "PUT", `/instance/${id}:scale`, {
        "instance-type": { id: await instanceTypeId(api, v["instanceType"] ?? "") },
      });
    case "instance:resize-disk":
      return api.mutate(zone, "PUT", `/instance/${id}:resize-disk`, {
        "disk-size": intOr(v["diskGb"]),
      });
    case "instance:revert-snapshot":
      if (!v["snapshotId"]) throw new Error("Pick a snapshot.");
      return api.mutate(zone, "POST", `/instance/${id}:revert-snapshot`, { id: v["snapshotId"] });
    case "instance:reset":
      return api.mutate(zone, "PUT", `/instance/${id}:reset`, {
        ...(v["template"] ? { template: { id: v["template"] } } : {}),
        ...(v["diskGb"] ? { "disk-size": intOr(v["diskGb"]) } : {}),
      });
    case "instance:detach-security-group":
      return api.mutate(zone, "PUT", `/security-group/${v["securityGroupId"]}:detach`, {
        instance: { id },
      });
    case "instance:detach-elastic-ip":
      return api.mutate(zone, "PUT", `/elastic-ip/${v["elasticIpId"]}:detach`, {
        instance: { id },
      });
    case "instance:detach-private-network":
      return api.mutate(zone, "PUT", `/private-network/${v["networkId"]}:detach`, {
        instance: { id },
      });
    case "block-storage:attach":
      if (!v["instanceId"]) throw new Error("Pick the instance.");
      return api.mutate(zone, "PUT", `/block-storage/${id}:attach`, {
        instance: { id: v["instanceId"] },
      });
    case "block-storage:snapshot":
      return api.mutate(zone, "POST", `/block-storage/${id}:create-snapshot`, { name: v["name"] });
    case "elastic-ip:attach":
      if (!v["instanceId"]) throw new Error("Pick the instance.");
      return api.mutate(zone, "PUT", `/elastic-ip/${id}:attach`, {
        instance: { id: v["instanceId"] },
      });
    case "security-group:add-rule": {
      const proto = v["protocol"] || "tcp";
      const [start, end] = (v["ports"] || "").split("-").map((s) => s.trim());
      return api.mutate(DEFAULT_ZONE, "POST", `/security-group/${trailingId(resourceId)}/rules`, {
        "flow-direction": v["direction"] || "ingress",
        protocol: proto,
        ...(v["sourceGroupId"]
          ? { "security-group": { id: v["sourceGroupId"] } }
          : { network: v["network"] || "0.0.0.0/0" }),
        ...(["tcp", "udp"].includes(proto) && start
          ? { "start-port": Number(start), "end-port": Number(end || start) }
          : {}),
        ...(proto === "icmp" ? { icmp: { type: 8, code: 0 } } : {}),
        ...(v["description"] ? { description: v["description"] } : {}),
      });
    }
    case "security-group:remove-rule":
      return api.mutate(
        DEFAULT_ZONE,
        "DELETE",
        `/security-group/${trailingId(resourceId)}/rules/${v["ruleId"]}`,
      );
    case "sks-cluster:upgrade":
      if (!v["version"]) throw new Error("Pick the version.");
      return api.mutate(zone, "PUT", `/sks-cluster/${id}/upgrade`, { version: v["version"] });
    case "sks-cluster:upgrade-level":
      return api.mutate(zone, "PUT", `/sks-cluster/${id}/upgrade-service-level`);
    case "nlb:add-service":
      return api.mutate(zone, "POST", `/load-balancer/${id}/service`, {
        name: v["name"],
        "instance-pool": { id: v["poolId"] },
        protocol: v["protocol"] || "tcp",
        strategy: v["strategy"] || "round-robin",
        port: intOr(v["port"], 80),
        "target-port": intOr(v["targetPort"], 80),
        healthcheck: {
          mode: v["healthMode"] || "tcp",
          port: intOr(v["targetPort"], 80),
          ...(v["healthMode"] && v["healthMode"] !== "tcp" ? { uri: v["healthUri"] || "/" } : {}),
          interval: 10,
          timeout: 5,
          retries: 1,
        },
      });
    case "nlb:remove-service":
      return api.mutate(zone, "DELETE", `/load-balancer/${id}/service/${v["serviceId"]}`);
    case "dbaas:reveal-password": {
      const [svc, user] = [id, v["username"] ?? ""];
      const type = await dbaasType(api, svc);
      return api.get(
        zone,
        `/dbaas-${dbaasPath(type)}/${svc}/user/${encodeURIComponent(user)}/password/reveal`,
      );
    }
    default:
      throw new Error(`Exoscale plugin: unknown command "${command}" for ${typeId}`);
  }
}
