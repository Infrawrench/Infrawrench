import { describe, expect, it } from "vitest";

import { FakeHttpReply, fakeCiHttp } from "@infrawrench/plugin-base/test-harness";

import { createVastApi } from "../api.js";
import {
  decodeTags,
  encodeTags,
  envValue,
  gpuNameVariants,
  instanceArgs,
  offerFits,
  offerNeeds,
  rentBody,
  TAGS_ENV,
  vastCiListTagged,
  vastCiPreflight,
  vastCiStart,
  vastCiStatus,
  vastCiTeardown,
} from "../ci-executor.js";

const tags = {
  "infrawrench-ci": "org-org_01HZX",
  "infrawrench-ci-run": "4c1f6a2e-9b7d-4e3a-8f21-0d5c6b7a8e9f",
  "infrawrench-ci-job": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
};
const spec = {
  kind: "container" as const,
  machine: "4vcpu-16gb",
  bootstrap: "#!/bin/sh\necho hi\n",
  tags,
  name: "infrawrench-ci-build",
  maxSeconds: 3600,
};
const NAME = "iwci-0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const KEY = "vast-SECRET-key";

function vast(routes: Parameters<typeof fakeCiHttp>[0]) {
  const { http, sent } = fakeCiHttp(routes);
  return { api: createVastApi(KEY, "", { http }), sent };
}

function offer(over: Record<string, unknown> = {}) {
  return {
    id: 501,
    gpu_name: "RTX 4090",
    num_gpus: 1,
    cpu_cores_effective: 8,
    cpu_ram: 32000,
    disk_space: 100,
    dph_total: 0.4,
    geolocation: "Texas, US",
    ...over,
  };
}

function instance(over: Record<string, unknown> = {}) {
  return {
    id: 9001,
    label: NAME,
    actual_status: "running",
    intended_status: "running",
    start_date: 1_794_560_400,
    extra_env: [
      [TAGS_ENV, encodeTags(tags)],
      ["-p 22:22", "1"],
    ],
    ...over,
  };
}
const page = (instances: unknown[]) => ({ instances, next_token: null });

