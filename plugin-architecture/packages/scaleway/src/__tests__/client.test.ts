import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock the Scaleway SDK clients ───────────────────────────────────────────
// Each SDK exposes a namespace (e.g. `Instancev1`) whose `.API` is a class
// constructed with the shared client. We replace each `.API` with a stub class
// that delegates to per-test method spies stored on module-level objects.

const { sdkMocks, instanceMethods, k8sMethods, rdbMethods, blockMethods, s3Mocks } = vi.hoisted(
  () => ({
    sdkMocks: {
      createClient: vi.fn(() => ({ __fakeClient: true })),
      createAdvancedClient: vi.fn(() => ({ __fakeClient: true })),
      withHTTPClient: vi.fn((httpClient: typeof fetch) => (settings: Record<string, unknown>) => ({
        ...settings,
        httpClient,
      })),
      withProfile: vi.fn(
        (profile: Record<string, unknown>) => (settings: Record<string, unknown>) => ({
          ...settings,
          ...profile,
        }),
      ),
    },
    instanceMethods: {
      listServers: vi.fn(),
      listServersTypes: vi.fn(),
      listImages: vi.fn(),
      createServer: vi.fn(),
      serverAction: vi.fn(),
      attachVolume: vi.fn(),
    },
    k8sMethods: {
      listClusters: vi.fn(),
      listPools: vi.fn(),
      listVersions: vi.fn(),
      createCluster: vi.fn(),
      deleteCluster: vi.fn(),
      getClusterKubeConfig: vi.fn(),
    },
    rdbMethods: {
      listInstances: vi.fn(),
      getInstance: vi.fn(),
      createInstance: vi.fn(),
      deleteInstance: vi.fn(),
    },
    blockMethods: {
      listVolumes: vi.fn(),
      createVolume: vi.fn(),
      deleteVolume: vi.fn(),
    },
    s3Mocks: {
      signedS3Fetch: vi.fn(),
      listS3Objects: vi.fn(),
      uploadS3Object: vi.fn(),
      makeS3Folder: vi.fn(),
      deleteS3Object: vi.fn(),
      getS3BucketPolicy: vi.fn(),
      putS3BucketPolicy: vi.fn(),
    },
  }),
);

vi.mock("@scaleway/sdk-client", () => ({
  createClient: sdkMocks.createClient,
  createAdvancedClient: sdkMocks.createAdvancedClient,
  withHTTPClient: sdkMocks.withHTTPClient,
  withProfile: sdkMocks.withProfile,
}));
vi.mock("@scaleway/sdk-instance", () => ({
  Instancev1: {
    API: class {
      constructor() {
        return instanceMethods as any;
      }
    },
  },
}));
vi.mock("@scaleway/sdk-k8s", () => ({
  K8Sv1: {
    API: class {
      constructor() {
        return k8sMethods as any;
      }
    },
  },
}));
vi.mock("@scaleway/sdk-rdb", () => ({
  Rdbv1: {
    API: class {
      constructor() {
        return rdbMethods as any;
      }
    },
  },
}));
vi.mock("@scaleway/sdk-block", () => ({
  Blockv1: {
    API: class {
      constructor() {
        return blockMethods as any;
      }
    },
  },
}));

// ── Mock the S3 helpers from plugin-base, keeping the rest of the module ─────
vi.mock("@infrawrench/plugin-base", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@infrawrench/plugin-base")>();
  return { ...actual, ...s3Mocks };
});

import { ScalewayClient } from "../client.js";
import { plugin } from "../plugin.js";

const ACCOUNT = "acct1";
const resourceTypes = plugin.resourceTypes;
const CREDS = {
  secretKey: "sk",
  accessKey: "SCWAK",
  defaultProjectId: "proj-uuid",
};

function makeClient(creds: Record<string, string> = CREDS) {
  return new ScalewayClient(creds, resourceTypes);
}

function s3Response(status: number, text: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  } as unknown as Response;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fetchMock: any;

beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, "fetch");
  for (const m of [
    ...Object.values(sdkMocks),
    ...Object.values(instanceMethods),
    ...Object.values(k8sMethods),
    ...Object.values(rdbMethods),
    ...Object.values(blockMethods),
    ...Object.values(s3Mocks),
  ]) {
    m.mockReset();
  }
  // Default: list methods return empty so unrelated zones/regions are harmless.
  instanceMethods.listServers.mockResolvedValue({ servers: [] });
  k8sMethods.listClusters.mockResolvedValue({ clusters: [] });
  k8sMethods.listPools.mockResolvedValue({ pools: [] });
  rdbMethods.listInstances.mockResolvedValue({ instances: [] });
  blockMethods.listVolumes.mockResolvedValue({ volumes: [] });
  sdkMocks.createClient.mockReturnValue({ __fakeClient: true });
  sdkMocks.createAdvancedClient.mockReturnValue({ __fakeClient: true });
  sdkMocks.withHTTPClient.mockImplementation(
    (httpClient: typeof fetch) => (settings: Record<string, unknown>) => ({
      ...settings,
      httpClient,
    }),
  );
  sdkMocks.withProfile.mockImplementation(
    (profile: Record<string, unknown>) => (settings: Record<string, unknown>) => ({
      ...settings,
      ...profile,
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("constructor", () => {
  it("throws without secretKey", () => {
    expect(() => new ScalewayClient({}, resourceTypes)).toThrow(/missing secretKey/);
  });
  it("constructs with secretKey only", () => {
    expect(new ScalewayClient({ secretKey: "sk" }, resourceTypes)).toBeInstanceOf(ScalewayClient);
  });

  it("routes SDK calls through host HTTP services when provided by plugin factory", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: '{"ok":true}',
    }));
    const c = plugin.createClient(CREDS, { http: { request } } as any) as ScalewayClient;

    await c.listResources("instance", ACCOUNT);

    expect(sdkMocks.createAdvancedClient).toHaveBeenCalled();
    expect(sdkMocks.withHTTPClient).toHaveBeenCalled();
    const httpClient = sdkMocks.withHTTPClient.mock.calls[0]![0] as typeof fetch;
    const response = await httpClient(
      new Request("https://api.scaleway.com/instance/v1/zones/fr-par-1/servers", {
        method: "POST",
        headers: { "X-Auth-Token": "sk", "Content-Type": "application/json" },
        body: '{"name":"vm"}',
      }),
    );

    expect(request).toHaveBeenCalledWith({
      url: "https://api.scaleway.com/instance/v1/zones/fr-par-1/servers",
      method: "POST",
      headers: expect.objectContaining({
        "x-auth-token": "sk",
        "content-type": "application/json",
      }),
      body: '{"name":"vm"}',
    });
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("listResources instance", () => {
  it("maps servers across zones (one zone populated)", async () => {
    const c = makeClient();
    instanceMethods.listServers.mockImplementation(async ({ zone }: { zone: string }) => {
      if (zone === "fr-par-1")
        return {
          servers: [
            {
              id: "srv1",
              name: "web",
              commercialType: "DEV1-S",
              image: { name: "ubuntu" },
              state: "running",
              publicIp: { address: "1.2.3.4" },
              privateIp: "10.0.0.1",
              creationDate: new Date("2024-01-01T00:00:00Z"),
              modificationDate: new Date("2024-01-02T00:00:00Z"),
            },
          ],
        };
      return { servers: [] };
    });
    const res = await c.listResources("instance", ACCOUNT);
    expect(res).toHaveLength(1);
    expect(res[0]!.id).toBe(`${ACCOUNT}:instance:fr-par-1/srv1`);
    expect(res[0]!.externalId).toBe("fr-par-1/srv1");
    expect(res[0]!.fields["commercialType"]).toBe("DEV1-S");
    expect(res[0]!.resolvedOutputs).toEqual({ publicIp: "1.2.3.4", privateIp: "10.0.0.1" });
    expect(res[0]!.updatedAt).toBe(new Date("2024-01-02T00:00:00Z").toISOString());
  });

  it("maps server with missing optional fields", async () => {
    const c = makeClient();
    instanceMethods.listServers.mockImplementation(async ({ zone }: { zone: string }) =>
      zone === "fr-par-1" ? { servers: [{ id: "s2", name: "bare" }] } : { servers: [] },
    );
    const res = await c.listResources("instance", ACCOUNT);
    expect(res[0]!.fields["image"]).toBe("");
    expect(res[0]!.resolvedOutputs["publicIp"]).toBe("");
    expect(typeof res[0]!.createdAt).toBe("string");
  });

  it("ignores zones that throw", async () => {
    const c = makeClient();
    instanceMethods.listServers.mockRejectedValue(new Error("zone down"));
    const res = await c.listResources("instance", ACCOUNT);
    expect(res).toEqual([]);
  });

  it("passes project filter when defaultProjectId set", async () => {
    const c = makeClient();
    await c.listResources("instance", ACCOUNT);
    expect(instanceMethods.listServers).toHaveBeenCalledWith(
      expect.objectContaining({ project: "proj-uuid" }),
    );
  });

  it("omits project when no defaultProjectId", async () => {
    const c = makeClient({ secretKey: "sk", accessKey: "SCWAK" });
    await c.listResources("instance", ACCOUNT);
    expect(instanceMethods.listServers).toHaveBeenCalledWith(
      expect.not.objectContaining({ project: expect.anything() }),
    );
  });

  it("throws on unknown type", async () => {
    const c = makeClient();
    await expect(c.listResources("nope", ACCOUNT)).rejects.toThrow(/unknown resource type/);
  });
});

describe("listResources kapsule-cluster", () => {
  it("maps clusters and pools", async () => {
    const c = makeClient();
    k8sMethods.listClusters.mockImplementation(async ({ region }: { region: string }) =>
      region === "fr-par"
        ? {
            clusters: [
              {
                id: "cl1",
                name: "k8s",
                region: "fr-par",
                version: "1.30",
                status: "ready",
                clusterUrl: "https://k8s",
                createdAt: new Date("2024-01-01T00:00:00Z"),
                updatedAt: new Date("2024-01-02T00:00:00Z"),
              },
            ],
          }
        : { clusters: [] },
    );
    k8sMethods.listPools.mockResolvedValue({
      pools: [
        { nodeType: "DEV1-M", size: 2, rootVolumeSize: 50 * 1024 * 1024 * 1024 },
        { nodeType: "DEV1-M", size: 3 },
      ],
    });
    const res = await c.listResources("kapsule-cluster", ACCOUNT);
    expect(res[0]!.fields["nodeCount"]).toBe(5);
    expect(res[0]!.fields["nodeType"]).toBe("DEV1-M");
    expect(res[0]!.fields["diskSizeGb"]).toBe(50);
    expect(res[0]!.resolvedOutputs["clusterUrl"]).toBe("https://k8s");
  });

  it("tolerates pool listing failure", async () => {
    const c = makeClient();
    k8sMethods.listClusters.mockImplementation(async ({ region }: { region: string }) =>
      region === "fr-par" ? { clusters: [{ id: "cl1", name: "k8s" }] } : { clusters: [] },
    );
    k8sMethods.listPools.mockRejectedValue(new Error("no perm"));
    const res = await c.listResources("kapsule-cluster", ACCOUNT);
    expect(res[0]!.fields["nodeCount"]).toBe(0);
    expect(res[0]!.fields["diskSizeGb"]).toBe(0);
  });

  it("ignores regions that throw", async () => {
    const c = makeClient();
    k8sMethods.listClusters.mockRejectedValue(new Error("down"));
    expect(await c.listResources("kapsule-cluster", ACCOUNT)).toEqual([]);
  });
});

describe("listResources rdb-instance", () => {
  it("maps databases parsing engine", async () => {
    const c = makeClient();
    rdbMethods.listInstances.mockImplementation(async ({ region }: { region: string }) =>
      region === "fr-par"
        ? {
            instances: [
              {
                id: "db1",
                name: "mydb",
                engine: "PostgreSQL-16",
                region: "fr-par",
                nodeType: "DB-DEV-S",
                status: "ready",
                createdAt: new Date("2024-01-01T00:00:00Z"),
              },
              { id: "db2", name: "n", engine: "" },
            ],
          }
        : { instances: [] },
    );
    const res = await c.listResources("rdb-instance", ACCOUNT);
    expect(res[0]!.fields["engine"]).toBe("PostgreSQL");
    expect(res[0]!.fields["engineVersion"]).toBe("16");
    expect(res[1]!.fields["engine"]).toBe("");
  });
});

describe("listResources block-volume", () => {
  it("maps volumes with attachment", async () => {
    const c = makeClient();
    blockMethods.listVolumes.mockImplementation(async ({ zone }: { zone: string }) =>
      zone === "fr-par-1"
        ? {
            volumes: [
              {
                id: "v1",
                name: "data",
                size: 100 * 1_000_000_000,
                specs: { perfIops: 5000 },
                status: "available",
                references: [{ productResourceType: "instance_server", productResourceId: "srv9" }],
                createdAt: new Date("2024-01-01T00:00:00Z"),
                updatedAt: new Date("2024-01-02T00:00:00Z"),
              },
              { id: "v2", name: "", size: 10 * 1_000_000_000, references: [] },
            ],
          }
        : { volumes: [] },
    );
    const res = await c.listResources("block-volume", ACCOUNT);
    expect(res[0]!.fields["sizeGb"]).toBe(100);
    expect(res[0]!.fields["perfIops"]).toBe("5000");
    expect(res[0]!.fields["attachedInstanceId"]).toBe("srv9");
    expect(res[1]!.displayName).toBe("v2");
    expect(res[1]!.fields["attachedInstanceId"]).toBe("");
  });

  it("ignores zones that throw", async () => {
    const c = makeClient();
    blockMethods.listVolumes.mockRejectedValue(new Error("down"));
    expect(await c.listResources("block-volume", ACCOUNT)).toEqual([]);
  });
});

describe("listResources object-storage-bucket", () => {
  it("parses XML ListBuckets per region", async () => {
    const c = makeClient();
    s3Mocks.signedS3Fetch.mockImplementation(async ({ url }: { url: string }) => {
      if (url.includes("s3.fr-par.scw.cloud"))
        return s3Response(
          200,
          "<ListAllMyBucketsResult><Buckets><Bucket><Name>my-bucket</Name><CreationDate>2024-01-01T00:00:00Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>",
        );
      return s3Response(200, "<ListAllMyBucketsResult></ListAllMyBucketsResult>");
    });
    const res = await c.listResources("object-storage-bucket", ACCOUNT);
    expect(res).toHaveLength(1);
    expect(res[0]!.displayName).toBe("my-bucket");
    expect(res[0]!.externalId).toBe("fr-par/my-bucket");
    expect(res[0]!.resolvedOutputs["endpoint"]).toBe("https://s3.fr-par.scw.cloud");
  });

  it("skips region on S3 error", async () => {
    const c = makeClient();
    s3Mocks.signedS3Fetch.mockResolvedValue(s3Response(403, "denied"));
    expect(await c.listResources("object-storage-bucket", ACCOUNT)).toEqual([]);
  });

  it("throws when S3 credentials missing (no accessKey)", async () => {
    const c = makeClient({ secretKey: "sk" });
    // objectStorageFetch asserts credentials; the per-region try/catch swallows
    // it, so the result is just empty.
    expect(await c.listResources("object-storage-bucket", ACCOUNT)).toEqual([]);
  });
});

describe("getResource", () => {
  it("throws when not found", async () => {
    const c = makeClient();
    await expect(c.getResource("instance", `${ACCOUNT}:instance:x/y`, ACCOUNT)).rejects.toThrow(
      /not found/,
    );
  });
});

describe("resolveOutput", () => {
  it("kapsule kubeconfig decodes base64 content", async () => {
    const c = makeClient();
    const content = btoa("apiVersion: v1");
    k8sMethods.getClusterKubeConfig.mockResolvedValue({
      text: async () => JSON.stringify({ content }),
    });
    const out = await c.resolveOutput(
      "kapsule-cluster",
      `${ACCOUNT}:kapsule-cluster:fr-par/cl1`,
      "kubeconfig",
      ACCOUNT,
    );
    expect(out).toBe("apiVersion: v1");
    expect(k8sMethods.getClusterKubeConfig).toHaveBeenCalledWith({
      region: "fr-par",
      clusterId: "cl1",
    });
  });

  it("kapsule kubeconfig returns plain yaml when not JSON", async () => {
    const c = makeClient();
    k8sMethods.getClusterKubeConfig.mockResolvedValue({ text: async () => "raw: yaml" });
    const out = await c.resolveOutput(
      "kapsule-cluster",
      `${ACCOUNT}:kapsule-cluster:fr-par/cl1`,
      "kubeconfig",
      ACCOUNT,
    );
    expect(out).toBe("raw: yaml");
  });

  it("kapsule kubeconfig returns empty when content not string", async () => {
    const c = makeClient();
    k8sMethods.getClusterKubeConfig.mockResolvedValue({
      text: async () => JSON.stringify({ other: 1 }),
    });
    const out = await c.resolveOutput(
      "kapsule-cluster",
      `${ACCOUNT}:kapsule-cluster:fr-par/cl1`,
      "kubeconfig",
      ACCOUNT,
    );
    expect(out).toBe("");
  });

  it("rdb host/port/username/password/dbName", async () => {
    const c = makeClient();
    rdbMethods.getInstance.mockResolvedValue({
      endpoints: [{ ip: "5.6.7.8", port: 5432 }],
    });
    const id = `${ACCOUNT}:rdb-instance:fr-par/db1`;
    expect(await c.resolveOutput("rdb-instance", id, "host", ACCOUNT)).toBe("5.6.7.8");
    expect(await c.resolveOutput("rdb-instance", id, "port", ACCOUNT)).toBe("5432");
    expect(await c.resolveOutput("rdb-instance", id, "username", ACCOUNT)).toBe("");
    expect(await c.resolveOutput("rdb-instance", id, "password", ACCOUNT)).toBe("");
    expect(await c.resolveOutput("rdb-instance", id, "dbName", ACCOUNT)).toBe("rdb");
  });

  it("rdb host falls back to hostname", async () => {
    const c = makeClient();
    rdbMethods.getInstance.mockResolvedValue({ endpoints: [{ hostname: "h.scw" }] });
    expect(
      await c.resolveOutput("rdb-instance", `${ACCOUNT}:rdb-instance:fr-par/db1`, "host", ACCOUNT),
    ).toBe("h.scw");
  });

  it("rdb unknown output falls through to error", async () => {
    const c = makeClient();
    rdbMethods.getInstance.mockResolvedValue({ endpoints: [] });
    await expect(
      c.resolveOutput("rdb-instance", `${ACCOUNT}:rdb-instance:fr-par/db1`, "zzz", ACCOUNT),
    ).rejects.toThrow(/cannot resolve output/);
  });

  it("object storage endpoint/accessKeyId/secretAccessKey", async () => {
    const c = makeClient();
    s3Mocks.signedS3Fetch.mockImplementation(async ({ url }: { url: string }) =>
      url.includes("s3.fr-par.scw.cloud")
        ? s3Response(
            200,
            "<r><Bucket><Name>b</Name><CreationDate>2024-01-01T00:00:00Z</CreationDate></Bucket></r>",
          )
        : s3Response(200, "<r></r>"),
    );
    const id = `${ACCOUNT}:object-storage-bucket:fr-par/b`;
    expect(await c.resolveOutput("object-storage-bucket", id, "endpoint", ACCOUNT)).toBe(
      "https://s3.fr-par.scw.cloud",
    );
    expect(await c.resolveOutput("object-storage-bucket", id, "accessKeyId", ACCOUNT)).toBe(
      "SCWAK",
    );
    expect(await c.resolveOutput("object-storage-bucket", id, "secretAccessKey", ACCOUNT)).toBe(
      "sk",
    );
  });

  it("throws for unsupported type", async () => {
    const c = makeClient();
    await expect(
      c.resolveOutput("block-volume", `${ACCOUNT}:block-volume:fr-par-1/v1`, "x", ACCOUNT),
    ).rejects.toThrow(/cannot resolve output/);
  });
});

describe("getCreateConfig", () => {
  it("instance config from SDK sizes/images", async () => {
    const c = makeClient();
    instanceMethods.listServersTypes.mockResolvedValue({
      servers: {
        "DEV1-S": { ncpus: 2, ram: 2 * 1024 * 1024 * 1024, monthlyPrice: 7.99 },
        "GP1-XS": { ncpus: 4, ram: 16 * 1024 * 1024 * 1024, hourlyPrice: 0.1 },
      },
    });
    instanceMethods.listImages.mockResolvedValue({
      images: [
        { id: "img1", name: "Ubuntu 24.04", arch: "x86_64" },
        { id: "img2", name: "Arm thing", arch: "arm64" },
      ],
    });
    const cfg = await c.getCreateConfig("instance");
    const size = cfg.fields.find((f) => f.key === "commercialType") as any;
    expect(size.sizes.find((s: any) => s.id === "DEV1-S").priceMonthly).toBe(7.99);
    expect(size.sizes.find((s: any) => s.id === "GP1-XS").priceMonthly).toBe(73);
    const image = cfg.fields.find((f) => f.key === "image") as any;
    expect(image.images.map((i: any) => i.id)).toEqual(["img1"]);
    expect(image.defaultValue).toBe("img1");
  });

  it("instance config falls back when SDK throws", async () => {
    const c = makeClient();
    instanceMethods.listServersTypes.mockRejectedValue(new Error("x"));
    instanceMethods.listImages.mockRejectedValue(new Error("x"));
    const cfg = await c.getCreateConfig("instance");
    const size = cfg.fields.find((f) => f.key === "commercialType") as any;
    expect(size.sizes[0].id).toBe("DEV1-S");
    const image = cfg.fields.find((f) => f.key === "image") as any;
    expect(image.defaultValue).toBe("ubuntu_jammy");
  });

  it("kapsule config from SDK", async () => {
    const c = makeClient();
    k8sMethods.listVersions.mockResolvedValue({ versions: [{ name: "1.30.2" }] });
    instanceMethods.listServersTypes.mockResolvedValue({
      servers: { "DEV1-M": { ncpus: 3, ram: 4 * 1024 * 1024 * 1024 } },
    });
    const cfg = await c.getCreateConfig("kapsule-cluster");
    const ver = cfg.fields.find((f) => f.key === "version") as any;
    expect(ver.options[0].id).toBe("1.30.2");
  });

  it("kapsule config fallbacks when SDK throws", async () => {
    const c = makeClient();
    k8sMethods.listVersions.mockRejectedValue(new Error("x"));
    instanceMethods.listServersTypes.mockRejectedValue(new Error("x"));
    const cfg = await c.getCreateConfig("kapsule-cluster");
    const ver = cfg.fields.find((f) => f.key === "version") as any;
    expect(ver.options[0].id).toBe("1.30.2");
    const size = cfg.fields.find((f) => f.key === "nodeType") as any;
    expect(size.sizes[0].id).toBe("DEV1-M");
  });

  it("rdb config static", async () => {
    const c = makeClient();
    const cfg = await c.getCreateConfig("rdb-instance");
    expect(cfg.fields.map((f) => f.key)).toContain("engine");
  });

  it("object-storage config static", async () => {
    const c = makeClient();
    const cfg = await c.getCreateConfig("object-storage-bucket");
    expect(cfg.fields.map((f) => f.key)).toContain("region");
  });

  it("block-volume config static", async () => {
    const c = makeClient();
    const cfg = await c.getCreateConfig("block-volume");
    expect(cfg.fields.map((f) => f.key)).toContain("sizeGb");
  });

  it("throws for unknown type", async () => {
    const c = makeClient();
    await expect(c.getCreateConfig("nope")).rejects.toThrow(/No create config/);
  });
});

describe("createResource", () => {
  it("creates instance and powers on", async () => {
    const c = makeClient();
    instanceMethods.createServer.mockResolvedValue({
      server: {
        id: "srv9",
        name: "new",
        commercialType: "DEV1-S",
        image: { name: "ubuntu" },
        state: "stopped",
        publicIp: { address: "9.9.9.9" },
        creationDate: new Date("2024-01-01T00:00:00Z"),
      },
    });
    instanceMethods.serverAction.mockResolvedValue({});
    const r = await c.createResource("instance", ACCOUNT, {
      name: "new",
      zone: "fr-par-1",
      commercialType: "DEV1-S",
      image: "ubuntu",
    });
    expect(r.externalId).toBe("fr-par-1/srv9");
    expect(r.resolvedOutputs["publicIp"]).toBe("9.9.9.9");
    expect(instanceMethods.serverAction).toHaveBeenCalledWith({
      zone: "fr-par-1",
      serverId: "srv9",
      action: "poweron",
    });
  });

  it("instance create tolerates poweron failure", async () => {
    const c = makeClient();
    instanceMethods.createServer.mockResolvedValue({
      server: { id: "srv10", name: "n", state: undefined },
    });
    instanceMethods.serverAction.mockRejectedValue(new Error("boot fail"));
    const r = await c.createResource("instance", ACCOUNT, { zone: "fr-par-1", name: "n" });
    expect(r.fields["state"]).toBe("starting");
  });

  it("instance create throws when no server returned", async () => {
    const c = makeClient();
    instanceMethods.createServer.mockResolvedValue({ server: undefined });
    await expect(
      c.createResource("instance", ACCOUNT, { zone: "fr-par-1", name: "n" }),
    ).rejects.toThrow(/returned no server/);
  });

  it("creates kapsule cluster", async () => {
    const c = makeClient();
    k8sMethods.createCluster.mockResolvedValue({
      id: "cl9",
      name: "k8s",
      version: "1.30.2",
      status: "creating",
      clusterUrl: "https://k",
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const r = await c.createResource("kapsule-cluster", ACCOUNT, {
      name: "k8s",
      region: "fr-par",
      version: "1.30.2",
      nodeType: "DEV1-M",
      nodeCount: "4",
    });
    expect(r.externalId).toBe("fr-par/cl9");
    expect(r.fields["nodeCount"]).toBe(4);
    const arg = (k8sMethods.createCluster.mock.calls as unknown as [unknown[]])[0]![0] as any;
    expect(arg.pools[0].size).toBe(4);
    expect(arg.pools[0].zone).toBe("fr-par-1");
  });

  it("kapsule create defaults invalid node count to 3", async () => {
    const c = makeClient();
    k8sMethods.createCluster.mockResolvedValue({ id: "cl10" });
    const r = await c.createResource("kapsule-cluster", ACCOUNT, {
      region: "fr-par",
      nodeCount: "x",
    });
    expect(r.fields["nodeCount"]).toBe(3);
  });

  it("creates rdb instance", async () => {
    const c = makeClient();
    rdbMethods.createInstance.mockResolvedValue({
      id: "db9",
      name: "mydb",
      status: "provisioning",
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const r = await c.createResource("rdb-instance", ACCOUNT, {
      name: "mydb",
      region: "fr-par",
      engine: "PostgreSQL-16",
      nodeType: "DB-DEV-S",
      isHaCluster: "true",
      disableBackup: "true",
      userName: "admin",
      password: "secret",
    });
    expect(r.externalId).toBe("fr-par/db9");
    expect(r.fields["engine"]).toBe("PostgreSQL");
    expect(r.fields["engineVersion"]).toBe("16");
    const arg = (rdbMethods.createInstance.mock.calls as unknown as [unknown[]])[0]![0] as any;
    expect(arg.isHaCluster).toBe(true);
    expect(arg.disableBackup).toBe(true);
  });

  it("rdb create handles missing createdAt", async () => {
    const c = makeClient();
    rdbMethods.createInstance.mockResolvedValue({ id: "db10", name: "n" });
    const r = await c.createResource("rdb-instance", ACCOUNT, { name: "n", engine: "MySQL-8" });
    expect(r.fields["engine"]).toBe("MySQL");
    expect(typeof r.createdAt).toBe("string");
  });

  it("creates object-storage bucket via S3 PUT", async () => {
    const c = makeClient();
    s3Mocks.signedS3Fetch.mockResolvedValue(s3Response(200, ""));
    const r = await c.createResource("object-storage-bucket", ACCOUNT, {
      name: "b",
      region: "fr-par",
    });
    expect(r.externalId).toBe("fr-par/b");
    const arg = (s3Mocks.signedS3Fetch.mock.calls as unknown as [unknown[]])[0]![0] as any;
    expect(arg.method).toBe("PUT");
    expect(arg.url).toBe("https://b.s3.fr-par.scw.cloud/");
  });

  it("creates block volume", async () => {
    const c = makeClient();
    blockMethods.createVolume.mockResolvedValue({
      id: "v9",
      name: "data",
      size: 100 * 1_000_000_000,
      status: "creating",
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const r = await c.createResource("block-volume", ACCOUNT, {
      name: "data",
      zone: "fr-par-1",
      sizeGb: "100",
      perfIops: "15000",
    });
    expect(r.externalId).toBe("fr-par-1/v9");
    expect(r.fields["sizeGb"]).toBe(100);
    expect(r.fields["perfIops"]).toBe("15000");
    const arg = (blockMethods.createVolume.mock.calls as unknown as [unknown[]])[0]![0] as any;
    expect(arg.fromEmpty.size).toBe(100 * 1_000_000_000);
    expect(arg.projectId).toBe("proj-uuid");
  });

  it("block volume create handles missing createdAt/name", async () => {
    const c = makeClient();
    blockMethods.createVolume.mockResolvedValue({ id: "v10", size: 10 * 1_000_000_000 });
    const r = await c.createResource("block-volume", ACCOUNT, { zone: "fr-par-1" });
    expect(r.displayName).toBe("v10");
    expect(r.fields["status"]).toBe("creating");
  });

  it("throws for unsupported create type", async () => {
    const c = makeClient();
    await expect(c.createResource("nope", ACCOUNT, {})).rejects.toThrow(/not supported/);
  });
});

describe("deleteResource", () => {
  it("terminates instance", async () => {
    const c = makeClient();
    instanceMethods.serverAction.mockResolvedValue({});
    await c.deleteResource("instance", `${ACCOUNT}:instance:fr-par-1/srv1`, ACCOUNT);
    expect(instanceMethods.serverAction).toHaveBeenCalledWith({
      zone: "fr-par-1",
      serverId: "srv1",
      action: "terminate",
    });
  });

  it("deletes kapsule cluster", async () => {
    const c = makeClient();
    k8sMethods.deleteCluster.mockResolvedValue({});
    await c.deleteResource("kapsule-cluster", `${ACCOUNT}:kapsule-cluster:fr-par/cl1`, ACCOUNT);
    expect(k8sMethods.deleteCluster).toHaveBeenCalledWith({
      region: "fr-par",
      clusterId: "cl1",
      withAdditionalResources: true,
    });
  });

  it("deletes rdb instance", async () => {
    const c = makeClient();
    rdbMethods.deleteInstance.mockResolvedValue({});
    await c.deleteResource("rdb-instance", `${ACCOUNT}:rdb-instance:fr-par/db1`, ACCOUNT);
    expect(rdbMethods.deleteInstance).toHaveBeenCalledWith({
      region: "fr-par",
      instanceId: "db1",
    });
  });

  it("deletes object storage bucket via S3", async () => {
    const c = makeClient();
    s3Mocks.signedS3Fetch.mockResolvedValue(s3Response(204, ""));
    await c.deleteResource(
      "object-storage-bucket",
      `${ACCOUNT}:object-storage-bucket:fr-par/b`,
      ACCOUNT,
    );
    const arg = (s3Mocks.signedS3Fetch.mock.calls as unknown as [unknown[]])[0]![0] as any;
    expect(arg.method).toBe("DELETE");
    expect(arg.url).toBe("https://b.s3.fr-par.scw.cloud/");
  });

  it("deletes block volume", async () => {
    const c = makeClient();
    blockMethods.deleteVolume.mockResolvedValue({});
    await c.deleteResource("block-volume", `${ACCOUNT}:block-volume:fr-par-1/v1`, ACCOUNT);
    expect(blockMethods.deleteVolume).toHaveBeenCalledWith({ zone: "fr-par-1", volumeId: "v1" });
  });

  it("throws for unsupported type", async () => {
    const c = makeClient();
    await expect(c.deleteResource("nope", `${ACCOUNT}:nope:x`, ACCOUNT)).rejects.toThrow(
      /not supported/,
    );
  });
});

describe("attachResource", () => {
  function volList() {
    blockMethods.listVolumes.mockImplementation(async ({ zone }: { zone: string }) =>
      zone === "fr-par-1"
        ? { volumes: [{ id: "v1", name: "v", size: 10 * 1_000_000_000, references: [] }] }
        : { volumes: [] },
    );
  }
  function instList(zone: string) {
    instanceMethods.listServers.mockImplementation(async ({ zone: z }: { zone: string }) =>
      z === zone ? { servers: [{ id: "srv1", name: "s", state: "running" }] } : { servers: [] },
    );
  }

  it("attaches block volume to instance same zone", async () => {
    const c = makeClient();
    volList();
    instList("fr-par-1");
    instanceMethods.attachVolume.mockResolvedValue({});
    await c.attachResource(
      "block-volume",
      `${ACCOUNT}:block-volume:fr-par-1/v1`,
      "instance",
      `${ACCOUNT}:instance:fr-par-1/srv1`,
      ACCOUNT,
    );
    expect(instanceMethods.attachVolume).toHaveBeenCalledWith({
      zone: "fr-par-1",
      serverId: "srv1",
      volumeId: "v1",
    });
  });

  it("rejects when zones differ", async () => {
    const c = makeClient();
    volList();
    instList("fr-par-2");
    await expect(
      c.attachResource(
        "block-volume",
        `${ACCOUNT}:block-volume:fr-par-1/v1`,
        "instance",
        `${ACCOUNT}:instance:fr-par-2/srv1`,
        ACCOUNT,
      ),
    ).rejects.toThrow(/does not match instance zone/);
  });

  it("throws for unsupported combo", async () => {
    const c = makeClient();
    await expect(c.attachResource("instance", "a", "block-volume", "b", ACCOUNT)).rejects.toThrow(
      /not supported/,
    );
  });
});

describe("fetchDashboardStats", () => {
  it("instance stats with public ip", async () => {
    const c = makeClient();
    instanceMethods.listServers.mockImplementation(async ({ zone }: { zone: string }) =>
      zone === "fr-par-1"
        ? {
            servers: [
              {
                id: "srv1",
                name: "s",
                commercialType: "DEV1-S",
                state: "running",
                publicIp: { address: "1.1.1.1" },
              },
            ],
          }
        : { servers: [] },
    );
    const stats = await c.fetchDashboardStats(
      "instance",
      `${ACCOUNT}:instance:fr-par-1/srv1`,
      ACCOUNT,
    );
    expect(stats[0]).toMatchObject({ label: "State", variant: "status-healthy" });
    expect(stats.find((s) => s.label === "Public IP")?.value).toBe("1.1.1.1");
  });

  it("instance stopped state -> error", async () => {
    const c = makeClient();
    instanceMethods.listServers.mockImplementation(async ({ zone }: { zone: string }) =>
      zone === "fr-par-1"
        ? { servers: [{ id: "srv1", name: "s", state: "stopped" }] }
        : { servers: [] },
    );
    const stats = await c.fetchDashboardStats(
      "instance",
      `${ACCOUNT}:instance:fr-par-1/srv1`,
      ACCOUNT,
    );
    expect(stats[0]!.variant).toBe("status-error");
  });

  it("instance other state -> degraded", async () => {
    const c = makeClient();
    instanceMethods.listServers.mockImplementation(async ({ zone }: { zone: string }) =>
      zone === "fr-par-1"
        ? { servers: [{ id: "srv1", name: "s", state: "starting" }] }
        : { servers: [] },
    );
    const stats = await c.fetchDashboardStats(
      "instance",
      `${ACCOUNT}:instance:fr-par-1/srv1`,
      ACCOUNT,
    );
    expect(stats[0]!.variant).toBe("status-degraded");
  });

  it("kapsule stats", async () => {
    const c = makeClient();
    k8sMethods.listClusters.mockImplementation(async ({ region }: { region: string }) =>
      region === "fr-par"
        ? { clusters: [{ id: "cl1", name: "k", status: "ready", version: "1.30" }] }
        : { clusters: [] },
    );
    const stats = await c.fetchDashboardStats(
      "kapsule-cluster",
      `${ACCOUNT}:kapsule-cluster:fr-par/cl1`,
      ACCOUNT,
    );
    expect(stats[0]!.variant).toBe("status-healthy");
  });

  it("rdb stats degraded", async () => {
    const c = makeClient();
    rdbMethods.listInstances.mockImplementation(async ({ region }: { region: string }) =>
      region === "fr-par"
        ? {
            instances: [
              {
                id: "db1",
                name: "d",
                engine: "PostgreSQL-16",
                status: "provisioning",
                nodeType: "DB-DEV-S",
              },
            ],
          }
        : { instances: [] },
    );
    const stats = await c.fetchDashboardStats(
      "rdb-instance",
      `${ACCOUNT}:rdb-instance:fr-par/db1`,
      ACCOUNT,
    );
    expect(stats[0]!.variant).toBe("status-degraded");
  });

  it("object-storage stats", async () => {
    const c = makeClient();
    s3Mocks.signedS3Fetch.mockImplementation(async ({ url }: { url: string }) =>
      url.includes("s3.fr-par.scw.cloud")
        ? s3Response(
            200,
            "<r><Bucket><Name>b</Name><CreationDate>2024-01-01T00:00:00Z</CreationDate></Bucket></r>",
          )
        : s3Response(200, "<r></r>"),
    );
    const stats = await c.fetchDashboardStats(
      "object-storage-bucket",
      `${ACCOUNT}:object-storage-bucket:fr-par/b`,
      ACCOUNT,
    );
    expect(stats[0]).toMatchObject({ label: "Name", value: "b" });
  });

  it("block-volume returns [] (no branch)", async () => {
    const c = makeClient();
    blockMethods.listVolumes.mockImplementation(async ({ zone }: { zone: string }) =>
      zone === "fr-par-1"
        ? { volumes: [{ id: "v1", name: "v", size: 10 * 1_000_000_000, references: [] }] }
        : { volumes: [] },
    );
    expect(
      await c.fetchDashboardStats("block-volume", `${ACCOUNT}:block-volume:fr-par-1/v1`, ACCOUNT),
    ).toEqual([]);
  });
});

describe("fetchMetricSeries", () => {
  it("returns [] without cockpit token", async () => {
    const c = makeClient();
    expect(
      await c.fetchMetricSeries("instance", `${ACCOUNT}:instance:fr-par-1/srv1`, ACCOUNT),
    ).toEqual([]);
  });

  it("returns [] for kapsule even with token", async () => {
    const c = makeClient({ ...CREDS, cockpitQueryToken: "tok" });
    expect(
      await c.fetchMetricSeries(
        "kapsule-cluster",
        `${ACCOUNT}:kapsule-cluster:fr-par/cl1`,
        ACCOUNT,
      ),
    ).toEqual([]);
  });

  it("returns [] for instance with malformed id", async () => {
    const c = makeClient({ ...CREDS, cockpitQueryToken: "tok" });
    expect(await c.fetchMetricSeries("instance", `${ACCOUNT}:instance:onlyzone`, ACCOUNT)).toEqual(
      [],
    );
  });

  it("returns [] when no cockpit data source", async () => {
    const c = makeClient({ ...CREDS, cockpitQueryToken: "tok" });
    fetchMock.mockResolvedValue(s3Response(404, "") as any);
    expect(
      await c.fetchMetricSeries("instance", `${ACCOUNT}:instance:fr-par-1/srv1`, ACCOUNT),
    ).toEqual([]);
  });

  it("queries cockpit and maps series", async () => {
    const c = makeClient({ ...CREDS, cockpitQueryToken: "tok" });
    (fetchMock as any).mockImplementation(
      async (url: string | URL | Request, _init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/data-sources")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data_sources: [{ url: "https://cockpit" }] }),
            text: async () => "",
          } as unknown as Response;
        }
        if (u.includes("/query_range")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              status: "success",
              data: { result: [{ values: [[1700000000, "12.5"]] }] },
            }),
            text: async () => "",
          } as unknown as Response;
        }
        return s3Response(404, "") as any;
      },
    );
    const series = await c.fetchMetricSeries(
      "instance",
      `${ACCOUNT}:instance:fr-par-1/srv1`,
      ACCOUNT,
      { startMs: 1000, endMs: 2000 },
    );
    expect(series.length).toBe(3);
    expect(series[0]!.points[0]).toEqual({ timestamp: 1700000000000, value: 12.5 });
  });

  it("queries cockpit through host HTTP services when provided", async () => {
    const request = vi.fn(async ({ url }: { url: string }) => {
      if (url.includes("/data-sources")) {
        return {
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data_sources: [{ url: "https://cockpit" }] }),
        };
      }
      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "success",
          data: { result: [{ values: [[1700000000, "7"]] }] },
        }),
      };
    });
    const c = plugin.createClient({ ...CREDS, cockpitQueryToken: "tok" }, {
      http: { request },
    } as any) as ScalewayClient;

    const series = await c.fetchMetricSeries(
      "instance",
      `${ACCOUNT}:instance:fr-par-1/srv1`,
      ACCOUNT,
    );

    expect(series).toHaveLength(3);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining("/cockpit/v1/regions/fr-par/data-sources"),
        method: "GET",
        headers: expect.objectContaining({ "X-Auth-Token": "sk" }),
      }),
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://cockpit/prometheus/api/v1/query_range",
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer tok",
          "Content-Type": "application/x-www-form-urlencoded",
        }),
        body: expect.stringContaining("query="),
      }),
    );
  });

  it("data source cache + query failure returns []", async () => {
    const c = makeClient({ ...CREDS, cockpitQueryToken: "tok" });
    let dsCalls = 0;
    (fetchMock as any).mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/data-sources")) {
        dsCalls++;
        return {
          ok: true,
          status: 200,
          json: async () => ({ data_sources: [{ url: "https://cockpit" }] }),
          text: async () => "",
        } as unknown as Response;
      }
      if (u.includes("/query_range")) return s3Response(500, "") as any;
      return s3Response(404, "") as any;
    });
    const id = `${ACCOUNT}:instance:fr-par-1/srv1`;
    expect(await c.fetchMetricSeries("instance", id, ACCOUNT)).toEqual([]);
    // second call reuses the cached data source
    await c.fetchMetricSeries("instance", id, ACCOUNT);
    expect(dsCalls).toBe(1);
  });

  it("returns [] when data source request throws", async () => {
    const c = makeClient({ ...CREDS, cockpitQueryToken: "tok" });
    fetchMock.mockRejectedValue(new Error("net"));
    expect(
      await c.fetchMetricSeries("instance", `${ACCOUNT}:instance:fr-par-1/srv1`, ACCOUNT),
    ).toEqual([]);
  });

  it("returns [] for unhandled resource type", async () => {
    const c = makeClient({ ...CREDS, cockpitQueryToken: "tok" });
    expect(
      await c.fetchMetricSeries("rdb-instance", `${ACCOUNT}:rdb-instance:fr-par/db1`, ACCOUNT),
    ).toEqual([]);
  });
});

