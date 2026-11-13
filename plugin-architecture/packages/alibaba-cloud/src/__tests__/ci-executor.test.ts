import { describe, expect, it } from "vitest";

import { autoReleaseTime, userData } from "../ci-ecs.js";
import { eciSize } from "../ci-eci.js";
import { plugin } from "../plugin.js";
import { makeClient, type Recorded, type Reply } from "./helpers.js";

const tags = {
  "infrawrench-ci": "org-Acme_01",
  "infrawrench-ci-run": "r1",
  "infrawrench-ci-job": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
};
const key = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const spec = { bootstrap: "#!/bin/sh\necho hi\n", tags, name: "ci build", maxSeconds: 3600 };

/** A region with a default VPC, a vSwitch that sells the type, Ubuntu, and the CI group. */
function region(opts: { group?: boolean; egress?: boolean } = {}) {
  const { group = true, egress = true } = opts;
  return (req: Recorded): Reply | undefined => {
    switch (req.action) {
      case "DescribeVpcs":
        return { body: { Vpcs: { Vpc: [{ VpcId: "vpc-default" }] } } };
      case "DescribeVSwitches":
        return {
          body: {
            VSwitches: {
              VSwitch: [
                { VSwitchId: "vsw-a", VpcId: "vpc-default", ZoneId: "ap-southeast-1a" },
                { VSwitchId: "vsw-b", VpcId: "vpc-default", ZoneId: "ap-southeast-1b" },
              ],
            },
          },
        };
      case "DescribeAvailableResource":
        return {
          body: {
            AvailableZones: {
              AvailableZone: [
                {
                  ZoneId: "ap-southeast-1b",
                  Status: "Available",
                  AvailableResources: {
                    AvailableResource: [
                      { SupportedResources: { SupportedResource: [{ Value: "ecs.g8i.large" }] } },
                    ],
                  },
                },
              ],
            },
          },
        };
      case "DescribeInstanceTypes":
        return { body: { InstanceTypes: { InstanceType: [{ CpuArchitecture: "X86" }] } } };
      case "DescribeImages":
        return {
          body: {
            Images: {
              Image: [
                {
                  ImageId: "ubuntu_24_04_x64_20G_alibase_20260916.vhd",
                  OSNameEn: "Ubuntu  24.04 64 bit",
                },
              ],
            },
          },
        };
      case "DescribeSecurityGroups":
        return {
          body: { SecurityGroups: { SecurityGroup: group ? [{ SecurityGroupId: "sg-ci" }] : [] } },
        };
      case "CreateSecurityGroup":
        return { body: { SecurityGroupId: "sg-ci" } };
      case "DescribeSecurityGroupAttribute":
        return {
          body: {
            Permissions: {
              Permission: egress ? [{ DestCidrIp: "0.0.0.0/0", Policy: "Accept" }] : [],
            },
          },
        };
      case "AuthorizeSecurityGroupEgress":
        return { body: {} };
      default:
        return undefined;
    }
  };
}

const NOW = Date.parse("2026-11-13T10:00:30Z");

