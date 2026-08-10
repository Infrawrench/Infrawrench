import { describe, expect, it, vi, type Mock } from "vitest";
import { DockerClient } from "../client.js";
import type { HostServices, ResourceInstance } from "@infrawrench/plugin-base";

interface DockerStub {
  command: Mock;
}

function makeServices(handler: (op: string, params?: Record<string, unknown>) => unknown): {
  services: HostServices;
  docker: DockerStub;
} {
  const command = vi.fn(async (op: string, params?: Record<string, unknown>) =>
    handler(op, params),
  );
  const docker = { command };
  return { services: { docker } as unknown as HostServices, docker };
}

const sampleContainer = {
  Id: "abcdef0123456789aaaa",
  Names: ["/web"],
  Image: "nginx:latest",
  Status: "Up 3 hours",
  State: "running",
  Ports: [
    { IP: "0.0.0.0", PrivatePort: 80, PublicPort: 8080, Type: "tcp" },
    { PrivatePort: 9000, Type: "tcp" }, // no PublicPort -> filtered out
  ],
  Labels: {},
  Created: 1_700_000_000,
  NetworkSettings: {
    Networks: {
      frontend: { NetworkID: "networkabcdef0123456789" },
      backend: { NetworkID: "networkfedcba9876543210" },
    },
  },
  Mounts: [
    { Type: "volume", Name: "app-data" },
    { Type: "volume", Name: "app-data" }, // same volume twice -> deduped
    { Type: "bind", Source: "/etc/hosts" }, // bind mount -> not a docker volume
  ],
};

const sampleImage = {
  Id: "sha256:abcdef0123456789",
  RepoTags: ["nginx:latest"],
  Created: 1_700_000_000,
  Size: 12_582_912,
  Containers: 2,
};

const sampleVolume = {
  Name: "app-data",
  Driver: "local",
  Mountpoint: "/var/lib/docker/volumes/app-data/_data",
  CreatedAt: "2024-01-01T00:00:00Z",
  Scope: "local",
};

const sampleNetwork = {
  Id: "networkabcdef0123456789",
  Name: "frontend",
  Driver: "bridge",
  Scope: "local",
  Created: "2024-01-02T00:00:00Z",
  Internal: false,
  IPAM: { Config: [{ Subnet: "172.18.0.0/16", Gateway: "172.18.0.1" }] },
};

