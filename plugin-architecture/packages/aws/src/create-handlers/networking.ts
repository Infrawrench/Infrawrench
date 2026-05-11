import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { parseXml, ensureArray } from "../auth.js";
import { signRequest } from "../signed-request.js";
import type { AwsCreateContext } from "./shared.js";

export async function networkingGetCreateConfig(
  _ctx: AwsCreateContext,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig | null> {
  if (typeId === "vpc") {
    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
        {
          key: "cidrBlock",
          label: "CIDR Block",
          kind: "text",
          required: true,
          defaultValue: "10.0.0.0/16",
          description: "IPv4 CIDR block (e.g. 10.0.0.0/16)",
        },
      ],
    };
  }
  if (typeId === "security-group") {
    return {
      fields: [
        { key: "groupName", label: "Group Name", kind: "text", required: true },
        { key: "description", label: "Description", kind: "text", required: true },
        {
          key: "vpcId",
          label: "VPC ID",
          kind: "text",
          required: false,
          description: "VPC to create in (defaults to default VPC)",
        },
      ],
    };
  }
  if (typeId === "internet-gateway") {
    return {
      fields: [{ key: "name", label: "Name (Tag)", kind: "text", required: false }],
    };
  }
  if (typeId === "subnet") {
    const hasParent = !!parentResourceId;
    const fields: CreateResourceConfig["fields"] = [];
    if (!hasParent) {
      fields.push({ key: "vpcId", label: "VPC ID", kind: "text", required: true });
    }
    fields.push(
      {
        key: "cidrBlock",
        label: "CIDR Block",
        kind: "text",
        required: true,
        description: "e.g. 10.0.1.0/24",
      },
      {
        key: "availabilityZone",
        label: "Availability Zone",
        kind: "text",
        required: true,
        description: "e.g. us-east-1a",
      },
      { key: "name", label: "Name (Tag)", kind: "text", required: false },
    );
    return { fields };
  }
  if (typeId === "nat-gateway") {
    return {
      fields: [
        { key: "subnetId", label: "Subnet ID", kind: "text", required: true },
        {
          key: "allocationId",
          label: "Elastic IP Allocation ID",
          kind: "text",
          required: true,
          description: "Allocation ID of an Elastic IP",
        },
      ],
    };
  }
  if (typeId === "target-group") {
    const hasParent = !!parentResourceId;
    const fields: CreateResourceConfig["fields"] = [
      { key: "name", label: "Name", kind: "text", required: true },
      {
        key: "protocol",
        label: "Protocol",
        kind: "select",
        required: true,
        options: [
          { id: "HTTP", label: "HTTP" },
          { id: "HTTPS", label: "HTTPS" },
          { id: "TCP", label: "TCP" },
          { id: "TLS", label: "TLS" },
          { id: "UDP", label: "UDP" },
        ],
        defaultValue: "HTTP",
      },
      {
        key: "port",
        label: "Port",
        kind: "number",
        required: true,
        defaultValue: "80",
        minValue: 1,
        maxValue: 65535,
      },
    ];
    if (!hasParent) {
      fields.push({ key: "vpcId", label: "VPC ID", kind: "text", required: true });
    }
    fields.push({
      key: "targetType",
      label: "Target Type",
      kind: "select",
      required: true,
      options: [
        { id: "instance", label: "Instance" },
        { id: "ip", label: "IP" },
        { id: "lambda", label: "Lambda" },
        { id: "alb", label: "ALB" },
      ],
      defaultValue: "instance",
    });
    return { fields };
  }
  if (typeId === "alb") {
    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
        {
          key: "subnets",
          label: "Subnet IDs",
          kind: "text",
          required: true,
          description: "Comma-separated subnet IDs (at least 2)",
        },
        {
          key: "scheme",
          label: "Scheme",
          kind: "select",
          required: true,
          options: [
            { id: "internet-facing", label: "Internet-facing" },
            { id: "internal", label: "Internal" },
          ],
          defaultValue: "internet-facing",
        },
      ],
    };
  }
  if (typeId === "route53-hosted-zone") {
    return {
      fields: [
        {
          key: "name",
          label: "Domain Name",
          kind: "text",
          required: true,
          description: "e.g. example.com",
        },
        { key: "comment", label: "Comment", kind: "text", required: false },
      ],
    };
  }
  if (typeId === "route53-record-set") {
    const hasParent = !!parentResourceId;
    const fields: CreateResourceConfig["fields"] = [];
    if (!hasParent) {
      fields.push({
        key: "hostedZoneId",
        label: "Hosted Zone ID",
        kind: "text",
        required: true,
      });
    }
    fields.push(
      {
        key: "name",
        label: "Record Name",
        kind: "text",
        required: true,
        description: "e.g. www.example.com",
      },
      {
        key: "type",
        label: "Record Type",
        kind: "select",
        required: true,
        options: [
          { id: "A", label: "A" },
          { id: "AAAA", label: "AAAA" },
          { id: "CNAME", label: "CNAME" },
          { id: "MX", label: "MX" },
          { id: "TXT", label: "TXT" },
          { id: "NS", label: "NS" },
          { id: "SRV", label: "SRV" },
          { id: "PTR", label: "PTR" },
          { id: "CAA", label: "CAA" },
        ],
        defaultValue: "A",
      },
      {
        key: "ttl",
        label: "TTL",
        kind: "number",
        required: true,
        defaultValue: "300",
        minValue: 0,
        maxValue: 2147483647,
      },
      {
        key: "value",
        label: "Value",
        kind: "text",
        required: true,
        description: "Record value (e.g. IP address)",
      },
    );
    return { fields };
  }
  if (typeId === "acm-certificate") {
    return {
      fields: [
        {
          key: "domainName",
          label: "Domain Name",
          kind: "text",
          required: true,
          description: "e.g. example.com or *.example.com",
        },
        {
          key: "validationMethod",
          label: "Validation Method",
          kind: "select",
          required: true,
          options: [
            { id: "DNS", label: "DNS" },
            { id: "EMAIL", label: "Email" },
          ],
          defaultValue: "DNS",
        },
      ],
    };
  }
  if (typeId === "api-gateway") {
    return {
      fields: [
        { key: "name", label: "API Name", kind: "text", required: true },
        {
          key: "protocolType",
          label: "Protocol Type",
          kind: "select",
          required: true,
          options: [
            { id: "HTTP", label: "HTTP" },
            { id: "WEBSOCKET", label: "WebSocket" },
          ],
          defaultValue: "HTTP",
        },
        {
          key: "description",
          label: "Description",
          kind: "text",
          required: false,
        },
      ],
    };
  }
  if (typeId === "waf-web-acl") {
    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
        {
          key: "scope",
          label: "Scope",
          kind: "select",
          required: true,
          options: [
            { id: "REGIONAL", label: "Regional" },
            { id: "CLOUDFRONT", label: "CloudFront" },
          ],
          defaultValue: "REGIONAL",
        },
        {
          key: "defaultAction",
          label: "Default Action",
          kind: "select",
          required: true,
          options: [
            { id: "ALLOW", label: "Allow" },
            { id: "BLOCK", label: "Block" },
          ],
          defaultValue: "ALLOW",
        },
        { key: "description", label: "Description", kind: "text", required: false },
      ],
    };
  }
  return null;
}

