import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BUNDLED_PLUGINS } from "../plugin-registry";
import { serializePluginsForEdge } from "../plugin-registry-edge-format";
import { isGatewayOnlyError } from "../runtime/gateway-only";

const GEN = fileURLToPath(new URL("../plugin-registry-edge.gen.json", import.meta.url));

afterEach(() => {
  globalThis.__INFRAWRENCH_EDGE_PLUGINS__ = undefined;
});

describe("the web edge Worker's plugin registry", () => {
  it("is up to date with the bundled plugins", () => {
    // Stale means the edge serves old manifests. Fix:
    //   pnpm --filter @infrawrench/server-core generate:edge-plugins
    const committed = JSON.parse(readFileSync(GEN, "utf8"));
    expect(committed).toEqual(JSON.parse(JSON.stringify(serializePluginsForEdge(BUNDLED_PLUGINS))));
  });

  it("carries the same data and the same capabilities as the real plugins", async () => {
    const { EDGE_PLUGINS } = await import("../plugin-registry-edge");
    expect(EDGE_PLUGINS.map((p) => p.manifest.id)).toEqual(
      BUNDLED_PLUGINS.map((p) => p.manifest.id),
    );
    for (const [i, real] of BUNDLED_PLUGINS.entries()) {
      const edge = EDGE_PLUGINS[i]!;
      expect(edge.manifest).toEqual(JSON.parse(JSON.stringify(real.manifest)));
      expect(edge.resourceTypes).toEqual(JSON.parse(JSON.stringify(real.resourceTypes)));
      // A capability that exists on Node exists on the edge, so checks like
      // `if (plugin.policyTemplate)` answer the same.
      for (const key of Object.keys(real) as (keyof typeof real)[]) {
        expect(typeof edge[key], `${real.manifest.id}.${String(key)}`).toBe(typeof real[key]);
      }
    }
  });

  it("hands plugin code to the gateway", async () => {
    const { EDGE_PLUGINS } = await import("../plugin-registry-edge");
    const aws = EDGE_PLUGINS.find((p) => p.manifest.id === "aws")!;
    let caught: unknown;
    try {
      aws.createClient({});
    } catch (e) {
      caught = e;
    }
    expect(isGatewayOnlyError(caught)).toBe(true);
  });

  it("is what loadPlugins returns when the edge flag is defined", async () => {
    globalThis.__INFRAWRENCH_EDGE_PLUGINS__ = true;
    const { vi } = await import("vitest");
    vi.resetModules();
    const { loadPlugins } = await import("../plugin-loader");
    const loaded = await loadPlugins();
    expect(loaded.length).toBe(BUNDLED_PLUGINS.length);
    expect(() => loaded[0]!.plugin.createClient({})).toThrow(/\[gateway-only\]/);
  });
});
