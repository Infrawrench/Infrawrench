//
// Additional AWS resource types beyond the original set.

import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ensureArray } from "./auth.js";
import type { ListerContext } from "./resource-listers.js";

export async function listRoute53HostedZones(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.jsonGet<{
    HostedZones?: Array<Record<string, unknown>>;
  }>("route53", "/2013-04-01/hostedzone");
  const zones = data.HostedZones ?? [];
  return zones.map((zone) => {
    const id = String(zone["Id"] ?? "").replace("/hostedzone/", "");
    const name = String(zone["Name"] ?? "");
    const config = zone["Config"] as Record<string, unknown> | undefined;
    return {
      id: ctx.id(accountId, "route53-hosted-zone", id),
      pluginId: "aws",
      resourceTypeId: "route53-hosted-zone",
      accountId,
      displayName: name,
      fields: {
        name,
        hostedZoneId: id,
        recordCount: Number(zone["ResourceRecordSetCount"] ?? 0),
        isPrivate: config?.["PrivateZone"] === true || config?.["PrivateZone"] === "true",
        comment: String(config?.["Comment"] ?? ""),
      },
      resolvedOutputs: {
        hostedZoneId: id,
        nameServers: "",
      },
      secretStates: [],
      externalId: id,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listRoute53RecordSets(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  // First list hosted zones, then records in each
  const zones = await listRoute53HostedZones(ctx, accountId);
  const results: ResourceInstance[] = [];

  for (const zone of zones) {
    const zoneId = zone.externalId ?? "";
    try {
      const data = await ctx.jsonGet<{
        ResourceRecordSets?: Array<Record<string, unknown>>;
      }>("route53", `/2013-04-01/hostedzone/${zoneId}/rrset`);
      const records = data.ResourceRecordSets ?? [];
      for (const record of records) {
        const name = String(record["Name"] ?? "");
        const type = String(record["Type"] ?? "");
        const recordId = `${zoneId}:${name}:${type}`;
        const resourceRecords = record["ResourceRecords"] as
          | Array<Record<string, string>>
          | undefined;
        const values = resourceRecords?.map((r) => String(r["Value"] ?? "")).join(", ") ?? "";

        results.push({
          id: ctx.id(accountId, "route53-record-set", recordId),
          pluginId: "aws",
          resourceTypeId: "route53-record-set",
          accountId,
          displayName: `${name} (${type})`,
          fields: {
            name,
            type,
            ttl: Number(record["TTL"] ?? 0),
            values,
            hostedZoneId: zoneId,
          },
          resolvedOutputs: {},
          secretStates: [],
          externalId: recordId,
          createdAt: ctx.now(),
          updatedAt: ctx.now(),
        });
      }
    } catch {
      // Skip zones we can't list records for
    }
  }
  return results;
}

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

    return {
      id: ctx.id(accountId, "alb", name),
      pluginId: "aws",
      resourceTypeId: "alb",
      accountId,
      displayName: name,
      fields: {
        name,
        type: String(lb["Type"] ?? "application"),
        state: String(stateObj?.["Code"] ?? "active"),
        scheme: String(lb["Scheme"] ?? ""),
        vpcId: String(lb["VpcId"] ?? ""),
        availabilityZones: azNames,
        ipAddressType: String(lb["IpAddressType"] ?? ""),
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
    return {
      id: ctx.id(accountId, "target-group", name),
      pluginId: "aws",
      resourceTypeId: "target-group",
      accountId,
      displayName: name,
      fields: {
        name,
        protocol: String(tg["Protocol"] ?? ""),
        port: Number(tg["Port"] ?? 0),
        targetType: String(tg["TargetType"] ?? "instance"),
        vpcId: String(tg["VpcId"] ?? ""),
        healthCheckProtocol: String(tg["HealthCheckProtocol"] ?? ""),
        healthCheckPath: String(tg["HealthCheckPath"] ?? ""),
        healthyThreshold: Number(tg["HealthyThresholdCount"] ?? 0),
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

export async function listAutoScalingGroups(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.ec2Query<Record<string, unknown>>(
    "autoscaling",
    "DescribeAutoScalingGroups",
    "2011-01-01",
  );
  const groups = ensureArray(
    (data["AutoScalingGroups"] as Record<string, unknown> | undefined)?.["member"],
  ) as Record<string, unknown>[];

  return groups.map((asg) => {
    const name = String(asg["AutoScalingGroupName"] ?? "");
    const azs = ensureArray(
      (asg["AvailabilityZones"] as Record<string, unknown> | undefined)?.["member"],
    ) as string[];
    const instances = ensureArray(
      (asg["Instances"] as Record<string, unknown> | undefined)?.["member"],
    ) as unknown[];
    const launchTemplate = asg["LaunchTemplate"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "auto-scaling-group", name),
      pluginId: "aws",
      resourceTypeId: "auto-scaling-group",
      accountId,
      displayName: name,
      fields: {
        name,
        minSize: Number(asg["MinSize"] ?? 0),
        maxSize: Number(asg["MaxSize"] ?? 0),
        desiredCapacity: Number(asg["DesiredCapacity"] ?? 0),
        status: String(asg["Status"] ?? ""),
        healthCheckType: String(asg["HealthCheckType"] ?? ""),
        availabilityZones: azs.join(", "),
        launchTemplate: launchTemplate
          ? `${launchTemplate["LaunchTemplateName"]}@${launchTemplate["Version"]}`
          : "",
        instanceCount: instances.length,
      },
      resolvedOutputs: {
        autoScalingGroupArn: String(asg["AutoScalingGroupARN"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: String(asg["CreatedTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listIAMRoles(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ Roles?: Record<string, unknown>[] }>(
    "iam",
    "AWSIdentityManagementService.ListRoles",
    {},
  );
  const roles = data.Roles ?? [];
  return roles.map((r) => {
    const roleName = String(r["RoleName"] ?? "");
    return {
      id: ctx.id(accountId, "iam-role", roleName),
      pluginId: "aws",
      resourceTypeId: "iam-role",
      accountId,
      displayName: roleName,
      fields: {
        roleName,
        roleId: String(r["RoleId"] ?? ""),
        path: String(r["Path"] ?? "/"),
        createDate: String(r["CreateDate"] ?? ""),
        description: String(r["Description"] ?? ""),
        maxSessionDuration: Number(r["MaxSessionDuration"] ?? 3600),
      },
      resolvedOutputs: {
        roleArn: String(r["Arn"] ?? ""),
      },
      secretStates: [],
      externalId: roleName,
      createdAt: String(r["CreateDate"] ?? ctx.now()),
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

export async function listStepFunctions(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ stateMachines?: Record<string, unknown>[] }>(
    "states",
    "AWSStepFunctions.ListStateMachines",
    {},
  );
  const machines = data.stateMachines ?? [];
  const results: ResourceInstance[] = [];

  for (const sm of machines) {
    const name = String(sm["name"] ?? "");
    const arn = String(sm["stateMachineArn"] ?? "");
    try {
      const detail = await ctx.json<Record<string, unknown>>(
        "states",
        "AWSStepFunctions.DescribeStateMachine",
        { stateMachineArn: arn },
      );
      results.push({
        id: ctx.id(accountId, "step-function", name),
        pluginId: "aws",
        resourceTypeId: "step-function",
        accountId,
        displayName: name,
        fields: {
          name,
          status: String(detail["status"] ?? "ACTIVE"),
          type: String(detail["type"] ?? "STANDARD"),
          creationDate: String(detail["creationDate"] ?? ""),
        },
        resolvedOutputs: { stateMachineArn: arn },
        secretStates: [],
        externalId: name,
        createdAt: String(detail["creationDate"] ?? ctx.now()),
        updatedAt: ctx.now(),
      });
    } catch {
      results.push({
        id: ctx.id(accountId, "step-function", name),
        pluginId: "aws",
        resourceTypeId: "step-function",
        accountId,
        displayName: name,
        fields: {
          name,
          status: "ACTIVE",
          type: String(sm["type"] ?? "STANDARD"),
          creationDate: String(sm["creationDate"] ?? ""),
        },
        resolvedOutputs: { stateMachineArn: arn },
        secretStates: [],
        externalId: name,
        createdAt: String(sm["creationDate"] ?? ctx.now()),
        updatedAt: ctx.now(),
      });
    }
  }
  return results;
}

export async function listEventBridgeRules(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ Rules?: Record<string, unknown>[] }>(
    "events",
    "AWSEvents.ListRules",
    {},
  );
  const rules = data.Rules ?? [];
  return rules.map((rule) => {
    const name = String(rule["Name"] ?? "");
    return {
      id: ctx.id(accountId, "eventbridge-rule", name),
      pluginId: "aws",
      resourceTypeId: "eventbridge-rule",
      accountId,
      displayName: name,
      fields: {
        name,
        state: String(rule["State"] ?? "ENABLED"),
        eventBusName: String(rule["EventBusName"] ?? "default"),
        scheduleExpression: String(rule["ScheduleExpression"] ?? ""),
        description: String(rule["Description"] ?? ""),
      },
      resolvedOutputs: {
        ruleArn: String(rule["Arn"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listKinesisStreams(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ StreamNames?: string[] }>(
    "kinesis",
    "Kinesis_20131202.ListStreams",
    {},
  );
  const streamNames = data.StreamNames ?? [];
  const results: ResourceInstance[] = [];

  for (const streamName of streamNames) {
    try {
      const detail = await ctx.json<{
        StreamDescription: Record<string, unknown>;
      }>("kinesis", "Kinesis_20131202.DescribeStream", { StreamName: streamName });
      const s = detail.StreamDescription;
      const shards = s["Shards"] as unknown[] | undefined;

      results.push({
        id: ctx.id(accountId, "kinesis-stream", streamName),
        pluginId: "aws",
        resourceTypeId: "kinesis-stream",
        accountId,
        displayName: streamName,
        fields: {
          streamName,
          status: String(s["StreamStatus"] ?? ""),
          shardCount: shards?.length ?? 0,
          retentionPeriodHours: Number(s["RetentionPeriodHours"] ?? 24),
          streamModeDetails: String(
            (s["StreamModeDetails"] as Record<string, unknown> | undefined)?.["StreamMode"] ??
              "PROVISIONED",
          ),
          encryptionType: String(s["EncryptionType"] ?? "NONE"),
        },
        resolvedOutputs: {
          streamArn: String(s["StreamARN"] ?? ""),
        },
        secretStates: [],
        externalId: streamName,
        createdAt: String(s["StreamCreationTimestamp"] ?? ctx.now()),
        updatedAt: ctx.now(),
      });
    } catch {
      // Skip streams we can't describe
    }
  }
  return results;
}

export async function listRedshiftClusters(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.ec2Query<Record<string, unknown>>(
    "redshift",
    "DescribeClusters",
    "2012-12-01",
  );
  const clusters = ensureArray(
    (data["Clusters"] as Record<string, unknown> | undefined)?.["member"],
  ) as Record<string, unknown>[];

  return clusters.map((c) => {
    const clusterId = String(c["ClusterIdentifier"] ?? "");
    const endpoint = c["Endpoint"] as Record<string, unknown> | undefined;
    return {
      id: ctx.id(accountId, "redshift-cluster", clusterId),
      pluginId: "aws",
      resourceTypeId: "redshift-cluster",
      accountId,
      displayName: clusterId,
      fields: {
        clusterIdentifier: clusterId,
        nodeType: String(c["NodeType"] ?? ""),
        status: String(c["ClusterStatus"] ?? ""),
        numberOfNodes: Number(c["NumberOfNodes"] ?? 0),
        dbName: String(c["DBName"] ?? ""),
        availabilityZone: String(c["AvailabilityZone"] ?? ""),
        encrypted: c["Encrypted"] === true || c["Encrypted"] === "true",
        publiclyAccessible: c["PubliclyAccessible"] === true || c["PubliclyAccessible"] === "true",
      },
      resolvedOutputs: {
        endpoint: String(endpoint?.["Address"] ?? ""),
        port: String(endpoint?.["Port"] ?? ""),
        masterUsername: String(c["MasterUsername"] ?? ""),
        clusterArn: `arn:aws:redshift:${ctx.region}:${accountId}:cluster:${clusterId}`,
      },
      secretStates: [],
      externalId: clusterId,
      createdAt: String(c["ClusterCreateTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listRDSClusters(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ DBClusters?: Record<string, unknown>[] }>(
    "rds",
    "AmazonRDSv19.DescribeDBClusters",
    {},
  );
  const clusters = data.DBClusters ?? [];
  return clusters.map((c) => {
    const clusterId = String(c["DBClusterIdentifier"] ?? "");
    const members = c["DBClusterMembers"] as unknown[] | undefined;
    return {
      id: ctx.id(accountId, "rds-cluster", clusterId),
      pluginId: "aws",
      resourceTypeId: "rds-cluster",
      accountId,
      displayName: clusterId,
      fields: {
        clusterIdentifier: clusterId,
        engine: String(c["Engine"] ?? ""),
        engineVersion: String(c["EngineVersion"] ?? ""),
        status: String(c["Status"] ?? ""),
        multiAZ: c["MultiAZ"] === true,
        storageEncrypted: c["StorageEncrypted"] === true,
        allocatedStorage: Number(c["AllocatedStorage"] ?? 0),
        dbClusterMembers: members?.length ?? 0,
      },
      resolvedOutputs: {
        endpoint: String(c["Endpoint"] ?? ""),
        readerEndpoint: String(c["ReaderEndpoint"] ?? ""),
        port: String(c["Port"] ?? ""),
        masterUsername: String(c["MasterUsername"] ?? ""),
        clusterArn: String(c["DBClusterArn"] ?? ""),
      },
      secretStates: [],
      externalId: clusterId,
      createdAt: String(c["ClusterCreateTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listOpenSearchDomains(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const listData = await ctx.jsonGet<{
    DomainNames?: Array<{ DomainName: string }>;
  }>("es", "/2021-01-01/domain");
  const domainNames = listData.DomainNames ?? [];
  const results: ResourceInstance[] = [];

  for (const d of domainNames) {
    const domainName = d.DomainName;
    try {
      const detail = await ctx.jsonGet<{
        DomainStatus: Record<string, unknown>;
      }>("es", `/2021-01-01/opensearch/domain/${encodeURIComponent(domainName)}`);
      const ds = detail.DomainStatus;
      const clusterConfig = ds["ClusterConfig"] as Record<string, unknown> | undefined;
      const ebsOptions = ds["EBSOptions"] as Record<string, unknown> | undefined;
      const encryptionConfig = ds["EncryptionAtRestOptions"] as Record<string, unknown> | undefined;

      results.push({
        id: ctx.id(accountId, "opensearch-domain", domainName),
        pluginId: "aws",
        resourceTypeId: "opensearch-domain",
        accountId,
        displayName: domainName,
        fields: {
          domainName,
          engineVersion: String(ds["EngineVersion"] ?? ""),
          instanceType: String(clusterConfig?.["InstanceType"] ?? ""),
          instanceCount: Number(clusterConfig?.["InstanceCount"] ?? 0),
          status: ds["Processing"] === true,
          volumeType: String(ebsOptions?.["VolumeType"] ?? ""),
          volumeSize: Number(ebsOptions?.["VolumeSize"] ?? 0),
          encryptionEnabled: encryptionConfig?.["Enabled"] === true,
        },
        resolvedOutputs: {
          endpoint: String(ds["Endpoint"] ?? ds["Endpoints"]?.toString() ?? ""),
          dashboardEndpoint: ds["Endpoint"] ? `${ds["Endpoint"]}/_dashboards` : "",
          domainArn: String(ds["ARN"] ?? ""),
        },
        secretStates: [],
        externalId: domainName,
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
      });
    } catch {
      // Skip domains we can't describe
    }
  }
  return results;
}

export async function listACMCertificates(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{
    CertificateSummaryList?: Record<string, unknown>[];
  }>("acm", "CertificateManager.ListCertificates", {});
  const certs = data.CertificateSummaryList ?? [];
  const results: ResourceInstance[] = [];

  for (const cert of certs) {
    const arn = String(cert["CertificateArn"] ?? "");
    try {
      const detail = await ctx.json<{
        Certificate: Record<string, unknown>;
      }>("acm", "CertificateManager.DescribeCertificate", { CertificateArn: arn });
      const c = detail.Certificate;
      const sans = c["SubjectAlternativeNames"] as string[] | undefined;
      const inUseBy = c["InUseBy"] as string[] | undefined;

      results.push({
        id: ctx.id(accountId, "acm-certificate", arn),
        pluginId: "aws",
        resourceTypeId: "acm-certificate",
        accountId,
        displayName: String(c["DomainName"] ?? ""),
        fields: {
          domainName: String(c["DomainName"] ?? ""),
          status: String(c["Status"] ?? ""),
          type: String(c["Type"] ?? ""),
          issuer: String(c["Issuer"] ?? ""),
          notBefore: String(c["NotBefore"] ?? ""),
          notAfter: String(c["NotAfter"] ?? ""),
          keyAlgorithm: String(c["KeyAlgorithm"] ?? ""),
          subjectAlternativeNames: sans?.join(", ") ?? "",
          inUseBy: inUseBy?.length ?? 0,
        },
        resolvedOutputs: { certificateArn: arn },
        secretStates: [],
        externalId: arn,
        createdAt: String(c["CreatedAt"] ?? ctx.now()),
        updatedAt: ctx.now(),
      });
    } catch {
      results.push({
        id: ctx.id(accountId, "acm-certificate", arn),
        pluginId: "aws",
        resourceTypeId: "acm-certificate",
        accountId,
        displayName: String(cert["DomainName"] ?? ""),
        fields: {
          domainName: String(cert["DomainName"] ?? ""),
          status: String(cert["Status"] ?? ""),
          type: String(cert["Type"] ?? ""),
          issuer: "",
          notBefore: "",
          notAfter: "",
          keyAlgorithm: String(cert["KeyAlgorithm"] ?? ""),
          subjectAlternativeNames: "",
          inUseBy: 0,
        },
        resolvedOutputs: { certificateArn: arn },
        secretStates: [],
        externalId: arn,
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
      });
    }
  }
  return results;
}

export async function listWAFWebACLs(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{
    WebACLs?: Record<string, unknown>[];
  }>("wafv2", "AWSWAF_20190729.ListWebACLs", { Scope: "REGIONAL", Limit: 100 });
  const acls = data.WebACLs ?? [];
  const results: ResourceInstance[] = [];

  for (const acl of acls) {
    const name = String(acl["Name"] ?? "");
    const aclId = String(acl["Id"] ?? "");
    const arn = String(acl["ARN"] ?? "");

    try {
      const detail = await ctx.json<{
        WebACL: Record<string, unknown>;
      }>("wafv2", "AWSWAF_20190729.GetWebACL", { Name: name, Scope: "REGIONAL", Id: aclId });
      const w = detail.WebACL;
      const rules = w["Rules"] as unknown[] | undefined;
      const defaultAction = w["DefaultAction"] as Record<string, unknown> | undefined;

      results.push({
        id: ctx.id(accountId, "waf-web-acl", name),
        pluginId: "aws",
        resourceTypeId: "waf-web-acl",
        accountId,
        displayName: name,
        fields: {
          name,
          scope: "REGIONAL",
          description: String(w["Description"] ?? ""),
          ruleCount: rules?.length ?? 0,
          defaultAction: defaultAction?.["Allow"] ? "ALLOW" : "BLOCK",
          capacity: Number(w["Capacity"] ?? 0),
        },
        resolvedOutputs: {
          webAclArn: arn,
          webAclId: aclId,
        },
        secretStates: [],
        externalId: name,
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
      });
    } catch {
      results.push({
        id: ctx.id(accountId, "waf-web-acl", name),
        pluginId: "aws",
        resourceTypeId: "waf-web-acl",
        accountId,
        displayName: name,
        fields: {
          name,
          scope: "REGIONAL",
          description: String(acl["Description"] ?? ""),
          ruleCount: 0,
          defaultAction: "ALLOW",
          capacity: 0,
        },
        resolvedOutputs: { webAclArn: arn, webAclId: aclId },
        secretStates: [],
        externalId: name,
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
      });
    }
  }
  return results;
}

export async function listCodeBuildProjects(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const listData = await ctx.json<{ projects?: string[] }>(
    "codebuild",
    "CodeBuild_20161006.ListProjects",
    {},
  );
  const projectNames = listData.projects ?? [];
  if (projectNames.length === 0) return [];

  const data = await ctx.json<{ projects?: Record<string, unknown>[] }>(
    "codebuild",
    "CodeBuild_20161006.BatchGetProjects",
    { names: projectNames },
  );
  const projects = data.projects ?? [];

  return projects.map((p) => {
    const name = String(p["name"] ?? "");
    const source = p["source"] as Record<string, unknown> | undefined;
    const environment = p["environment"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "codebuild-project", name),
      pluginId: "aws",
      resourceTypeId: "codebuild-project",
      accountId,
      displayName: name,
      fields: {
        name,
        description: String(p["description"] ?? ""),
        sourceType: String(source?.["type"] ?? ""),
        environment: String(environment?.["image"] ?? ""),
        computeType: String(environment?.["computeType"] ?? ""),
        lastBuildStatus: String(p["lastBuildStatus"] ?? ""),
        badge: (p["badge"] as Record<string, unknown> | undefined)?.["badgeEnabled"] === true,
      },
      resolvedOutputs: {
        projectArn: String(p["arn"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: String(p["created"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listCodePipelines(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{
    pipelines?: Record<string, unknown>[];
  }>("codepipeline", "CodePipeline_20150709.ListPipelines", {});
  const pipelines = data.pipelines ?? [];

  return pipelines.map((p) => {
    const name = String(p["name"] ?? "");
    return {
      id: ctx.id(accountId, "codepipeline-pipeline", name),
      pluginId: "aws",
      resourceTypeId: "codepipeline-pipeline",
      accountId,
      displayName: name,
      fields: {
        name,
        stageCount: 0,
        version: Number(p["version"] ?? 0),
        createdAt: String(p["created"] ?? ""),
        updatedAt: String(p["updated"] ?? ""),
        pipelineType: String(p["pipelineType"] ?? ""),
      },
      resolvedOutputs: {
        pipelineArn: `arn:aws:codepipeline:${ctx.region}:${accountId}:${name}`,
      },
      secretStates: [],
      externalId: name,
      createdAt: String(p["created"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listCloudFormationStacks(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ Stacks?: Record<string, unknown>[] }>(
    "cloudformation",
    "CloudFormation.DescribeStacks",
    {},
  );
  const stacks = data.Stacks ?? [];
  return stacks.map((s) => {
    const stackName = String(s["StackName"] ?? "");
    return {
      id: ctx.id(accountId, "cloudformation-stack", stackName),
      pluginId: "aws",
      resourceTypeId: "cloudformation-stack",
      accountId,
      displayName: stackName,
      fields: {
        stackName,
        stackId: String(s["StackId"] ?? ""),
        status: String(s["StackStatus"] ?? ""),
        description: String(s["Description"] ?? ""),
        driftStatus: String(
          s["DriftInformation"]
            ? (s["DriftInformation"] as Record<string, unknown>)["StackDriftStatus"]
            : "",
        ),
        enableTerminationProtection: s["EnableTerminationProtection"] === true,
      },
      resolvedOutputs: {
        stackArn: String(s["StackId"] ?? ""),
      },
      secretStates: [],
      externalId: stackName,
      createdAt: String(s["CreationTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listSSMParameters(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ Parameters?: Record<string, unknown>[] }>(
    "ssm",
    "AmazonSSM.DescribeParameters",
    {},
  );
  const params = data.Parameters ?? [];
  return params.map((p) => {
    const name = String(p["Name"] ?? "");
    return {
      id: ctx.id(accountId, "ssm-parameter", name),
      pluginId: "aws",
      resourceTypeId: "ssm-parameter",
      accountId,
      displayName: name,
      fields: {
        name,
        type: String(p["Type"] ?? ""),
        version: Number(p["Version"] ?? 0),
        tier: String(p["Tier"] ?? "Standard"),
        lastModifiedDate: String(p["LastModifiedDate"] ?? ""),
        dataType: String(p["DataType"] ?? "text"),
      },
      resolvedOutputs: {
        parameterArn: `arn:aws:ssm:${ctx.region}:${accountId}:parameter${name.startsWith("/") ? "" : "/"}${name}`,
        parameterValue: "",
      },
      secretStates: [],
      externalId: name,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listEFSFileSystems(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.jsonGet<{
    FileSystems?: Record<string, unknown>[];
  }>("elasticfilesystem", "/2015-02-01/file-systems");
  const fileSystems = data.FileSystems ?? [];

  return fileSystems.map((fs) => {
    const fsId = String(fs["FileSystemId"] ?? "");
    const tagSet = fs["Tags"] as Array<Record<string, string>> | undefined;
    const nameTag = tagSet?.find((t) => t["Key"] === "Name");
    const name = nameTag ? (nameTag["Value"] ?? "") : "";
    const sizeObj = fs["SizeInBytes"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "efs-file-system", fsId),
      pluginId: "aws",
      resourceTypeId: "efs-file-system",
      accountId,
      displayName: name || fsId,
      fields: {
        name,
        fileSystemId: fsId,
        lifeCycleState: String(fs["LifeCycleState"] ?? ""),
        performanceMode: String(fs["PerformanceMode"] ?? ""),
        throughputMode: String(fs["ThroughputMode"] ?? ""),
        sizeInBytes: Number(sizeObj?.["Value"] ?? 0),
        encrypted: fs["Encrypted"] === true,
        numberOfMountTargets: Number(fs["NumberOfMountTargets"] ?? 0),
      },
      resolvedOutputs: {
        fileSystemArn: String(fs["FileSystemArn"] ?? ""),
        fileSystemId: fsId,
      },
      secretStates: [],
      externalId: fsId,
      createdAt: String(fs["CreationTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listAPIGateways(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.jsonGet<{
    Items?: Record<string, unknown>[];
  }>("apigateway", "/v2/apis");
  const apis = data.Items ?? [];

  return apis.map((api) => {
    const name = String(api["Name"] ?? "");
    const apiId = String(api["ApiId"] ?? "");
    const routeCount = Number(api["RouteSelectionExpression"] ? 1 : 0);

    return {
      id: ctx.id(accountId, "api-gateway", apiId),
      pluginId: "aws",
      resourceTypeId: "api-gateway",
      accountId,
      displayName: name || apiId,
      fields: {
        name,
        apiId,
        protocolType: String(api["ProtocolType"] ?? "HTTP"),
        description: String(api["Description"] ?? ""),
        routeCount,
        createdDate: String(api["CreatedDate"] ?? ""),
      },
      resolvedOutputs: {
        apiEndpoint: String(api["ApiEndpoint"] ?? ""),
        apiId,
      },
      secretStates: [],
      externalId: apiId,
      createdAt: String(api["CreatedDate"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listCloudWatchAlarms(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ MetricAlarms?: Record<string, unknown>[] }>(
    "monitoring",
    "GraniteServiceVersion20100801.DescribeAlarms",
    {},
  );
  const alarms = data.MetricAlarms ?? [];

  return alarms.map((a) => {
    const alarmName = String(a["AlarmName"] ?? "");
    return {
      id: ctx.id(accountId, "cloudwatch-alarm", alarmName),
      pluginId: "aws",
      resourceTypeId: "cloudwatch-alarm",
      accountId,
      displayName: alarmName,
      fields: {
        alarmName,
        state: String(a["StateValue"] ?? ""),
        metricName: String(a["MetricName"] ?? ""),
        namespace: String(a["Namespace"] ?? ""),
        comparisonOperator: String(a["ComparisonOperator"] ?? ""),
        threshold: Number(a["Threshold"] ?? 0),
        period: Number(a["Period"] ?? 0),
        actionsEnabled: a["ActionsEnabled"] === true,
      },
      resolvedOutputs: {
        alarmArn: String(a["AlarmArn"] ?? ""),
      },
      secretStates: [],
      externalId: alarmName,
      createdAt: String(a["AlarmConfigurationUpdatedTimestamp"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listCloudWatchLogGroups(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ logGroups?: Record<string, unknown>[] }>(
    "logs",
    "Logs_20140328.DescribeLogGroups",
    {},
  );
  const logGroups = data.logGroups ?? [];

  return logGroups.map((lg) => {
    const logGroupName = String(lg["logGroupName"] ?? "");
    return {
      id: ctx.id(accountId, "cloudwatch-log-group", logGroupName),
      pluginId: "aws",
      resourceTypeId: "cloudwatch-log-group",
      accountId,
      displayName: logGroupName,
      fields: {
        logGroupName,
        storedBytes: Number(lg["storedBytes"] ?? 0),
        retentionInDays: Number(lg["retentionInDays"] ?? 0),
        metricFilterCount: Number(lg["metricFilterCount"] ?? 0),
        kmsKeyId: String(lg["kmsKeyId"] ?? ""),
      },
      resolvedOutputs: {
        logGroupArn: String(lg["arn"] ?? ""),
      },
      secretStates: [],
      externalId: logGroupName,
      createdAt: lg["creationTime"]
        ? new Date(Number(lg["creationTime"])).toISOString()
        : ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listAppRunnerServices(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{
    ServiceSummaryList?: Record<string, unknown>[];
  }>("apprunner", "AppRunner.ListServices", {});
  const services = data.ServiceSummaryList ?? [];

  return services.map((svc) => {
    const serviceName = String(svc["ServiceName"] ?? "");
    return {
      id: ctx.id(accountId, "apprunner-service", serviceName),
      pluginId: "aws",
      resourceTypeId: "apprunner-service",
      accountId,
      displayName: serviceName,
      fields: {
        serviceName,
        status: String(svc["Status"] ?? ""),
        serviceId: String(svc["ServiceId"] ?? ""),
        sourceType: "",
        cpu: "",
        memory: "",
      },
      resolvedOutputs: {
        serviceUrl: String(svc["ServiceUrl"] ?? ""),
        serviceArn: String(svc["ServiceArn"] ?? ""),
      },
      secretStates: [],
      externalId: serviceName,
      createdAt: String(svc["CreatedAt"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listGlueDatabases(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{
    DatabaseList?: Record<string, unknown>[];
  }>("glue", "AWSGlue.GetDatabases", {});
  const databases = data.DatabaseList ?? [];

  return databases.map((db) => {
    const name = String(db["Name"] ?? "");
    return {
      id: ctx.id(accountId, "glue-database", name),
      pluginId: "aws",
      resourceTypeId: "glue-database",
      accountId,
      displayName: name,
      fields: {
        name,
        description: String(db["Description"] ?? ""),
        locationUri: String(db["LocationUri"] ?? ""),
        createTime: String(db["CreateTime"] ?? ""),
        catalogId: String(db["CatalogId"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: String(db["CreateTime"] ?? ctx.now()),
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

export async function listCloudTrailTrails(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ trailList?: Record<string, unknown>[] }>(
    "cloudtrail",
    "CloudTrail_20131101.DescribeTrails",
    {},
  );
  const trails = data.trailList ?? [];
  return trails.map((t) => {
    const name = String(t["Name"] ?? "");
    return {
      id: ctx.id(accountId, "cloudtrail-trail", name),
      pluginId: "aws",
      resourceTypeId: "cloudtrail-trail",
      accountId,
      displayName: name,
      fields: {
        name,
        s3BucketName: String(t["S3BucketName"] ?? ""),
        isMultiRegion: t["IsMultiRegionTrail"] === true,
        isOrganizationTrail: t["IsOrganizationTrail"] === true,
        logFileValidationEnabled: t["LogFileValidationEnabled"] === true,
        includeGlobalServiceEvents: t["IncludeGlobalServiceEvents"] === true,
        status: true,
      },
      resolvedOutputs: {
        trailArn: String(t["TrailARN"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listMSKClusters(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.jsonGet<{
    ClusterInfoList?: Record<string, unknown>[];
  }>("kafka", "/v1/clusters");
  const clusters = data.ClusterInfoList ?? [];

  return clusters.map((c) => {
    const name = String(c["ClusterName"] ?? "");
    const brokerNodeGroupInfo = c["BrokerNodeGroupInfo"] as Record<string, unknown> | undefined;
    return {
      id: ctx.id(accountId, "msk-cluster", name),
      pluginId: "aws",
      resourceTypeId: "msk-cluster",
      accountId,
      displayName: name,
      fields: {
        clusterName: name,
        state: String(c["State"] ?? ""),
        kafkaVersion: String(
          c["CurrentBrokerSoftwareInfo"]
            ? (c["CurrentBrokerSoftwareInfo"] as Record<string, unknown>)["KafkaVersion"]
            : "",
        ),
        numberOfBrokerNodes: Number(c["NumberOfBrokerNodes"] ?? 0),
        instanceType: String(brokerNodeGroupInfo?.["InstanceType"] ?? ""),
        storagePerBrokerGb: Number(
          ((brokerNodeGroupInfo?.["StorageInfo"] as Record<string, unknown> | undefined)?.[
            "EbsStorageInfo"
          ] as Record<string, unknown> | undefined)
            ? ((
                (brokerNodeGroupInfo?.["StorageInfo"] as Record<string, unknown>)?.[
                  "EbsStorageInfo"
                ] as Record<string, unknown>
              )?.["VolumeSize"] ?? 0)
            : 0,
        ),
      },
      resolvedOutputs: {
        clusterArn: String(c["ClusterArn"] ?? ""),
        bootstrapBrokers: "",
      },
      secretStates: [],
      externalId: name,
      createdAt: String(c["CreationTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listNeptuneClusters(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ DBClusters?: Record<string, unknown>[] }>(
    "rds",
    "AmazonRDSv19.DescribeDBClusters",
    { Filters: [{ Name: "engine", Values: ["neptune"] }] },
  );
  const clusters = data.DBClusters ?? [];
  return clusters
    .filter((c) => String(c["Engine"] ?? "") === "neptune")
    .map((c) => {
      const clusterId = String(c["DBClusterIdentifier"] ?? "");
      const members = c["DBClusterMembers"] as unknown[] | undefined;
      return {
        id: ctx.id(accountId, "neptune-cluster", clusterId),
        pluginId: "aws",
        resourceTypeId: "neptune-cluster",
        accountId,
        displayName: clusterId,
        fields: {
          clusterIdentifier: clusterId,
          engine: String(c["Engine"] ?? ""),
          engineVersion: String(c["EngineVersion"] ?? ""),
          status: String(c["Status"] ?? ""),
          storageEncrypted: c["StorageEncrypted"] === true,
          multiAZ: c["MultiAZ"] === true,
          dbClusterMembers: members?.length ?? 0,
        },
        resolvedOutputs: {
          endpoint: String(c["Endpoint"] ?? ""),
          readerEndpoint: String(c["ReaderEndpoint"] ?? ""),
          port: String(c["Port"] ?? ""),
          clusterArn: String(c["DBClusterArn"] ?? ""),
        },
        secretStates: [],
        externalId: clusterId,
        createdAt: String(c["ClusterCreateTime"] ?? ctx.now()),
        updatedAt: ctx.now(),
      };
    });
}

export async function listDocumentDBClusters(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ DBClusters?: Record<string, unknown>[] }>(
    "rds",
    "AmazonRDSv19.DescribeDBClusters",
    { Filters: [{ Name: "engine", Values: ["docdb"] }] },
  );
  const clusters = data.DBClusters ?? [];
  return clusters
    .filter((c) => String(c["Engine"] ?? "") === "docdb")
    .map((c) => {
      const clusterId = String(c["DBClusterIdentifier"] ?? "");
      const members = c["DBClusterMembers"] as unknown[] | undefined;
      return {
        id: ctx.id(accountId, "documentdb-cluster", clusterId),
        pluginId: "aws",
        resourceTypeId: "documentdb-cluster",
        accountId,
        displayName: clusterId,
        fields: {
          clusterIdentifier: clusterId,
          engine: String(c["Engine"] ?? ""),
          engineVersion: String(c["EngineVersion"] ?? ""),
          status: String(c["Status"] ?? ""),
          storageEncrypted: c["StorageEncrypted"] === true,
          multiAZ: c["MultiAZ"] === true,
          dbClusterMembers: members?.length ?? 0,
        },
        resolvedOutputs: {
          endpoint: String(c["Endpoint"] ?? ""),
          readerEndpoint: String(c["ReaderEndpoint"] ?? ""),
          port: String(c["Port"] ?? ""),
          masterUsername: String(c["MasterUsername"] ?? ""),
          clusterArn: String(c["DBClusterArn"] ?? ""),
        },
        secretStates: [],
        externalId: clusterId,
        createdAt: String(c["ClusterCreateTime"] ?? ctx.now()),
        updatedAt: ctx.now(),
      };
    });
}

export async function listMQBrokers(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.jsonGet<{
    BrokerSummaries?: Record<string, unknown>[];
  }>("mq", "/v1/brokers");
  const brokers = data.BrokerSummaries ?? [];

  return brokers.map((b) => {
    const brokerName = String(b["BrokerName"] ?? "");
    const brokerId = String(b["BrokerId"] ?? "");
    return {
      id: ctx.id(accountId, "mq-broker", brokerId),
      pluginId: "aws",
      resourceTypeId: "mq-broker",
      accountId,
      displayName: brokerName,
      fields: {
        brokerName,
        brokerId,
        engineType: String(b["EngineType"] ?? ""),
        engineVersion: String(b["EngineVersion"] ?? ""),
        hostInstanceType: String(b["HostInstanceType"] ?? ""),
        deploymentMode: String(b["DeploymentMode"] ?? ""),
        status: String(b["BrokerState"] ?? ""),
      },
      resolvedOutputs: {
        brokerArn: String(b["BrokerArn"] ?? ""),
        consoleUrl: "",
      },
      secretStates: [],
      externalId: brokerId,
      createdAt: String(b["Created"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listBatchJobQueues(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ jobQueues?: Record<string, unknown>[] }>(
    "batch",
    "AWSBatch.DescribeJobQueues",
    {},
  );
  const queues = data.jobQueues ?? [];

  return queues.map((q) => {
    const name = String(q["jobQueueName"] ?? "");
    return {
      id: ctx.id(accountId, "batch-job-queue", name),
      pluginId: "aws",
      resourceTypeId: "batch-job-queue",
      accountId,
      displayName: name,
      fields: {
        jobQueueName: name,
        state: String(q["state"] ?? ""),
        status: String(q["status"] ?? ""),
        priority: Number(q["priority"] ?? 0),
        schedulingPolicyArn: String(q["schedulingPolicyArn"] ?? ""),
      },
      resolvedOutputs: {
        jobQueueArn: String(q["jobQueueArn"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listSageMakerEndpoints(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ Endpoints?: Record<string, unknown>[] }>(
    "sagemaker",
    "SageMaker.ListEndpoints",
    {},
  );
  const endpoints = data.Endpoints ?? [];

  return endpoints.map((ep) => {
    const name = String(ep["EndpointName"] ?? "");
    return {
      id: ctx.id(accountId, "sagemaker-endpoint", name),
      pluginId: "aws",
      resourceTypeId: "sagemaker-endpoint",
      accountId,
      displayName: name,
      fields: {
        endpointName: name,
        status: String(ep["EndpointStatus"] ?? ""),
        endpointConfigName: String(ep["EndpointConfigName"] ?? ""),
        creationTime: String(ep["CreationTime"] ?? ""),
        lastModifiedTime: String(ep["LastModifiedTime"] ?? ""),
      },
      resolvedOutputs: {
        endpointArn: String(ep["EndpointArn"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: String(ep["CreationTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}
