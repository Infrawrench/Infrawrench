import { describe, expect, it } from "vitest";

import { FakeHttpReply, fakeCiHttp } from "@infrawrench/plugin-base/test-harness";

import { createPaperspaceApi } from "../api.js";
import {
  ciInstanceName,
  gpuMachineType,
  machineBody,
  paperspaceCiListTagged,
  paperspaceCiPreflight,
  paperspaceCiStart,
  paperspaceCiStatus,
  paperspaceCiTeardown,
  tagsOfName,
} from "../ci-executor.js";

const tags = {
  "infrawrench-ci": "org-9b2f1c3e-6a5d-4e7f-8a9b-0c1d2e3f4a5b",
  "infrawrench-ci-run": "4c1f6a2e-9b7d-4e3a-8f21-0d5c6b7a8e9f",
  "infrawrench-ci-job": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
};
const spec = {
  kind: "vm" as const,
  bootstrap: "#!/bin/sh\necho hi\n",
  tags,
  name: "infrawrench-ci-build",
  maxSeconds: 5400,
};
const NAME = "iwci-0f1e2d3c4b5a69788796a5b4c3d2e1f0_xorg-9b2f1c3e-6a5d-4e7f-8a9b-0c1d2e3f4a5b";
const KEY = "test-paperspace-key";

const template = {
  id: "tkni3aa4",
  name: "Ubuntu 22.04 Server",
  agentType: "LinuxHeadless",
  operatingSystemLabel: "Ubuntu 22.04",
  defaultSizeGb: 50,
  availableMachineTypes: [
    { machineTypeLabel: "C5", isAvailable: true },
    { machineTypeLabel: "A6000", isAvailable: true },
    { machineTypeLabel: "H100x8", isAvailable: false },
  ],
};

function paperspace(routes: Parameters<typeof fakeCiHttp>[0]) {
  const { http, sent } = fakeCiHttp(routes);
  return { api: createPaperspaceApi(KEY, "", { http } as never), sent };
}

const page = (items: unknown[]) => ({ items, hasMore: false });

