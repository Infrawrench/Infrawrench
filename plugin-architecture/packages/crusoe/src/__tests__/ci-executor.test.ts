import { describe, expect, it } from "vitest";

import { FakeHttpReply, fakeCiHttp } from "@infrawrench/plugin-base/test-harness";

import {
  chooseProject,
  ciInstanceName,
  crusoeCiListTagged,
  crusoeCiPreflight,
  crusoeCiStart,
  crusoeCiStatus,
  crusoeCiTeardown,
  gpuVmType,
  imageFor,
  startupScript,
  tagsOfName,
} from "../ci-executor.js";
import { CrusoeClient } from "../client.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import type { CrusoeImage, CrusoeProject, CrusoeVmType } from "../types.js";

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
  maxSeconds: 3600,
};
const NAME = "iwci-0f1e2d3c4b5a69788796a5b4c3d2e1f0_xorg-9b2f1c3e-6a5d-4e7f-8a9b-0c1d2e3f4a5b";
const SECRET = "c2VjcmV0LWtleS1mb3ItdGVzdHM";

const project = (id: string, name: string) =>
  ({ id, name, organization_id: "org-1" }) as CrusoeProject;
const vmType = (product_name: string, gpu_type: string, num_gpu: number) =>
  ({ product_name, gpu_type, num_gpu }) as CrusoeVmType;
const TYPES = [
  vmType("c1a.4x", "", 0),
  vmType("a100-80gb.1x", "A100-80GB", 1),
  vmType("a100-80gb.8x", "A100-80GB", 8),
  vmType("a100-80gb-sxm-ib.8x", "A100-SXM-80GB", 8),
  vmType("h100-80gb-sxm-ib.8x", "H100-SXM-80GB", 8),
  vmType("l40s-48gb.4x", "L40S-48GB", 4),
];
const done = (id?: string) => ({
  operation: { operation_id: "op-1", state: "SUCCEEDED", result: id ? { id } : {} },
});

function crusoe(routes: Parameters<typeof fakeCiHttp>[0]) {
  const { http, sent } = fakeCiHttp([
    [
      "GET /organizations/projects",
      () => ({ items: [project("p-ci", "infrawrench-ci"), project("p-2", "training")] }),
    ],
    ...routes,
  ]);
  const client = new CrusoeClient({ accessKeyId: "AKTEST", secretKey: SECRET }, RESOURCE_TYPES, {
    http,
  } as never);
  return { client, sent };
}

