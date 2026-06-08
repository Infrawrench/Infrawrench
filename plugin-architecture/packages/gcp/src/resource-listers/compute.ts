import type { ResourceInstance } from "@infrawrench/plugin-base";
import { paginateAggregated, type ListerContext } from "./shared.js";

export async function listGceInstances(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await paginateAggregated<Record<string, unknown>>(
    ctx,
    `https://compute.googleapis.com/compute/v1/projects/${p}/aggregated/instances`,
    "instances",
  );
  return items.map((inst) => {
    const name = String(inst["name"]);
    const numericId = String(inst["id"] ?? "");
    const zone_ = String(inst["zone"]).split("/").pop() ?? "";
    const machineType = String(inst["machineType"]).split("/").pop() ?? "";
    const status = String(inst["status"] ?? "");
    const nets = inst["networkInterfaces"] as Array<Record<string, unknown>> | undefined;
    const externalIp =
      ((nets?.[0]?.["accessConfigs"] as Array<Record<string, unknown>> | undefined)?.[0]?.[
        "natIP"
      ] as string) ?? "";
    const internalIp = (nets?.[0]?.["networkIP"] as string) ?? "";

    // Extract SSH username from instance metadata ssh-keys entry
    let sshUsername = "";
    const metadataItems = (inst["metadata"] as Record<string, unknown> | undefined)?.["items"] as
      | Array<Record<string, string>>
      | undefined;
    const sshKeysEntry = metadataItems?.find((m) => m["key"] === "ssh-keys");
    if (sshKeysEntry?.["value"]) {
      // Format: "username:ssh-rsa AAAA..." — extract the username before the colon
      const firstLine = sshKeysEntry["value"].split("\n")[0] ?? "";
      const colonIdx = firstLine.indexOf(":");
      if (colonIdx > 0) sshUsername = firstLine.substring(0, colonIdx);
    }

    return {
      id: ctx.id(accountId, "gce-instance", `${p}/${zone_}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "gce-instance",
      accountId,
      displayName: name,
      fields: { name, numericId, zone: zone_, machineType, status, sshUsername },
      resolvedOutputs: { externalIp, internalIp },
      secretStates: [],
      externalId: `${p}/${zone_}/${name}`,
      createdAt: String(inst["creationTimestamp"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listGceDisks(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await paginateAggregated<Record<string, unknown>>(
    ctx,
    `https://compute.googleapis.com/compute/v1/projects/${p}/aggregated/disks`,
    "disks",
  );
  return items.map((disk) => {
    const name = String(disk["name"]);
    const zone_ = String(disk["zone"]).split("/").pop() ?? "";
    const type = String(disk["type"]).split("/").pop() ?? "";
    return {
      id: ctx.id(accountId, "gce-disk", `${p}/${zone_}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "gce-disk",
      accountId,
      displayName: name,
      fields: {
        name,
        zone: zone_,
        sizeGb: Number(disk["sizeGb"] ?? 0),
        type,
        status: String(disk["status"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${p}/${zone_}/${name}`,
      createdAt: String(disk["creationTimestamp"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listGkeClusters(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ clusters?: Record<string, unknown>[] }>(
    `https://container.googleapis.com/v1/projects/${p}/locations/-/clusters`,
  );
  return (data.clusters ?? []).map((c) => {
    const name = String(c["name"]);
    const location = String(c["location"] ?? "");
    const nodePool = (c["nodePools"] as Array<Record<string, unknown>> | undefined)?.[0];
    const nodeConfig = (nodePool?.["config"] as Record<string, unknown> | undefined) ?? {};
    const nodeCount = Number((nodePool?.["initialNodeCount"] as number | undefined) ?? 0);
    return {
      id: ctx.id(accountId, "gke-cluster", `${p}/${location}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "gke-cluster",
      accountId,
      displayName: name,
      fields: {
        name,
        location,
        version: String(c["currentMasterVersion"] ?? ""),
        machineType: String(nodeConfig["machineType"] ?? ""),
        diskSizeGb: Number(nodeConfig["diskSizeGb"] ?? 0),
        nodeCount,
        status: String(c["status"] ?? ""),
      },
      resolvedOutputs: {
        clusterEndpoint: String(c["endpoint"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: String(c["createTime"] ?? ctx.now()),
      updatedAt: String(c["updateTime"] ?? ctx.now()),
    };
  });
}

export async function listInstanceTemplates(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://compute.googleapis.com/compute/v1/projects/${p}/global/instanceTemplates`,
    "items",
  );
  return items.map((tpl) => {
    const name = String(tpl["name"]);
    const selfLink = String(tpl["selfLink"] ?? "");
    const description = String(tpl["description"] ?? "");
    const props = (tpl["properties"] as Record<string, unknown>) ?? {};
    const machineType = String(props["machineType"] ?? "");
    const disks = (props["disks"] as Array<Record<string, unknown>>) ?? [];
    const bootDisk = disks.find((d) => d["boot"] === true) ?? disks[0];
    const bootParams = (bootDisk?.["initializeParams"] as Record<string, unknown>) ?? {};
    const sourceImage =
      String(bootParams["sourceImage"] ?? "")
        .split("/")
        .pop() ?? "";
    const diskSizeGb = Number(bootParams["diskSizeGb"] ?? 0);
    return {
      id: ctx.id(accountId, "instance-template", name),
      pluginId: "gcp",
      resourceTypeId: "instance-template",
      accountId,
      displayName: name,
      fields: {
        name,
        machineType,
        sourceImage,
        diskSizeGb,
        description,
      },
      resolvedOutputs: { selfLink },
      secretStates: [],
      externalId: name,
      createdAt: String(tpl["creationTimestamp"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listInstanceGroups(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await paginateAggregated<Record<string, unknown>>(
    ctx,
    `https://compute.googleapis.com/compute/v1/projects/${p}/aggregated/instanceGroupManagers`,
    "instanceGroupManagers",
  );
  return items.map((igm) => {
    const name = String(igm["name"]);
    const zone =
      String(igm["zone"] ?? "")
        .split("/")
        .pop() ?? "";
    const region =
      String(igm["region"] ?? "")
        .split("/")
        .pop() ?? "";
    const instanceTemplate =
      String(igm["instanceTemplate"] ?? "")
        .split("/")
        .pop() ?? "";
    const igmStatus = igm["status"] as Record<string, unknown> | undefined;
    const isStable = igmStatus?.["isStable"] === true;
    const selfLink = String(igm["instanceGroup"] ?? igm["selfLink"] ?? "");
    return {
      id: ctx.id(accountId, "instance-group", `${zone || region}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "instance-group",
      accountId,
      displayName: name,
      fields: {
        name,
        zone,
        region,
        size: Number(igm["targetSize"] ?? 0),
        isManaged: true,
        targetSize: Number(igm["targetSize"] ?? 0),
        instanceTemplate,
        status: igmStatus ? (isStable ? "RUNNING" : "UPDATING") : "",
      },
      resolvedOutputs: selfLink ? { selfLink } : {},
      secretStates: [],
      externalId: `${zone || region}/${name}`,
      createdAt: String(igm["creationTimestamp"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listHealthChecks(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://compute.googleapis.com/compute/v1/projects/${p}/global/healthChecks`,
    "items",
  );
  return items.map((hc) => {
    const name = String(hc["name"]);
    const httpHc = hc["httpHealthCheck"] as Record<string, unknown> | undefined;
    const httpsHc = hc["httpsHealthCheck"] as Record<string, unknown> | undefined;
    const tcpHc = hc["tcpHealthCheck"] as Record<string, unknown> | undefined;
    let type = "TCP";
    let port = 0;
    if (httpHc) {
      type = "HTTP";
      port = Number(httpHc["port"] ?? 80);
    } else if (httpsHc) {
      type = "HTTPS";
      port = Number(httpsHc["port"] ?? 443);
    } else if (tcpHc) {
      type = "TCP";
      port = Number(tcpHc["port"] ?? 0);
    }
    const selfLink = String(hc["selfLink"] ?? "");
    return {
      id: ctx.id(accountId, "health-check", name),
      pluginId: "gcp",
      resourceTypeId: "health-check",
      accountId,
      displayName: name,
      fields: {
        name,
        type,
        port,
        checkIntervalSec: Number(hc["checkIntervalSec"] ?? 5),
        timeoutSec: Number(hc["timeoutSec"] ?? 5),
        healthyThreshold: Number(hc["healthyThreshold"] ?? 2),
        unhealthyThreshold: Number(hc["unhealthyThreshold"] ?? 2),
      },
      resolvedOutputs: selfLink ? { selfLink } : {},
      secretStates: [],
      externalId: name,
      createdAt: String(hc["creationTimestamp"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listBackendServices(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await paginateAggregated<Record<string, unknown>>(
    ctx,
    `https://compute.googleapis.com/compute/v1/projects/${p}/aggregated/backendServices`,
    "backendServices",
  );
  return items.map((bs) => {
    const name = String(bs["name"]);
    const backends = bs["backends"];
    const healthChecks = bs["healthChecks"];
    const draining = bs["connectionDraining"] as Record<string, unknown> | undefined;
    const selfLink = String(bs["selfLink"] ?? "");
    const region =
      String(bs["region"] ?? "")
        .split("/")
        .pop() ?? "";
    const externalId = `${region || "global"}/${name}`;
    return {
      id: ctx.id(accountId, "backend-service", externalId),
      pluginId: "gcp",
      resourceTypeId: "backend-service",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        description: String(bs["description"] ?? ""),
        protocol: String(bs["protocol"] ?? ""),
        port: Number(bs["port"] ?? 0),
        portName: String(bs["portName"] ?? ""),
        loadBalancingScheme: String(bs["loadBalancingScheme"] ?? ""),
        timeoutSec: Number(bs["timeoutSec"] ?? 0),
        connectionDrainingTimeoutSec: Number(draining?.["drainingTimeoutSec"] ?? 0),
        healthCheckCount: Array.isArray(healthChecks) ? healthChecks.length : 0,
        backendCount: Array.isArray(backends) ? backends.length : 0,
        enableCDN: bs["enableCDN"] === true,
        sessionAffinity: String(bs["sessionAffinity"] ?? "NONE"),
      },
      resolvedOutputs: selfLink ? { selfLink } : {},
      secretStates: [],
      externalId,
      createdAt: String(bs["creationTimestamp"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listForwardingRules(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await paginateAggregated<Record<string, unknown>>(
    ctx,
    `https://compute.googleapis.com/compute/v1/projects/${p}/aggregated/forwardingRules`,
    "forwardingRules",
  );
  return items.map((fr) => {
    const name = String(fr["name"]);
    const region =
      String(fr["region"] ?? "")
        .split("/")
        .pop() ?? "global";
    const ipAddress = String(fr["IPAddress"] ?? "");
    return {
      id: ctx.id(accountId, "forwarding-rule", `${region}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "forwarding-rule",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        IPAddress: ipAddress,
        IPProtocol: String(fr["IPProtocol"] ?? ""),
        portRange: String(fr["portRange"] ?? ""),
        target:
          String(fr["target"] ?? "")
            .split("/")
            .pop() ?? "",
        loadBalancingScheme: String(fr["loadBalancingScheme"] ?? ""),
        networkTier: String(fr["networkTier"] ?? ""),
      },
      resolvedOutputs: { IPAddress: ipAddress },
      secretStates: [],
      externalId: `${region}/${name}`,
      createdAt: String(fr["creationTimestamp"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}
