import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { alibabaRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
): RemediationResource {
  return { resourceTypeId, displayName: "web-1", externalId, fields };
}

function lines(finding: RemediationFinding): string[] {
  return alibabaRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

const orphan = (resource: RemediationResource): RemediationFinding => ({
  kind: "orphan",
  reason: "unused",
  resource,
});

const oversized = (fields: RemediationResource["fields"]): RemediationFinding => ({
  kind: "oversized",
  resource: res("ecs-instance", "cn-hangzhou/i-abc", fields),
  sizeFieldKey: "instanceType",
  currentSize: "ecs.g7.xlarge",
  targetSize: "ecs.g7.large",
  region: "cn-hangzhou",
});

describe("alibabaRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(alibabaRemediationCommands);
  });

  it("stops, resizes and starts a pay-as-you-go instance", () => {
    expect(lines(oversized({ chargeType: "PostPaid" }))).toMatchInlineSnapshot(`
      [
        "- aliyun ecs StopInstance --RegionId cn-hangzhou --InstanceId i-abc",
        "- aliyun ecs ModifyInstanceSpec --RegionId cn-hangzhou --InstanceId i-abc --InstanceType ecs.g7.large",
        "- aliyun ecs StartInstance --RegionId cn-hangzhou --InstanceId i-abc",
      ]
    `);
  });

  it("uses the prepay spec change for a subscription instance", () => {
    expect(lines(oversized({ chargeType: "PrePaid" }))[1]).toBe(
      "- aliyun ecs ModifyPrepayInstanceSpec --RegionId cn-hangzhou --InstanceId i-abc --InstanceType ecs.g7.large --AutoPay true",
    );
  });

  it("stops in economical mode for a sleep schedule", () => {
    expect(
      lines({
        kind: "sleep-schedule",
        resource: res("ecs-instance", "cn-hangzhou/i-abc", { chargeType: "PostPaid" }),
      }),
    ).toMatchInlineSnapshot(`
      [
        "- aliyun ecs StopInstance --RegionId cn-hangzhou --InstanceId i-abc --StoppedMode StopCharging",
        "- aliyun ecs StartInstance --RegionId cn-hangzhou --InstanceId i-abc",
      ]
    `);
  });

  it("deactivates and activates a CLB for a sleep schedule", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("slb", "cn-hangzhou/lb-1") }))
      .toMatchInlineSnapshot(`
      [
        "- aliyun slb SetLoadBalancerStatus --RegionId cn-hangzhou --LoadBalancerId lb-1 --LoadBalancerStatus inactive",
        "- aliyun slb SetLoadBalancerStatus --RegionId cn-hangzhou --LoadBalancerId lb-1 --LoadBalancerStatus active",
      ]
    `);
  });

  it("images then deletes a stopped pay-as-you-go instance", () => {
    expect(lines(orphan(res("ecs-instance", "cn-hangzhou/i-abc", { chargeType: "PostPaid" }))))
      .toMatchInlineSnapshot(`
      [
        "- aliyun ecs CreateImage --RegionId cn-hangzhou --InstanceId i-abc --ImageName iw-i-abc-20261007",
        "! aliyun ecs DeleteInstance --RegionId cn-hangzhou --InstanceId i-abc --Force true",
      ]
    `);
  });

  it("turns off renewal for a stopped subscription instance", () => {
    expect(
      lines(orphan(res("ecs-instance", "cn-hangzhou/i-abc", { chargeType: "PrePaid" }))),
    ).toEqual([
      "- aliyun ecs ModifyInstanceAutoRenewAttribute --RegionId cn-hangzhou --InstanceId i-abc --RenewalStatus NotRenewal",
    ]);
  });

  it("snapshots then deletes an unattached disk", () => {
    expect(lines(orphan(res("disk", "cn-hangzhou/d-1")))).toMatchInlineSnapshot(`
      [
        "- aliyun ecs CreateSnapshot --RegionId cn-hangzhou --DiskId d-1 --SnapshotName iw-d-1-20261007",
        "! aliyun ecs DeleteDisk --RegionId cn-hangzhou --DiskId d-1",
      ]
    `);
  });

  it("releases a pay-as-you-go EIP but not a subscription one", () => {
    expect(lines(orphan(res("eip", "cn-hangzhou/eip-1", { chargeType: "PostPaid" })))).toEqual([
      "! aliyun vpc ReleaseEipAddress --RegionId cn-hangzhou --AllocationId eip-1",
    ]);
    expect(lines(orphan(res("eip", "cn-hangzhou/eip-1", { chargeType: "PrePaid" })))).toEqual([]);
  });

  it("quotes hostile ids and falls back to the region field", () => {
    expect(lines(orphan(res("eip", "x; rm -rf ~", { region: "cn-beijing" })))).toEqual([
      "! aliyun vpc ReleaseEipAddress --RegionId cn-beijing --AllocationId 'x; rm -rf ~'",
    ]);
  });

  it("returns nothing without an id or for unsupported findings", () => {
    expect(lines(orphan(res("disk", null)))).toEqual([]);
    expect(lines(orphan(res("disk", "d-1")))).toEqual([]);
    expect(lines(orphan(res("vpc", "cn-hangzhou/vpc-1")))).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("disk", "cn-hangzhou/d-1") })).toEqual([]);
  });
});
