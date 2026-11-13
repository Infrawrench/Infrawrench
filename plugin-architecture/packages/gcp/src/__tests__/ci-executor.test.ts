import { describe, expect, it } from "vitest";

import {
  buildBody,
  buildListTagged,
  buildStart,
  buildStatus,
  buildTeardown,
  machineType,
} from "../ci-cloud-build.js";
import {
  computeListTagged,
  computePreflight,
  computeStart,
  computeStatus,
  computeTeardown,
  instanceBody,
  sourceImage,
} from "../ci-compute.js";
import { gcpCiListTagged, gcpCiPreflight } from "../ci-executor.js";
import {
  jobBody,
  runListTagged,
  runResources,
  runStart,
  runStatus,
  runTeardown,
} from "../ci-run-jobs.js";
import { labelsOf, serviceAccountEmail, uuidOf, type GcpCiCalls } from "../ci-shared.js";

type Route = (url: URL, body: unknown) => unknown;

/** A fake Google: routes `METHOD path` prefixes to answers, recording what was sent. No network. */
function fakeGoogle(routes: Array<[string, Route]>) {
  const sent: Array<{ method: string; url: string; body: unknown }> = [];
  const calls: GcpCiCalls = {
    project: "acme",
    sleep: async () => {},
    call: async <T>(method: string, url: string, body?: unknown) => {
      sent.push({ method, url, body });
      const parsed = new URL(url);
      const match = routes.find(([pattern]) => {
        const [m, p] = pattern.split(" ");
        return m === method && `${parsed.host}${parsed.pathname}`.includes(p ?? "");
      });
      if (!match) throw new Error(`unexpected ${method} ${url}`);
      return (await match[1](parsed, body)) as T;
    },
  };
  return { calls, sent };
}

function status(code: number, message = `status ${code}`, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { status: code }, extra);
}

const tags = {
  "infrawrench-ci": "org-Acme",
  "infrawrench-ci-run": "r1",
  "infrawrench-ci-job": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
};
const key = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const spec = { bootstrap: "#!/bin/sh\necho hi\n", tags, name: "ci build", maxSeconds: 3600 };

describe("shared", () => {
  it("makes labels GCP takes and a UUID from the job key", () => {
    expect(labelsOf({ "Infrawrench CI": "Org/A" })).toEqual({ infrawrench_ci: "org_a" });
    expect(uuidOf(key)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(serviceAccountEmail("acme")).toBe("infrawrench-ci-runner@acme.iam.gserviceaccount.com");
    expect(serviceAccountEmail("example.com:acme")).toBe(
      "infrawrench-ci-runner@acme.example.com.iam.gserviceaccount.com",
    );
  });

  it("checks permissions with testIamPermissions and says what is missing", async () => {
    const { calls } = fakeGoogle([
      [
        "POST cloudresourcemanager.googleapis.com/v3/projects/acme:testIamPermissions",
        () => ({ permissions: ["compute.instances.get"] }),
      ],
      [
        "GET compute.googleapis.com/compute/v1/projects/acme/global/networks/default",
        () => Promise.reject(status(404)),
      ],
    ]);
    const result = await gcpCiPreflight(calls, "vm", "europe-west1");
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.permission)).toContain("compute.instances.create");
    expect(result.missing.map((m) => m.permission)).not.toContain("compute.instances.get");
    expect(result.problems[0]).toContain("no network named `default`");
    expect(result.region).toBe("europe-west1");
  });
});

