import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it, vi } from "vitest";
import {
  CI_SCRIPT_VAR,
  deploymentState,
  jobScript,
  limitsFor,
  projectName,
  RAILWAY_CI_EXECUTOR,
  START_COMMAND,
} from "../ci-executor.js";
import { RailwayClient } from "../client.js";
import { plugin } from "../plugin.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import { isolate } from "./helpers.js";

isolate();

interface Call {
  op: string;
  query: string;
  variables: Record<string, any>;
}
type Answer = { data?: unknown; errors?: Array<{ message: string }> };

/**
 * A client whose every GraphQL call is answered by `answer`, keyed by the
 * operation's name (or `apiToken` for the token's workspaces). Nothing
 * reaches backboard.railway.com.
 */
function railway(answer: (c: Call) => Answer, workspaceId = "ws-1") {
  const calls: Call[] = [];
  const request = vi.fn(async (req: { body?: string | Uint8Array }) => {
    const parsed = JSON.parse(String(req.body ?? "{}")) as {
      query: string;
      variables: Record<string, any>;
    };
    const op = /(?:query|mutation)\s+(\w+)/.exec(parsed.query)?.[1] ?? "apiToken";
    const call = { op, ...parsed };
    calls.push(call);
    return { status: 200, headers: {}, body: JSON.stringify(answer(call)) };
  });
  const c = hostClient(
    new RailwayClient(
      { apiToken: "tok", ...(workspaceId ? { workspaceId } : {}) },
      RESOURCE_TYPES,
      {
        http: { request },
      },
    ),
  );
  return { c, calls };
}

const tags = {
  "infrawrench-ci": "org-1",
  "infrawrench-ci-run": "run-1",
  "infrawrench-ci-job": "5f0c1c2e-1111-4a4a-9b9b-0123456789ab",
};
const spec = {
  kind: "container" as const,
  bootstrap: "#!/bin/sh\necho hi\n",
  tags,
  name: "infrawrench-ci-build",
  maxSeconds: 1800,
};
const NAME = "iwci-5f0c1c2e11114a4a9b9b0123456789ab";
const edges = (rows: unknown[]) => ({ edges: rows.map((node) => ({ node })) });
const projects = (rows: unknown[]) => ({
  data: { projects: { ...edges(rows), pageInfo: { hasNextPage: false, endCursor: null } } },
});

describe("declaration", () => {
  it("offers a one-off deployment as a container kind", () => {
    expect(plugin.manifest.ciExecutor).toBe(RAILWAY_CI_EXECUTOR);
    expect(RAILWAY_CI_EXECUTOR.kinds.map((k) => k.kind)).toEqual(["container"]);
  });
});