describe("Paperspace CI executor", () => {
  it("names the machine with its tags and reads them back", () => {
    expect(ciInstanceName(spec)).toBe(NAME);
    expect(ciInstanceName(spec)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(tagsOfName(NAME)).toEqual({
      "infrawrench-ci": tags["infrawrench-ci"],
      "infrawrench-ci-job": tags["infrawrench-ci-job"],
    });
    const odd = { ...spec, tags: { "infrawrench-ci": "org_1", "infrawrench-ci-job": "job 7" } };
    expect(tagsOfName(ciInstanceName(odd))).toEqual(odd.tags);
    expect(tagsOfName("my-machine")).toEqual({});
  });

  it("maps cloud.gpu onto Paperspace machine types", () => {
    expect(gpuMachineType("a6000")).toBe("A6000");
    expect(gpuMachineType("RTX A6000:4")).toBe("A6000x4");
    expect(gpuMachineType("a100-80gb:8")).toBe("A100-80Gx8");
    expect(gpuMachineType("A100")).toBe("A100");
    expect(gpuMachineType("h100:8")).toBe("H100x8");
    expect(() => gpuMachineType("h100:2")).toThrow("1, 8 GPUs, not 2");
    expect(() => gpuMachineType("mi300x")).toThrow("no GPU machine");
  });

  it("asks for a machine that powers off at its deadline and mails no password", () => {
    const body = machineBody({ ...spec, gpu: "a6000" }, "tkni3aa4", "s-1", 50);
    expect(body).toMatchObject({
      name: NAME,
      machineType: "A6000",
      templateId: "tkni3aa4",
      region: "ny2",
      publicIpType: "dynamic",
      startupScriptId: "s-1",
      autoShutdownEnabled: true,
      autoShutdownTimeout: 2,
      autoShutdownForce: true,
      emailPassword: false,
      startOnCreate: true,
    });
    // The pipeline's machine wins over the GPU.
    expect(machineBody({ ...spec, machine: "C7", gpu: "h100" }, "t", "s", 50).machineType).toBe(
      "C7",
    );
    // The kind's default, which the host fills in, gives way to the GPU.
    expect(machineBody({ ...spec, machine: "C5", gpu: "h100" }, "t", "s", 50).machineType).toBe(
      "H100",
    );
  });

  it("starts a machine with a run-once startup script", async () => {
    const { api, sent } = paperspace([
      ["GET /machines?", () => page([])],
      ["GET /os-templates", () => page([template])],
      ["GET /startup-scripts?", () => page([])],
      ["POST /startup-scripts", () => ({ id: "s-1", name: NAME })],
      [
        "POST /machines",
        () => ({ data: { id: "ps1abc", name: NAME, state: "provisioning", region: "ny2" } }),
      ],
    ]);
    const handle = await paperspaceCiStart(api, spec);
    expect(handle).toEqual({
      id: "ps1abc",
      region: "ny2",
      label: "paperspace machine ps1abc (ny2)",
      data: { kind: "machine", name: NAME, startupScript: "s-1" },
    });
    const script = sent.find(
      (c) => c.method === "POST" && c.url.pathname.endsWith("/startup-scripts"),
    );
    expect(script?.body).toMatchObject({ name: NAME, isRunOnce: true });
    expect((script?.body as { script: string }).script).toMatch(
      /^#!\/bin\/bash\nshutdown -h \+90 /,
    );
    for (const call of sent) {
      expect(JSON.stringify(call.body ?? "")).not.toContain(KEY);
    }
    expect(sent[0]?.headers["Authorization"]).toBe(`Bearer ${KEY}`);
  });

  it("finds the machine a first start made", async () => {
    const { api, sent } = paperspace([
      ["GET /machines?", () => page([{ id: "ps1abc", name: NAME, state: "ready", region: "ca1" }])],
      ["GET /startup-scripts?", () => page([{ id: "s-1", name: NAME }])],
    ]);
    expect(await paperspaceCiStart(api, spec)).toMatchObject({
      id: "ps1abc",
      region: "ca1",
      data: { startupScript: "s-1" },
    });
    expect(sent.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("refuses a machine type the template does not run on, before making anything", async () => {
    const { api, sent } = paperspace([
      ["GET /machines?", () => page([])],
      ["GET /os-templates", () => page([template])],
    ]);
    await expect(paperspaceCiStart(api, { ...spec, gpu: "h100:8" })).rejects.toThrow(
      "not available",
    );
    expect(sent.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("removes its startup script when the machine cannot be made", async () => {
    const { api, sent } = paperspace([
      ["GET /machines?", () => page([])],
      ["GET /os-templates", () => page([template])],
      ["GET /startup-scripts?", () => page([])],
      ["POST /startup-scripts", () => ({ id: "s-1", name: NAME })],
      ["POST /machines", () => new FakeHttpReply(400, { message: "out of capacity" })],
      ["DELETE /startup-scripts/s-1", () => ({ id: "s-1" })],
    ]);
    await expect(paperspaceCiStart(api, spec)).rejects.toThrow("out of capacity");
    expect(sent.at(-1)).toMatchObject({ method: "DELETE" });
  });

  it("follows the machine's state", async () => {
    const states: Record<string, string> = {
      provisioning: "starting",
      ready: "running",
      off: "stopped",
    };
    for (const [state, want] of Object.entries(states)) {
      const { api } = paperspace([["GET /machines/ps1", () => ({ id: "ps1", state })]]);
      expect((await paperspaceCiStatus(api, { id: "ps1", label: "" })).state).toBe(want);
    }
    const { api } = paperspace([
      ["GET /machines/ps1", () => new FakeHttpReply(404, { message: "not found" })],
    ]);
    expect(await paperspaceCiStatus(api, { id: "ps1", label: "" })).toEqual({ state: "gone" });
  });

  it("deletes the machine and its script, and succeeds when both are gone", async () => {
    const { api, sent } = paperspace([
      ["DELETE /machines/ps1", () => new FakeHttpReply(404, { message: "not found" })],
      ["GET /startup-scripts?", () => page([{ id: "s-9", name: NAME }])],
      ["DELETE /startup-scripts/s-9", () => new FakeHttpReply(404, { message: "not found" })],
    ]);
    await paperspaceCiTeardown(api, {
      id: "ps1",
      label: "",
      data: { kind: "machine", name: NAME },
    });
    expect(sent.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "DELETE /v1/machines/ps1",
      "GET /v1/startup-scripts",
      "DELETE /v1/startup-scripts/s-9",
    ]);
  });

  it("lists machines named for CI and scripts no machine holds", async () => {
    const { api } = paperspace([
      [
        "GET /machines",
        () =>
          page([
            {
              id: "ps1",
              name: NAME,
              state: "ready",
              region: "ny2",
              dtCreated: "2026-11-13T10:00:00Z",
            },
            { id: "ps2", name: "someone's machine", state: "ready" },
          ]),
      ],
      [
        "GET /startup-scripts",
        () =>
          page([
            { id: "s-1", name: NAME, assignedMachineIds: ["ps1"] },
            {
              id: "s-2",
              name: "iwci-11111111111111111111111111111111_xorg-a",
              assignedMachineIds: [],
            },
          ]),
      ],
    ]);
    const found = await paperspaceCiListTagged(api, "infrawrench-ci");
    expect(found.map((f) => [f.handle.id, f.live, f.tags["infrawrench-ci"]])).toEqual([
      ["ps1", true, tags["infrawrench-ci"]],
      ["s-2", false, "org-a"],
    ]);
    expect(found[0]?.createdAt).toBe("2026-11-13T10:00:00Z");
  });

  it("preflight reads, and names what a refused read needs", async () => {
    const ok = paperspace([
      ["GET /machines", () => page([])],
      ["GET /startup-scripts", () => page([])],
      ["GET /os-templates", () => page([template])],
    ]);
    expect(await paperspaceCiPreflight(ok.api, "vm")).toEqual({
      ok: true,
      missing: [],
      problems: [],
      region: "ny2",
    });
    const denied = paperspace([
      ["GET /machines", () => new FakeHttpReply(403, { message: "forbidden" })],
      ["GET /startup-scripts", () => new FakeHttpReply(403, { message: "forbidden" })],
      ["GET /os-templates", () => page([])],
    ]);
    const result = await paperspaceCiPreflight(denied.api, "vm");
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.permission)).toEqual(["Machines", "Startup scripts"]);
    expect(result.problems[0]).toContain("no OS template");
  });
});
