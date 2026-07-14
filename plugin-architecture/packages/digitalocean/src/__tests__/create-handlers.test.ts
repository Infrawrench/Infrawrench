import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import {
  type DoCreateContext,
  estimateDoDatabaseMonthlyPrice,
  doGetCreateConfig,
  doCreateResource,
} from "../create-handlers.js";

// ---- catalog responses used by doGetCreateConfig ----
const REGIONS = {
  regions: [
    { slug: "nyc3", name: "New York 3", available: true },
    { slug: "sfo1", name: "San Francisco 1 (legacy)", available: true },
    { slug: "ams2", name: "Amsterdam 2 (legacy)", available: true },
  ],
};
const SIZES = {
  sizes: [
    {
      slug: "s-1vcpu-1gb",
      memory: 1024,
      vcpus: 1,
      disk: 25,
      price_monthly: 6,
      available: true,
      description: "Basic",
    },
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
const IMAGES = {
  images: [
    {
      id: 1,
      slug: "ubuntu-22-04-x64",
      name: "Ubuntu 22.04",
      distribution: "Ubuntu",
      type: "distribution",
      public: true,
      status: "available",
    },
  ],
};
const PROJECTS = {
  projects: [
    { id: "proj-default", name: "Default", is_default: true },
    { id: "proj-2", name: "Staging" },
  ],
};

/**
 * Route a DO REST path to a canned JSON response. Unknown GET paths return an
 * empty object; this is enough for the catalog-driven create config branches.
 */
function routeFetch(path: string): unknown {
  if (path === "/regions") return REGIONS;
  if (path === "/sizes") return SIZES;
  if (path.startsWith("/images")) return IMAGES;
  if (path === "/projects") return PROJECTS;
  if (path === "/kubernetes/options")
    return {
      options: {
        regions: [{ slug: "nyc3", name: "New York 3" }],
        sizes: [{ slug: "s-2vcpu-4gb", name: "2vCPU" }],
        versions: [{ slug: "1.29.1-do.0", kubernetes_version: "1.29.1" }],
      },
    };
  if (path === "/databases/options")
    return {
      options: {
        pg: {
          regions: ["nyc3"],
          layouts: [{ num_nodes: 1, sizes: ["db-s-1vcpu-1gb", "db-r-2vcpu-16gb"] }],
        },
        kafka: { regions: ["nyc3"], layouts: [{ num_nodes: 3, sizes: ["gd-2vcpu-8gb"] }] },
      },
    };
  if (path.startsWith("/vpcs")) return { vpcs: [{ id: "vpc-1", name: "default", region: "nyc3" }] };
  if (path.startsWith("/domains")) return { domains: [{ name: "example.com" }] };
  if (path.startsWith("/gen-ai/models/routers/presets"))
    return { presets: [{ slug: "balanced", display_name: "Balanced", short_description: "ok" }] };
  if (path.startsWith("/gen-ai/models/routers"))
    return { model_routers: [{ uuid: "router-1", name: "R1" }] };
  if (path.startsWith("/gen-ai/models"))
    return { models: [{ uuid: "model-1", name: "Llama", provider: { name: "Meta" } }] };
  if (path === "/gen-ai/regions") return { regions: [{ region: "tor1", serves_inference: true }] };
  if (path === "/gen-ai/workspaces") return { workspaces: [{ uuid: "ws-1", name: "default" }] };
  if (path.startsWith("/gen-ai/agents")) return { agents: [{ uuid: "agent-1", name: "A1" }] };
  if (path === "/dedicated-inferences/sizes")
    return {
      regions: [{ region: "nyc3", sizes: [{ slug: "gpu-1", gpu_count: 1, price_monthly: 1500 }] }],
    };
  if (path === "/dedicated-inferences/accelerators")
    return { accelerators: [{ slug: "acc-1", model_id: "m-1", name: "Mixtral" }] };
  return {};
}

function makeCtx(overrides?: Partial<DoCreateContext>): DoCreateContext & {
  fetch: Mock;
} {
  const fetch = vi.fn(async (path: string) => routeFetch(path)) as Mock;
  return {
    fetch,
    credentials: { apiToken: "tok" },
    ...overrides,
  } as DoCreateContext & { fetch: Mock };
}

describe("estimateDoDatabaseMonthlyPrice", () => {
  it("returns 0 for zero memory", () => {
    expect(estimateDoDatabaseMonthlyPrice("db-s-1vcpu-1gb", 0)).toBe(0);
  });
  it("prices memory-optimized (db-r-)", () => {
    expect(estimateDoDatabaseMonthlyPrice("db-r-2vcpu-16gb", 16)).toBeCloseTo(16 * 30.45);
  });
  it("prices burstable (db-b-)", () => {
    expect(estimateDoDatabaseMonthlyPrice("db-b-1vcpu-1gb", 1)).toBe(8);
  });
  it("prices standard (db-s-)", () => {
    expect(estimateDoDatabaseMonthlyPrice("db-s-2vcpu-4gb", 4)).toBeCloseTo(4 * 15.2);
  });
  it("returns 0 for engine-namespaced slugs", () => {
    expect(estimateDoDatabaseMonthlyPrice("gd-2vcpu-8gb", 8)).toBe(0);
  });
});

describe("doGetCreateConfig — every type produces fields", () => {
  const types = [
    "droplet",
    "doks-cluster",
    "spaces-bucket",
    "managed-database",
    "domain",
    "dns-record",
    "project",
    "volume",
    "nfs-share",
    "gen-ai-agent",
    "gen-ai-knowledge-base",
    "gen-ai-model-router",
    "dedicated-inference",
    "agent-api-key",
  ];
  for (const type of types) {
    it(`${type} returns a non-empty field list`, async () => {
      const ctx = makeCtx();
      const config = await doGetCreateConfig(ctx, type);
      expect(Array.isArray(config.fields)).toBe(true);
      expect(config.fields.length).toBeGreaterThan(0);
      expect(config.fields.some((f) => f.key === "name" || f.key === "agentUuid")).toBe(true);
    });
  }

  it("includes a Project select when created from the account base", async () => {
    const ctx = makeCtx();
    const config = await doGetCreateConfig(ctx, "droplet");
    const project = config.fields.find((f) => f.key === "projectId");
    expect(project).toBeDefined();
    expect((project as { defaultValue?: string }).defaultValue).toBe("proj-default");
  });

  it("omits the Project select when a parentResourceId is supplied", async () => {
    const ctx = makeCtx();
    const config = await doGetCreateConfig(ctx, "droplet", "acc:project:proj-2");
    expect(config.fields.find((f) => f.key === "projectId")).toBeUndefined();
  });

  it("db-user surfaces Kafka ACL fields when the parent cluster is Kafka", async () => {
    const ctx = makeCtx({
      fetch: vi.fn(async (path: string) => {
        if (path === "/databases/clu-1") return { database: { engine: "kafka" } };
        return routeFetch(path);
      }) as Mock,
    });
    const config = await doGetCreateConfig(ctx, "db-user", "acc:managed-database:clu-1");
    const keys = config.fields.map((f) => f.key);
    expect(keys).toContain("name");
    expect(keys.some((k) => k === "topic" || k === "permission")).toBe(true);
  });

  it("db-user falls back to a bare username form for non-Kafka engines", async () => {
    const ctx = makeCtx({
      fetch: vi.fn(async (path: string) => {
        if (path === "/databases/clu-1") return { database: { engine: "pg" } };
        return routeFetch(path);
      }) as Mock,
    });
    const config = await doGetCreateConfig(ctx, "db-user", "acc:managed-database:clu-1");
    expect(config.fields.map((f) => f.key)).toEqual(["name"]);
  });

  it("dns-record adds a domain picker only from the account base", async () => {
    const ctx = makeCtx();
    const fromBase = await doGetCreateConfig(ctx, "dns-record");
    expect(fromBase.fields.some((f) => f.key === "domainName")).toBe(true);
    const fromDomain = await doGetCreateConfig(ctx, "dns-record", "acc:domain:example.com");
    expect(fromDomain.fields.some((f) => f.key === "domainName")).toBe(false);
  });

  it("agent-api-key shows an agent picker from the base but not under an agent", async () => {
    const ctx = makeCtx();
    const fromBase = await doGetCreateConfig(ctx, "agent-api-key");
    expect(fromBase.fields.some((f) => f.key === "agentUuid")).toBe(true);
    const fromAgent = await doGetCreateConfig(ctx, "agent-api-key", "acc:gen-ai-agent:agent-1");
    expect(fromAgent.fields.map((f) => f.key)).toEqual(["name"]);
  });

  it("managed-database excludes legacy non-DBaaS regions", async () => {
    const ctx = makeCtx();
    const config = await doGetCreateConfig(ctx, "managed-database");
    const regionField = config.fields.find((f) => f.key === "region") as {
      regions: Array<{ id: string }>;
    };
    const slugs = regionField.regions.map((r) => r.id);
    expect(slugs).toContain("nyc3");
    expect(slugs).not.toContain("sfo1");
    expect(slugs).not.toContain("ams2");
  });

  it("throws for an unknown type", async () => {
    const ctx = makeCtx();
    await expect(doGetCreateConfig(ctx, "nonsense")).rejects.toThrow(/No create config/);
  });

  it("tolerates a failing /projects fetch (no project field, no throw)", async () => {
    const ctx = makeCtx({
      fetch: vi.fn(async (path: string) => {
        if (path === "/projects") throw new Error("403");
        return routeFetch(path);
      }) as Mock,
    });
    const config = await doGetCreateConfig(ctx, "volume");
    expect(config.fields.find((f) => f.key === "projectId")).toBeUndefined();
  });
});

describe("doCreateResource — REST create branches", () => {
  it("creates a droplet, uploads an SSH key, and assigns it to a project", async () => {
    const fetch = vi.fn(async (path: string) => {
      if (path === "/account/keys") return { ssh_key: { id: 555 } };
      if (path === "/droplets")
        return {
          droplet: {
            id: 42,
            name: "web-1",
            region: { slug: "nyc3" },
            size: { slug: "s-1vcpu-1gb" },
            image: { slug: "ubuntu-22-04-x64" },
            networks: {
              v4: [
                { type: "public", ip_address: "1.2.3.4" },
                { type: "private", ip_address: "10.0.0.1" },
              ],
            },
            created_at: "2026-01-01T00:00:00Z",
          },
        };
      return {};
    }) as Mock;
    const ctx = { fetch, credentials: {} } as DoCreateContext;
    const result = await doCreateResource(
      ctx,
      "droplet",
      "acc",
      {
        name: "web-1",
        region: "nyc3",
        size: "s-1vcpu-1gb",
        image: "ubuntu-22-04-x64",
        sshPublicKey: "ssh-ed25519 AAAA comment",
      },
      "acc:project:proj-2",
    );
    expect(result.resource.id).toBe("acc:droplet:42");
    expect(result.resource.resolvedOutputs).toEqual({ ipv4: "1.2.3.4", ipv4Private: "10.0.0.1" });
    expect(result.resource.parentResourceId).toBe("acc:project:proj-2");
    expect(fetch).toHaveBeenCalledWith(
      "/account/keys",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "comment", public_key: "ssh-ed25519 AAAA comment" }),
      }),
    );
    expect(fetch).toHaveBeenCalledWith(
      "/droplets",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "web-1",
          region: "nyc3",
          size: "s-1vcpu-1gb",
          image: "ubuntu-22-04-x64",
          ssh_keys: [555],
        }),
      }),
    );
    // project assignment POST happened
    expect(fetch).toHaveBeenCalledWith("/projects/proj-2/resources", expect.any(Object));
  });

  it("resolves a duplicate SSH key beyond page 1 when the upload 422s", async () => {
    const sshPub = "ssh-ed25519 AAAA comment";
    // Page 1 is full (200 non-matching keys); the match sits on page 2.
    const page1 = Array.from({ length: 200 }, (_, i) => ({
      id: i + 1,
      public_key: `ssh-ed25519 OTHER${i} other`,
    }));
    const fetch = vi.fn(async (path: string, init?: { method?: string }) => {
      if (path === "/account/keys" && init?.method === "POST") {
        throw new Error("DigitalOcean API 422: SSH Key is already in use on your account");
      }
      if (path === "/account/keys?per_page=200&page=1") return { ssh_keys: page1 };
      if (path === "/account/keys?per_page=200&page=2")
        return { ssh_keys: [{ id: 999, public_key: sshPub }] };
      if (path === "/droplets")
        return { droplet: { id: 43, name: "web-2", networks: { v4: [] } } };
      return {};
    }) as Mock;
    const ctx = { fetch, credentials: {} } as DoCreateContext;
    const result = await doCreateResource(ctx, "droplet", "acc", {
      name: "web-2",
      region: "nyc3",
      size: "s-1vcpu-1gb",
      image: "ubuntu-22-04-x64",
      sshPublicKey: sshPub,
    });
    expect(result.resource.id).toBe("acc:droplet:43");
    expect(fetch).toHaveBeenCalledWith("/account/keys?per_page=200&page=2");
    expect(fetch).toHaveBeenCalledWith(
      "/droplets",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"ssh_keys":[999]'),
      }),
    );
  });

  it("fails droplet creation when the duplicate SSH key cannot be found on any page", async () => {
    const fetch = vi.fn(async (path: string, init?: { method?: string }) => {
      if (path === "/account/keys" && init?.method === "POST") {
        throw new Error("DigitalOcean API 422: SSH Key is already in use on your account");
      }
      if (path.startsWith("/account/keys?"))
        return { ssh_keys: [{ id: 1, public_key: "ssh-ed25519 OTHER other" }] };
      return {};
    }) as Mock;
    const ctx = { fetch, credentials: {} } as DoCreateContext;
    await expect(
      doCreateResource(ctx, "droplet", "acc", {
        name: "web-3",
        region: "nyc3",
        size: "s-1vcpu-1gb",
        image: "ubuntu-22-04-x64",
        sshPublicKey: "ssh-ed25519 AAAA comment",
      }),
    ).rejects.toThrow(/Failed to attach SSH key/);
    expect(fetch).not.toHaveBeenCalledWith("/droplets", expect.anything());
  });

  it("creates a droplet and an extra attached volume when addExtraDisk is set", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (path: string) => {
      calls.push(path);
      if (path === "/droplets") return { droplet: { id: 7, name: "w", networks: { v4: [] } } };
      return {};
    }) as Mock;
    const ctx = { fetch, credentials: {} } as DoCreateContext;
    await doCreateResource(ctx, "droplet", "acc", {
      name: "w",
      region: "nyc3",
      size: "s",
      image: "i",
      addExtraDisk: "true",
      extraDiskSizeGb: "50",
    });
    expect(calls).toContain("/volumes");
  });

  it("records a warning when project assignment fails", async () => {
    const fetch = vi.fn(async (path: string) => {
      if (path === "/droplets") return { droplet: { id: 9, name: "w", networks: { v4: [] } } };
      if (path.endsWith("/resources")) throw new Error("nope");
      return {};
    }) as Mock;
    const ctx = { fetch, credentials: {} } as DoCreateContext;
    const result = await doCreateResource(
      ctx,
      "droplet",
      "acc",
      { name: "w", region: "nyc3", size: "s", image: "i" },
      "acc:project:proj-2",
    );
    expect(result.warnings.some((w) => w.code === "do.project-assignment-failed")).toBe(true);
  });

  it("creates a DOKS cluster", async () => {
    const fetch = vi.fn(async (path: string) => {
      if (path === "/kubernetes/clusters")
        return {
          kubernetes_cluster: {
            id: "k-1",
            name: "kube",
            region: "nyc3",
            version: "1.29.1-do.0",
            endpoint: "https://k.example",
            node_pools: [{ size: "s-2vcpu-4gb", count: 3 }],
          },
        };
      return {};
    }) as Mock;
    const ctx = { fetch, credentials: {} } as DoCreateContext;
    const result = await doCreateResource(ctx, "doks-cluster", "acc", {
      name: "kube",
      region: "nyc3",
      version: "1.29.1-do.0",
      nodePoolSize: "s-2vcpu-4gb",
      nodeCount: "3",
    });
    expect(result.resource.id).toBe("acc:doks-cluster:k-1");
    expect(result.resource.resolvedOutputs.clusterEndpoint).toBe("https://k.example");
  });

  it("creates a managed database", async () => {
    const fetch = vi.fn(async (path: string) => {
      if (path === "/databases")
        return {
          database: {
            id: "db-1",
            name: "pgcluster",
            engine: "pg",
            version: "16",
            region: "nyc3",
            size: "db-s-1vcpu-1gb",
            num_nodes: 1,
          },
        };
      return {};
    }) as Mock;
    const ctx = { fetch, credentials: {} } as DoCreateContext;
    const result = await doCreateResource(ctx, "managed-database", "acc", {
      name: "pgcluster",
      engine: "pg",
      region: "nyc3",
      size: "db-s-1vcpu-1gb",
      nodeCount: "1",
    });
    expect(result.resource.id).toBe("acc:managed-database:db-1");
  });

  it("creates a db-user and captures its password as a secret", async () => {
    const fetch = vi.fn(async (path: string) => {
      if (path === "/databases/db-1") return { database: { engine: "pg" } };
      if (path === "/databases/db-1/users")
        return { user: { name: "infrawrench-x", role: "normal", password: "s3cret" } };
      return {};
    }) as Mock;
    const ctx = { fetch, credentials: {} } as DoCreateContext;
    const result = await doCreateResource(
      ctx,
      "db-user",
      "acc",
      { name: "infrawrench-x" },
      "acc:managed-database:db-1",
    );
    expect(result.resource.id).toBe("acc:db-user:db-1:infrawrench-x");
    expect(result.resource.secretStates[0]).toMatchObject({
      fieldKey: "password",
      resolution: { kind: "plaintext", value: "s3cret" },
    });
  });

  it("db-user sends a Kafka ACL settings block for kafka clusters", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/databases/db-k") return { database: { engine: "kafka" } };
      if (path === "/databases/db-k/users") {
        bodies.push(JSON.parse(init!.body as string));
        return { user: { name: "kuser", password: "pw" } };
      }
      return {};
    }) as Mock;
    const ctx = { fetch, credentials: {} } as DoCreateContext;
    await doCreateResource(
      ctx,
      "db-user",
      "acc",
      { name: "kuser", topic: "events", permission: "produce" },
      "acc:managed-database:db-k",
    );
    expect(bodies[0]).toMatchObject({
      name: "kuser",
      settings: { acl: [{ topic: "events", permission: "produce" }] },
    });
  });

  it("db-user requires a parent cluster", async () => {
    const ctx = { fetch: vi.fn(), credentials: {} } as unknown as DoCreateContext;
    await expect(doCreateResource(ctx, "db-user", "acc", { name: "x" })).rejects.toThrow(
      /must be created from a managed-database/,
    );
  });

  it("db-user throws when DO returns no password", async () => {
    const fetch = vi.fn(async (path: string) => {
      if (path === "/databases/db-1") return { database: { engine: "pg" } };
      if (path === "/databases/db-1/users") return { user: { name: "u" } };
      return {};
    }) as Mock;
    const ctx = { fetch, credentials: {} } as DoCreateContext;
    await expect(
      doCreateResource(ctx, "db-user", "acc", { name: "u" }, "acc:managed-database:db-1"),
    ).rejects.toThrow(/did not return a password/);
  });

  it("creates a domain", async () => {
    const fetch = vi.fn(async () => ({
      domain: { name: "example.com", ttl: 1800, zone_file: "; zone" },
    })) as Mock;
    const ctx = { fetch, credentials: {} } as DoCreateContext;
    const result = await doCreateResource(ctx, "domain", "acc", { name: "example.com" });
    expect(result.resource.id).toBe("acc:domain:example.com");
  });

  it("creates a dns-record under a domain", async () => {
    const fetch = vi.fn(async () => ({
      domain_record: { id: 33, type: "A", name: "www", data: "1.2.3.4", ttl: 1800 },
    })) as Mock;
    const ctx = { fetch, credentials: {} } as DoCreateContext;
    const result = await doCreateResource(
      ctx,
      "dns-record",
      "acc",
      { type: "A", name: "www", data: "1.2.3.4", ttl: "1800" },
      "acc:domain:example.com",
    );
    expect(result.resource.id).toBe("acc:dns-record:example.com/33");
    expect(result.resource.displayName).toBe("A www.example.com");
  });

  it("dns-record requires a domain name", async () => {
    const ctx = { fetch: vi.fn(), credentials: {} } as unknown as DoCreateContext;
    await expect(
      doCreateResource(ctx, "dns-record", "acc", { type: "A", name: "x", data: "1.1.1.1" }),
    ).rejects.toThrow(/domainName is required/);
  });

  it("creates a project", async () => {
    const fetch = vi.fn(async () => ({
      project: { id: "p-9", name: "Proj", purpose: "API", environment: "Production" },
    })) as Mock;
    const ctx = { fetch, credentials: {} } as DoCreateContext;
    const result = await doCreateResource(ctx, "project", "acc", {
      name: "Proj",
      purpose: "API",
      environment: "Production",
    });
    expect(result.resource.id).toBe("acc:project:p-9");
  });

  it("creates a volume", async () => {
    const fetch = vi.fn(async (path: string) => {
      if (path === "/volumes")
        return {
          volume: { id: "vol-1", name: "data", region: { slug: "nyc3" }, size_gigabytes: 50 },
        };
      return {};
    }) as Mock;
    const ctx = { fetch, credentials: {} } as DoCreateContext;
    const result = await doCreateResource(ctx, "volume", "acc", {
      name: "data",
      region: "nyc3",
      sizeGb: "50",
      filesystemType: "ext4",
    });
    expect(result.resource.id).toBe("acc:volume:vol-1");
    expect(result.resource.fields.sizeGb).toBe(50);
  });

  it("creates an nfs-share", async () => {
    const fetch = vi.fn(async (path: string) => {
      if (path === "/nfs")
        return {
          nfs: { id: "nfs-1", name: "share", size_gib: 50, status: "creating", vpc_ids: ["vpc-1"] },
        };
      return {};
    }) as Mock;
    const ctx = { fetch, credentials: {} } as DoCreateContext;
    const result = await doCreateResource(ctx, "nfs-share", "acc", {
      name: "share",
      region: "nyc3",
      sizeGib: "50",
      performanceTier: "standard",
      vpcId: "vpc-1",
    });
    expect(result.resource.id).toBe("acc:nfs-share:nyc3/nfs-1");
  });

  it("creates a gen-ai-agent with a foundation model, auto-creating a workspace", async () => {
    const fetch = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/gen-ai/workspaces" && init?.method === "POST")
        return { workspace: { uuid: "ws-new" } };
      if (path === "/gen-ai/workspaces") return { workspaces: [] };
      if (path === "/gen-ai/agents")
        return {
          agent: {
            uuid: "agent-1",
            name: "A1",
            region: "tor1",
            deployment: { url: "https://a.example", status: "running" },
          },
        };
      return {};
    }) as Mock;
    const ctx = { fetch, credentials: {} } as DoCreateContext;
    const result = await doCreateResource(ctx, "gen-ai-agent", "acc", {
      name: "A1",
      region: "tor1",
      modelSource: "model",
      modelUuid: "model-1",
    });
    expect(result.resource.id).toBe("acc:gen-ai-agent:agent-1");
    expect(result.resource.resolvedOutputs.deploymentUrl).toBe("https://a.example");
  });

  it("gen-ai-agent throws when no model source is chosen", async () => {
    const ctx = { fetch: vi.fn(async () => ({})), credentials: {} } as DoCreateContext;
    await expect(
      doCreateResource(ctx, "gen-ai-agent", "acc", {
        name: "A",
        region: "tor1",
        modelSource: "model",
      }),
    ).rejects.toThrow(/Pick a Foundation Model/);
  });

  it("creates a gen-ai-knowledge-base", async () => {
    const fetch = vi.fn(async (path: string) => {
      if (path === "/gen-ai/knowledge_bases")
        return { knowledge_base: { uuid: "kb-1", name: "KB", region: "tor1" } };
      return {};
    }) as Mock;
    const ctx = { fetch, credentials: {} } as DoCreateContext;
    const result = await doCreateResource(ctx, "gen-ai-knowledge-base", "acc", {
      name: "KB",
      region: "tor1",
      embeddingModelUuid: "model-1",
      tags: "a, b",
    });
    expect(result.resource.id).toBe("acc:gen-ai-knowledge-base:kb-1");
    expect(result.resource.resolvedOutputs.retrievalEndpoint).toContain("kb-1");
  });

  it("creates a gen-ai-model-router applying a preset config", async () => {
    const fetch = vi.fn(async (path: string) => {
      if (path.startsWith("/gen-ai/models/routers/presets"))
        return {
          presets: [{ slug: "balanced", config: { fallback_models: ["m1"], policies: [{}] } }],
        };
      if (path === "/gen-ai/models/routers")
        return {
          model_router: {
            uuid: "r-1",
            name: "R",
            config: { fallback_models: ["m1"], policies: [{}] },
          },
        };
      return {};
    }) as Mock;
    const ctx = { fetch, credentials: {} } as DoCreateContext;
    const result = await doCreateResource(ctx, "gen-ai-model-router", "acc", {
      name: "R",
      presetSlug: "balanced",
    });
    expect(result.resource.id).toBe("acc:gen-ai-model-router:r-1");
    expect(result.resource.fields.fallbackModels).toBe("m1");
  });

  it("creates a dedicated-inference deployment", async () => {
    const fetch = vi.fn(async (path: string) => {
      if (path === "/dedicated-inferences")
        return { dedicated_inference: { id: "di-1", region: "nyc3", status: "provisioning" } };
      return {};
    }) as Mock;
    const ctx = { fetch, credentials: {} } as DoCreateContext;
    const result = await doCreateResource(ctx, "dedicated-inference", "acc", {
      name: "infer",
      region: "nyc3",
      size: "gpu-1",
      modelId: "m-1",
      enablePublicEndpoint: "true",
    });
    expect(result.resource.id).toBe("acc:dedicated-inference:di-1");
  });

  it("creates an agent-api-key from an agent detail page and captures the secret", async () => {
    const fetch = vi.fn(async (path: string) => {
      if (path === "/gen-ai/agents/agent-1/api_keys")
        return { api_key_info: { uuid: "key-1", name: "k", secret_key: "sk-shh" } };
      return {};
    }) as Mock;
    const ctx = { fetch, credentials: {} } as DoCreateContext;
    const result = await doCreateResource(
      ctx,
      "agent-api-key",
      "acc",
      { name: "k" },
      "acc:gen-ai-agent:agent-1",
    );
    expect(result.resource.id).toBe("acc:agent-api-key:agent-1/key-1");
    expect(result.resource.secretStates[0]).toMatchObject({
      resolution: { kind: "plaintext", value: "sk-shh" },
    });
  });

  it("agent-api-key requires an agent uuid", async () => {
    const ctx = { fetch: vi.fn(async () => ({})), credentials: {} } as DoCreateContext;
    await expect(doCreateResource(ctx, "agent-api-key", "acc", { name: "k" })).rejects.toThrow(
      /Agent UUID is required/,
    );
  });

  it("throws for an unsupported create type", async () => {
    const ctx = { fetch: vi.fn(async () => ({})), credentials: {} } as DoCreateContext;
    await expect(doCreateResource(ctx, "bogus", "acc", {})).rejects.toThrow(
      /createResource not supported/,
    );
  });
});

