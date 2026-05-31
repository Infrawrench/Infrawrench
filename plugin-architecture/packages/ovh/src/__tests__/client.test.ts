import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OvhClient } from "../client.js";
import { plugin } from "../plugin.js";

const ACCOUNT = "acct1";
const resourceTypes = plugin.resourceTypes;

const CREDS = {
  applicationKey: "ak",
  applicationSecret: "as",
  consumerKey: "ck",
  projectId: "proj123",
};

function makeClient(creds: Record<string, string> = CREDS) {
  return new OvhClient(creds, resourceTypes);
}

function okJson(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function notOk(status: number, text = "boom"): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => text,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, "fetch");
  // First call is always /auth/time inside getTimestamp; default it.
  fetchMock.mockImplementation(async (url: string | URL | Request) => {
    if (String(url).includes("/auth/time")) return okJson(1700000000);
    return okJson({});
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Return the non-/auth/time fetch calls in order. */
function apiCalls() {
  return fetchMock.mock.calls.filter((c) => !String(c[0]).includes("/auth/time"));
}
function lastApiCall() {
  const calls = apiCalls();
  return calls[calls.length - 1];
}

describe("constructor", () => {
  it.each([
    ["applicationKey", { ...CREDS, applicationKey: "" }],
    ["applicationSecret", { ...CREDS, applicationSecret: "" }],
    ["consumerKey", { ...CREDS, consumerKey: "" }],
    ["projectId", { ...CREDS, projectId: "" }],
  ])("throws when %s missing", (name, creds) => {
    expect(() => new OvhClient(creds, resourceTypes)).toThrow(new RegExp(`missing ${name}`));
  });

  it("selects endpoint url by region", async () => {
    const c = new OvhClient({ ...CREDS, endpoint: "ca" }, resourceTypes);
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).includes("/auth/time")) return okJson(1700000000);
      return okJson([]);
    });
    await c.listResources("instance", ACCOUNT);
    expect(String(lastApiCall()[0])).toContain("https://ca.api.ovh.com/1.0");
  });

  it("falls back to eu for unknown endpoint", async () => {
    const c = new OvhClient({ ...CREDS, endpoint: "zzz" }, resourceTypes);
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).includes("/auth/time")) return okJson(1700000000);
      return okJson([]);
    });
    await c.listResources("instance", ACCOUNT);
    expect(String(lastApiCall()[0])).toContain("https://eu.api.ovh.com/1.0");
  });
});

describe("auth signing / timestamp", () => {
  it("sends OVH signature headers", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).includes("/auth/time")) return okJson(1700000000);
      return okJson([]);
    });
    await c.listResources("instance", ACCOUNT);
    const headers = lastApiCall()[1].headers as Record<string, string>;
    expect(headers["X-Ovh-Application"]).toBe("ak");
    expect(headers["X-Ovh-Consumer"]).toBe("ck");
    expect(headers["X-Ovh-Signature"]).toMatch(/^\$1\$[0-9a-f]{40}$/);
    expect(headers["X-Ovh-Timestamp"]).toBeDefined();
  });

  it("recovers when /auth/time fetch fails (delta 0)", async () => {
    const c = makeClient();
    let timeCalls = 0;
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).includes("/auth/time")) {
        timeCalls++;
        throw new Error("network");
      }
      return okJson([]);
    });
    await c.listResources("instance", ACCOUNT);
    expect(timeCalls).toBe(1);
    // second call should NOT refetch time (cached delta)
    await c.listResources("instance", ACCOUNT);
    expect(timeCalls).toBe(1);
  });
});

