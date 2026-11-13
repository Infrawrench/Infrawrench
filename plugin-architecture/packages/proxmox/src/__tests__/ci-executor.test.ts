import { describe, expect, it } from "vitest";

import { encodeForm, ProxmoxApiError, type FormValue } from "../api.js";
import {
  agentCommand,
  ciListTagged,
  ciPreflight,
  ciStart,
  ciStatus,
  ciTeardown,
  describeTags,
  findTemplate,
  parseMachine,
  tagsOf,
  vmName,
  type PveCalls,
} from "../ci-executor.js";

const tags = {
  "infrawrench-ci": "org-1",
  "infrawrench-ci-run": "run-1",
  "infrawrench-ci-job": "5F0C1C2E-1111-4a4a-9b9b-0123456789ab",
};
const spec = {
  kind: "vm" as const,
  bootstrap: "#!/bin/sh\necho 'a;b&c'\n",
  tags,
  name: "infrawrench-ci-build",
  image: "ubuntu-ci",
  maxSeconds: 1800,
};
const NAME = "iwci-5f0c1c2e11114a4a9b9b0123456789ab";

type Handler = (params: Record<string, FormValue> | undefined) => unknown;

/** A fake Proxmox VE API: answers `METHOD path` from a table, recording each call. No network. */
function fakePve(answers: Record<string, Handler>) {
  const calls: Array<{ method: string; path: string; params?: Record<string, FormValue> }> = [];
  const call =
    (method: string) =>
    async <T>(path: string, params?: Record<string, FormValue>): Promise<T> => {
      calls.push({ method, path, ...(params ? { params } : {}) });
      const answer = answers[`${method} ${path}`];
      if (!answer)
        throw new ProxmoxApiError(
          `Proxmox VE API 500 for ${method} ${path}: Configuration file 'nodes/pve/qemu-server/1.conf' does not exist`,
          500,
        );
      return answer(params) as T;
    };
  const api: PveCalls = {
    get: call("GET"),
    post: call("POST"),
    put: call("PUT"),
    delete: call("DELETE"),
    waitForTask: async () => true,
  };
  return { api, calls };
}

const template = {
  id: "qemu/9000",
  type: "qemu",
  vmid: 9000,
  name: "ubuntu-ci",
  node: "pve1",
  template: 1,
};
const noSleep = async () => undefined;

describe("helpers", () => {
  it("keeps the tags in the description and reads them back", () => {
    expect(tagsOf(describeTags(tags))).toEqual(tags);
    expect(tagsOf("someone's notes")).toEqual({});
  });

  it("names the VM as a DNS name from the job id", () => {
    expect(vmName(spec)).toBe(NAME);
    expect(vmName({ tags: {}, name: "My_Build" })).toMatch(/^iwci-[0-9a-f]{32}$/);
  });

  it("runs the bootstrap from standard input, detached, behind a power-off timer", () => {
    const [sh, flag, script] = agentCommand(1800);
    expect([sh, flag]).toEqual(["/bin/sh", "-c"]);
    expect(script).toContain("cat > /run/iwci-bootstrap.sh");
    expect(script).toContain("setsid");
    expect(script).toContain("shutdown -h +30");
    expect(script).toContain("shutdown -h now");
  });

  it("form-encodes a list as the key repeated, escaping ; and &", () => {
    expect(encodeForm({ command: ["/bin/sh", "-c", "a;b"], "input-data": "x&y" })).toBe(
      "command=%2Fbin%2Fsh&command=-c&command=a%3Bb&input-data=x%26y",
    );
  });

  it("finds a template by VMID or name, and lists the ones there are when it cannot", () => {
    const all = [
      template,
      { ...template, id: "qemu/9001", vmid: 9001, name: "debian" },
      { id: "qemu/100", type: "qemu", vmid: 100, name: "web", node: "pve1" },
    ];
    expect(findTemplate(all, "9001").name).toBe("debian");
    expect(findTemplate(all, "ubuntu-ci").vmid).toBe(9000);
    expect(() => findTemplate(all, "web")).toThrow(
      /Templates: 9000 \(ubuntu-ci\), 9001 \(debian\)/,
    );
    expect(() => findTemplate([template, { ...template, vmid: 9002 }], "ubuntu-ci")).toThrow(
      /More than one/,
    );
    expect(parseMachine("4vcpu-8gb")).toEqual({ cores: 4, memory: 8192 });
    expect(parseMachine("0.5vcpu-1gb")).toBeNull();
  });
});

