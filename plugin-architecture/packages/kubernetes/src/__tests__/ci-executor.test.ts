import { describe, expect, it } from "vitest";

import {
  ciListTagged,
  ciPreflight,
  ciStart,
  ciStatus,
  ciTeardown,
  gpuResource,
  jobManifest,
  jobName,
  labelValue,
  parseMachine,
  TAGS_ANNOTATION,
  type K8sCall,
} from "../ci-executor.js";

type Answer = (body: unknown) => unknown;

/** A fake API server: answers `METHOD path` from a table, recording each call. No network. */
function fakeK8s(answers: Record<string, Answer>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const call: K8sCall = async <T>(path: string, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body });
    const answer = answers[`${method} ${path}`];
    if (!answer) throw new Error(`K8s API error 404 at https://k8s.test${path}: not found`);
    return answer(init?.body) as T;
  };
  return { call, calls };
}

const fail = (status: number) => () => {
  throw new Error(`K8s API error ${status} at https://k8s.test: no`);
};

const tags = {
  "infrawrench-ci": "org-1",
  "infrawrench-ci-run": "ci-1.0123456789abcdef0123456789abcdef",
  "infrawrench-ci-job": "5f0c1c2e-1111-4a4a-9b9b-0123456789ab",
};

const spec = {
  kind: "cluster" as const,
  bootstrap: "#!/bin/sh\necho 'hi'\n",
  tags,
  name: "infrawrench-ci-build",
  maxSeconds: 2400,
};

const JOBS = "/apis/batch/v1/namespaces/ci/jobs";
const NAME = "iwci-5f0c1c2e11114a4a9b9b0123456789ab";

describe("jobManifest", () => {
  it("runs the bootstrap with no cluster credentials, a deadline and a TTL", () => {
    const job = jobManifest(spec, "ci") as any;
    expect(job.metadata.name).toBe(NAME);
    expect(job.metadata.namespace).toBe("ci");
    expect(job.spec.activeDeadlineSeconds).toBe(2400);
    expect(job.spec.ttlSecondsAfterFinished).toBeGreaterThan(0);
    expect(job.spec.backoffLimit).toBe(0);
    const pod = job.spec.template.spec;
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.enableServiceLinks).toBe(false);
    expect(pod.restartPolicy).toBe("Never");
    expect(pod.serviceAccountName).toBeUndefined();
    const container = pod.containers[0];
    expect(container.image).toBe("buildpack-deps:noble-curl");
    expect(container.command.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(container.command[2]).toContain("sleep 2400;");
    expect(container.command[3]).toBe("iwci");
    expect(container.command[4]).toContain("for t in bash curl");
    expect(container.command[4]).toContain("echo 'hi'");
    expect(container.resources.requests).toEqual({ cpu: "2", memory: "4Gi" });
    expect(container.env).toBeUndefined();
    expect(container.volumeMounts).toBeUndefined();
  });

  it("labels the Job and its pod, and keeps the tags as sent", () => {
    const job = jobManifest(spec, "ci") as any;
    expect(job.metadata.labels["infrawrench-ci"]).toBe("org-1");
    expect(job.spec.template.metadata.labels["infrawrench-ci-job"]).toBe(
      tags["infrawrench-ci-job"],
    );
    expect(JSON.parse(job.metadata.annotations[TAGS_ANNOTATION])).toEqual(tags);
  });

  it("sizes the pod from the machine and adds GPUs", () => {
    const job = jobManifest({ ...spec, machine: "0.5vcpu-1gb", gpu: "nvidia:2" }, "ci") as any;
    const resources = job.spec.template.spec.containers[0].resources;
    expect(resources.requests).toEqual({ cpu: "500m", memory: "1Gi" });
    expect(resources.limits["nvidia.com/gpu"]).toBe("2");
    expect(() => jobManifest({ ...spec, machine: "t3.large" }, "ci")).toThrow(/CPUs and memory/);
  });
});

