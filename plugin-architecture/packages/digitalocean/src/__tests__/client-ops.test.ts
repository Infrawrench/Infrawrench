import { describe, it, expect, vi, afterEach } from "vitest";
import { DigitalOceanClient } from "../client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: () => null },
  } as unknown as Response;
}

function installFetch(route: (path: string, method: string, body?: string) => unknown | undefined) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.replace("https://api.digitalocean.com/v2", "");
    const result = route(path, init?.method ?? "GET", init?.body as string | undefined);
    if (result === undefined) return jsonResponse({}, 404);
    if (result && typeof (result as { text?: unknown }).text === "function")
      return result as Response;
    return jsonResponse(result);
  }) as typeof fetch);
}

const ACC = "acc1";
const newClient = (creds: Record<string, string> = {}) =>
  new DigitalOceanClient({ apiToken: "tok", ...creds });

afterEach(() => vi.restoreAllMocks());

describe("updateResource", () => {
  it("updates a gen-ai-agent (model swap to router)", async () => {
    let body: string | undefined;
    installFetch((path, _m, b) => {
      if (path === "/gen-ai/agents/a-1") {
        body = b;
        return { agent: { uuid: "a-1", name: "A", model_router: { uuid: "r-1", name: "R" } } };
      }
      return undefined;
    });
    const r = await newClient().updateResource("gen-ai-agent", `${ACC}:gen-ai-agent:a-1`, ACC, {
      name: "A",
      temperature: "0.5",
      modelRouterUuid: "r-1",
    });
    expect(r.fields.modelRouterUuid).toBe("r-1");
    expect(JSON.parse(body!)).toMatchObject({
      name: "A",
      temperature: 0.5,
      model_router_uuid: "r-1",
    });
  });

  it("updates a gen-ai-knowledge-base (tags split into array)", async () => {
    let body: string | undefined;
    installFetch((path, _m, b) => {
      if (path === "/gen-ai/knowledge_bases/kb-1") {
        body = b;
        return { knowledge_base: { uuid: "kb-1", name: "KB", tags: ["a", "b"] } };
      }
      return undefined;
    });
    const r = await newClient().updateResource(
      "gen-ai-knowledge-base",
      `${ACC}:gen-ai-knowledge-base:kb-1`,
      ACC,
      { name: "KB", tags: "a, b" },
    );
    expect(JSON.parse(body!).tags).toEqual(["a", "b"]);
    expect(r.fields.tags).toBe("a,b");
  });

  it("updates a dns-record", async () => {
    installFetch((path) => {
      if (path === "/domains/example.com/records/7")
        return { domain_record: { id: 7, type: "A", name: "www", data: "5.6.7.8", ttl: 600 } };
      return undefined;
    });
    const r = await newClient().updateResource(
      "dns-record",
      `${ACC}:dns-record:example.com/7`,
      ACC,
      { data: "5.6.7.8", ttl: "600" },
    );
    expect(r.fields.data).toBe("5.6.7.8");
  });

  it("updates a project via PATCH", async () => {
    installFetch((path, method) => {
      if (path === "/projects/p-1" && method === "PATCH")
        return { project: { id: "p-1", name: "Renamed", purpose: "API" } };
      return undefined;
    });
    const r = await newClient().updateResource("project", `${ACC}:project:p-1`, ACC, {
      name: "Renamed",
    });
    expect(r.displayName).toBe("Renamed");
  });

  it("throws for unsupported update types", async () => {
    installFetch(() => undefined);
    await expect(
      newClient().updateResource("droplet", `${ACC}:droplet:1`, ACC, {}),
    ).rejects.toThrow(/not supported/);
  });
});