describe("Alibaba Cloud CI executor", () => {
  it("declares vm and container", () => {
    expect(plugin.manifest.ciExecutor?.kinds.map((k) => k.kind)).toEqual(["vm", "container"]);
  });

  it("runs an ECS instance with a client token, tags, an auto-release time and no RAM role", async () => {
    const base = region();
    const { client, calls } = makeClient((req) => {
      if (req.action === "RunInstances") {
        return { body: { InstanceIdSets: { InstanceIdSet: ["i-job"] } } };
      }
      return base(req);
    });
    const handle = await client.ciStart!({ ...spec, kind: "vm" });
    expect(handle).toMatchObject({ id: "i-job", region: "ap-southeast-1", data: { kind: "vm" } });
    const run = calls.find((c) => c.action === "RunInstances")!;
    expect(run.url.host).toBe("ecs.ap-southeast-1.aliyuncs.com");
    expect(run.headers["authorization"]).toMatch(/^ACS3-HMAC-SHA256 /);
    const p = run.params;
    expect(p).toMatchObject({
      ZoneId: "ap-southeast-1b",
      VSwitchId: "vsw-b",
      SecurityGroupId: "sg-ci",
      InstanceType: "ecs.g8i.large",
      ImageId: "ubuntu_24_04_x64_20G_alibase_20260916.vhd",
      InstanceName: `iwci-${key}`,
      InstanceChargeType: "PostPaid",
      HttpTokens: "required",
      "Tag.1.Key": "infrawrench-ci",
      "Tag.1.Value": "org-Acme_01",
      "Tag.3.Value": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
    });
    expect(p["ClientToken"]).toMatch(/^[0-9a-f]{32}$/);
    expect(p["AutoReleaseTime"]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:00Z$/);
    expect(p["RamRoleName"]).toBeUndefined();
    expect(Number(p["InternetMaxBandwidthOut"])).toBeGreaterThan(0);
    expect(atob(p["UserData"]!)).toContain("echo hi");
    // The group was there and open outbound: nothing made.
    expect(calls.some((c) => c.action === "CreateSecurityGroup")).toBe(false);
    expect(calls.some((c) => c.action === "AuthorizeSecurityGroupEgress")).toBe(false);
  });

  it("makes the CI group in a new region: enterprise, tagged for the network, open outbound only", async () => {
    const base = region({ group: false, egress: false });
    const { client, calls } = makeClient((req) => {
      if (req.action === "RunInstances") {
        return { body: { InstanceIdSets: { InstanceIdSet: ["i-job"] } } };
      }
      return base(req);
    });
    await client.ciStart!({ ...spec, kind: "vm" });
    const created = calls.find((c) => c.action === "CreateSecurityGroup")!.params;
    expect(created).toMatchObject({
      VpcId: "vpc-default",
      SecurityGroupName: "infrawrench-ci",
      SecurityGroupType: "enterprise",
      "Tag.1.Key": "infrawrench-ci-network",
    });
    const egress = calls.find((c) => c.action === "AuthorizeSecurityGroupEgress")!.params;
    expect(egress).toMatchObject({
      SecurityGroupId: "sg-ci",
      "Permissions.1.IpProtocol": "ALL",
      "Permissions.1.PortRange": "-1/-1",
      "Permissions.1.DestCidrIp": "0.0.0.0/0",
      "Permissions.1.Policy": "accept",
    });
    expect(calls.some((c) => c.action === "AuthorizeSecurityGroup")).toBe(false);
  });

  it("starts an ECI group that never restarts, ends at the deadline and has a public address", async () => {
    const base = region();
    const { client, calls } = makeClient((req) => {
      if (req.action === "CreateContainerGroup") return { body: { ContainerGroupId: "eci-job" } };
      return base(req);
    });
    const handle = await client.ciStart!({ ...spec, kind: "container", machine: "4vcpu-8gb" });
    expect(handle).toMatchObject({ id: "eci-job", data: { kind: "container" } });
    const create = calls.find((c) => c.action === "CreateContainerGroup")!;
    expect(create.url.host).toBe("eci.ap-southeast-1.aliyuncs.com");
    expect(create.params).toMatchObject({
      VSwitchId: "vsw-a,vsw-b",
      SecurityGroupId: "sg-ci",
      ContainerGroupName: `iwci-${key}`,
      RestartPolicy: "Never",
      Cpu: "4",
      Memory: "8",
      AutoCreateEip: "true",
      ActiveDeadlineSeconds: "3600",
      "Container.1.Image": "docker.io/library/buildpack-deps:noble-curl",
      "Container.1.Command.1": "/bin/sh",
      "Container.1.Command.2": "-c",
      "Tag.2.Key": "infrawrench-ci-run",
    });
    expect(create.params["Container.1.Arg.3"]).toContain("echo hi");
    expect(create.params["RamRoleName"]).toBeUndefined();
  });

  it("reads status, releases instances and groups, and cleans up an address ECI leaves", async () => {
    let eipStatus = "InUse";
    const { client, calls } = makeClient((req) => {
      switch (req.action) {
        case "DescribeInstances":
          return req.params["InstanceIds"] === '["i-gone"]'
            ? { body: { Instances: { Instance: [] } } }
            : { body: { Instances: { Instance: [{ InstanceId: "i-job", Status: "Running" }] } } };
        case "DeleteInstances":
          return req.params["InstanceId.1"] === "i-gone"
            ? { status: 404, body: { Code: "InvalidInstanceIds.NotFound", Message: "" } }
            : { body: {} };
        case "DescribeContainerGroups":
          return {
            body: { ContainerGroups: [{ ContainerGroupId: "eci-job", Status: "Succeeded" }] },
          };
        case "DescribeEipAddresses":
          if (req.params["AssociatedInstanceId"]) {
            return {
              body: { EipAddresses: { EipAddress: [{ AllocationId: "eip-1", Status: "InUse" }] } },
            };
          }
          return {
            body: { EipAddresses: { EipAddress: [{ AllocationId: "eip-1", Status: eipStatus }] } },
          };
        case "DeleteContainerGroup":
          eipStatus = "Available";
          return { body: {} };
        case "ReleaseEipAddress":
          return { body: {} };
        default:
          return undefined;
      }
    });
    const vm = { id: "i-job", region: "ap-southeast-1", label: "", data: { kind: "vm" } };
    expect(await client.ciStatus!(vm)).toMatchObject({ state: "running" });
    expect(await client.ciStatus!({ ...vm, id: "i-gone" })).toEqual({ state: "gone" });
    await client.ciTeardown!(vm);
    expect(calls.find((c) => c.action === "DeleteInstances")!.params["Force"]).toBe("true");
    await client.ciTeardown!({ ...vm, id: "i-gone" });

    const group = {
      id: "eci-job",
      region: "ap-southeast-1",
      label: "",
      data: { kind: "container" },
    };
    expect(await client.ciStatus!(group)).toMatchObject({ state: "stopped" });
    await client.ciTeardown!(group);
    expect(calls.find((c) => c.action === "ReleaseEipAddress")!.params["AllocationId"]).toBe(
      "eip-1",
    );
  });

  it("lists what is tagged across both kinds", async () => {
    const { client, calls } = makeClient((req) => {
      if (req.action === "DescribeInstances") {
        return {
          body: {
            Instances: {
              Instance: [
                {
                  InstanceId: "i-job",
                  Status: "Stopped",
                  CreationTime: "2026-11-13T10:00Z",
                  Tags: {
                    Tag: Object.entries(tags).map(([TagKey, TagValue]) => ({ TagKey, TagValue })),
                  },
                },
              ],
            },
          },
        };
      }
      if (req.action === "DescribeContainerGroups") {
        return {
          body: {
            ContainerGroups: [
              {
                ContainerGroupId: "eci-job",
                Status: "Running",
                Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
              },
              {
                ContainerGroupId: "eci-other",
                Status: "Running",
                Tags: [{ Key: "team", Value: "web" }],
              },
            ],
          },
        };
      }
      return undefined;
    });
    const listed = await client.ciListTagged!("infrawrench-ci", ["ap-southeast-1"]);
    expect(listed.map((t) => [t.handle.id, t.live])).toEqual([
      ["i-job", false],
      ["eci-job", true],
    ]);
    expect(listed[0]!.tags).toEqual(tags);
    expect(calls.find((c) => c.action === "DescribeContainerGroups")!.params["Limit"]).toBe("20");
    expect(calls.find((c) => c.action === "DescribeInstances")!.params["Tag.1.Key"]).toBe(
      "infrawrench-ci",
    );
  });

  it("names refused actions in preflight and passes dry runs", async () => {
    const base = region();
    const { client } = makeClient((req) => {
      switch (req.action) {
        case "DescribeInstances":
          return { status: 403, body: { Code: "Forbidden.RAM", Message: "no" } };
        case "DeleteInstances":
          return { status: 400, body: { Code: "DRYRUN.SUCCESS", Message: "ok" } };
        case "RunInstances":
          expect(req.params["DryRun"]).toBe("true");
          return { status: 403, body: { Code: "Forbidden.RAM", Message: "no" } };
        case "DescribeEipAddresses":
          return { body: { EipAddresses: { EipAddress: [] } } };
        case "CreateContainerGroup":
          return {
            status: 403,
            body: {
              Code: "CreateServiceLinkedRole.Denied",
              Message: "make sure the account has ram:CreateServiceLinkedRole permission",
            },
          };
        default:
          return base(req);
      }
    });
    const vm = await client.ciPreflight!("vm");
    expect(vm.ok).toBe(false);
    expect(vm.missing.map((m) => m.permission)).toEqual([
      "ecs:DescribeInstances",
      "ecs:RunInstances",
    ]);
    const container = await client.ciPreflight!("container");
    expect(container.missing.map((m) => m.permission)).toEqual(["eci:CreateContainerGroup"]);
    const nowhere = await client.ciPreflight!("container", "eu-west-3");
    expect(nowhere.problems[0]).toContain("not offered in eu-west-3");
  });
});

describe("Alibaba Cloud CI helpers", () => {
  it("releases at the deadline, never under Alibaba's 30 minutes, on a whole minute", () => {
    expect(autoReleaseTime(NOW, 3600)).toBe("2026-11-13T11:01:00Z");
    expect(autoReleaseTime(NOW, 60)).toBe("2026-11-13T10:32:00Z");
  });

  it("sizes container groups and writes the user data", () => {
    expect(eciSize("2vcpu-4gb")).toEqual({ Cpu: 2, Memory: 4 });
    expect(() => eciSize("ecs.g8i.large")).toThrow("vcpu");
    expect(userData("#!/bin/sh\nx\n", 600)).toMatch(/^#!\/bin\/bash\nshutdown -h \+10 /);
  });
});
