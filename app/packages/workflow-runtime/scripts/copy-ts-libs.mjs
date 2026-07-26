#!/usr/bin/env node
/**
 * Copies TypeScript's `lib.*.d.ts` standard-library declarations next to a
 * service's esbuild bundle.
 *
 * `typecheck.ts` builds a real `ts.Program` to give headless authors (the
 * MCP/chat `write_workflow` tool) the same diagnostics the Monaco editor
 * shows. esbuild bundles the compiler's *code*, but the lib declarations are
 * data files read from disk at runtime — and a bundled service can no longer
 * resolve the `typescript` package to find them. Without this copy the check
 * silently degrades to syntax-only (`degraded: true`).
 *
 * DOM libs are deliberately excluded: workflows run in QuickJS, and the editor
 * checks against `lib: ["es2020"]`.
 *
 * Usage (from a service package dir): node ../workflow-runtime/scripts/copy-ts-libs.mjs dist
 *
 * Resolution happens from this package, which declares `typescript` as a direct
 * dependency — service packages don't (and shouldn't) depend on it.
 */
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const libDir = dirname(require.resolve("typescript"));
const destDir = resolve(process.cwd(), process.argv[2] ?? "dist", "ts-libs");
mkdirSync(destDir, { recursive: true });

const wanted = readdirSync(libDir).filter((f) =>
  /^lib\.(es|decorators|scripthost).*\.d\.ts$/.test(f),
);
if (wanted.length === 0) {
  console.error(`no lib.*.d.ts found in ${libDir}`);
  process.exit(1);
}
for (const file of wanted) copyFileSync(join(libDir, file), join(destDir, file));
console.log(`copied ${wanted.length} TypeScript lib files -> ${destDir}`);
