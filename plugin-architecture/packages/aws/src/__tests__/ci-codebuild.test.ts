import { describe, expect, it } from "vitest";

import { AwsRequestError } from "../aws-errors.js";
import type { AwsCiCalls } from "../ci-calls.js";
import {
  CI_PROJECT,
  CI_ROLE,
  CODEBUILD_DEFAULT_IMAGE,
  TAGS_VARIABLE,
  buildspec,
  codebuildListTagged,
  codebuildPreflight,
  codebuildStart,
  codebuildStatus,
  codebuildTeardown,
  startBuildRequest,
  timeoutMinutes,
} from "../ci-codebuild.js";

type Answer = (body: Record<string, unknown>) => unknown;

/** A fake AWS: CodeBuild targets and IAM actions from tables, recording what was sent. No network. */
function fakeAws(
  codebuild: Record<string, Answer>,
  iam: Record<string, Answer> = {},
  simulate: AwsCiCalls["simulate"] = async (actions) => new Map(actions.map((a) => [a, true])),
) {
  const sent: Array<{ target: string; body: Record<string, unknown> }> = [];
  const calls: AwsCiCalls = {
    ec2: async () => {
      throw new Error("no EC2 here");
    },
    json: async <T>(_region: string, _service: string, target: string, body: object) => {
      const op = target.split(".").pop() ?? "";
      sent.push({ target: op, body: body as Record<string, unknown> });
      const answer = codebuild[op];
      if (!answer) throw new Error(`unexpected ${op}`);
      return (await answer(body as Record<string, unknown>)) as T;
    },
    query: async <T>(_service: string, action: string, _version: string, params = {}) => {
      sent.push({ target: `iam.${action}`, body: params });
      const answer = iam[action];
      if (!answer) throw new Error(`unexpected ${action}`);
      return (await answer(params)) as T;
    },
    simulate,
    sleep: async () => {},
  };
  return { calls, sent };
}

const err = (code: string, message = `${code}: no`) => new AwsRequestError(message, 400, code);

const spec = {
  kind: "build" as const,
  bootstrap: "#!/bin/sh\necho hi\n",
  tags: { "infrawrench-ci": "org", "infrawrench-ci-job": "job-1" },
  name: "ci build",
  maxSeconds: 3600,
};

describe("startBuildRequest", () => {
  it("runs the bootstrap privileged, with its tags, a timeout and no logs", () => {
    const body = startBuildRequest(spec);
    expect(body).toMatchObject({
      projectName: CI_PROJECT,
      sourceTypeOverride: "NO_SOURCE",
      imageOverride: CODEBUILD_DEFAULT_IMAGE,
      environmentTypeOverride: "LINUX_CONTAINER",
      computeTypeOverride: "BUILD_GENERAL1_MEDIUM",
      privilegedModeOverride: true,
      timeoutInMinutesOverride: 60,
      logsConfigOverride: { cloudWatchLogs: { status: "DISABLED" } },
    });
    expect(body.idempotencyToken).toMatch(/^[0-9a-f]{32}$/);
    expect(body.environmentVariablesOverride).toEqual([
      { name: TAGS_VARIABLE, value: JSON.stringify(spec.tags), type: "PLAINTEXT" },
    ]);
    const encoded = /echo (\S+) \|/.exec(body.buildspecOverride ?? "")?.[1] ?? "";
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(spec.bootstrap);
  });

  it("keeps the timeout inside CodeBuild's range", () => {
    expect(timeoutMinutes(10)).toBe(5);
    expect(timeoutMinutes(3601)).toBe(61);
    expect(timeoutMinutes(10 * 24 * 3600)).toBe(2160);
  });

  it("writes a buildspec YAML can read", () => {
    expect(buildspec("x")).toMatch(
      /^version: 0\.2\nphases:\n {2}build:\n {4}commands:\n {6}- '.*'\n$/,
    );
  });
});

describe("codebuildPreflight", () => {
  it("asks about PassRole on the CI role, and not for CreateRole once the role is there", async () => {
    const asked: Array<string | undefined> = [];
    const { calls } = fakeAws(
      {},
      { GetRole: () => ({ GetRoleResult: { Role: { Arn: "arn:aws:iam::1:role/x" } } }) },
      async (actions, resource) => {
        asked.push(resource?.("123"));
        return new Map(actions.map((a) => [a, a !== "iam:CreateRole"]));
      },
    );
    const result = await codebuildPreflight(calls, "eu-west-1");
    expect(result).toEqual({ ok: true, missing: [], problems: [], region: "eu-west-1" });
    expect(asked).toEqual([undefined, `arn:aws:iam::123:role/${CI_ROLE}`]);
  });

  it("names what a read-only key lacks", async () => {
    const { calls } = fakeAws(
      {},
      { GetRole: () => Promise.reject(err("NoSuchEntity")) },
      async (actions) => new Map(actions.map((a) => [a, a.endsWith("BatchGetBuilds")])),
    );
    const result = await codebuildPreflight(calls, "eu-west-1");
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.permission)).toContain("codebuild:StartBuild");
    expect(result.missing.map((m) => m.permission)).toContain("iam:CreateRole");
    expect(result.missing.map((m) => m.permission)).toContain("iam:PassRole");
  });
});