describe("listResources instance", () => {
  it("maps instances with ip addresses", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).includes("/auth/time")) return okJson(1700000000);
      return okJson([
        {
          id: "i-1",
          name: "web",
          region: "GRA11",
          status: "ACTIVE",
          created: "2024-01-01T00:00:00Z",
          flavor: { id: "f1", name: "b3-8" },
          image: { id: "img1", name: "Ubuntu 24.04" },
          ipAddresses: [
            { ip: "1.2.3.4", type: "public", version: 4 },
            { ip: "::1", type: "public", version: 6 },
            { ip: "10.0.0.1", type: "private", version: 4 },
          ],
        },
      ]);
    });
    const res = await c.listResources("instance", ACCOUNT);
    expect(res[0].id).toBe(`${ACCOUNT}:instance:i-1`);
    expect(res[0].externalId).toBe("i-1");
    expect(res[0].fields["flavorName"]).toBe("b3-8");
    expect(res[0].fields["sshUsername"]).toBe("ubuntu");
    expect(res[0].resolvedOutputs).toEqual({
      ipv4: "1.2.3.4",
      ipv6: "::1",
      ipv4Private: "10.0.0.1",
    });
    expect(String(lastApiCall()[0])).toBe(
      "https://eu.api.ovh.com/1.0/cloud/project/proj123/instance",
    );
  });

  it("handles instance with no ips/flavor/image", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).includes("/auth/time")) return okJson(1700000000);
      return okJson([{ id: "i-2", name: "bare", region: "GRA11", status: "BUILD" }]);
    });
    const res = await c.listResources("instance", ACCOUNT);
    expect(res[0].fields["flavorName"]).toBe("");
    expect(res[0].fields["sshUsername"]).toBe("root");
    expect(res[0].resolvedOutputs["ipv4"]).toBe("");
  });

  it("throws on unknown type", async () => {
    const c = makeClient();
    await expect(c.listResources("nope", ACCOUNT)).rejects.toThrow(/unknown resource type/);
  });

  it("propagates non-ok error", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).includes("/auth/time")) return okJson(1700000000);
      return notOk(403, "forbidden");
    });
    await expect(c.listResources("instance", ACCOUNT)).rejects.toThrow(
      /OVH API error 403.*forbidden/,
    );
  });
});

describe("listResources volume", () => {
  it("maps volumes", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).includes("/auth/time")) return okJson(1700000000);
      return okJson([
        {
          id: "v-1",
          name: "data",
          region: "GRA11",
          size: 100,
          type: "classic",
          status: "available",
          bootable: true,
          attachedTo: ["i-1", "i-2"],
          creationDate: "2024-01-01T00:00:00Z",
        },
        { id: "v-2", region: "GRA11", size: 10, type: "classic" },
      ]);
    });
    const res = await c.listResources("volume", ACCOUNT);
    expect(res[0].fields["attachedTo"]).toBe("i-1,i-2");
    expect(res[0].fields["bootable"]).toBe(true);
    expect(res[1].displayName).toBe("v-2");
    expect(res[1].fields["status"]).toBe("");
    expect(res[1].fields["attachedTo"]).toBe("");
  });
});

describe("listResources managed-kube", () => {
  it("maps clusters fetching each + node pools", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/auth/time")) return okJson(1700000000);
      if (u.endsWith("/kube")) return okJson(["c-1"]);
      if (u.endsWith("/kube/c-1"))
        return okJson({
          id: "c-1",
          name: "k8s",
          region: "GRA11",
          version: "1.31",
          status: "READY",
          url: "https://k8s",
          nodesUrl: "https://nodes",
          createdAt: "2024-01-01T00:00:00Z",
        });
      if (u.endsWith("/kube/c-1/nodepool"))
        return okJson([
          { id: "p1", flavorName: "b3-8", desiredNodes: 3 },
          { id: "p2", flavorName: "b3-8", currentNodes: 2 },
        ]);
      return okJson([]);
    });
    const res = await c.listResources("managed-kube", ACCOUNT);
    expect(res[0].fields["nodeCount"]).toBe(5);
    expect(res[0].fields["nodePoolCount"]).toBe(2);
    expect(res[0].fields["flavor"]).toBe("b3-8");
    expect(res[0].resolvedOutputs["clusterUrl"]).toBe("https://k8s");
  });

  it("handles node pool listing failure gracefully", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/auth/time")) return okJson(1700000000);
      if (u.endsWith("/kube")) return okJson(["c-1"]);
      if (u.endsWith("/kube/c-1")) return okJson({ id: "c-1" });
      if (u.endsWith("/nodepool")) return notOk(403);
      return okJson([]);
    });
    const res = await c.listResources("managed-kube", ACCOUNT);
    expect(res[0].fields["nodeCount"]).toBe(0);
    expect(res[0].fields["nodePoolCount"]).toBe(0);
    expect(res[0].displayName).toBe("c-1");
  });
});

