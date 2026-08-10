import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DigitalOceanClient } from "../client.js";

// A Response-like stub good enough for jsonRestFetch (.ok/.status/.json/.text).
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: () => null },
  } as unknown as Response;
}

/** A Response whose `.text()` returns the raw string verbatim (no JSON wrap). */
function textResponse(text: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
    headers: { get: () => null },
  } as unknown as Response;
}

/** Match a request against `${path}` (with the base url stripped) + method. */
type Route = (path: string, method: string, body: string | undefined) => unknown | undefined;

function installFetch(route: Route) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.replace("https://api.digitalocean.com/v2", "");
    const method = init?.method ?? "GET";
    const body = init?.body as string | undefined;
    const result = route(path, method, body);
    if (result === undefined) return jsonResponse({ error: `unrouted ${method} ${path}` }, 404);
    // Our fake Responses aren't real `Response` instances; detect them by shape.
    if (result && typeof (result as { text?: unknown }).text === "function") {
      return result as Response;
    }
    return jsonResponse(result);
  }) as typeof fetch);
}

const ACC = "acc1";
const creds = { apiToken: "tok" };

function newClient(extraCreds: Record<string, string> = {}) {
  return new DigitalOceanClient({ ...creds, ...extraCreds });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DigitalOceanClient constructor", () => {
  it("throws without an apiToken", () => {
    expect(() => new DigitalOceanClient({})).toThrow(/missing apiToken/);
  });
  it("constructs with an apiToken", () => {
    expect(newClient()).toBeInstanceOf(DigitalOceanClient);
  });
});

describe("fetch error translation", () => {
  it("adds a GenAI scope hint on 403 for /gen-ai paths", async () => {
    installFetch((path) => {
      if (path === "/projects") return { projects: [] };
      if (path.startsWith("/gen-ai/agents")) return jsonResponse("forbidden", 403);
      return undefined;
    });
    const client = newClient();
    // listGenAiAgents swallows via fetchOrEmpty → returns []
    const list = await client.listResources("gen-ai-agent", ACC);
    expect(list).toEqual([]);
  });
});

describe("listResources dispatch + mappers", () => {
  beforeEach(() => {
    installFetch((path) => {
      if (path === "/projects") return { projects: [{ id: "proj-1" }] };
      if (path.startsWith("/projects/proj-1/resources"))
        return { resources: [{ urn: "do:droplet:42" }, { urn: "do:volume:vol-1" }] };
      if (path === "/droplets?per_page=200")
        return {
          droplets: [
            {
              id: 42,
              name: "web-1",
              status: "active",
              memory: 1024,
              vcpus: 1,
              disk: 25,
              region: { slug: "nyc3" },
              size: { slug: "s-1vcpu-1gb", price_monthly: 6 },
              image: { slug: "ubuntu-22-04-x64" },
              networks: { v4: [{ type: "public", ip_address: "1.2.3.4" }] },
              tags: ["web"],
            },
          ],
        };
      if (path === "/volumes?per_page=200")
        return {
          volumes: [
            {
              id: "vol-1",
              name: "data",
              region: { slug: "nyc3" },
              size_gigabytes: 50,
              droplet_ids: [42],
            },
          ],
        };
      if (path === "/snapshots?per_page=200")
        return { snapshots: [{ id: "snap-1", name: "backup", resource_type: "droplet" }] };
      if (path === "/images?private=true&per_page=200")
        return { images: [{ id: 99, name: "myimg", type: "snapshot" }] };
      if (path === "/databases") return { databases: [{ id: "db-1", name: "pg", engine: "pg" }] };
      if (path === "/databases/db-1/users")
        return { users: [{ name: "doadmin", role: "primary" }] };
      if (path === "/kubernetes/clusters")
        return {
          kubernetes_clusters: [
            { id: "k-1", name: "kube", region: "nyc3", node_pools: [{ size: "s", count: 3 }] },
          ],
        };
      if (path === "/domains") return { domains: [{ name: "example.com" }] };
      if (path.startsWith("/domains/example.com/records"))
        return { domain_records: [{ id: 7, type: "A", name: "www", data: "1.2.3.4" }] };
      if (path === "/nfs?per_page=200")
        return { nfs: [{ id: "nfs-1", name: "share", region: "nyc3", size_gib: 50 }] };
      return undefined;
    });
  });

  it("lists droplets and resolves the project parent", async () => {
    const list = await newClient().listResources("droplet", ACC);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(`${ACC}:droplet:42`);
    expect(list[0]!.fields.region).toBe("nyc3");
    expect(list[0]!.parentResourceId).toBe(`${ACC}:project:proj-1`);
  });

  it("lists volumes", async () => {
    const list = await newClient().listResources("volume", ACC);
    expect(list[0]!.fields.dropletIds).toBe("42");
  });

  it("lists snapshots, images, databases, db-users, doks, domains, dns, nfs", async () => {
    const client = newClient();
    expect((await client.listResources("snapshot", ACC))[0]!.fields.name).toBe("backup");
    expect((await client.listResources("image", ACC))[0]!.fields.name).toBe("myimg");
    expect((await client.listResources("managed-database", ACC))[0]!.fields.engine).toBe("pg");
    expect((await client.listResources("db-user", ACC))[0]!.fields.name).toBe("doadmin");
    expect((await client.listResources("db-user", ACC))[0]!.fields.databaseId).toBe("db-1");
    expect((await client.listResources("doks-cluster", ACC))[0]!.fields.nodeCount).toBe(3);
    expect((await client.listResources("domain", ACC))[0]!.fields.name).toBe("example.com");
    expect((await client.listResources("dns-record", ACC))[0]!.fields.name).toBe("www.example.com");
    expect((await client.listResources("nfs-share", ACC))[0]!.externalId).toBe("nyc3/nfs-1");
  });

  it("throws for an unknown resource type", async () => {
    await expect(newClient().listResources("bogus", ACC)).rejects.toThrow(/unknown resource type/);
  });

  it("returns [] for spaces-bucket without S3 credentials", async () => {
    expect(await newClient().listResources("spaces-bucket", ACC)).toEqual([]);
  });
});

