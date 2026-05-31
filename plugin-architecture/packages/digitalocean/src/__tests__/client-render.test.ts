import { describe, it, expect, vi, afterEach } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
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

function installFetch(route: (path: string, method: string) => unknown | undefined) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.replace("https://api.digitalocean.com/v2", "");
    const result = route(path, init?.method ?? "GET");
    if (result === undefined) return jsonResponse({}, 404);
    if (result && typeof (result as { text?: unknown }).text === "function")
      return result as Response;
    return jsonResponse(result);
  }) as typeof fetch);
}

const ACC = "acc1";
const client = new DigitalOceanClient({ apiToken: "tok" });

function res(
  typeId: string,
  fields: Record<string, unknown>,
  extra: Partial<ResourceInstance> = {},
): ResourceInstance {
  return {
    id: `${ACC}:${typeId}:ext`,
    pluginId: "digitalocean",
    resourceTypeId: typeId,
    accountId: ACC,
    displayName: String(fields["name"] ?? typeId),
    fields,
    resolvedOutputs: {},
    secretStates: [],
    externalId: "ext",
    ...extra,
  } as ResourceInstance;
}

afterEach(() => vi.restoreAllMocks());

describe("renderDetail / renderSidebarItem across types", () => {
  it("renders a running droplet with lifecycle actions", () => {
    const detail = client.renderDetail(
      res("droplet", {
        name: "web-1",
        region: "nyc3",
        status: "active",
        size: "s-1vcpu-1gb",
        features: "ipv6",
        backupIds: "111",
        snapshotIds: "222",
      }),
    );
    expect(detail.title).toBe("web-1");
    expect(detail.headerActions!.some((a) => "label" in a && a.label === "Reboot")).toBe(true);
  });

  it("renders an off droplet with a Power On action", () => {
    const detail = client.renderDetail(
      res("droplet", { name: "web-2", region: "nyc3", status: "off" }),
    );
    expect(detail.headerActions!.some((a) => "label" in a && a.label === "Power On")).toBe(true);
  });

  it("renders volume / snapshot / image / nfs-share details", () => {
    expect(
      client.renderDetail(res("volume", { name: "v", region: "nyc3", dropletIds: "42" })),
    ).toBeTruthy();
    expect(client.renderDetail(res("snapshot", { name: "s", regions: "nyc3" }))).toBeTruthy();
    expect(client.renderDetail(res("image", { name: "i", type: "snapshot" }))).toBeTruthy();
    const nfs = client.renderDetail(
      res(
        "nfs-share",
        { name: "share", region: "nyc3" },
        { resolvedOutputs: { mountCommand: "mount x" } },
      ),
    );
    expect(nfs).toBeTruthy();
  });

  it("renders a spaces-bucket with storage browser + policy editor", () => {
    const detail = client.renderDetail(res("spaces-bucket", { name: "bk", region: "nyc3" }));
    expect(detail.storageBrowser).toEqual({ bucketName: "ext" });
    expect(detail.bucketPolicyEditor!.vendor).toBe("do-spaces");
  });

  it("renders managed-database and db-user details", () => {
    expect(
      client.renderDetail(
        res("managed-database", { name: "db", engine: "pg", region: "nyc3", status: "online" }),
      ),
    ).toBeTruthy();
    expect(client.renderDetail(res("db-user", { name: "bob", role: "normal" }))).toBeTruthy();
  });

  it("renders domain and dns-record details", () => {
    expect(client.renderDetail(res("domain", { name: "example.com", ttl: 1800 }))).toBeTruthy();
    expect(
      client.renderDetail(
        res("dns-record", {
          type: "A",
          name: "www.example.com",
          data: "1.2.3.4",
          domainName: "example.com",
        }),
      ),
    ).toBeTruthy();
  });

  it("renders the three GenAI detail variants", () => {
    expect(
      client.renderDetail(
        res(
          "gen-ai-agent",
          { name: "A", region: "tor1", status: "running", modelName: "Llama" },
          { resolvedOutputs: { deploymentUrl: "https://a" } },
        ),
      ),
    ).toBeTruthy();
    expect(
      client.renderDetail(res("gen-ai-knowledge-base", { name: "KB", region: "tor1" })),
    ).toBeTruthy();
    expect(
      client.renderDetail(
        res(
          "gen-ai-model-router",
          { name: "R", regions: "all" },
          {
            resolvedOutputs: { __policies__: "[]", __fallbackModels__: "[]" },
          },
        ),
      ),
    ).toBeTruthy();
  });

  it("renderSidebarItem returns a schema", () => {
    expect(
      client.renderSidebarItem(res("droplet", { name: "web", status: "active" })),
    ).toBeTruthy();
    expect(client.renderSidebarItem(res("dns-record", { type: "A", name: "www" }))).toBeTruthy();
  });
});

