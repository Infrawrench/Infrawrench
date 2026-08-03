import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The desktop plugin loader pulls in ~30 plugin packages and env. All are
// mocked so the loader's validation/filter logic can be exercised in
// isolation.

const safeParse = vi.fn();
vi.mock("@infrawrench/plugin-base", () => ({
  pluginManifestSchema: { safeParse: (m: unknown) => safeParse(m) },
  validatePreflightContract: () => null,
}));

let disabled: string[] = [];
let enabledResourceTypes: Record<string, string[]> = {};
vi.mock("../../../env", () => ({
  get DISABLED_PLUGINS() {
    return disabled;
  },
  get ENABLED_RESOURCE_TYPES() {
    return enabledResourceTypes;
  },
}));

const awsPlugin = {
  manifest: { id: "aws" },
  resourceTypes: [{ id: "ec2" }, { id: "s3" }],
};
const pgPlugin = {
  manifest: { id: "postgres" },
  resourceTypes: [{ id: "table" }],
};

vi.mock("@infrawrench/plugin-aws", () => ({ plugin: awsPlugin }));
vi.mock("@infrawrench/plugin-postgres", () => ({ plugin: pgPlugin }));
// Stub every other statically-listed dynamic import so the module graph
// resolves. `vi.mock` is hoisted and requires literal specifiers, hence the
// explicit list.
const stub = (id: string) => ({ plugin: { manifest: { id }, resourceTypes: [] } });
vi.mock("@infrawrench/plugin-digitalocean", () => stub("digitalocean"));
vi.mock("@infrawrench/plugin-docker", () => stub("docker"));
vi.mock("@infrawrench/plugin-gcp", () => stub("gcp"));
vi.mock("@infrawrench/plugin-hetzner", () => stub("hetzner"));
vi.mock("@infrawrench/plugin-kafka", () => stub("kafka"));
vi.mock("@infrawrench/plugin-kubernetes", () => stub("kubernetes"));
vi.mock("@infrawrench/plugin-memcached", () => stub("memcached"));
vi.mock("@infrawrench/plugin-mongodb", () => stub("mongodb"));
vi.mock("@infrawrench/plugin-mysql", () => stub("mysql"));
vi.mock("@infrawrench/plugin-mssql", () => stub("mssql"));
vi.mock("@infrawrench/plugin-neon", () => stub("neon"));
vi.mock("@infrawrench/plugin-redis", () => stub("redis"));
vi.mock("@infrawrench/plugin-scaleway", () => stub("scaleway"));
vi.mock("@infrawrench/plugin-ssh", () => stub("ssh"));
vi.mock("@infrawrench/plugin-cloudflare", () => stub("cloudflare"));
vi.mock("@infrawrench/plugin-ovh", () => stub("ovh"));
vi.mock("@infrawrench/plugin-databricks", () => stub("databricks"));
vi.mock("@infrawrench/plugin-turso", () => stub("turso"));
vi.mock("@infrawrench/plugin-planetscale", () => stub("planetscale"));
vi.mock("@infrawrench/plugin-azure", () => stub("azure"));
vi.mock("@infrawrench/plugin-fly", () => stub("fly"));
vi.mock("@infrawrench/plugin-vercel", () => stub("vercel"));
vi.mock("@infrawrench/plugin-netlify", () => stub("netlify"));
vi.mock("@infrawrench/plugin-cloudinary", () => stub("cloudinary"));
vi.mock("@infrawrench/plugin-clickhouse", () => stub("clickhouse"));
vi.mock("@infrawrench/plugin-opensearch", () => stub("opensearch"));
vi.mock("@infrawrench/plugin-xai", () => stub("xai"));
vi.mock("@infrawrench/plugin-together", () => stub("together"));
vi.mock("@infrawrench/plugin-speechmatics", () => stub("speechmatics"));
vi.mock("@infrawrench/plugin-revai", () => stub("revai"));
vi.mock("@infrawrench/plugin-replicate", () => stub("replicate"));
vi.mock("@infrawrench/plugin-openrouter", () => stub("openrouter"));
vi.mock("@infrawrench/plugin-openai", () => stub("openai"));
vi.mock("@infrawrench/plugin-mistral", () => stub("mistral"));
vi.mock("@infrawrench/plugin-groq", () => stub("groq"));
vi.mock("@infrawrench/plugin-gladia", () => stub("gladia"));
vi.mock("@infrawrench/plugin-gemini", () => stub("gemini"));
vi.mock("@infrawrench/plugin-fireworks", () => stub("fireworks"));
vi.mock("@infrawrench/plugin-elevenlabs", () => stub("elevenlabs"));
vi.mock("@infrawrench/plugin-deepseek", () => stub("deepseek"));
vi.mock("@infrawrench/plugin-deepgram", () => stub("deepgram"));
vi.mock("@infrawrench/plugin-cohere", () => stub("cohere"));
vi.mock("@infrawrench/plugin-cartesia", () => stub("cartesia"));
vi.mock("@infrawrench/plugin-assemblyai", () => stub("assemblyai"));
vi.mock("@infrawrench/plugin-anthropic", () => stub("anthropic"));

beforeEach(() => {
  disabled = [];
  enabledResourceTypes = {};
  safeParse.mockReset();
  safeParse.mockReturnValue({ success: true });
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadPlugins", () => {
  it("loads all bundled plugins and caches the result", async () => {
    const { loadPlugins } = await import("../loader");
    const loaded = await loadPlugins();
    const ids = loaded.map((l) => l.plugin.manifest.id);
    expect(ids).toContain("aws");
    expect(ids).toContain("postgres");
    expect(ids).toContain("docker");
    expect(new Set(ids).size).toBe(ids.length);

    // cached — calling again returns the same array reference
    const again = await loadPlugins();
    expect(again).toBe(loaded);
  });

  it("skips disabled plugins by id", async () => {
    disabled = ["postgres"];
    const { loadPlugins } = await import("../loader");
    const loaded = await loadPlugins();
    const ids = loaded.map((l) => l.plugin.manifest.id);
    expect(ids).toContain("aws");
    expect(ids).not.toContain("postgres");
  });

  it("skips plugins whose manifest fails schema validation", async () => {
    safeParse.mockImplementation((m: { id: string }) =>
      m.id === "aws" ? { success: false } : { success: true },
    );
    const { loadPlugins } = await import("../loader");
    const loaded = await loadPlugins();
    const ids = loaded.map((l) => l.plugin.manifest.id);
    expect(ids).not.toContain("aws");
    expect(ids).toContain("postgres");
  });

  it("applies the resource-type allowlist", async () => {
    enabledResourceTypes = { aws: ["s3"] };
    const { loadPlugins } = await import("../loader");
    const loaded = await loadPlugins();
    const aws = loaded.find((l) => l.plugin.manifest.id === "aws")!;
    expect(aws.plugin.resourceTypes.map((r: { id: string }) => r.id)).toEqual(["s3"]);
  });

  it("getPlugin finds a loaded plugin by id and returns undefined otherwise", async () => {
    const { getPlugin } = await import("../loader");
    expect((await getPlugin("aws"))?.plugin.manifest.id).toBe("aws");
    expect(await getPlugin("nope")).toBeUndefined();
  });
});
