import { describe, expect, it } from "vitest";

import { AwsRequestError } from "../aws-errors.js";
import type { AwsCiCalls } from "../ci-calls.js";
import {
  CI_CLUSTER,
  ECS_DEFAULT_IMAGE,
  ecsListTagged,
  ecsPreflight,
  ecsStart,
  ecsStatus,
  ecsTeardown,
  fargateSize,
  taskDefinitionRequest,
} from "../ci-ecs.js";

type Answer = (body: Record<string, unknown>) => unknown;

/** A fake AWS: answers each ECS target and EC2 action from a table, recording what was sent. No network. */
function fakeAws(
  ecs: Record<string, Answer>,
  ec2: Record<string, Answer> = {
    DescribeSubnets: () => ({
      subnetSet: { item: [{ subnetId: "subnet-a" }, { subnetId: "subnet-b" }] },
    }),
  },
  simulate: AwsCiCalls["simulate"] = async (actions) => new Map(actions.map((a) => [a, true])),
) {
  const sent: Array<{ region: string; target: string; body: Record<string, unknown> }> = [];
  const calls: AwsCiCalls = {
    ec2: async <T>(region: string, action: string, params: Record<string, string> = {}) => {
      sent.push({ region, target: `ec2.${action}`, body: params });
      const answer = ec2[action];
      if (!answer) throw new Error(`unexpected ${action}`);
      return (await answer(params)) as T;
    },
    json: async <T>(region: string, _service: string, target: string, body: object) => {
      const op = target.split(".").pop() ?? "";
      sent.push({ region, target: op, body: body as Record<string, unknown> });
      const answer = ecs[op];
      if (!answer) throw new Error(`unexpected ${op}`);
      return (await answer(body as Record<string, unknown>)) as T;
    },
    query: async () => {
      throw new Error("no IAM here");
    },
    simulate,
  };
  return { calls, sent };
}

const err = (code: string, message = `${code}: no`) => new AwsRequestError(message, 400, code);

const spec = {
  kind: "container" as const,
  bootstrap: "#!/bin/sh\necho hi\n",
  tags: { "infrawrench-ci": "org", "infrawrench-ci-job": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0" },
  name: "ci build",
  maxSeconds: 3600,
};
const key = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

describe("fargateSize", () => {
  it("takes Fargate's pairs and names them when it is not one", () => {
    expect(fargateSize("2vcpu-4gb")).toEqual({ cpu: "2048", memory: "4096" });
    expect(fargateSize("0.25vcpu-0.5gb")).toEqual({ cpu: "256", memory: "512" });
    expect(fargateSize("8vcpu-20gb")).toEqual({ cpu: "8192", memory: "20480" });
    expect(() => fargateSize("8vcpu-18gb")).toThrow("table of pairs");
    expect(() => fargateSize("2vcpu-1gb")).toThrow("table of pairs");
    expect(() => fargateSize("t3.large")).toThrow("2vcpu-4gb");
  });
});

describe("taskDefinitionRequest", () => {
  it("runs the bootstrap under a watchdog, with no roles and the job's tags", () => {
    const def = taskDefinitionRequest(spec);
    expect(def.family).toBe(`infrawrench-ci-${key}`);
    expect(def.taskRoleArn).toBeUndefined();
    expect(def.executionRoleArn).toBeUndefined();
    expect(def.requiresCompatibilities).toEqual(["FARGATE"]);
    expect(def.networkMode).toBe("awsvpc");
    const container = def.containerDefinitions?.[0];
    expect(container?.image).toBe(ECS_DEFAULT_IMAGE);
    expect(container?.entryPoint).toEqual(["/bin/sh", "-c"]);
    expect(container?.command?.[0]).toContain("sleep 3600;");
    expect(container?.command?.at(-1)).toBe(spec.bootstrap);
    expect(def.tags).toContainEqual({ key: "infrawrench-ci", value: "org" });
  });
});

describe("ecsPreflight", () => {
  it("is ok when the simulator allows everything and default subnets exist", async () => {
    const { calls } = fakeAws({});
    expect(await ecsPreflight(calls, "eu-west-1")).toEqual({
      ok: true,
      missing: [],
      problems: [],
      region: "eu-west-1",
    });
  });

  it("names what the key lacks, and a missing default VPC", async () => {
    const { calls } = fakeAws(
      {},
      { DescribeSubnets: () => ({ subnetSet: null }) },
      async (actions) => new Map(actions.map((a) => [a, !a.startsWith("ecs:RunTask")])),
    );
    const result = await ecsPreflight(calls, "us-east-2");
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.permission)).toEqual(["ecs:RunTask"]);
    expect(result.problems[0]).toContain("no default VPC in us-east-2");
  });

  it("asks for the simulator when the key may not run it", async () => {
    const { calls } = fakeAws({}, undefined, async () => null);
    const result = await ecsPreflight(calls, "eu-west-1");
    expect(result.missing.map((m) => m.permission)).toEqual(["iam:SimulatePrincipalPolicy"]);
  });
});

