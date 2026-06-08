import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";

const ec2Call = vi.fn();
const ec2QueryCall = vi.fn();
const fetchSigned = vi.fn();
vi.mock("../client-transport.js", () => ({
  ec2Call: (...a: unknown[]) => ec2Call(...a),
  ec2QueryCall: (...a: unknown[]) => ec2QueryCall(...a),
  hostForService: () => "route53.amazonaws.com",
}));
vi.mock("../signed-request.js", () => ({ fetchSigned: (...a: unknown[]) => fetchSigned(...a) }));

import { attachResource } from "../attach-handlers.js";

const creds = { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-1" };

function res(
  fields: Record<string, unknown>,
  ro: Record<string, unknown> = {},
  externalId = "ext",
): ResourceInstance {
  return {
    id: "id",
    pluginId: "aws",
    resourceTypeId: "t",
    accountId: "acct",
    displayName: "d",
    fields,
    resolvedOutputs: ro,
    secretStates: [],
    externalId,
    createdAt: "",
    updatedAt: "",
  } as ResourceInstance;
}

function ctx(map: Record<string, ResourceInstance>) {
  return {
    creds,
    credsFor: (region: string) => ({ ...creds, region }),
    getResource: vi.fn(async (typeId: string) => map[typeId]!),
  };
}

beforeEach(() => {
  ec2Call.mockReset();
  ec2QueryCall.mockReset();
  fetchSigned.mockReset();
});

describe("attachResource elastic-ip → ec2", () => {
  it("associates the address", async () => {
    ec2Call.mockResolvedValue({});
    const c = ctx({
      "elastic-ip": res({ allocationId: "eipalloc-1" }),
      "ec2-instance": res({ instanceId: "i-1", region: "us-west-2" }),
    });
    await attachResource(c, "elastic-ip", "s", "ec2-instance", "t", "acct");
    expect(ec2Call.mock.calls[0]![1]).toBe("AssociateAddress");
  });
  it("throws if ids missing", async () => {
    const c = ctx({ "elastic-ip": res({}), "ec2-instance": res({}) });
    await expect(attachResource(c, "elastic-ip", "s", "ec2-instance", "t", "acct")).rejects.toThrow(
      /AllocationId/,
    );
  });
});

describe("attachResource ebs-volume → ec2", () => {
  it("attaches volume in matching AZ", async () => {
    ec2Call.mockResolvedValue({});
    const c = ctx({
      "ebs-volume": res({ volumeId: "vol-1", availabilityZone: "us-east-1a" }),
      "ec2-instance": res({ instanceId: "i-1", availabilityZone: "us-east-1a" }),
    });
    await attachResource(c, "ebs-volume", "s", "ec2-instance", "t", "acct");
    const params = ec2Call.mock.calls[0]![2] as Record<string, string>;
    expect(params["Device"]).toBe("/dev/sdf");
  });
  it("throws on AZ mismatch", async () => {
    const c = ctx({
      "ebs-volume": res({ volumeId: "vol-1", availabilityZone: "us-east-1a" }),
      "ec2-instance": res({ instanceId: "i-1", availabilityZone: "us-east-1b" }),
    });
    await expect(attachResource(c, "ebs-volume", "s", "ec2-instance", "t", "acct")).rejects.toThrow(
      /AZ/,
    );
  });
  it("throws when ids missing", async () => {
    const c = ctx({ "ebs-volume": res({}, {}, ""), "ec2-instance": res({}, {}, "") });
    await expect(attachResource(c, "ebs-volume", "s", "ec2-instance", "t", "acct")).rejects.toThrow(
      /VolumeId/,
    );
  });
});

describe("attachResource security-group → ec2", () => {
  it("appends the SG to the instance's existing groups", async () => {
    ec2Call.mockImplementation(async (_c, action) => {
      if (action === "DescribeInstances") {
        return {
          reservationSet: {
            item: { instancesSet: { item: { groupSet: { item: { groupId: "sg-existing" } } } } },
          },
        };
      }
      return {};
    });
    const c = ctx({
      "security-group": res({ groupId: "sg-new" }),
      "ec2-instance": res({ instanceId: "i-1" }),
    });
    await attachResource(c, "security-group", "s", "ec2-instance", "t", "acct");
    const modify = ec2Call.mock.calls.find((cl) => cl[1] === "ModifyInstanceAttribute")!;
    const params = modify[2] as Record<string, string>;
    expect(params["GroupId.1"]).toBe("sg-existing");
    expect(params["GroupId.2"]).toBe("sg-new");
  });
  it("no-ops when SG already attached", async () => {
    ec2Call.mockResolvedValue({
      reservationSet: {
        item: { instancesSet: { item: { groupSet: { item: { groupId: "sg-new" } } } } },
      },
    });
    const c = ctx({
      "security-group": res({ groupId: "sg-new" }),
      "ec2-instance": res({ instanceId: "i-1" }),
    });
    await attachResource(c, "security-group", "s", "ec2-instance", "t", "acct");
    expect(ec2Call.mock.calls.some((cl) => cl[1] === "ModifyInstanceAttribute")).toBe(false);
  });
  it("throws when ids missing", async () => {
    const c = ctx({ "security-group": res({}, {}, ""), "ec2-instance": res({}, {}, "") });
    await expect(
      attachResource(c, "security-group", "s", "ec2-instance", "t", "acct"),
    ).rejects.toThrow(/security group/);
  });
});

describe("attachResource target-group → ec2", () => {
  it("registers the instance as a target", async () => {
    ec2QueryCall.mockResolvedValue({});
    const c = ctx({
      "target-group": res(
        { targetType: "instance", vpcId: "vpc-1", region: "us-east-2" },
        { targetGroupArn: "arn:aws:elasticloadbalancing:us-east-2:1:targetgroup/tg/abc" },
      ),
      "ec2-instance": res({ instanceId: "i-1", vpcId: "vpc-1", region: "us-east-2" }),
    });
    await attachResource(c, "target-group", "s", "ec2-instance", "t", "acct");
    expect(ec2QueryCall.mock.calls[0]![1]).toBe("elasticloadbalancing");
    expect(ec2QueryCall.mock.calls[0]![2]).toBe("RegisterTargets");
    expect(ec2QueryCall.mock.calls[0]![4]).toMatchObject({
      TargetGroupArn: "arn:aws:elasticloadbalancing:us-east-2:1:targetgroup/tg/abc",
      "Targets.member.1.Id": "i-1",
    });
  });

  it("rejects non-instance target groups", async () => {
    const c = ctx({
      "target-group": res({ targetType: "ip" }, { targetGroupArn: "arn:tg" }),
      "ec2-instance": res({ instanceId: "i-1" }),
    });
    await expect(
      attachResource(c, "target-group", "s", "ec2-instance", "t", "acct"),
    ).rejects.toThrow(/cannot register EC2 instances/);
  });

  it("rejects VPC mismatch", async () => {
    const c = ctx({
      "target-group": res({ targetType: "instance", vpcId: "vpc-a" }, { targetGroupArn: "arn:tg" }),
      "ec2-instance": res({ instanceId: "i-1", vpcId: "vpc-b" }),
    });
    await expect(
      attachResource(c, "target-group", "s", "ec2-instance", "t", "acct"),
    ).rejects.toThrow(/does not match instance VPC/);
  });

  it("throws when ids are missing", async () => {
    const c = ctx({ "target-group": res({}, {}, ""), "ec2-instance": res({}, {}, "") });
    await expect(
      attachResource(c, "target-group", "s", "ec2-instance", "t", "acct"),
    ).rejects.toThrow(/TargetGroupArn/);
  });
});

describe("attachResource internet-gateway → vpc", () => {
  it("attaches the internet gateway to the VPC", async () => {
    ec2Call.mockResolvedValue({});
    const c = ctx({
      "internet-gateway": res({ internetGatewayId: "igw-1", region: "us-west-1" }),
      vpc: res({ vpcId: "vpc-1", region: "us-west-1" }),
    });
    await attachResource(c, "internet-gateway", "s", "vpc", "t", "acct");
    expect(ec2Call.mock.calls[0]![1]).toBe("AttachInternetGateway");
    expect(ec2Call.mock.calls[0]![2]).toEqual({
      InternetGatewayId: "igw-1",
      VpcId: "vpc-1",
    });
  });

  it("no-ops when already attached to the VPC", async () => {
    const c = ctx({
      "internet-gateway": res({ internetGatewayId: "igw-1", vpcId: "vpc-1" }),
      vpc: res({ vpcId: "vpc-1" }),
    });
    await attachResource(c, "internet-gateway", "s", "vpc", "t", "acct");
    expect(ec2Call).not.toHaveBeenCalled();
  });

  it("throws when ids are missing", async () => {
    const c = ctx({ "internet-gateway": res({}, {}, ""), vpc: res({}, {}, "") });
    await expect(attachResource(c, "internet-gateway", "s", "vpc", "t", "acct")).rejects.toThrow(
      /InternetGatewayId/,
    );
  });
});

describe("attachResource route-table → subnet", () => {
  it("associates the route table to the subnet", async () => {
    ec2Call.mockResolvedValue({});
    const c = ctx({
      "route-table": res({ routeTableId: "rtb-1", vpcId: "vpc-1", region: "us-east-1" }),
      subnet: res({ subnetId: "subnet-1", vpcId: "vpc-1", region: "us-east-1" }),
    });
    await attachResource(c, "route-table", "s", "subnet", "t", "acct");
    expect(ec2Call.mock.calls[0]![1]).toBe("AssociateRouteTable");
    expect(ec2Call.mock.calls[0]![2]).toEqual({
      RouteTableId: "rtb-1",
      SubnetId: "subnet-1",
    });
  });

  it("rejects VPC mismatch", async () => {
    const c = ctx({
      "route-table": res({ routeTableId: "rtb-1", vpcId: "vpc-a" }),
      subnet: res({ subnetId: "subnet-1", vpcId: "vpc-b" }),
    });
    await expect(attachResource(c, "route-table", "s", "subnet", "t", "acct")).rejects.toThrow(
      /does not match subnet VPC/,
    );
  });
});

describe("attachResource internet-gateway → route-table", () => {
  it("creates a default route to the internet gateway", async () => {
    ec2Call.mockResolvedValue({});
    const c = ctx({
      "internet-gateway": res({ internetGatewayId: "igw-1", vpcId: "vpc-1" }),
      "route-table": res({ routeTableId: "rtb-1", vpcId: "vpc-1" }),
    });
    await attachResource(c, "internet-gateway", "s", "route-table", "t", "acct");
    expect(ec2Call.mock.calls[0]![1]).toBe("CreateRoute");
    expect(ec2Call.mock.calls[0]![2]).toEqual({
      RouteTableId: "rtb-1",
      DestinationCidrBlock: "0.0.0.0/0",
      GatewayId: "igw-1",
    });
  });

  it("replaces the default route when it already exists", async () => {
    ec2Call
      .mockRejectedValueOnce(new Error("InvalidRoute.Duplicate: RouteAlreadyExists"))
      .mockResolvedValueOnce({});
    const c = ctx({
      "internet-gateway": res({ internetGatewayId: "igw-1", vpcId: "vpc-1" }),
      "route-table": res({ routeTableId: "rtb-1", vpcId: "vpc-1" }),
    });
    await attachResource(c, "internet-gateway", "s", "route-table", "t", "acct");
    expect(ec2Call.mock.calls[1]![1]).toBe("ReplaceRoute");
  });
});

describe("attachResource nat-gateway → route-table", () => {
  it("creates a default route to the NAT gateway", async () => {
    ec2Call.mockResolvedValue({});
    const c = ctx({
      "nat-gateway": res({ natGatewayId: "nat-1", vpcId: "vpc-1" }),
      "route-table": res({ routeTableId: "rtb-1", vpcId: "vpc-1" }),
    });
    await attachResource(c, "nat-gateway", "s", "route-table", "t", "acct");
    expect(ec2Call.mock.calls[0]![1]).toBe("CreateRoute");
    expect(ec2Call.mock.calls[0]![2]).toEqual({
      RouteTableId: "rtb-1",
      DestinationCidrBlock: "0.0.0.0/0",
      NatGatewayId: "nat-1",
    });
  });
});

describe("attachResource auto-scaling-group → target-group", () => {
  it("attaches the target group to the Auto Scaling group", async () => {
    ec2QueryCall.mockResolvedValue({});
    const c = ctx({
      "auto-scaling-group": res({ name: "asg-1", region: "us-east-2" }, {}, "asg-1"),
      "target-group": res(
        { region: "us-east-2" },
        { targetGroupArn: "arn:aws:elasticloadbalancing:us-east-2:1:targetgroup/tg/abc" },
      ),
    });
    await attachResource(c, "auto-scaling-group", "s", "target-group", "t", "acct");
    expect(ec2QueryCall.mock.calls[0]![1]).toBe("autoscaling");
    expect(ec2QueryCall.mock.calls[0]![2]).toBe("AttachLoadBalancerTargetGroups");
    expect(ec2QueryCall.mock.calls[0]![4]).toEqual({
      AutoScalingGroupName: "asg-1",
      "TargetGroupARNs.member.1": "arn:aws:elasticloadbalancing:us-east-2:1:targetgroup/tg/abc",
    });
  });

  it("throws when ids are missing", async () => {
    const c = ctx({
      "auto-scaling-group": res({}, {}, ""),
      "target-group": res({}, {}, ""),
    });
    await expect(
      attachResource(c, "auto-scaling-group", "s", "target-group", "t", "acct"),
    ).rejects.toThrow(/AutoScalingGroupName/);
  });
});

describe("attachResource route53-record-set → alb", () => {
  it("upserts an alias record to the load balancer", async () => {
    fetchSigned.mockResolvedValue({});
    const c = ctx({
      "route53-record-set": res({
        hostedZoneId: "ZROOT",
        name: "app.example.com.",
        type: "A",
      }),
      alb: res(
        {},
        {
          dnsName: "lb-123.us-east-1.elb.amazonaws.com",
          canonicalHostedZoneId: "ZLB",
        },
      ),
    });
    await attachResource(c, "route53-record-set", "s", "alb", "t", "acct");
    const arg = fetchSigned.mock.calls[0]![0] as {
      method: string;
      url: string;
      body: string;
    };
    expect(arg.method).toBe("POST");
    expect(arg.url).toContain("/2013-04-01/hostedzone/ZROOT/rrset");
    expect(arg.body).toContain("<Action>UPSERT</Action>");
    expect(arg.body).toContain("<AliasTarget>");
    expect(arg.body).toContain("<HostedZoneId>ZLB</HostedZoneId>");
    expect(arg.body).toContain("<DNSName>lb-123.us-east-1.elb.amazonaws.com</DNSName>");
  });

  it("rejects non-A/AAAA record types", async () => {
    const c = ctx({
      "route53-record-set": res({ hostedZoneId: "ZROOT", name: "app.example.com.", type: "CNAME" }),
      alb: res({}, { dnsName: "lb.example.com", canonicalHostedZoneId: "ZLB" }),
    });
    await expect(attachResource(c, "route53-record-set", "s", "alb", "t", "acct")).rejects.toThrow(
      /must be A or AAAA/,
    );
  });
});

describe("attachResource unsupported", () => {
  it("throws", async () => {
    await expect(attachResource(ctx({}), "x", "s", "y", "t", "acct")).rejects.toThrow(
      /not supported/,
    );
  });
});
