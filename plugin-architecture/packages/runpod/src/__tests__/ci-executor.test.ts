import { describe, expect, it } from "vitest";

import { FakeHttpReply, fakeCiHttp } from "@infrawrench/plugin-base/test-harness";

import { RunpodApi } from "../api.js";
import {
  computeOf,
  decodeTags,
  encodeTags,
  parseCpuMachine,
  podBody,
  podCommand,
  resolveGpuType,
  runpodCiListTagged,
  runpodCiPreflight,
  runpodCiStart,
  runpodCiStatus,
  runpodCiTeardown,
  TAGS_ENV,
} from "../ci-executor.js";
import type { RpGpuType } from "../types.js";

const tags = {
  "infrawrench-ci": "org-org_01HZX",
  "infrawrench-ci-run": "4c1f6a2e-9b7d-4e3a-8f21-0d5c6b7a8e9f",
  "infrawrench-ci-job": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
};
const spec = {
  kind: "container" as const,
  machine: "cpu3c-2",
  bootstrap: "#!/bin/sh\necho hi\n",
  tags,
  name: "infrawrench-ci-build",
  maxSeconds: 3600,
};
const NAME = "iwci-0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const KEY = "rpa_SECRETKEY";

function gpu(id: string, name: string, max = 8): RpGpuType {
  return {
    id,
    name,
    pool: null,
    manufacturer: "NVIDIA",
    memory: 80,
    secure: true,
    community: true,
    price: { secure: 2, community: 1.5 },
    maxCount: { secure: max, community: max },
  } as RpGpuType;
}
const CATALOG = [
  gpu("NVIDIA GeForce RTX 4090", "RTX 4090"),
  gpu("NVIDIA H100 80GB HBM3", "H100 SXM"),
  gpu("NVIDIA H100 PCIe", "H100 PCIe"),
  gpu("NVIDIA L40S", "L40S"),
  gpu("NVIDIA L40", "L40"),
];

function runpod(routes: Parameters<typeof fakeCiHttp>[0]) {
  const { http, sent } = fakeCiHttp(routes);
  return { api: new RunpodApi(KEY, "", { http }), sent };
}

function pod(over: Record<string, unknown> = {}) {
  return {
    id: "pod_abc",
    name: NAME,
    status: "RUNNING",
    dataCenterId: "US-TX-3",
    createdAt: "2026-11-13T10:00:00Z",
    env: { [TAGS_ENV]: encodeTags(tags) },
    ...over,
  };
}
const page = (pods: unknown[]) => ({
  pods,
  pagination: { nextCursor: null, hasNextPage: false },
});