describe("listResources managed-db", () => {
  it("maps services", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).includes("/auth/time")) return okJson(1700000000);
      return okJson([
        {
          id: "db-abcdef123456",
          description: "mydb",
          engine: "postgresql",
          version: "16",
          plan: "essential",
          flavor: "db1-7",
          status: "READY",
          nodeNumber: 2,
          nodes: [{ region: "GRA" }],
        },
        { id: "db-2222", engine: "mysql", nodes: [{ region: "SBG" }] },
      ]);
    });
    const res = await c.listResources("managed-db", ACCOUNT);
    expect(res[0].displayName).toBe("mydb");
    expect(res[0].fields["nodeCount"]).toBe(2);
    expect(res[0].fields["region"]).toBe("GRA");
    expect(res[1].displayName).toBe("mysql (db-2222)");
    expect(res[1].fields["nodeCount"]).toBe(1);
  });
});

describe("getResource", () => {
  it("returns found resource", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).includes("/auth/time")) return okJson(1700000000);
      return okJson([{ id: "v-1", region: "GRA11", size: 10, type: "classic" }]);
    });
    const r = await c.getResource("volume", `${ACCOUNT}:volume:v-1`, ACCOUNT);
    expect(r.externalId).toBe("v-1");
  });

  it("throws when not found", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).includes("/auth/time")) return okJson(1700000000);
      return okJson([]);
    });
    await expect(c.getResource("volume", `${ACCOUNT}:volume:nope`, ACCOUNT)).rejects.toThrow(
      /not found/,
    );
  });
});

describe("resolveOutput", () => {
  it("managed-kube kubeconfig", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/auth/time")) return okJson(1700000000);
      if (u.endsWith("/kubeconfig")) return okJson({ content: "KUBECONFIG_YAML" });
      return okJson({});
    });
    const out = await c.resolveOutput(
      "managed-kube",
      `${ACCOUNT}:managed-kube:c-1`,
      "kubeconfig",
      ACCOUNT,
    );
    expect(out).toBe("KUBECONFIG_YAML");
    expect(lastApiCall()[1].method).toBe("POST");
  });

  it("managed-kube kubeconfig throws on unparsable id", async () => {
    const c = makeClient();
    await expect(c.resolveOutput("managed-kube", "", "kubeconfig", ACCOUNT)).rejects.toThrow(
      /Cannot parse cluster ID/,
    );
  });

  it("managed-db connectionString, host, port, database", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/auth/time")) return okJson(1700000000);
      if (u.endsWith("/database/service/db-1"))
        return okJson({
          id: "db-1",
          engine: "postgresql",
          description: "maindb",
          endpoints: [{ uri: "postgres://x", domain: "host.ovh", port: 5432 }],
        });
      return okJson({});
    });
    const id = `${ACCOUNT}:managed-db:db-1`;
    expect(await c.resolveOutput("managed-db", id, "connectionString", ACCOUNT)).toBe(
      "postgres://x",
    );
    expect(await c.resolveOutput("managed-db", id, "host", ACCOUNT)).toBe("host.ovh");
    expect(await c.resolveOutput("managed-db", id, "port", ACCOUNT)).toBe("5432");
    expect(await c.resolveOutput("managed-db", id, "database", ACCOUNT)).toBe("maindb");
    expect(await c.resolveOutput("managed-db", id, "password", ACCOUNT)).toBe("");
  });

  it("managed-db kafka connectionString is normalized", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/auth/time")) return okJson(1700000000);
      return okJson({
        id: "db-1",
        engine: "kafka",
        endpoints: [{ uri: "kafkas://broker:9093" }],
      });
    });
    const out = await c.resolveOutput(
      "managed-db",
      `${ACCOUNT}:managed-db:db-1`,
      "connectionString",
      ACCOUNT,
    );
    expect(out).toContain("kafka://broker:9093");
    expect(out).toContain("sasl=scram-sha-512");
    expect(out).toContain("ssl=true");
  });

  it("managed-db username fetches user list", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/auth/time")) return okJson(1700000000);
      if (u.endsWith("/user")) return okJson([{ username: "avnadmin" }]);
      return okJson({ id: "db-1", engine: "postgresql", endpoints: [] });
    });
    const out = await c.resolveOutput(
      "managed-db",
      `${ACCOUNT}:managed-db:db-1`,
      "username",
      ACCOUNT,
    );
    expect(out).toBe("avnadmin");
  });

  it("managed-db username empty when no users", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/auth/time")) return okJson(1700000000);
      if (u.endsWith("/user")) return okJson([]);
      return okJson({ id: "db-1", engine: "postgresql", endpoints: [{}] });
    });
    expect(
      await c.resolveOutput("managed-db", `${ACCOUNT}:managed-db:db-1`, "username", ACCOUNT),
    ).toBe("");
  });

  it("managed-db throws on unparsable id", async () => {
    const c = makeClient();
    await expect(c.resolveOutput("managed-db", "", "host", ACCOUNT)).rejects.toThrow(
      /Cannot parse database service ID/,
    );
  });

  it("managed-db unknown output falls through to error", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).includes("/auth/time")) return okJson(1700000000);
      return okJson({ id: "db-1", engine: "postgresql", endpoints: [{}] });
    });
    await expect(
      c.resolveOutput("managed-db", `${ACCOUNT}:managed-db:db-1`, "bogus", ACCOUNT),
    ).rejects.toThrow(/cannot resolve output/);
  });

  it("instance output via getResource", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).includes("/auth/time")) return okJson(1700000000);
      return okJson([
        {
          id: "i-1",
          name: "w",
          region: "GRA11",
          status: "ACTIVE",
          ipAddresses: [{ ip: "9.9.9.9", type: "public", version: 4 }],
        },
      ]);
    });
    expect(await c.resolveOutput("instance", `${ACCOUNT}:instance:i-1`, "ipv4", ACCOUNT)).toBe(
      "9.9.9.9",
    );
    expect(await c.resolveOutput("instance", `${ACCOUNT}:instance:i-1`, "missing", ACCOUNT)).toBe(
      "",
    );
  });

  it("throws for unsupported type", async () => {
    const c = makeClient();
    await expect(c.resolveOutput("volume", `${ACCOUNT}:volume:v-1`, "x", ACCOUNT)).rejects.toThrow(
      /cannot resolve output/,
    );
  });
});