describe("Compute Engine", () => {
  it("launches Ubuntu with no service account, a run-time limit and the tags", () => {
    const body = instanceBody({ ...spec, kind: "vm" }, "us-central1-a") as Record<string, any>;
    expect(body["name"]).toBe(`iwci-${key}`);
    expect(body["serviceAccounts"]).toEqual([]);
    expect(body["scheduling"]).toEqual({
      provisioningModel: "STANDARD",
      maxRunDuration: { seconds: "3600" },
      instanceTerminationAction: "DELETE",
    });
    expect(body["disks"][0].initializeParams.sourceImage).toBe(
      "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64",
    );
    expect(body["disks"][0].initializeParams.diskType).toBe(
      "zones/us-central1-a/diskTypes/pd-balanced",
    );
    const items = body["metadata"].items as Array<{ key: string; value: string }>;
    expect(items.find((i) => i.key === "startup-script")?.value).toContain("echo hi");
    expect(JSON.parse(items.find((i) => i.key === "infrawrench-ci-tags")?.value ?? "")).toEqual(
      tags,
    );
    expect(body["labels"]).toMatchObject({ "infrawrench-ci": "org-acme" });
    expect(body["networkInterfaces"][0].accessConfigs[0].type).toBe("ONE_TO_ONE_NAT");
  });

  it("picks the arm image for Axion and attaches a GPU when asked", () => {
    expect(sourceImage("c4a-standard-4")).toContain("ubuntu-2404-lts-arm64");
    const body = instanceBody(
      { ...spec, kind: "vm", machine: "g2-standard-4", gpu: "nvidia-l4" },
      "us-east4-a",
    ) as Record<string, any>;
    expect(body["guestAccelerators"]).toEqual([
      { acceleratorType: "zones/us-east4-a/acceleratorTypes/nvidia-l4", acceleratorCount: 1 },
    ]);
    expect(body["scheduling"].onHostMaintenance).toBe("TERMINATE");
    expect(() => instanceBody({ ...spec, kind: "vm", gpu: "x:0" }, "z")).toThrow("<type>");
  });

  it("starts in the region's first zone, idempotently, and follows and deletes the instance", async () => {
    const { calls, sent } = fakeGoogle([
      [
        "GET /regions/us-central1",
        () => ({ zones: ["https://x/zones/us-central1-c", "https://x/zones/us-central1-a"] }),
      ],
      ["POST /zones/us-central1-a/operations/op-1/wait", () => ({ name: "op-1", status: "DONE" })],
      ["POST /zones/us-central1-a/instances", () => ({ name: "op-1", status: "RUNNING" })],
      ["GET /zones/us-central1-a/instances/", () => ({ status: "RUNNING" })],
      ["DELETE /zones/us-central1-a/instances/", () => ({})],
    ]);
    const handle = await computeStart(calls, "us-central1", { ...spec, kind: "vm" });
    expect(handle).toEqual({
      id: `iwci-${key}`,
      region: "us-central1",
      label: `gcp compute iwci-${key} (us-central1-a)`,
      data: { kind: "vm", zone: "us-central1-a" },
    });
    const insert = sent.find((s) => s.method === "POST" && s.url.includes("/instances?"));
    expect(new URL(insert?.url ?? "").searchParams.get("requestId")).toBe(uuidOf(key));
    expect(await computeStatus(calls, handle)).toEqual({ state: "running", detail: "RUNNING" });
    await computeTeardown(calls, handle);
    expect(sent.at(-1)?.method).toBe("DELETE");
  });

  it("names why an insert failed, and takes a taken name as its own", async () => {
    const failing = fakeGoogle([
      [
        "POST /zones/us-central1-a/instances",
        () => ({
          name: "op",
          status: "DONE",
          error: { errors: [{ message: "ZONE_RESOURCE_POOL_EXHAUSTED" }] },
        }),
      ],
    ]);
    await expect(
      computeStart(failing.calls, "us-central1-a", { ...spec, kind: "vm" }),
    ).rejects.toThrow("ZONE_RESOURCE_POOL_EXHAUSTED");
    const taken = fakeGoogle([
      ["POST /zones/us-central1-a/instances", () => Promise.reject(status(409))],
    ]);
    await expect(
      computeStart(taken.calls, "us-central1-a", { ...spec, kind: "vm" }),
    ).resolves.toMatchObject({
      id: `iwci-${key}`,
    });
  });

  it("reads a deleted instance as gone and its deletion as done", async () => {
    const { calls } = fakeGoogle([
      ["GET /instances/", () => Promise.reject(status(404))],
      ["DELETE /instances/", () => Promise.reject(status(404))],
    ]);
    const handle = {
      id: "iwci-x",
      region: "us-central1",
      label: "x",
      data: { kind: "vm", zone: "us-central1-a" },
    };
    expect(await computeStatus(calls, handle)).toEqual({ state: "gone" });
    await expect(computeTeardown(calls, handle)).resolves.toBeUndefined();
  });

  it("lists labelled instances in the regions asked, with their tags as sent", async () => {
    const { calls, sent } = fakeGoogle([
      [
        "GET /aggregated/instances",
        () => ({
          items: {
            "zones/us-central1-a": {
              instances: [
                {
                  name: "iwci-1",
                  status: "TERMINATED",
                  creationTimestamp: "2026-11-13T00:00:00Z",
                  metadata: {
                    items: [{ key: "infrawrench-ci-tags", value: JSON.stringify(tags) }],
                  },
                },
              ],
            },
            "zones/europe-west1-b": { instances: [{ name: "iwci-2", metadata: { items: [] } }] },
          },
        }),
      ],
    ]);
    const tagged = await computeListTagged(calls, "infrawrench-ci", ["us-central1"]);
    expect(tagged).toEqual([
      {
        handle: expect.objectContaining({
          id: "iwci-1",
          data: { kind: "vm", zone: "us-central1-a" },
        }),
        tags,
        createdAt: "2026-11-13T00:00:00Z",
        live: false,
      },
    ]);
    expect(new URL(sent[0]?.url ?? "").searchParams.get("filter")).toBe("labels.infrawrench-ci:*");
  });
});