describe("the build's life", () => {
  it("makes the role and project on first use, then starts the build", async () => {
    let creates = 0;
    const { calls, sent } = fakeAws(
      {
        BatchGetProjects: () => ({ projects: [], projectsNotFound: [CI_PROJECT] }),
        CreateProject: () => {
          creates++;
          // A role a moment old is not assumable yet.
          if (creates === 1) {
            return Promise.reject(
              err(
                "InvalidInputException",
                "CodeBuild is not authorized to perform: sts:AssumeRole",
              ),
            );
          }
          return { project: {} };
        },
        StartBuild: () => ({ build: { id: "infrawrench-ci:b1" } }),
      },
      {
        GetRole: () => Promise.reject(err("NoSuchEntity")),
        CreateRole: () => ({
          CreateRoleResult: { Role: { Arn: "arn:aws:iam::1:role/infrawrench-ci-codebuild" } },
        }),
      },
    );
    const handle = await codebuildStart(calls, "eu-west-1", spec);
    expect(handle).toEqual({
      id: "infrawrench-ci:b1",
      region: "eu-west-1",
      label: "aws codebuild b1 (eu-west-1)",
      data: { kind: "build" },
    });
    const role = sent.find((s) => s.target === "iam.CreateRole")?.body ?? {};
    expect(JSON.parse(String(role["AssumeRolePolicyDocument"]))).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "codebuild.amazonaws.com" },
          Action: "sts:AssumeRole",
        },
      ],
    });
    // The role gets no policy: nothing attaches or puts one.
    expect(sent.some((s) => /Policy$/.test(s.target) && s.target.startsWith("iam."))).toBe(false);
    expect(sent.find((s) => s.target === "CreateProject")?.body).toMatchObject({
      serviceRole: "arn:aws:iam::1:role/infrawrench-ci-codebuild",
      source: { type: "NO_SOURCE" },
      logsConfig: { cloudWatchLogs: { status: "DISABLED" } },
    });
    expect(creates).toBe(2);
  });

  it("follows the build, stops it, and takes a finished one as done", async () => {
    let complete = false;
    const { calls } = fakeAws({
      BatchGetBuilds: () => ({
        builds: [
          complete
            ? { id: "p:b1", buildStatus: "SUCCEEDED", buildComplete: true }
            : {
                id: "p:b1",
                buildStatus: "IN_PROGRESS",
                currentPhase: "BUILD",
                buildComplete: false,
              },
        ],
      }),
      StopBuild: () =>
        complete ? Promise.reject(err("InvalidInputException", "Build already completed")) : {},
    });
    const handle = { id: "p:b1", region: "eu-west-1", label: "x", data: { kind: "build" } };
    expect(await codebuildStatus(calls, "eu-west-1", handle)).toEqual({
      state: "running",
      detail: "BUILD",
    });
    await codebuildTeardown(calls, "eu-west-1", handle);
    complete = true;
    expect(await codebuildStatus(calls, "eu-west-1", handle)).toEqual({
      state: "gone",
      detail: "SUCCEEDED",
    });
    await expect(codebuildTeardown(calls, "eu-west-1", handle)).resolves.toBeUndefined();
  });

  it("reads a build CodeBuild does not know as gone", async () => {
    const { calls } = fakeAws({
      BatchGetBuilds: () => ({ builds: [], buildsNotFound: ["p:b9"] }),
      StopBuild: () => Promise.reject(err("ResourceNotFoundException")),
    });
    const handle = { id: "p:b9", region: "eu-west-1", label: "x", data: { kind: "build" } };
    expect(await codebuildStatus(calls, "eu-west-1", handle)).toEqual({ state: "gone" });
    await expect(codebuildTeardown(calls, "eu-west-1", handle)).resolves.toBeUndefined();
  });
});

describe("codebuildListTagged", () => {
  it("lists running builds by the tags they carry, and stops paging past the longest build", async () => {
    const now = Date.parse("2026-11-13T12:00:00Z");
    const { calls, sent } = fakeAws({
      ListBuildsForProject: (body) =>
        body["nextToken"]
          ? { ids: ["p:old"] }
          : { ids: ["p:b1", "p:b2", "p:old"], nextToken: "t2" },
      BatchGetBuilds: () => ({
        builds: [
          {
            id: "p:b1",
            buildComplete: false,
            startTime: now / 1000 - 60,
            environment: {
              environmentVariables: [{ name: TAGS_VARIABLE, value: '{"infrawrench-ci":"org"}' }],
            },
          },
          { id: "p:b2", buildComplete: true, startTime: now / 1000 - 120 },
          { id: "p:old", buildComplete: true, startTime: now / 1000 - 3 * 24 * 3600 },
        ],
      }),
    });
    const tagged = await codebuildListTagged(calls, "eu-west-1", "infrawrench-ci", now);
    expect(tagged).toEqual([
      {
        handle: expect.objectContaining({ id: "p:b1" }),
        tags: { "infrawrench-ci": "org" },
        createdAt: new Date(now - 60_000).toISOString(),
        live: true,
      },
    ]);
    expect(sent.filter((s) => s.target === "ListBuildsForProject")).toHaveLength(1);
    expect(sent[0]?.body).not.toHaveProperty("sortOrder");
  });

  it("finds nothing where the project was never made", async () => {
    const { calls } = fakeAws({
      ListBuildsForProject: () => Promise.reject(err("ResourceNotFoundException")),
    });
    expect(await codebuildListTagged(calls, "eu-west-1", "infrawrench-ci")).toEqual([]);
  });
});