describe("renderDetail / renderSidebarItem", () => {
  function res(typeId: string, fields: Record<string, unknown>) {
    return {
      id: `${ACCOUNT}:${typeId}:x`,
      pluginId: "scaleway",
      resourceTypeId: typeId,
      accountId: ACCOUNT,
      displayName: "thing",
      fields,
      resolvedOutputs: {},
      secretStates: [],
      externalId: "x",
      createdAt: "x",
      updatedAt: "x",
    } as any;
  }

  it("renderDetail status branches", () => {
    const c = makeClient();
    expect(c.renderDetail(res("instance", { state: "running" })).status?.status).toBe("healthy");
    expect(c.renderDetail(res("instance", { state: "starting" })).status?.status).toBe(
      "provisioning",
    );
    expect(c.renderDetail(res("instance", { state: "stopped" })).status?.status).toBe("error");
    expect(c.renderDetail(res("instance", { state: "weird" })).status?.status).toBe("info");
    expect(c.renderDetail(res("rdb-instance", { status: "ready" })).status?.status).toBe("healthy");
  });

  it("renderDetail object storage attaches browser + drops status", () => {
    const c = makeClient();
    const d = c.renderDetail(res("object-storage-bucket", { name: "mybucket", region: "fr-par" }));
    expect(d.status).toBeUndefined();
    expect(d.storageBrowser).toEqual({ bucketName: "mybucket" });
    expect(d.bucketPolicyEditor?.vendor).toBe("scaleway-os");
  });

  it("renderDetail object storage without name keeps no browser", () => {
    const c = makeClient();
    const d = c.renderDetail(res("object-storage-bucket", { name: "", region: "fr-par" }));
    expect(d.storageBrowser).toBeUndefined();
  });

  it("renderSidebarItem branches", () => {
    const c = makeClient();
    expect(c.renderSidebarItem(res("instance", { state: "running" })).status!.status).toBe(
      "healthy",
    );
    expect(c.renderSidebarItem(res("instance", { state: "starting" })).status!.status).toBe(
      "provisioning",
    );
    expect(c.renderSidebarItem(res("instance", { state: "error" })).status!.status).toBe("error");
    expect(c.renderSidebarItem(res("instance", { state: "?" })).status!.status).toBe("info");
  });
});