describe("getCreateConfig", () => {
  it("instance config", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/auth/time")) return okJson(1700000000);
      if (u.endsWith("/flavor"))
        return okJson([
          {
            id: "f1",
            name: "b3-8",
            region: "GRA11",
            ram: 8192,
            disk: 50,
            vcpus: 2,
            type: "General Purpose",
            available: true,
          },
          { id: "f2", name: "old", region: "GRA11", ram: 1, disk: 1, vcpus: 1, available: false },
        ]);
      if (u.endsWith("/image"))
        return okJson([
          { id: "img1", name: "Ubuntu 24.04", region: "GRA11", status: "active", type: "linux" },
          { id: "img2", name: "Windows", region: "GRA11", status: "active", type: "windows" },
          { id: "img3", name: "old", region: "GRA11", status: "deprecated" },
        ]);
      if (u.endsWith("/region"))
        return okJson([
          { name: "GRA11", status: "UP" },
          { name: "DOWN1", status: "DOWN" },
        ]);
      return okJson([]);
    });
    const cfg = await c.getCreateConfig("instance");
    const region = cfg.fields.find((f) => f.key === "region") as any;
    expect(region.regions.map((r: any) => r.id)).toEqual(["GRA11"]);
    expect(region.regions[0].location).toBe("Gravelines, France");
    const size = cfg.fields.find((f) => f.key === "flavorId") as any;
    expect(size.sizes.map((s: any) => s.id)).toEqual(["f1"]);
    const image = cfg.fields.find((f) => f.key === "imageId") as any;
    expect(image.defaultValue).toBe("img1");
  });

  it("managed-kube config groups flavors by name and prefers b3-8", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/auth/time")) return okJson(1700000000);
      if (u.endsWith("/region")) return okJson([{ name: "GRA11", status: "UP" }]);
      if (u.endsWith("/flavor"))
        return okJson([
          { id: "f1", name: "b3-8", region: "GRA11", ram: 8, disk: 50, vcpus: 2, available: true },
          { id: "f2", name: "b3-8", region: "SBG5", ram: 8, disk: 50, vcpus: 2, available: true },
          { id: "f3", name: "b2-7", region: "GRA11", ram: 7, disk: 50, vcpus: 2, available: true },
        ]);
      return okJson([]);
    });
    const cfg = await c.getCreateConfig("managed-kube");
    const flavor = cfg.fields.find((f) => f.key === "flavor") as any;
    expect(flavor.sizes.map((s: any) => s.id)).toEqual(["b3-8", "b2-7"]);
    expect(flavor.defaultValue).toBe("b3-8");
  });

  it("managed-kube config tolerates flavor fetch failure", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/auth/time")) return okJson(1700000000);
      if (u.endsWith("/region")) return okJson([{ name: "GRA11", status: "UP" }]);
      if (u.endsWith("/flavor")) return notOk(500);
      return okJson([]);
    });
    const cfg = await c.getCreateConfig("managed-kube");
    const flavor = cfg.fields.find((f) => f.key === "flavor") as any;
    expect(flavor.sizes).toEqual([]);
  });

  it("managed-db config is static", async () => {
    const c = makeClient();
    const cfg = await c.getCreateConfig("managed-db");
    expect(cfg.fields.map((f) => f.key)).toContain("engine");
  });

  it("volume config", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).includes("/auth/time")) return okJson(1700000000);
      return okJson([{ name: "GRA11", status: "UP" }]);
    });
    const cfg = await c.getCreateConfig("volume");
    expect(cfg.fields.map((f) => f.key)).toContain("size");
  });

  it("throws for unknown type", async () => {
    const c = makeClient();
    await expect(c.getCreateConfig("nope")).rejects.toThrow(/No create config/);
  });
});

