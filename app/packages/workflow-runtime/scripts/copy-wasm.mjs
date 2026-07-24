#!/usr/bin/env node
/**
 * Copies the QuickJS wasmfile binary next to a service's esbuild bundle.
 *
 * The workflow sandbox uses `@jitl/quickjs-ng-wasmfile-release-asyncify`, whose
 * emscripten loader reads `emscripten-module.wasm` from disk next to the
 * emitted chunk (`__dirname + "/emscripten-module.wasm"`). esbuild bundles the
 * loader JS but not the binary asset, so every service that bundles the
 * sandbox (web, poller, github-watcher) must copy the wasm into its output
 * dir or workflow runs fail at runtime with ENOENT. The desktop app does the
 * same thing via the `copy-quickjs-wasm` plugin in electron.vite.config.ts.
 *
 * Usage (from a service package dir): node ../workflow-runtime/scripts/copy-wasm.mjs dist
 *
 * Resolution happens from this package, which declares the wasm variant as a
 * direct dependency — service packages don't (and shouldn't) depend on it.
 */
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const wasmPath = require.resolve("@jitl/quickjs-ng-wasmfile-release-asyncify/wasm");
const destDir = resolve(process.cwd(), process.argv[2] ?? "dist");
mkdirSync(destDir, { recursive: true });
copyFileSync(wasmPath, resolve(destDir, "emscripten-module.wasm"));
console.log(`copied ${wasmPath} -> ${resolve(destDir, "emscripten-module.wasm")}`);
