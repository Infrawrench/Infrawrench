import { describe, expect, it } from "vitest";

import { AwsRequestError } from "../aws-errors.js";
import type { AwsCiCalls } from "../ci-calls.js";
import {
  AWS_CI_EXECUTOR,
  awsCiListTagged,
  ciListTagged,
  ciPreflight,
  ciStart,
  ciStatus,
  ciTeardown,
  defaultImage,
  runParams,
  userData,
  type Ec2Call,
} from "../ci-executor.js";

/** A fake EC2: answers each action from a table, recording what was sent. No network. */
function fakeEc2(answers: Record<string, (params: Record<string, string>) => unknown>) {
  const calls: Array<{ region: string; action: string; params: Record<string, string> }> = [];
  const call: Ec2Call = async <T>(region: string, action: string, params = {}) => {
    calls.push({ region, action, params });
    const answer = answers[action];
    if (!answer) throw new Error(`unexpected ${action}`);
    return answer(params) as T;
  };
  return { call, calls };
}

const err = (code: string) => new AwsRequestError(`${code}: no`, 412, code);

const spec = {
  kind: "vm" as const,
  bootstrap: "#!/bin/sh\necho hi\n",
  tags: { "infrawrench-ci": "org", "infrawrench-ci-job": "job-1" },
  name: "ci build",
  maxSeconds: 3600,
};

describe("runParams", () => {
  it("launches Ubuntu with the bootstrap, tags and a terminate-on-shutdown backstop", () => {
    const p = runParams(spec, "job-1");
    expect(p["ImageId"]).toBe(defaultImage("t3.large"));
    expect(p["InstanceType"]).toBe("t3.large");
    expect(p["InstanceInitiatedShutdownBehavior"]).toBe("terminate");
    expect(p["ClientToken"]).toBe("job-1");
    expect(p["MetadataOptions.HttpTokens"]).toBe("required");
    expect(p["TagSpecification.1.Tag.1.Key"]).toBe("infrawrench-ci");
    expect(p["TagSpecification.1.Tag.3.Key"]).toBe("Name");
    expect(p["TagSpecification.2.ResourceType"]).toBe("volume");
    const data = Buffer.from(p["UserData"] ?? "", "base64").toString("utf8");
    expect(data).toContain("shutdown -h +60");
    expect(data).toContain("echo hi");
    expect(data.trimEnd().endsWith("shutdown -h now")).toBe(true);
    expect(data.match(/^#!/gm)).toHaveLength(1);
  });

  it("picks the arm64 image for Graviton and keeps a custom image's own disks", () => {
    expect(runParams({ ...spec, machine: "c7g.large" }, "t")["ImageId"]).toContain("/arm64/");
    const custom = runParams({ ...spec, image: "ami-123" }, "t");
    expect(custom["ImageId"]).toBe("ami-123");
    expect(custom["BlockDeviceMapping.1.DeviceName"]).toBeUndefined();
  });

  it("rounds the backstop up to whole minutes", () => {
    expect(userData("true", 61)).toContain("shutdown -h +2");
  });
});

describe("ciPreflight", () => {
  it("is ok when every dry run is allowed and a default VPC exists", async () => {
    const { call, calls } = fakeEc2({
      RunInstances: () => Promise.reject(err("DryRunOperation")),
      DescribeInstances: () => Promise.reject(err("DryRunOperation")),
      TerminateInstances: () => Promise.reject(err("DryRunOperation")),
      DescribeVpcs: () => ({ vpcSet: { item: { vpcId: "vpc-1" } } }),
    });
    const result = await ciPreflight(call, "eu-west-1", "vm");
    expect(result).toEqual({ ok: true, missing: [], problems: [], region: "eu-west-1" });
    expect(calls.every((c) => c.action === "DescribeVpcs" || c.params["DryRun"] === "true")).toBe(
      true,
    );
  });

  it("names what a read-only key lacks, and a missing default VPC", async () => {
    const { call } = fakeEc2({
      RunInstances: () => Promise.reject(err("UnauthorizedOperation")),
      DescribeInstances: () => Promise.reject(err("DryRunOperation")),
      TerminateInstances: () => Promise.reject(err("UnauthorizedOperation")),
      DescribeVpcs: () => ({ vpcSet: null }),
    });
    const result = await ciPreflight(call, "eu-west-1", "vm", "us-east-2");
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.permission)).toEqual([
      "ec2:RunInstances",
      "ec2:CreateTags",
      "ec2:TerminateInstances",
    ]);
    expect(result.problems[0]).toContain("no default VPC in us-east-2");
  });

  it("refuses kinds it does not run", async () => {
    const { call } = fakeEc2({});
    await expect(ciPreflight(call, "eu-west-1", "build")).rejects.toThrow("`vm`");
  });
});