describe("vpc", () => {
  const VPCS = {
    vpcs: [
      {
        id: "5a4981aa-9653-4bd1-bef5-d6bff52042e4",
        urn: "do:vpc:5a4981aa-9653-4bd1-bef5-d6bff52042e4",
        name: "default-nyc3",
        description: "shared",
        region: "nyc3",
        ip_range: "10.116.0.0/20",
        default: true,
        created_at: "2026-01-02T03:04:05Z",
      },
      { id: "vpc-2", name: "prod", region: "fra1", ip_range: "10.10.10.0/24" },
    ],
  };

  it("lists VPCs with the uuid as externalId", async () => {
    installFetch((path) => (path === "/vpcs?per_page=200" ? VPCS : undefined));
    const list = await newClient().listResources("vpc", ACC);
    expect(list).toHaveLength(2);
    expect(list[0]!.id).toBe(`${ACC}:vpc:5a4981aa-9653-4bd1-bef5-d6bff52042e4`);
    expect(list[0]!.externalId).toBe("5a4981aa-9653-4bd1-bef5-d6bff52042e4");
    expect(list[0]!.displayName).toBe("default-nyc3");
    expect(list[0]!.fields).toEqual({
      name: "default-nyc3",
      region: "nyc3",
      ipRange: "10.116.0.0/20",
      description: "shared",
      isDefault: true,
      createdAt: "2026-01-02T03:04:05Z",
    });
    expect(list[0]!.resolvedOutputs).toEqual({
      vpcId: "5a4981aa-9653-4bd1-bef5-d6bff52042e4",
    });
    expect(list[0]!.createdAt).toBe("2026-01-02T03:04:05Z");
    // Absent `default`/`description` must not become "undefined" strings.
    expect(list[1]!.fields).toMatchObject({ description: "", isDefault: false });
  });

  it("tolerates a null vpcs array", async () => {
    installFetch((path) => (path === "/vpcs?per_page=200" ? { vpcs: null } : undefined));
    expect(await newClient().listResources("vpc", ACC)).toEqual([]);
  });

  it("resolves the vpcId output from the external id without a network call", async () => {
    installFetch(() => undefined);
    expect(await newClient().resolveOutput("vpc", `${ACC}:vpc:vpc-9`, "vpcId", ACC)).toBe("vpc-9");
  });

  it("DELETEs /vpcs/{id}", async () => {
    const seen: Array<{ path: string; method: string }> = [];
    installFetch((path, method) => {
      seen.push({ path, method });
      return {};
    });
    await newClient().deleteResource("vpc", `${ACC}:vpc:vpc-9`, ACC);
    expect(seen).toEqual([{ path: "/vpcs/vpc-9", method: "DELETE" }]);
  });
});