describe("Cloud Run jobs", () => {
  it("creates and starts the job in one call, as a service account with no roles", () => {
    const body = jobBody({ ...spec, kind: "container" }, "acme") as Record<string, any>;
    expect(body["startExecutionToken"]).toBe("run");
    const task = body["template"].template;
    expect(task.serviceAccount).toBe("infrawrench-ci-runner@acme.iam.gserviceaccount.com");
    expect(task.timeout).toBe("3600s");
    expect(task.maxRetries).toBe(0);
    expect(task.containers[0].command).toEqual(["/bin/sh", "-c"]);
    expect(task.containers[0].args).toEqual([spec.bootstrap]);
    expect(task.containers[0].resources.limits).toEqual({ cpu: "2", memory: "4Gi" });
    expect(JSON.parse(body["annotations"]["infrawrench.com/ci-tags"])).toEqual(tags);
  });

  it("sizes jobs from Cloud Run's table", () => {
    expect(runResources("1vcpu-0.5gb")).toEqual({ cpu: "1", memory: "512Mi" });
    expect(() => runResources("3vcpu-4gb")).toThrow("1, 2, 4, 6 or 8");
    expect(() => runResources("4vcpu-1gb")).toThrow();
  });

  it("makes the service account, waits for it to settle, and takes a taken name as started", async () => {
    let creates = 0;
    const { calls, sent } = fakeGoogle([
      [
        "GET iam.googleapis.com/v1/projects/acme/serviceAccounts/",
        () => Promise.reject(status(404)),
      ],
      ["POST iam.googleapis.com/v1/projects/acme/serviceAccounts", () => ({})],
      [
        "POST run.googleapis.com/v2/projects/acme/locations/us-central1/jobs",
        () => {
          creates++;
          if (creates === 1)
            return Promise.reject(
              status(400, "Service account infrawrench-ci-runner does not exist."),
            );
          return Promise.reject(status(409));
        },
      ],
    ]);
    const handle = await runStart(calls, "us-central1", { ...spec, kind: "container" });
    expect(handle).toEqual({
      id: `iwci-${key}`,
      region: "us-central1",
      label: `gcp run job iwci-${key} (us-central1)`,
      data: { kind: "container" },
    });
    expect(creates).toBe(2);
    const account = sent.find((s) => s.method === "POST" && s.url.endsWith("/serviceAccounts"));
    expect(account?.body).toMatchObject({ accountId: "infrawrench-ci-runner" });
    // Nothing grants the account a role.
    expect(sent.some((s) => s.url.includes("setIamPolicy"))).toBe(false);
  });

  it("follows the execution, and deletes the job", async () => {
    let executions: unknown[] = [];
    const { calls } = fakeGoogle([
      ["GET /jobs/iwci-1/executions", () => ({ executions })],
      ["DELETE /jobs/iwci-1", () => ({})],
    ]);
    const handle = { id: "iwci-1", region: "us-central1", label: "x", data: { kind: "container" } };
    expect(await runStatus(calls, handle)).toEqual({ state: "starting" });
    executions = [{ runningCount: 1 }];
    expect(await runStatus(calls, handle)).toEqual({ state: "running" });
    executions = [{ completionTime: "2026-11-13T00:00:00Z", succeededCount: 1 }];
    expect(await runStatus(calls, handle)).toMatchObject({ state: "stopped" });
    await runTeardown(calls, handle);
  });

  it("reads a deleted job as gone, and lists only CI jobs with tags", async () => {
    const { calls } = fakeGoogle([
      ["GET /jobs/iwci-1/executions", () => Promise.reject(status(404))],
      ["DELETE /jobs/iwci-1", () => Promise.reject(status(404))],
      [
        "GET /locations/us-central1/jobs",
        () => ({
          jobs: [
            {
              name: "projects/acme/locations/us-central1/jobs/iwci-1",
              annotations: { "infrawrench.com/ci-tags": JSON.stringify(tags) },
              createTime: "t",
            },
            { name: "projects/acme/locations/us-central1/jobs/nightly" },
          ],
        }),
      ],
    ]);
    const handle = { id: "iwci-1", region: "us-central1", label: "x", data: { kind: "container" } };
    expect(await runStatus(calls, handle)).toEqual({ state: "gone" });
    await expect(runTeardown(calls, handle)).resolves.toBeUndefined();
    const tagged = await runListTagged(calls, "infrawrench-ci", ["us-central1"]);
    expect(tagged.map((t) => [t.handle.id, t.live, t.tags])).toEqual([["iwci-1", true, tags]]);
  });
});

