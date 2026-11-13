import { describe, expect, it } from "vitest";

import {
  CI_APP_NAME,
  createRequest,
  modalCiListTagged,
  modalCiPreflight,
  modalCiStart,
  modalCiStatus,
  modalCiTeardown,
  sandboxGpu,
  sandboxName,
  sandboxResources,
} from "../ci-executor.js";
import { GrpcCode } from "../grpc.js";
import { ProtoMessage, ProtoWriter } from "../proto.js";
import { ctxWith, makeHttp, type Reply } from "./helpers.js";

const tags = {
  "infrawrench-ci": "org-org_01HZX",
  "infrawrench-ci-run": "4c1f6a2e-9b7d-4e3a-8f21-0d5c6b7a8e9f",
  "infrawrench-ci-job": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
};
const spec = {
  kind: "container" as const,
  bootstrap: "#!/bin/sh\necho hi\n",
  tags,
  name: "infrawrench-ci-build",
  maxSeconds: 3600,
};
const NAME = "iwci-0f1e2d3c4b5a69788796a5b4c3d2e1f0";

function tagEntries(map: Record<string, string>): ProtoWriter[] {
  return Object.entries(map).map(([k, v]) => new ProtoWriter().string(1, k).string(2, v));
}

function readTags(m: ProtoMessage, field: number): Record<string, string> {
  return Object.fromEntries(m.messages(field).map((t) => [t.string(1), t.string(2)]));
}

function modal(routes: Record<string, (req: ProtoMessage) => Reply>) {
  const { http, calls } = makeHttp((method, req) => {
    const route = routes[method];
    if (!route) throw new Error(`unexpected ${method}`);
    return route(req);
  });
  return { ctx: ctxWith(http), calls };
}

const APP = () => new ProtoWriter().string(1, "ap-ci");
const ENV = () =>
  new ProtoWriter()
    .string(1, "en-1")
    .message(
      2,
      new ProtoWriter().string(1, "main").message(2, new ProtoWriter().string(1, "2025.06")),
    );