describe("createResource", () => {
  it("creates instance without ssh key", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).includes("/auth/time")) return okJson(1700000000);
      return okJson({
        id: "i-9",
        name: "new",
        region: "GRA11",
        status: "BUILD",
        flavor: { id: "f1", name: "b3-8" },
        image: { id: "img1", name: "Ubuntu" },
        ipAddresses: [
          { ip: "1.1.1.1", type: "public", version: 4 },
          { ip: "10.0.0.9", type: "private", version: 4 },
        ],
      });
    });
    const r = await c.createResource("instance", ACCOUNT, {
      name: "new",
      flavorId: "f1",
      imageId: "img1",
      region: "GRA11",
    });
    expect(r.externalId).toBe("i-9");
    expect(r.resolvedOutputs).toEqual({ ipv4: "1.1.1.1", ipv4Private: "10.0.0.9" });
    const body = JSON.parse(lastApiCall()[1].body as string);
    expect(body.sshKeyId).toBeUndefined();
  });

  it("creates instance uploading new ssh key", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/auth/time")) return okJson(1700000000);
      if (u.endsWith("/sshkey")) return okJson({ id: "key-1" });
      return okJson({ id: "i-10", name: "n", region: "GRA11", status: "BUILD" });
    });
    const r = await c.createResource("instance", ACCOUNT, {
      name: "n",
      flavorId: "f1",
      imageId: "img1",
      region: "GRA11",
      sshPublicKey: "ssh-rsa AAA me@host",
    });
    expect(r.externalId).toBe("i-10");
    const body = JSON.parse(lastApiCall()[1].body as string);
    expect(body.sshKeyId).toBe("key-1");
  });

  it("reuses existing ssh key when upload fails", async () => {
    const c = makeClient();
    let sshkeyPost = 0;
    fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/auth/time")) return okJson(1700000000);
      if (u.endsWith("/sshkey") && init?.method === "POST") {
        sshkeyPost++;
        return notOk(409, "exists");
      }
      if (u.endsWith("/sshkey")) return okJson([{ id: "key-9", publicKey: "ssh-rsa AAA me@host" }]);
      return okJson({ id: "i-11", name: "n", region: "GRA11", status: "BUILD" });
    });
    const r = await c.createResource("instance", ACCOUNT, {
      name: "n",
      flavorId: "f1",
      imageId: "img1",
      region: "GRA11",
      sshPublicKey: "ssh-rsa AAA me@host",
    });
    expect(sshkeyPost).toBe(1);
    const body = JSON.parse(lastApiCall()[1].body as string);
    expect(body.sshKeyId).toBe("key-9");
    expect(r.externalId).toBe("i-11");
  });

  it("creates managed-kube cluster with node pool", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/auth/time")) return okJson(1700000000);
      if (u.endsWith("/nodepool")) return okJson({ id: "p1" });
      if (u.endsWith("/kube"))
        return okJson({
          id: "c-9",
          name: "k8s",
          region: "GRA11",
          version: "1.31",
          status: "INSTALLING",
        });
      return okJson({});
    });
    const r = await c.createResource("managed-kube", ACCOUNT, {
      name: "k8s",
      region: "GRA11",
      version: "1.31",
      flavor: "b3-8",
      nodeCount: "4",
    });
    expect(r.externalId).toBe("c-9");
    expect(r.fields["nodeCount"]).toBe(4);
    expect(r.fields["nodePoolCount"]).toBe(1);
  });

  it("managed-kube uses defaults when nodeCount invalid", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/auth/time")) return okJson(1700000000);
      if (u.endsWith("/nodepool")) return okJson({ id: "p1" });
      if (u.endsWith("/kube")) return okJson({ id: "c-10" });
      return okJson({});
    });
    const r = await c.createResource("managed-kube", ACCOUNT, {
      region: "GRA11",
      nodeCount: "abc",
    });
    expect(r.fields["nodeCount"]).toBe(3);
    expect(r.displayName).toBe("OVH Kubernetes");
  });

  it("managed-kube throws when node pool creation fails", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/auth/time")) return okJson(1700000000);
      if (u.endsWith("/nodepool")) return notOk(400, "no quota");
      if (u.endsWith("/kube")) return okJson({ id: "c-11", name: "k8s" });
      return okJson({});
    });
    await expect(
      c.createResource("managed-kube", ACCOUNT, { name: "k8s", region: "GRA11" }),
    ).rejects.toThrow(/node pool creation failed/);
  });

  it("creates managed-db", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).includes("/auth/time")) return okJson(1700000000);
      return okJson({
        id: "db-9999aaaa",
        description: "mydb",
        engine: "postgresql",
        version: "16",
        plan: "essential",
        flavor: "db1-7",
        status: "CREATING",
      });
    });
    const r = await c.createResource("managed-db", ACCOUNT, {
      description: "mydb",
      engine: "postgresql",
      version: "16",
      plan: "essential",
      flavor: "db1-7",
      nodeCount: "2",
    });
    expect(r.externalId).toBe("db-9999aaaa");
    expect(r.fields["nodeCount"]).toBe(2);
    const body = JSON.parse(lastApiCall()[1].body as string);
    expect(body.nodeList).toHaveLength(2);
  });

  it("creates managed-db with fallbacks when response sparse", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).includes("/auth/time")) return okJson(1700000000);
      return okJson({ id: "db-1111bbbb" });
    });
    const r = await c.createResource("managed-db", ACCOUNT, {
      engine: "mysql",
      version: "8",
      plan: "business",
      flavor: "db1-4",
    });
    expect(r.fields["engine"]).toBe("mysql");
    expect(r.displayName).toBe("undefined (db-1111b)");
    expect(r.fields["nodeCount"]).toBe(1);
  });

  it("creates volume", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).includes("/auth/time")) return okJson(1700000000);
      return okJson({
        id: "v-9",
        name: "vol",
        region: "GRA11",
        size: 200,
        type: "high-speed",
        status: "creating",
        bootable: false,
        creationDate: "2024-01-01T00:00:00Z",
      });
    });
    const r = await c.createResource("volume", ACCOUNT, {
      name: "vol",
      region: "GRA11",
      size: "200",
      type: "high-speed",
    });
    expect(r.externalId).toBe("v-9");
    expect(r.fields["sizeGb"]).toBe(200);
    const body = JSON.parse(lastApiCall()[1].body as string);
    expect(body).toMatchObject({ size: 200, type: "high-speed" });
  });

  it("creates volume with defaults when response sparse", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).includes("/auth/time")) return okJson(1700000000);
      return okJson({ id: "v-10", region: "GRA11", size: 100, type: "classic" });
    });
    const r = await c.createResource("volume", ACCOUNT, { name: "vol", region: "GRA11" });
    expect(r.displayName).toBe("vol");
    expect(r.fields["status"]).toBe("creating");
  });

  it("throws for unsupported create type", async () => {
    const c = makeClient();
    await expect(c.createResource("nope", ACCOUNT, {})).rejects.toThrow(/not supported/);
  });
});

