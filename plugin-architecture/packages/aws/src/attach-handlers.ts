import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { AwsCredentials } from "./auth.js";
import { ensureArray } from "./auth.js";
import { ec2Call, ec2QueryCall, hostForService } from "./client-transport.js";
import { fetchSigned } from "./signed-request.js";

const CLOUDFRONT_ALIAS_HOSTED_ZONE_ID = "Z2FDTNDATAQYW2";

interface AttachContext {
  /** Home/default creds — used only for global services. */
  creds: AwsCredentials;
  /** Build creds scoped to a specific region — use this for regional services. */
  credsFor(region: string): AwsCredentials;
  getResource(typeId: string, resourceId: string, accountId: string): Promise<ResourceInstance>;
}

export async function attachResource(
  ctx: AttachContext,
  sourceTypeId: string,
  sourceResourceId: string,
  targetTypeId: string,
  targetResourceId: string,
  accountId: string,
): Promise<void> {
  if (sourceTypeId === "elastic-ip" && targetTypeId === "ec2-instance") {
    const [ipResource, instance] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    const allocationId = String(
      ipResource.fields["allocationId"] ?? ipResource.resolvedOutputs["allocationId"] ?? "",
    );
    const instanceId = String(
      instance.fields["instanceId"] ?? instance.resolvedOutputs["instanceId"] ?? "",
    );
    if (!allocationId || !instanceId) {
      throw new Error("Cannot determine AllocationId or InstanceId for attachment");
    }
    const region = String(instance.fields["region"] ?? ctx.creds.region);
    const creds = ctx.credsFor(region);
    // Associate the Elastic IP with the EC2 instance
    await ec2Call<unknown>(creds, "AssociateAddress", {
      AllocationId: allocationId,
      InstanceId: instanceId,
    });
    return;
  }
  if (sourceTypeId === "elastic-ip" && targetTypeId === "subnet") {
    const [ipResource, subnet] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    const allocationId = String(
      ipResource.fields["allocationId"] ?? ipResource.resolvedOutputs["allocationId"] ?? "",
    );
    const subnetId = String(subnet.fields["subnetId"] ?? subnet.externalId ?? "");
    if (!allocationId || !subnetId) {
      throw new Error("Cannot determine AllocationId or SubnetId for NAT gateway creation");
    }
    const associationId = String(ipResource.fields["associationId"] ?? "");
    if (associationId) {
      throw new Error(
        "Elastic IP is already associated; disassociate it before creating a NAT gateway.",
      );
    }
    const region = String(
      subnet.fields["region"] ?? ipResource.fields["region"] ?? ctx.creds.region,
    );
    const creds = ctx.credsFor(region);
    await ec2Call<unknown>(creds, "CreateNatGateway", {
      AllocationId: allocationId,
      SubnetId: subnetId,
      ConnectivityType: "public",
    });
    return;
  }
  if (sourceTypeId === "ebs-volume" && targetTypeId === "ec2-instance") {
    const [volume, instance] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    const volumeId = String(volume.fields["volumeId"] ?? volume.externalId ?? "");
    const instanceId = String(instance.fields["instanceId"] ?? instance.externalId ?? "");
    const volumeAz = String(volume.fields["availabilityZone"] ?? "");
    const instanceAz = String(instance.fields["availabilityZone"] ?? "");
    if (!volumeId || !instanceId) {
      throw new Error("Cannot determine VolumeId or InstanceId for attachment");
    }
    if (volumeAz && instanceAz && volumeAz !== instanceAz) {
      throw new Error(
        `Volume AZ ${volumeAz} does not match instance AZ ${instanceAz} — EBS volumes must be in the same AZ as the instance.`,
      );
    }
    const region = String(instance.fields["region"] ?? ctx.creds.region);
    const creds = ctx.credsFor(region);
    // Pick the first free device letter after /dev/sdf (sdf..sdp is the conventional range)
    const device = "/dev/sdf";
    await ec2Call(creds, "AttachVolume", {
      VolumeId: volumeId,
      InstanceId: instanceId,
      Device: device,
    });
    return;
  }
  if (sourceTypeId === "security-group" && targetTypeId === "ec2-instance") {
    const [sg, instance] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    const sgId = String(sg.fields["groupId"] ?? sg.externalId ?? "");
    const instanceId = String(instance.fields["instanceId"] ?? instance.externalId ?? "");
    if (!sgId || !instanceId) {
      throw new Error("Cannot determine security group or instance id for attachment");
    }
    const region = String(instance.fields["region"] ?? ctx.creds.region);
    const creds = ctx.credsFor(region);
    // Fetch the instance's current SG IDs so we don't overwrite existing ones.
    const describeRes = await ec2Call<Record<string, unknown>>(creds, "DescribeInstances", {
      "InstanceId.1": instanceId,
    });
    const reservations = ensureArray(
      (describeRes["reservationSet"] as Record<string, unknown> | undefined)?.["item"],
    ) as Record<string, unknown>[];
    const inst = ensureArray(
      (reservations[0]?.["instancesSet"] as Record<string, unknown> | undefined)?.["item"],
    )[0] as Record<string, unknown> | undefined;
    const currentGroups = ensureArray(
      (inst?.["groupSet"] as Record<string, unknown> | undefined)?.["item"],
    ) as Record<string, unknown>[];
    const current = currentGroups.map((g) => String(g["groupId"] ?? "")).filter(Boolean);
    if (current.includes(sgId)) return;
    const next = [...current, sgId];
    const params: Record<string, string> = { InstanceId: instanceId };
    next.forEach((g, i) => {
      params[`GroupId.${i + 1}`] = g;
    });
    await ec2Call(creds, "ModifyInstanceAttribute", params);
    return;
  }
  if (sourceTypeId === "target-group" && targetTypeId === "ec2-instance") {
    const [targetGroup, instance] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    const targetGroupArn = String(
      targetGroup.fields["targetGroupArn"] ??
        targetGroup.resolvedOutputs["targetGroupArn"] ??
        targetGroup.externalId ??
        "",
    );
    const instanceId = String(instance.fields["instanceId"] ?? instance.externalId ?? "");
    if (!targetGroupArn || !instanceId) {
      throw new Error("Cannot determine TargetGroupArn or InstanceId for target registration");
    }
    const targetType = String(targetGroup.fields["targetType"] ?? "instance");
    if (targetType && targetType !== "instance") {
      throw new Error(`Target group target type ${targetType} cannot register EC2 instances`);
    }
    const targetVpcId = String(targetGroup.fields["vpcId"] ?? "");
    const instanceVpcId = String(instance.fields["vpcId"] ?? "");
    if (targetVpcId && instanceVpcId && targetVpcId !== instanceVpcId) {
      throw new Error(
        `Target group VPC ${targetVpcId} does not match instance VPC ${instanceVpcId}.`,
      );
    }
    const region = String(
      instance.fields["region"] ?? targetGroup.fields["region"] ?? ctx.creds.region,
    );
    const creds = ctx.credsFor(region);
    await ec2QueryCall(creds, "elasticloadbalancing", "RegisterTargets", "2015-12-01", {
      TargetGroupArn: targetGroupArn,
      "Targets.member.1.Id": instanceId,
    });
    return;
  }
  if (sourceTypeId === "internet-gateway" && targetTypeId === "vpc") {
    const [gateway, vpc] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    const gatewayId = String(gateway.fields["internetGatewayId"] ?? gateway.externalId ?? "");
    const vpcId = String(vpc.fields["vpcId"] ?? vpc.externalId ?? "");
    if (!gatewayId || !vpcId) {
      throw new Error("Cannot determine InternetGatewayId or VpcId for attachment");
    }
    if (String(gateway.fields["vpcId"] ?? "") === vpcId) return;
    const region = String(vpc.fields["region"] ?? gateway.fields["region"] ?? ctx.creds.region);
    const creds = ctx.credsFor(region);
    await ec2Call(creds, "AttachInternetGateway", {
      InternetGatewayId: gatewayId,
      VpcId: vpcId,
    });
    return;
  }
  if (sourceTypeId === "route-table" && targetTypeId === "subnet") {
    const [routeTable, subnet] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    const routeTableId = String(routeTable.fields["routeTableId"] ?? routeTable.externalId ?? "");
    const subnetId = String(subnet.fields["subnetId"] ?? subnet.externalId ?? "");
    if (!routeTableId || !subnetId) {
      throw new Error("Cannot determine RouteTableId or SubnetId for association");
    }
    assertVpcMatch(routeTable, subnet, "Route table", "subnet");
    const region = String(
      subnet.fields["region"] ?? routeTable.fields["region"] ?? ctx.creds.region,
    );
    const creds = ctx.credsFor(region);
    await ec2Call(creds, "AssociateRouteTable", {
      RouteTableId: routeTableId,
      SubnetId: subnetId,
    });
    return;
  }
  if (sourceTypeId === "internet-gateway" && targetTypeId === "route-table") {
    const [gateway, routeTable] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    const gatewayId = String(gateway.fields["internetGatewayId"] ?? gateway.externalId ?? "");
    const routeTableId = String(routeTable.fields["routeTableId"] ?? routeTable.externalId ?? "");
    if (!gatewayId || !routeTableId) {
      throw new Error("Cannot determine InternetGatewayId or RouteTableId for route creation");
    }
    assertVpcMatch(gateway, routeTable, "Internet gateway", "route table");
    const region = String(
      routeTable.fields["region"] ?? gateway.fields["region"] ?? ctx.creds.region,
    );
    const creds = ctx.credsFor(region);
    await upsertDefaultRoute(creds, routeTableId, { GatewayId: gatewayId });
    return;
  }
  if (sourceTypeId === "nat-gateway" && targetTypeId === "route-table") {
    const [gateway, routeTable] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    const gatewayId = String(gateway.fields["natGatewayId"] ?? gateway.externalId ?? "");
    const routeTableId = String(routeTable.fields["routeTableId"] ?? routeTable.externalId ?? "");
    if (!gatewayId || !routeTableId) {
      throw new Error("Cannot determine NatGatewayId or RouteTableId for route creation");
    }
    assertVpcMatch(gateway, routeTable, "NAT gateway", "route table");
    const region = String(
      routeTable.fields["region"] ?? gateway.fields["region"] ?? ctx.creds.region,
    );
    const creds = ctx.credsFor(region);
    await upsertDefaultRoute(creds, routeTableId, { NatGatewayId: gatewayId });
    return;
  }
  if (sourceTypeId === "auto-scaling-group" && targetTypeId === "target-group") {
    const [asg, targetGroup] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    const asgName = String(asg.fields["name"] ?? asg.externalId ?? "");
    const targetGroupArn = String(
      targetGroup.resolvedOutputs["targetGroupArn"] ??
        targetGroup.fields["targetGroupArn"] ??
        targetGroup.externalId ??
        "",
    );
    if (!asgName || !targetGroupArn) {
      throw new Error("Cannot determine AutoScalingGroupName or TargetGroupARN for attachment");
    }
    const region = String(asg.fields["region"] ?? targetGroup.fields["region"] ?? ctx.creds.region);
    const creds = ctx.credsFor(region);
    await ec2QueryCall(creds, "autoscaling", "AttachLoadBalancerTargetGroups", "2011-01-01", {
      AutoScalingGroupName: asgName,
      "TargetGroupARNs.member.1": targetGroupArn,
    });
    return;
  }
  if (sourceTypeId === "route53-record-set" && targetTypeId === "alb") {
    const [record, loadBalancer] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    const hostedZoneId = String(record.fields["hostedZoneId"] ?? "");
    const recordName = String(record.fields["name"] ?? "");
    const recordType = String(record.fields["type"] ?? "A");
    const lbDnsName = String(loadBalancer.resolvedOutputs["dnsName"] ?? "");
    const lbZoneId = String(loadBalancer.resolvedOutputs["canonicalHostedZoneId"] ?? "");
    if (!hostedZoneId || !recordName || !lbDnsName || !lbZoneId) {
      throw new Error("Cannot determine Route53 record or load balancer alias target");
    }
    if (recordType !== "A" && recordType !== "AAAA") {
      throw new Error(
        `Route53 alias records to load balancers must be A or AAAA, got ${recordType}`,
      );
    }
    await upsertRoute53Alias(ctx.creds, hostedZoneId, recordName, recordType, lbZoneId, lbDnsName);
    return;
  }
  if (sourceTypeId === "route53-record-set" && targetTypeId === "cloudfront-distribution") {
    const [record, distribution] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    const hostedZoneId = String(record.fields["hostedZoneId"] ?? "");
    const recordName = String(record.fields["name"] ?? "");
    const recordType = String(record.fields["type"] ?? "A");
    const distributionDomainName = String(distribution.fields["domainName"] ?? "");
    if (!hostedZoneId || !recordName || !distributionDomainName) {
      throw new Error("Cannot determine Route53 record or CloudFront alias target");
    }
    if (recordType !== "A" && recordType !== "AAAA") {
      throw new Error(
        `Route53 alias records to CloudFront distributions must be A or AAAA, got ${recordType}`,
      );
    }
    await upsertRoute53Alias(
      ctx.creds,
      hostedZoneId,
      recordName,
      recordType,
      CLOUDFRONT_ALIAS_HOSTED_ZONE_ID,
      distributionDomainName,
    );
    return;
  }
  throw new Error(`AWS plugin: attachResource not supported for ${sourceTypeId} → ${targetTypeId}`);
}