describe("ciPreflight", () => {
  it("names each privilege the token lacks", async () => {
    const { api } = fakePve({
      "GET /access/permissions": () => ({
        "/vms": { "VM.Clone": 1, "VM.Audit": 1, "VM.Monitor": 1 },
      }),
      "GET /cluster/resources": () => [template],
    });
    const result = await ciPreflight(api, "vm");
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.permission)).toEqual([
      "VM.Allocate",
      "VM.Config.CPU",
      "VM.Config.Memory",
      "VM.Config.Options",
      "VM.PowerMgmt",
      "Datastore.AllocateSpace",
      "SDN.Use",
    ]);
  });

  it("passes with every privilege on /, and asks for a template when there is none", async () => {
    const all = Object.fromEntries(
      [
        "VM.Clone",
        "VM.Allocate",
        "VM.Config.CPU",
        "VM.Config.Memory",
        "VM.Config.Options",
        "VM.PowerMgmt",
        "VM.Audit",
        "Datastore.AllocateSpace",
        "SDN.Use",
        "VM.GuestAgent.Unrestricted",
      ].map((p) => [p, 1]),
    );
    const ok = await ciPreflight(
      fakePve({
        "GET /access/permissions": () => ({ "/": all }),
        "GET /cluster/resources": () => [template],
      }).api,
      "vm",
    );
    expect(ok).toEqual({ ok: true, missing: [], problems: [] });
    const none = await ciPreflight(
      fakePve({
        "GET /access/permissions": () => ({ "/": all }),
        "GET /cluster/resources": () => [],
      }).api,
      "vm",
    );
    expect(none.problems[0]).toMatch(/no VM template/);
    await expect(ciPreflight(fakePve({}).api, "container")).rejects.toThrow(/LXC|container/);
  });
});

