import { describe, expect, it } from "vitest";

import type { HostServices } from "@infrawrench/plugin-base";
import { FakeHttpReply, fakeCiHttp } from "@infrawrench/plugin-base/test-harness";

import { createLambdaApi } from "../api.js";
import {
  lambdaCiListTagged,
  lambdaCiPreflight,
  lambdaCiStart,
  lambdaCiStatus,
  lambdaCiTeardown,
  lambdaTagKey,
  lambdaUserData,
  launchBody,
  placeJob,
} from "../ci-executor.js";
import type { LInstanceTypeItem } from "../types.js";

const tags = {
  "infrawrench-ci": "org-org_01HZX",
  "infrawrench-ci-run": "4c1f6a2e-9b7d-4e3a-8f21-0d5c6b7a8e9f",
  "infrawrench-ci-job": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
};
const spec = {
  kind: "vm" as const,
  bootstrap: "#!/bin/sh\necho 'hi'\n",
  tags,
  name: "infrawrench-ci-build",
  maxSeconds: 3600,
};
const NAME = "iwci-0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const KEY = "secret_lambda_key";

function lambda(routes: Parameters<typeof fakeCiHttp>[0]) {
  const { http, sent } = fakeCiHttp(routes);
  return { api: createLambdaApi(KEY, "", { http } as HostServices), sent };
}

function type(
  name: string,
  gpus: number,
  gpu: string,
  cents: number,
  regions: string[],
): LInstanceTypeItem {
  return {
    instance_type: {
      name,
      description: name,
      gpu_description: gpu,
      price_cents_per_hour: cents,
      architecture: "x86_64",
      specs: { gpus, vcpus: 30, memory_gib: 200, storage_gib: 1000 },
    },
    regions_with_capacity_available: regions.map((r) => ({ name: r, description: r })),
  };
}

const TYPES = [
  type("gpu_1x_a10", 1, "A10 (24 GB PCIe)", 75, ["us-east-1"]),
  type("gpu_1x_h100_pcie", 1, "H100 (80 GB PCIe)", 249, []),
  type("gpu_1x_h100_sxm5", 1, "H100 (80 GB SXM5)", 329, ["us-south-2", "us-west-3"]),
  type("gpu_8x_h100_sxm5", 8, "H100 (80 GB SXM5)", 2392, ["us-west-3"]),
  type("gpu_1x_a100_sxm4", 1, "A100 (40 GB SXM4)", 129, ["us-west-2"]),
];
const types = async () => TYPES;

const INSTANCE = {
  id: "0920582c7ff041399e34823a0be62549",
  name: NAME,
  status: "active",
  region: { name: "us-west-3", description: "Utah" },
  tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
};