describe("names and values", () => {
  it("cleans label values to 63 characters with alphanumeric ends", () => {
    expect(labelValue("a b/c")).toBe("a-b-c");
    expect(labelValue(`-${"x".repeat(80)}-`)).toHaveLength(63);
    expect(labelValue("--ok--")).toBe("ok");
  });

  it("derives the Job name from the job id, within 63 characters", () => {
    expect(jobName(spec)).toBe(NAME);
    expect(jobName({ tags: { "infrawrench-ci-job": "A".repeat(90) }, name: "x" })).toMatch(
      /^iwci-[0-9a-f]{32}$/,
    );
    expect(jobName({ tags: {}, name: "My Build!" })).toMatch(/^iwci-[0-9a-f]{32}$/);
  });

  it("parses machine sizes and GPU requests", () => {
    expect(parseMachine("4vcpu-8gb")).toEqual({ cpu: "4", memory: "8Gi" });
    expect(parseMachine("1 vCPU / 0.5 GiB")).toEqual({ cpu: "1", memory: "512Mi" });
    expect(parseMachine("big")).toBeNull();
    expect(gpuResource("a100")).toEqual({ resource: "nvidia.com/gpu", count: "1" });
    expect(gpuResource("amd:4")).toEqual({ resource: "amd.com/gpu", count: "4" });
    expect(gpuResource("example.com/tpu:8")).toEqual({ resource: "example.com/tpu", count: "8" });
    expect(() => gpuResource("nvidia:0")).toThrow();
  });
});

describe("ciPreflight", () => {
  it("names each verb the connection lacks in the namespace", async () => {
    const { call, calls } = fakeK8s({
      "POST /apis/authorization.k8s.io/v1/selfsubjectaccessreviews": (body: any) => ({
        status: { allowed: ["get", "list"].includes(body.spec.resourceAttributes.verb) },
      }),
      "GET /api/v1/namespaces/ci": () => ({}),
    });
    const result = await ciPreflight(call, "default", "cluster", "ci");
    expect(result.ok).toBe(false);
    expect(result.region).toBe("ci");
    expect(result.missing.map((m) => m.permission)).toEqual([
      "create jobs.batch in namespace ci",
      "delete jobs.batch in namespace ci",
    ]);
    const reviews = calls.filter((c) => c.path.includes("selfsubjectaccessreviews"));
    expect((reviews[0]!.body as any).spec.resourceAttributes).toEqual({
      namespace: "ci",
      verb: "create",
      group: "batch",
      resource: "jobs",
    });
  });

  it("passes with every verb, and reports a namespace that does not exist", async () => {
    const allowed = {
      "POST /apis/authorization.k8s.io/v1/selfsubjectaccessreviews": () => ({
        status: { allowed: true },
      }),
    };
    const ok = await ciPreflight(
      fakeK8s({ ...allowed, "GET /api/v1/namespaces/default": () => ({}) }).call,
      "default",
      "cluster",
    );
    expect(ok).toEqual({ ok: true, missing: [], problems: [], region: "default" });
    const absent = await ciPreflight(fakeK8s(allowed).call, "default", "cluster", "nope");
    expect(absent.ok).toBe(false);
    expect(absent.problems[0]).toMatch(/no namespace nope/);
    const forbidden = await ciPreflight(
      fakeK8s({ ...allowed, "GET /api/v1/namespaces/ci": fail(403) }).call,
      "default",
      "cluster",
      "ci",
    );
    expect(forbidden.ok).toBe(true);
  });

  it("refuses other kinds", async () => {
    await expect(ciPreflight(fakeK8s({}).call, "default", "vm")).rejects.toThrow(/cluster/);
  });
});

