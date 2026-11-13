import { hostDriver } from "@infrawrench/plugin-base/effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPull = vi.fn();
const mockFollowProgress = vi.fn();
const mockCreateContainer = vi.fn();
const mockInfo = vi.fn();
const mockListContainers = vi.fn();
const mockImageInspect = vi.fn();
const mockStart = vi.fn();
const mockInspect = vi.fn();
const mockRemove = vi.fn();

// No daemon is ever reached: dockerode is replaced whole.
vi.mock("dockerode", () => ({
  default: vi.fn(function () {
    return {
      pull: mockPull,
      info: mockInfo,
      listContainers: mockListContainers,
      createContainer: mockCreateContainer,
      getImage: vi.fn(() => ({ inspect: mockImageInspect })),
      getContainer: vi.fn(() => ({ start: mockStart, inspect: mockInspect, remove: mockRemove })),
      modem: { followProgress: mockFollowProgress },
    };
  }),
}));

import {
  buildScript,
  ciListTagged,
  ciPreflight,
  ciStart,
  ciStatus,
  ciTeardown,
  containerName,
  createBody,
  parseMachine,
  TAGS_LABEL,
  type DockerCommand,
} from "../ci-executor.js";
import { driver as contractDriver } from "../driver.js";

const driver = hostDriver(contractDriver);
const HOST = "tcp://docker.example.test:2375";

const tags = {
  "infrawrench-ci": "org-1",
  "infrawrench-ci-run": "run-1",
  "infrawrench-ci-job": "5f0c1c2e-1111-4a4a-9b9b-0123456789ab",
};
const spec = {
  kind: "container" as const,
  bootstrap: "#!/bin/sh\necho hi\n",
  tags,
  name: "infrawrench-ci-build",
  maxSeconds: 1800,
};
const NAME = "iwci-5f0c1c2e11114a4a9b9b0123456789ab";

/** A fake driver: answers each op from a table, recording what was asked. */
function fakeDocker(answers: Record<string, (params: Record<string, unknown>) => unknown>) {
  const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  const command: DockerCommand = async (op, params = {}) => {
    calls.push({ op, params });
    const answer = answers[op];
    if (!answer) throw new Error(`unexpected ${op}`);
    return answer(params);
  };
  return { command, calls };
}

const httpError = (statusCode: number) =>
  Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });

describe("createBody", () => {
  it("runs the bootstrap unprivileged, with no mounts, auto-removed, under a time limit", () => {
    const body = createBody(spec) as any;
    expect(body.Image).toBe("buildpack-deps:noble-curl");
    expect(body.Entrypoint).toEqual(["/bin/sh", "-c"]);
    expect(body.Cmd[0]).toContain("sleep 1800;");
    expect(body.Cmd[1]).toBe("iwci");
    expect(body.Cmd[2]).toContain("for t in bash curl");
    expect(body.Cmd[2]).toContain("echo hi");
    expect(body.HostConfig.AutoRemove).toBe(true);
    expect(body.HostConfig.Privileged).toBeUndefined();
    expect(body.HostConfig.Binds).toBeUndefined();
    expect(body.HostConfig.Mounts).toBeUndefined();
    expect(body.HostConfig.NetworkMode).toBeUndefined();
    expect(body.Env).toBeUndefined();
    expect(body.StopTimeout).toBe(10);
    expect(body.HostConfig.NanoCpus).toBe(2e9);
    expect(body.HostConfig.Memory).toBe(4 * 1024 ** 3);
    expect(body.Labels["infrawrench-ci-job"]).toBe(tags["infrawrench-ci-job"]);
    expect(JSON.parse(body.Labels[TAGS_LABEL])).toEqual(tags);
  });

  it("gives a build its own daemon in a privileged dind container", () => {
    const body = createBody({ ...spec, kind: "build" }) as any;
    expect(body.Image).toBe("docker:29-dind");
    expect(body.HostConfig.Privileged).toBe(true);
    expect(body.Cmd[2]).toContain(
      "dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock",
    );
    expect(body.Cmd[2]).not.toContain("tcp://");
    expect(() => createBody({ ...spec, kind: "build", gpu: "nvidia:1" })).toThrow(/GPUs/);
  });

  it("asks for GPUs and refuses other kinds and sizes", () => {
    const body = createBody({ ...spec, gpu: "a100:2" }) as any;
    expect(body.HostConfig.DeviceRequests).toEqual([
      { Driver: "nvidia", Count: 2, Capabilities: [["gpu"]] },
    ]);
    expect(() => createBody({ ...spec, kind: "vm" })).toThrow(/container/);
    expect(() => createBody({ ...spec, machine: "huge" })).toThrow(/CPUs and memory/);
  });

  it("parses sizes and names the container after the job", () => {
    expect(parseMachine("0.5vcpu-0.5gb")).toEqual({ nanoCpus: 5e8, memory: 512 * 1024 ** 2 });
    expect(containerName(spec)).toBe(NAME);
    expect(buildScript("x")).toContain("until docker info");
  });
});