describe("DockerClient.listResources", () => {
  it("maps containers to ResourceInstances with formatted ports and slugged id", async () => {
    const { services } = makeServices((op) => (op === "listContainers" ? [sampleContainer] : []));
    const client = new DockerClient({ dockerHost: "unix:///var/run/docker.sock" }, services);
    const list = await client.listResources("docker-container", "acct");
    expect(list).toHaveLength(1);
    const r = list[0]!;
    expect(r.id).toBe("acct:docker-container:abcdef012345");
    expect(r.pluginId).toBe("docker");
    expect(r.resourceTypeId).toBe("docker-container");
    expect(r.displayName).toBe("web");
    expect(r.externalId).toBe("abcdef0123456789aaaa");
    expect(r.fields).toEqual({
      name: "web",
      image: "nginx:latest",
      status: "Up 3 hours",
      ports: "8080->80/tcp",
      networks: "frontend, backend",
      volumes: "app-data",
    });
    expect(r.resolvedOutputs).toEqual({ containerId: "abcdef0123456789aaaa", status: "running" });
    expect(r.createdAt).toBe(new Date(1_700_000_000 * 1000).toISOString());
  });

  it("falls back to the short id for display name when there is no name", async () => {
    const { services } = makeServices(() => [{ ...sampleContainer, Names: [], Ports: [] }]);
    const client = new DockerClient({ dockerHost: "" }, services);
    const [r] = await client.listResources("docker-container", "a");
    expect(r!.displayName).toBe("abcdef012345");
    expect(r!.fields["ports"]).toBe("");
  });

  it("returns an empty array when no docker service is injected", async () => {
    const client = new DockerClient({ dockerHost: "" });
    expect(await client.listResources("docker-container", "a")).toEqual([]);
  });

  it("throws for unknown resource types", async () => {
    const client = new DockerClient({ dockerHost: "" });
    await expect(client.listResources("widget", "a")).rejects.toThrow(/unknown resource type/);
  });

  it("maps images to ResourceInstances with encoded Docker ids", async () => {
    const { services } = makeServices((op) => (op === "listImages" ? [sampleImage] : []));
    const client = new DockerClient({ dockerHost: "" }, services);

    const [r] = await client.listResources("docker-image", "acct");

    expect(r).toMatchObject({
      id: "acct:docker-image:sha256%3Aabcdef0123456789",
      resourceTypeId: "docker-image",
      displayName: "nginx:latest",
      fields: { tags: "nginx:latest", size: "12 MB", containers: 2 },
      resolvedOutputs: { imageId: "sha256:abcdef0123456789" },
      externalId: "sha256:abcdef0123456789",
    });
  });

  it("maps volumes and networks to ResourceInstances", async () => {
    const { services } = makeServices((op) => {
      if (op === "listVolumes") return [sampleVolume];
      if (op === "listNetworks") return [sampleNetwork];
      return [];
    });
    const client = new DockerClient({ dockerHost: "" }, services);

    const [volume] = await client.listResources("docker-volume", "acct");
    const [network] = await client.listResources("docker-network", "acct");

    expect(volume).toMatchObject({
      id: "acct:docker-volume:app-data",
      displayName: "app-data",
      fields: {
        name: "app-data",
        driver: "local",
        mountpoint: "/var/lib/docker/volumes/app-data/_data",
        scope: "local",
      },
      resolvedOutputs: { volumeName: "app-data" },
    });
    expect(network).toMatchObject({
      id: "acct:docker-network:networkabcdef0123456789",
      displayName: "frontend",
      fields: {
        name: "frontend",
        driver: "bridge",
        scope: "local",
        subnet: "172.18.0.0/16",
        internal: false,
      },
      resolvedOutputs: { networkId: "networkabcdef0123456789" },
    });
  });
});

describe("DockerClient.getResource", () => {
  it("returns the matching resource", async () => {
    const { services } = makeServices(() => [sampleContainer]);
    const client = new DockerClient({ dockerHost: "" }, services);
    const r = await client.getResource(
      "docker-container",
      "acct:docker-container:abcdef012345",
      "acct",
    );
    expect(r.externalId).toBe("abcdef0123456789aaaa");
  });

  it("throws when the resource id is not found", async () => {
    const { services } = makeServices(() => [sampleContainer]);
    const client = new DockerClient({ dockerHost: "" }, services);
    await expect(client.getResource("docker-container", "missing", "acct")).rejects.toThrow(
      /not found/,
    );
  });
});

describe("DockerClient.resolveOutput", () => {
  it("throws not supported", async () => {
    const client = new DockerClient({ dockerHost: "" });
    await expect(client.resolveOutput("docker-container", "x", "y")).rejects.toThrow(
      /not supported/,
    );
  });
});

