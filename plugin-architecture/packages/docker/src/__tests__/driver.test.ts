import { describe, it, expect, vi, beforeEach } from "vitest";

const mockVersion = vi.fn();
const mockListContainers = vi.fn();
const mockListImages = vi.fn();
const mockInspect = vi.fn();
const mockStart = vi.fn();
const mockStop = vi.fn();
const mockRestart = vi.fn();

const mockGetContainer = vi.fn(() => ({
  inspect: mockInspect,
  start: mockStart,
  stop: mockStop,
  restart: mockRestart,
}));

vi.mock("dockerode", () => ({
  default: vi.fn(() => ({
    version: mockVersion,
    listContainers: mockListContainers,
    listImages: mockListImages,
    getContainer: mockGetContainer,
  })),
}));

import { driver } from "../driver.js";
import Dockerode from "dockerode";

describe("docker driver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has id 'docker'", () => {
    expect(driver.id).toBe("docker");
  });

  describe("command", () => {
    it("version returns docker version info", async () => {
      const versionInfo = { Version: "24.0.0", ApiVersion: "1.43" };
      mockVersion.mockResolvedValue(versionInfo);

      const result = await driver.command("unix:///var/run/docker.sock", "version");

      expect(result).toEqual(versionInfo);
    });

    it("listContainers returns all containers", async () => {
      const containers = [{ Id: "abc123", Names: ["/myapp"] }];
      mockListContainers.mockResolvedValue(containers);

      const result = await driver.command("unix:///var/run/docker.sock", "listContainers");

      expect(result).toEqual(containers);
      expect(mockListContainers).toHaveBeenCalledWith({ all: true });
    });

    it("inspectContainer inspects a specific container", async () => {
      const info = { Id: "abc123", State: { Running: true } };
      mockInspect.mockResolvedValue(info);

      const result = await driver.command("unix:///var/run/docker.sock", "inspectContainer", {
        id: "abc123",
      });

      expect(result).toEqual(info);
      expect(mockGetContainer).toHaveBeenCalledWith("abc123");
    });

    it("startContainer starts a container", async () => {
      mockStart.mockResolvedValue(undefined);

      const result = await driver.command("unix:///var/run/docker.sock", "startContainer", {
        id: "abc123",
      });

      expect(result).toEqual({ ok: true });
    });

    it("stopContainer stops a container", async () => {
      mockStop.mockResolvedValue(undefined);

      const result = await driver.command("unix:///var/run/docker.sock", "stopContainer", {
        id: "abc123",
      });

      expect(result).toEqual({ ok: true });
    });

    it("restartContainer restarts a container", async () => {
      mockRestart.mockResolvedValue(undefined);

      const result = await driver.command("unix:///var/run/docker.sock", "restartContainer", {
        id: "abc123",
      });

      expect(result).toEqual({ ok: true });
    });

    it("listImages returns images", async () => {
      const images = [{ Id: "sha256:abc", RepoTags: ["nginx:latest"] }];
      mockListImages.mockResolvedValue(images);

      const result = await driver.command("unix:///var/run/docker.sock", "listImages");

      expect(result).toEqual(images);
      expect(mockListImages).toHaveBeenCalledWith({ all: false });
    });

    it("throws for unknown ops", async () => {
      await expect(
        driver.command("unix:///var/run/docker.sock", "removeContainer"),
      ).rejects.toThrow('Docker driver: unknown op "removeContainer"');
    });

    it("creates client with socketPath for unix:// host", async () => {
      mockVersion.mockResolvedValue({});

      await driver.command("unix:///var/run/docker.sock", "version");

      expect(Dockerode).toHaveBeenCalledWith({ socketPath: "/var/run/docker.sock" });
    });

    it("creates client with host/port for tcp host", async () => {
      mockVersion.mockResolvedValue({});

      await driver.command("http://192.168.1.1:2375", "version");

      expect(Dockerode).toHaveBeenCalledWith({ host: "192.168.1.1", port: 2375 });
    });

    it("creates client with default socket when host is empty", async () => {
      mockVersion.mockResolvedValue({});

      await driver.command("", "version");

      expect(Dockerode).toHaveBeenCalledWith({ socketPath: "/var/run/docker.sock" });
    });

    it("propagates errors from docker operations", async () => {
      mockVersion.mockRejectedValue(new Error("connection refused"));

      await expect(driver.command("unix:///var/run/docker.sock", "version")).rejects.toThrow(
        "connection refused",
      );
    });
  });
});