describe("ciPreflight", () => {
  it("passes for a Linux daemon and explains one it cannot use", async () => {
    expect(
      await ciPreflight(fakeDocker({ ciInfo: () => ({ OSType: "linux" }) }).command, "container"),
    ).toEqual({
      ok: true,
      missing: [],
      problems: [],
    });
    const windows = await ciPreflight(
      fakeDocker({ ciInfo: () => ({ OSType: "windows" }) }).command,
      "build",
    );
    expect(windows.problems[0]).toMatch(/windows containers/);
    const down = await ciPreflight(
      fakeDocker({
        ciInfo: () => {
          throw new Error("connect ECONNREFUSED");
        },
      }).command,
      "container",
    );
    expect(down.ok).toBe(false);
    expect(down.problems[0]).toMatch(/could not reach/);
  });
});

describe("ciStart", () => {
  it("creates the container under the job's name", async () => {
    const { command, calls } = fakeDocker({ ciRun: () => ({ id: "c".repeat(64) }) });
    const handle = await ciStart(command, spec);
    expect(handle.id).toBe("c".repeat(64));
    expect(handle.label).toBe(`docker container ${NAME} (cccccccccccc)`);
    expect(calls[0]!.params["name"]).toBe(NAME);
  });

  it("is idempotent: the same name for the same job is the container it made", async () => {
    const { command, calls } = fakeDocker({
      ciRun: () => ({ conflict: true }),
      ciInspect: () => ({ Id: "abc", Config: { Labels: tags }, State: { Status: "created" } }),
      ciStartContainer: () => ({ ok: true }),
    });
    expect((await ciStart(command, spec)).id).toBe("abc");
    expect(calls.map((c) => c.op)).toEqual(["ciRun", "ciInspect", "ciStartContainer"]);
  });

  it("refuses someone else's container of the same name", async () => {
    const { command } = fakeDocker({
      ciRun: () => ({ conflict: true }),
      ciInspect: () => ({ Id: "abc", Config: { Labels: {} } }),
    });
    await expect(ciStart(command, spec)).rejects.toThrow(/not this CI job's/);
  });
});

describe("ciStatus, ciTeardown and ciListTagged", () => {
  const handle = { id: "abc", label: "x" };

  it("maps the container's state", async () => {
    const status = (State: object | null) =>
      ciStatus(fakeDocker({ ciInspect: () => (State ? { State } : null) }).command, handle);
    expect(await status(null)).toEqual({ state: "gone" });
    expect(await status({ Status: "created" })).toEqual({ state: "starting" });
    expect(await status({ Status: "running" })).toEqual({ state: "running" });
    expect(await status({ Status: "exited", ExitCode: 2 })).toEqual({
      state: "stopped",
      detail: "exit code 2",
    });
    expect(await status({ Status: "exited", OOMKilled: true })).toEqual({
      state: "stopped",
      detail: "out of memory",
    });
  });

  it("tears down through the driver", async () => {
    const { command, calls } = fakeDocker({ ciRemove: () => ({ ok: true }) });
    await ciTeardown(command, handle);
    expect(calls).toEqual([{ op: "ciRemove", params: { id: "abc" } }]);
  });

  it("lists by label, with the tags as sent and not the image's labels", async () => {
    const { command, calls } = fakeDocker({
      ciList: () => [
        {
          Id: "abc",
          Names: [`/${NAME}`],
          Labels: {
            ...tags,
            [TAGS_LABEL]: JSON.stringify(tags),
            "org.opencontainers.image.version": "24.04",
          },
          State: "running",
          Created: 1_763_000_000,
        },
        { Id: "def", Names: ["/old"], Labels: { "infrawrench-ci": "org-1" }, State: "exited" },
      ],
    });
    const found = await ciListTagged(command, "infrawrench-ci");
    expect(calls[0]!.params).toEqual({ label: "infrawrench-ci" });
    expect(found[0]).toEqual({
      handle: { id: "abc", label: `docker container ${NAME} (abc)`, data: { name: NAME } },
      tags,
      createdAt: new Date(1_763_000_000_000).toISOString(),
      live: true,
    });
    expect(found[1]!.tags).toEqual({ "infrawrench-ci": "org-1" });
    expect(found[1]!.live).toBe(false);
  });
});

describe("docker driver CI operations", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ciRun pulls, creates under the name and starts", async () => {
    mockPull.mockResolvedValue("stream");
    mockFollowProgress.mockImplementation((_s: unknown, cb: (e: Error | null) => void) => cb(null));
    const start = vi.fn();
    mockCreateContainer.mockResolvedValue({ id: "new", start });
    const result = await driver.command(HOST, "ciRun", {
      name: NAME,
      image: "img:1",
      body: { Image: "img:1" },
    });
    expect(result).toEqual({ id: "new" });
    expect(mockCreateContainer).toHaveBeenCalledWith({ Image: "img:1", name: NAME });
    expect(start).toHaveBeenCalled();
  });

  it("ciRun uses an image already present when the registry is out of reach, and reports a name in use", async () => {
    mockPull.mockRejectedValue(new Error("registry down"));
    mockImageInspect.mockResolvedValue({});
    mockCreateContainer.mockRejectedValue(httpError(409));
    expect(await driver.command(HOST, "ciRun", { name: NAME, image: "img:1", body: {} })).toEqual({
      conflict: true,
    });
    mockImageInspect.mockRejectedValue(httpError(404));
    await expect(
      driver.command(HOST, "ciRun", { name: NAME, image: "img:1", body: {} }),
    ).rejects.toThrow(/Failed to pull image "img:1"/);
  });

  it("ciInspect is null for a container that is gone; ciRemove tolerates gone and being removed", async () => {
    mockInspect.mockRejectedValue(httpError(404));
    expect(await driver.command(HOST, "ciInspect", { id: "x" })).toBeNull();
    mockRemove.mockRejectedValueOnce(httpError(404)).mockRejectedValueOnce(httpError(409));
    expect(await driver.command(HOST, "ciRemove", { id: "x" })).toEqual({ ok: true });
    expect(await driver.command(HOST, "ciRemove", { id: "x" })).toEqual({ ok: true });
    expect(mockRemove).toHaveBeenCalledWith({ force: true, v: true });
    mockRemove.mockRejectedValueOnce(httpError(500));
    await expect(driver.command(HOST, "ciRemove", { id: "x" })).rejects.toThrow();
  });

  it("ciList filters by label over every container; ciStartContainer tolerates one already started", async () => {
    mockListContainers.mockResolvedValue([]);
    await driver.command(HOST, "ciList", { label: "infrawrench-ci" });
    expect(mockListContainers).toHaveBeenCalledWith({
      all: true,
      filters: { label: ["infrawrench-ci"] },
    });
    mockStart.mockRejectedValue(httpError(304));
    expect(await driver.command(HOST, "ciStartContainer", { id: "x" })).toEqual({ ok: true });
    mockInfo.mockResolvedValue({
      OSType: "linux",
      Architecture: "x86_64",
      ServerVersion: "29.0",
      Secret: "no",
    });
    expect(await driver.command(HOST, "ciInfo")).toEqual({
      OSType: "linux",
      Architecture: "x86_64",
      ServerVersion: "29.0",
    });
  });
});