describe("the instance's life", () => {
  it("starts, follows, lists and terminates by id", async () => {
    const { call, calls } = fakeEc2({
      RunInstances: () => ({ instancesSet: { item: { instanceId: "i-1" } } }),
      DescribeInstances: (p) =>
        p["InstanceId.1"]
          ? {
              reservationSet: {
                item: {
                  instancesSet: { item: { instanceId: "i-1", instanceState: { name: "running" } } },
                },
              },
            }
          : {
              reservationSet: {
                item: [
                  {
                    instancesSet: {
                      item: {
                        instanceId: "i-2",
                        launchTime: "2026-11-13T00:00:00Z",
                        instanceState: { name: "stopped" },
                        tagSet: { item: [{ key: "infrawrench-ci", value: "org" }] },
                      },
                    },
                  },
                ],
              },
            },
      TerminateInstances: () => ({}),
    });
    const handle = await ciStart(call, "eu-west-1", { ...spec, region: "us-east-2" });
    expect(handle).toEqual({ id: "i-1", region: "us-east-2", label: "aws ec2 i-1 (us-east-2)" });
    expect(await ciStatus(call, "eu-west-1", handle)).toEqual({ state: "running" });
    const tagged = await ciListTagged(call, "eu-west-1", "infrawrench-ci", []);
    expect(tagged).toEqual([
      {
        handle: { id: "i-2", region: "eu-west-1", label: "aws ec2 i-2 (eu-west-1)" },
        tags: { "infrawrench-ci": "org" },
        createdAt: "2026-11-13T00:00:00Z",
        live: false,
      },
    ]);
    await ciTeardown(call, "eu-west-1", handle);
    expect(calls.at(-1)).toEqual({
      region: "us-east-2",
      action: "TerminateInstances",
      params: { "InstanceId.1": "i-1" },
    });
  });

  it("reads an instance EC2 no longer knows as gone, and its teardown as done", async () => {
    const { call } = fakeEc2({
      DescribeInstances: () => Promise.reject(err("InvalidInstanceID.NotFound")),
      TerminateInstances: () => Promise.reject(err("InvalidInstanceID.NotFound")),
    });
    const handle = { id: "i-9", region: "eu-west-1", label: "x" };
    expect(await ciStatus(call, "eu-west-1", handle)).toEqual({ state: "gone" });
    await expect(ciTeardown(call, "eu-west-1", handle)).resolves.toBeUndefined();
  });

  it("asks for an instance type when a GPU is wanted", async () => {
    const { call } = fakeEc2({});
    await expect(ciStart(call, "eu-west-1", { ...spec, gpu: "a10g" })).rejects.toThrow("g5.xlarge");
  });
});

describe("awsCiListTagged", () => {
  it("lists EC2, ECS and CodeBuild, and a kind the key may not read hides nothing", async () => {
    const { call } = fakeEc2({
      DescribeInstances: () => ({
        reservationSet: {
          item: {
            instancesSet: {
              item: {
                instanceId: "i-2",
                instanceState: { name: "running" },
                tagSet: { item: [{ key: "infrawrench-ci", value: "org" }] },
              },
            },
          },
        },
      }),
    });
    const calls: AwsCiCalls = {
      ec2: call,
      json: async () => {
        throw err("AccessDeniedException");
      },
      query: async () => {
        throw new Error("no IAM");
      },
      simulate: async () => null,
    };
    const tagged = await awsCiListTagged(call, calls, "eu-west-1", "infrawrench-ci", []);
    expect(tagged.map((t) => t.handle.id)).toEqual(["i-2"]);
  });

  it("declares the three kinds with sizes the rest of the code accepts", () => {
    expect(AWS_CI_EXECUTOR.kinds.map((k) => k.kind)).toEqual(["vm", "container", "build"]);
  });
});