describe("ciStart", () => {
  it("creates the Job in the pipeline's namespace", async () => {
    const { call, calls } = fakeK8s({ [`POST ${JOBS}`]: () => ({}) });
    const handle = await ciStart(call, "default", { ...spec, region: "ci" });
    expect(handle).toEqual({
      id: `ci/${NAME}`,
      region: "ci",
      label: `kubernetes job ci/${NAME}`,
      data: { namespace: "ci", name: NAME },
    });
    expect((calls[0]!.body as any).metadata.name).toBe(NAME);
  });

  it("goes to the connection's namespace by default", async () => {
    const { call, calls } = fakeK8s({ "POST /apis/batch/v1/namespaces/web/jobs": () => ({}) });
    expect((await ciStart(call, "web", spec)).region).toBe("web");
    expect(calls).toHaveLength(1);
  });

  it("is idempotent: a Job of the same name for the same job is the one it made", async () => {
    const { call } = fakeK8s({
      [`POST ${JOBS}`]: fail(409),
      [`GET ${JOBS}/${NAME}`]: () => ({
        metadata: { name: NAME, annotations: { [TAGS_ANNOTATION]: JSON.stringify(tags) } },
      }),
    });
    expect((await ciStart(call, "ci", spec)).id).toBe(`ci/${NAME}`);
  });

  it("refuses someone else's Job of the same name", async () => {
    const { call } = fakeK8s({
      [`POST ${JOBS}`]: fail(409),
      [`GET ${JOBS}/${NAME}`]: () => ({ metadata: { name: NAME } }),
    });
    await expect(ciStart(call, "ci", spec)).rejects.toThrow(/not this CI job's/);
  });
});

describe("ciStatus", () => {
  const status = (s: object) =>
    ciStatus(fakeK8s({ [`GET ${JOBS}/${NAME}`]: () => ({ status: s }) }).call, {
      id: `ci/${NAME}`,
      label: "x",
      data: { namespace: "ci", name: NAME },
    });

  it("maps the Job's status", async () => {
    expect(await status({})).toEqual({ state: "starting" });
    expect(await status({ active: 1, ready: 0 })).toEqual({ state: "starting" });
    expect(await status({ active: 1, ready: 1 })).toEqual({ state: "running" });
    expect(await status({ active: 1 })).toEqual({ state: "running" });
    expect(
      await status({
        failed: 1,
        conditions: [{ type: "Failed", status: "True", reason: "DeadlineExceeded" }],
      }),
    ).toEqual({ state: "stopped", detail: "DeadlineExceeded" });
    expect(
      await status({ succeeded: 1, conditions: [{ type: "Complete", status: "True" }] }),
    ).toEqual({ state: "stopped" });
  });

  it("is gone when the Job is", async () => {
    expect(
      await ciStatus(fakeK8s({}).call, { id: `ci/${NAME}`, region: "ci", label: "x" }),
    ).toEqual({
      state: "gone",
    });
  });
});

describe("ciTeardown", () => {
  it("deletes the Job with its pods, and succeeds when it is already gone", async () => {
    const path = `${JOBS}/${NAME}?propagationPolicy=Background`;
    const { call, calls } = fakeK8s({ [`DELETE ${path}`]: () => ({}) });
    await ciTeardown(call, { id: `ci/${NAME}`, label: "x", data: { namespace: "ci", name: NAME } });
    expect((calls[0]!.body as any).propagationPolicy).toBe("Background");
    await expect(
      ciTeardown(fakeK8s({}).call, { id: `ci/${NAME}`, region: "ci", label: "x" }),
    ).resolves.toBeUndefined();
    await expect(
      ciTeardown(fakeK8s({ [`DELETE ${path}`]: fail(403) }).call, {
        id: `ci/${NAME}`,
        region: "ci",
        label: "x",
      }),
    ).rejects.toThrow(/403/);
  });
});

describe("ciListTagged", () => {
  const job = (name: string, ns: string, done: boolean) => ({
    metadata: {
      name,
      namespace: ns,
      creationTimestamp: "2026-11-13T10:00:00Z",
      labels: { "infrawrench-ci": "org-1" },
      annotations: { [TAGS_ANNOTATION]: JSON.stringify(tags) },
    },
    status: done ? { conditions: [{ type: "Complete", status: "True" }] } : { active: 1 },
  });

  it("lists every namespace, with the tags as sent", async () => {
    const { call } = fakeK8s({
      "GET /apis/batch/v1/jobs?labelSelector=infrawrench-ci": () => ({
        items: [job("a", "ci", false), job("b", "web", true)],
      }),
    });
    const found = await ciListTagged(call, "default", "infrawrench-ci", []);
    expect(found.map((f) => [f.handle.id, f.live])).toEqual([
      ["ci/a", true],
      ["web/b", false],
    ]);
    expect(found[0]!.tags).toEqual(tags);
    expect(found[0]!.createdAt).toBe("2026-11-13T10:00:00Z");
  });

  it("falls back to its own namespace when it may not list the cluster", async () => {
    const { call } = fakeK8s({
      "GET /apis/batch/v1/jobs?labelSelector=infrawrench-ci": fail(403),
      "GET /apis/batch/v1/namespaces/web/jobs?labelSelector=infrawrench-ci": () => ({
        items: [job("a", "web", false)],
      }),
    });
    expect((await ciListTagged(call, "web", "infrawrench-ci", [])).map((f) => f.handle.id)).toEqual(
      ["web/a"],
    );
  });

  it("lists the namespaces it is given", async () => {
    const { call, calls } = fakeK8s({
      [`GET ${JOBS}?labelSelector=infrawrench-ci`]: () => ({ items: [job("a", "ci", false)] }),
    });
    expect(await ciListTagged(call, "default", "infrawrench-ci", ["ci", "ci"])).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});