describe("deleteResource", () => {
  it.each([
    ["instance", "/instance/x"],
    ["managed-kube", "/kube/x"],
    ["managed-db", "/database/service/x"],
    ["volume", "/volume/x"],
  ])("deletes %s", async (type, suffix) => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).includes("/auth/time")) return okJson(1700000000);
      return okJson({}, 204);
    });
    await c.deleteResource(type, `${ACCOUNT}:${type}:x`, ACCOUNT);
    expect(String(lastApiCall()[0])).toContain(`/cloud/project/proj123${suffix}`);
    expect(lastApiCall()[1].method).toBe("DELETE");
  });

  it("throws when id unparsable", async () => {
    const c = makeClient();
    await expect(c.deleteResource("instance", "", ACCOUNT)).rejects.toThrow(
      /Cannot parse resource ID/,
    );
  });

  it("throws for unsupported type", async () => {
    const c = makeClient();
    await expect(c.deleteResource("nope", `${ACCOUNT}:nope:1`, ACCOUNT)).rejects.toThrow(
      /not supported/,
    );
  });
});

describe("attachResource", () => {
  it("attaches volume to instance same region", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/auth/time")) return okJson(1700000000);
      if (u.endsWith("/volume"))
        return okJson([{ id: "v-1", region: "GRA11", size: 10, type: "classic" }]);
      if (u.endsWith("/instance"))
        return okJson([{ id: "i-1", name: "w", region: "GRA11", status: "ACTIVE" }]);
      return okJson({});
    });
    await c.attachResource(
      "volume",
      `${ACCOUNT}:volume:v-1`,
      "instance",
      `${ACCOUNT}:instance:i-1`,
      ACCOUNT,
    );
    expect(String(lastApiCall()[0])).toContain("/volume/v-1/attach");
    expect(JSON.parse(lastApiCall()[1].body as string)).toEqual({ instanceId: "i-1" });
  });

  it("rejects when regions differ", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/auth/time")) return okJson(1700000000);
      if (u.endsWith("/volume"))
        return okJson([{ id: "v-1", region: "GRA11", size: 10, type: "classic" }]);
      if (u.endsWith("/instance"))
        return okJson([{ id: "i-1", name: "w", region: "SBG5", status: "ACTIVE" }]);
      return okJson({});
    });
    await expect(
      c.attachResource(
        "volume",
        `${ACCOUNT}:volume:v-1`,
        "instance",
        `${ACCOUNT}:instance:i-1`,
        ACCOUNT,
      ),
    ).rejects.toThrow(/does not match instance region/);
  });

  it("throws for unsupported combo", async () => {
    const c = makeClient();
    await expect(c.attachResource("instance", "a", "volume", "b", ACCOUNT)).rejects.toThrow(
      /not supported/,
    );
  });
});