describe("Crusoe CI executor", () => {
  it("names the VM with its tags in Crusoe's characters and reads them back", () => {
    expect(ciInstanceName(spec)).toBe(NAME);
    expect(NAME).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(tagsOfName(NAME)).toEqual({
      "infrawrench-ci": tags["infrawrench-ci"],
      "infrawrench-ci-job": tags["infrawrench-ci-job"],
    });
    const odd = { ...spec, tags: { "infrawrench-ci": "org:1", "infrawrench-ci-job": "job_7" } };
    expect(tagsOfName(ciInstanceName(odd))).toEqual(odd.tags);
  });

  it("chooses the CI project, the only project, or default", () => {
    expect(chooseProject([project("a", "x"), project("b", "infrawrench-ci")]).id).toBe("b");
    expect(chooseProject([project("a", "x")]).id).toBe("a");
    expect(chooseProject([project("a", "x"), project("b", "default")]).id).toBe("b");
    expect(() => chooseProject([project("a", "x"), project("b", "y")])).toThrow("infrawrench-ci");
  });

  it("maps cloud.gpu onto the project's VM types", () => {
    expect(gpuVmType(TYPES, "a100-80gb")).toBe("a100-80gb.1x");
    expect(gpuVmType(TYPES, "A100:8")).toBe("a100-80gb.8x");
    expect(gpuVmType(TYPES, "h100:8")).toBe("h100-80gb-sxm-ib.8x");
    expect(gpuVmType(TYPES, "l40s:4")).toBe("l40s-48gb.4x");
    expect(() => gpuVmType(TYPES, "h100:2")).toThrow("no h100 VM with 2 GPUs");
    expect(() => gpuVmType(TYPES, "b200")).toThrow("no GPU VM type for `b200`");
  });

  it("picks the newest Ubuntu image for the VM type's product line", () => {
    const images = [
      {
        name: "ubuntu22.04-nvidia-pcie-docker",
        tags: ["latest"],
        created_at: "2025-01-01",
        supported_product_lines: ["a100-80gb"],
      },
      {
        name: "ubuntu24.04-nvidia-b.a100.0.1",
        tags: ["latest"],
        created_at: "2026-02-01",
        supported_product_lines: ["a100-80gb"],
      },
    ] as CrusoeImage[];
    expect(imageFor(images, "a100-80gb.8x")).toBe("ubuntu24.04-nvidia-b.a100.0.1:latest");
    expect(imageFor(images, "c1a.4x")).toBe("ubuntu24.04-base-image-generic:latest");
  });

  it("runs the job once and powers off on any later start", () => {
    const script = startupScript(spec.bootstrap, 3600);
    expect(script.startsWith("#!/bin/bash\n")).toBe(true);
    expect(script).toContain("if [ -e /var/lib/iwci-started ]; then shutdown -h now; exit 0; fi");
    expect(script).toContain("shutdown -h +60");
    expect(() => startupScript("#!/bin/sh\necho héllo\n", 60)).toThrow("ASCII");
  });

  it("starts an on-demand VM with a throwaway key and no credentials", async () => {
    const { client, sent } = crusoe([
      ["GET /projects/p-ci/compute/vms/instances", () => ({ items: [] })],
      ["GET /projects/p-ci/compute/vms/types", () => ({ items: TYPES })],
      ["GET /compute/images", () => ({ items: [] })],
      ["POST /projects/p-ci/compute/vms/instances", () => done("vm-1")],
    ]);
    const handle = await crusoeCiStart(client, { ...spec, machine: "c1a.4x", gpu: "h100:8" });
    expect(handle).toEqual({
      id: "vm-1",
      region: "us-east1-a",
      label: `crusoe vm ${NAME} (us-east1-a)`,
      data: { project: "p-ci", name: NAME },
    });
    expect(sent[1]?.url.searchParams.get("names")).toBe(NAME);
    const create = sent.find((c) => c.method === "POST");
    expect(create?.body).toMatchObject({
      name: NAME,
      type: "h100-80gb-sxm-ib.8x",
      location: "us-east1-a",
      image: "ubuntu24.04-base-image-generic:latest",
      install_crusoe_watch_agent: false,
      reservation_specification: { selection_strategy: "on_demand" },
    });
    expect((create?.body as { ssh_public_key: string }).ssh_public_key).toMatch(/^ssh-ed25519 /);
    expect(JSON.stringify(create?.body)).not.toContain(SECRET);
    expect(JSON.stringify(create?.body)).not.toContain("AKTEST");
  });

  it("finds the VM a first start made", async () => {
    const { client, sent } = crusoe([
      [
        "GET /projects/p-ci/compute/vms/instances",
        () => ({ items: [{ id: "vm-1", name: NAME, location: "us-southcentral1-a" }] }),
      ],
    ]);
    expect(await crusoeCiStart(client, spec)).toMatchObject({
      id: "vm-1",
      region: "us-southcentral1-a",
    });
    expect(sent.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("follows the VM's state and reads a missing VM as gone", async () => {
    const handle = { id: "vm-1", label: "", data: { project: "p-ci", name: NAME } };
    for (const [state, want] of [
      ["STATE_RESOURCING_AGENT", "starting"],
      ["STATE_RUNNING", "running"],
      ["STATE_SHUTOFF", "stopped"],
    ]) {
      const { client } = crusoe([
        ["GET /projects/p-ci/compute/vms/instances", () => ({ items: [{ id: "vm-1", state }] })],
      ]);
      expect((await crusoeCiStatus(client, handle)).state).toBe(want);
    }
    const { client, sent } = crusoe([
      ["GET /projects/p-ci/compute/vms/instances", () => ({ items: [] })],
    ]);
    expect(await crusoeCiStatus(client, handle)).toEqual({ state: "gone" });
    expect(sent[0]?.url.searchParams.get("ids")).toBe("vm-1");
  });

  it("deletes the VM, and succeeds when it is already gone", async () => {
    const handle = { id: "vm-1", label: "", data: { project: "p-ci", name: NAME } };
    const ok = crusoe([["DELETE /projects/p-ci/compute/vms/instances/vm-1", () => done()]]);
    await crusoeCiTeardown(ok.client, handle);
    expect(ok.sent.map((c) => c.method)).toEqual(["DELETE"]);
    const gone = crusoe([
      [
        "DELETE /projects/p-ci/compute/vms/instances/vm-1",
        () => new FakeHttpReply(404, { code: "not_found", message: "instance not found" }),
      ],
    ]);
    await expect(crusoeCiTeardown(gone.client, handle)).resolves.toBeUndefined();
    const failed = crusoe([
      [
        "DELETE /projects/p-ci/compute/vms/instances/vm-1",
        () => new FakeHttpReply(500, { message: "internal" }),
      ],
    ]);
    await expect(crusoeCiTeardown(failed.client, handle)).rejects.toThrow("500");
  });

  it("lists VMs named for CI in every project it can read", async () => {
    const { client } = crusoe([
      [
        "GET /projects/p-ci/compute/vms/instances",
        () => ({
          items: [
            {
              id: "vm-1",
              name: NAME,
              location: "us-east1-a",
              state: "STATE_RUNNING",
              created_at: "2026-11-13T10:00:00Z",
            },
            { id: "vm-2", name: "trainer", location: "us-east1-a", state: "STATE_RUNNING" },
          ],
        }),
      ],
      [
        "GET /projects/p-2/compute/vms/instances",
        () => new FakeHttpReply(403, { message: "forbidden" }),
      ],
    ]);
    const found = await crusoeCiListTagged(client, "infrawrench-ci");
    expect(found).toEqual([
      {
        handle: {
          id: "vm-1",
          region: "us-east1-a",
          label: `crusoe vm ${NAME} (us-east1-a)`,
          data: { project: "p-ci", name: NAME },
        },
        tags: {
          "infrawrench-ci": tags["infrawrench-ci"],
          "infrawrench-ci-job": tags["infrawrench-ci-job"],
        },
        createdAt: "2026-11-13T10:00:00Z",
        live: true,
      },
    ]);
  });

  it("preflight reads, probes a delete, and names a Reader's gap", async () => {
    const ok = crusoe([
      ["GET /projects/p-ci/compute/vms/instances", () => ({ items: [] })],
      ["GET /projects/p-ci/compute/vms/types", () => ({ items: TYPES })],
      [
        "DELETE /projects/p-ci/compute/vms/instances/00000000",
        () => new FakeHttpReply(404, { message: "not found" }),
      ],
      ["GET /locations", () => ({ items: ["us-east1-a", "eu-iceland1-a"] })],
    ]);
    expect(await crusoeCiPreflight(ok.client, "vm")).toEqual({
      ok: true,
      missing: [],
      problems: [],
      region: "us-east1-a",
    });
    const reader = crusoe([
      ["GET /projects/p-ci/compute/vms/instances", () => ({ items: [] })],
      ["GET /projects/p-ci/compute/vms/types", () => ({ items: TYPES })],
      [
        "DELETE /projects/p-ci/compute/vms/instances/00000000",
        () => new FakeHttpReply(403, { message: "forbidden" }),
      ],
      ["GET /locations", () => ({ items: ["us-east1-a"] })],
    ]);
    const result = await crusoeCiPreflight(reader.client, "vm", "eu-norway1-a");
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.permission)).toEqual(["Editor"]);
    expect(result.problems).toEqual([
      "Crusoe has no location `eu-norway1-a`. Name one of us-east1-a.",
    ]);
  });
});
