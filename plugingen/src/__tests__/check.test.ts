import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPlugin, checkPlugins, exitCodeFor, type CheckReport } from "../check.js";
import { PluginGenError } from "../errors.js";
import type { FetchText } from "../fetching.js";
import { generatePlugin } from "../generate.js";
import { decodeConfig } from "../config.js";

const URL_A = "https://vendor.test/a.json";
const URL_B = "https://vendor.test/b.json";

const document = (type: string, route = "/a"): string =>
  JSON.stringify({
    openapi: "3.1.0",
    info: { title: "x", version: "1" },
    paths: {
      [route]: {
        get: {
          operationId: "get",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": { schema: { type: "object", properties: { v: { type } } } },
              },
            },
          },
        },
      },
    },
  });

let root: string;

function pluginDir(plugin: string): string {
  return path.join(root, "plugin-architecture/packages", plugin);
}

/** Lays out a plugin whose committed types came from `commitWith`. */
async function layOut(plugin: string, config: object, commitWith: FetchText): Promise<void> {
  fs.mkdirSync(path.join(pluginDir(plugin), "src"), { recursive: true });
  fs.writeFileSync(path.join(pluginDir(plugin), "plugingen.json"), JSON.stringify(config));
  const files = await generatePlugin(decodeConfig(plugin, config), commitWith, { silent: true });
  for (const file of files) {
    fs.writeFileSync(path.join(pluginDir(plugin), "src", file.fileName), file.text);
  }
}

const one = { specUrl: URL_A, paths: { "/a": ["get"] } };
const serve =
  (text: string): FetchText =>
  () =>
    Promise.resolve(text);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "plugingen-check-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function snapshot(): string {
  const dir = pluginDir("acme");
  return fs
    .readdirSync(path.join(dir, "src"))
    .map((name) => `${name}:${fs.readFileSync(path.join(dir, "src", name), "utf8")}`)
    .join("\n");
}