describe("helpers", () => {
  it("names the project from the job, and reads machine sizes as limits", () => {
    expect(projectName(spec)).toBe(NAME);
    expect(limitsFor("2vcpu-4gb")).toEqual({ vCPUs: 2, memoryGB: 4 });
    expect(() => limitsFor("large")).toThrow(/CPU and memory limits/);
  });

  it("runs the job under the watchdog, from a base64 variable", () => {
    const script = jobScript(spec);
    expect(script).toMatch(/^#!\/bin\/sh\nexec '\/bin\/sh' '-c' /);
    expect(script).toContain("sleep 1800");
    expect(script).toContain("echo hi");
    expect(START_COMMAND).toBe(
      `/bin/sh -c "echo $${CI_SCRIPT_VAR} | base64 -d > /tmp/iwci-job.sh && exec /bin/sh /tmp/iwci-job.sh"`,
    );
  });

  it("reads a deployment that ran to its end as stopped", () => {
    expect(deploymentState({ status: "QUEUED" })).toEqual({ state: "starting" });
    expect(deploymentState({ status: "SUCCESS", deploymentStopped: false })).toEqual({
      state: "running",
    });
    expect(deploymentState({ status: "SUCCESS", deploymentStopped: true }).state).toBe("stopped");
    expect(deploymentState({ status: "CRASHED" }).state).toBe("stopped");
  });
});

describe("ciStart", () => {
  it("makes a project, a sourceless service, sets it to run once, limits it and deploys", async () => {
    const { c, calls } = railway((call) => {
      switch (call.op) {
        case "CiProjects":
          return projects([{ id: "p0", name: "shop", description: null }]);
        case "CiProjectCreate":
          return { data: { projectCreate: { id: "p1", environments: edges([{ id: "e1" }]) } } };
        case "CiServiceCreate":
          return { data: { serviceCreate: { id: "s1" } } };
        case "CiInstanceUpdate":
          return { data: { serviceInstanceUpdate: true } };
        case "CiLimitsUpdate":
          return { data: { serviceInstanceLimitsUpdate: true } };
        case "CiDeploy":
          return { data: { serviceInstanceDeployV2: "d1234567890" } };
      }
      throw new Error(`unexpected ${call.op}`);
    });
    const handle = await c.ciStart!({ ...spec, region: "europe-west4-drams3a" });
    expect(handle).toEqual({
      id: "d1234567890",
      label: "railway project p1 deployment d1234567",
      data: { project: "p1", environment: "e1", service: "s1", deployment: "d1234567890" },
    });
    expect(calls.map((x) => x.op)).toEqual([
      "CiProjects",
      "CiProjectCreate",
      "CiServiceCreate",
      "CiInstanceUpdate",
      "CiLimitsUpdate",
      "CiDeploy",
    ]);
    expect(calls[1]!.variables["input"]).toEqual({
      name: NAME,
      description: JSON.stringify(tags),
      workspaceId: "ws-1",
      defaultEnvironmentName: "ci",
    });
    const service = calls[2]!.variables["input"];
    expect(service).toMatchObject({ projectId: "p1", environmentId: "e1", name: "job" });
    expect(service.source).toBeUndefined();
    // The one variable is the script; no Railway token goes anywhere near it.
    expect(Object.keys(service.variables)).toEqual([CI_SCRIPT_VAR]);
    expect(atob(service.variables[CI_SCRIPT_VAR])).toContain("echo hi");
    expect(calls[3]!.variables["input"]).toEqual({
      source: { image: "buildpack-deps:noble-curl" },
      startCommand: START_COMMAND,
      restartPolicyType: "NEVER",
      region: "europe-west4-drams3a",
    });
    expect(calls[4]!.variables["input"]).toEqual({
      serviceId: "s1",
      environmentId: "e1",
      vCPUs: 2,
      memoryGB: 4,
    });
  });

  it("returns the deployment a lost answer started instead of deploying twice", async () => {
    const { c, calls } = railway((call) => {
      if (call.op === "CiProjects") {
        return projects([{ id: "p1", name: NAME, description: JSON.stringify(tags) }]);
      }
      if (call.op === "CiProject") {
        return {
          data: {
            project: {
              id: "p1",
              environments: edges([{ id: "e1" }]),
              services: edges([{ id: "s1", name: "job" }]),
              deployments: edges([{ id: "d1", status: "DEPLOYING" }]),
            },
          },
        };
      }
      throw new Error(`unexpected ${call.op}`);
    });
    const handle = await c.ciStart!(spec);
    expect(handle.data).toEqual({
      project: "p1",
      environment: "e1",
      service: "s1",
      deployment: "d1",
    });
    expect(calls.map((x) => x.op)).toEqual(["CiProjects", "CiProject"]);
  });

  it("refuses a project of that name that is not this CI job's", async () => {
    const { c } = railway(() => projects([{ id: "p1", name: NAME, description: "my app" }]));
    await expect(c.ciStart!(spec)).rejects.toThrow(/not this CI job's/);
  });

  it("asks for a workspace when the token reaches several", async () => {
    const { c } = railway(
      (call) =>
        call.op === "apiToken"
          ? {
              data: {
                apiToken: {
                  workspaces: [
                    { id: "a", name: "A" },
                    { id: "b", name: "B" },
                  ],
                },
              },
            }
          : { data: {} },
      "",
    );
    await expect(c.ciStart!(spec)).rejects.toThrow(/several workspaces/);
  });

  it("refuses GPUs and other kinds", async () => {
    const { c } = railway(() => ({ data: {} }));
    await expect(c.ciStart!({ ...spec, gpu: "a100" })).rejects.toThrow(/no GPUs/);
    await expect(c.ciStart!({ ...spec, kind: "vm" })).rejects.toThrow(/`container`/);
  });
});

describe("ciStatus", () => {
  const handle = { id: "d1", label: "x", data: { project: "p1", deployment: "d1" } };

  it("reads the deployment", async () => {
    const { c } = railway(() => ({
      data: { deployment: { id: "d1", status: "SUCCESS", deploymentStopped: false } },
    }));
    expect(await c.ciStatus!(handle)).toEqual({ state: "running" });
  });

  it("is gone once the project is not in the workspace", async () => {
    const { c } = railway((call) =>
      call.op === "CiDeployment" ? { errors: [{ message: "Not Authorized" }] } : projects([]),
    );
    expect(await c.ciStatus!(handle)).toEqual({ state: "gone" });
  });
});

describe("ciTeardown", () => {
  const handle = { id: "d1", label: "x", data: { project: "p1", deployment: "d1" } };

  it("deletes the project", async () => {
    const { c, calls } = railway(() => ({ data: { projectDelete: true } }));
    await c.ciTeardown!(handle);
    expect(calls.map((x) => [x.op, x.variables["id"]])).toEqual([["CiProjectDelete", "p1"]]);
  });

  it("succeeds when the project is already gone, and not while it is still there", async () => {
    const gone = railway((call) =>
      call.op === "CiProjectDelete" ? { errors: [{ message: "Not Authorized" }] } : projects([]),
    );
    await gone.c.ciTeardown!(handle);
    const kept = railway((call) =>
      call.op === "CiProjectDelete"
        ? { errors: [{ message: "Not Authorized" }] }
        : projects([{ id: "p1", name: NAME }]),
    );
    await expect(kept.c.ciTeardown!(handle)).rejects.toThrow(/Not Authorized/);
  });
});

describe("ciListTagged", () => {
  it("finds iwci- projects carrying the tag", async () => {
    const { c } = railway(() =>
      projects([
        { id: "p0", name: "shop", description: JSON.stringify(tags) },
        {
          id: "p1",
          name: NAME,
          description: JSON.stringify(tags),
          createdAt: "2026-11-13T00:00:00Z",
          deployments: edges([{ id: "d1", status: "SUCCESS", deploymentStopped: true }]),
        },
        { id: "p2", name: "iwci-other", description: "{}" },
      ]),
    );
    expect(await c.ciListTagged!("infrawrench-ci", [])).toEqual([
      {
        handle: {
          id: "d1",
          label: "railway project p1 deployment d1",
          data: { project: "p1", deployment: "d1" },
        },
        tags,
        createdAt: "2026-11-13T00:00:00Z",
        live: false,
      },
    ]);
  });
});

describe("ciPreflight", () => {
  it("passes when the workspace's projects can be read", async () => {
    const { c } = railway(() => projects([]));
    expect(await c.ciPreflight!("container")).toEqual({ ok: true, missing: [], problems: [] });
  });

  it("names a token that cannot read the workspace", async () => {
    const { c } = railway(() => ({ errors: [{ message: "Not Authorized" }] }));
    const result = await c.ciPreflight!("container");
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/Not Authorized/);
  });
});