describe("fetchMetricSeries", () => {
  it("returns [] (not wired)", async () => {
    const c = makeClient();
    expect(await c.fetchMetricSeries("instance", "x", ACCOUNT)).toEqual([]);
  });
});

describe("fetchDashboardStats", () => {
  function listImpl(body: unknown) {
    return async (url: string | URL | Request) => {
      if (String(url).includes("/auth/time")) return okJson(1700000000);
      return okJson(body);
    };
  }

  it("instance stats healthy + public ip", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(
      listImpl([{ id: "i-1", name: "w", region: "GRA11", status: "ACTIVE" }]),
    );
    const stats = await c.fetchDashboardStats("instance", `${ACCOUNT}:instance:i-1`, ACCOUNT);
    expect(stats[0]).toMatchObject({ label: "Status", variant: "status-healthy" });
  });

  it("instance stopped variant error", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(
      listImpl([{ id: "i-1", name: "w", region: "GRA11", status: "STOPPED" }]),
    );
    const stats = await c.fetchDashboardStats("instance", `${ACCOUNT}:instance:i-1`, ACCOUNT);
    expect(stats[0].variant).toBe("status-error");
  });

  it("instance unknown variant degraded", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(
      listImpl([{ id: "i-1", name: "w", region: "GRA11", status: "MIGRATING" }]),
    );
    const stats = await c.fetchDashboardStats("instance", `${ACCOUNT}:instance:i-1`, ACCOUNT);
    expect(stats[0].variant).toBe("status-degraded");
  });

  it("managed-kube stats", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/auth/time")) return okJson(1700000000);
      if (u.endsWith("/kube")) return okJson(["c-1"]);
      if (u.endsWith("/kube/c-1"))
        return okJson({ id: "c-1", status: "READY", version: "1.31", region: "GRA11" });
      if (u.endsWith("/nodepool")) return okJson([{ id: "p", desiredNodes: 2 }]);
      return okJson([]);
    });
    const stats = await c.fetchDashboardStats(
      "managed-kube",
      `${ACCOUNT}:managed-kube:c-1`,
      ACCOUNT,
    );
    expect(stats[0].variant).toBe("status-healthy");
    expect(stats.find((s) => s.label === "Nodes")?.value).toBe("2");
  });

  it("managed-db stats degraded", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(
      listImpl([{ id: "db-1", engine: "mysql", plan: "essential", status: "CREATING" }]),
    );
    const stats = await c.fetchDashboardStats("managed-db", `${ACCOUNT}:managed-db:db-1`, ACCOUNT);
    expect(stats[0].variant).toBe("status-degraded");
    expect(stats.find((s) => s.label === "Engine")?.value).toBe("mysql");
  });

  it("returns [] for unhandled type (volume)", async () => {
    const c = makeClient();
    fetchMock.mockImplementation(
      listImpl([{ id: "v-1", region: "GRA11", size: 1, type: "classic" }]),
    );
    expect(await c.fetchDashboardStats("volume", `${ACCOUNT}:volume:v-1`, ACCOUNT)).toEqual([]);
  });
});