export async function networkingCreateResource(
  ctx: AwsCreateContext,
  typeId: string,
  accountId: string,
  fields: Record<string, string>,
  parentResourceId?: string,
): Promise<ResourceInstance | null> {
  if (typeId === "vpc") {
    const data = await ctx.ec2<Record<string, unknown>>("CreateVpc", {
      CidrBlock: fields["cidrBlock"] ?? "10.0.0.0/16",
    });
    const vpc = (data["vpc"] ?? data) as Record<string, unknown>;
    const vpcId = String(vpc["vpcId"] ?? "");
    // Tag with name
    if (fields["name"]) {
      await ctx.ec2("CreateTags", {
        "ResourceId.1": vpcId,
        "Tag.1.Key": "Name",
        "Tag.1.Value": fields["name"],
      });
    }
    return {
      id: ctx.makeId(accountId, "vpc", vpcId),
      pluginId: "aws",
      resourceTypeId: "vpc",
      accountId,
      displayName: fields["name"] || vpcId,
      fields: {
        vpcId,
        name: fields["name"] ?? "",
        cidrBlock: fields["cidrBlock"] ?? "10.0.0.0/16",
        state: "available",
        isDefault: false,
        tenancy: "default",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: vpcId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "security-group") {
    const params: Record<string, string> = {
      GroupName: fields["groupName"] ?? "",
      GroupDescription: fields["description"] ?? "",
    };
    if (fields["vpcId"]) params["VpcId"] = fields["vpcId"];
    const data = await ctx.ec2<Record<string, unknown>>("CreateSecurityGroup", params);
    const groupId = String(data["groupId"] ?? "");
    return {
      id: ctx.makeId(accountId, "security-group", groupId),
      pluginId: "aws",
      resourceTypeId: "security-group",
      accountId,
      displayName: fields["groupName"] ?? groupId,
      fields: {
        groupId,
        groupName: fields["groupName"] ?? "",
        description: fields["description"] ?? "",
        vpcId: fields["vpcId"] ?? "",
        inboundRuleCount: 0,
        outboundRuleCount: 1,
      },
      resolvedOutputs: { groupId },
      secretStates: [],
      externalId: groupId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "internet-gateway") {
    const data = await ctx.ec2<Record<string, unknown>>("CreateInternetGateway");
    const igw = (data["internetGateway"] ?? data) as Record<string, unknown>;
    const igwId = String(igw["internetGatewayId"] ?? "");
    if (fields["name"]) {
      await ctx.ec2("CreateTags", {
        "ResourceId.1": igwId,
        "Tag.1.Key": "Name",
        "Tag.1.Value": fields["name"],
      });
    }
    return {
      id: ctx.makeId(accountId, "internet-gateway", igwId),
      pluginId: "aws",
      resourceTypeId: "internet-gateway",
      accountId,
      displayName: igwId,
      fields: {
        internetGatewayId: igwId,
        vpcId: "",
        state: "detached",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: igwId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "subnet") {
    const parentVpcId = parentResourceId ? parentResourceId.split(":").slice(2).join(":") : "";
    const vpcId = fields["vpcId"] || parentVpcId;
    const params: Record<string, string> = {
      VpcId: vpcId,
      CidrBlock: fields["cidrBlock"] ?? "",
      AvailabilityZone: fields["availabilityZone"] ?? "",
    };
    const data = await ctx.ec2<Record<string, unknown>>("CreateSubnet", params);
    const sub = (data["subnet"] ?? data) as Record<string, unknown>;
    const subnetId = String(sub["subnetId"] ?? "");
    if (fields["name"]) {
      await ctx.ec2("CreateTags", {
        "ResourceId.1": subnetId,
        "Tag.1.Key": "Name",
        "Tag.1.Value": fields["name"],
      });
    }
    return {
      id: ctx.makeId(accountId, "subnet", subnetId),
      pluginId: "aws",
      resourceTypeId: "subnet",
      accountId,
      displayName: fields["name"] || subnetId,
      fields: {
        subnetId,
        name: fields["name"] ?? "",
        vpcId,
        cidrBlock: fields["cidrBlock"] ?? "",
        availabilityZone: fields["availabilityZone"] ?? "",
        state: "available",
        availableIps: 0,
        mapPublicIp: false,
      },
      resolvedOutputs: {
        subnetArn: String(sub["subnetArn"] ?? ""),
      },
      secretStates: [],
      externalId: subnetId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "nat-gateway") {
    const data = await ctx.ec2<Record<string, unknown>>("CreateNatGateway", {
      SubnetId: fields["subnetId"] ?? "",
      AllocationId: fields["allocationId"] ?? "",
    });
    const nat = (data["natGateway"] ?? data) as Record<string, unknown>;
    const natGatewayId = String(nat["natGatewayId"] ?? "");
    return {
      id: ctx.makeId(accountId, "nat-gateway", natGatewayId),
      pluginId: "aws",
      resourceTypeId: "nat-gateway",
      accountId,
      displayName: natGatewayId,
      fields: {
        natGatewayId,
        state: "pending",
        subnetId: fields["subnetId"] ?? "",
        vpcId: "",
        connectivityType: "public",
        publicIp: "",
        privateIp: "",
      },
      resolvedOutputs: { natGatewayId },
      secretStates: [],
      externalId: natGatewayId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "target-group") {
    // Target groups tie to a VPC. When created from an ALB's detail page, the
    // vpcId field is hidden — look up the parent ALB to read its vpcId since
    // the ALB's externalId is just its name, not the VPC.
    let vpcId = fields["vpcId"] ?? "";
    if (!vpcId && parentResourceId) {
      const alb = await ctx.getResource("alb", parentResourceId, accountId);
      vpcId = String(alb.fields["vpcId"] ?? "");
    }
    const params: Record<string, string> = {
      Name: fields["name"] ?? "",
      Protocol: fields["protocol"] ?? "HTTP",
      Port: fields["port"] ?? "80",
      VpcId: vpcId,
      TargetType: fields["targetType"] ?? "instance",
    };
    const data = await ctx.ec2Query<Record<string, unknown>>(
      "elasticloadbalancing",
      "CreateTargetGroup",
      "2015-12-01",
      params,
    );
    const tgs = ensureArray(
      (data["TargetGroups"] as Record<string, unknown> | undefined)?.["member"],
    ) as Record<string, unknown>[];
    const tg = tgs[0] ?? {};
    const name = fields["name"] ?? "";
    return {
      id: ctx.makeId(accountId, "target-group", name),
      pluginId: "aws",
      resourceTypeId: "target-group",
      accountId,
      displayName: name,
      fields: {
        name,
        protocol: fields["protocol"] ?? "HTTP",
        port: Number(fields["port"] ?? 80),
        targetType: fields["targetType"] ?? "instance",
        vpcId,
        healthCheckProtocol: String(tg["HealthCheckProtocol"] ?? ""),
        healthCheckPath: String(tg["HealthCheckPath"] ?? ""),
        healthyThreshold: Number(tg["HealthyThresholdCount"] ?? 0),
      },
      resolvedOutputs: {
        targetGroupArn: String(tg["TargetGroupArn"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "alb") {
    const subnets = (fields["subnets"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const params: Record<string, string> = {
      Name: fields["name"] ?? "",
      Scheme: fields["scheme"] ?? "internet-facing",
    };
    subnets.forEach((s, i) => {
      params[`Subnets.member.${i + 1}`] = s;
    });
    const data = await ctx.ec2Query<Record<string, unknown>>(
      "elasticloadbalancing",
      "CreateLoadBalancer",
      "2015-12-01",
      params,
    );
    const lbs = ensureArray(
      (data["LoadBalancers"] as Record<string, unknown> | undefined)?.["member"],
    ) as Record<string, unknown>[];
    const lb = lbs[0] ?? {};
    const name = fields["name"] ?? "";
    return {
      id: ctx.makeId(accountId, "alb", name),
      pluginId: "aws",
      resourceTypeId: "alb",
      accountId,
      displayName: name,
      fields: {
        name,
        type: String(lb["Type"] ?? "application"),
        state: "provisioning",
        scheme: fields["scheme"] ?? "internet-facing",
        vpcId: String(lb["VpcId"] ?? ""),
        availabilityZones: "",
        ipAddressType: String(lb["IpAddressType"] ?? ""),
      },
      resolvedOutputs: {
        dnsName: String(lb["DNSName"] ?? ""),
        loadBalancerArn: String(lb["LoadBalancerArn"] ?? ""),
        canonicalHostedZoneId: String(lb["CanonicalHostedZoneId"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "route53-hosted-zone") {
    const domainName = fields["name"] ?? "";
    const host = ctx.hostForService("route53");
    const url = `https://${host}/2013-04-01/hostedzone`;
    const bodyXml = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<CreateHostedZoneRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">`,
      `<Name>${domainName}</Name>`,
      `<CallerReference>${Date.now()}</CallerReference>`,
      fields["comment"]
        ? `<HostedZoneConfig><Comment>${fields["comment"]}</Comment></HostedZoneConfig>`
        : "",
      `</CreateHostedZoneRequest>`,
    ].join("");
    const headers = await signRequest({
      method: "POST",
      url,
      headers: { Host: host, "Content-Type": "application/xml" },
      body: bodyXml,
      service: "route53",
      credentials: ctx.creds,
    });
    const res = await fetch(url, { method: "POST", headers, body: bodyXml });
    if (!res.ok)
      throw new Error(`Route53 CreateHostedZone failed: ${res.status} ${await res.text()}`);
    const xml = await res.text();
    const parsed = parseXml(xml) as Record<string, unknown>;
    const hz = (parsed["HostedZone"] ?? {}) as Record<string, unknown>;
    const zoneId = String(hz["Id"] ?? "").replace("/hostedzone/", "");
    return {
      id: ctx.makeId(accountId, "route53-hosted-zone", zoneId),
      pluginId: "aws",
      resourceTypeId: "route53-hosted-zone",
      accountId,
      displayName: domainName,
      fields: {
        name: domainName,
        hostedZoneId: zoneId,
        recordCount: 0,
        isPrivate: false,
        comment: fields["comment"] ?? "",
      },
      resolvedOutputs: {
        hostedZoneId: zoneId,
        nameServers: "",
      },
      secretStates: [],
      externalId: zoneId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "route53-record-set") {
    const parentHostedZoneId = parentResourceId
      ? parentResourceId.split(":").slice(2).join(":")
      : "";
    const hostedZoneId = fields["hostedZoneId"] || parentHostedZoneId;
    const recordName = fields["name"] ?? "";
    const recordType = fields["type"] ?? "A";
    const ttl = fields["ttl"] ?? "300";
    const value = fields["value"] ?? "";
    const host = ctx.hostForService("route53");
    const url = `https://${host}/2013-04-01/hostedzone/${hostedZoneId}/rrset`;
    const bodyXml = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">`,
      `<ChangeBatch><Changes><Change>`,
      `<Action>CREATE</Action>`,
      `<ResourceRecordSet>`,
      `<Name>${recordName}</Name>`,
      `<Type>${recordType}</Type>`,
      `<TTL>${ttl}</TTL>`,
      `<ResourceRecords><ResourceRecord><Value>${value}</Value></ResourceRecord></ResourceRecords>`,
      `</ResourceRecordSet>`,
      `</Change></Changes></ChangeBatch>`,
      `</ChangeResourceRecordSetsRequest>`,
    ].join("");
    const headers = await signRequest({
      method: "POST",
      url,
      headers: { Host: host, "Content-Type": "application/xml" },
      body: bodyXml,
      service: "route53",
      credentials: ctx.creds,
    });
    const res = await fetch(url, { method: "POST", headers, body: bodyXml });
    if (!res.ok)
      throw new Error(`Route53 ChangeResourceRecordSets failed: ${res.status} ${await res.text()}`);
    const recordId = `${hostedZoneId}:${recordName}:${recordType}`;
    return {
      id: ctx.makeId(accountId, "route53-record-set", recordId),
      pluginId: "aws",
      resourceTypeId: "route53-record-set",
      accountId,
      displayName: `${recordName} (${recordType})`,
      fields: {
        name: recordName,
        type: recordType,
        ttl: Number(ttl),
        values: value,
        hostedZoneId,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: recordId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "acm-certificate") {
    const domainName = fields["domainName"] ?? "";
    const data = await ctx.json<{ CertificateArn?: string }>(
      "acm",
      "CertificateManager.RequestCertificate",
      {
        DomainName: domainName,
        ValidationMethod: fields["validationMethod"] ?? "DNS",
      },
    );
    const arn = data.CertificateArn ?? "";
    return {
      id: ctx.makeId(accountId, "acm-certificate", arn),
      pluginId: "aws",
      resourceTypeId: "acm-certificate",
      accountId,
      displayName: domainName,
      fields: {
        domainName,
        status: "PENDING_VALIDATION",
        type: "AMAZON_ISSUED",
        issuer: "",
        notBefore: "",
        notAfter: "",
        keyAlgorithm: "RSA_2048",
        subjectAlternativeNames: domainName,
        inUseBy: 0,
      },
      resolvedOutputs: { certificateArn: arn },
      secretStates: [],
      externalId: arn,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "api-gateway") {
    const name = fields["name"] ?? "";
    const protocolType = fields["protocolType"] ?? "HTTP";
    const description = fields["description"] ?? "";
    const host = ctx.hostForService("apigateway");
    const url = `https://${host}/v2/apis`;
    const bodyStr = JSON.stringify({
      name,
      protocolType,
      description,
    });
    const headers = await signRequest({
      method: "POST",
      url,
      headers: { Host: host, "Content-Type": "application/json" },
      body: bodyStr,
      service: "apigateway",
      credentials: ctx.creds,
    });
    const res = await fetch(url, { method: "POST", headers, body: bodyStr });
    if (!res.ok) throw new Error(`API Gateway create failed: ${res.status}: ${await res.text()}`);
    const result = (await res.json()) as Record<string, unknown>;
    const apiId = String(result["apiId"] ?? "");
    const now = new Date().toISOString();
    return {
      id: ctx.makeId(accountId, "api-gateway", apiId),
      pluginId: "aws",
      resourceTypeId: "api-gateway",
      accountId,
      displayName: name,
      fields: {
        name,
        apiId,
        protocolType,
        description,
        routeCount: 0,
        createdDate: now,
      },
      resolvedOutputs: {
        apiEndpoint: String(result["apiEndpoint"] ?? ""),
        apiId,
      },
      secretStates: [],
      externalId: apiId,
      createdAt: now,
      updatedAt: now,
    };
  }
  if (typeId === "waf-web-acl") {
    const name = fields["name"] ?? "";
    const scope = fields["scope"] ?? "REGIONAL";
    const defaultAction = fields["defaultAction"] === "BLOCK" ? { Block: {} } : { Allow: {} };
    const data = await ctx.json<{ Summary?: Record<string, unknown> }>(
      "wafv2",
      "AWSWAF_20190729.CreateWebACL",
      {
        Name: name,
        Scope: scope,
        DefaultAction: defaultAction,
        ...(fields["description"] ? { Description: fields["description"] } : {}),
        VisibilityConfig: {
          SampledRequestsEnabled: true,
          CloudWatchMetricsEnabled: true,
          MetricName: name,
        },
        Rules: [],
      },
    );
    const summary = data.Summary ?? {};
    return {
      id: ctx.makeId(accountId, "waf-web-acl", name),
      pluginId: "aws",
      resourceTypeId: "waf-web-acl",
      accountId,
      displayName: name,
      fields: {
        name,
        scope,
        description: fields["description"] ?? "",
        ruleCount: 0,
        defaultAction: fields["defaultAction"] ?? "ALLOW",
        capacity: 0,
      },
      resolvedOutputs: {
        webAclArn: String(summary["ARN"] ?? ""),
        webAclId: String(summary["Id"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  return null;
}
