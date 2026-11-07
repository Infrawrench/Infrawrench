/**
 * Deletes, drag-attach, one-click actions and prompted actions
 * (`executeNoSqlCommand`; `args[0]` is the prompt's JSON form).
 */

import { decodePromptArgs, pathEncode, signedS3Fetch } from "@infrawrench/plugin-base";
import {
  DEFAULT_ZONE,
  type ExoscaleApi,
  type Operation,
  byId,
  intOr,
  rawId,
  trailingId,
  zonal,
} from "./api.js";
import { dbaasPath, sosEndpoint, str } from "./listers.js";
import { instanceTypeId } from "./update.js";

async function dbaasType(api: ExoscaleApi, name: string): Promise<string> {
  const svc = await api.at(DEFAULT_ZONE).get("/dbaas-service");
  const type = str((svc["dbaas-services"] ?? []).find((s) => s["name"] === name)?.["type"]);
  if (!type) throw new Error("That database service no longer exists.");
  return type;
}

/** `GET /dbaas-{type}/{service}/user/{username}/password/reveal`. */
export async function revealPassword(
  api: ExoscaleApi,
  zone: string,
  service: string,
  username: string,
) {
  const type = await dbaasType(api, service);
  return api
    .at(zone)
    .get(
      `/dbaas-${rawId(dbaasPath(type))}/${rawId(service)}/user/${pathEncode(username)}/password/reveal`,
    );
}

