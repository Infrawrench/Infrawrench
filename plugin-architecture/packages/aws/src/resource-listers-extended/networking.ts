import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ensureArray } from "../xml.js";
import { joinIds, type ListerContext } from "../resource-listers.js";

export async function listALBs(ctx: ListerContext, accountId: string): Promise<ResourceInstance[]> {
  const data = await ctx.ec2Query<Record<string, unknown>>(
    "elasticloadbalancing",
    "DescribeLoadBalancers",
    "2015-12-01",
  );
  const lbs = ensureArray(
    (data["LoadBalancers"] as Record<string, unknown> | undefined)?.["member"],
  ) as Record<string, unknown>[];

  return lbs.map((lb) => {
    const name = String(lb["LoadBalancerName"] ?? "");
    const azs = ensureArray(
      (lb["AvailabilityZones"] as Record<string, unknown> | undefined)?.["member"],
    ) as Record<string, unknown>[];
    const azNames = azs.map((az) => String(az["ZoneName"] ?? "")).join(", ");
    const stateObj = lb["State"] as Record<string, unknown> | undefined;
    // Each availability zone entry names the subnet the load balancer has an
    // interface in, so the subnet links come out of the same payload as the AZs.
    const subnetIds = joinIds(azs.map((az) => az["SubnetId"]));
    const securityGroupIds = joinIds(
      ensureArray((lb["SecurityGroups"] as Record<string, unknown> | undefined)?.["member"]),
    );

    return {
      id: ctx.id(accountId, "alb", name),
      pluginId: "aws",
      resourceTypeId: "alb",
      accountId,
      displayName: name,
      fields: {
        name,
        region: ctx.region,
        type: String(lb["Type"] ?? "application"),
        state: String(stateObj?.["Code"] ?? "active"),
        scheme: String(lb["Scheme"] ?? ""),
        vpcId: String(lb["VpcId"] ?? ""),
        availabilityZones: azNames,
        ipAddressType: String(lb["IpAddressType"] ?? ""),
        subnetIds,
        securityGroupIds,
      },
      resolvedOutputs: {
        dnsName: String(lb["DNSName"] ?? ""),
        loadBalancerArn: String(lb["LoadBalancerArn"] ?? ""),
        canonicalHostedZoneId: String(lb["CanonicalHostedZoneId"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: String(lb["CreatedTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listTargetGroups(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.ec2Query<Record<string, unknown>>(
    "elasticloadbalancing",
    "DescribeTargetGroups",
    "2015-12-01",
  );
  const tgs = ensureArray(
    (data["TargetGroups"] as Record<string, unknown> | undefined)?.["member"],
  ) as Record<string, unknown>[];

  return tgs.map((tg) => {
    const name = String(tg["TargetGroupName"] ?? "");
    // A target group can be attached to more than one load balancer; the
    // ARNs are on the describe response already.
    const loadBalancerArns = joinIds(
      ensureArray((tg["LoadBalancerArns"] as Record<string, unknown> | undefined)?.["member"]),
    );
    return {
      id: ctx.id(accountId, "target-group", name),
      pluginId: "aws",
      resourceTypeId: "target-group",
      accountId,
      displayName: name,
      fields: {
        name,
        region: ctx.region,
        protocol: String(tg["Protocol"] ?? ""),
        port: Number(tg["Port"] ?? 0),
        targetType: String(tg["TargetType"] ?? "instance"),
        vpcId: String(tg["VpcId"] ?? ""),
        healthCheckProtocol: String(tg["HealthCheckProtocol"] ?? ""),
        healthCheckPath: String(tg["HealthCheckPath"] ?? ""),
        healthyThreshold: Number(tg["HealthyThresholdCount"] ?? 0),
        loadBalancerArns,
      },
      resolvedOutputs: {
        targetGroupArn: String(tg["TargetGroupArn"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listSecurityGroups(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.ec2<Record<string, unknown>>("DescribeSecurityGroups");
  const groups = ensureArray(
    (data["securityGroupInfo"] as Record<string, unknown> | undefined)?.["item"],
  ) as Record<string, unknown>[];

  return groups.map((sg) => {
    const groupId = String(sg["groupId"] ?? "");
    const inboundRules = ensureArray(
      (sg["ipPermissions"] as Record<string, unknown> | undefined)?.["item"],
    );
    const outboundRules = ensureArray(
      (sg["ipPermissionsEgress"] as Record<string, unknown> | undefined)?.["item"],
    );

    return {
      id: ctx.id(accountId, "security-group", groupId),
      pluginId: "aws",
      resourceTypeId: "security-group",
      accountId,
      displayName: String(sg["groupName"] ?? groupId),
      fields: {
        groupId,
        region: ctx.region,
        groupName: String(sg["groupName"] ?? ""),
        description: String(sg["groupDescription"] ?? ""),
        vpcId: String(sg["vpcId"] ?? ""),
        inboundRuleCount: inboundRules.length,
        outboundRuleCount: outboundRules.length,
      },
      resolvedOutputs: { groupId },
      secretStates: [],
      externalId: groupId,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listSubnets(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.ec2<Record<string, unknown>>("DescribeSubnets");
  const subnets = ensureArray(
    (data["subnetSet"] as Record<string, unknown> | undefined)?.["item"],
  ) as Record<string, unknown>[];

  return subnets.map((sub) => {
    const subnetId = String(sub["subnetId"] ?? "");
    const tagSet = sub["tagSet"] as Record<string, unknown> | undefined;
    const tags = ensureArray(tagSet?.["item"]) as Record<string, unknown>[];
    const nameTag = tags.find((t) => t["key"] === "Name");
    const name = nameTag ? String(nameTag["value"] ?? "") : "";

    return {
      id: ctx.id(accountId, "subnet", subnetId),
      pluginId: "aws",
      resourceTypeId: "subnet",
      accountId,
      displayName: name || subnetId,
      fields: {
        subnetId,
        name,
        region: ctx.region,
        vpcId: String(sub["vpcId"] ?? ""),
        cidrBlock: String(sub["cidrBlock"] ?? ""),
        availabilityZone: String(sub["availabilityZone"] ?? ""),
        state: String(sub["state"] ?? ""),
        availableIps: Number(sub["availableIpAddressCount"] ?? 0),
        mapPublicIp: String(sub["mapPublicIpOnLaunch"]) === "true",
      },
      resolvedOutputs: {
        subnetArn: String(sub["subnetArn"] ?? ""),
      },
      secretStates: [],
      externalId: subnetId,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listRouteTables(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.ec2<Record<string, unknown>>("DescribeRouteTables");
  const routeTables = ensureArray(
    (data["routeTableSet"] as Record<string, unknown> | undefined)?.["item"],
  ) as Record<string, unknown>[];

  return routeTables.map((rt) => {
    const routeTableId = String(rt["routeTableId"] ?? "");
    const tagSet = rt["tagSet"] as Record<string, unknown> | undefined;
    const tags = ensureArray(tagSet?.["item"]) as Record<string, unknown>[];
    const nameTag = tags.find((t) => t["key"] === "Name");
    const name = nameTag ? String(nameTag["value"] ?? "") : "";
    const routes = ensureArray(
      (rt["routeSet"] as Record<string, unknown> | undefined)?.["item"],
    ) as Record<string, unknown>[];
    const associations = ensureArray(
      (rt["associationSet"] as Record<string, unknown> | undefined)?.["item"],
    ) as Record<string, unknown>[];
    const main = associations.some((assoc) => String(assoc["main"] ?? "") === "true");
    // `routeCount` stays as-is; these name the gateways the routes actually
    // point at. `gatewayId` also carries "local" and `vpce-…` endpoint ids,
    // so only the internet-gateway ids are kept.
    const natGatewayIds = joinIds(routes.map((route) => route["natGatewayId"]));
    const internetGatewayIds = joinIds(
      routes
        .map((route) => String(route["gatewayId"] ?? ""))
        .filter((gatewayId) => gatewayId.startsWith("igw-")),
    );

    return {
      id: ctx.id(accountId, "route-table", routeTableId),
      pluginId: "aws",
      resourceTypeId: "route-table",
      accountId,
      displayName: name || routeTableId,
      fields: {
        routeTableId,
        name,
        region: ctx.region,
        vpcId: String(rt["vpcId"] ?? ""),
        main,
        routeCount: routes.length,
        associationCount: associations.length,
        natGatewayIds,
        internetGatewayIds,
      },
      resolvedOutputs: { routeTableId },
      secretStates: [],
      externalId: routeTableId,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listNATGateways(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.ec2<Record<string, unknown>>("DescribeNatGateways");
  const gateways = ensureArray(
    (data["natGatewaySet"] as Record<string, unknown> | undefined)?.["item"],
  ) as Record<string, unknown>[];

  return gateways.map((nat) => {
    const natGatewayId = String(nat["natGatewayId"] ?? "");
    const addresses = ensureArray(
      (nat["natGatewayAddressSet"] as Record<string, unknown> | undefined)?.["item"],
    ) as Record<string, unknown>[];
    const addr = addresses[0];

    return {
      id: ctx.id(accountId, "nat-gateway", natGatewayId),
      pluginId: "aws",
      resourceTypeId: "nat-gateway",
      accountId,
      displayName: natGatewayId,
      fields: {
        natGatewayId,
        region: ctx.region,
        state: String(nat["state"] ?? ""),
        subnetId: String(nat["subnetId"] ?? ""),
        vpcId: String(nat["vpcId"] ?? ""),
        connectivityType: String(nat["connectivityType"] ?? "public"),
        publicIp: addr ? String(addr["publicIp"] ?? "") : "",
        privateIp: addr ? String(addr["privateIp"] ?? "") : "",
      },
      resolvedOutputs: { natGatewayId },
      secretStates: [],
      externalId: natGatewayId,
      createdAt: String(nat["createTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listElasticIPs(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.ec2<Record<string, unknown>>("DescribeAddresses");
  const addresses = ensureArray(
    (data["addressesSet"] as Record<string, unknown> | undefined)?.["item"],
  ) as Record<string, unknown>[];

  return addresses.map((addr) => {
    const allocationId = String(addr["allocationId"] ?? "");
    const publicIp = String(addr["publicIp"] ?? "");

    return {
      id: ctx.id(accountId, "elastic-ip", allocationId),
      pluginId: "aws",
      resourceTypeId: "elastic-ip",
      accountId,
      displayName: publicIp || allocationId,
      fields: {
        allocationId,
        publicIp,
        region: ctx.region,
        associationId: String(addr["associationId"] ?? ""),
        instanceId: String(addr["instanceId"] ?? ""),
        networkInterfaceId: String(addr["networkInterfaceId"] ?? ""),
        domain: String(addr["domain"] ?? ""),
      },
      resolvedOutputs: { publicIp },
      secretStates: [],
      externalId: allocationId,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listInternetGateways(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.ec2<Record<string, unknown>>("DescribeInternetGateways");
  const gateways = ensureArray(
    (data["internetGatewaySet"] as Record<string, unknown> | undefined)?.["item"],
  ) as Record<string, unknown>[];

  return gateways.map((igw) => {
    const igwId = String(igw["internetGatewayId"] ?? "");
    const attachments = ensureArray(
      (igw["attachmentSet"] as Record<string, unknown> | undefined)?.["item"],
    ) as Record<string, unknown>[];
    const attachment = attachments[0];

    return {
      id: ctx.id(accountId, "internet-gateway", igwId),
      pluginId: "aws",
      resourceTypeId: "internet-gateway",
      accountId,
      displayName: igwId,
      fields: {
        internetGatewayId: igwId,
        region: ctx.region,
        vpcId: attachment ? String(attachment["vpcId"] ?? "") : "",
        state: attachment ? String(attachment["state"] ?? "") : "detached",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: igwId,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}