function assertVpcMatch(
  source: ResourceInstance,
  target: ResourceInstance,
  sourceLabel: string,
  targetLabel: string,
): void {
  const sourceVpcId = String(source.fields["vpcId"] ?? "");
  const targetVpcId = String(target.fields["vpcId"] ?? "");
  if (sourceVpcId && targetVpcId && sourceVpcId !== targetVpcId) {
    throw new Error(
      `${sourceLabel} VPC ${sourceVpcId} does not match ${targetLabel} VPC ${targetVpcId}.`,
    );
  }
}

async function upsertDefaultRoute(
  creds: AwsCredentials,
  routeTableId: string,
  target: { GatewayId: string } | { NatGatewayId: string },
): Promise<void> {
  const params = {
    RouteTableId: routeTableId,
    DestinationCidrBlock: "0.0.0.0/0",
    ...target,
  };
  try {
    await ec2Call(creds, "CreateRoute", params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/RouteAlreadyExists|InvalidRoute\.Duplicate/i.test(message)) throw error;
    await ec2Call(creds, "ReplaceRoute", params);
  }
}

async function upsertRoute53Alias(
  creds: AwsCredentials,
  hostedZoneId: string,
  recordName: string,
  recordType: string,
  aliasHostedZoneId: string,
  aliasDnsName: string,
): Promise<void> {
  const host = hostForService(creds, "route53");
  const url = `https://${host}/2013-04-01/hostedzone/${hostedZoneId}/rrset`;
  const bodyXml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">`,
    `<ChangeBatch><Changes><Change>`,
    `<Action>UPSERT</Action>`,
    `<ResourceRecordSet>`,
    `<Name>${xmlEscape(recordName)}</Name>`,
    `<Type>${xmlEscape(recordType)}</Type>`,
    `<AliasTarget>`,
    `<HostedZoneId>${xmlEscape(aliasHostedZoneId)}</HostedZoneId>`,
    `<DNSName>${xmlEscape(aliasDnsName)}</DNSName>`,
    `<EvaluateTargetHealth>false</EvaluateTargetHealth>`,
    `</AliasTarget>`,
    `</ResourceRecordSet>`,
    `</Change></Changes></ChangeBatch>`,
    `</ChangeResourceRecordSetsRequest>`,
  ].join("");
  await fetchSigned({
    method: "POST",
    url,
    headers: { Host: host, "Content-Type": "application/xml" },
    body: bodyXml,
    service: "route53",
    credentials: creds,
  });
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
