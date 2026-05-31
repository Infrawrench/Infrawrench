import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The desktop plugin loader pulls in the blessed-plugins registry, ~30 plugin
// packages, and env. All are mocked so the loader's selection/validation/filter
// logic can be exercised in isolation.

const entries = [
  { id: "aws", packageName: "@infrawrench/plugin-aws" },
  { id: "docker", packageName: "@infrawrench/plugin-docker" },
  { id: "ghost", packageName: "@infrawrench/plugin-unmapped" }, // no module loader
  { id: "disabled-one", packageName: "@infrawrench/plugin-postgres" },
];

vi.mock("@blessed-plugins", () => ({ default: { entries } }));

const safeParse = vi.fn();
vi.mock("@infrawrench/plugin-base", () => ({
  pluginManifestSchema: { safeParse: (m: unknown) => safeParse(m) },
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
  manifest: { id: "disabled-one" },
  resourceTypes: [{ id: "table" }],
};

vi.mock("@infrawrench/plugin-aws", () => ({ plugin: awsPlugin }));
vi.mock("@infrawrench/plugin-postgres", () => ({ plugin: pgPlugin }));
// Stub every other statically-listed dynamic import so the module graph
// resolves; they are never reached for our entry list. `vi.mock` is hoisted
// and requires literal specifiers, hence the explicit list.
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
  it("loads valid plugins, skips unmapped package names, and caches", async () => {
    const { loadPlugins } = await import("../loader");
    const loaded = await loadPlugins();
    const ids = loaded.map((l) => l.plugin.manifest.id).sort();
    // ghost (no module loader) is skipped; aws + docker + postgres load.
    expect(ids).toEqual(["aws", "disabled-one", "docker"]);

    // cached — calling again returns the same array reference
    const again = await loadPlugins();
    expect(again).toBe(loaded);
  });

  it("skips disabled plugins by id", async () => {
    disabled = ["disabled-one"];
    const { loadPlugins } = await import("../loader");
    const loaded = await loadPlugins();
    // ghost has no module loader and disabled-one is disabled → aws + docker remain.
    expect(loaded.map((l) => l.plugin.manifest.id)).toEqual(["aws", "docker"]);
  });

  it("skips plugins whose manifest fails schema validation", async () => {
    safeParse.mockImplementation((m: { id: string }) =>
      m.id === "aws" ? { success: false } : { success: true },
    );
    const { loadPlugins } = await import("../loader");
    const loaded = await loadPlugins();
    // aws fails schema validation → docker + disabled-one remain.
    expect(loaded.map((l) => l.plugin.manifest.id)).toEqual(["docker", "disabled-one"]);
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