describe("Cloud Build", () => {
  it("runs the bootstrap as a script, logging nothing, as a service account with no roles", () => {
    const body = buildBody({ ...spec, kind: "build" }, "acme") as Record<string, any>;
    expect(body["steps"]).toEqual([
      { name: "gcr.io/cloud-builders/docker", script: spec.bootstrap },
    ]);
    expect(body["timeout"]).toBe("3600s");
    expect(body["serviceAccount"]).toBe(
      "projects/acme/serviceAccounts/infrawrench-ci-runner@acme.iam.gserviceaccount.com",
    );
    expect(body["options"]).toEqual({
      machineType: "E2_STANDARD_2",
      logging: "NONE",
      substitutionOption: "ALLOW_LOOSE",
    });
    expect(body["tags"]).toContain("infrawrench-ci");
    expect(body["tags"]).toContain(`iwci-${key}`);
    expect(JSON.parse(body["substitutions"]["_INFRAWRENCH_CI_TAGS"])).toEqual(tags);
    expect(machineType("E2_HIGHCPU_8")).toBe("E2_HIGHCPU_8");
    expect(() => machineType("e2-micro")).toThrow("e2-highcpu-8");
  });

  it("reuses the build a retried start made, else starts one", async () => {
    let earlier: unknown[] = [{ id: "b-0" }];
    const { calls, sent } = fakeGoogle([
      ["GET iam.googleapis.com/v1/projects/acme/serviceAccounts/", () => ({})],
      ["GET /locations/us-central1/builds", () => ({ builds: earlier })],
      ["POST /locations/us-central1/builds", () => ({ metadata: { build: { id: "b-1" } } })],
    ]);
    expect((await buildStart(calls, "us-central1", { ...spec, kind: "build" })).id).toBe("b-0");
    expect(new URL(sent[0]?.url ?? "").searchParams.get("filter")).toBe(`tags="iwci-${key}"`);
    earlier = [];
    expect((await buildStart(calls, "us-central1", { ...spec, kind: "build" })).id).toBe("b-1");
  });

  it("follows the build, cancels it, and takes a finished one as done", async () => {
    let state = "WORKING";
    const { calls } = fakeGoogle([
      [
        "POST /builds/b-1:cancel",
        () => (state === "WORKING" ? {} : Promise.reject(status(400, "not running"))),
      ],
      ["GET /builds/b-1", () => ({ status: state })],
    ]);
    const handle = { id: "b-1", region: "us-central1", label: "x", data: { kind: "build" } };
    expect(await buildStatus(calls, handle)).toEqual({ state: "running", detail: "WORKING" });
    await buildTeardown(calls, handle);
    state = "SUCCESS";
    expect(await buildStatus(calls, handle)).toEqual({ state: "gone", detail: "SUCCESS" });
    await expect(buildTeardown(calls, handle)).resolves.toBeUndefined();
  });

  it("lists running tagged builds", async () => {
    const { calls, sent } = fakeGoogle([
      [
        "GET /locations/europe-west1/builds",
        () => ({
          builds: [
            {
              id: "b-1",
              createTime: "t",
              substitutions: { _INFRAWRENCH_CI_TAGS: JSON.stringify(tags) },
            },
          ],
        }),
      ],
    ]);
    const tagged = await buildListTagged(calls, "infrawrench-ci", ["europe-west1"]);
    expect(tagged).toEqual([
      {
        handle: expect.objectContaining({ id: "b-1", region: "europe-west1" }),
        tags,
        createdAt: "t",
        live: true,
      },
    ]);
    expect(new URL(sent[0]?.url ?? "").searchParams.get("filter")).toContain(
      'tags="infrawrench-ci"',
    );
  });
});

describe("gcpCiListTagged", () => {
  it("does not let a switched-off API hide the other kinds", async () => {
    const disabled = Object.assign(status(403), { apiDisabled: true });
    const { calls } = fakeGoogle([
      [
        "GET /aggregated/instances",
        () => ({
          items: {
            "zones/us-central1-a": {
              instances: [
                {
                  name: "iwci-1",
                  metadata: {
                    items: [{ key: "infrawrench-ci-tags", value: JSON.stringify(tags) }],
                  },
                },
              ],
            },
          },
        }),
      ],
      ["GET run.googleapis.com", () => Promise.reject(disabled)],
      ["GET cloudbuild.googleapis.com", () => Promise.reject(disabled)],
    ]);
    const tagged = await gcpCiListTagged(calls, "infrawrench-ci", []);
    expect(tagged.map((t) => t.handle.id)).toEqual(["iwci-1"]);
  });
});