describe("attachResource", () => {
  it("attaches a volume to a droplet in the same region", async () => {
    const posts: string[] = [];
    installFetch((path, method) => {
      if (path === "/projects") return { projects: [] };
      // getResource("volume") has no single endpoint → list-and-find.
      if (path === "/volumes?per_page=200")
        return { volumes: [{ id: "vol-1", name: "data", region: { slug: "nyc3" } }] };
      if (path === "/droplets/42")
        return { droplet: { id: 42, name: "d", region: { slug: "nyc3" }, networks: {} } };
      if (path === "/volumes/vol-1/actions" && method === "POST") {
        posts.push(path);
        return {};
      }
      return undefined;
    });
    await newClient().attachResource(
      "volume",
      `${ACC}:volume:vol-1`,
      "droplet",
      `${ACC}:droplet:42`,
      ACC,
    );
    expect(posts).toContain("/volumes/vol-1/actions");
  });

  it("rejects a cross-region volume attach", async () => {
    installFetch((path) => {
      if (path === "/projects") return { projects: [] };
      if (path === "/volumes?per_page=200")
        return { volumes: [{ id: "vol-1", name: "data", region: { slug: "sfo3" } }] };
      if (path === "/droplets/42")
        return { droplet: { id: 42, region: { slug: "nyc3" }, networks: {} } };
      return undefined;
    });
    await expect(
      newClient().attachResource(
        "volume",
        `${ACC}:volume:vol-1`,
        "droplet",
        `${ACC}:droplet:42`,
        ACC,
      ),
    ).rejects.toThrow(/does not match droplet region/);
  });

  it("attaches a knowledge base to an agent", async () => {
    const posts: string[] = [];
    installFetch((path, method) => {
      if (method === "POST") {
        posts.push(path);
        return {};
      }
      return undefined;
    });
    await newClient().attachResource(
      "gen-ai-knowledge-base",
      `${ACC}:gen-ai-knowledge-base:kb-1`,
      "gen-ai-agent",
      `${ACC}:gen-ai-agent:a-1`,
      ACC,
    );
    expect(posts).toContain("/gen-ai/agents/a-1/knowledge_bases/kb-1");
  });

  it("throws for an unsupported attach pair", async () => {
    installFetch(() => undefined);
    await expect(newClient().attachResource("snapshot", "x", "image", "y", ACC)).rejects.toThrow(
      /not supported/,
    );
  });
});

describe("executeFieldAction", () => {
  it("creates a workspace inline", async () => {
    installFetch((path) => {
      if (path === "/gen-ai/workspaces") return { workspace: { uuid: "ws-1", name: "default" } };
      return undefined;
    });
    const r = await newClient().executeFieldAction(
      "gen-ai-agent",
      "workspaceUuid",
      "create-workspace",
      ACC,
      {},
      { name: "default" },
    );
    expect(r.value).toBe("ws-1");
    expect(r.option).toEqual({ id: "ws-1", label: "default" });
  });

  it("creates an inference router inline", async () => {
    installFetch((path) => {
      if (path === "/gen-ai/models/routers") return { model_router: { uuid: "r-1", name: "R" } };
      return undefined;
    });
    const r = await newClient().executeFieldAction(
      "gen-ai-agent",
      "modelRouterUuid",
      "create-inference-router",
      ACC,
      {},
      { name: "R", fallbackModels: "m1, m2" },
    );
    expect(r.value).toBe("r-1");
  });

  it("requires a workspace name", async () => {
    installFetch(() => undefined);
    await expect(
      newClient().executeFieldAction("gen-ai-agent", "f", "create-workspace", ACC, {}, {}),
    ).rejects.toThrow(/Workspace name is required/);
  });

  it("throws for unknown field actions", async () => {
    installFetch(() => undefined);
    await expect(newClient().executeFieldAction("droplet", "f", "x", ACC, {}, {})).rejects.toThrow(
      /not supported/,
    );
  });
});

