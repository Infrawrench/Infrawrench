import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeConfig,
  discoverPlugins,
  DOCUMENT_KEYS,
  loadConfig,
  PATCH_KEYS,
  pluginDir,
} from "../config.js";
import { PluginGenError } from "../errors.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const single = { specUrl: "https://x.test/a.json", paths: { "/a": ["get"] } };

function problem(raw: unknown): string {
  try {
    decodeConfig("acme", raw);
  } catch (error) {
    if (error instanceof PluginGenError) {
      expect(error.kind).toBe("config");
      return error.message;
    }
    throw error;
  }
  throw new Error("expected the config to be rejected");
}

describe("decodeConfig", () => {
  it("reads one document into api-types.gen.ts", () => {
    const { documents } = decodeConfig("acme", {
      ...single,
      $schema: "x",
      pathPrefix: "/api/v4",
      patches: [{ pointer: "/a", value: null, why: "wrong" }],
    });
    expect(documents).toEqual([
      {
        fileName: "api-types.gen.ts",
        specUrl: single.specUrl,
        pathPrefix: "/api/v4",
        paths: { "/a": ["get"] },
        patches: [{ pointer: "/a", value: null, why: "wrong" }],
      },
    ]);
  });

  it("gives each named document its own file", () => {
    const { documents } = decodeConfig("acme", {
      documents: [
        { name: "cloud", ...single },
        { name: "v2010", ...single },
      ],
    });
    expect(documents.map((document) => document.fileName)).toEqual([
      "api-types.cloud.gen.ts",
      "api-types.v2010.gen.ts",
    ]);
  });

  it.each([
    [{ ...single, specUrl: "http://x.test/a" }, "acme/plugingen.json", "specUrl"],
    [{ paths: { "/a": ["get"] } }, "acme/plugingen.json", "specUrl"],
    [{ ...single, paths: { a: ["get"] } }, "acme/plugingen.json", 'paths["a"]'],
    [{ ...single, paths: { "/a": ["GET"] } }, "acme/plugingen.json", 'paths["/a"]'],
    [{ ...single, paths: {} }, "acme/plugingen.json", "paths"],
    [{ ...single, pathPrefix: "/api/" }, "acme/plugingen.json", "pathPrefix"],
    [{ ...single, extra: 1 }, "acme/plugingen.json", "extra"],
    [
      { ...single, patches: [{ pointer: "/a", value: 1, why: " " }] },
      "acme/plugingen.json",
      "patches[0].why",
    ],
    [
      { ...single, patches: [{ pointer: "a", value: 1, why: "x" }] },
      "acme/plugingen.json",
      "patches[0].pointer",
    ],
    [
      { ...single, patches: [{ pointer: "/a", why: "x" }] },
      "acme/plugingen.json",
      "patches[0].value",
    ],
    [{ documents: [] }, "acme/plugingen.json", "documents"],
    [{ documents: [{ ...single }] }, "acme/plugingen.json", "documents[0].name"],
    [{ documents: [{ ...single, name: "../evil" }] }, "acme/plugingen.json", "documents[0].name"],
    [{ documents: [{ ...single, name: "a" }], specUrl: "x" }, "acme/plugingen.json", "specUrl"],
  ])("names the plugin and the field for %j", (raw, plugin, field) => {
    const message = problem(raw);
    expect(message).toContain(plugin);
    expect(message).toContain(`${field}:`);
  });

  it("reports every problem at once", () => {
    const message = problem({ specUrl: "nope", paths: 1 });
    expect(message).toContain("specUrl:");
    expect(message).toContain("paths:");
  });
});

describe("plugingen.schema.json", () => {
  const schema: unknown = JSON.parse(
    fs.readFileSync(path.join(ROOT, "plugingen/plugingen.schema.json"), "utf8"),
  );

  it("names the same fields the decoder accepts", () => {
    const text = JSON.stringify(schema);
    for (const key of [...DOCUMENT_KEYS, ...PATCH_KEYS, "documents", "name", "$schema"]) {
      expect(text).toContain(`"${key}"`);
    }
    expect(Object.keys(single).every((key) => DOCUMENT_KEYS.includes(key))).toBe(true);
  });
});

describe("the checked-in configs", () => {
  const plugins = discoverPlugins(ROOT);

  it("includes the worked examples", () => {
    expect(plugins).toEqual(expect.arrayContaining(["gitlab", "hetzner", "twilio", "vercel"]));
  });

  it.each(plugins)("%s decodes and points at the schema", (plugin) => {
    expect(() => loadConfig(ROOT, plugin)).not.toThrow();
    const dir = pluginDir(ROOT, plugin);
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, "plugingen.json"), "utf8"));
    expect(raw).toMatchObject({ $schema: "../../../plugingen/plugingen.schema.json" });
    expect(fs.existsSync(path.join(dir, "../../../plugingen/plugingen.schema.json"))).toBe(true);
  });
});

describe("loadConfig", () => {
  it.each(["../evil", "Foo", "a/b", ""])("refuses %j as a plugin name", (name) => {
    expect(() => loadConfig(ROOT, name)).toThrow(/not a plugin name/);
  });

  it("says when a plugin has no config", () => {
    expect(() => loadConfig(ROOT, "no-such-plugin")).toThrow(
      /no-such-plugin has no plugingen.json/,
    );
  });
});