describe("renderDetail / renderSidebarItem", () => {
  function res(overrides: Record<string, unknown> = {}) {
    return {
      id: `${ACCOUNT}:instance:i-1`,
      pluginId: "ovh",
      resourceTypeId: "instance",
      accountId: ACCOUNT,
      displayName: "web",
      fields: { name: "web", region: "GRA11", status: "ACTIVE" },
      resolvedOutputs: {},
      secretStates: [],
      externalId: "i-1",
      createdAt: "x",
      updatedAt: "x",
      ...overrides,
    } as any;
  }

  it("renderDetail healthy with label", () => {
    const c = makeClient();
    const d = c.renderDetail(res());
    expect(d.status).toMatchObject({ kind: "status-dot", status: "healthy", label: "ACTIVE" });
    expect(d.subtitle).toContain("GRA11");
  });

  it("renderDetail covers status branches", () => {
    const c = makeClient();
    const map: Record<string, string> = {
      READY: "healthy",
      BUILD: "provisioning",
      INSTALLING: "provisioning",
      CREATING: "provisioning",
      ERROR: "error",
      DELETED: "error",
      SUSPENDED: "degraded",
      SHUTOFF: "degraded",
      STOPPED: "degraded",
      WEIRD: "info",
    };
    for (const [status, dot] of Object.entries(map)) {
      const d = c.renderDetail(res({ fields: { status } }));
      expect(d.status.status).toBe(dot);
    }
  });

  it("renderDetail with no status omits label", () => {
    const c = makeClient();
    const d = c.renderDetail(res({ fields: { region: "GRA11" } }));
    expect((d.status as any).label).toBeUndefined();
    expect(d.status.status).toBe("info");
  });

  it("renderSidebarItem covers branches", () => {
    const c = makeClient();
    expect(c.renderSidebarItem(res()).status.status).toBe("healthy");
    expect(c.renderSidebarItem(res({ fields: { status: "BUILD" } })).status.status).toBe(
      "provisioning",
    );
    expect(c.renderSidebarItem(res({ fields: { status: "ERROR" } })).status.status).toBe("error");
    expect(c.renderSidebarItem(res({ fields: { status: "STOPPED" } })).status.status).toBe(
      "degraded",
    );
    expect(c.renderSidebarItem(res({ fields: { status: "WHAT" } })).status.status).toBe("info");
  });
});
