import { describe, expect, it } from "vitest";

import { VsphereApiError } from "../api.js";
import {
  CI_CATEGORY,
  ciListTagged,
  ciPreflight,
  ciStart,
  ciStatus,
  ciTeardown,
  customization,
  userData,
  vmName,
  type VsphereCalls,
} from "../ci-executor.js";

const JOB = "5f0c1c2e-1111-4a4a-9b9b-0123456789ab";
const tags = {
  "infrawrench-ci": "org-1",
  "infrawrench-ci-run": "run-1",
  "infrawrench-ci-job": JOB,
};
const spec = {
  kind: "vm" as const,
  bootstrap: "#!/bin/sh\necho hi\n",
  tags,
  name: "infrawrench-ci-build",
  image: "ubuntu-ci",
  maxSeconds: 1800,
};
const NAME = `iwci-${JOB}`;

type Handler = (opts: { query?: Record<string, unknown>; body?: unknown }) => unknown;

/** A fake vCenter: answers `METHOD path[?action]` from a table, recording each call. No network. */
function fakeVcenter(answers: Record<string, Handler>) {
  const calls: Array<{ method: string; key: string; query?: unknown; body?: unknown }> = [];
  const api: VsphereCalls = {
    async request<T>(
      method: string,
      path: string,
      opts: { query?: Record<string, unknown>; body?: unknown } = {},
    ) {
      const action = opts.query?.["action"];
      const key = `${method} ${path}${action ? `?${String(action)}` : ""}`;
      calls.push({ method, key, query: opts.query, body: opts.body });
      const answer = answers[key];
      if (!answer)
        throw new VsphereApiError(
          `vCenter API 404 for ${method} ${path}: not found`,
          404,
          "NOT_FOUND",
        );
      return answer(opts) as T;
    },
  } as VsphereCalls;
  return { api, calls };
}

const tagging = {
  "GET /cis/tagging/category": () => ["cat-1"],
  "GET /cis/tagging/category/cat-1": () => ({ name: CI_CATEGORY }),
  "POST /cis/tagging/tag?list-tags-for-category": () => ["tag-1"],
  "GET /cis/tagging/tag/tag-1": () => ({ name: "org-1" }),
};

describe("helpers", () => {
  it("names the VM after the job so the job can be read back", () => {
    expect(vmName(spec)).toBe(NAME);
  });

  it("hands the bootstrap over as cloud-init user data behind a power-off timer", () => {
    const data = userData(spec.bootstrap, 1800);
    expect(data.startsWith("#!/bin/sh\n")).toBe(true);
    expect(data).toContain("shutdown -h +30");
    expect(data.trimEnd().endsWith("shutdown -h now")).toBe(true);
    const body = customization(NAME, spec.bootstrap, 1800);
    expect(body.spec.configuration_spec.cloud_config.type).toBe("CLOUDINIT");
    expect(body.spec.configuration_spec.cloud_config.cloudinit.metadata).toBe(
      `instance-id: ${NAME}\nlocal-hostname: ${NAME}\n`,
    );
    expect(body.spec.global_DNS_settings).toEqual({});
    expect(body.spec.interfaces).toEqual([]);
  });
});

describe("ciPreflight", () => {
  it("checks vCenter answers, and cannot name privileges ahead", async () => {
    const ok = await ciPreflight(
      fakeVcenter({ "GET /vcenter/vm": () => [], "GET /cis/tagging/category": () => [] }).api,
      "vm",
    );
    expect(ok).toEqual({ ok: true, missing: [], problems: [] });
    const down = await ciPreflight(fakeVcenter({}).api, "vm");
    expect(down.ok).toBe(false);
    await expect(ciPreflight(fakeVcenter({}).api, "container")).rejects.toThrow(/vm/);
  });
});

