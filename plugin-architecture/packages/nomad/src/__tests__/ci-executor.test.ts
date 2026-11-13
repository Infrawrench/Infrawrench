import { describe, expect, it } from "vitest";

import { NomadApiError } from "../api.js";
import {
  batchJob,
  ciListTagged,
  ciPreflight,
  ciStart,
  ciStatus,
  ciTeardown,
  jobId,
  parseMachine,
  type NomadCiApi,
  type NomadCiJob,
} from "../ci-executor.js";

const tags = {
  "infrawrench-ci": "org-1",
  "infrawrench-ci-run": "run-1",
  "infrawrench-ci-job": "5f0c1c2e-1111-4a4a-9b9b-0123456789ab",
};
const spec = {
  kind: "cluster" as const,
  bootstrap: "#!/bin/sh\necho hi\n",
  tags,
  name: "infrawrench-ci-build",
  maxSeconds: 1800,
};
const ID = "iwci-5f0c1c2e11114a4a9b9b0123456789ab";

const err = (status: number, text = "no") =>
  new NomadApiError(status, `Nomad API error ${status} for X /v1/jobs: ${text}`);

/** A fake Nomad: every call answered by the test, recorded. No network. */
function fakeNomad(over: Partial<NomadCiApi>) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const wrap =
    <K extends keyof NomadCiApi>(op: K) =>
    (...args: unknown[]) => {
      calls.push({ op, args });
      const fn = over[op] as ((...a: unknown[]) => Promise<unknown>) | undefined;
      if (!fn) return Promise.reject(new Error(`unexpected ${op}`));
      return fn(...args);
    };
  const api = {
    register: wrap("register"),
    readJob: wrap("readJob"),
    purgeJob: wrap("purgeJob"),
    listJobs: wrap("listJobs"),
    listNodes: wrap("listNodes"),
  } as NomadCiApi;
  return { api, calls };
}

describe("batchJob", () => {
  it("is a batch job that never retries, on docker, with the tags as Meta", () => {
    const job = batchJob(spec, "ci");
    expect(job).toMatchObject({
      ID,
      Namespace: "ci",
      Type: "batch",
      Datacenters: ["*"],
      Meta: { ...tags, "infrawrench-ci-name": "infrawrench-ci-build" },
    });
    const group = job.TaskGroups![0]!;
    expect(group.RestartPolicy).toEqual({ Attempts: 0, Mode: "fail" });
    expect(group.ReschedulePolicy).toEqual({ Attempts: 0, Unlimited: false });
    const task = group.Tasks![0]!;
    expect(task.Driver).toBe("docker");
    expect(task.Config).toMatchObject({ image: "buildpack-deps:noble-curl", command: "/bin/sh" });
    const args = (task.Config as { args: string[] }).args;
    expect(args[0]).toBe("-c");
    expect(args[1]).toContain("sleep 1800;");
    expect(args[3]).toContain("for t in bash curl");
    expect(task.Resources).toEqual({ CPU: 2000, MemoryMB: 4096 });
    expect(task.KillTimeout).toBe(10e9);
    // Nothing that would hand the task a credential or the host.
    expect(JSON.stringify(job)).not.toMatch(
      /Vault|Consul|Identity|volumes|docker\.sock|privileged/i,
    );
  });

  it("asks for GPUs as Nomad device requests", () => {
    const res = (gpu: string) =>
      batchJob({ ...spec, gpu }, "ci").TaskGroups![0]!.Tasks![0]!.Resources;
    expect(res("a100:2")?.Devices).toEqual([{ Name: "nvidia/gpu/a100", Count: 2 }]);
    expect(res("amd/gpu")?.Devices).toEqual([{ Name: "amd/gpu", Count: 1 }]);
    expect(() => res("gpu:0")).toThrow(/count/);
  });

  it("parses sizes, names the job after the CI job, and refuses other shapes", () => {
    expect(parseMachine("0.5vcpu-0.5gb")).toEqual({ cpu: 500, memoryMB: 512 });
    expect(jobId({ tags: {}, name: "a b/c" })).toMatch(/^iwci-[0-9a-f]{32}$/);
    expect(() => batchJob({ ...spec, machine: "t3.large" }, "ci")).toThrow(/CPUs and memory/);
  });
});