describe("the task's life", () => {
  const taskArn = "arn:aws:ecs:eu-west-1:1:task/infrawrench-ci/abc";
  const defArn = `arn:aws:ecs:eu-west-1:1:task-definition/infrawrench-ci-${key}:1`;

  it("makes the cluster, registers, runs idempotently, and tears both down", async () => {
    const { calls, sent } = fakeAws({
      DescribeClusters: () => ({ clusters: [], failures: [{ reason: "MISSING" }] }),
      CreateCluster: () => ({ cluster: { status: "ACTIVE" } }),
      DescribeTaskDefinition: () =>
        Promise.reject(err("ClientException", "Unable to describe task definition.")),
      RegisterTaskDefinition: () => ({ taskDefinition: { taskDefinitionArn: defArn } }),
      RunTask: () => ({ tasks: [{ taskArn }], failures: [] }),
      DescribeTasks: () => ({ tasks: [{ taskArn, lastStatus: "RUNNING" }] }),
      StopTask: () => ({}),
      DeregisterTaskDefinition: () => ({}),
      DeleteTaskDefinitions: () => ({ failures: [] }),
    });
    const handle = await ecsStart(calls, "eu-west-1", spec);
    expect(handle).toEqual({
      id: taskArn,
      region: "eu-west-1",
      label: "aws ecs task abc (eu-west-1)",
      data: { kind: "container", cluster: CI_CLUSTER, taskDefinition: defArn },
    });
    const run = sent.find((s) => s.target === "RunTask")?.body;
    expect(run).toMatchObject({
      cluster: CI_CLUSTER,
      taskDefinition: defArn,
      launchType: "FARGATE",
      clientToken: key,
      networkConfiguration: {
        awsvpcConfiguration: { subnets: ["subnet-a", "subnet-b"], assignPublicIp: "ENABLED" },
      },
    });
    expect(await ecsStatus(calls, "eu-west-1", handle)).toEqual({ state: "running" });
    await ecsTeardown(calls, "eu-west-1", handle);
    expect(sent.slice(-3).map((s) => s.target)).toEqual([
      "StopTask",
      "DeregisterTaskDefinition",
      "DeleteTaskDefinitions",
    ]);
  });

  it("reuses the definition a retried start registered", async () => {
    const { calls, sent } = fakeAws({
      DescribeClusters: () => ({ clusters: [{ status: "ACTIVE" }] }),
      DescribeTaskDefinition: () => ({
        taskDefinition: { taskDefinitionArn: defArn, status: "ACTIVE" },
      }),
      RunTask: () => ({ tasks: [{ taskArn }] }),
    });
    await ecsStart(calls, "eu-west-1", spec);
    expect(sent.map((s) => s.target)).not.toContain("RegisterTaskDefinition");
    expect(sent.map((s) => s.target)).not.toContain("CreateCluster");
  });

  it("names why ECS started nothing, and retires the definition", async () => {
    const { calls, sent } = fakeAws({
      DescribeClusters: () => ({ clusters: [{ status: "ACTIVE" }] }),
      DescribeTaskDefinition: () => ({
        taskDefinition: { taskDefinitionArn: defArn, status: "ACTIVE" },
      }),
      RunTask: () => ({ tasks: [], failures: [{ reason: "RESOURCE:CPU" }] }),
      DeregisterTaskDefinition: () => ({}),
      DeleteTaskDefinitions: () => ({}),
    });
    await expect(ecsStart(calls, "eu-west-1", spec)).rejects.toThrow("RESOURCE:CPU");
    expect(sent.at(-1)?.target).toBe("DeleteTaskDefinitions");
  });

  it("reads a forgotten task as gone, and tears down what is already gone", async () => {
    const { calls } = fakeAws({
      DescribeTasks: () => ({ tasks: [], failures: [{ arn: taskArn, reason: "MISSING" }] }),
      StopTask: () =>
        Promise.reject(err("InvalidParameterException", "The referenced task was not found.")),
      DeregisterTaskDefinition: () =>
        Promise.reject(err("ClientException", "The specified task definition does not exist.")),
      DeleteTaskDefinitions: () => ({ failures: [{ reason: "TASK_DEFINITION_NOT_FOUND" }] }),
    });
    const handle = {
      id: taskArn,
      region: "eu-west-1",
      label: "x",
      data: { kind: "container", cluster: CI_CLUSTER, taskDefinition: defArn },
    };
    expect(await ecsStatus(calls, "eu-west-1", handle)).toEqual({ state: "gone" });
    await expect(ecsTeardown(calls, "eu-west-1", handle)).resolves.toBeUndefined();
  });

  it("refuses GPUs", async () => {
    const { calls } = fakeAws({});
    await expect(ecsStart(calls, "eu-west-1", { ...spec, gpu: "a10g" })).rejects.toThrow("`vm`");
  });
});