describe("storage browser verbs", () => {
  it("listStorageObjects delegates after region probe", async () => {
    const c = makeClient();
    s3Mocks.signedS3Fetch.mockResolvedValue(s3Response(200, ""));
    s3Mocks.listS3Objects.mockResolvedValue([{ key: "a", size: 1 }] as any);
    const out = await c.listStorageObjects("mybucket", "prefix/");
    expect(out).toEqual([{ key: "a", size: 1 }]);
    expect(s3Mocks.listS3Objects).toHaveBeenCalled();
    // region probe used signedS3Fetch HEAD
    expect(
      ((s3Mocks.signedS3Fetch.mock.calls as unknown as [unknown[]])[0]![0] as any).method,
    ).toBe("HEAD");
  });

  it("region probe accepts 403 as a hit", async () => {
    const c = makeClient();
    s3Mocks.signedS3Fetch.mockResolvedValue(s3Response(403, ""));
    s3Mocks.uploadS3Object.mockResolvedValue(undefined);
    await c.uploadStorageObject("mybucket", "k", new File(["x"], "x"));
    expect(s3Mocks.uploadS3Object).toHaveBeenCalled();
  });

  it("region probe tolerates throw then succeeds elsewhere", async () => {
    const c = makeClient();
    let calls = 0;
    s3Mocks.signedS3Fetch.mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error("net");
      return s3Response(200, "");
    });
    s3Mocks.makeS3Folder.mockResolvedValue(undefined);
    await c.makeStorageFolder("mybucket", "folder/");
    expect(s3Mocks.makeS3Folder).toHaveBeenCalled();
  });

  it("throws when bucket cannot be located in any region", async () => {
    const c = makeClient();
    s3Mocks.signedS3Fetch.mockResolvedValue(s3Response(404, ""));
    await expect(c.deleteStorageObject("ghost", "k")).rejects.toThrow(/could not locate/);
  });

  it("uses cached region from prior list", async () => {
    const c = makeClient();
    // Prime cache via listResources
    s3Mocks.signedS3Fetch.mockImplementation(async ({ url }: { url: string }) =>
      url.includes("s3.fr-par.scw.cloud")
        ? s3Response(
            200,
            "<r><Bucket><Name>cached</Name><CreationDate>2024-01-01T00:00:00Z</CreationDate></Bucket></r>",
          )
        : s3Response(200, "<r></r>"),
    );
    await c.listResources("object-storage-bucket", ACCOUNT);
    s3Mocks.signedS3Fetch.mockClear();
    s3Mocks.deleteS3Object.mockResolvedValue(undefined);
    await c.deleteStorageObject("cached", "k");
    // No HEAD probe needed because region is cached
    expect(s3Mocks.signedS3Fetch).not.toHaveBeenCalled();
    expect(s3Mocks.deleteS3Object).toHaveBeenCalled();
  });

  it("assertS3Credentials throws when no access key", async () => {
    const c = makeClient({ secretKey: "sk" });
    await expect(c.listStorageObjects("b", "")).rejects.toThrow(/require an Access Key/);
  });
});