describe("ciStart", () => {
  it("clones, sizes, tags, starts and hands the bootstrap to the guest agent", async () => {
    const { api, calls } = fakePve({
      "GET /cluster/resources": () => [template],
      "GET /cluster/nextid": () => "123",
      "POST /nodes/pve1/qemu/9000/clone": () => "UPID:pve1:clone",
      "PUT /nodes/pve1/qemu/123/config": () => null,
      "POST /nodes/pve1/qemu/123/status/start": () => "UPID:pve1:start",
      "POST /nodes/pve1/qemu/123/agent/ping": () => ({}),
      "POST /nodes/pve1/qemu/123/agent/exec": () => ({ pid: 7 }),
    });
    const handle = await ciStart(api, { ...spec, machine: "4vcpu-8gb" }, noSleep);
    expect(handle).toEqual({
      id: "123",
      region: "pve1",
      label: `proxmox vm 123 ${NAME} on pve1`,
      data: { node: "pve1", vmid: "123", name: NAME },
    });
    const clone = calls.find((c) => c.path.endsWith("/clone"))!;
    expect(clone.params).toMatchObject({ newid: 123, name: NAME });
    const config = calls.find((c) => c.method === "PUT")!;
    expect(config.params).toMatchObject({
      cores: 4,
      memory: 8192,
      agent: "1",
      tags: "infrawrench-ci",
    });
    expect(tagsOf(String(config.params!["description"]))).toEqual(tags);
    const exec = calls.find((c) => c.path.endsWith("/agent/exec"))!;
    expect(exec.params!["input-data"]).toBe(spec.bootstrap);
    expect((exec.params!["command"] as string[])[0]).toBe("/bin/sh");
  });

  it("is idempotent: a VM of the job's name and tags is the one it made", async () => {
    const { api, calls } = fakePve({
      "GET /cluster/resources": () => [
        template,
        {
          id: "qemu/123",
          type: "qemu",
          vmid: 123,
          name: NAME,
          node: "pve2",
          tags: "infrawrench-ci",
        },
      ],
      "GET /nodes/pve2/qemu/123/config": () => ({ description: describeTags(tags) }),
    });
    expect((await ciStart(api, spec, noSleep)).id).toBe("123");
    expect(calls.some((c) => c.path.endsWith("/clone"))).toBe(false);
  });

  it("destroys a VM that never got the job, and says what the template lacks", async () => {
    let now = 0;
    const realNow = Date.now;
    Date.now = () => (now += 120_000);
    try {
      const { api, calls } = fakePve({
        "GET /cluster/resources": () => [template],
        "GET /cluster/nextid": () => 123,
        "POST /nodes/pve1/qemu/9000/clone": () => "UPID:pve1:clone",
        "PUT /nodes/pve1/qemu/123/config": () => null,
        "POST /nodes/pve1/qemu/123/status/start": () => null,
        "GET /nodes/pve1/qemu/123/status/current": () => ({ status: "running" }),
        "POST /nodes/pve1/qemu/123/status/stop": () => null,
        "DELETE /nodes/pve1/qemu/123": () => null,
      });
      await expect(ciStart(api, spec, noSleep)).rejects.toThrow(/qemu-guest-agent/);
      expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  it("asks for a template and a size it can use", async () => {
    await expect(
      ciStart(fakePve({}).api, { ...spec, image: undefined } as never, noSleep),
    ).rejects.toThrow(/cloud.image/);
    await expect(
      ciStart(fakePve({}).api, { ...spec, machine: "t3.large" }, noSleep),
    ).rejects.toThrow(/vCPUs and memory/);
  });
});

describe("ciStatus, ciTeardown and ciListTagged", () => {
  const handle = {
    id: "123",
    region: "pve1",
    label: "x",
    data: { node: "pve1", vmid: "123", name: NAME },
  };

  it("maps the VM's state, and is gone when the VM is", async () => {
    const status = (current: object) =>
      ciStatus(fakePve({ "GET /nodes/pve1/qemu/123/status/current": () => current }).api, handle);
    expect(await status({ status: "running" })).toEqual({ state: "running" });
    expect(await status({ status: "stopped", lock: "clone" })).toEqual({ state: "starting" });
    expect(await status({ status: "stopped" })).toEqual({ state: "stopped" });
    expect(await ciStatus(fakePve({}).api, handle)).toEqual({ state: "gone" });
  });

  it("stops a running VM before destroying it, and succeeds when it is gone", async () => {
    const { api, calls } = fakePve({
      "GET /nodes/pve1/qemu/123/status/current": () => ({ status: "running" }),
      "POST /nodes/pve1/qemu/123/status/stop": () => "UPID:stop",
      "DELETE /nodes/pve1/qemu/123": () => "UPID:destroy",
    });
    await ciTeardown(api, handle);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /nodes/pve1/qemu/123/status/current",
      "POST /nodes/pve1/qemu/123/status/stop",
      "DELETE /nodes/pve1/qemu/123",
    ]);
    expect(calls[2]!.params).toEqual({ purge: 1, "destroy-unreferenced-disks": 1 });
    await expect(ciTeardown(fakePve({}).api, handle)).resolves.toBeUndefined();
  });

  it("lists tagged VMs, not templates, with the tags as sent", async () => {
    const { api } = fakePve({
      "GET /cluster/resources": () => [
        template,
        {
          id: "qemu/123",
          type: "qemu",
          vmid: 123,
          name: NAME,
          node: "pve1",
          tags: "infrawrench-ci;other",
          status: "running",
        },
        { id: "qemu/124", type: "qemu", vmid: 124, name: "web", node: "pve1", tags: "prod" },
      ],
      "GET /nodes/pve1/qemu/123/config": () => ({ description: describeTags(tags) }),
    });
    const found = await ciListTagged(api, "infrawrench-ci");
    expect(found).toEqual([
      {
        handle: {
          id: "123",
          region: "pve1",
          label: `proxmox vm 123 ${NAME} on pve1`,
          data: { node: "pve1", vmid: "123", name: NAME },
        },
        tags,
        live: true,
      },
    ]);
  });
});
