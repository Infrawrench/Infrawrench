import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { MONACO_CDN_BASE, RENDERER_CSP, RENDERER_CSP_DIRECTIVES } from "../renderer-csp";

// vitest's cwd is the desktop package root (`electron/` builds to CJS, so no
// import.meta here).
const DESKTOP_DIR = process.cwd();

function directive(name: string): string {
  const found = RENDERER_CSP_DIRECTIVES.find(([k]) => k === name);
  if (!found) throw new Error(`no ${name} directive`);
  return found[1];
}

describe("renderer CSP", () => {
  it("allows no inline script and no eval", () => {
    const script = directive("script-src");
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
    expect(script).not.toMatch(/(^|\s)(https?:|\*)(\s|$)/);
    expect(directive("object-src")).toBe("'none'");
    expect(directive("base-uri")).toBe("'none'");
  });

  it("pins jsDelivr to the Monaco build @monaco-editor/loader actually fetches", () => {
    // The editors load Monaco from the CDN at runtime; if the loader is
    // upgraded and its default version moves, the CSP would silently block
    // every editor. Read the default straight from the installed loader.
    const uiRequire = createRequire(join(DESKTOP_DIR, "../ui/package.json"));
    const reactPkg = uiRequire.resolve("@monaco-editor/react/package.json");
    const loaderPkg = createRequire(reactPkg).resolve("@monaco-editor/loader/package.json");
    const config = readFileSync(join(dirname(loaderPkg), "lib/cjs/config/index.js"), "utf8");
    const vs = /vs:\s*['"]([^'"]+)['"]/.exec(config)?.[1];
    expect(vs).toBeDefined();
    expect(`${vs}/`.startsWith(MONACO_CDN_BASE)).toBe(true);
    expect(MONACO_CDN_BASE.endsWith("/")).toBe(true);
  });

  it("is injected by the renderer build, and index.html has no inline script", () => {
    const config = readFileSync(join(DESKTOP_DIR, "electron.vite.config.ts"), "utf8");
    expect(config).toMatch(/rendererCsp\(\)/);
    const html = readFileSync(join(DESKTOP_DIR, "index.html"), "utf8");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(RENDERER_CSP).toContain("default-src 'self'");
  });
});