describe("ciStart", () => {
  it("clones powered off onto the only cluster, tags, customizes and powers on", async () => {
    const { api, calls } = fakeVcenter({
      "GET /vcenter/vm": (o) =>
        (o.query?.["names"] as string[])[0] === "ubuntu-ci"
          ? [{ vm: "vm-9", name: "ubuntu-ci" }]
          : [],
      "GET /vcenter/cluster": () => [{ cluster: "domain-c8" }],
      "POST /vcenter/vm?clone": () => "vm-42",
      ...tagging,
      "POST /cis/tagging/tag-association/tag-1?attach": () => undefined,
      "PUT /vcenter/vm/vm-42/guest/customization": () => undefined,
      "POST /vcenter/vm/vm-42/power?start": () => undefined,
    });
    const handle = await ciStart(api, spec);
    expect(handle).toEqual({
      id: "vm-42",
      label: `vsphere vm vm-42 ${NAME}`,
      data: { name: NAME },
    });
    const clone = calls.find((c) => c.key === "POST /vcenter/vm?clone")!;
    expect(clone.body).toEqual({
      source: "vm-9",
      name: NAME,
      power_on: false,
      placement: { cluster: "domain-c8" },
    });
    const attach = calls.find((c) => c.key.endsWith("?attach"))!;
    expect(attach.body).toEqual({ object_id: { type: "VirtualMachine", id: "vm-42" } });
    expect(calls.map((c) => c.key).slice(-2)).toEqual([
      "PUT /vcenter/vm/vm-42/guest/customization",
      "POST /vcenter/vm/vm-42/power?start",
    ]);
  });

  it("makes the category and the scope's tag the first time", async () => {
    const { api, calls } = fakeVcenter({
      "GET /vcenter/vm": (o) =>
        (o.query?.["names"] as string[])[0] === "ubuntu-ci"
          ? [{ vm: "vm-9", name: "ubuntu-ci" }]
          : [],
      "GET /vcenter/cluster": () => [],
      "POST /vcenter/vm?clone": () => "vm-42",
      "GET /cis/tagging/category": () => [],
      "POST /cis/tagging/category": () => "cat-new",
      "POST /cis/tagging/tag?list-tags-for-category": () => [],
      "POST /cis/tagging/tag": () => "tag-new",
      "POST /cis/tagging/tag-association/tag-new?attach": () => undefined,
      "PUT /vcenter/vm/vm-42/guest/customization": () => undefined,
      "POST /vcenter/vm/vm-42/power?start": () => undefined,
    });
    await ciStart(api, spec);
    expect(calls.find((c) => c.key === "POST /cis/tagging/category")!.body).toMatchObject({
      name: CI_CATEGORY,
      cardinality: "MULTIPLE",
      associable_types: ["VirtualMachine"],
    });
    expect(calls.find((c) => c.key === "POST /cis/tagging/tag")!.body).toMatchObject({
      name: "org-1",
      category_id: "cat-new",
    });
    expect(calls.find((c) => c.key === "POST /vcenter/vm?clone")!.body).not.toHaveProperty(
      "placement",
    );
  });

  it("is idempotent: a VM of the job's name is the one it made", async () => {
    const { api, calls } = fakeVcenter({ "GET /vcenter/vm": () => [{ vm: "vm-42", name: NAME }] });
    expect((await ciStart(api, spec)).id).toBe("vm-42");
    expect(calls).toHaveLength(1);
  });

  it("deletes a clone that failed to start, and names the privileges when denied", async () => {
    const { api, calls } = fakeVcenter({
      "GET /vcenter/vm": (o) =>
        (o.query?.["names"] as string[])[0] === "ubuntu-ci"
          ? [{ vm: "vm-9", name: "ubuntu-ci" }]
          : [],
      "GET /vcenter/cluster": () => [],
      "POST /vcenter/vm?clone": () => "vm-42",
      ...tagging,
      "POST /cis/tagging/tag-association/tag-1?attach": () => undefined,
      "PUT /vcenter/vm/vm-42/guest/customization": () => {
        throw new VsphereApiError("vCenter denied PUT (403): no", 403);
      },
      "POST /vcenter/vm/vm-42/power?stop": () => {
        throw new VsphereApiError("AlreadyInDesiredState", 400);
      },
      "DELETE /vcenter/vm/vm-42": () => undefined,
    });
    await expect(ciStart(api, spec)).rejects.toThrow(/VirtualMachine\.Provisioning\.Customize/);
    expect(calls.at(-1)!.key).toBe("DELETE /vcenter/vm/vm-42");
  });

  it("refuses sizes and GPUs it cannot give, and asks for a template", async () => {
    await expect(ciStart(fakeVcenter({}).api, { ...spec, machine: "4vcpu-8gb" })).rejects.toThrow(
      /template/,
    );
    await expect(ciStart(fakeVcenter({}).api, { ...spec, gpu: "a100" })).rejects.toThrow(/gpu/);
    await expect(
      ciStart(fakeVcenter({}).api, { ...spec, image: undefined } as never),
    ).rejects.toThrow(/cloud.image/);
  });
});

describe("ciStatus, ciTeardown and ciListTagged", () => {
  const handle = { id: "vm-42", label: "x", data: { name: NAME } };

  it("maps power state, and is gone for an unknown VM", async () => {
    const status = (state: string) =>
      ciStatus(fakeVcenter({ "GET /vcenter/vm/vm-42/power": () => ({ state }) }).api, handle);
    expect(await status("POWERED_ON")).toEqual({ state: "running" });
    expect(await status("POWERED_OFF")).toEqual({ state: "stopped", detail: "POWERED_OFF" });
    expect(await ciStatus(fakeVcenter({}).api, handle)).toEqual({ state: "gone" });
  });

  it("powers off before deleting, and succeeds for a VM that is gone", async () => {
    const { api, calls } = fakeVcenter({
      "POST /vcenter/vm/vm-42/power?stop": () => undefined,
      "DELETE /vcenter/vm/vm-42": () => undefined,
    });
    await ciTeardown(api, handle);
    expect(calls.map((c) => c.key)).toEqual([
      "POST /vcenter/vm/vm-42/power?stop",
      "DELETE /vcenter/vm/vm-42",
    ]);
    await expect(ciTeardown(fakeVcenter({}).api, handle)).resolves.toBeUndefined();
  });

  it("lists the VMs carrying a CI scope's tag, with the job read back from the name", async () => {
    const { api } = fakeVcenter({
      ...tagging,
      "POST /cis/tagging/tag-association/tag-1?list-attached-objects": () => [
        { type: "VirtualMachine", id: "vm-42" },
        { type: "Folder", id: "group-1" },
      ],
      "GET /vcenter/vm": (o) => {
        expect(o.query?.["vms"]).toEqual(["vm-42"]);
        return [{ vm: "vm-42", name: NAME, power_state: "POWERED_ON" }];
      },
    });
    expect(await ciListTagged(api, "infrawrench-ci")).toEqual([
      {
        handle: { id: "vm-42", label: `vsphere vm vm-42 ${NAME}`, data: { name: NAME } },
        tags: { "infrawrench-ci": "org-1", "infrawrench-ci-job": JOB },
        live: true,
      },
    ]);
    expect(
      await ciListTagged(
        fakeVcenter({ "GET /cis/tagging/category": () => [] }).api,
        "infrawrench-ci",
      ),
    ).toEqual([]);
  });
});
