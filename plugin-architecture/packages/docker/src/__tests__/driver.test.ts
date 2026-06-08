import { describe, it, expect, vi, beforeEach } from "vitest";

const mockVersion = vi.fn();
const mockListContainers = vi.fn();
const mockListImages = vi.fn();
const mockListVolumes = vi.fn();
const mockListNetworks = vi.fn();
const mockInspect = vi.fn();
const mockStart = vi.fn();
const mockStop = vi.fn();
const mockRestart = vi.fn();
const mockCreateVolume = vi.fn();
const mockCreateNetwork = vi.fn();
const mockRemoveImage = vi.fn();
const mockRemoveVolume = vi.fn();
const mockRemoveNetwork = vi.fn();

const mockGetContainer = vi.fn(() => ({
  inspect: mockInspect,
  start: mockStart,
  stop: mockStop,
  restart: mockRestart,
}));

const mockGetImage = vi.fn(() => ({ remove: mockRemoveImage }));
const mockGetVolume = vi.fn(() => ({ remove: mockRemoveVolume }));
const mockGetNetwork = vi.fn(() => ({ remove: mockRemoveNetwork }));

vi.mock("dockerode", () => ({
  default: vi.fn(function () {
    return {
      version: mockVersion,
      listContainers: mockListContainers,
      listImages: mockListImages,
      listVolumes: mockListVolumes,
      listNetworks: mockListNetworks,
      createVolume: mockCreateVolume,
      createNetwork: mockCreateNetwork,
      getContainer: mockGetContainer,
      getImage: mockGetImage,
      getVolume: mockGetVolume,
      getNetwork: mockGetNetwork,
    };
  }),
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

    it("listVolumes unwraps Docker's volume response envelope", async () => {
      const volumes = [{ Name: "data", Driver: "local" }];
      mockListVolumes.mockResolvedValue({ Volumes: volumes, Warnings: [] });

      const result = await driver.command("unix:///var/run/docker.sock", "listVolumes");

      expect(result).toEqual(volumes);
    });

    it("listNetworks returns Docker networks", async () => {
      const networks = [{ Id: "net123", Name: "bridge" }];
      mockListNetworks.mockResolvedValue(networks);

      const result = await driver.command("unix:///var/run/docker.sock", "listNetworks");

      expect(result).toEqual(networks);
    });

    it("creates volumes and networks", async () => {
      mockCreateVolume.mockResolvedValue({ Name: "data" });
      mockCreateNetwork.mockResolvedValue({ Id: "net123" });

      await driver.command("unix:///var/run/docker.sock", "createVolume", {
        name: "data",
        driver: "local",
      });
      await driver.command("unix:///var/run/docker.sock", "createNetwork", {
        name: "frontend",
        driver: "bridge",
        internal: true,
      });

      expect(mockCreateVolume).toHaveBeenCalledWith({ Name: "data", Driver: "local" });
      expect(mockCreateNetwork).toHaveBeenCalledWith({
        Name: "frontend",
        Driver: "bridge",
        Internal: true,
      });
    });

    it("removes images, volumes, and networks", async () => {
      mockRemoveImage.mockResolvedValue(undefined);
      mockRemoveVolume.mockResolvedValue(undefined);
      mockRemoveNetwork.mockResolvedValue(undefined);

      await expect(
        driver.command("unix:///var/run/docker.sock", "removeImage", { id: "sha256:abc" }),
      ).resolves.toEqual({ ok: true });
      await expect(
        driver.command("unix:///var/run/docker.sock", "removeVolume", { name: "data" }),
      ).resolves.toEqual({ ok: true });
      await expect(
        driver.command("unix:///var/run/docker.sock", "removeNetwork", { id: "net123" }),
      ).resolves.toEqual({ ok: true });

      expect(mockGetImage).toHaveBeenCalledWith("sha256:abc");
      expect(mockGetVolume).toHaveBeenCalledWith("data");
      expect(mockGetNetwork).toHaveBeenCalledWith("net123");
    });

    it("throws for unknown ops", async () => {
      await expect(driver.command("unix:///var/run/docker.sock", "bogusOp")).rejects.toThrow(
        'Docker driver: unknown op "bogusOp"',
      );
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