export async function deleteResource(
  api: ExoscaleApi,
  typeId: string,
  resourceId: string,
): Promise<void> {
  const { zone, id } = zonal(resourceId);
  const raw = trailingId(resourceId);
  const z = api.at(zone);
  const dns = api.at(DEFAULT_ZONE);
  const ref = rawId(id);
  const done = (answer: Promise<Operation>, at = z) => at.settle(answer).then(() => undefined);
  switch (typeId) {
    case "instance":
      return done(z.delete(`/instance/${ref}`));
    case "block-storage":
      return done(z.delete(`/block-storage/${ref}`));
    case "block-storage-snapshot":
      return done(z.delete(`/block-storage-snapshot/${ref}`));
    case "snapshot":
      return done(z.delete(`/snapshot/${ref}`));
    case "template":
      return done(z.delete(`/template/${ref}`));
    case "private-network":
      return done(z.delete(`/private-network/${ref}`));
    case "security-group":
      return done(dns.delete(`/security-group/${rawId(raw)}`), dns);
    case "elastic-ip":
      return done(z.delete(`/elastic-ip/${ref}`));
    case "sks-cluster":
      return done(z.delete(`/sks-cluster/${ref}`));
    case "sks-nodepool": {
      const [clusterId, poolId] = id.split("/");
      return done(z.delete(`/sks-cluster/${rawId(clusterId)}/nodepool/${rawId(poolId)}`));
    }
    case "nlb":
      return done(z.delete(`/load-balancer/${ref}`));
    case "instance-pool":
      return done(z.delete(`/instance-pool/${ref}`));
    case "dbaas":
      return done(z.delete(`/dbaas-${rawId(dbaasPath(await dbaasType(api, id)))}/${ref}`));
    case "dbaas-user":
    case "dbaas-database": {
      const [svc, name] = id.split("/");
      const family = rawId(dbaasPath(await dbaasType(api, svc ?? "")));
      return done(
        typeId === "dbaas-user"
          ? z.delete(`/dbaas-${family}/${rawId(svc)}/user/${pathEncode(name ?? "")}`)
          : z.delete(`/dbaas-${family}/${rawId(svc)}/database/${pathEncode(name ?? "")}`),
      );
    }
    case "dns-domain":
      return done(dns.delete(`/dns-domain/${rawId(raw)}`), dns);
    case "dns-record": {
      const [domainId, recordId] = raw.split("/");
      return done(dns.delete(`/dns-domain/${rawId(domainId)}/record/${rawId(recordId)}`), dns);
    }
    case "ssh-key":
      return done(dns.delete(`/ssh-key/${pathEncode(raw)}`), dns);
    case "anti-affinity-group":
      return done(dns.delete(`/anti-affinity-group/${rawId(raw)}`), dns);
    case "bucket": {
      const res = await signedS3Fetch({
        accessKey: api.apiKey,
        secretKey: api.apiSecret,
        region: zone,
        method: "DELETE",
        url: `${sosEndpoint(zone)}/${encodeURIComponent(id)}`,
      });
      if (!res.ok && res.status !== 404) {
        throw Object.assign(
          new Error(`SOS refused to delete the bucket (it must be empty): ${res.status}`),
          { status: res.status },
        );
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
      const z = api.at(s.zone);
      await z.settle(z.put(`/block-storage/${rawId(s.id)}:attach`, { body }));
      return;
    }
    case "elastic-ip": {
      const s = zonal(sourceResourceId);
      const z = api.at(s.zone);
      await z.settle(z.put(`/elastic-ip/${rawId(s.id)}:attach`, { body }));
      return;
    }
    case "private-network": {
      const s = zonal(sourceResourceId);
      const z = api.at(s.zone);
      await z.settle(z.put(`/private-network/${rawId(s.id)}:attach`, { body }));
      return;
    }
    case "security-group": {
      const z = api.at(target.zone);
      await z.settle(
        z.put(`/security-group/${rawId(trailingId(sourceResourceId))}:attach`, { body }),
      );
      return;
    }
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
  const z = api.at(zone);
  const ref = rawId(id);
  if (typeId === "instance") {
    switch (actionId) {
      case "start":
        await z.settle(z.put(`/instance/${ref}:start`, { body: {} }));
        return;
      case "stop":
        await z.settle(z.put(`/instance/${ref}:stop`));
        return;
      case "reboot":
        await z.settle(z.put(`/instance/${ref}:reboot`));
        return;
      case "add-protection":
        await z.settle(z.put(`/instance/${ref}:add-protection`));
        return;
      case "remove-protection":
        await z.settle(z.put(`/instance/${ref}:remove-protection`));
        return;
      case "snapshot":
        await z.settle(z.post(`/instance/${ref}:create-snapshot`));
        return;
    }
  }
  if (typeId === "block-storage" && actionId === "detach")
    return void (await z.settle(z.put(`/block-storage/${ref}:detach`)));
  if (typeId === "dbaas" && actionId === "maintenance") {
    return void (await z.put(
      `/dbaas-${rawId(dbaasPath(await dbaasType(api, id)))}/${ref}/maintenance/start`,
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
): Promise<Operation | Awaited<ReturnType<typeof revealPassword>>> {
  const { zone, id } = zonal(resourceId);
  const z = api.at(zone);
  const ref = rawId(id);
  const v = decodePromptArgs(args);
  switch (`${typeId}:${command}`) {
    case "instance:scale":
      return z.settle(
        z.put(`/instance/${ref}:scale`, {
          body: { "instance-type": byId(await instanceTypeId(api, v["instanceType"] ?? "")) },
        }),
      );
    case "instance:resize-disk":
      return z.settle(
        z.put(`/instance/${ref}:resize-disk`, { body: { "disk-size": intOr(v["diskGb"]) } }),
      );
    case "instance:revert-snapshot":
      if (!v["snapshotId"]) throw new Error("Pick a snapshot.");
      return z.settle(
        z.post(`/instance/${ref}:revert-snapshot`, { body: { id: v["snapshotId"] } }),
      );
    case "instance:reset":
      return z.settle(
        z.put(`/instance/${ref}:reset`, {
          body: {
            ...(v["template"] ? { template: { id: v["template"] } } : {}),
            ...(v["diskGb"] ? { "disk-size": intOr(v["diskGb"]) } : {}),
          },
        }),
      );
    case "instance:detach-security-group":
      return z.settle(
        z.put(`/security-group/${rawId(v["securityGroupId"])}:detach`, {
          body: { instance: { id } },
        }),
      );
    case "instance:detach-elastic-ip":
      return z.settle(
        z.put(`/elastic-ip/${rawId(v["elasticIpId"])}:detach`, { body: { instance: { id } } }),
      );
    case "instance:detach-private-network":
      return z.settle(
        z.put(`/private-network/${rawId(v["networkId"])}:detach`, {
          body: { instance: { id } },
        }),
      );
    case "block-storage:attach":
      if (!v["instanceId"]) throw new Error("Pick the instance.");
      return z.settle(
        z.put(`/block-storage/${ref}:attach`, { body: { instance: { id: v["instanceId"] } } }),
      );
    case "block-storage:snapshot":
      return z.settle(
        z.post(`/block-storage/${ref}:create-snapshot`, { body: { name: v["name"] } }),
      );
    case "elastic-ip:attach":
      if (!v["instanceId"]) throw new Error("Pick the instance.");
      return z.settle(
        z.put(`/elastic-ip/${ref}:attach`, { body: { instance: { id: v["instanceId"] } } }),
      );
    case "security-group:add-rule": {
      const proto = v["protocol"] || "tcp";
      const [start, end] = (v["ports"] || "").split("-").map((s) => s.trim());
      const dns = api.at(DEFAULT_ZONE);
      return dns.settle(
        dns.post(`/security-group/${rawId(trailingId(resourceId))}/rules`, {
          body: {
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
          },
        }),
      );
    }
    case "security-group:remove-rule": {
      const dns = api.at(DEFAULT_ZONE);
      return dns.settle(
        dns.delete(`/security-group/${rawId(trailingId(resourceId))}/rules/${rawId(v["ruleId"])}`),
      );
    }
    case "sks-cluster:upgrade":
      if (!v["version"]) throw new Error("Pick the version.");
      return z.settle(z.put(`/sks-cluster/${ref}/upgrade`, { body: { version: v["version"] } }));
    case "sks-cluster:upgrade-level":
      return z.settle(z.put(`/sks-cluster/${ref}/upgrade-service-level`));
    case "nlb:add-service":
      return z.settle(
        z.post(`/load-balancer/${ref}/service`, {
          body: {
            name: v["name"],
            "instance-pool": byId(v["poolId"]),
            protocol: v["protocol"] || "tcp",
            strategy: v["strategy"] || "round-robin",
            port: intOr(v["port"], 80),
            "target-port": intOr(v["targetPort"], 80),
            healthcheck: {
              mode: v["healthMode"] || "tcp",
              port: intOr(v["targetPort"], 80),
              ...(v["healthMode"] && v["healthMode"] !== "tcp"
                ? { uri: v["healthUri"] || "/" }
                : {}),
              interval: 10,
              timeout: 5,
              retries: 1,
            },
          },
        }),
      );
    case "nlb:remove-service":
      return z.settle(z.delete(`/load-balancer/${ref}/service/${rawId(v["serviceId"])}`));
    case "dbaas:reveal-password":
      return revealPassword(api, zone, id, v["username"] ?? "");
    default:
      throw new Error(`Exoscale plugin: unknown command "${command}" for ${typeId}`);
  }
}