describe("Modal CI executor", () => {
  it("sizes Sandboxes in physical cores and maps GPU names", () => {
    expect(sandboxName(spec)).toBe(NAME);
    expect(sandboxResources("2vcpu-4gb")).toEqual({ milliCpu: 1000, memoryMb: 4096 });
    expect(sandboxResources("0.1vcpu-0.5gb")).toEqual({ milliCpu: 125, memoryMb: 512 });
    expect(() => sandboxResources("large")).toThrow("vCPUs and memory");
    expect(sandboxGpu("h100")).toEqual({ type: "H100", count: 1 });
    expect(sandboxGpu("H100!:2")).toEqual({ type: "H100!", count: 2 });
    expect(sandboxGpu("a100-80gb:4")).toEqual({ type: "A100-80GB", count: 4 });
    expect(sandboxGpu("NVIDIA L40S")).toEqual({ type: "L40S", count: 1 });
    expect(sandboxGpu("a10g")).toEqual({ type: "A10", count: 1 });
    expect(sandboxGpu("rtx-pro-6000")).toEqual({ type: "RTX-PRO-6000", count: 1 });
    expect(() => sandboxGpu("a10:8")).toThrow("at most 4 A10");
    expect(() => sandboxGpu("v100")).toThrow("no GPU `v100`");
  });

  it("builds a Sandbox with a timeout, tags, a name and no credentials", () => {
    const req = new ProtoMessage(
      createRequest({ ...spec, gpu: "h100:2", region: "us-east" }, "ap-ci", "im-1").finish(),
    );
    expect(req.string(1)).toBe("ap-ci");
    expect(readTags(req, 4)).toEqual(tags);
    const def = req.message(2)!;
    const args = def.strings(1);
    expect(args.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(args[2]).toContain("echo hi");
    expect(args[2]).toContain("apt-get");
    expect(def.string(3)).toBe("im-1");
    expect(def.uint(7)).toBe(3600);
    expect(def.string(30)).toBe(NAME);
    const resources = def.message(5)!;
    expect(resources.uint(2)).toBe(4096);
    expect(resources.uint(3)).toBe(1000);
    expect(resources.message(4)!.uint(2)).toBe(2);
    expect(resources.message(4)!.string(4)).toBe("H100");
    expect(def.message(17)!.strings(4)).toEqual(["us-east"]);
    expect(def.message(22)!.uint(1)).toBe(1);
    // No secrets (4), mounts (2, 13), OIDC token (37) or env (40).
    for (const field of [2, 4, 13, 37, 40]) expect(def.has(field)).toBe(false);
  });

  it("starts: app, builder version, image, then the Sandbox, never sending the token inside", async () => {
    const { ctx, calls } = modal({
      AppGetOrCreate: () => APP(),
      SandboxGetFromName: () => ({ grpcStatus: GrpcCode.NOT_FOUND, message: "no sandbox" }),
      EnvironmentGetOrCreate: () => ENV(),
      ImageGetOrCreate: () => new ProtoWriter().string(1, "im-1"),
      ImageJoinStreaming: () => [
        new ProtoWriter().string(3, "e1"),
        new ProtoWriter().message(1, new ProtoWriter().int(1, 1)).string(3, "e2"),
      ],
      SandboxCreate: () => new ProtoWriter().string(1, "sb-1"),
    });
    const handle = await modalCiStart(ctx, spec);
    expect(handle).toEqual({
      id: "sb-1",
      label: "modal sandbox sb-1",
      data: { app: "ap-ci", name: NAME },
    });
    expect(calls.map((c) => c.method)).toEqual([
      "AppGetOrCreate",
      "SandboxGetFromName",
      "EnvironmentGetOrCreate",
      "ImageGetOrCreate",
      "ImageJoinStreaming",
      "SandboxCreate",
    ]);
    const app = calls[0]!.request;
    expect(app.string(1)).toBe(CI_APP_NAME);
    expect(app.uint(3)).toBe(1);
    const lookup = calls[1]!.request;
    expect([lookup.string(1), lookup.string(3), lookup.bool(4)]).toEqual([NAME, CI_APP_NAME, true]);
    const image = calls[3]!.request;
    expect(image.message(2)!.strings(6)).toEqual(["FROM buildpack-deps:noble-curl"]);
    expect([image.string(4), image.string(9)]).toEqual(["ap-ci", "2025.06"]);
    expect(calls[4]!.request.string(1)).toBe("im-1");
    expect(calls[4]!.request.float(2)).toBe(55);
    const create = calls[5]!;
    // The secret is only ever a header; the Sandbox request does not hold it.
    expect(create.headers["x-modal-token-secret"]).toBe("as-test");
    expect(JSON.stringify(create.request.message(2)!.strings(1))).not.toContain("as-test");
    expect(JSON.stringify(create.request.message(2)!.strings(1))).not.toContain("ak-test");
  });

  it("finds the Sandbox a first start made", async () => {
    const { ctx, calls } = modal({
      AppGetOrCreate: () => APP(),
      SandboxGetFromName: () => new ProtoWriter().string(1, "sb-1"),
    });
    expect(await modalCiStart(ctx, spec)).toMatchObject({ id: "sb-1" });
    expect(calls).toHaveLength(2);
  });

  it("takes over a Sandbox a racing start made", async () => {
    let lookups = 0;
    const { ctx } = modal({
      AppGetOrCreate: () => APP(),
      SandboxGetFromName: () =>
        lookups++ === 0
          ? { grpcStatus: GrpcCode.NOT_FOUND }
          : new ProtoWriter().string(1, "sb-raced"),
      EnvironmentGetOrCreate: () => ENV(),
      ImageGetOrCreate: () =>
        new ProtoWriter().string(1, "im-1").message(2, new ProtoWriter().int(1, 1)),
      SandboxCreate: () => ({ grpcStatus: GrpcCode.ALREADY_EXISTS, message: "name in use" }),
    });
    expect(await modalCiStart(ctx, spec)).toMatchObject({ id: "sb-raced" });
  });

  it("refuses what a Sandbox cannot do before making anything", async () => {
    const { ctx, calls } = modal({});
    await expect(modalCiStart(ctx, { ...spec, maxSeconds: 25 * 3600 })).rejects.toThrow(
      "at most 24 hours",
    );
    await expect(modalCiStart(ctx, { ...spec, gpu: "v100" })).rejects.toThrow("no GPU");
    await expect(modalCiStart(ctx, { ...spec, region: "us-east-1" })).rejects.toThrow("no region");
    await expect(modalCiStart(ctx, { ...spec, kind: "vm" })).rejects.toThrow("kind `container`");
    await expect(
      modalCiStart(ctx, { ...spec, tags: { ...tags, big: "x".repeat(600) } }),
    ).rejects.toThrow("512 bytes");
    expect(calls).toHaveLength(0);
  });

  it("fails a start whose image does not build", async () => {
    const { ctx } = modal({
      AppGetOrCreate: () => APP(),
      SandboxGetFromName: () => ({ grpcStatus: GrpcCode.NOT_FOUND }),
      EnvironmentGetOrCreate: () => ENV(),
      ImageGetOrCreate: () =>
        new ProtoWriter()
          .string(1, "im-1")
          .message(2, new ProtoWriter().int(1, 2).string(2, "manifest unknown")),
    });
    await expect(modalCiStart(ctx, { ...spec, image: "nope:1" })).rejects.toThrow(
      "could not prepare the image nope:1: failed: manifest unknown",
    );
  });

  it("reports status from the wait result and the task", async () => {
    const reply = (wait: Reply, task?: Reply) =>
      modal({
        SandboxWait: () => wait,
        SandboxGetTaskId: () => task ?? new ProtoWriter(),
      }).ctx;
    const handle = { id: "sb-1", label: "modal sandbox sb-1" };
    expect(await modalCiStatus(reply({ grpcStatus: GrpcCode.NOT_FOUND }), handle)).toEqual({
      state: "gone",
    });
    expect(
      await modalCiStatus(
        reply(new ProtoWriter().message(1, new ProtoWriter().int(1, 1).int(3, 0))),
        handle,
      ),
    ).toEqual({ state: "stopped", detail: "exit code 0" });
    expect(
      await modalCiStatus(reply(new ProtoWriter().message(1, new ProtoWriter().int(1, 4))), handle),
    ).toEqual({ state: "stopped", detail: "timed out" });
    expect(await modalCiStatus(reply(new ProtoWriter()), handle)).toEqual({ state: "starting" });
    expect(
      await modalCiStatus(reply(new ProtoWriter(), new ProtoWriter().string(1, "ta-1")), handle),
    ).toEqual({ state: "running" });
  });

  it("tears down idempotently", async () => {
    const handle = { id: "sb-1", label: "modal sandbox sb-1" };
    const ok = modal({ SandboxTerminate: () => new ProtoWriter() });
    await modalCiTeardown(ok.ctx, handle);
    expect(ok.calls[0]!.request.string(1)).toBe("sb-1");
    const gone = modal({ SandboxTerminate: () => ({ grpcStatus: GrpcCode.NOT_FOUND }) });
    await expect(modalCiTeardown(gone.ctx, handle)).resolves.toBeUndefined();
    const refused = modal({
      SandboxTerminate: () => ({ grpcStatus: GrpcCode.PERMISSION_DENIED }),
    });
    await expect(modalCiTeardown(refused.ctx, handle)).rejects.toThrow("PERMISSION_DENIED");
  });

  it("lists the CI app's running Sandboxes that carry the tag, page by page", async () => {
    const { ctx, calls } = modal({
      AppGetOrCreate: (req) => {
        expect(req.uint(3)).toBe(0);
        return APP();
      },
      SandboxList: (req) => {
        if (req.double(2) === 0) {
          const first = new ProtoWriter()
            .string(1, "sb-1")
            .double(3, 1_700_000_100)
            .string(7, NAME);
          for (const t of tagEntries(tags)) first.message(6, t);
          return new ProtoWriter()
            .message(1, first)
            .message(1, new ProtoWriter().string(1, "sb-2").double(3, 1_700_000_050));
        }
        return new ProtoWriter();
      },
      SandboxTagsGet: () => {
        const res = new ProtoWriter();
        for (const t of tagEntries({ other: "x" })) res.message(1, t);
        return res;
      },
    });
    const found = await modalCiListTagged(ctx, "infrawrench-ci");
    expect(found).toEqual([
      {
        handle: { id: "sb-1", label: "modal sandbox sb-1", data: { app: "ap-ci", name: NAME } },
        tags,
        createdAt: new Date(1_700_000_100_000).toISOString(),
        live: true,
      },
    ]);
    expect(calls.filter((c) => c.method === "SandboxList").map((c) => c.request.double(2))).toEqual(
      [0, 1_700_000_050],
    );
  });

  it("lists nothing when the CI app was never made", async () => {
    const { ctx } = modal({ AppGetOrCreate: () => ({ grpcStatus: GrpcCode.NOT_FOUND }) });
    expect(await modalCiListTagged(ctx, "infrawrench-ci")).toEqual([]);
  });

  it("preflight names the Contributor role when the app cannot be made", async () => {
    const { ctx } = modal({
      EnvironmentGetOrCreate: () => ENV(),
      AppGetOrCreate: () => ({ grpcStatus: GrpcCode.PERMISSION_DENIED, message: "viewer" }),
    });
    const result = await modalCiPreflight(ctx, "container");
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.permission)).toEqual(["Contributor"]);
  });

  it("preflight passes a Contributor token and checks the region", async () => {
    const routes = {
      EnvironmentGetOrCreate: () => ENV(),
      AppGetOrCreate: () => APP(),
      SandboxList: () => new ProtoWriter(),
    };
    expect(await modalCiPreflight(modal(routes).ctx, "container")).toEqual({
      ok: true,
      missing: [],
      problems: [],
    });
    const bad = await modalCiPreflight(modal(routes).ctx, "container", "us-east-1");
    expect(bad.ok).toBe(false);
    expect(bad.problems[0]).toContain("no region `us-east-1`");
  });
});
