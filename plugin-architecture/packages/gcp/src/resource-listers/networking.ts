import type { ResourceInstance } from "@infrawrench/plugin-base";
import { paginateAggregated, type ListerContext } from "./shared.js";

export async function listVpcNetworks(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://compute.googleapis.com/compute/v1/projects/${p}/global/networks`,
    "items",
  );
  return items.map((net) => {
    const name = String(net["name"]);
    const selfLink = String(
      net["selfLink"] ??
        `https://compute.googleapis.com/compute/v1/projects/${p}/global/networks/${name}`,
    );
    const subnetCount = (net["subnetworks"] as unknown[] | undefined)?.length ?? 0;
    return {
      id: ctx.id(accountId, "vpc-network", `${p}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "vpc-network",
      accountId,
      displayName: name,
      fields: {
        name,
        description: String(net["description"] ?? ""),
        autoCreateSubnetworks: Boolean(net["autoCreateSubnetworks"]),
        mtu: Number(net["mtu"] ?? 1460),
        subnetCount,
      },
      resolvedOutputs: { selfLink },
      secretStates: [],
      externalId: `${p}/${name}`,
      createdAt: String(net["creationTimestamp"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listFirewallRules(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://compute.googleapis.com/compute/v1/projects/${p}/global/firewalls`,
    "items",
  );
  return items.map((fw) => {
    const name = String(fw["name"]);
    const network =
      String(fw["network"] ?? "")
        .split("/")
        .pop() ?? "";
    const direction = String(fw["direction"] ?? "");
    const priority = Number(fw["priority"] ?? 1000);
    const disabled = fw["disabled"] === true;
    const sourceRanges = Array.isArray(fw["sourceRanges"])
      ? (fw["sourceRanges"] as string[]).join(", ")
      : "";
    const destinationRanges = Array.isArray(fw["destinationRanges"])
      ? (fw["destinationRanges"] as string[]).join(", ")
      : "";
    const allowed = Array.isArray(fw["allowed"])
      ? (fw["allowed"] as Array<Record<string, unknown>>)
          .map((a) => {
            const proto = String(a["IPProtocol"] ?? "");
            const ports = Array.isArray(a["ports"]) ? (a["ports"] as string[]).join(",") : "";
            return ports ? `${proto}:${ports}` : proto;
          })
          .join("; ")
      : "";
    const denied = Array.isArray(fw["denied"])
      ? (fw["denied"] as Array<Record<string, unknown>>)
          .map((d) => {
            const proto = String(d["IPProtocol"] ?? "");
            const ports = Array.isArray(d["ports"]) ? (d["ports"] as string[]).join(",") : "";
            return ports ? `${proto}:${ports}` : proto;
          })
          .join("; ")
      : "";
    const action = allowed ? "ALLOW" : denied ? "DENY" : "";
    return {
      id: ctx.id(accountId, "firewall-rule", name),
      pluginId: "gcp",
      resourceTypeId: "firewall-rule",
      accountId,
      displayName: name,
      fields: {
        name,
        network,
        direction,
        priority,
        action,
        sourceRanges,
        destinationRanges,
        allowed,
        denied,
        disabled,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: String(fw["creationTimestamp"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listSubnets(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await paginateAggregated<Record<string, unknown>>(
    ctx,
    `https://compute.googleapis.com/compute/v1/projects/${p}/aggregated/subnetworks`,
    "subnetworks",
  );
  return items.map((sub) => {
    const name = String(sub["name"]);
    const region =
      String(sub["region"] ?? "")
        .split("/")
        .pop() ?? "";
    const network =
      String(sub["network"] ?? "")
        .split("/")
        .pop() ?? "";
    return {
      id: ctx.id(accountId, "subnet", `${region}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "subnet",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        network,
        ipCidrRange: String(sub["ipCidrRange"] ?? ""),
        gatewayAddress: String(sub["gatewayAddress"] ?? ""),
        privateIpGoogleAccess: sub["privateIpGoogleAccess"] === true,
        purpose: String(sub["purpose"] ?? "PRIVATE"),
        stackType: String(sub["stackType"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${region}/${name}`,
      createdAt: String(sub["creationTimestamp"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listStaticIps(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await paginateAggregated<Record<string, unknown>>(
    ctx,
    `https://compute.googleapis.com/compute/v1/projects/${p}/aggregated/addresses`,
    "addresses",
  );
  return items.map((addr) => {
    const name = String(addr["name"]);
    const region =
      String(addr["region"] ?? "")
        .split("/")
        .pop() ?? "";
    const address = String(addr["address"] ?? "");
    return {
      id: ctx.id(accountId, "static-ip", `${region}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "static-ip",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        address,
        addressType: String(addr["addressType"] ?? ""),
        status: String(addr["status"] ?? ""),
        networkTier: String(addr["networkTier"] ?? ""),
        ipVersion: String(addr["ipVersion"] ?? "IPV4"),
      },
      resolvedOutputs: { address },
      secretStates: [],
      externalId: `${region}/${name}`,
      createdAt: String(addr["creationTimestamp"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listCloudRouters(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await paginateAggregated<Record<string, unknown>>(
    ctx,
    `https://compute.googleapis.com/compute/v1/projects/${p}/aggregated/routers`,
    "routers",
  );
  return items.map((router) => {
    const name = String(router["name"]);
    const region =
      String(router["region"] ?? "")
        .split("/")
        .pop() ?? "";
    const network =
      String(router["network"] ?? "")
        .split("/")
        .pop() ?? "";
    const selfLink = String(
      router["selfLink"] ??
        `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/routers/${name}`,
    );
    const bgp = router["bgp"] as Record<string, unknown> | undefined;
    const nats = router["nats"] as unknown[] | undefined;
    return {
      id: ctx.id(accountId, "cloud-router", `${region}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "cloud-router",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        network,
        bgpAsn: Number(bgp?.["asn"] ?? 0),
        natCount: Array.isArray(nats) ? nats.length : 0,
      },
      resolvedOutputs: { selfLink },
      secretStates: [],
      externalId: `${region}/${name}`,
      createdAt: String(router["creationTimestamp"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listCloudNats(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const routers = await paginateAggregated<Record<string, unknown>>(
    ctx,
    `https://compute.googleapis.com/compute/v1/projects/${p}/aggregated/routers`,
    "routers",
  );
  const results: ResourceInstance[] = [];
  for (const router of routers) {
    const routerName = String(router["name"]);
    const region =
      String(router["region"] ?? "")
        .split("/")
        .pop() ?? "";
    const nats = router["nats"] as Array<Record<string, unknown>> | undefined;
    if (!nats) continue;
    for (const nat of nats) {
      const natName = String(nat["name"]);
      results.push({
        id: ctx.id(accountId, "cloud-nat", `${region}/${routerName}/${natName}`),
        pluginId: "gcp",
        resourceTypeId: "cloud-nat",
        accountId,
        displayName: natName,
        fields: {
          name: natName,
          region,
          router: routerName,
          natIpAllocateOption: String(nat["natIpAllocateOption"] ?? ""),
          sourceSubnetworkIpRangesToNat: String(nat["sourceSubnetworkIpRangesToNat"] ?? ""),
          status: "ACTIVE",
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: `${region}/${routerName}/${natName}`,
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
      });
    }
  }
  return results;
}

export async function listSslCertificates(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://compute.googleapis.com/compute/v1/projects/${p}/global/sslCertificates`,
    "items",
  );
  return items.map((cert) => {
    const name = String(cert["name"]);
    const managed = cert["managed"] as Record<string, unknown> | undefined;
    const domains = managed?.["domains"] as string[] | undefined;
    const status = managed?.["status"] as string | undefined;
    return {
      id: ctx.id(accountId, "ssl-certificate", name),
      pluginId: "gcp",
      resourceTypeId: "ssl-certificate",
      accountId,
      displayName: name,
      fields: {
        name,
        type: String(cert["type"] ?? "SELF_MANAGED"),
        status: status ?? "ACTIVE",
        domains: domains?.join(", ") ?? "",
        expireTime: String(cert["expireTime"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: String(cert["creationTimestamp"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}
