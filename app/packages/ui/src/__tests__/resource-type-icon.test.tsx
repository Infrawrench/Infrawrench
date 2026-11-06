import { existsSync, readFileSync } from "node:fs";
import { cwd } from "node:process";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  RESOURCE_ICON_KEYS,
  ResourceTypeIcon,
  inferIconKey,
} from "../components/icons/ResourceTypeIcon.js";

/**
 * The corner icon on every tile comes from `iconKey`, a word the plugin chooses.
 * Nothing at build time connects that word to a drawing, so a typo or a new word
 * would silently render the generic box. The edge registry is generated from
 * every bundled plugin, which makes it the one place to check them all from.
 */
function registryPath(): string {
  let dir = cwd();
  for (let up = 0; up < 10; up++) {
    if (existsSync(`${dir}/pnpm-workspace.yaml`)) {
      return `${dir}/app/packages/server-core/src/plugin-registry-edge.gen.json`;
    }
    dir = dir.slice(0, dir.lastIndexOf("/"));
  }
  throw new Error(`no pnpm-workspace.yaml above ${cwd()}`);
}

const { plugins } = JSON.parse(readFileSync(registryPath(), "utf8")) as {
  plugins: Array<{
    manifest: { id: string };
    resourceTypes: Array<{ id: string; iconKey?: string }>;
  }>;
};
const types = plugins.flatMap((p) =>
  p.resourceTypes.map((t) => ({ name: `${p.manifest.id}/${t.id}`, iconKey: t.iconKey })),
);

describe("plugin icon keys", () => {
  it("reads a registry with resource types in it", () => {
    expect(types.length).toBeGreaterThan(1000);
  });

  it("gives every resource type an icon key", () => {
    expect(types.filter((t) => !t.iconKey).map((t) => t.name)).toEqual([]);
  });

  it("draws every icon key a plugin uses", () => {
    const missing = types.filter((t) => t.iconKey && !(t.iconKey in RESOURCE_ICON_KEYS));
    expect(missing.map((t) => `${t.name} → ${t.iconKey}`)).toEqual([]);
  });
});

describe("ResourceTypeIcon", () => {
  it("draws the drawing for a known key", () => {
    const { container } = render(<ResourceTypeIcon iconKey="cpu" />);
    // Lucide's cpu is the only icon here built from two nested rects.
    expect(container.querySelectorAll("svg rect")).toHaveLength(2);
  });

  it("falls back to a box rather than rendering nothing", () => {
    const { container } = render(<ResourceTypeIcon iconKey="not-a-real-key" />);
    expect(container.querySelector("svg")?.children.length).toBeGreaterThan(0);
  });
});

describe("inferIconKey", () => {
  it("reads the noun, which comes last", () => {
    expect(inferIconKey("firestore-index")).toBe("index");
    expect(inferIconKey("database-user")).toBe("user");
  });

  it("gives up on an id with no word it knows", () => {
    expect(inferIconKey("frobnicator")).toBeUndefined();
    expect(inferIconKey(undefined)).toBeUndefined();
  });
});