function instance(overrides: Partial<ResourceInstance> = {}): ResourceInstance {
  return {
    id: "acct:docker-container:abcdef012345",
    pluginId: "docker",
    resourceTypeId: "docker-container",
    accountId: "acct",
    displayName: "web",
    fields: { name: "web", image: "nginx:latest", status: "Up 3 hours", ports: "8080->80/tcp" },
    resolvedOutputs: { containerId: "abcdef0123456789aaaa", status: "running" },
    secretStates: [],
    externalId: "abcdef0123456789aaaa",
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("DockerClient.renderDetail", () => {
  it("renders container detail with running status dot and key-value list", () => {
    const client = new DockerClient({ dockerHost: "" });
    const detail = client.renderDetail(instance());
    expect(detail.title).toBe("web");
    expect(detail.subtitle).toBe("nginx:latest");
    expect(detail.status).toEqual({
      kind: "status-dot",
      status: "healthy",
      label: "Up 3 hours",
    });
    const kv = (detail.sections[0] as { children: { items: { key: string; value: string }[] }[] })
      .children[0]!;
    expect(kv.items).toEqual([
      { key: "ID", value: "abcdef012345" },
      { key: "Image", value: "nginx:latest" },
      { key: "Status", value: "Up 3 hours" },
      { key: "Ports", value: "8080->80/tcp" },
    ]);
    expect(detail.headerActions).toEqual([
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
    ]);
  });

  it("uses placeholders and external id when fields/outputs are missing", () => {
    const client = new DockerClient({ dockerHost: "" });
    const detail = client.renderDetail(
      instance({
        fields: { name: "" },
        resolvedOutputs: {},
        externalId: "ffffffff0000aaaa",
        displayName: "fallback",
      }),
    );
    // name is an empty string (present but falsy) so title becomes ""
    expect(detail.title).toBe("");
    expect(detail.status).toEqual({ kind: "status-dot", status: "info", label: "unknown" });
    const kv = (detail.sections[0] as { children: { items: { value: string }[] }[] }).children[0]!;
    expect(kv.items.map((i) => i.value)).toEqual(["ffffffff0000", "—", "unknown", "—"]);
  });
});

describe("DockerClient.renderSidebarItem", () => {
  it("maps id, label and a status dot based on state", () => {
    const client = new DockerClient({ dockerHost: "" });
    expect(client.renderSidebarItem(instance())).toEqual({
      id: "acct:docker-container:abcdef012345",
      label: "web",
      status: { kind: "status-dot", status: "healthy" },
    });
  });

  it("maps paused/exited/created/unknown states to the right status", () => {
    const client = new DockerClient({ dockerHost: "" });
    const status = (state: string) =>
      client.renderSidebarItem(instance({ resolvedOutputs: { status: state } })).status;
    expect(status("paused")).toMatchObject({ status: "degraded" });
    expect(status("exited")).toMatchObject({ status: "error" });
    expect(status("created")).toMatchObject({ status: "provisioning" });
    expect(status("whatever")).toMatchObject({ status: "info" });
  });
});

describe("DockerClient.getCreateConfig", () => {
  it("builds a select for image when images are available", async () => {
    const { services } = makeServices((op) =>
      op === "listImages"
        ? [{ RepoTags: ["nginx:latest", "<none>:<none>"] }, { RepoTags: ["redis:7"] }, {}]
        : [],
    );
    const client = new DockerClient({ dockerHost: "" }, services);
    const cfg = await client.getCreateConfig("docker-container");
    const imageField = cfg.fields.find((f) => f.key === "image")!;
    expect(imageField.kind).toBe("select");
    expect((imageField as { options: { id: string }[] }).options).toEqual([
      { id: "nginx:latest", label: "nginx:latest" },
      { id: "redis:7", label: "redis:7" },
    ]);
    expect(cfg.fields.map((f) => f.key)).toEqual(["name", "image", "ports", "start"]);
  });

  it("falls back to a text image field when no images / no docker service", async () => {
    const client = new DockerClient({ dockerHost: "" });
    const cfg = await client.getCreateConfig("docker-container");
    const imageField = cfg.fields.find((f) => f.key === "image")!;
    expect(imageField.kind).toBe("text");
    expect(imageField).not.toHaveProperty("options");
  });

  it("throws for unsupported types", async () => {
    const client = new DockerClient({ dockerHost: "" });
    await expect(client.getCreateConfig("widget")).rejects.toThrow(/not supported/);
  });

  it("returns create configs for volumes and networks", async () => {
    const client = new DockerClient({ dockerHost: "" });

    expect((await client.getCreateConfig("docker-volume")).fields.map((f) => f.key)).toEqual([
      "name",
      "driver",
    ]);
    expect((await client.getCreateConfig("docker-network")).fields.map((f) => f.key)).toEqual([
      "name",
      "driver",
      "internal",
    ]);
  });
});

describe("DockerClient.createResource", () => {
  it("parses port mappings and starts the container", async () => {
    const { services, docker } = makeServices((op, params) => {
      if (op === "createContainer") {
        expect(params).toMatchObject({
          image: "nginx:latest",
          name: "web",
          exposedPorts: { "80/tcp": {} },
          hostConfig: { PortBindings: { "80/tcp": [{ HostPort: "8080" }] } },
          start: true,
        });
        return {
          Id: "newid0123456789",
          Name: "/web",
          State: { Status: "running" },
          Created: "2021-06-01T00:00:00.000Z",
        };
      }
      return {};
    });
    const client = new DockerClient({ dockerHost: "" }, services);
    const r = await client.createResource("docker-container", "acct", {
      image: "nginx:latest",
      name: "web",
      ports: "8080:80",
      start: "true",
    });
    expect(docker.command).toHaveBeenCalledWith("createContainer", expect.any(Object));
    expect(r.id).toBe("acct:docker-container:newid0123456");
    expect(r.fields).toEqual({
      name: "web",
      image: "nginx:latest",
      status: "Up",
      ports: "8080:80",
    });
    expect(r.resolvedOutputs).toEqual({ containerId: "newid0123456789", status: "running" });
    expect(r.createdAt).toBe("2021-06-01T00:00:00.000Z");
  });

  it("creates without ports and without starting", async () => {
    const { services } = makeServices((op, params) => {
      if (op === "createContainer") {
        expect(params).toMatchObject({
          exposedPorts: undefined,
          hostConfig: undefined,
          start: false,
        });
        return { Id: "stoppedid12345", Name: "", State: { Status: "created" } };
      }
      return {};
    });
    const client = new DockerClient({ dockerHost: "" }, services);
    const r = await client.createResource("docker-container", "acct", {
      image: "redis:7",
      start: "false",
    });
    expect(r.fields["status"]).toBe("Created");
    expect(r.resolvedOutputs["status"]).toBe("created");
    expect(r.displayName).toBe("stoppedid123");
    // created falls back to "now" when result has no Created
    expect(typeof r.createdAt).toBe("string");
  });

  it("ignores malformed port segments", async () => {
    const { services } = makeServices((op, params) => {
      if (op === "createContainer") {
        expect(params).toMatchObject({ exposedPorts: undefined, hostConfig: undefined });
        return { Id: "x1234567890ab", Name: "/n" };
      }
      return {};
    });
    const client = new DockerClient({ dockerHost: "" }, services);
    await client.createResource("docker-container", "a", {
      image: "i",
      ports: "8080,:80, ",
    });
  });

  it("throws when no docker service is available", async () => {
    const client = new DockerClient({ dockerHost: "" });
    await expect(client.createResource("docker-container", "a", { image: "i" })).rejects.toThrow(
      /not available/,
    );
  });

  it("throws for unsupported types", async () => {
    const client = new DockerClient({ dockerHost: "" });
    await expect(client.createResource("widget", "a", {})).rejects.toThrow(/not supported/);
  });

  it("creates a Docker volume", async () => {
    const { services, docker } = makeServices((op, params) => {
      if (op === "createVolume") {
        expect(params).toEqual({ name: "app-data", driver: "local" });
        return sampleVolume;
      }
      return {};
    });
    const client = new DockerClient({ dockerHost: "" }, services);

    const r = await client.createResource("docker-volume", "acct", {
      name: "app-data",
      driver: "local",
    });

    expect(docker.command).toHaveBeenCalledWith("createVolume", {
      name: "app-data",
      driver: "local",
    });
    expect(r.resourceTypeId).toBe("docker-volume");
    expect(r.displayName).toBe("app-data");
  });

  it("creates a Docker network", async () => {
    const { services, docker } = makeServices((op, params) => {
      if (op === "createNetwork") {
        expect(params).toEqual({ name: "frontend", driver: "bridge", internal: true });
        return { Id: "networkabcdef0123456789" };
      }
      return {};
    });
    const client = new DockerClient({ dockerHost: "" }, services);

    const r = await client.createResource("docker-network", "acct", {
      name: "frontend",
      driver: "bridge",
      internal: "true",
    });

    expect(docker.command).toHaveBeenCalledWith("createNetwork", {
      name: "frontend",
      driver: "bridge",
      internal: true,
    });
    expect(r.resourceTypeId).toBe("docker-network");
    expect(r.displayName).toBe("frontend");
  });
});

describe("DockerClient.deleteResource", () => {
  it("removes the container by parsing the trailing id segment", async () => {
    const { services, docker } = makeServices(() => ({ ok: true }));
    const client = new DockerClient({ dockerHost: "" }, services);
    await client.deleteResource("docker-container", "acct:docker-container:abcdef012345", "acct");
    expect(docker.command).toHaveBeenCalledWith("removeContainer", { id: "abcdef012345" });
  });

  it("removes images, volumes, and networks with decoded ids", async () => {
    const { services, docker } = makeServices(() => ({ ok: true }));
    const client = new DockerClient({ dockerHost: "" }, services);

    await client.deleteResource(
      "docker-image",
      "acct:docker-image:sha256%3Aabcdef0123456789",
      "acct",
    );
    await client.deleteResource("docker-volume", "acct:docker-volume:app-data", "acct");
    await client.deleteResource(
      "docker-network",
      "acct:docker-network:networkabcdef0123456789",
      "acct",
    );

    expect(docker.command).toHaveBeenCalledWith("removeImage", { id: "sha256:abcdef0123456789" });
    expect(docker.command).toHaveBeenCalledWith("removeVolume", { name: "app-data" });
    expect(docker.command).toHaveBeenCalledWith("removeNetwork", {
      id: "networkabcdef0123456789",
    });
  });

  it("throws for unsupported types", async () => {
    const client = new DockerClient({ dockerHost: "" });
    await expect(client.deleteResource("widget", "x", "a")).rejects.toThrow(/not supported/);
  });

  it("throws when no docker service available", async () => {
    const client = new DockerClient({ dockerHost: "" });
    await expect(client.deleteResource("docker-container", "a:b:c", "a")).rejects.toThrow(
      /not available/,
    );
  });
});

describe("DockerClient.fetchDashboardStats", () => {
  it("returns per-container stats from the resource fields", async () => {
    const { services } = makeServices(() => [sampleContainer]);
    const client = new DockerClient({ dockerHost: "" }, services);
    const stats = await client.fetchDashboardStats(
      "docker-container",
      "acct:docker-container:abcdef012345",
      "acct",
    );
    expect(stats).toEqual([
      { label: "Status", value: "Up 3 hours", variant: "status-healthy" },
      { label: "Image", value: "nginx:latest" },
      { label: "Ports", value: "8080->80/tcp" },
    ]);
  });

  it("marks exited containers as error variant", async () => {
    const exited = { ...sampleContainer, Status: "Exited (0)", State: "exited", Ports: [] };
    const { services } = makeServices(() => [exited]);
    const client = new DockerClient({ dockerHost: "" }, services);
    const stats = await client.fetchDashboardStats(
      "docker-container",
      "acct:docker-container:abcdef012345",
      "acct",
    );
    expect(stats[0]).toEqual({
      label: "Status",
      value: "Exited (0)",
      variant: "status-error",
    });
    // Status + Image (ports empty so omitted)
    expect(stats).toEqual([
      { label: "Status", value: "Exited (0)", variant: "status-error" },
      { label: "Image", value: "nginx:latest" },
    ]);
  });

  it("returns empty array when the per-container resource lookup fails", async () => {
    const { services } = makeServices(() => []);
    const client = new DockerClient({ dockerHost: "" }, services);
    const stats = await client.fetchDashboardStats("docker-container", "missing", "acct");
    expect(stats).toEqual([]);
  });

  it("returns account-level version + running count for non-container type", async () => {
    const { services } = makeServices((op) => {
      if (op === "version") return { Version: "24.0.7" };
      if (op === "listContainers")
        return [
          { ...sampleContainer, State: "running" },
          { ...sampleContainer, State: "exited" },
          { ...sampleContainer, State: "running" },
        ];
      return [];
    });
    const client = new DockerClient({ dockerHost: "" }, services);
    const stats = await client.fetchDashboardStats("account", "acct", "acct");
    expect(stats).toEqual([
      { label: "Version", value: "24.0.7" },
      { label: "Running", value: "2" },
    ]);
  });

  it("returns empty array when no docker service for account-level stats", async () => {
    const client = new DockerClient({ dockerHost: "" });
    expect(await client.fetchDashboardStats("account", "acct", "acct")).toEqual([]);
  });

  it("returns empty array when account-level docker commands throw", async () => {
    const { services } = makeServices((op) => {
      if (op === "version") throw new Error("daemon down");
      return [];
    });
    const client = new DockerClient({ dockerHost: "" }, services);
    expect(await client.fetchDashboardStats("account", "acct", "acct")).toEqual([]);
  });
});