describe("getManifest / applyManifest", () => {
  it("getManifest pretty-prints JSON policy", async () => {
    const c = makeClient();
    s3Mocks.signedS3Fetch.mockResolvedValue(s3Response(200, ""));
    s3Mocks.getS3BucketPolicy.mockResolvedValue('{"Version":"2012-10-17"}');
    const out = await c.getManifest(`${ACCOUNT}:object-storage-bucket:fr-par/b`, ACCOUNT);
    expect(out).toContain('"Version": "2012-10-17"');
  });

  it("getManifest returns empty when no policy", async () => {
    const c = makeClient();
    s3Mocks.signedS3Fetch.mockResolvedValue(s3Response(200, ""));
    s3Mocks.getS3BucketPolicy.mockResolvedValue("");
    expect(await c.getManifest(`${ACCOUNT}:object-storage-bucket:fr-par/b`, ACCOUNT)).toBe("");
  });

  it("getManifest returns raw when not JSON", async () => {
    const c = makeClient();
    s3Mocks.signedS3Fetch.mockResolvedValue(s3Response(200, ""));
    s3Mocks.getS3BucketPolicy.mockResolvedValue("not json");
    expect(await c.getManifest(`${ACCOUNT}:object-storage-bucket:fr-par/b`, ACCOUNT)).toBe(
      "not json",
    );
  });

  it("getManifest handles externalId without slash", async () => {
    const c = makeClient();
    s3Mocks.signedS3Fetch.mockResolvedValue(s3Response(200, ""));
    s3Mocks.getS3BucketPolicy.mockResolvedValue("");
    await c.getManifest(`${ACCOUNT}:object-storage-bucket:bareBucket`, ACCOUNT);
    // getObjectStorageConfig probed for bucket "bareBucket"
    const call = (s3Mocks.signedS3Fetch.mock.calls as unknown as [unknown[]])[0]![0] as any;
    expect(call.url).toContain("/bareBucket");
  });

  it("getManifest throws for non-bucket type", async () => {
    const c = makeClient();
    await expect(c.getManifest(`${ACCOUNT}:instance:x`, ACCOUNT)).rejects.toThrow(/not supported/);
  });

  it("applyManifest delegates to putS3BucketPolicy", async () => {
    const c = makeClient();
    s3Mocks.signedS3Fetch.mockResolvedValue(s3Response(200, ""));
    s3Mocks.putS3BucketPolicy.mockResolvedValue(undefined);
    await c.applyManifest(`${ACCOUNT}:object-storage-bucket:fr-par/b`, ACCOUNT, "{}");
    expect(s3Mocks.putS3BucketPolicy).toHaveBeenCalledWith(expect.anything(), "b", "{}");
  });

  it("applyManifest throws for non-bucket type", async () => {
    const c = makeClient();
    await expect(c.applyManifest(`${ACCOUNT}:instance:x`, ACCOUNT, "{}")).rejects.toThrow(
      /not supported/,
    );
  });
});