describe("checkPlugin", () => {
  it("is up to date when regenerating changes nothing, and writes nothing", async () => {
    await layOut("acme", one, serve(document("string")));
    const before = snapshot();
    const { report, changedFiles } = await checkPlugin(root, "acme", serve(document("string")));
    expect(report).toMatchObject({ status: "up-to-date", specUrls: [URL_A] });
    expect(changedFiles).toEqual([]);
    expect(snapshot()).toBe(before);
    expect(exitCodeFor([report])).toBe(0);
  });

  it("reports a change with the operation it affects, and still writes nothing", async () => {
    await layOut("acme", one, serve(document("string")));
    const before = snapshot();
    const { report, changedFiles } = await checkPlugin(root, "acme", serve(document("number")));
    expect(report).toMatchObject({ status: "changed", operations: ["GET /a"] });
    expect(changedFiles.map((file) => file.fileName)).toEqual(["api-types.gen.ts"]);
    expect(changedFiles[0]?.text).toContain("v?: number");
    expect(snapshot()).toBe(before);
    expect(exitCodeFor([report])).toBe(1);
  });

  it("says so when a vendor change does not touch what the plugin lists", async () => {
    await layOut("acme", one, serve(document("string")));
    const parsed: unknown = JSON.parse(document("string"));
    const unrelated = JSON.stringify({
      ...Object(parsed),
      paths: {
        ...Object(parsed).paths,
        "/other": { get: { responses: { "200": { description: "x" } } } },
      },
    });
    const { report } = await checkPlugin(root, "acme", serve(unrelated));
    expect(report.status).toBe("up-to-date");
  });

  it("reports a file that does not exist yet as changed", async () => {
    await layOut("acme", one, serve(document("string")));
    fs.rmSync(path.join(pluginDir("acme"), "src/api-types.gen.ts"));
    const { report } = await checkPlugin(root, "acme", serve(document("string")));
    expect(report).toMatchObject({ status: "changed", operations: [] });
  });

  it.each<[string, FetchText, string, boolean]>([
    [
      "a network failure",
      () => Promise.reject(new PluginGenError("network", "down")),
      "network",
      true,
    ],
    [
      "a document that moved",
      () => Promise.reject(new PluginGenError("unavailable", "answered 404")),
      "unavailable",
      false,
    ],
    ["a document that no longer parses", serve("<html>"), "parse", false],
    ["an operation removed", serve(document("string", "/moved")), "operation-removed", false],
    ["anything unforeseen", () => Promise.reject(new Error("boom")), "generator", false],
  ])("cannot check after %s", async (_name, fetchText, failure, transient) => {
    await layOut("acme", one, serve(document("string")));
    const { report, changedFiles } = await checkPlugin(root, "acme", fetchText);
    expect(report).toMatchObject({ status: "could-not-check", failure, transient });
    expect(changedFiles).toEqual([]);
    expect(exitCodeFor([report])).toBe(2);
  });

  it("cannot check when a patch no longer applies", async () => {
    await layOut("acme", one, serve(document("string")));
    fs.writeFileSync(
      path.join(pluginDir("acme"), "plugingen.json"),
      JSON.stringify({
        ...one,
        patches: [{ pointer: "/paths/~1gone/get", value: {}, why: "test" }],
      }),
    );
    const { report } = await checkPlugin(root, "acme", serve(document("string")));
    expect(report).toMatchObject({ failure: "patch", transient: false });
  });

  it("names the plugin and the field for a bad config", async () => {
    await layOut("acme", one, serve(document("string")));
    fs.writeFileSync(path.join(pluginDir("acme"), "plugingen.json"), `{"specUrl":"x","paths":{}}`);
    const { report } = await checkPlugin(root, "acme", serve(document("string")));
    expect(report).toMatchObject({
      status: "could-not-check",
      failure: "config",
      transient: false,
    });
    expect(report.reason).toContain("acme/plugingen.json");
    expect(report.reason).toContain("specUrl");
  });

  it("flattens a multi-line reason, so a log cannot be handed a new line", async () => {
    await layOut("acme", one, serve(document("string")));
    const fetchText: FetchText = () =>
      Promise.reject(new PluginGenError("parse", "bad\n::error::injected"));
    const { report } = await checkPlugin(root, "acme", fetchText);
    expect(report.reason).toBe("bad ::error::injected");
  });

  describe("with several documents", () => {
    const two = {
      documents: [
        { name: "a", specUrl: URL_A, paths: { "/a": ["get"] } },
        { name: "b", specUrl: URL_B, paths: { "/a": ["get"] } },
      ],
    };
    const route =
      (a: () => Promise<string>, b: () => Promise<string>): FetchText =>
      (url) =>
        url === URL_A ? a() : b();

    it("reports only the file that changed", async () => {
      await layOut("acme", two, serve(document("string")));
      const { report, changedFiles } = await checkPlugin(
        root,
        "acme",
        route(
          () => Promise.resolve(document("string")),
          () => Promise.resolve(document("number")),
        ),
      );
      expect(report.status).toBe("changed");
      expect(changedFiles.map((file) => file.fileName)).toEqual(["api-types.b.gen.ts"]);
      expect(report.documents.map((document) => document.status)).toEqual([
        "up-to-date",
        "changed",
      ]);
    });

    it("does not call a change on one document news when the other is unreachable", async () => {
      await layOut("acme", two, serve(document("string")));
      const { report } = await checkPlugin(
        root,
        "acme",
        route(
          () => Promise.resolve(document("number")),
          () => Promise.reject(new PluginGenError("network", "down")),
        ),
      );
      expect(report).toMatchObject({ status: "could-not-check", transient: true });
    });

    it("lets a lasting failure outrank a transient one", async () => {
      await layOut("acme", two, serve(document("string")));
      const { report } = await checkPlugin(
        root,
        "acme",
        route(
          () => Promise.reject(new PluginGenError("network", "down")),
          () => Promise.reject(new PluginGenError("unavailable", "answered 404")),
        ),
      );
      expect(report).toMatchObject({ failure: "unavailable", transient: false });
      expect(report.reason).toContain("down");
      expect(report.reason).toContain("404");
    });
  });
});

describe("checkPlugins", () => {
  it("does not let one vendor being down stop the others", async () => {
    await layOut("down", one, serve(document("string")));
    await layOut("fine", { ...one, specUrl: URL_B }, serve(document("string")));
    const fetchText: FetchText = (url) =>
      url === URL_A
        ? Promise.reject(new PluginGenError("network", "down"))
        : Promise.resolve(document("number"));
    const outcomes = await checkPlugins(root, ["down", "fine"], fetchText, 2);
    expect(outcomes.map((outcome) => outcome.report.status)).toEqual([
      "could-not-check",
      "changed",
    ]);
  });

  it("reports an unknown plugin rather than throwing", async () => {
    const [outcome] = await checkPlugins(root, ["nope"], serve(""), 1);
    expect(outcome?.report).toMatchObject({ status: "could-not-check", failure: "config" });
  });
});

describe("exitCodeFor", () => {
  const report = (status: CheckReport["status"]): CheckReport => ({
    plugin: "x",
    status,
    reason: "",
    specUrls: [],
    documents: [],
  });

  it("lets the worst result win", () => {
    expect(exitCodeFor([])).toBe(0);
    expect(exitCodeFor([report("up-to-date"), report("changed")])).toBe(1);
    expect(exitCodeFor([report("changed"), report("could-not-check")])).toBe(2);
  });
});
