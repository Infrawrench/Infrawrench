import { describe, it, expect, vi, beforeEach } from "vitest";

const mockVersion = vi.fn();
const mockPull = vi.fn();
const mockCreateContainer = vi.fn();
const mockFollowProgress = vi.fn();
const mockRemove = vi.fn();
const mockInspect = vi.fn();
const mockStart = vi.fn();

const mockGetContainer = vi.fn(() => ({
  inspect: mockInspect,
  start: mockStart,
  remove: mockRemove,
}));

vi.mock("dockerode", () => ({
  default: vi.fn(function () {
    return {
      version: mockVersion,
      pull: mockPull,
      createContainer: mockCreateContainer,
      getContainer: mockGetContainer,
      modem: { followProgress: mockFollowProgress },
    };
  }),
}));

import { driver } from "../driver.js";
import Dockerode from "dockerode";

const HOST = "unix:///var/run/docker.sock";

describe("docker driver — createContainer / removeContainer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pulls the image, creates and starts the container, then inspects", async () => {
    mockPull.mockResolvedValue("stream-handle");
    mockFollowProgress.mockImplementation((_stream: unknown, cb: (err: Error | null) => void) =>
      cb(null),
    );
    const created = { start: mockStart, inspect: mockInspect };
    mockCreateContainer.mockResolvedValue(created);
    mockStart.mockResolvedValue(undefined);
    mockInspect.mockResolvedValue({ Id: "newid", State: { Status: "running" } });

    const result = await driver.command(HOST, "createContainer", {
      image: "nginx:latest",
      name: "web",
      exposedPorts: { "80/tcp": {} },
      hostConfig: { PortBindings: { "80/tcp": [{ HostPort: "8080" }] } },
      start: true,
    });

    expect(mockPull).toHaveBeenCalledWith("nginx:latest");
    expect(mockCreateContainer).toHaveBeenCalledWith({
      Image: "nginx:latest",
      name: "web",
      ExposedPorts: { "80/tcp": {} },
      HostConfig: { PortBindings: { "80/tcp": [{ HostPort: "8080" }] } },
    });
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ Id: "newid", State: { Status: "running" } });
  });

  it("does not start the container when start is falsey", async () => {
    mockPull.mockResolvedValue("s");
    mockFollowProgress.mockImplementation((_s: unknown, cb: (e: Error | null) => void) => cb(null));
    mockCreateContainer.mockResolvedValue({ start: mockStart, inspect: mockInspect });
    mockInspect.mockResolvedValue({ Id: "x" });

    await driver.command(HOST, "createContainer", { image: "redis:7" });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("wraps pull errors with a descriptive message", async () => {
    mockPull.mockRejectedValue(new Error("no such image"));
    await expect(driver.command(HOST, "createContainer", { image: "ghost:404" })).rejects.toThrow(
      /Failed to pull image "ghost:404": no such image/,
    );
    expect(mockCreateContainer).not.toHaveBeenCalled();
  });

  it("rejects when followProgress reports an error", async () => {
    mockPull.mockResolvedValue("s");
    mockFollowProgress.mockImplementation((_s: unknown, cb: (e: Error | null) => void) =>
      cb(new Error("progress boom")),
    );
    await expect(driver.command(HOST, "createContainer", { image: "i" })).rejects.toThrow(
      /Failed to pull image "i": progress boom/,
    );
  });

  it("removeContainer forces removal", async () => {
    mockRemove.mockResolvedValue(undefined);
    const result = await driver.command(HOST, "removeContainer", { id: "cid" });
    expect(mockGetContainer).toHaveBeenCalledWith("cid");
    expect(mockRemove).toHaveBeenCalledWith({ force: true });
    expect(result).toEqual({ ok: true });
  });

  it("defaults the TCP port to 2375 when the URL omits it", async () => {
    mockVersion.mockResolvedValue({});
    await driver.command("tcp://docker.internal", "version");
    expect(Dockerode).toHaveBeenCalledWith({ host: "docker.internal", port: 2375 });
  });
});
