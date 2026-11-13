import { hostPlugin } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  jobBody,
  jobName,
  LAUNCHER,
  NORTHFLANK_CI_EXECUTOR,
  parseTagsDescription,
  projectName,
  tagsDescription,
} from "../ci-executor.js";
import { plugin as contractPlugin } from "../plugin.js";

const plugin = hostPlugin(contractPlugin);

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}
let calls: Call[] = [];
let routes: Record<string, unknown> = {};

const notFound = () =>
  new Response(JSON.stringify({ error: { status: 404, message: "Not found" } }), { status: 404 });

// Every request is answered here; nothing reaches api.northflank.com.
beforeEach(() => {
  calls = [];
  routes = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const call = {
        method: (init.method ?? "GET").toUpperCase(),
        path: url.pathname,
        query: url.searchParams,
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const route = routes[`${call.method} ${call.path}`];
      if (route === undefined) return notFound();
      const value = typeof route === "function" ? (route as (c: Call) => unknown)(call) : route;
      if (value instanceof Response) return value;
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const tags = {
  "infrawrench-ci": "org-org_01HZX4Y0ABCDEFGHJKMNPQRSTV",
  "infrawrench-ci-run": "0b8c3c1e-2222-4a4a-9b9b-0123456789ab",
  "infrawrench-ci-job": "5f0c1c2e-1111-4a4a-9b9b-0123456789ab",
};
const spec = {
  kind: "container" as const,
  bootstrap: '#!/bin/sh\necho "${HOME}"\n',
  tags,
  name: "infrawrench-ci-build",
  maxSeconds: 1800,
};
const JOB = "iwci-5f0c1c2e11114a4a9b9b0123456789ab";
const PROJECT = "infrawrench-ci-europe-west";
const JOBS = `/v1/projects/${PROJECT}/jobs`;

const client = () => plugin.createClient({ apiToken: "nf-test" });
const page = (key: string, rows: unknown[]) => ({
  data: { [key]: rows },
  pagination: { hasNextPage: false, count: rows.length },
});

describe("declaration", () => {
  it("offers a job run as a container kind", () => {
    expect(contractPlugin.manifest.ciExecutor).toBe(NORTHFLANK_CI_EXECUTOR);
    expect(NORTHFLANK_CI_EXECUTOR.kinds.map((k) => k.kind)).toEqual(["container"]);
  });
});

describe("names", () => {
  it("fits Northflank's name rules", () => {
    const pattern = /^[a-zA-Z]((-|\s)?[a-zA-Z0-9]+((-|\s)[a-zA-Z0-9]+)*)?$/;
    expect(jobName(spec)).toBe(JOB);
    expect(jobName(spec)).toMatch(pattern);
    expect(JOB.length).toBeLessThanOrEqual(52);
    for (const region of ["europe-west", "europe-west-netherlands", "australia-southeast"]) {
      expect(projectName(region)).toMatch(pattern);
      expect(projectName(region).length).toBeLessThanOrEqual(39);
    }
  });
});

describe("tags in the description", () => {
  it("round-trips the tags in the characters a description allows", () => {
    const text = tagsDescription({ ...tags, "with space": "a=b{c}é" });
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text).toMatch(/^[a-zA-Z0-9.,?\s\\/'"()[\];`%^&*\-_:!]+$/);
    expect(parseTagsDescription(text)).toEqual({ ...tags, "with space": "a=b{c}é" });
  });

  it("refuses tags too long to hold, and reads anything else as not ours", () => {
    expect(() => tagsDescription({ a: "x".repeat(300) })).toThrow(/holds 200/);
    expect(parseTagsDescription("A job somebody made")).toBeNull();
    expect(parseTagsDescription(undefined)).toBeNull();
  });
});

describe("jobBody", () => {
  it("runs the script once, from a runtime file, under the job's deadline", () => {
    const body = jobBody(spec) as any;
    expect(body).toMatchObject({
      name: JOB,
      billing: { deploymentPlan: "nf-compute-200" },
      deployment: {
        external: { imagePath: "buildpack-deps:noble-curl" },
        docker: {
          configType: "customEntrypointCustomCommand",
          customEntrypoint: "/bin/sh",
          customCommand: "/iwci/run.sh",
        },
      },
      settings: { backoffLimit: 0, runOnSourceChange: "never", activeDeadlineSeconds: 1800 },
    });
    expect(body.settings.cron).toBeUndefined();
    expect(body.runtimeEnvironment).toBeUndefined();
    const decode = (b64: string) =>
      new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    // Nothing Northflank would template: no `$` anywhere in what it stores.
    expect(decode(body.runtimeFiles["/iwci/run.sh"].data)).toBe(LAUNCHER);
    expect(LAUNCHER).not.toContain("$");
    const stored = decode(body.runtimeFiles["/iwci/job.b64"].data);
    expect(stored).not.toContain("$");
    expect(decode(stored)).toContain('echo "${HOME}"');
  });
});

describe("ciStart", () => {
  it("makes the region's project, then the job, then one run", async () => {
    routes["POST /v1/projects"] = { data: { id: PROJECT } };
    routes[`PUT ${JOBS}`] = { data: { id: JOB } };
    routes[`POST ${JOBS}/${JOB}/runs`] = { data: { id: "run-0123456789", runName: "r" } };
    const handle = await client().ciStart!(spec);
    expect(handle).toEqual({
      id: "run-0123456789",
      region: "europe-west",
      label: `northflank job ${JOB} run run-0123 (${PROJECT})`,
      data: { project: PROJECT, job: JOB, run: "run-0123456789" },
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /v1/projects/${PROJECT}`,
      "POST /v1/projects",
      `GET ${JOBS}/${JOB}`,
      `PUT ${JOBS}`,
      `POST ${JOBS}/${JOB}/runs`,
    ]);
    expect(calls[1]!.body).toEqual({
      name: PROJECT,
      description: "Infrawrench CI jobs",
      region: "europe-west",
    });
    expect(parseTagsDescription((calls[3]!.body as { description: string }).description)).toEqual(
      tags,
    );
  });

  it("reaches a team through an organisation token's team prefix", async () => {
    routes[`GET /v1/teams/acme/projects/${PROJECT}`] = { data: { id: PROJECT } };
    routes[`PUT /v1/teams/acme${JOBS.slice(3)}`] = { data: { id: JOB } };
    routes[`POST /v1/teams/acme${JOBS.slice(3)}/${JOB}/runs`] = { data: { id: "run-1" } };
    const c = plugin.createClient({ apiToken: "nf-test", teamId: "acme" });
    await c.ciStart!(spec);
    expect(calls.every((call) => call.path.startsWith("/v1/teams/acme/"))).toBe(true);
  });

  it("returns the run a lost answer started instead of running the job twice", async () => {
    routes[`GET /v1/projects/${PROJECT}`] = { data: { id: PROJECT } };
    routes[`GET ${JOBS}/${JOB}`] = { data: { id: JOB, description: tagsDescription(tags) } };
    routes[`GET ${JOBS}/${JOB}/runs`] = page("runs", [{ id: "run-1", active: 1 }]);
    const handle = await client().ciStart!(spec);
    expect(handle.data).toEqual({ project: PROJECT, job: JOB, run: "run-1" });
    expect(calls.some((c) => c.method === "PUT" || c.method === "POST")).toBe(false);
  });

  it("refuses a job of that name that is not this CI job's", async () => {
    routes[`GET /v1/projects/${PROJECT}`] = { data: { id: PROJECT } };
    routes[`GET ${JOBS}/${JOB}`] = { data: { id: JOB, description: "someone's job" } };
    await expect(client().ciStart!(spec)).rejects.toThrow(/not this CI job's/);
  });

  it("refuses GPUs and other kinds", async () => {
    await expect(client().ciStart!({ ...spec, gpu: "h100" })).rejects.toThrow(/no GPUs/);
    await expect(client().ciStart!({ ...spec, kind: "build" })).rejects.toThrow(/`container`/);
  });
});

describe("ciStatus", () => {
  const handle = { id: "run-1", label: "x", data: { project: PROJECT, job: JOB, run: "run-1" } };
  const run = `GET ${JOBS}/${JOB}/runs/run-1`;

  it("maps the run", async () => {
    routes[run] = { data: { id: "run-1", active: 0, concluded: false } };
    expect(await client().ciStatus!(handle)).toEqual({ state: "starting" });
    routes[run] = { data: { id: "run-1", active: 1, concluded: false, status: "RUNNING" } };
    expect(await client().ciStatus!(handle)).toEqual({ state: "running" });
    routes[run] = { data: { id: "run-1", active: 0, concluded: true, status: "FAILED" } };
    expect(await client().ciStatus!(handle)).toEqual({
      state: "stopped",
      detail: "The run ended: FAILED.",
    });
  });

  it("is gone once the job is", async () => {
    expect(await client().ciStatus!(handle)).toEqual({ state: "gone" });
  });
});

describe("ciTeardown", () => {
  it("aborts the run, deletes the job, and succeeds when both are gone", async () => {
    const handle = { id: "run-1", label: "x", data: { project: PROJECT, job: JOB, run: "run-1" } };
    routes[`DELETE ${JOBS}/${JOB}/runs/run-1`] = {};
    routes[`DELETE ${JOBS}/${JOB}`] = {};
    await client().ciTeardown!(handle);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `DELETE ${JOBS}/${JOB}/runs/run-1`,
      `DELETE ${JOBS}/${JOB}`,
    ]);
    routes = {};
    await client().ciTeardown!(handle);
  });
});

describe("ciListTagged", () => {
  it("lists the CI projects' jobs that carry the tag", async () => {
    routes["GET /v1/projects"] = page("projects", [
      { id: "shop", name: "shop" },
      { id: PROJECT, name: PROJECT },
    ]);
    routes[`GET ${JOBS}`] = page("jobs", [
      { id: JOB, description: tagsDescription(tags), createdAt: "2026-11-13T00:00:00Z" },
      { id: "iwci-other", description: "not ours" },
      { id: "nightly", description: tagsDescription(tags) },
    ]);
    routes[`GET ${JOBS}/${JOB}/runs`] = page("runs", [{ id: "run-1", concluded: true }]);
    const found = await client().ciListTagged!("infrawrench-ci", []);
    expect(found).toEqual([
      {
        handle: {
          id: "run-1",
          region: "europe-west",
          label: `northflank job ${JOB} run run-1 (${PROJECT})`,
          data: { project: PROJECT, job: JOB, run: "run-1" },
        },
        tags,
        createdAt: "2026-11-13T00:00:00Z",
        live: false,
      },
    ]);
    expect(calls.some((c) => c.path === "/v1/projects/shop/jobs")).toBe(false);
  });
});

describe("ciPreflight", () => {
  it("passes a team token that can list projects", async () => {
    routes["GET /v1/auth"] = { data: { entityType: "team" } };
    routes["GET /v1/projects"] = page("projects", []);
    expect(await client().ciPreflight!("container")).toEqual({
      ok: true,
      missing: [],
      problems: [],
      region: "europe-west",
    });
  });

  it("names an organisation token with no team, a project restriction and a refused read", async () => {
    routes["GET /v1/auth"] = {
      data: { entityType: "org", projectRestrictions: { enabled: true } },
    };
    routes["GET /v1/projects"] = new Response(
      JSON.stringify({ error: { status: 403, message: "Forbidden" } }),
      { status: 403 },
    );
    const result = await client().ciPreflight!("container", "us-central");
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(2);
    expect(result.problems[1]).toMatch(/infrawrench-ci-us-central/);
    expect(result.missing.map((m) => m.permission)).toEqual(["Project > Projects > Manage > Read"]);
  });
});
