import { describe, it, expect, vi } from "vitest";
import type { AwsCreateContext } from "../create-handlers/shared.js";
import { networkingCreateResource } from "../create-handlers/networking.js";
import { parseXml } from "../xml.js";

/**
 * ELBv2 speaks the AWS Query protocol: the created object sits under a
 * `<Action>Result` element inside the response root, and `parseXml` unwraps
 * only the root. These run the documented sample responses (Elastic Load
 * Balancing API Reference) through the real parser, so a handler reading
 * from the wrong level comes back with an empty ARN and fails here.
 */

const CREATE_TARGET_GROUP_XML = `<CreateTargetGroupResponse xmlns="http://elasticloadbalancing.amazonaws.com/doc/2015-12-01/">
  <CreateTargetGroupResult>
    <TargetGroups>
      <member>
        <TargetGroupArn>arn:aws:elasticloadbalancing:us-west-2:123456789012:targetgroup/my-targets/73e2d6bc24d8a067</TargetGroupArn>
        <HealthCheckTimeoutSeconds>5</HealthCheckTimeoutSeconds>
        <HealthCheckPort>traffic-port</HealthCheckPort>
        <Matcher>
          <HttpCode>200</HttpCode>
        </Matcher>
        <TargetGroupName>my-targets</TargetGroupName>
        <HealthCheckProtocol>HTTP</HealthCheckProtocol>
        <HealthCheckPath>/</HealthCheckPath>
        <Protocol>HTTP</Protocol>
        <Port>80</Port>
        <VpcId>vpc-3ac0fb5f</VpcId>
        <HealthyThresholdCount>5</HealthyThresholdCount>
        <HealthCheckIntervalSeconds>30</HealthCheckIntervalSeconds>
        <UnhealthyThresholdCount>2</UnhealthyThresholdCount>
      </member>
    </TargetGroups>
  </CreateTargetGroupResult>
  <ResponseMetadata>
    <RequestId>b83fe90e-f2d5-11e5-b95d-3b2c1831fc26</RequestId>
  </ResponseMetadata>
</CreateTargetGroupResponse>`;

const CREATE_LOAD_BALANCER_XML = `<CreateLoadBalancerResponse xmlns="http://elasticloadbalancing.amazonaws.com/doc/2015-12-01/">
  <CreateLoadBalancerResult>
    <LoadBalancers>
      <member>
        <LoadBalancerArn>arn:aws:elasticloadbalancing:us-west-2:123456789012:loadbalancer/app/my-load-balancer/50dc6c495c0c9188</LoadBalancerArn>
        <Scheme>internet-facing</Scheme>
        <LoadBalancerName>my-load-balancer</LoadBalancerName>
        <VpcId>vpc-3ac0fb5f</VpcId>
        <CanonicalHostedZoneId>Z2P70J7EXAMPLE</CanonicalHostedZoneId>
        <CreatedTime>2016-03-25T21:29:48.850Z</CreatedTime>
        <AvailabilityZones>
          <member>
            <SubnetId>subnet-8360a9e7</SubnetId>
            <ZoneName>us-west-2a</ZoneName>
          </member>
          <member>
            <SubnetId>subnet-b7d581c0</SubnetId>
            <ZoneName>us-west-2b</ZoneName>
          </member>
        </AvailabilityZones>
        <SecurityGroups>
          <member>sg-5943793c</member>
        </SecurityGroups>
        <DNSName>my-load-balancer-424835706.us-west-2.elb.amazonaws.com</DNSName>
        <State>
          <Code>provisioning</Code>
        </State>
        <Type>application</Type>
      </member>
    </LoadBalancers>
  </CreateLoadBalancerResult>
  <ResponseMetadata>
    <RequestId>32d531b2-f2d0-11e5-9192-3fff33344cfa</RequestId>
  </ResponseMetadata>
</CreateLoadBalancerResponse>`;

function makeCtx(xml: string): AwsCreateContext {
  const ctx = {
    creds: { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-west-2" },
    hostForService: (service: string) => `${service}.us-west-2.amazonaws.com`,
    ec2: vi.fn(),
    json: vi.fn(),
    ec2Query: vi.fn(async () => parseXml(xml)),
    queryPost: vi.fn(),
    xmlGet: vi.fn(),
    makeId: (accountId: string, typeId: string, externalId: string) =>
      `${accountId}:${typeId}:${externalId}`,
    listAllIAMPolicies: vi.fn(),
    policiesToOptions: vi.fn(),
    getResource: vi.fn(),
    withRegion: () => ctx,
  } as unknown as AwsCreateContext;
  return ctx;
}

describe("ELBv2 create handlers", () => {
  it("target-group reads the created group under CreateTargetGroupResult", async () => {
    const ctx = makeCtx(CREATE_TARGET_GROUP_XML);
    const tg = await networkingCreateResource(ctx, "target-group", "acct", {
      name: "my-targets",
      protocol: "HTTP",
      port: "80",
      vpcId: "vpc-3ac0fb5f",
      targetType: "instance",
      region: "us-west-2",
    });
    expect(ctx.ec2Query).toHaveBeenCalledWith(
      "elasticloadbalancing",
      "CreateTargetGroup",
      "2015-12-01",
      expect.objectContaining({ Name: "my-targets", VpcId: "vpc-3ac0fb5f" }),
    );
    expect(tg!.resolvedOutputs.targetGroupArn).toBe(
      "arn:aws:elasticloadbalancing:us-west-2:123456789012:targetgroup/my-targets/73e2d6bc24d8a067",
    );
    expect(tg!.fields).toMatchObject({
      healthCheckProtocol: "HTTP",
      healthCheckPath: "/",
      healthyThreshold: 5,
    });
  });

  it("alb reads the created balancer under CreateLoadBalancerResult", async () => {
    const ctx = makeCtx(CREATE_LOAD_BALANCER_XML);
    const lb = await networkingCreateResource(ctx, "alb", "acct", {
      name: "my-load-balancer",
      subnets: "subnet-8360a9e7, subnet-b7d581c0",
      region: "us-west-2",
    });
    expect(lb!.resolvedOutputs).toEqual({
      dnsName: "my-load-balancer-424835706.us-west-2.elb.amazonaws.com",
      loadBalancerArn:
        "arn:aws:elasticloadbalancing:us-west-2:123456789012:loadbalancer/app/my-load-balancer/50dc6c495c0c9188",
      canonicalHostedZoneId: "Z2P70J7EXAMPLE",
    });
    expect(lb!.fields).toMatchObject({ type: "application", vpcId: "vpc-3ac0fb5f" });
  });
});