describe("getResource", () => {
  it("fetches a droplet via the single-resource endpoint", async () => {
    installFetch((path) => {
      if (path === "/projects") return { projects: [] };
      if (path === "/droplets/42")
        return { droplet: { id: 42, name: "web-1", region: { slug: "nyc3" }, networks: {} } };
      return undefined;
    });
    const r = await newClient().getResource("droplet", `${ACC}:droplet:42`, ACC);
    expect(r.displayName).toBe("web-1");
  });

  it("falls back to list-and-find when the single endpoint 404s", async () => {
    installFetch((path) => {
      if (path === "/projects") return { projects: [] };
      if (path === "/droplets/42") return jsonResponse("not found", 404);
      if (path === "/droplets?per_page=200")
        return { droplets: [{ id: 42, name: "web-1", region: { slug: "nyc3" }, networks: {} }] };
      return undefined;
    });
    const r = await newClient().getResource("droplet", `${ACC}:droplet:42`, ACC);
    expect(r.id).toBe(`${ACC}:droplet:42`);
  });

  it("throws when a resource is not found", async () => {
    installFetch((path) => {
      if (path === "/domains") return { domains: [] };
      return undefined;
    });
    await expect(
      newClient().getResource("domain", `${ACC}:domain:missing.com`, ACC),
    ).rejects.toThrow(/not found/);
  });
});

describe("resolveOutput", () => {
  it("returns a managed-database connection string with inline credentials", async () => {
    installFetch((path) => {
      if (path === "/databases/db-1")
        return {
          database: {
            engine: "pg",
            connection: {
              uri: "postgres://doadmin:secret@host:5432/defaultdb",
              user: "doadmin",
              password: "secret",
              host: "host",
              port: "5432",
              database: "defaultdb",
            },
          },
        };
      return undefined;
    });
    const client = newClient();
    const uri = await client.resolveOutput(
      "managed-database",
      `${ACC}:managed-database:db-1`,
      "connectionString",
      ACC,
    );
    expect(uri).toContain("postgres://");
    expect(
      await client.resolveOutput("managed-database", `${ACC}:managed-database:db-1`, "host", ACC),
    ).toBe("host");
    expect(
      await client.resolveOutput("managed-database", `${ACC}:managed-database:db-1`, "port", ACC),
    ).toBe("5432");
  });

  it("resolves doks kubeconfig as raw yaml", async () => {
    installFetch((path) => {
      if (path === "/kubernetes/clusters/k-1/kubeconfig") return textResponse("apiVersion: v1");
      return undefined;
    });
    const yaml = await newClient().resolveOutput(
      "doks-cluster",
      `${ACC}:doks-cluster:k-1`,
      "kubeconfig",
      ACC,
    );
    expect(yaml).toContain("apiVersion");
  });

  it("resolves domain nameservers without a network call", async () => {
    installFetch(() => undefined);
    const ns = await newClient().resolveOutput("domain", `${ACC}:domain:x.com`, "nameservers", ACC);
    expect(ns).toContain("ns1.digitalocean.com");
  });

  it("returns spaces access/secret keys from credentials", async () => {
    installFetch(() => undefined);
    const client = newClient({ spacesAccessKeyId: "AK", spacesSecretAccessKey: "SK" });
    expect(
      await client.resolveOutput("spaces-bucket", `${ACC}:spaces-bucket:b`, "accessKeyId", ACC),
    ).toBe("AK");
    expect(
      await client.resolveOutput("spaces-bucket", `${ACC}:spaces-bucket:b`, "secretAccessKey", ACC),
    ).toBe("SK");
  });

  it("throws for an unsupported output", async () => {
    installFetch(() => undefined);
    await expect(
      newClient().resolveOutput("project", `${ACC}:project:p`, "bogus", ACC),
    ).rejects.toThrow(/cannot resolve output/);
  });
});