describe("executeNoSqlCommand delegation", () => {
  it("delegates droplet commands", async () => {
    const posts: string[] = [];
    installFetch((path) => {
      posts.push(path);
      return {};
    });
    await newClient().executeNoSqlCommand("droplet", `${ACC}:droplet:42`, ACC, "snapshot-named", [
      JSON.stringify({ name: "snap" }),
    ]);
    expect(posts).toContain("/droplets/42/actions");
  });

  it("make-db-user requires a host secret store", async () => {
    installFetch(() => undefined);
    await expect(
      newClient().executeNoSqlCommand(
        "managed-database",
        `${ACC}:managed-database:db-1`,
        ACC,
        "make-db-user",
        [JSON.stringify({ name: "u" })],
      ),
    ).rejects.toThrow(/can't persist credentials/);
  });
});

describe("fetchDashboardStats / getLogs", () => {
  it("returns droplet stats", async () => {
    installFetch((path) => {
      if (path === "/projects") return { projects: [] };
      if (path === "/droplets/42")
        return {
          droplet: {
            id: 42,
            name: "d",
            region: { slug: "nyc3" },
            size: { slug: "s-1vcpu-1gb" },
            vcpus: 2,
            memory: 4096,
            networks: { v4: [{ type: "public", ip_address: "1.2.3.4" }] },
          },
        };
      return undefined;
    });
    const stats = await newClient().fetchDashboardStats("droplet", `${ACC}:droplet:42`, ACC);
    expect(stats.some((s) => s.label === "Region")).toBe(true);
    expect(stats.some((s) => s.label === "vCPU")).toBe(true);
  });

  it("getLogs returns managed-database events", async () => {
    installFetch((path) => {
      if (path === "/databases/db-1/events")
        return {
          events: [{ id: "e1", event_type: "create", create_time: "t", cluster_name: "c" }],
        };
      return undefined;
    });
    const logs = await newClient().getLogs(
      "managed-database",
      `${ACC}:managed-database:db-1`,
      ACC,
      {
        tailLines: 50,
      },
    );
    expect(logs.text).toContain("create");
    expect(logs.containers).toEqual(["events"]);
  });

  it("getLogs returns empty for non-database types", async () => {
    installFetch(() => undefined);
    const logs = await newClient().getLogs("droplet", `${ACC}:droplet:1`, ACC, {});
    expect(logs).toEqual({ text: "", containers: [], activeContainer: "" });
  });
});

describe("Spaces storage methods", () => {
  it("listStorageObjects requires S3 credentials", async () => {
    installFetch(() => undefined);
    await expect(newClient().listStorageObjects("bk", "")).rejects.toThrow(
      /Spaces storage requires S3-compatible credentials/,
    );
  });

  it("getManifest requires S3 credentials", async () => {
    installFetch(() => undefined);
    await expect(newClient().getManifest(`${ACC}:spaces-bucket:bk`, ACC)).rejects.toThrow(
      /Spaces storage requires S3-compatible credentials/,
    );
  });

  it("getSpacesConfig probes the bucket region and lists objects", async () => {
    // HEAD probe returns the home region; the subsequent list returns an empty
    // S3 ListBucket XML payload.
    const headResponse = {
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({}),
      headers: { get: (k: string) => (k === "x-amz-bucket-region" ? "fra1" : null) },
    } as unknown as Response;
    const listResponse = {
      ok: true,
      status: 200,
      text: async () =>
        '<?xml version="1.0"?><ListBucketResult><KeyCount>0</KeyCount></ListBucketResult>',
      json: async () => ({}),
      headers: { get: () => null },
    } as unknown as Response;
    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((async (_in: unknown, init?: RequestInit) => {
      call += 1;
      return init?.method === "HEAD" || call === 1 ? headResponse : listResponse;
    }) as typeof fetch);

    const client = newClient({ spacesAccessKeyId: "AK", spacesSecretAccessKey: "SK" });
    const objects = await client.listStorageObjects("bk", "");
    expect(Array.isArray(objects)).toBe(true);
  });
});
