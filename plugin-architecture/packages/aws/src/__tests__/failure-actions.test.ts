import { describe, expect, it } from "vitest";
import {
  ecsServiceRef,
  injectEcsFailure,
  prepareEcsFailure,
  undoEcsFailure,
  type EcsCall,
} from "../failure-actions.js";
import { ECSServiceResourceType } from "../resources/ecs-service.js";

function fakeEcs(desiredCount: number): {
  call: EcsCall;
  calls: { target: string; body: Record<string, unknown> }[];
} {
  const calls: { target: string; body: Record<string, unknown> }[] = [];
  const call = (async (target: string, body: Record<string, unknown>) => {
    calls.push({ target, body });
    if (target.endsWith("UpdateService")) desiredCount = Number(body["desiredCount"]);
    return { services: [{ desiredCount, status: "ACTIVE" }] };
  }) as EcsCall;
  return { call, calls };
}

const ref = { cluster: "prod", service: "checkout" };

describe("ECS scale-to-zero", () => {
  it("is declared on the ECS service type", () => {
    expect(ECSServiceResourceType.failureActions?.map((a) => a.id)).toEqual(["scale-to-zero"]);
  });

  it("reads the desired count, scales to zero and restores it", async () => {
    const { call, calls } = fakeEcs(4);
    const prepared = await prepareEcsFailure(call, ref, "ecs-service", "scale-to-zero");
    expect(prepared).toEqual({
      undo: { desiredCount: 4 },
      alreadyInEffect: false,
      currentState: "4 desired tasks",
    });
    await injectEcsFailure(call, ref, "ecs-service", "scale-to-zero");
    await undoEcsFailure(call, ref, "ecs-service", "scale-to-zero", prepared.undo);
    expect(calls).toEqual([
      {
        target: "AmazonEC2ContainerServiceV20141113.DescribeServices",
        body: { cluster: "prod", services: ["checkout"] },
      },
      {
        target: "AmazonEC2ContainerServiceV20141113.UpdateService",
        body: { cluster: "prod", service: "checkout", desiredCount: 0 },
      },
      {
        target: "AmazonEC2ContainerServiceV20141113.UpdateService",
        body: { cluster: "prod", service: "checkout", desiredCount: 4 },
      },
    ]);
  });

  it("reports a service already at zero as in effect", async () => {
    const { call } = fakeEcs(0);
    expect(
      (await prepareEcsFailure(call, ref, "ecs-service", "scale-to-zero")).alreadyInEffect,
    ).toBe(true);
  });

  it("refuses an undo with nothing stored, and unknown actions", async () => {
    const { call } = fakeEcs(2);
    await expect(undoEcsFailure(call, ref, "ecs-service", "scale-to-zero", {})).rejects.toThrow(
      /desired count/,
    );
    await expect(injectEcsFailure(call, ref, "ec2-instance", "scale-to-zero")).rejects.toThrow(
      /no failure action/,
    );
  });

  it("reads the cluster and service from the external id", () => {
    expect(ecsServiceRef("prod/checkout")).toEqual(ref);
    expect(() => ecsServiceRef("checkout")).toThrow(/cannot read/);
  });
});