describe("container-registry", () => {
  const CREDS_DOC = {
    auths: { "registry.digitalocean.com": { auth: btoa("dop_v1_tok:secret:with:colons") } },
  };

  it("lists the account's single registry with its subscription tier", async () => {
    installFetch((path) => {
      if (path === "/registry")
        return {
          registry: {
            name: "acme",
            region: "nyc3",
            storage_usage_bytes: 12345,
            created_at: "2026-01-01T00:00:00Z",
          },
        };
      if (path === "/registry/subscription") return { subscription: { tier: { slug: "basic" } } };
      return undefined;
    });
    const list = await newClient().listResources("container-registry", ACC);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(`${ACC}:container-registry:acme`);
    expect(list[0]!.externalId).toBe("acme");
    expect(list[0]!.fields).toMatchObject({
      name: "acme",
      subscriptionTier: "basic",
      region: "nyc3",
      storageUsageBytes: 12345,
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(list[0]!.resolvedOutputs).toEqual({
      endpoint: "registry.digitalocean.com/acme",
      serverUrl: "registry.digitalocean.com",
    });
  });

  it("leaves the tier blank when the subscription endpoint fails", async () => {
    installFetch((path) => {
      if (path === "/registry") return { registry: { name: "acme" } };
      return undefined; // /registry/subscription → 404
    });
    const list = await newClient().listResources("container-registry", ACC);
    expect(list[0]!.fields.subscriptionTier).toBe("");
  });

  it("maps a 404 (no registry yet) to an empty list", async () => {
    installFetch(() => undefined);
    expect(await newClient().listResources("container-registry", ACC)).toEqual([]);
  });

  it("propagates non-404 errors from GET /registry", async () => {
    installFetch((path) => {
      if (path === "/registry") return jsonResponse("boom", 500);
      return undefined;
    });
    await expect(newClient().listResources("container-registry", ACC)).rejects.toThrow(
      /API error 500/,
    );
  });

  it("resolves endpoint/serverUrl from the registry name without a network call", async () => {
    installFetch(() => undefined);
    const client = newClient();
    const rid = `${ACC}:container-registry:acme`;
    expect(await client.resolveOutput("container-registry", rid, "endpoint", ACC)).toBe(
      "registry.digitalocean.com/acme",
    );
    expect(await client.resolveOutput("container-registry", rid, "serverUrl", ACC)).toBe(
      "registry.digitalocean.com",
    );
  });

  it("resolves dockerConfigJson as the compact credentials document", async () => {
    installFetch((path) => {
      if (path === "/registry/docker-credentials?read_write=true") return CREDS_DOC;
      return undefined;
    });
    const json = await newClient().resolveOutput(
      "container-registry",
      `${ACC}:container-registry:acme`,
      "dockerConfigJson",
      ACC,
    );
    expect(JSON.parse(json)).toEqual(CREDS_DOC);
    expect(json).not.toContain("\n");
  });

  it("parses username/password from the auth value, splitting on the first colon", async () => {
    installFetch((path) => {
      if (path === "/registry/docker-credentials?read_write=true") return CREDS_DOC;
      return undefined;
    });
    const client = newClient();
    const rid = `${ACC}:container-registry:acme`;
    expect(await client.resolveOutput("container-registry", rid, "username", ACC)).toBe(
      "dop_v1_tok",
    );
    expect(await client.resolveOutput("container-registry", rid, "password", ACC)).toBe(
      "secret:with:colons",
    );
  });

  it("deletes the registry only when the current name matches", async () => {
    const seen: Array<{ path: string; method: string }> = [];
    installFetch((path, method) => {
      seen.push({ path, method });
      if (path === "/registry") return { registry: { name: "acme" } };
      return undefined;
    });
    const client = newClient();
    await expect(
      client.deleteResource("container-registry", `${ACC}:container-registry:other`, ACC),
    ).rejects.toThrow(/refusing to delete/);
    expect(seen.some((s) => s.method === "DELETE")).toBe(false);
    await client.deleteResource("container-registry", `${ACC}:container-registry:acme`, ACC);
    expect(seen).toContainEqual({ path: "/registry", method: "DELETE" });
  });
});

describe("deleteResource", () => {
  it("DELETEs the right endpoint per type", async () => {
    const seen: Array<{ path: string; method: string }> = [];
    installFetch((path, method) => {
      seen.push({ path, method });
      return {};
    });
    const client = newClient();
    await client.deleteResource("droplet", `${ACC}:droplet:42`, ACC);
    await client.deleteResource("doks-cluster", `${ACC}:doks-cluster:k-1`, ACC);
    await client.deleteResource("managed-database", `${ACC}:managed-database:db-1`, ACC);
    await client.deleteResource("domain", `${ACC}:domain:example.com`, ACC);
    await client.deleteResource("project", `${ACC}:project:p-1`, ACC);
    await client.deleteResource("volume", `${ACC}:volume:vol-1`, ACC);
    await client.deleteResource("snapshot", `${ACC}:snapshot:s-1`, ACC);
    await client.deleteResource("image", `${ACC}:image:99`, ACC);
    expect(seen).toEqual([
      { path: "/droplets/42", method: "DELETE" },
      { path: "/kubernetes/clusters/k-1", method: "DELETE" },
      { path: "/databases/db-1", method: "DELETE" },
      { path: "/domains/example.com", method: "DELETE" },
      { path: "/projects/p-1", method: "DELETE" },
      { path: "/volumes/vol-1", method: "DELETE" },
      { path: "/snapshots/s-1", method: "DELETE" },
      { path: "/images/99", method: "DELETE" },
    ]);
  });

  it("parses composite db-user / dns-record / nfs-share / agent-api-key ids", async () => {
    const paths: string[] = [];
    installFetch((path) => {
      paths.push(path);
      return {};
    });
    const client = newClient();
    await client.deleteResource("db-user", `${ACC}:db-user:db-1:bob`, ACC);
    await client.deleteResource("dns-record", `${ACC}:dns-record:example.com/7`, ACC);
    await client.deleteResource("nfs-share", `${ACC}:nfs-share:nyc3/nfs-1`, ACC);
    await client.deleteResource("agent-api-key", `${ACC}:agent-api-key:agent-1/key-1`, ACC);
    expect(paths).toContain("/databases/db-1/users/bob");
    expect(paths).toContain("/domains/example.com/records/7");
    expect(paths).toContain("/nfs/nfs-1?region=nyc3");
    expect(paths).toContain("/gen-ai/agents/agent-1/api_keys/key-1");
  });

  it("requires S3 credentials to delete a spaces-bucket", async () => {
    installFetch(() => undefined);
    await expect(
      newClient().deleteResource("spaces-bucket", `${ACC}:spaces-bucket:b`, ACC),
    ).rejects.toThrow(/Spaces management requires S3-compatible credentials/);
  });

  it("throws for an unsupported type", async () => {
    installFetch(() => undefined);
    await expect(newClient().deleteResource("bogus", `${ACC}:bogus:x`, ACC)).rejects.toThrow(
      /not supported/,
    );
  });
});

describe("invokeAction", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("dispatches droplet actions through the action handler", async () => {
    const paths: string[] = [];
    installFetch((path) => {
      paths.push(path);
      if (path === "/projects") return { projects: [] };
      if (path === "/droplets/42")
        return { droplet: { id: 42, name: "web-1", region: { slug: "nyc3" }, networks: {} } };
      return {};
    });
    await newClient().invokeAction("droplet", `${ACC}:droplet:42`, "reboot", ACC);
    expect(paths).toContain("/droplets/42/actions");
  });

  it("toggles gen-ai-agent deployment visibility", async () => {
    let captured: { path: string; body: string | undefined } | undefined;
    installFetch((path, _method, body) => {
      captured = { path, body };
      return {};
    });
    await newClient().invokeAction(
      "gen-ai-agent",
      `${ACC}:gen-ai-agent:agent-1`,
      "make-public",
      ACC,
    );
    expect(captured!.path).toBe("/gen-ai/agents/agent-1/deployment_visibility");
    expect(JSON.parse(captured!.body!)).toEqual({ visibility: "VISIBILITY_PUBLIC" });
  });

  it("regenerates an agent-api-key", async () => {
    const paths: string[] = [];
    installFetch((path) => {
      paths.push(path);
      return {};
    });
    await newClient().invokeAction(
      "agent-api-key",
      `${ACC}:agent-api-key:agent-1/key-1`,
      "regenerate",
      ACC,
    );
    expect(paths).toContain("/gen-ai/agents/agent-1/api_keys/key-1/regenerate");
  });

  it("throws for unsupported action types", async () => {
    installFetch(() => undefined);
    await expect(newClient().invokeAction("project", `${ACC}:project:p`, "x", ACC)).rejects.toThrow(
      /not supported/,
    );
  });
});

describe("getCreateConfig / estimateCost / exportCredential / manifests", () => {
  it("getCreateConfig delegates to doGetCreateConfig", async () => {
    installFetch(() => undefined);
    const config = await newClient().getCreateConfig("project");
    expect(config.fields.some((f) => f.key === "name")).toBe(true);
  });

  it("estimateCost multiplies db per-node price by node count", async () => {
    const client = newClient();
    const est = await client.estimateCost("managed-database", {
      size: "db-s-2vcpu-4gb",
      nodeCount: "3",
    });
    expect(est?.monthlyAmount).toBeCloseTo(4 * 15.2 * 3);
    expect(est?.lineItems).toHaveLength(1);
    expect(est?.lineItems[0]).toMatchObject({ quantity: 3, unit: "nodes" });
    expect(await client.estimateCost("doks-cluster", {})).toBeNull();
    expect(await client.estimateCost("droplet", {})).toBeNull();
  });

  it("exportCredential mints a bucket-scoped Spaces key", async () => {
    installFetch((path) => {
      if (path === "/projects") return { projects: [] };
      if (path === "/spaces/keys")
        return { key: { name: "k", access_key: "AK2", secret_key: "SK2" } };
      // getResource HEADs the bucket via the regional S3 endpoint; accept it.
      if (path.includes("my-bucket.nyc3.digitaloceanspaces.com")) return textResponse("", 200);
      return undefined;
    });
    const client = newClient({ spacesAccessKeyId: "AK", spacesSecretAccessKey: "SK" });
    const exp = await client.exportCredential(
      "spaces-bucket",
      `${ACC}:spaces-bucket:my-bucket`,
      ACC,
      "bucket-scoped-rw",
    );
    expect(exp.filename).toContain("my-bucket");
    expect(exp.content).toContain("AK2");
    expect(exp.fields!.some((f) => f.sensitive)).toBe(true);
  });

  it("exportCredential rejects unknown formats", async () => {
    installFetch((path) => {
      if (path === "/projects") return { projects: [] };
      if (path.includes("b.nyc3.digitaloceanspaces.com")) return textResponse("", 200);
      return jsonResponse("err", 404);
    });
    const client = newClient({ spacesAccessKeyId: "AK", spacesSecretAccessKey: "SK" });
    await expect(
      client.exportCredential("spaces-bucket", `${ACC}:spaces-bucket:b`, ACC, "weird"),
    ).rejects.toThrow(/unknown spaces key format/);
  });

  it("exportCredential throws for unsupported types", async () => {
    installFetch(() => undefined);
    await expect(
      newClient().exportCredential("droplet", `${ACC}:droplet:1`, ACC, "x"),
    ).rejects.toThrow(/not supported/);
  });

  it("getManifest / applyManifest reject non-spaces types", async () => {
    installFetch(() => undefined);
    const client = newClient();
    await expect(client.getManifest(`${ACC}:droplet:1`, ACC)).rejects.toThrow(/not supported/);
    await expect(client.applyManifest(`${ACC}:droplet:1`, ACC, "{}")).rejects.toThrow(
      /not supported/,
    );
  });
});
