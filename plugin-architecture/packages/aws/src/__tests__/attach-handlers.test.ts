import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";

const ec2Call = vi.fn();
vi.mock("../client-transport.js", () => ({ ec2Call: (...a: unknown[]) => ec2Call(...a) }));

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

beforeEach(() => ec2Call.mockReset());

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

describe("attachResource unsupported", () => {
  it("throws", async () => {
    await expect(attachResource(ctx({}), "x", "s", "y", "t", "acct")).rejects.toThrow(
      /not supported/,
    );
  });
});