describe("Runpod CI executor", () => {
  it("keeps tags exactly in the pod's environment", () => {
    expect(decodeTags(encodeTags(tags))).toEqual(tags);
    expect(decodeTags("not base64 json")).toBeNull();
    expect(decodeTags(undefined)).toBeNull();
  });

  it("reads CPU machines", () => {
    expect(parseCpuMachine("cpu3c-2")).toEqual({ id: "cpu3c", vcpuCount: 2 });
    expect(parseCpuMachine("CPU5C:8")).toEqual({ id: "cpu5c", vcpuCount: 8 });
    expect(parseCpuMachine("cpu5g")).toEqual({ id: "cpu5g", vcpuCount: 2 });
    expect(() => parseCpuMachine("cpu3c-3")).toThrow("power of two");
    expect(parseCpuMachine("NVIDIA L40S")).toBeNull();
  });

  it("maps cloud.gpu to one Runpod GPU type", () => {
    expect(resolveGpuType(CATALOG, "rtx 4090").id).toBe("NVIDIA GeForce RTX 4090");
    expect(resolveGpuType(CATALOG, "H100 SXM").id).toBe("NVIDIA H100 80GB HBM3");
    expect(resolveGpuType(CATALOG, "h100-pcie").id).toBe("NVIDIA H100 PCIe");
    expect(resolveGpuType(CATALOG, "L40").id).toBe("NVIDIA L40");
    expect(resolveGpuType(CATALOG, "NVIDIA L40S").id).toBe("NVIDIA L40S");
    expect(() => resolveGpuType(CATALOG, "h100")).toThrow("more than one Runpod GPU type");
    expect(() => resolveGpuType(CATALOG, "b200")).toThrow("no GPU type `b200`");
  });

  it("makes a GPU pod from cloud.gpu even beside the default CPU machine", async () => {
    const catalog = async () => CATALOG;
    expect(await computeOf({ machine: "cpu3c-2", gpu: "rtx4090:2" }, catalog)).toEqual({
      gpu: { id: "NVIDIA GeForce RTX 4090", count: 2 },
    });
    expect(await computeOf({ machine: "NVIDIA L40S" }, catalog)).toEqual({
      gpu: { id: "NVIDIA L40S", count: 1 },
    });
    expect(await computeOf({ machine: "cpu5c-4" }, catalog)).toEqual({
      cpu: { id: "cpu5c", vcpuCount: 4 },
    });
    await expect(computeOf({ machine: "L40", gpu: "L40S" }, catalog)).rejects.toThrow(
      "name one GPU type",
    );
    await expect(computeOf({ gpu: "l40s:16" }, catalog)).rejects.toThrow("at most 8");
  });

  it("runs the job under the watchdog and keeps Runpod's pod key out of it", async () => {
    const body = await podBody({ ...spec, region: "US-TX-3" }, async () => CATALOG);
    expect(body).toMatchObject({
      name: NAME,
      image: "docker.io/library/buildpack-deps:noble-curl",
      cloud: "SECURE",
      dataCenterIds: ["US-TX-3"],
      cpu: { id: "cpu3c", vcpuCount: 2 },
    });
    expect(body).not.toHaveProperty("startSsh");
    expect(body.env).toEqual({ [TAGS_ENV]: encodeTags(tags) });
    const { entrypoint, cmd } = podCommand(spec.bootstrap, spec.maxSeconds);
    expect(entrypoint.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(entrypoint[2]).toContain("unset RUNPOD_API_KEY");
    expect(entrypoint[2]).toContain("https://api.runpod.io/v2/pods/$RUNPOD_POD_ID");
    expect(cmd[0]).toBe("iwci");
    expect(cmd[1]).toContain("sleep 3600");
    expect(cmd[2]).toContain("echo hi");
  });

  it("starts one pod and sends no key to it", async () => {
    const { api, sent } = runpod([
      ["GET /v2/pods", () => page([pod({ id: "pod_other", name: "someone-else" })])],
      ["GET /v2/catalog/gpus", () => ({ gpus: CATALOG })],
      ["POST /v2/pods", () => new FakeHttpReply(201, pod({ status: "PROVISIONING" }))],
    ]);
    const handle = await runpodCiStart(api, { ...spec, gpu: "rtx 4090" });
    expect(handle).toEqual({
      id: "pod_abc",
      region: "US-TX-3",
      label: "runpod pod pod_abc (US-TX-3)",
    });
    const create = sent.find((c) => c.method === "POST");
    expect(create?.body).toMatchObject({ gpu: { id: "NVIDIA GeForce RTX 4090", count: 1 } });
    expect(JSON.stringify(create?.body)).not.toContain(KEY);
    expect(create?.headers["Authorization"] ?? create?.headers["authorization"]).toBe(
      `Bearer ${KEY}`,
    );
  });

  it("finds the pod a first start made", async () => {
    const { api, sent } = runpod([["GET /v2/pods", () => page([pod()])]]);
    expect(await runpodCiStart(api, spec)).toMatchObject({ id: "pod_abc" });
    expect(sent).toHaveLength(1);
  });

  it("follows the pod and treats a missing one as gone", async () => {
    const { api } = runpod([
      ["GET /v2/pods/pod_abc", () => pod({ status: "STARTING" })],
      ["GET /v2/pods/pod_x", () => new FakeHttpReply(404, { title: "Not Found", status: 404 })],
      ["GET /v2/pods/pod_e", () => pod({ status: "EXITED" })],
    ]);
    expect(await runpodCiStatus(api, { id: "pod_abc", label: "" })).toEqual({
      state: "starting",
      detail: "STARTING",
    });
    expect(await runpodCiStatus(api, { id: "pod_x", label: "" })).toEqual({ state: "gone" });
    expect((await runpodCiStatus(api, { id: "pod_e", label: "" })).state).toBe("stopped");
  });

  it("tears down idempotently", async () => {
    const { api, sent } = runpod([
      ["DELETE /v2/pods/pod_abc", () => undefined],
      ["DELETE /v2/pods/pod_x", () => new FakeHttpReply(404, { title: "Not Found" })],
    ]);
    await runpodCiTeardown(api, { id: "pod_abc", label: "" });
    await runpodCiTeardown(api, { id: "pod_x", label: "" });
    expect(sent.map((c) => c.url.pathname)).toEqual(["/v2/pods/pod_abc", "/v2/pods/pod_x"]);
  });

  it("lists what carries the tag, with its tags as sent", async () => {
    const { api } = runpod([
      [
        "GET /v2/pods",
        () =>
          page([
            pod(),
            pod({ id: "pod_e", status: "EXITED" }),
            pod({ id: "pod_t", status: "TERMINATED" }),
            pod({ id: "pod_mine", name: "my pod", env: {} }),
          ]),
      ],
    ]);
    const found = await runpodCiListTagged(api, "infrawrench-ci");
    expect(found.map((f) => [f.handle.id, f.live])).toEqual([
      ["pod_abc", true],
      ["pod_e", false],
    ]);
    expect(found[0]?.tags).toEqual(tags);
    expect(found[0]?.createdAt).toBe("2026-11-13T10:00:00Z");
  });

  it("names the access a read-only key lacks", async () => {
    const { api } = runpod([
      ["GET /v2/pods", () => page([])],
      ["DELETE /v2/pods/", () => new FakeHttpReply(403, { title: "Forbidden" })],
      ["GET /v2/catalog/datacenters", () => ({ dataCenters: [{ id: "US-TX-3" }] })],
    ]);
    const result = await runpodCiPreflight(api, "container", "EU-NOPE-1");
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.permission)).toEqual(["All"]);
    expect(result.problems[0]).toContain("no data center `EU-NOPE-1`");
    await expect(runpodCiPreflight(api, "vm")).rejects.toThrow("kind `container`");
  });

  it("passes a key that may write", async () => {
    const { api } = runpod([
      ["GET /v2/pods", () => page([])],
      ["DELETE /v2/pods/", () => new FakeHttpReply(404, { title: "Not Found" })],
    ]);
    expect(await runpodCiPreflight(api, "container")).toEqual({
      ok: true,
      missing: [],
      problems: [],
    });
  });
});