describe("doCreateResource — spaces-bucket via signed S3 (global fetch mocked)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("PUTs the bucket with pre-existing Spaces credentials (no minting)", async () => {
    const okResponse = { ok: true, status: 200, text: async () => "" } as unknown as Response;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse);
    const ctx = {
      fetch: vi.fn(async () => ({})),
      credentials: { spacesAccessKeyId: "AK", spacesSecretAccessKey: "SK" },
    } as unknown as DoCreateContext;

    const result = await doCreateResource(ctx, "spaces-bucket", "acc", {
      name: "my-bucket",
      region: "nyc3",
    });
    expect(result.resource.id).toBe("acc:spaces-bucket:my-bucket");
    expect(result.resource.resolvedOutputs.endpoint).toBe(
      "https://my-bucket.nyc3.digitaloceanspaces.com",
    );
    expect(result.credentialUpdates).toBeUndefined();
    // a signed PUT went out via global fetch
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("mints a Spaces key when none exists and returns credentialUpdates", async () => {
    const okResponse = { ok: true, status: 200, text: async () => "" } as unknown as Response;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse);
    const ctx = {
      fetch: vi.fn(async (path: string) => {
        if (path === "/spaces/keys") return { key: { access_key: "NEW_AK", secret_key: "NEW_SK" } };
        return {};
      }),
      credentials: {},
    } as unknown as DoCreateContext;

    const promise = doCreateResource(ctx, "spaces-bucket", "acc", {
      name: "fresh-bucket",
      region: "nyc3",
    });
    // drive the propagation-probe sleeps (probe succeeds on the first attempt
    // here, so no sleep is hit, but advance to be safe)
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;
    expect(result.credentialUpdates).toEqual({
      spacesAccessKeyId: "NEW_AK",
      spacesSecretAccessKey: "NEW_SK",
    });
  });

  it("throws a helpful error when the bucket PUT keeps failing", async () => {
    const badResponse = {
      ok: false,
      status: 500,
      text: async () => "InternalError",
    } as unknown as Response;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(badResponse);
    const ctx = {
      fetch: vi.fn(async () => ({})),
      credentials: { spacesAccessKeyId: "AK", spacesSecretAccessKey: "SK" },
    } as unknown as DoCreateContext;
    await expect(
      doCreateResource(ctx, "spaces-bucket", "acc", { name: "b", region: "nyc3" }),
    ).rejects.toThrow(/Spaces S3 API error 500/);
  });
});