describe("Vast.ai CI executor", () => {
  it("keeps tags exactly in the instance's environment", () => {
    expect(decodeTags(envValue(instance().extra_env, TAGS_ENV))).toEqual(tags);
    expect(envValue([`${TAGS_ENV}=abc`], TAGS_ENV)).toBe("abc");
    expect(envValue(undefined, TAGS_ENV)).toBeUndefined();
  });

  it("reads the machine and cloud.gpu as what an offer needs", () => {
    expect(offerNeeds({ machine: "4vcpu-16gb", gpu: "h100_sxm:8" })).toEqual({
      gpuType: "h100_sxm",
      gpuCount: 8,
      vcpus: 4,
      memoryGb: 16,
    });
    expect(offerNeeds({ machine: "RTX 4090", region: "US" })).toEqual({
      gpuType: "RTX 4090",
      gpuCount: 1,
      vcpus: 0,
      memoryGb: 0,
      region: "US",
    });
    expect(offerNeeds({ machine: "8vcpu-32gb" })).toMatchObject({ gpuCount: 1, vcpus: 8 });
    expect(() => offerNeeds({ machine: "RTX 3090", gpu: "H100" })).toThrow("name one GPU");
    expect(gpuNameVariants("rtx_4090")).toEqual(
      expect.arrayContaining(["rtx_4090", "rtx 4090", "RTX_4090", "RTX 4090"]),
    );
  });

  it("checks what the search cannot", () => {
    const needs = { gpuType: "rtx4090", gpuCount: 1, vcpus: 4, memoryGb: 16, region: "us" };
    expect(offerFits(offer(), needs)).toBe(true);
    expect(offerFits(offer({ gpu_name: "RTX 3090" }), needs)).toBe(false);
    expect(offerFits(offer({ cpu_ram: 8000 }), needs)).toBe(false);
    expect(offerFits(offer({ disk_space: 16 }), needs)).toBe(false);
    expect(offerFits(offer({ geolocation: "Sweden, SE" }), needs)).toBe(false);
  });

  it("runs the job under the watchdog and keeps Vast's instance key out of it", () => {
    const body = rentBody(spec);
    expect(body).toMatchObject({
      client_id: "me",
      image: "docker.io/library/buildpack-deps:noble-curl",
      runtype: "args",
      label: NAME,
      disk: 32,
      target_state: "running",
      cancel_unavail: true,
      env: { [TAGS_ENV]: encodeTags(tags) },
    });
    const args = instanceArgs(spec.bootstrap, spec.maxSeconds);
    expect(args.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(args[2]).toContain("unset CONTAINER_API_KEY");
    expect(args[2]).toContain("https://console.vast.ai/api/v0/instances/$CONTAINER_ID/");
    expect(args[4]).toContain("sleep 3600");
    expect(args[5]).toContain("echo hi");
  });

  it("rents the cheapest fitting offer, moving on when one is taken", async () => {
    const { api, sent } = vast([
      ["GET /api/v1/instances/", () => page([])],
      [
        "POST /api/v0/bundles/",
        () => ({ offers: [offer({ cpu_ram: 1000 }), offer({ id: 502 }), offer({ id: 503 })] }),
      ],
      ["PUT /api/v0/asks/502/", () => ({ success: false, error: "no_such_ask", msg: "taken" })],
      ["PUT /api/v0/asks/503/", () => ({ success: true, new_contract: 9001 })],
    ]);
    const handle = await vastCiStart(api, { ...spec, gpu: "RTX_4090" });
    expect(handle).toEqual({
      id: "9001",
      region: "Texas, US",
      label: "vast.ai instance 9001 (1x RTX 4090)",
    });
    const lookup = sent[0]!;
    expect(lookup.url.searchParams.get("select_filters")).toBe(
      JSON.stringify({ label: { eq: NAME } }),
    );
    const search = sent.find((c) => c.method === "POST")!.body as Record<string, unknown>;
    expect(search).toMatchObject({
      verified: { eq: true },
      rented: { eq: false },
      type: "ondemand",
      num_gpus: { in: [1] },
      order: [["dph_total", "asc"]],
    });
    expect((search["gpu_name"] as { in: string[] }).in).toContain("RTX 4090");
    const puts = sent.filter((c) => c.method === "PUT");
    expect(puts.map((c) => c.url.pathname)).toEqual(["/api/v0/asks/502/", "/api/v0/asks/503/"]);
    expect(JSON.stringify(puts[1]!.body)).not.toContain(KEY);
  });

  it("falls back to matching names when Vast spells the GPU differently", async () => {
    let searches = 0;
    const { api } = vast([
      ["GET /api/v1/instances/", () => page([])],
      [
        "POST /api/v0/bundles/",
        () => ({ offers: searches++ === 0 ? [] : [offer({ gpu_name: "H100 SXM", num_gpus: 8 })] }),
      ],
      ["PUT /api/v0/asks/501/", () => ({ success: true, new_contract: 77 })],
    ]);
    expect(await vastCiStart(api, { ...spec, gpu: "h100:8" })).toMatchObject({ id: "77" });
    expect(searches).toBe(2);
  });

  it("says so when nothing fits", async () => {
    const { api } = vast([
      ["GET /api/v1/instances/", () => page([])],
      ["POST /api/v0/bundles/", () => ({ offers: [] })],
    ]);
    await expect(vastCiStart(api, { ...spec, gpu: "B200:8" })).rejects.toThrow(
      "no verified on-demand offer with 8x B200",
    );
  });

  it("finds the instance a first start made", async () => {
    const { api, sent } = vast([["GET /api/v1/instances/", () => page([instance()])]]);
    expect(await vastCiStart(api, spec)).toMatchObject({ id: "9001" });
    expect(sent).toHaveLength(1);
  });

  it("follows the instance and treats a missing one as gone", async () => {
    const { api } = vast([
      ["GET /api/v0/instances/1/", () => ({ instances: instance({ actual_status: null }) })],
      ["GET /api/v0/instances/2/", () => ({ instances: instance() })],
      ["GET /api/v0/instances/3/", () => ({ instances: instance({ actual_status: "exited" }) })],
      [
        "GET /api/v0/instances/4/",
        () => new FakeHttpReply(404, { success: false, error: "not_found" }),
      ],
    ]);
    expect((await vastCiStatus(api, { id: "1", label: "" })).state).toBe("starting");
    expect((await vastCiStatus(api, { id: "2", label: "" })).state).toBe("running");
    expect((await vastCiStatus(api, { id: "3", label: "" })).state).toBe("stopped");
    expect(await vastCiStatus(api, { id: "4", label: "" })).toEqual({ state: "gone" });
  });

  it("tears down idempotently", async () => {
    const { api, sent } = vast([
      ["DELETE /api/v0/instances/9001/", () => ({ success: true })],
      [
        "DELETE /api/v0/instances/9002/",
        () => new FakeHttpReply(404, { success: false, error: "not_found" }),
      ],
    ]);
    await vastCiTeardown(api, { id: "9001", label: "" });
    await vastCiTeardown(api, { id: "9002", label: "" });
    expect(sent).toHaveLength(2);
  });

  it("lists what carries the tag, with its tags as sent", async () => {
    const { api } = vast([
      [
        "GET /api/v1/instances/",
        () =>
          page([
            instance(),
            instance({ id: 9002, actual_status: "exited", intended_status: "stopped" }),
            instance({ id: 9003, label: "my training run", extra_env: [] }),
          ]),
      ],
    ]);
    const found = await vastCiListTagged(api, "infrawrench-ci");
    expect(found.map((f) => [f.handle.id, f.live])).toEqual([
      ["9001", true],
      ["9002", false],
    ]);
    expect(found[0]?.tags).toEqual(tags);
    expect(found[0]?.createdAt).toBe(new Date(1_794_560_400_000).toISOString());
  });

  it("names the permissions a key lacks", async () => {
    const { api } = vast([
      ["GET /api/v1/instances/", () => page([])],
      ["DELETE /api/v0/instances/0/", () => new FakeHttpReply(403, { msg: "forbidden" })],
      ["GET /api/v0/users/current/", () => ({ credit: 0 })],
    ]);
    const result = await vastCiPreflight(api, "container");
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.permission)).toEqual(["instance_write"]);
    expect(result.problems[0]).toContain("no credit");
    await expect(vastCiPreflight(api, "vm")).rejects.toThrow("kind `container`");
  });

  it("passes a key that may rent and destroy", async () => {
    const { api } = vast([
      ["GET /api/v1/instances/", () => page([])],
      [
        "DELETE /api/v0/instances/0/",
        () => new FakeHttpReply(404, { success: false, error: "not_found" }),
      ],
      ["GET /api/v0/users/current/", () => ({ credit: 12.5 })],
    ]);
    expect(await vastCiPreflight(api, "container")).toEqual({
      ok: true,
      missing: [],
      problems: [],
    });
  });
});