describe("GenAI listers", () => {
  it("lists gen-ai agents, knowledge bases, model routers", async () => {
    installFetch((path) => {
      if (path === "/gen-ai/agents?per_page=200")
        return {
          agents: [{ uuid: "a-1", name: "A1", region: "tor1", deployment: { status: "running" } }],
        };
      if (path === "/gen-ai/knowledge_bases?per_page=200")
        return { knowledge_bases: [{ uuid: "kb-1", name: "KB1", region: "tor1" }] };
      if (path === "/gen-ai/models/routers?per_page=200")
        return { model_routers: [{ uuid: "r-1", name: "R1" }] };
      return undefined;
    });
    expect((await client.listResources("gen-ai-agent", ACC))[0]!.fields.name).toBe("A1");
    expect((await client.listResources("gen-ai-knowledge-base", ACC))[0]!.fields.name).toBe("KB1");
    expect((await client.listResources("gen-ai-model-router", ACC))[0]!.fields.name).toBe("R1");
  });

  it("lists dedicated inferences, inference batches, model & agent api keys (tolerating gaps)", async () => {
    installFetch((path) => {
      if (path.startsWith("/dedicated-inferences"))
        return { dedicated_inferences: [{ id: "di-1", spec: { name: "infer" } }] };
      if (path.startsWith("/gen-ai/models/api_keys"))
        return { api_key_infos: [{ uuid: "mk-1", name: "mk" }] };
      if (path === "/gen-ai/agents?per_page=200") return { agents: [{ uuid: "a-1", name: "A1" }] };
      if (path.includes("/api_keys")) return { api_key_infos: [{ uuid: "ak-1", name: "ak" }] };
      return { batch_jobs: [] };
    });
    // These should not throw; exact mapping varies but the call must succeed.
    await expect(client.listResources("dedicated-inference", ACC)).resolves.toBeInstanceOf(Array);
    await expect(client.listResources("inference-batch", ACC)).resolves.toBeInstanceOf(Array);
    await expect(client.listResources("model-api-key", ACC)).resolves.toBeInstanceOf(Array);
    await expect(client.listResources("agent-api-key", ACC)).resolves.toBeInstanceOf(Array);
  });
});

describe("enrichDetail", () => {
  it("enriches a droplet with catalog data", async () => {
    installFetch((path) => {
      if (path.startsWith("/sizes"))
        return {
          sizes: [
            {
              slug: "s-2vcpu-4gb",
              memory: 4096,
              vcpus: 2,
              disk: 80,
              price_monthly: 24,
              available: true,
              description: "Basic",
            },
          ],
        };
      if (path.startsWith("/images?type=distribution"))
        return {
          images: [
            { id: 1, slug: "ubuntu", name: "Ubuntu", distribution: "Ubuntu", status: "available" },
          ],
        };
      if (path.startsWith("/images?private=true")) return { images: [] };
      return { backups: [], snapshots: [] };
    });
    const enriched = await client.enrichDetail(
      res("droplet", { name: "web", size: "s-1vcpu-1gb", backupIds: "", snapshotIds: "" }),
    );
    expect(typeof enriched.resolvedOutputs["__sizes__"]).toBe("string");
  });

  it("returns non-enriched types unchanged", async () => {
    installFetch(() => undefined);
    const project = res("project", { name: "p" });
    expect(await client.enrichDetail(project)).toBe(project);
  });

  it("enriches a gen-ai-agent", async () => {
    installFetch((path) => {
      if (path.startsWith("/gen-ai/agents/ext"))
        return {
          agent: { uuid: "ext", name: "A", deployment: { status: "running" }, chatbot: {} },
        };
      return {};
    });
    const enriched = await client.enrichDetail(res("gen-ai-agent", { name: "A" }));
    expect(enriched.resourceTypeId).toBe("gen-ai-agent");
  });
});