describe("ecsListTagged", () => {
  it("lists tagged tasks and the definitions no task uses", async () => {
    const taskArn = "arn:aws:ecs:eu-west-1:1:task/infrawrench-ci/abc";
    const live = "arn:aws:ecs:eu-west-1:1:task-definition/infrawrench-ci-a:1";
    const orphan = "arn:aws:ecs:eu-west-1:1:task-definition/infrawrench-ci-b:1";
    const { calls } = fakeAws({
      ListTasks: () => ({ taskArns: [taskArn] }),
      DescribeTasks: () => ({
        tasks: [
          {
            taskArn,
            taskDefinitionArn: live,
            lastStatus: "PENDING",
            createdAt: 1_763_000_000,
            tags: [
              { key: "infrawrench-ci", value: "org" },
              { key: "Name", value: "ci build" },
            ],
          },
        ],
      }),
      ListTaskDefinitions: () => ({ taskDefinitionArns: [live, orphan] }),
      DescribeTaskDefinition: () => ({
        taskDefinition: { registeredAt: 1_763_000_100 },
        tags: [{ key: "infrawrench-ci", value: "org" }],
      }),
    });
    const tagged = await ecsListTagged(calls, "eu-west-1", "infrawrench-ci");
    expect(tagged).toEqual([
      {
        handle: expect.objectContaining({ id: taskArn }),
        tags: { "infrawrench-ci": "org" },
        createdAt: new Date(1_763_000_000_000).toISOString(),
        live: true,
      },
      {
        handle: expect.objectContaining({
          id: orphan,
          data: expect.objectContaining({ taskDefinition: orphan }),
        }),
        tags: { "infrawrench-ci": "org" },
        createdAt: new Date(1_763_000_100_000).toISOString(),
        live: false,
      },
    ]);
  });

  it("finds nothing where the cluster was never made", async () => {
    const { calls } = fakeAws({
      ListTasks: () => Promise.reject(err("ClusterNotFoundException")),
      ListTaskDefinitions: () => ({ taskDefinitionArns: [] }),
    });
    expect(await ecsListTagged(calls, "eu-west-1", "infrawrench-ci")).toEqual([]);
  });
});