describe("Lambda Cloud CI executor", () => {
  it("runs the bootstrap under a timeout and never powers off", () => {
    const data = lambdaUserData(spec.bootstrap, 3600);
    expect(data).toMatch(/^#!\/bin\/bash\n/);
    expect(data).toContain("timeout --kill-after=30 3600 /bin/bash -c '#!/bin/sh");
    expect(data).toContain(`echo '\\''hi'\\''`);
    expect(data).not.toContain("shutdown");
  });

  it("keeps CI tag keys and encodes others reversibly", () => {
    expect(lambdaTagKey("infrawrench-ci-job")).toBe("infrawrench-ci-job");
    expect(lambdaTagKey("Team")).toBe("x-5465616d");
    const body = launchBody(spec, { machine: "gpu_1x_a10", region: "us-east-1" }, NAME);
    expect(body).toMatchObject({
      region_name: "us-east-1",
      instance_type_name: "gpu_1x_a10",
      ssh_key_names: [NAME],
      name: NAME,
      hostname: NAME,
    });
    expect(body).not.toHaveProperty("image");
    expect(body.tags).toContainEqual({ key: "infrawrench-ci", value: "org-org_01HZX" });
    expect(
      launchBody({ ...spec, image: "ubuntu-24-04" }, { machine: "m", region: "r" }, NAME),
    ).toMatchObject({ image: { family: "ubuntu-24-04" } });
  });

  it("places a GPU request on the cheapest type with room", async () => {
    expect(await placeJob(types, { gpu: "H100", machine: "gpu_1x_a10" })).toEqual({
      machine: "gpu_1x_h100_sxm5",
      region: "us-south-2",
    });
    expect(await placeJob(types, { gpu: "h100:8" })).toEqual({
      machine: "gpu_8x_h100_sxm5",
      region: "us-west-3",
    });
    expect(await placeJob(types, { gpu: "h100", region: "us-west-3" })).toEqual({
      machine: "gpu_1x_h100_sxm5",
      region: "us-west-3",
    });
    expect(await placeJob(types, { machine: "gpu_1x_a100_sxm4" })).toEqual({
      machine: "gpu_1x_a100_sxm4",
      region: "us-west-2",
    });
    await expect(placeJob(types, { gpu: "b200" })).rejects.toThrow("no instance type with 1 b200");
    await expect(placeJob(types, { machine: "gpu_1x_h100_pcie" })).rejects.toThrow("no capacity");
    await expect(placeJob(types, { machine: "gpu_1x_a100_sxm4", gpu: "h100" })).rejects.toThrow(
      "does not have 1 h100",
    );
  });

  it("launches with a throwaway key, then removes the key", async () => {
    const { api, sent } = lambda([
      ["GET /instances", () => ({ data: [], page_token: null })],
      ["GET /ssh-keys", () => ({ data: [] })],
      ["POST /ssh-keys", () => ({ data: { id: "k1", name: NAME, public_key: "x" } })],
      [
        "POST /instance-operations/launch",
        () => ({ data: { instance_ids: ["0920582c7ff041399e34823a0be62549"] } }),
      ],
      ["DELETE /ssh-keys/k1", () => ({ data: {} })],
    ]);
    const handle = await lambdaCiStart(api, types, { ...spec, gpu: "a10" });
    expect(handle).toEqual({
      id: "0920582c7ff041399e34823a0be62549",
      region: "us-east-1",
      label: "lambda-cloud instance 0920582c7ff0 (us-east-1)",
    });
    const key = sent.find((c) => c.method === "POST" && c.url.pathname.endsWith("/ssh-keys"));
    expect((key?.body as { public_key: string }).public_key).toMatch(/^ssh-ed25519 /);
    const launch = sent.find((c) => c.url.pathname.endsWith("/launch"));
    expect(launch?.body).toMatchObject({ instance_type_name: "gpu_1x_a10", name: NAME });
    expect(JSON.stringify(launch?.body)).not.toContain(KEY);
    expect(sent.at(-1)?.method).toBe("DELETE");
  });

  it("finds the instance a first start made", async () => {
    const { api, sent } = lambda([
      ["GET /instances", () => ({ data: [INSTANCE], page_token: null })],
    ]);
    expect(await lambdaCiStart(api, types, spec)).toMatchObject({
      id: INSTANCE.id,
      region: "us-west-3",
    });
    expect(sent).toHaveLength(1);
  });

  it("removes the key when the launch fails", async () => {
    const { api, sent } = lambda([
      ["GET /instances", () => ({ data: [], page_token: null })],
      ["GET /ssh-keys", () => ({ data: [{ id: "k1", name: NAME, public_key: "x" }] })],
      [
        "POST /instance-operations/launch",
        () =>
          new FakeHttpReply(400, {
            error: { code: "instance-operations/launch/insufficient-capacity", message: "no" },
          }),
      ],
      ["DELETE /ssh-keys/k1", () => ({ data: {} })],
    ]);
    await expect(lambdaCiStart(api, types, spec)).rejects.toThrow("400");
    expect(sent.at(-1)).toMatchObject({ method: "DELETE" });
  });

  it("reads status and treats a missing instance as gone", async () => {
    const { api } = lambda([
      [`GET /instances/${INSTANCE.id}`, () => ({ data: { ...INSTANCE, status: "booting" } })],
      [
        "GET /instances/gone",
        () =>
          new FakeHttpReply(404, {
            error: { code: "global/object-does-not-exist", message: "Not found" },
          }),
      ],
    ]);
    expect(await lambdaCiStatus(api, { id: INSTANCE.id, label: "x" })).toEqual({
      state: "starting",
      detail: "booting",
    });
    expect(await lambdaCiStatus(api, { id: "gone", label: "x" })).toEqual({ state: "gone" });
  });

  it("tears down idempotently", async () => {
    const { api, sent } = lambda([
      [
        "POST /instance-operations/terminate",
        (c) =>
          (c.body as { instance_ids: string[] }).instance_ids[0] === "gone"
            ? new FakeHttpReply(404, { error: { code: "global/object-does-not-exist" } })
            : new FakeHttpReply(400, { error: { code: "global/invalid-parameters" } }),
      ],
      [`GET /instances/${INSTANCE.id}`, () => ({ data: { ...INSTANCE, status: "terminating" } })],
    ]);
    await lambdaCiTeardown(api, { id: "gone", label: "x" });
    await lambdaCiTeardown(api, { id: INSTANCE.id, label: "x" });
    expect(sent.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("lists only tagged instances, with their tags as sent", async () => {
    const { api } = lambda([
      [
        "GET /instances",
        () => ({
          data: [
            INSTANCE,
            { ...INSTANCE, id: "other", tags: [] },
            { ...INSTANCE, id: "old", status: "terminated" },
            {
              ...INSTANCE,
              id: "unhealthy",
              status: "unhealthy",
              tags: [...INSTANCE.tags, { key: "x-5465616d", value: "web" }],
            },
          ],
          page_token: null,
        }),
      ],
    ]);
    const found = await lambdaCiListTagged(api, "infrawrench-ci");
    expect(found.map((f) => f.handle.id)).toEqual([INSTANCE.id, "unhealthy"]);
    expect(found[0]?.tags).toEqual(tags);
    expect(found[1]?.tags).toEqual({ ...tags, Team: "web" });
    expect(found.every((f) => f.live)).toBe(true);
  });

  it("names what a key may not do", async () => {
    const forbidden = () =>
      new FakeHttpReply(403, { error: { code: "global/forbidden", message: "Forbidden" } });
    const notFound = () =>
      new FakeHttpReply(404, { error: { code: "global/object-does-not-exist" } });
    const { api } = lambda([
      ["GET /instances", () => ({ data: [], page_token: null })],
      ["GET /ssh-keys", () => ({ data: [] })],
      ["POST /instance-operations/terminate", forbidden],
      ["DELETE /ssh-keys/", notFound],
      ["GET /regions", () => ({ data: [{ name: "us-east-1", description: "Virginia" }] })],
    ]);
    const result = await lambdaCiPreflight(api, "vm", "us-west-9");
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.permission)).toEqual(["Instance: Terminate"]);
    expect(result.problems).toEqual([
      "Lambda Cloud has no region `us-west-9`. Name one such as us-east-1.",
    ]);
    await expect(lambdaCiPreflight(api, "container")).rejects.toThrow("kind `vm`");
  });
});