describe("ciPreflight", () => {
  it("passes when every probe is allowed", async () => {
    const { api, calls } = fakeNomad({
      listJobs: async () => [],
      readJob: async () => Promise.reject(err(404, "job not found")),
      register: async () =>
        Promise.reject(err(500, "Enforcing job modify index 1: job does not exist")),
      purgeJob: async () => ({}),
      listNodes: async () => [
        { Status: "ready", Drivers: { docker: { Detected: true, Healthy: true } } },
      ],
    });
    expect(await ciPreflight(api, "cluster", "ci")).toEqual({
      ok: true,
      missing: [],
      problems: [],
      region: "ci",
    });
    const probe = calls.find((c) => c.op === "register")!;
    expect((probe.args[0] as NomadCiJob).Stop).toBe(true);
    expect(probe.args[2]).toEqual({ JobModifyIndex: 1 });
  });

  it("names each capability the token lacks, once", async () => {
    const { api } = fakeNomad({
      listJobs: async () => Promise.reject(err(403)),
      readJob: async () => Promise.reject(err(403)),
      register: async () => Promise.reject(err(403)),
      purgeJob: async () => Promise.reject(err(403)),
      listNodes: async () => Promise.reject(err(403)),
    });
    const result = await ciPreflight(api, "cluster");
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.permission)).toEqual([
      "list-jobs in namespace default",
      "read-job in namespace default",
      "submit-job in namespace default",
    ]);
  });

  it("reports a cluster with no docker driver, and takes back a probe that was registered", async () => {
    const { api, calls } = fakeNomad({
      listJobs: async () => [],
      readJob: async () => Promise.reject(err(404)),
      register: async () => ({}),
      purgeJob: async () => ({}),
      listNodes: async () => [
        { Status: "ready", Drivers: { exec: { Detected: true, Healthy: true } } },
      ],
    });
    const result = await ciPreflight(api, "cluster");
    expect(result.problems[0]).toMatch(/docker driver/);
    expect(calls.filter((c) => c.op === "purgeJob")).toHaveLength(2);
  });
});

describe("ciStart", () => {
  it("registers only a new job", async () => {
    const { api, calls } = fakeNomad({ register: async () => ({}) });
    const handle = await ciStart(api, { ...spec, region: "ci" });
    expect(handle).toEqual({
      id: ID,
      region: "ci",
      label: `nomad job ci/${ID}`,
      data: { namespace: "ci" },
    });
    expect(calls[0]!.args[1]).toBe("ci");
    expect(calls[0]!.args[2]).toEqual({ JobModifyIndex: 0 });
  });

  it("is idempotent: an existing job for the same CI job is the one it made", async () => {
    const exists = err(500, "Enforcing job modify index 0: job already exists");
    const mine = fakeNomad({
      register: async () => Promise.reject(exists),
      readJob: async () => ({ ID, Meta: tags }),
    });
    expect((await ciStart(mine.api, spec)).id).toBe(ID);
    const theirs = fakeNomad({
      register: async () => Promise.reject(exists),
      readJob: async () => ({ ID, Meta: {} }),
    });
    await expect(ciStart(theirs.api, spec)).rejects.toThrow(/not this CI job's/);
  });

  it("passes other failures on", async () => {
    const { api } = fakeNomad({ register: async () => Promise.reject(err(403)) });
    await expect(ciStart(api, spec)).rejects.toThrow(/403/);
    await expect(ciStart(api, { ...spec, kind: "vm" })).rejects.toThrow(/cluster/);
  });
});

describe("ciStatus, ciTeardown and ciListTagged", () => {
  const handle = { id: ID, region: "ci", label: "x", data: { namespace: "ci" } };

  it("maps the job's status", async () => {
    const status = (job: object) => ciStatus(fakeNomad({ readJob: async () => job }).api, handle);
    expect(await status({ Status: "pending" })).toEqual({ state: "starting" });
    expect(await status({ Status: "running" })).toEqual({ state: "running" });
    expect(await status({ Status: "dead" })).toEqual({ state: "stopped" });
    expect(await status({ Status: "dead", Stop: true })).toEqual({
      state: "stopped",
      detail: "stopped",
    });
    expect(
      await ciStatus(fakeNomad({ readJob: async () => Promise.reject(err(404)) }).api, handle),
    ).toEqual({
      state: "gone",
    });
  });

  it("purges the job in its namespace", async () => {
    const { api, calls } = fakeNomad({ purgeJob: async () => ({}) });
    await ciTeardown(api, handle);
    expect(calls[0]!.args).toEqual([ID, "ci"]);
  });

  it("lists CI jobs with their Meta as tags", async () => {
    const { api } = fakeNomad({
      listJobs: async () => [
        { ID, Namespace: "ci", Status: "running" },
        { ID: "iwci-other", Namespace: "default", Status: "dead" },
      ],
      readJob: async (id: string) =>
        id === ID
          ? {
              ID,
              Status: "running",
              SubmitTime: 1_763_000_000_000_000_000,
              Meta: { ...tags, "infrawrench-ci-name": "n" },
            }
          : { ID: id, Status: "dead", Meta: {} },
    } as Partial<NomadCiApi>);
    const found = await ciListTagged(api, "infrawrench-ci");
    expect(found).toEqual([
      {
        handle: { id: ID, region: "ci", label: `nomad job ci/${ID}`, data: { namespace: "ci" } },
        tags,
        createdAt: new Date(1_763_000_000_000).toISOString(),
        live: true,
      },
    ]);
  });
});
