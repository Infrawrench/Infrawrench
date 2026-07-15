import { beforeEach, describe, expect, it, vi } from "vitest";

let loader: typeof import("../plugin-loader");

// The first import transforms all 31 plugin packages; under a fully parallel
// `turbo test` run that can exceed the default 10s hook timeout.
beforeEach(async () => {
  vi.resetModules();
  loader = await import("../plugin-loader");
}, 60_000);

describe("loadPlugins", () => {
  it("loads a non-empty set of plugins", async () => {
    const loaded = await loader.loadPlugins();
    expect(loaded.length).toBeGreaterThan(0);
  });

  it("returns plugins with valid manifests and client factories", async () => {
    const loaded = await loader.loadPlugins();
    for (const { plugin } of loaded) {
      expect(plugin.manifest.id).toBeTruthy();
      expect(typeof plugin.createClient).toBe("function");
    }
  });

  it("includes well-known plugins (aws, postgres)", async () => {
    const loaded = await loader.loadPlugins();
    const ids = loaded.map((l) => l.plugin.manifest.id);
    expect(ids).toContain("aws");
    expect(ids).toContain("postgres");
  });

  it("caches the result (same array reference on repeated calls)", async () => {
    const a = await loader.loadPlugins();
    const b = await loader.loadPlugins();
    expect(a).toBe(b);
  });

  it("produces unique plugin ids", async () => {
    const loaded = await loader.loadPlugins();
    const ids = loaded.map((l) => l.plugin.manifest.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("getPlugin", () => {
  it("returns a loaded plugin by id", async () => {
    const p = await loader.getPlugin("aws");
    expect(p).toBeDefined();
    expect(p!.plugin.manifest.id).toBe("aws");
  });

  it("returns undefined for an unknown id", async () => {
    expect(await loader.getPlugin("does-not-exist")).toBeUndefined();
  });
});
