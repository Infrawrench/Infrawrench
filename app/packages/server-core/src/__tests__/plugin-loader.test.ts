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

/**
 * `dependsOn.targetTypeId` / `targetPluginId` are plain strings — nothing in
 * the type system checks that they name a type that exists. A typo doesn't
 * fail to compile, it just silently produces no edge on the dependency graph,
 * which is invisible until someone notices a missing arrow. Validate the whole
 * registry at once instead.
 */
describe("dependsOn declarations", () => {
  it("only reference resource types that exist", async () => {
    const loaded = await loader.loadPlugins();
    const typesByPlugin = new Map(
      loaded.map((l) => [l.plugin.manifest.id, new Set(l.plugin.resourceTypes.map((t) => t.id))]),
    );

    const dangling: string[] = [];
    for (const { plugin } of loaded) {
      for (const type of plugin.resourceTypes) {
        for (const rule of type.dependsOn ?? []) {
          const where = `${plugin.manifest.id}/${type.id}.${rule.fieldKey}`;
          const targetPluginId = rule.targetPluginId ?? plugin.manifest.id;
          const targetTypes = typesByPlugin.get(targetPluginId);
          if (!targetTypes) {
            dangling.push(`${where} → unknown plugin "${targetPluginId}"`);
            continue;
          }
          if (rule.targetTypeId && !targetTypes.has(rule.targetTypeId)) {
            dangling.push(`${where} → unknown type "${targetPluginId}:${rule.targetTypeId}"`);
          }
        }
      }
    }
    expect(dangling).toEqual([]);
  });

  it("declare a field the type actually knows about, or an undeclared synced one", async () => {
    // A rule may legitimately name a field the lister writes without declaring
    // in `fields[]` (the bag is stored unfiltered), so this can't be a hard
    // equality check — but a rule whose field matches neither the declared
    // fields nor the outputs is almost certainly a typo.
    const loaded = await loader.loadPlugins();
    const suspicious: string[] = [];
    for (const { plugin } of loaded) {
      for (const type of plugin.resourceTypes) {
        for (const rule of type.dependsOn ?? []) {
          if (rule.from === "outputs") continue;
          const known =
            type.fields.some((f) => f.key === rule.fieldKey) ||
            type.outputs.some((o) => o.key === rule.fieldKey);
          if (!known) suspicious.push(`${plugin.manifest.id}/${type.id}.${rule.fieldKey}`);
        }
      }
    }
    // No exceptions: every rule names a declared field or output.
    expect(suspicious).toEqual([]);
  });

  it("only interpolate fields the type declares in matchTemplate", async () => {
    // Same silent-failure class as above, one level deeper: a typo inside
    // `{…}` makes the host abort the composition on every row, so the rule
    // yields nothing forever — no compile error, no runtime error, just a
    // missing arrow. Nothing else validates these names.
    const loaded = await loader.loadPlugins();
    const bad: string[] = [];
    for (const { plugin } of loaded) {
      for (const type of plugin.resourceTypes) {
        for (const rule of type.dependsOn ?? []) {
          if (!rule.matchTemplate) continue;
          const placeholders = [...rule.matchTemplate.matchAll(/\{([^{}]+)\}/g)].map((m) =>
            (m[1] ?? "").trim(),
          );
          if (placeholders.length === 0) {
            bad.push(`${plugin.manifest.id}/${type.id}.${rule.fieldKey}: template has no {…}`);
            continue;
          }
          for (const name of placeholders) {
            // A template reads one bag — `outputs` when the rule says so,
            // `fields` otherwise — so validate against the one it will read.
            const known =
              rule.from === "outputs"
                ? type.outputs.some((o) => o.key === name)
                : type.fields.some((f) => f.key === name);
            if (!known) {
              bad.push(`${plugin.manifest.id}/${type.id}.${rule.fieldKey}: {${name}}`);
            }
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

/**
 * Same silent-failure class as `dependsOn`: an `expiryFields` rule over a
 * field the lister never stores simply yields no item on the expiry radar —
 * no compile error, no runtime error, just a deadline nobody is watching.
 */
describe("expiryFields declarations", () => {
  it("declare a field the type actually knows about", async () => {
    const loaded = await loader.loadPlugins();
    const suspicious: string[] = [];
    for (const { plugin } of loaded) {
      for (const type of plugin.resourceTypes) {
        for (const rule of type.expiryFields ?? []) {
          const known = type.fields.some((f) => f.key === rule.fieldKey);
          if (!known) suspicious.push(`${plugin.manifest.id}/${type.id}.${rule.fieldKey}`);
        }
      }
    }
    expect(suspicious).toEqual([]);
  });

  it("only set an age budget on from:'created' rules", async () => {
    const loaded = await loader.loadPlugins();
    const bad: string[] = [];
    for (const { plugin } of loaded) {
      for (const type of plugin.resourceTypes) {
        for (const rule of type.expiryFields ?? []) {
          if (rule.from !== "created" && rule.maxAgeDays !== undefined) {
            bad.push(`${plugin.manifest.id}/${type.id}.${rule.fieldKey}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
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
