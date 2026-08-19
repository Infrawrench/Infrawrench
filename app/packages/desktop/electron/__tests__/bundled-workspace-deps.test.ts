import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `externalizeDepsPlugin` leaves every key of `dependencies` as a runtime
 * require, and electron-builder's `files` drops `node_modules/@infrawrench/**`
 * from the asar. A workspace package that is a `dependencies` entry and is not
 * in the main build's `exclude` list therefore throws "Cannot find module" the
 * moment the packaged app starts — a lit dock icon and no window, invisible in
 * dev because dev resolves through the real `node_modules`.
 *
 * This has shipped twice (`appstream-host`, then `appstream-core`, the latter
 * reached only transitively), so assert it rather than relying on the note in
 * CLAUDE.md.
 */
const pkgRoot = resolve(__dirname, "../..");

function workspaceRuntimeDeps(): string[] {
  const pkg = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(pkg.dependencies ?? {}).filter((name) => name.startsWith("@infrawrench/"));
}

function mainExcludeList(): string[] {
  const config = readFileSync(resolve(pkgRoot, "electron.vite.config.ts"), "utf8");
  // The main build is the first `externalizeDepsPlugin({ exclude: [...] })` in
  // the file; read its array literal rather than importing the config, which
  // would pull in the whole Vite plugin chain.
  const start = config.indexOf("exclude: [");
  expect(start).toBeGreaterThan(-1);
  const end = config.indexOf("]", start);
  return [...config.slice(start, end).matchAll(/"(@infrawrench\/[a-z0-9-]+)"/g)].map((m) => m[1]);
}

describe("main-process workspace dependencies", () => {
  it("bundles every @infrawrench package in `dependencies`", () => {
    const excluded = new Set(mainExcludeList());
    const missing = workspaceRuntimeDeps().filter((name) => !excluded.has(name));
    expect(missing).toEqual([]);
  });
});
